import type {
  AxisLayout,
  ChartLayout,
  LegendItemLayout,
  LegendLayout,
  NormalizedOption,
  Rect,
  TitleLayout,
} from '../internal';
import { createScale, formatTick } from '../scale';
import { measureTextWidth } from '../util/text';

const TICK_LENGTH = 4;
const LABEL_GAP = 6;
const AXIS_NAME_GAP = 6;
const LEGEND_GAP = 8;
const SLIDER_GAP = 14;
const SLIDER_HEIGHT = 26;

/**
 * 计算图表布局（标题 / 图例 / 绘图区 / 坐标轴）。
 *
 * 顺序：先用「临时比例尺」拿刻度值（刻度只取决于数据域，与像素范围无关），
 * 量出坐标轴占用的空间；再排标题与图例；最后推出绘图区矩形。
 * 真正的比例尺由 Chart 拿到 plot rect 之后创建，保证刻度与布局严格一致。
 */
export function computeLayout(norm: NormalizedOption, ctx: any, canvas: Rect): ChartLayout {
  const margin = norm.option.margin;

  const xScale = createScale(norm.xAxis.type, norm.xAxis.domain, [0, Math.max(1, canvas.width)], {
    logBase: norm.xAxis.option.logBase,
  });
  const xAxisLayout = buildAxisLayout(norm, 'x', norm.xAxis, xScale, ctx);
  // 每个 y 轴各量一次刻度：多轴时刻度数量与标签宽度互不影响
  const yAxisLayouts: AxisLayout[] = norm.yAxes.map((axis) => {
    const scale = createScale(axis.type, axis.domain, [Math.max(1, canvas.height), 0], {
      logBase: axis.option.logBase,
    });
    return buildAxisLayout(norm, 'y', axis, scale, ctx);
  });
  // 同侧的多个轴逐层外移；offset 是相对绘图区边缘的距离
  let leftOffset = 0;
  let rightOffset = 0;
  for (let i = 0; i < norm.yAxes.length; i++) {
    const axis = norm.yAxes[i];
    const layout = yAxisLayouts[i];
    if (axis.option.show === false || norm.kind !== 'cartesian') {
      layout.offset = 0;
      continue;
    }
    const width = yAxisReserve(axis, layout);
    if (axis.position === 'right') {
      layout.offset = rightOffset;
      rightOffset += width;
    } else {
      layout.offset = leftOffset;
      leftOffset += width;
    }
  }
  const yAxisLayout = yAxisLayouts[0];

  const title = buildTitleLayout(norm);
  const titleHeight = title
    ? (title.text ? title.textStyle.fontSize * 1.5 : 0) + (title.subtext ? title.subtextStyle.fontSize * 1.4 : 0)
    : 0;
  // 标题在上、图例在其下方；图例排版需要知道标题占用的高度
  const legend = layoutLegend(norm, ctx, canvas, margin.top + titleHeight);
  const legendSize = legend ? legendSizeOf(legend, norm) : { width: 0, height: 0 };

  let left = margin.left;
  let top = margin.top;
  let right = canvas.width - margin.right;
  let bottom = canvas.height - margin.bottom;

  top += titleHeight;
  if (legend) {
    if (legend.position === 'top') top += legendSize.height + LEGEND_GAP;
    else if (legend.position === 'bottom') bottom -= legendSize.height + LEGEND_GAP;
    else if (legend.position === 'left') left += legendSize.width + LEGEND_GAP;
    else right -= legendSize.width + LEGEND_GAP;
  }

  // 非直角坐标场景（饼图 / 雷达 / 桑基）不画坐标轴，也不为它预留空间
  const showX = norm.kind === 'cartesian' && norm.xAxis.option.show !== false;
  left += leftOffset;
  right -= rightOffset;
  if (showX) {
    bottom -= xAxisLayout.labelHeight + TICK_LENGTH + LABEL_GAP;
    if (norm.xAxis.option.name) bottom -= xAxisLayout.nameHeight + AXIS_NAME_GAP;
  }

  // dataZoom 滑块：在坐标轴之下预留一条轨道
  const sliderOption = norm.option.dataZoom && norm.option.dataZoom.slider;
  const showSlider =
    norm.kind === 'cartesian' && !!norm.option.dataZoom && (!sliderOption || sliderOption.show !== false);
  const sliderHeight = Math.max(12, Number(sliderOption && sliderOption.height) || SLIDER_HEIGHT);
  let sliderY: number | null = null;
  if (showSlider) {
    const limit = canvas.height - margin.bottom;
    const need = sliderHeight + SLIDER_GAP;
    if (bottom + need > limit) bottom -= bottom + need - limit;
    sliderY = bottom + SLIDER_GAP;
  }

  let plot: Rect = {
    x: Math.round(Math.max(0, left)),
    y: Math.round(Math.max(0, top)),
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top)),
  };

  // x 轴标签抽稀：**必须等绘图区宽度定下来**再做（第一次建比例尺时用的是画布宽度，
  // y 轴那一截还没扣掉；按画布宽度抽稀会把可用宽度多算 7%~11%，两个标签刚好贴住）。
  // 两侧的余量也一起给它：绘图区左边只有 margin+坐标轴那点地方，右首标签放不下会被画布切掉。
  // 抽稀对**隐藏的 x 轴**同样要做：垂直网格线读的就是这张表（`labels[i] === ''` = 不画）。
  // 轴藏起来了只是不画标签，网格该在哪还是在哪 —— 多 pane 的 x 轴都藏了，网格却要能对齐。
  if (norm.kind === 'cartesian') {
    thinXAxisLabels(
      xAxisLayout,
      {
        axisLength: plot.width,
        leftRoom: plot.x,
        rightRoom: Math.max(0, canvas.width - plot.x - plot.width),
      },
      ctx,
      norm.theme.fontSize,
      norm.theme.fontFamily
    );
  }

  // 极坐标：在可用区域里取最大的圆，并把绘图区收缩成圆的外接正方形
  let polar: { cx: number; cy: number; radius: number } | null = null;
  if (norm.kind === 'polar' || norm.kind === 'radar' || norm.kind === 'gauge' || norm.kind === 'liquid') {
    const halfMin = Math.min(plot.width, plot.height) / 2;
    const halfW = plot.width / 2;
    const halfH = plot.height / 2;
    // 饼图默认带引导线标签，标签要画到圆外，因此预留一圈文字空间
    const hasLabels =
      norm.kind === 'polar' &&
      norm.series.some((s) => s.type === 'pie' && !(s.option.label && s.option.label.show === false));
    const labelAllowance = hasLabels ? Math.min(46, halfMin * 0.26) : 6;
    let radius: number;
    if (norm.kind === 'gauge') {
      // 仪表盘的文字全在弧内（刻度贴弧、数值在圆心），**不需要**外圈标签预留 ——
      // 之前照抄饼图预留圈，实测半径只有可用空间的 ~50%（420×300 的画布里指针盘直径只有 92px）。
      // 弧顶到圆心就是 r，所以纵向按半高留 4px；两侧刻度数字有宽度，横向留 14px。
      radius = Math.max(10, Math.min(halfW - 14, halfH - 4) * 0.94);
    } else if (norm.kind === 'liquid') {
      // 水位球的名称与数值都画在球内，整圆贴满较短的半轴即可（留 3px 给描边）
      radius = Math.max(10, Math.min(halfW, halfH) - 3);
    } else {
      radius = Math.max(10, halfMin * polarRadiusRatio(norm) - labelAllowance);
    }
    const cx = plot.x + plot.width / 2;
    const cy = plot.y + plot.height / 2;
    polar = { cx, cy, radius };
    plot = {
      x: Math.round(cx - radius),
      y: Math.round(cy - radius),
      width: Math.round(radius * 2),
      height: Math.round(radius * 2),
    };
  }

  // 等比坐标：绘图区收缩成正方形（数据跨度已经由 normalize 拉齐，两者合起来才是「单位等长」）。
  // 这里只动绘图区，刻度值早就量好了，位置在渲染时按 plot 现算 —— 所以不需要二次布局。
  if (norm.kind === 'cartesian' && norm.option.aspect === 'equal') {
    const side = Math.min(plot.width, plot.height);
    plot = {
      x: Math.round(plot.x + (plot.width - side) / 2),
      y: Math.round(plot.y + (plot.height - side) / 2),
      width: Math.round(side),
      height: Math.round(side),
    };
  }

  if (title) {
    title.y = margin.top;
  }

  const slider: Rect | null =
    showSlider && sliderY !== null
      ? { x: plot.x, y: Math.round(sliderY), width: plot.width, height: Math.round(sliderHeight) }
      : null;

  return {
    canvas,
    plot,
    titleRect: title ? { x: title.x, y: title.y, width: 0, height: titleHeight } : null,
    legendRect: legend ? legendBoundingRect(legend) : null,
    legend,
    title,
    polar,
    slider,
    xAxisLayout,
    yAxes: yAxisLayouts,
    yAxisLayout,
    margin,
  };
}

