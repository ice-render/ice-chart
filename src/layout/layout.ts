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
  const titleHeight = title ? (title.text ? title.textStyle.fontSize * 1.5 : 0) + (title.subtext ? title.subtextStyle.fontSize * 1.4 : 0) : 0;
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
  const showSlider = norm.kind === 'cartesian' && !!norm.option.dataZoom && (!sliderOption || sliderOption.show !== false);
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

  // 极坐标：在可用区域里取最大的圆，并把绘图区收缩成圆的外接正方形
  let polar: { cx: number; cy: number; radius: number } | null = null;
  if (norm.kind === 'polar' || norm.kind === 'radar' || norm.kind === 'gauge') {
    const ratio = polarRadiusRatio(norm);
    // 饼图默认带引导线标签，标签要画到圆外，因此预留一圈文字空间
    const halfMin = Math.min(plot.width, plot.height) / 2;
    const hasLabels =
      (norm.kind === 'polar' && norm.series.some((s) => s.type === 'pie' && !(s.option.label && s.option.label.show === false))) ||
      norm.kind === 'gauge';
    const labelAllowance = hasLabels ? Math.min(46, halfMin * 0.26) : 6;
    const radius = Math.max(10, halfMin * ratio - labelAllowance);
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

/** 饼图半径占可用半径的比例（取第一个饼图系列的 radius 配置）。 */
function polarRadiusRatio(norm: NormalizedOption): number {
  if (norm.kind === 'gauge') {
    // 仪表盘是 270° 的弧，半径可以比整圆更饱满一些
    return 0.62;
  }
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
  if (axisOption.show === false) {
    return { ticks: [], labels: [], offset: 0, labelWidth: 0, labelHeight: 0, nameWidth: 0, nameHeight: 0 };
  }
  const ticks = scale.ticks(axisOption.tickCount || 5);
  const labels: string[] = [];
  let maxLabelWidth = 0;
  for (let i = 0; i < ticks.length; i++) {
    const label = formatTick(ticks[i], scale, i, axisOption.formatter);
    labels.push(label);
    const w = measureTextWidth(ctx, label, fontSize, fontFamily);
    if (w > maxLabelWidth) maxLabelWidth = w;
  }
  const rotate = Math.abs(Number(axisOption.labelRotate) || 0);
  const radians = (rotate * Math.PI) / 180;
  const rotatedHeight = maxLabelWidth * Math.sin(radians) + fontSize * 1.4;
  const name = axisOption.name || '';
  const nameWidth = name ? measureTextWidth(ctx, name, fontSize, fontFamily) : 0;
  return {
    ticks,
    labels,
    offset: 0,
    labelWidth: axis === 'y' ? maxLabelWidth : 0,
    labelHeight: axis === 'x' ? (rotate > 0 ? rotatedHeight : fontSize * 1.4) : 0,
    nameWidth: axis === 'x' ? nameWidth : 0,
    nameHeight: name ? fontSize * 1.4 : 0,
  };
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
      for (const point of s.points) {
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
  const pieces = items.map((item) => ({ item, textWidth: measureTextWidth(ctx, item.name, fontSize, norm.theme.fontFamily) }));
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