/**
 * 圆半径占可用半径的比例（饼图取系列上的 `radius`，雷达取 `radar.radius`）。
 *
 * 注意：`gauge` / `liquid` 不在这里 —— 它们的半径由可用空间的形状直接算（见上面），
 * 因为它们的文字都在图形内部，不需要按比例留外圈。
 */
function polarRadiusRatio(norm: NormalizedOption): number {
  if (norm.kind === 'radar') {
    const raw = Number(norm.radar && norm.radar.radius);
    return isFinite(raw) && raw > 0 ? Math.max(0.1, Math.min(1, raw)) : 0.72;
  }
  for (const series of norm.series) {
    if (series.type !== 'pie') continue;
    const raw = Number(series.option.radius);
    if (isFinite(raw) && raw > 0) return Math.max(0.1, Math.min(1, raw));
  }
  return 0.92;
}

/** 单个 y 轴占用的横向空间。 */
function yAxisReserve(axis: { option: { name?: string } }, layout: AxisLayout): number {
  let width = layout.labelWidth + TICK_LENGTH + LABEL_GAP;
  if (axis.option.name) width += layout.nameHeight + AXIS_NAME_GAP;
  return width;
}

function buildAxisLayout(
  norm: NormalizedOption,
  axis: 'x' | 'y',
  internal: { option: any },
  scale: any,
  ctx: any
): AxisLayout {
  const axisOption = internal.option;
  const fontSize = norm.theme.fontSize;
  const fontFamily = norm.theme.fontFamily;
  // ⚠️ `show: false` **不是**「这张表不出」：垂直网格线跟标签是同一批位置（抽稀过的），
  // 轴藏起来的那些 pane 也得有这张表，否则网格只能退回「每个类目一条线」= 一片栅栏。
  // 隐藏的轴只是**不占排版空间**（见下面把 width/height 归零），也不画（Axis 里早就拦了）。
  const hidden = axisOption.show === false;
  const ticks = scale.ticks(axisOption.tickCount || 5);
  const formatLabel = (index: number): string => formatTick(ticks[index], scale, index, axisOption.formatter);
  /**
   * **稠密轴的标签惰性格式化**（2026-09-23）。
   *
   * 类目轴是「一个数据点一个刻度」，而真正画得出来的只有抽稀后那几百颗 —— 先格式化
   * 10 万个字符串再扔掉 99.9%，是每帧一次 O(类目数) 的 `String()` 加十万条字符串的分配
   * （GC 也跟着抖）。这里只格式化**量宽度要用的样本**，其余留空；抽稀定稿之后由
   * `thinXAxisLabels` 按保留下来的下标现算。
   *
   * 门槛 512：刻度本来就少的轴（数值 / 时间轴）继续走「全量格式化」，语义不受影响。
   */
  const lazy = ticks.length > 512;
  const labels: string[] = lazy ? new Array<string>(ticks.length).fill('') : [];
  let maxLabelWidth = 0;
  /**
   * 宽度**按样本量**（2026-09-22）：类目轴上标签宽度基本一致，而 `measureText` 是真在 ctx 上
   * 量一次（μs 级）—— 全量量一遍就是 O(类目数)：10 万个类目、每次数据变化都要量 10 万次。
   * `thinXAxisLabels` 本来就是按样本量宽度的，这里跟它保持同一条口径。
   */
  const sampleStep = Math.max(1, Math.floor(ticks.length / 64));
  for (let i = 0; i < ticks.length; i++) {
    // 首末两颗一定量（时间轴的端点常常最长/最短），其余按样本走
    const sampled = i % sampleStep === 0 || i === 0 || i === ticks.length - 1;
    if (lazy && !sampled) continue;
    const label = formatLabel(i);
    labels[i] = label;
    if (!sampled) continue;
    const w = measureTextWidth(ctx, label, fontSize, fontFamily);
    if (w > maxLabelWidth) maxLabelWidth = w;
  }
  // 刻度标签按**可用像素**稀释（2026-09-14）：类别轴的刻度数等于数据点数
  // （30 个点的折线就是 30 个刻度），全画出来会挤成一团。这里按「标签宽度 + 间隔」
  // 算一个步长，只保留整步长上的标签；刻度线照画。
  //
  // ⚠️ 抽稀**不能在这里做**（2026-09-21）：函数的入参 `scale` 是在 `computeLayout` 开头
  // 用**画布宽度**建的，那时绘图区宽度还没算出来（要等 y 轴占位定下来）。按画布宽度抽稀
  // 会把可用宽度多算 7%~11%（多出来的正好是 y 轴那一截），实际排下来每两个标签就贴住一点。
  // 所以抽稀挪到绘图区算完之后，见 `thinXAxisLabels`。

  const rotate = Math.abs(Number(axisOption.labelRotate) || 0);
  const radians = (rotate * Math.PI) / 180;
  const rotatedHeight = maxLabelWidth * Math.sin(radians) + fontSize * 1.4;
  const name = axisOption.name || '';
  const nameWidth = name ? measureTextWidth(ctx, name, fontSize, fontFamily) : 0;
  if (hidden) {
    return {
      ticks,
      labels,
      formatLabel: lazy ? formatLabel : undefined,
      sampledLabelWidth: maxLabelWidth,
      offset: 0,
      labelWidth: 0,
      labelHeight: 0,
      nameWidth: 0,
      nameHeight: 0,
    };
  }
  return {
    ticks,
    labels,
    formatLabel: lazy ? formatLabel : undefined,
    sampledLabelWidth: maxLabelWidth,
    offset: 0,
    labelWidth: axis === 'y' ? maxLabelWidth : 0,
    labelHeight: axis === 'x' ? (rotate > 0 ? rotatedHeight : fontSize * 1.4) : 0,
    nameWidth: axis === 'x' ? nameWidth : 0,
    nameHeight: name ? fontSize * 1.4 : 0,
  };
}

/**
 * x 轴标签抽稀（**唯一一处**，`Axis` 组件不再自己算一遍）。
 *
 * 判据是「相邻两个标签的像素间隔 ≥ max(标签宽度 + 10, 64)」—— 64px 是舒适间隔，
 * 低于这个值数字标签即使不重叠也「吵」（30 个刻度会挤成一片编号）。
 *
 * 两个必须这么写的地方：
 * 1. **间距要用真实值**，不能给 1px 之类的地板：间距 0.24px/根时 `ceil(64 / 1)` 会得到
 *    「88 根一跳」，而正确值是 380 根一跳 —— 差一个数量级，标签直接糊成一条色带。
 * 2. **末尾那根单独判**：离前一个保留的标签够远就补回来，太近就把前一个让掉 ——
 *    直接画末尾会让最后两个标签贴在一起（奇偶根数一换，末端就挤一对，实测踩到）。
 */
export function thinXAxisLabels(
  axisLayout: AxisLayout,
  geometry: { axisLength: number; leftRoom?: number; rightRoom?: number },
  ctx: any,
  fontSize: number,
  fontFamily: string
): void {
  const ticks = axisLayout.ticks;
  const labels = axisLayout.labels;
  const axisLength = geometry.axisLength;
  if (!ticks || ticks.length <= 2 || !axisLength || axisLength <= 0) return;
  const formatLabel = axisLayout.formatLabel;
  /** 惰性形态（稠密轴）下 `labels` 里只有样本，不能再抽一次样 —— 直接用布局那一趟量到的宽度。 */
  const lazy = typeof formatLabel === 'function';
  let maxLabelWidth = 0;
  if (lazy) {
    maxLabelWidth = Number(axisLayout.sampledLabelWidth) || 0;
  } else {
    // 量宽度按样本走：类目轴上标签宽度基本一致，全量 measureText 是 O(类目数)
    // （缩到几千根时一次布局要量几千次，白花时间）
    const sampleStep = Math.max(1, Math.floor(ticks.length / 64));
    for (let i = 0; i < labels.length; i += sampleStep) {
      if (!labels[i]) continue;
      const w = measureTextWidth(ctx, labels[i], fontSize, fontFamily);
      if (w > maxLabelWidth) maxLabelWidth = w;
    }
  }
  /** 惰性形态下「补标签」：这一趟才是真正决定要画哪几颗的地方。 */
  const materialize = (indices: () => Iterable<number>): void => {
    if (!formatLabel) return;
    for (const index of indices()) if (!labels[index]) labels[index] = formatLabel(index);
  };
  if (maxLabelWidth <= 0) {
    // 量不出宽度（空标签 / 桩上下文）就退回「全量可画」：与惰性化之前的行为一致
    materialize(function* () {
      for (let i = 0; i < labels.length; i++) yield i;
    });
    return;
  }
  const minGap = Math.max(maxLabelWidth + 10, 64);
  const spacing = axisLength / (ticks.length - 1 || 1);
  if (spacing >= minGap) {
    // 抽稀用不上 → 惰性形态要把没格式化的补齐，否则整条轴只剩样本那几颗标签
    materialize(function* () {
      for (let i = 0; i < labels.length; i++) yield i;
    });
    return;
  }
  const keepEvery = Math.max(1, Math.ceil(minGap / spacing));
  const keep = new Set<number>();
  for (let i = 0; i < ticks.length; i += keepEvery) keep.add(i);
  const last = ticks.length - 1;
  if (last > 0 && !keep.has(last)) {
    const prev = last - (last % keepEvery);
    if ((last - prev) * spacing >= minGap) {
      keep.add(last);
    } else {
      keep.delete(prev);
      keep.add(last);
    }
  }
  // 首末那两颗标签**放不下就丢掉**，不往里推 —— 推右会让它压住下一个标签
  // （实测：左端 `09-15 17:33` 被推右 27px，正好盖住第二个标签的开头，看着像糊在一起）。
  // 丢掉只让最边上空一格，其余标签都是完整的，时间轴上这是常态。
  const half = maxLabelWidth / 2;
  const leftRoom = Number(geometry.leftRoom) || 0;
  const rightRoom = Number(geometry.rightRoom) || 0;
  const kept = Array.from(keep).sort((a, b) => a - b);
  if (kept.length) {
    const first = kept[0];
    if (first * spacing - half < -leftRoom) keep.delete(first);
    const end = kept[kept.length - 1];
    if (end * spacing + half > axisLength + rightRoom) keep.delete(end);
  }
  // 抽稀定稿：**在这里**才把保留下来的那几颗格式化出来（惰性形态；全量形态 `labels` 早已填好）
  materialize(() => keep);
  // `kept` 这个名字上面的「首末放不下就丢掉」那段已经用过了，而且那份是**删之前**的快照 ——
  // 这里必须重新取一次（`keep` 可能刚被删过两项）
  const finalKept = Array.from(keep).sort((a, b) => a - b);
  /**
   * 交出去「要画哪几颗」的原下标 —— 热路径从此按这张表走（`Axis` / 网格线），
   * 不必再逐项扫整条 10 万项的表。`ticks` / `labels` 的**长度与对齐关系不变**。
   */
  axisLayout.visible = finalKept;
  if (lazy) {
    /**
     * 惰性形态：`labels` 里被填过的只有「样本 + 刚刚补上的 keep 那几颗」，
     * 所以只要把**不在 keep 里的样本**抹掉就够 —— 省掉的就是原来那趟 O(n)（10 万次）抹白。
     */
    const step = Math.max(1, Math.floor(labels.length / 64));
    for (let i = 0; i < labels.length; i += step) if (!keep.has(i)) labels[i] = '';
    const last = labels.length - 1;
    if (last > 0 && last % step !== 0 && !keep.has(last)) labels[last] = '';
    return;
  }
  for (let i = 0; i < labels.length; i++) {
    if (!keep.has(i)) labels[i] = '';
  }
}

function buildTitleLayout(norm: NormalizedOption): TitleLayout | null {
  const option = norm.option.title;
  if (!option || (!option.text && !option.subtext)) return null;
  const theme = norm.theme;
  const textStyle = {
    color: (option.textStyle && option.textStyle.color) || theme.textColor,
    fontSize: (option.textStyle && option.textStyle.fontSize) || theme.fontSize + 4,
    fontWeight: (option.textStyle && option.textStyle.fontWeight) || 'bold',
  };
  const subtextStyle = {
    color: (option.subtextStyle && option.subtextStyle.color) || theme.subTextColor,
    fontSize: (option.subtextStyle && option.subtextStyle.fontSize) || theme.fontSize,
  };
  const align = option.left === 'left' ? 'left' : option.left === 'right' ? 'right' : 'center';
  return { text: option.text || '', subtext: option.subtext || '', x: 0, y: 0, align, textStyle, subtextStyle };
}

/**
 * 图例排版：水平布局（top/bottom）按画布宽度折行，垂直布局（left/right）单列。
 * 这里只依赖画布尺寸，因此可以在绘图区确定之前完成，避免布局的循环依赖。
 */
function layoutLegend(norm: NormalizedOption, ctx: any, canvas: Rect, topOffset: number): LegendLayout | null {
  const option = norm.option.legend;
  if (!option || option.show === false) return null;
  const items: LegendItemLayout[] = [];
  if (norm.kind === 'polar' || norm.kind === 'funnel') {
    // 饼图 / 漏斗图的图例项是「数据项（扇区 / 阶段）」而不是「系列」
    for (const s of norm.series) {
      if (s.type !== 'pie' && s.type !== 'funnel') continue;
      for (let i = 0, n = s.pointCount; i < n; i++) {
        const point = s.pointAt(i);
        items.push({
          seriesId: s.id,
          seriesIndex: s.index,
          dataIndex: point.index,
          name: point.name || `${s.name} ${point.index + 1}`,
          color: point.color || s.color,
          hidden: !!norm.hiddenSlices[`${s.id}#${point.index}`],
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        });
      }
    }
  } else {
    for (const s of norm.series) {
      items.push({
        seriesId: s.id,
        seriesIndex: s.index,
        name: s.name,
        color: s.color,
        hidden: !!s.hidden,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
    }
  }
  if (!items.length) return null;
  const legend: LegendLayout = { position: option.position || 'top', items };
  const fontSize = norm.theme.fontSize;
  const itemWidth = option.itemWidth || 12;
  const itemHeight = Math.max(option.itemHeight || 12, fontSize * 1.4);
  const gap = option.itemGap || 16;
  const pieces = items.map((item) => ({
    item,
    textWidth: measureTextWidth(ctx, item.name, fontSize, norm.theme.fontFamily),
  }));
  const rowHeight = itemHeight + 4;
  const margin = norm.option.margin;

  if (legend.position === 'left' || legend.position === 'right') {
    const maxText = Math.max(...pieces.map((p) => p.textWidth), 0);
    const totalHeight = pieces.length * rowHeight;
    const x = legend.position === 'left' ? margin.left : canvas.width - margin.right - (itemWidth + 6 + maxText);
    const available = Math.max(0, canvas.height - topOffset - margin.bottom);
    const startY = Math.max(topOffset, topOffset + (available - totalHeight) / 2);
    for (let i = 0; i < pieces.length; i++) {
      const it = pieces[i].item;
      it.x = x;
      it.y = startY + i * rowHeight;
      it.width = itemWidth + 6 + pieces[i].textWidth;
      it.height = rowHeight;
    }
    return legend;
  }

  const rows: Array<Array<{ item: LegendItemLayout; textWidth: number }>> = [];
  let row: Array<{ item: LegendItemLayout; textWidth: number }> = [];
  let rowWidth = 0;
  const maxWidth = Math.max(40, canvas.width - margin.left - margin.right);
  for (const p of pieces) {
    const w = itemWidth + 6 + p.textWidth;
    if (row.length && rowWidth + gap + w > maxWidth) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    rowWidth += (row.length > 1 ? gap : 0) + w;
    row.push(p);
  }
  if (row.length) rows.push(row);

  let y = legend.position === 'top' ? topOffset : canvas.height - margin.bottom - rows.length * rowHeight;
  for (const r of rows) {
    const total = r.reduce((sum, p, i) => sum + itemWidth + 6 + p.textWidth + (i > 0 ? gap : 0), 0);
    let x = (canvas.width - total) / 2;
    for (const p of r) {
      p.item.x = x;
      p.item.y = y;
      p.item.width = itemWidth + 6 + p.textWidth;
      p.item.height = rowHeight;
      x += p.item.width + gap;
    }
    y += rowHeight;
  }
  return legend;
}

/** 图例整体尺寸（按行/列累加，避免依赖已计算的包围盒）。 */
function legendSizeOf(legend: LegendLayout, norm: NormalizedOption): { width: number; height: number } {
  const option = norm.option.legend;
  const fontSize = norm.theme.fontSize;
  const itemWidth = option.itemWidth || 12;
  const itemHeight = Math.max(option.itemHeight || 12, fontSize * 1.4);
  const rowHeight = itemHeight + 4;
  if (legend.position === 'left' || legend.position === 'right') {
    // 注意：不能用 0 作为 Math.min 的初始值 —— 图例项都在画布右侧（x > 0）时，
    // 会把 minX 算成 0，宽度就等于「从画布左边到图例右边」，绘图区被挤成一条缝。
    const lefts = legend.items.map((it) => it.x);
    const rights = legend.items.map((it) => it.x + it.width);
    const minX = lefts.length ? Math.min(...lefts) : 0;
    const maxRight = rights.length ? Math.max(...rights) : 0;
    return { width: Math.max(itemWidth + 6, maxRight - minX), height: legend.items.length * rowHeight };
  }
  let rows = 1;
  let lastY = legend.items.length ? legend.items[0].y : 0;
  for (const it of legend.items) {
    if (it.y > lastY) {
      rows += 1;
      lastY = it.y;
    }
  }
  return { width: 0, height: rows * rowHeight };
}

function legendBoundingRect(legend: LegendLayout): Rect {
  if (!legend.items.length) return { x: 0, y: 0, width: 0, height: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const it of legend.items) {
    x0 = Math.min(x0, it.x);
    y0 = Math.min(y0, it.y);
    x1 = Math.max(x1, it.x + it.width);
    y1 = Math.max(y1, it.y + it.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
