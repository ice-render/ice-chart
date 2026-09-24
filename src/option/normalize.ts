import type { AnnotationOption, AxisOption, ChartOption, ChartTheme, SeriesOption } from '../types';
import type { GraphOption, RadarOption, SankeyNodeOption, SankeyOption } from '../types';
import {
  arrayAccessors,
  columnAccessors,
  gridAccessors,
  rawCategoryIndex,
  rawAccessors,
  readGenericPoint,
  storeDomainOf,
  toNumber,
} from '../internal';
import type { SeriesRawPoints } from '../internal';
import type { DataPoint, InternalAxis, InternalSeries, NormalizedOption, SeriesColumns, SeriesGrid } from '../internal';
import type { SeriesRing } from '../util/ring';
import { ringAccessors } from '../util/ring';
import { chunkAccessors, createChunks } from '../util/chunks';
import type { SeriesChunks } from '../util/chunks';
import { resolveChartTheme } from '../theme/chartTheme';
import { extent, isFiniteNumber, niceDomain, round } from '../util/math';
import { computeKdeProfile } from '../layout/density';
import { resolveMatrix } from '../layout/panels';
import { toTimestamp } from '../scale/TimeScale';
import { compileExpression } from '../expr/expr';
import { diagnoseExpression } from '../expr/diagnostics';
import { robustRange } from '../expr/sample';

const DEFAULT_MARGIN = { top: 12, right: 16, bottom: 12, left: 12 };
/** 数据域默认留白比例（数据跨度的 5%）：曲线不贴边，见 `AxisOption.padding`。 */
const DEFAULT_DOMAIN_PADDING = 0.05;

/**
 * 给数据域留白：把 [min, max] 按跨度的比例外扩。
 *
 * - 显式写了 `min` / `max` 的一侧不动（用户说了算）；
 * - 柱形 / 面积被强制包含 0 的那一侧不动（基线要贴在轴上，抬起来是错的）；
 * - `padding: 0` 或 log 轴不做（log 的外扩要按对数比例，不做隐式处理）。
 */
function padDomain(
  min: number,
  max: number,
  option: { padding?: number },
  skipMin: boolean,
  skipMax: boolean
): [number, number] {
  const raw = option && option.padding !== undefined ? Number(option.padding) : DEFAULT_DOMAIN_PADDING;
  if (!isFinite(raw) || raw <= 0) return [min, max];
  const span = max - min;
  if (!isFinite(span) || span <= 0) return [min, max];
  const pad = span * Math.min(0.5, raw);
  return [skipMin ? min : min - pad, skipMax ? max : max + pad];
}

/** 入场 / 更新 / 交互反馈三段动画的默认值。 */
export const DEFAULT_ANIMATION_STAGES = {
  enter: { duration: 520, delay: 0, easing: 'easeOutCubic', stagger: 0.35 },
  update: { duration: 420, delay: 0, easing: 'easeOutCubic', stagger: 0 },
  highlight: { duration: 260, delay: 0, easing: 'springSnappy', stagger: 0 },
};

/**
 * 归一化动画配置：
 * - 支持 `animation: false` 一键关闭；
 * - 支持扁平写法（duration / easing / stagger）等价于 `enter` 的配置；
 * - `enter / update / highlight` 三段可以分别配置或用 `false` 单独关闭。
 */
export function normalizeAnimation(input: any): any {
  if (input === false) {
    return { enabled: false, enter: false, update: false, highlight: false };
  }
  const raw: any = input || {};
  const enabled = raw.enabled !== false;
  const flat: any = {
    duration: raw.duration,
    easing: raw.easing,
    stagger: raw.stagger,
    delay: raw.delay,
  };
  const stage = (name: 'enter' | 'update' | 'highlight'): any => {
    if (raw[name] === false) return false;
    const merged: any = { ...DEFAULT_ANIMATION_STAGES[name] };
    if (name === 'enter') {
      // 扁平写法只影响入场，保持向后兼容
      for (const key of Object.keys(flat)) {
        if (flat[key] !== undefined) merged[key] = flat[key];
      }
    }
    if (raw[name] && typeof raw[name] === 'object') {
      Object.assign(merged, raw[name]);
    }
    return merged;
  };
  return { enabled, enter: stage('enter'), update: stage('update'), highlight: stage('highlight') };
}

/**
 * 归一化标注配置（只做**形状**层面的收拢）。
 *
 * 数据值 → 像素的解析不在这里：归一化阶段还没有比例尺（要等布局之后），
 * 而「这条标注画不画得出来」只有拿到坐标轴才知道 —— 那部分在 `src/annotation/resolve.ts`。
 */
export function normalizeAnnotation(input: any): AnnotationOption | null {
  if (!input || typeof input !== 'object') return null;
  const list = (value: any): any[] =>
    Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  const lines = list(input.lines);
  const points = list(input.points);
  const areas = list(input.areas);
  if (!lines.length && !points.length && !areas.length) return null;
  return { lines, points, areas };
}

/**
 * 类目（合并）域的**一次性缓存**：按「存储指纹」判命中（见 `buildXDomain`）。
 *
 * 为什么需要它：一次 `applyOption` 要归一化两遍（applyOption 一遍、rebuild 一遍），
 * 同一帧里往往还有视窗更新再触发一遍 —— 而类目轴的多来源合并要对**每张表**跑一趟
 * `String()` + 哈希（100 万 × 2 ≈ 38ms/次）。同一批存储在两次归一化之间不可能变，
 * 所以按指纹复用一次就够（实测 1M + 量柱 + 均线：每帧 6 次合并 → 2 次）。
 *
 * 指纹取值（每个系列一项）：惰性原始点用 `长度 / categoryNext / 计数表大小 / 首末类目`
 * —— `categoryNext` 只在**新增类目**时自增，`categoryCounts.size` 只在增删类目时变，
 * 两者叠上首末键，覆盖了「滚动窗口只动两头」与「中间类目被淘汰」两种改法；
 * 普通系列用 `点数 / 首末 x`。判不中就重算 —— **宁可多算一次，不能给出错的轴**。
 */
export interface CategoryDomainCache {
  key: string;
  result: { domain: any[]; categories: any[]; categoryLookup?: (key: string) => number };
  /**
   * **单来源普通系列的增量类目表**（2026-09-24，见 `OrdinaryCategoryIncremental`）。
   *
   * 惰性原始点那条路把这张表维护在**存储**里；普通系列的数据在 `option` 里，
   * 于是维护在图表实例的缓存上。判不中就置空 → 下一帧全量重算。
   */
  incremental?: OrdinaryCategoryIncremental | null;
}

/**
 * 单来源普通系列的**增量类目表**：把「头部淘汰 + 尾部追加」这趟滚动窗口，
 * 从「每 tick 把 10 万类目重新去重一遍（10 万点实测 2.9ms）」降到「验一遍 + O(delta) 维护」。
 *
 * 与 `SeriesRawPoints` 的类目表同一套口径（那里维护在存储上）：
 * - `values`：上一次的 x 值序列。**只在「窗口内类目互不相同」时才等于类目表**，
 *   所以 `unique` 是这套增量的前提，一旦不成立就整表重建；
 * - `seq`：类目 → **绝对序号**（不是下标）。下标由「自己的序号 − 首项序号」算出，
 *   于是头部淘汰只是删一个 key，不必把整张表重写一遍。
 *
 * 纪律：增量只在**逐项验过**之后才认（宁可多算一次，不给错的轴）；
 * 任何一处对不上（换了数据源 / 中间被改过 / 出现重复类目）都退回全量聚合。
 */
export interface OrdinaryCategoryIncremental {
  /** 上一次那批数据属于哪个系列（换了系列就整表重建）。 */
  seriesId: string;
  values: any[];
  seq: Map<string, number>;
  /** 下一个要分配的绝对序号。不变式：`首项序号 + 类目数`。 */
  next: number;
  unique: boolean;
}

/**
 * 视窗（数据缩放 / 手势平移产生的窗口）：归一化的**域**输入口径。
 *
 * 抽成独立接口是为了 `applyViewToNormalized` —— 它接受的就是这一组字段，
 * 语义与「带视窗重跑一遍归一化」逐项一致（见那里的注释与 `tests/option/apply-view.test.ts`）。
 */
export interface NormalizeView {
  /** 当前 x 数据域（数据缩放后）。不传表示自动。 */
  xDomain?: [any, any] | null;
  /** 主 y 轴的数据域（缩放后），等价于 yDomains[0]。 */
  yDomain?: [number, number] | null;
  /** 每个 y 轴的数据域（多轴时按 index 区分）。 */
  yDomains?: Array<[number, number] | null>;
}

/**
 * 普通系列**点物化的复用缓存**（图表实例持有，按系列 id）。
 *
 * 为什么要：`buildPoints` 每趟归一化都要给每个系列物化一遍 `DataPoint`（10 万点约 1.5~2ms
 * 加一堆垃圾），而**平移 / 缩放 / 重复归一化时数据根本没变** —— 重建纯属白烧。
 *
 * 判据（与类目域那套同源）：**数据数组身份 + 长度 + 解析规则**（`type|xField|yField`）
 * 都没变才复用；换了数组、换了长度、换了字段一律重建 —— 宁可多算一次，不给错的数据。
 * 只对「点完全由自己那份 data 决定」的类型生效：`radar / sankey / graph` 的点来自旁边的
 * `radar` / `sankey` / `graph` 配置块，不在这条路上（它们照样每趟重建）。
 */
export interface PointCacheEntry {
  rows: any[];
  rule: string;
  points: DataPoint[];
  hasExplicitX: boolean;
}

export interface NormalizeContext extends NormalizeView {
  /** 见 `PointCacheEntry`。 */
  pointCache?: Map<string, PointCacheEntry>;
  hiddenIds?: Record<string, boolean>;
  /** 类目（合并）域的一次性缓存（图表实例持有；见 `CategoryDomainCache`）。 */
  categoryCache?: CategoryDomainCache;
  /**
   * 引擎实例主题是不是暗色（`theme: 'auto'` 时用来决定跟亮色还是暗色主题）。
   * 由 `ICEChart` 按 `ice.getTheme()` 算出后传进来 —— 归一化层本身不碰引擎实例，保持纯函数。
   */
  preferDark?: boolean;
  /** 被隐藏的扇区（饼图），key 为 `seriesId#dataIndex`。 */
  hiddenSlices?: Record<string, boolean>;
  /**
   * 虚拟（列存）系列的存储缓存，key 为系列 id。
   *
   * 为什么需要：`data` 在第一次归一化之后就被释放了（这正是虚拟化省内存的地方），
   * 而**下一次**更新（`setData` / `appendData` / 手势）还要再归一化一遍 —— 那时
   * `option` 里已经没有 `data` 了。于是列存要在**图表实例**上留一份：
   * 第一次建列并放进缓存，后面的归一化直接复用。
   * 带 data 的输入永远以 data 为准（缓存只是「没有 data 时怎么办」的答案）。
   */
  virtualColumns?: Map<
    string,
    | { columns: SeriesColumns }
    | { grid: SeriesGrid }
    | { ring: SeriesRing }
    | { chunks: SeriesChunks }
    | { raw: SeriesRawPoints }
  >;
}

/**
 * 把用户 option 归一化成内部结构：数据点、坐标轴类型、数据域、堆叠基线。
 *
 * 这一步是纯计算、无副作用、不依赖 DOM / ctx，因此可以被完整单测覆盖。
 */
export function normalizeOption(option: ChartOption, context: NormalizeContext = {}): NormalizedOption {
  if (!option || !Array.isArray(option.series)) {
    throw new Error('[ice-chart] option.series 必须是数组。');
  }

  const theme = resolveChartTheme(option.theme, { preferDark: !!context.preferDark });
  const merged: any = {
    legend: {
      show: option.series.length > 1,
      position: 'top',
      itemWidth: 12,
      itemHeight: 12,
      itemGap: 16,
      selectable: true,
      ...(option.legend || {}),
    },
    tooltip: {
      show: true,
      trigger: 'axis',
      ...(option.tooltip || {}),
    },
    crosshair: {
      show: true,
      type: 'line',
      axis: 'x',
      showAxisLabel: true,
      ...(option.crosshair || {}),
    },
    grid: {
      show: true,
      x: false,
      y: true,
      lineWidth: 1,
      ...(option.grid || {}),
    },
    interaction: {
      hover: { enabled: true, mode: 'nearest-x', dimOthers: false, ...(option.interaction?.hover || {}) },
      select: { enabled: false, mode: 'single', toggle: true, ...(option.interaction?.select || {}) },
      brush: option.interaction?.brush === false ? false : { enabled: false, axes: 'x', mode: 'select', ...(option.interaction?.brush || {}) },
      zoom:
        option.interaction?.zoom === false
          ? false
          : { enabled: true, axes: 'x', wheel: true, wheelFactor: 1.2, mode: 'data', ...(option.interaction?.zoom || {}) },
      pan: option.interaction?.pan === false ? false : { enabled: false, axes: 'xy', ...(option.interaction?.pan || {}) },
      keyboard: option.interaction?.keyboard === undefined ? true : option.interaction.keyboard,
    },
    animation: normalizeAnimation(option.animation),
    margin: { ...DEFAULT_MARGIN, ...(option.margin || {}) },
  };
  merged.series = option.series;
  merged.title = option.title;
  merged.xAxis = option.xAxis || {};
  merged.yAxis = option.yAxis || {};
  merged.dataZoom = option.dataZoom || null;
  merged.theme = option.theme;
  merged.aspect = option.aspect === 'equal' ? 'equal' : 'auto';
  merged.polarGrid = option.polarGrid || null;
  merged.annotation = normalizeAnnotation(option.annotation);
  merged.tooltip = { show: option.tooltip?.show !== false, ...merged.tooltip };
  merged.crosshair = { show: option.crosshair?.show !== false, ...merged.crosshair };

  const radar = option.radar || null;
  const graphOption = option.graph || null;
  const series = buildSeries(option.series, theme, merged.legend?.selected || {}, radar, option.sankey || null, graphOption, context);
  // 瀑布图配置「顶层与系列级等价，series 优先」（types 的承诺）。以前只读了系列级，
  // 写在顶层的 `option.waterfall.*` 静默失效 —— 测试之前靠色板兜底值恰好相同而没暴露。
  for (const s of series) {
    if (s.type !== 'waterfall') continue;
    const own = (s.option as any).waterfall;
    const resolved = own !== undefined ? own : option.waterfall;
    if (resolved !== undefined) s.waterfallOption = resolved;
  }
  const hiddenIds: Record<string, boolean> = { ...(context.hiddenIds || {}) };
  for (const s of series) {
    if (merged.legend?.selected && merged.legend.selected[s.name] === false) {
      hiddenIds[s.id] = true;
    }
    s.hidden = !!hiddenIds[s.id] || s.option.show === false;
  }

  const kind: 'cartesian' | 'polar' | 'radar' | 'sankey' | 'funnel' | 'gauge' | 'liquid' | 'treemap' | 'graph' = series.some((s) => s.type === 'pie')
    ? 'polar'
    : series.some((s) => s.type === 'radar')
      ? 'radar'
      : series.some((s) => s.type === 'sankey')
        ? 'sankey'
        : series.some((s) => s.type === 'funnel')
          ? 'funnel'
          : series.some((s) => s.type === 'gauge')
            ? 'gauge'
            : series.some((s) => s.type === 'liquid')
              ? 'liquid'
              : series.some((s) => s.type === 'treemap')
              ? 'treemap'
              : series.some((s) => s.type === 'graph')
                ? 'graph'
                : 'cartesian';
  const sankey = kind === 'sankey' ? option.sankey || null : null;
  const funnel = kind === 'funnel' ? option.funnel || {} : null;
  const gauge = kind === 'gauge' ? option.gauge || {} : null;
  const liquid = kind === 'liquid' ? option.liquid || {} : null;
  const treemap = kind === 'treemap' ? option.treemap || {} : null;
  const graph = kind === 'graph' ? graphOption : null;
  const hiddenSlices: Record<string, boolean> = { ...(context.hiddenSlices || {}) };
  const radarDomains: Array<[number, number]> = radar ? buildRadarDomains(radar, series) : [];
  if (kind !== 'cartesian' && (!option.tooltip || option.tooltip.trigger === undefined)) {
    // 非直角坐标没有「数据列」的概念，默认按数据项触发提示
    merged.tooltip.trigger = 'item';
  }
  const xAxisOption: AxisOption = merged.xAxis;
  // 主流习惯用 type: 'value' 表示数值轴，这里统一成内部的 'linear'
  if (xAxisOption.type === ('value' as any)) xAxisOption.type = 'linear';
  // 多 y 轴：option.yAxis 可以是单个对象或数组；每个系列用 yAxisIndex 绑定到其中一个
  const yAxisOptions: AxisOption[] = Array.isArray(option.yAxis) ? option.yAxis : [option.yAxis || {}];
  if (!yAxisOptions.length) yAxisOptions.push({});
  for (const axis of yAxisOptions) {
    if (axis.type === ('value' as any)) axis.type = 'linear';
  }
  for (const s of series) {
    const raw = Number(s.option.yAxisIndex);
    s.axisIndex = isFinite(raw) ? Math.max(0, Math.min(yAxisOptions.length - 1, Math.floor(raw))) : 0;
  }
  /**
   * 面板矩阵：`series[].panel` 在这里夹到合法范围。
   *
   * 越界 / 负数 / 非数字一律夹回（0 或最后一个面板）：坏配置画歪比整张图空白好，
   * 与标注那套「坏数据不让图表崩」同一条纪律。
   */
  const matrix = resolveMatrix(option.matrix);
  for (const s of series) {
    if (!matrix) {
      s.panel = 0;
      continue;
    }
    const rawPanel = Number(s.option.panel);
    s.panel = isFinite(rawPanel) ? Math.max(0, Math.min(matrix.panelCount - 1, Math.floor(rawPanel))) : 0;
  }

  /**
   * 排布方向：类目轴在 y 上就是横向柱状图（排行榜场景）。
   * 判定依据与主流写法一致 —— 声明了类目 y 轴（type 或 data），且 x 轴不是类目轴。
   */
  const horizontal = isHorizontalLayout(xAxisOption, yAxisOptions[0]);
  if (horizontal && (!option.tooltip || option.tooltip.trigger === undefined)) {
    // 横向图的类目在 y 轴上，没有「按 x 取整列」的语义，默认按数据项触发
    merged.tooltip.trigger = 'item';
  }
  // 轴声明了类目时，数据项按**下标**对齐到类目
  //（常见写法：series.data 只给数值，类目由 axis.data 提供）
  applyAxisCategories(horizontal ? yAxisOptions[0] : xAxisOption, series);
  const xType = horizontal
    ? xAxisOption.type && xAxisOption.type !== 'category'
      ? xAxisOption.type
      : 'linear'
    : resolveXAxisType(xAxisOption, series);
  /**
   * **数值列**的虚拟系列只有数值型 x（类目轴表达不了它，别让 100 万个数值被聚合成 100 万个类目）。
   * 惰性原始点（自定义系列）不受这条限制：它的 x 可以是类目（K 线就是时间字符串）。
   */
  const columnarVirtual = series.some((s) => !!(s.columns || s.ring || s.chunks));
  if (columnarVirtual && (xType === 'category' || horizontal)) {
    throw new Error('[ice-chart] 虚拟（列存）系列只支持数值型 x 轴（xAxis.type 不要写 category）。');
  }
  // 反过来：虚拟热力图的 x / y 都必须是类目轴（矩阵靠类目定行列）
  if (series.some((s) => s.grid)) {
    if (xType !== 'category') {
      throw new Error('[ice-chart] 虚拟（列存）热力图的 x 轴必须是类目轴（xAxis.type: \'category\'）。');
    }
    const yType = yAxisOptions[0] && yAxisOptions[0].type;
    if (yType !== undefined && yType !== 'category') {
      throw new Error('[ice-chart] 虚拟（列存）热力图的 y 轴必须是类目轴（yAxis.type 不要写别的）。');
    }
  }
  let rawXDomain: any[];
  let categories: any[];
  let categoryLookup: ((key: string) => number) | undefined;
  if (horizontal) {
    // 横向：x 轴承载数值（用 y 轴那套值域算法），类目搬到 y 轴
    rawXDomain = buildYDomain(series, 0, xAxisOption, xType) as any[];
    categories = [];
    // 类目轴上的类目：优先用 yAxis.data，其次从数据项的 name / xValue 推导
    const yCategories = buildCategoryValues(yAxisOptions[0], series);
    yAxisOptions[0] = { ...yAxisOptions[0], type: 'category' };
    (yAxisOptions[0] as any).__categories = yCategories;
  } else {
    const built = buildXDomain(xType, series, xAxisOption, context.categoryCache);
    rawXDomain = built.domain;
    categories = built.categories;
    categoryLookup = built.categoryLookup;
  }
  const resolved = resolveXDomain(xType, rawXDomain, context.xDomain, categoryLookup);
  const xDomain = resolved.domain;
  /**
   * 查表口按**整张类目表**编号，域是整张表的一段时靠 `categoryOffset` 换算 ——
   * 所以「被视窗裁剪」不再需要把查表口丢掉（丢掉等于让 BandScale 每帧重写一张
   * 10 万条的 Map，实测 1ms/次，是这类页面归一化里最大的一笔）。
   */
  const categoryOffset = categoryLookup ? resolved.offset : 0;

  applyStacking(series);
  applyWaterfall(series);

  const xAxis: InternalAxis = {
    option: xAxisOption,
    type: xType,
    domain: xDomain,
    scale: null,
    index: 0,
    position: 'left',
  };
  const hasHeatmap = series.some((s) => s.type === 'heatmap');
  const yAxes: InternalAxis[] = yAxisOptions.map((option, index) => {
    if (horizontal && index === 0) {
      return {
        option,
        type: 'category' as const,
        domain: ((option as any).__categories as any[]) || [],
        scale: null,
        index,
        position: option.position || 'left',
        // 横向图的类目在 y 轴上，值在 x 轴上 —— y 视窗对这根轴无效
        categoryDomain: true,
      };
    }
    // 热力图需要「类目 y 轴」：y 方向也是离散类目
    if (hasHeatmap && (option.type === undefined || option.type === 'category')) {
      const seen: Record<string, boolean> = {};
      const categories: any[] = [];
      for (const s of series) {
        if (s.type !== 'heatmap') continue;
        // 列存（虚拟）热力图：行类目就是矩阵的行，别再扫 100 万格
        if (s.grid) {
          for (const value of s.grid.yCategories) {
            const key = String(value);
            if (seen[key]) continue;
            seen[key] = true;
            categories.push(value);
          }
          continue;
        }
        for (let i = 0, n = s.pointCount; i < n; i++) {
          const point = s.pointAt(i);
          const key = String(point.name === undefined ? point.xValue : point.name);
          if (!seen[key]) {
            seen[key] = true;
            categories.push(point.name === undefined ? point.xValue : point.name);
          }
        }
      }
      return {
        option,
        type: 'category' as const,
        domain: categories,
        scale: null,
        index,
        position: option.position || (index === 0 ? 'left' : 'right'),
        // 热力图的行类目：同上，不接受 y 视窗
        categoryDomain: true,
      };
    }
    const type = option.type || 'linear';
    const explicit = context.yDomains ? context.yDomains[index] : index === 0 ? context.yDomain : null;
    const domain = explicit ? (explicit as any[]) : ((buildYDomain(series, index, option, type) as any[]) as any[]);
    return {
      option,
      type,
      domain,
      scale: null,
      index,
      position: option.position || (index === 0 ? 'left' : 'right'),
    };
  });
  const yAxis = yAxes[0];
  applyEqualAspect(option, kind, xAxis, yAxes);
  // 等比坐标会改写 x 域（把绘图区补成正方形），那时查表口同样失效 → 退回去自建
  if (categoryLookup && xAxis.domain === xDomain) {
    xAxis.categoryLookup = categoryLookup;
    xAxis.categoryOffset = categoryOffset;
  }

  return {
    labels: {
      chart: '图表',
      sector: '扇区',
      value: '数值',
      ratio: '占比',
      indicator: '指标',
      coordinate: '坐标',
      liquid: '水位',
      slice: '切片',
      ...(option.labels || {}),
    },
    kind,
    orientation: horizontal ? 'horizontal' : 'vertical',
    matrix,
    radar,
    sankey,
    funnel,
    gauge,
    liquid,
    treemap,
    graph,
    radarDomains,
    option: merged,
    theme,
    series,
    xAxis,
    yAxes,
    yAxis,
    categories,
    visibleSeries: series.filter((s) => !s.hidden),
    hiddenIds,
    hiddenSlices,
  };
}

/**
 * 视窗是不是只影响「域」，不影响系列本身的构造。
 *
 * 视窗在归一化里一共只有三处作用：① x 域裁剪（`resolveXDomain`）；
 * ② y 轴的显式数据域；③ 表达式系列的**采样区间**（`function` / `parametric` 的
 * 采样点按可视窗口现算，见 `buildCurvePoints` 的 `context.xDomain` 分支）。
 * ① ② 可以事后套用（`applyViewToNormalized`），③ 不行 —— 那必须整条重跑。
 *
 * 等比坐标（`aspect: 'equal'`）同理：它按两个轴的**跨度**重新拉齐，
 * 跨度随视窗变，事后套用会算错。
 */
export function canApplyView(norm: NormalizedOption): boolean {
  if (!norm) return false;
  if (norm.option && (norm.option as any).aspect === 'equal') return false;
  for (const series of norm.series) {
    if (series.type === 'function' || series.type === 'parametric') return false;
  }
  return true;
}

/**
 * 把**全域**归一化结果套上视窗。
 *
 * 结果与 `normalizeOption(option, view)` 逐项一致，但省掉一整遍归一化
 * （点物化 / 类目（合并）表 / 轴域都复用全域那一遍）—— 10 万点普通系列上
 * 那一遍实测约 3ms/次（见 `plans/incremental-pipeline.md`）。
 *
 * 之所以能省：视窗只落在这几个「域」字段上，而域是归一化**最后**才算的
 * （x 域裁剪在 `resolveXDomain`、y 轴域在轴的构造里），所以事后套用等价 ——
 * 这条等价性由 `tests/option/apply-view.test.ts` 对着参照实现逐项锁住。
 *
 * ⚠️ 调用方必须先过 `canApplyView`：表达式系列 / 等比坐标套用会算错
 * （采样区间与跨度都由视窗决定），那两种情形只能整条重跑。
 */
export function applyViewToNormalized(norm: NormalizedOption, view: NormalizeView): NormalizedOption {
  const window = view && Array.isArray(view.xDomain) && view.xDomain.length >= 2 ? (view.xDomain as [any, any]) : null;
  const hasYWindow = !!(view && (view.yDomains || (Array.isArray(view.yDomain) && view.yDomain.length === 2)));
  if (!window && !hasYWindow) return norm;

  const xAxis: InternalAxis = { ...norm.xAxis };
  if (window) {
    // 与 `normalizeOption` 里那条完全同源：同一个 resolveXDomain、同一份查表口
    const resolved = resolveXDomain(xAxis.type, xAxis.domain, window, norm.xAxis.categoryLookup);
    xAxis.domain = resolved.domain;
    if (norm.xAxis.categoryLookup) {
      xAxis.categoryLookup = norm.xAxis.categoryLookup;
      xAxis.categoryOffset = resolved.offset;
    }
  }

  const yAxes: InternalAxis[] = norm.yAxes.map((axis, index) => {
    // 类目 y 轴（横向图 / 热力图的行）不吃 y 视窗 —— 与带视窗重跑一遍的规则一致
    if (axis.categoryDomain) return axis;
    const explicit = view.yDomains ? view.yDomains[index] : index === 0 ? view.yDomain : null;
    if (!explicit || explicit.length !== 2) return axis;
    return { ...axis, domain: [explicit[0], explicit[1]] };
  });

  return { ...norm, xAxis, yAxes, yAxis: yAxes[0] };
}

function buildSeries(
  seriesOptions: SeriesOption[],
  theme: ChartTheme,
  _selected: Record<string, boolean>,
  radar?: RadarOption | null,
  sankey?: SankeyOption | null,
  graph?: GraphOption | null,
  context?: NormalizeContext
): InternalSeries[] {
  const out: InternalSeries[] = [];
  const usedNames: Record<string, number> = {};
  for (let i = 0; i < seriesOptions.length; i++) {
    const option = seriesOptions[i];
    if (!option || !option.type) {
      throw new Error(`[ice-chart] series[${i}] 缺少 type。`);
    }
    let name = option.name;
    if (!name) {
      name = `series-${i + 1}`;
    }
    if (usedNames[name] !== undefined) {
      usedNames[name] += 1;
      name = `${name} (${usedNames[name]})`;
    } else {
      usedNames[name] = 0;
    }
    const id = option.id || `series-${i}`;
    const color = option.color || theme.colorPalette[i % theme.colorPalette.length];
    // 列存（虚拟）系列：只建列，不建数据点数组（见 plans/scatter-large-data-virtualization.md）
    // 列存（虚拟）系列：只建存储，不建「每点一个 DataPoint」的数据点数组
    if (option.virtual) {
      const cache = context && context.virtualColumns ? context.virtualColumns : null;
      const cached = cache ? cache.get(id) : undefined;
      const shared = {
        id,
        index: i,
        type: option.type,
        name,
        color,
        points: [],
        virtual: true as const,
        hasExplicitX: true,
        hidden: false,
        axisIndex: 0,
        panel: 0,
      };
      /**
       * 存储有**两种生命周期**，先定形态再决定要不要摘掉 `data`：
       * - 惰性原始点（自定义系列）：**保留 `data`** —— 原始数据就是存储本身，按引用复用；
       * - 数值列 / 矩阵 / 分块 / 环形：建完就把 `data` 从 option 里摘掉（省内存的大头，
       *   百万级元组数组从此没有任何引用），下一遍归一化靠缓存复用同一项。
       */
      const reuseRaw =
        cached &&
        'raw' in cached &&
        (option.data === undefined || (cached.raw as SeriesRawPoints).data === option.data)
          ? cached.raw
          : null;
      const reuseStore = !reuseRaw && cached && option.data === undefined ? cached : null;
      const takeLean = (): SeriesOption => {
        const lean: SeriesOption = { ...option, data: undefined };
        seriesOptions[i] = lean;
        return lean;
      };

      if (reuseRaw) {
        out.push({ ...shared, option, raw: reuseRaw, pointCount: reuseRaw.length, ...rawAccessors(reuseRaw) });
        continue;
      }
      if (reuseStore && 'ring' in reuseStore) {
        const ring = reuseStore.ring;
        out.push({ ...shared, option, ring, pointCount: ring.length, ...ringAccessors(ring) });
        continue;
      }
      if (reuseStore && 'chunks' in reuseStore) {
        const chunks = reuseStore.chunks;
        out.push({ ...shared, option, chunks, pointCount: chunks.total, ...chunkAccessors(chunks) });
        continue;
      }
      if (reuseStore && 'grid' in reuseStore) {
        const grid = reuseStore.grid;
        out.push({ ...shared, option, grid, pointCount: grid.values.length, ...gridAccessors(grid) });
        continue;
      }
      if (reuseStore && 'columns' in reuseStore) {
        const columns = reuseStore.columns;
        out.push({ ...shared, option, columns, pointCount: columns.y.length, ...columnAccessors(columns) });
        continue;
      }

      // ---- 新建存储 ----
      if (option.type === 'heatmap') {
        const grid = buildVirtualGrid(option, i);
        if (cache) cache.set(id, { grid });
        out.push({ ...shared, option: takeLean(), grid, pointCount: grid.values.length, ...gridAccessors(grid) });
        continue;
      }
      if (isChunkedInput(option.data)) {
        const chunks = buildVirtualChunks(option.data, i);
        if (cache) cache.set(id, { chunks });
        out.push({ ...shared, option: takeLean(), chunks, pointCount: chunks.total, ...chunkAccessors(chunks) });
        continue;
      }
      if (isColumnarVirtualType(option.type)) {
        /**
         * 数值列只吃**数值型 x**。x 不是数值时（类目轴上的字符串 x，比如均线挂在时间类目上）
         * 不要抛错 —— 退回下面的**惰性原始点**：一样不建 `DataPoint` 数组、一样不建逐点像素，
         * 组件走虚拟绘制那条路（每像素列抽样）。这条让「类目轴 + 百万点折线」也可行，
         * 不再逼应用把它降级成普通系列（那会物化 100 万个对象 + 逐帧 LTTB）。
         */
        const columns = tryBuildVirtualColumns(option, i);
        if (columns) {
          if (cache) cache.set(id, { columns });
          out.push({ ...shared, option: takeLean(), columns, pointCount: columns.y.length, ...columnAccessors(columns) });
          continue;
        }
      }
      /**
       * 惰性原始点：任何其它类型（自定义系列）都走这里 —— 保留原始数据、不建 DataPoint 数组。
       * 组件按自己的字段解析 raw，提示框照旧能拿到 `params.data`。
       */
      const raw = buildVirtualRawPoints(option, i);
      if (cache) cache.set(id, { raw });
      out.push({ ...shared, option, raw, pointCount: raw.length, ...rawAccessors(raw) });
      continue;
    }
    /**
     * **点物化的复用**：同一份数据数组 + 同一条解析规则 + 同长度 → 直接复用上一趟那批点
     * （平移 / 缩放 / 重复归一化的常见形状）。`radar / sankey / graph` 的点由旁边的配置块
     * 决定，不在这条路上。见 `PointCacheEntry`。
     */
    const pointCache = context && context.pointCache ? context.pointCache : null;
    const sourceRows = Array.isArray(option.data) ? (option.data as any[]) : null;
    const parseRule = `${option.type}|${option.xField || ''}|${option.yField || ''}`;
    const shard = pointCache && sourceRows ? pointCache.get(id) : undefined;
    const reusable =
      shard &&
      shard.rows === sourceRows &&
      shard.rule === parseRule &&
      shard.points.length === sourceRows.length &&
      option.type !== 'radar' &&
      option.type !== 'sankey' &&
      option.type !== 'graph'
        ? shard
        : null;
    const built = reusable
      ? { points: reusable.points, hasExplicitX: reusable.hasExplicitX }
      : buildPoints(option, radar, sankey, graph, context);
    const { points, hasExplicitX } = built;
    if (pointCache && sourceRows && !reusable) pointCache.set(id, { rows: sourceRows, rule: parseRule, points, hasExplicitX });
    if (option.type === 'pie') {
      // 饼图：每个扇区一个颜色（可被数据项自身的 color 覆盖）
      for (let p = 0; p < points.length; p++) {
        const raw = points[p].raw;
        const own = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.color : undefined;
        points[p].color = own || (p === 0 && option.color ? option.color : theme.colorPalette[p % theme.colorPalette.length]);
      }
    }
    const internal: InternalSeries = {
      id,
      index: i,
      type: option.type,
      name,
      color,
      option,
      points,
      virtual: false,
      pointCount: points.length,
      // 普通系列：读点就是 points 的直读，与迁移前逐字等价（列存系列在 Phase 2 步骤 3 换实现）。
      ...arrayAccessors(points),
      hasExplicitX,
      hidden: false,
      axisIndex: 0,
      panel: 0,
    };
    applyCurveDomain(internal, option, context);
    out.push(internal);
  }
  return out;
}

function buildPoints(
  option: SeriesOption,
  radar?: RadarOption | null,
  sankey?: SankeyOption | null,
  graph?: GraphOption | null,
  context?: NormalizeContext
): { points: DataPoint[]; hasExplicitX: boolean } {
  const raw = Array.isArray(option.data) ? option.data : [];
  if (!Array.isArray(option.data) && option.data && typeof option.data === 'object') {
    // 列式输入（{ x, y }）只有列存（virtual）系列认识；普通系列拿到它只会画出一张空图
    throw new Error(
      `[ice-chart] series 的列式 data（{ x, y }）需要配 virtual: true（当前 type: '${option.type}'）。`
    );
  }
  const points: DataPoint[] = [];
  let hasExplicitX = false;
  // 函数绘图 / 参数曲线：数据点由表达式现算（不是用户给的数组）
  if (option.type === 'function' || option.type === 'parametric') {
    return buildCurvePoints(option, context);
  }
  // 关系图：点是「节点 + 连线」，索引 0..n-1 是节点，之后是连线
  if (option.type === 'graph' && graph) {
    const graphNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const graphLinks = Array.isArray(graph.links) ? graph.links : [];
    const indexOf = (ref: string | number): number => {
      if (typeof ref === 'number') return ref;
      return graphNodes.findIndex((node: any) => node.id === ref || node.name === ref);
    };
    for (let i = 0; i < graphNodes.length; i++) {
      const node: any = graphNodes[i];
      const value = toNumber(node.value);
      points.push({
        index: i,
        xValue: node.name,
        y: value,
        raw: node,
        base: 0,
        top: value === null ? 0 : value,
        name: node.name,
      });
    }
    for (let i = 0; i < graphLinks.length; i++) {
      const link: any = graphLinks[i];
      const s = indexOf(link.source);
      const t = indexOf(link.target);
      const name = `${s >= 0 ? graphNodes[s].name : String(link.source)} → ${t >= 0 ? graphNodes[t].name : String(link.target)}`;
      const value = toNumber(link.value);
      points.push({
        index: graphNodes.length + i,
        xValue: name,
        y: value === null ? 1 : value,
        raw: { __graphLink: true, source: link.source, target: link.target, value: link.value },
        base: 0,
        top: value === null ? 1 : value,
        name,
      });
    }
    return { points, hasExplicitX: true };
  }
  // 桑基图：点为「节点 + 连线」，索引 0..n-1 是节点，之后是连线
  if (option.type === 'sankey' && sankey) {
    const nodes = Array.isArray(sankey.nodes) ? sankey.nodes : [];
    const links = Array.isArray(sankey.links) ? sankey.links : [];
    const inTotals = new Array(nodes.length).fill(0);
    const outTotals = new Array(nodes.length).fill(0);
    const indexOf = (ref: string | number): number =>
      typeof ref === 'number' ? ref : nodes.findIndex((node: SankeyNodeOption) => node.name === ref);
    for (const link of links) {
      const s = indexOf(link.source);
      const t = indexOf(link.target);
      const value = Number(link.value) || 0;
      if (s >= 0) outTotals[s] += value;
      if (t >= 0) inTotals[t] += value;
    }
    // 节点流量取入/出较大者（中间节点相加会翻倍）
    const totals = inTotals.map((value: number, i: number) => Math.max(value, outTotals[i]));
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      points.push({
        index: i,
        xValue: node.name,
        y: totals[i],
        raw: node,
        base: 0,
        top: totals[i],
        name: node.name,
      });
    }
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const s = indexOf(link.source);
      const t = indexOf(link.target);
      const name = `${s >= 0 ? nodes[s].name : String(link.source)} → ${t >= 0 ? nodes[t].name : String(link.target)}`;
      points.push({
        index: nodes.length + i,
        xValue: name,
        y: Number(link.value) || 0,
        raw: { __sankeyLink: true, source: link.source, target: link.target, value: link.value },
        base: 0,
        top: Number(link.value) || 0,
        name,
      });
    }
    return { points, hasExplicitX: true };
  }
  // 雷达图：数据按指标顺序排列，每个指标一个顶点
  if (option.type === 'radar' && radar && Array.isArray(radar.indicators)) {
    for (let i = 0; i < radar.indicators.length; i++) {
      const indicator = radar.indicators[i];
      const item = raw[i];
      const value =
        item && typeof item === 'object' && !Array.isArray(item) && (item as any).value !== undefined
          ? toNumber((item as any).value)
          : toNumber(item);
      points.push({
        index: i,
        xValue: indicator.name,
        y: value,
        raw: item,
        base: 0,
        top: value === null ? 0 : value,
        name: indicator.name,
      });
    }
    return { points, hasExplicitX: true };
  }
  // 热力图：数据项是 [x类目, y类目, 数值]
  if (option.type === 'heatmap') {
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (!Array.isArray(item) || item.length < 3) {
        points.push({ index: i, xValue: i, y: null, raw: item, base: 0, top: 0 });
        continue;
      }
      const value = toNumber(item[2]);
      hasExplicitX = true;
      points.push({
        index: i,
        xValue: item[0],
        y: value,
        raw: item,
        base: 0,
        top: value === null ? 0 : value,
        name: String(item[1]),
      });
    }
    return { points, hasExplicitX };
  }
  // 箱线图：数据项是 [min, Q1, median, Q3, max]，或一串原始观测值（自动算分位数）
  if (option.type === 'boxplot') {
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      const tuple = Array.isArray(item) ? item.map((v) => Number(v)) : null;
      if (!tuple || !tuple.length) {
        points.push({ index: i, xValue: i, y: null, raw: item, base: 0, top: 0 });
        continue;
      }
      // 恰好 5 个数 = 已经算好的五数概括 [min, Q1, median, Q3, max]；
      // 其它长度 = 原始观测值，自动算分位数（曾经用 >= 5 判断，
      // 于是 40 个原始观测值被当成五数概括 —— min/max 包不住四分位，箱体是错乱的，
      // 命中判定也跟着失效。这个 bug 只在真实浏览器里悬停才看得出来。）
      const summary: [number, number, number, number, number] =
        tuple.length === 5 ? [tuple[0], tuple[1], tuple[2], tuple[3], tuple[4]] : computeBoxplotSummary(tuple);
      hasExplicitX = true;
      points.push({
        index: i,
        xValue: i,
        // 数据点的「值」取中位数（提示框、键盘导航都用它）
        y: summary[2],
        raw: item,
        base: 0,
        top: summary[2],
        boxplot: summary,
      });
    }
    return { points, hasExplicitX };
  }
  // 小提琴图：数据项是**一组原始观测值**（数组），或 { name, values } 具名分组。
  // 密度轮廓在这里算好（纯函数），组件只做「数据空间 → 像素」的映射。
  if (option.type === 'violin') {
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      const named = item && typeof item === 'object' && !Array.isArray(item) ? (item as any) : null;
      const source: any[] = Array.isArray(item) ? item : named && Array.isArray(named.values) ? named.values : [];
      const values: number[] = [];
      for (const entry of source) {
        const value = toNumber(entry);
        if (value !== null) values.push(value);
      }
      const name = named && named.name !== undefined ? String(named.name) : undefined;
      const summary = computeBoxplotSummary(values);
      const config = option.violin || {};
      const profile = computeKdeProfile(values, { bandwidth: config.bandwidth, samples: config.samples });
      hasExplicitX = true;
      points.push({
        index: i,
        xValue: name === undefined ? i : name,
        // 空组没有「值」可锚定（提示框、键盘导航都读 y）
        y: values.length ? summary[2] : null,
        raw: item,
        base: 0,
        top: values.length ? summary[2] : 0,
        name,
        violin: {
          values,
          bandwidth: profile.bandwidth,
          grid: profile.grid,
          density: profile.density,
          summary,
        },
      });
    }
    return { points, hasExplicitX };
  }
  // 瀑布图：base/top 由累计值推导（见 applyWaterfall）
  if (option.type === 'waterfall') {
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      let value: number | null = null;
      let name: string | undefined;
      if (typeof item === 'number') value = toNumber(item);
      else if (item && typeof item === 'object' && !Array.isArray(item)) {
        const obj: any = item;
        value = toNumber(obj.value === undefined ? obj.y : obj.value);
        if (obj.name !== undefined) name = String(obj.name);
      } else {
        value = toNumber(item);
      }
      hasExplicitX = true;
      points.push({ index: i, xValue: name === undefined ? i : name, y: value, raw: item, base: 0, top: value === null ? 0 : value, name });
    }
    return { points, hasExplicitX };
  }
  // 矩形树图：把层级数据按「先父后子、每层按值降序」拉平 ——
  // 必须与 layoutTreemap 的访问顺序一致，否则像素/提示框会与矩形错位。
  if (option.type === 'treemap') {
    const flat: Array<{ node: any; depth: number }> = [];
    const visit = (nodes: any[], depth: number): void => {
      const sorted = nodes
        .slice()
        .sort((a, b) => treemapNodeValue(b) - treemapNodeValue(a));
      for (const node of sorted) {
        flat.push({ node, depth });
        if (Array.isArray(node && node.children) && node.children.length) visit(node.children, depth + 1);
      }
    };
    if (Array.isArray(option.data)) visit(option.data as any[], 0);
    for (let i = 0; i < flat.length; i++) {
      const node = flat[i].node;
      const value = treemapNodeValue(node);
      points.push({
        index: i,
        xValue: node && node.name !== undefined ? node.name : i,
        y: value,
        raw: node,
        base: 0,
        top: value,
        name: node && node.name !== undefined ? String(node.name) : String(i),
      });
    }
    return { points, hasExplicitX: true };
  }
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const parsed = readGenericPoint(item, i, option);
    if (parsed.explicitX) hasExplicitX = true;
    points.push({
      index: i,
      xValue: parsed.xValue,
      y: parsed.y,
      raw: item,
      base: 0,
      top: parsed.y === null ? 0 : parsed.y,
      name: parsed.name,
      size: parsed.size,
    });
  }
  return { points, hasExplicitX };
}

/**
 * 列存（虚拟）系列的建列：**一趟扫描**同时算好数据域、单调性与尺寸范围。
 *
 * 为什么必须一趟：100 万点上每多扫一遍就是几毫秒，而且中间产物（临时数组）会立刻被丢弃；
 * 建完之后只有 `x / y / size` 三条列常驻，`points` 留空 —— 这就是省内存的全部秘密。
 *
 * 输入三种写法都收：
 * 1. 列式 `{ x, y, size? }`（大数据推荐直接给 `Float64Array`，图表**直接采用**，不复制）；
 * 2. `[[x, y], ...]` 元组数组；
 * 3. `[y, y, ...]` 纯数值数组（x 取下标）。
 */
/**
 * 试建数值列：**只有「x 不是数值」这一种失败**返回 `null`（调用方退回惰性原始点），
 * 其余问题（堆叠、长度不一致、空数据…）照旧抛错 —— 那些是用法错误，静默降级更难查。
 */
function tryBuildVirtualColumns(option: SeriesOption, seriesIndex: number): SeriesColumns | null {
  try {
    return buildVirtualColumns(option, seriesIndex);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.indexOf('需要数值型 x') >= 0) return null;
    throw error;
  }
}

function buildVirtualColumns(option: SeriesOption, seriesIndex: number): SeriesColumns {
  const fail: (reason: string) => never = (reason) => {
    throw new Error(`[ice-chart] series[${seriesIndex}].virtual ${reason}`);
  };
  if (option.type !== 'scatter' && option.type !== 'line' && option.type !== 'area') {
    fail(`目前只支持散点 / 折线 / 面积（scatter / line / area），收到 type: '${option.type}'。`);
  }
  if (option.stack) fail('不支持堆叠（stack）。');

  const data: any = option.data;
  let count = 0;
  let readX: ((i: number) => any) | null = null;
  let readY: ((i: number) => any) | null = null;
  let readSize: ((i: number) => any) | null = null;
  /** 列式输入且已经是 Float64Array 时直接采用（省掉一份 8MB/百万点的复制）。 */
  let adoptX: Float64Array | null = null;
  let adoptY: Float64Array | null = null;
  let adoptSize: Float64Array | null = null;

  if (data && !Array.isArray(data) && typeof data === 'object' && (data as any).x !== undefined) {
    const cols: any = data;
    count = Number(cols.y.length) || 0;
    if (Number(cols.x.length) !== count) fail(`的 x / y 长度不一致（${cols.x.length} vs ${cols.y.length}）。`);
    readX = (i) => cols.x[i];
    readY = (i) => cols.y[i];
    readSize = cols.size ? (i) => cols.size[i] : null;
    adoptX = cols.x instanceof Float64Array ? cols.x : null;
    adoptY = cols.y instanceof Float64Array ? cols.y : null;
    adoptSize = cols.size instanceof Float64Array ? cols.size : null;
  } else if (Array.isArray(data)) {
    count = data.length;
    /**
     * 取点规则与**普通系列逐字一致**（`readGenericPoint` 那套）：
     * - 元组 `[x, y, size]` 按位置取；
     * - 对象行按 `xField` / `yField`（默认 `x` / `y`）取，缺了才退下标 ——
     *   原来对象行一律退成「x = 下标、y = 整行」，于是 `{ x, y }` 形状的 data
     *   在虚拟系列里**解析不出来**（y 是 NaN 直接判失败），而普通系列一直读得出来。
     *   这条曾把「大系列 + 对象行」逼回普通路径（每点一个 DataPoint）。
     */
    const xField = option.xField || 'x';
    const yField = option.yField || 'y';
    const readRow = (row: any): { x: any; y: any; size: any } => {
      if (Array.isArray(row)) return { x: row[0], y: row[1], size: row.length > 2 ? row[2] : undefined };
      if (row && typeof row === 'object') {
        const x = row[xField] !== undefined ? row[xField] : row.x !== undefined ? row.x : undefined;
        const y = row[yField] !== undefined ? row[yField] : row.y !== undefined ? row.y : row.value;
        return { x, y, size: row.size };
      }
      return { x: undefined, y: row, size: undefined };
    };
    readX = (i) => {
      const parsed = readRow(data[i]);
      return parsed.x === undefined ? i : parsed.x;
    };
    readY = (i) => readRow(data[i]).y;
    readSize = (i) => readRow(data[i]).size;
  } else {
    fail('需要 data（列式 { x, y }、元组数组或数值数组）。');
  }

  const x = adoptX && adoptX.length === count ? adoptX : new Float64Array(count);
  const y = adoptY && adoptY.length === count ? adoptY : new Float64Array(count);
  if (!readX || !readY) fail('的数据无法解析。');
  if (!adoptX || adoptX.length !== count) {
    for (let i = 0; i < count; i++) {
      const value = Number(readX(i));
      if (!isFinite(value)) fail(`需要数值型 x（第 ${i} 项是 ${JSON.stringify(readX(i))}）。`);
      x[i] = value;
    }
  } else {
    for (let i = 0; i < count; i++) {
      if (!isFinite(x[i])) fail(`需要数值型 x（第 ${i} 项是 ${JSON.stringify(x[i])}）。`);
    }
  }

  let hasSize = false;
  const size = adoptSize && adoptSize.length === count ? adoptSize : new Float64Array(count).fill(NaN);
  for (let i = 0; i < count; i++) {
    const rawSize = readSize ? readSize(i) : undefined;
    if (rawSize !== undefined && rawSize !== null && rawSize !== '') {
      const parsed = Number(rawSize);
      if (isFinite(parsed)) {
        size[i] = parsed;
        hasSize = true;
      }
    }
    const parsedY = toNumber(readY(i));
    y[i] = parsedY === null ? NaN : parsedY;
  }

  // 数据域 / 单调性：与建列同一趟（下面的循环就是扫描本体，上面那次只做了拷贝）
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let sMin = Infinity;
  let sMax = -Infinity;
  let monotonic = true;
  let prevX = -Infinity;
  for (let i = 0; i < count; i++) {
    const xv = x[i];
    if (xv < xMin) xMin = xv;
    if (xv > xMax) xMax = xv;
    if (xv < prevX) monotonic = false;
    prevX = xv;
    const yv = y[i];
    if (!Number.isNaN(yv)) {
      if (yv < yMin) yMin = yv;
      if (yv > yMax) yMax = yv;
    }
    const sv = size[i];
    if (!Number.isNaN(sv)) {
      if (sv < sMin) sMin = sv;
      if (sv > sMax) sMax = sv;
    }
  }
  if (!isFinite(xMin)) {
    xMin = 0;
    xMax = 1;
  }
  return {
    kind: 'columns',
    x,
    y,
    size: hasSize ? size : null,
    xDomain: [xMin, xMax],
    yDomain: isFinite(yMin) ? [yMin, yMax] : null,
    xMonotonic: monotonic,
    sizeExtent: hasSize ? (sMin === sMax ? [sMin, sMin + 1] : [sMin, sMax]) : null,
  };
}

/** 有专门列存布局的类型（数值列 / 稠密矩阵）；其余的 virtual 系列走「惰性原始点」。 */
function isColumnarVirtualType(type: SeriesOption['type']): boolean {
  return type === 'scatter' || type === 'line' || type === 'area' || type === 'heatmap';
}

/**
 * 惰性原始点存储：**一趟扫描**算好数据域 / 单调性 / 尺寸范围，但**不建 `DataPoint`**。
 *
 * 取点规则与普通系列共用 `readGenericPoint` —— 所以 virtual 与普通系列在提示框 /
 * 命中里表现一致，只有「对象什么时候造」不同。原始数据按引用保留（见 `SeriesRawPoints`）。
 */
function buildVirtualRawPoints(option: SeriesOption, seriesIndex: number): SeriesRawPoints {
  const raw = Array.isArray(option.data) ? option.data : [];
  const count = raw.length;
  const rule = { type: option.type, xField: option.xField, yField: option.yField };
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let sMin = Infinity;
  let sMax = -Infinity;
  let monotonic = true;
  let prevX = -Infinity;
  let hasSize = false;
  const categories: any[] = [];
  const categoryCounts = new Map<string, number>();
  const categorySeq = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const parsed = readGenericPoint(raw[i], i, rule);
    const key = String(parsed.xValue);
    if ((categoryCounts.get(key) ?? 0) === 0) {
      categories.push(parsed.xValue);
      categorySeq.set(key, categorySeq.size);
    }
    categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1);
    const x = Number(parsed.xValue);
    if (isFinite(x)) {
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (x < prevX) monotonic = false;
      prevX = x;
    } else {
      // 类目 / 时间字符串：数值域没有意义，单调性按「不能证明」处理
      monotonic = false;
    }
    if (parsed.y !== null) {
      if (parsed.y < yMin) yMin = parsed.y;
      if (parsed.y > yMax) yMax = parsed.y;
    }
    if (typeof parsed.size === 'number' && isFinite(parsed.size)) {
      hasSize = true;
      if (parsed.size < sMin) sMin = parsed.size;
      if (parsed.size > sMax) sMax = parsed.size;
    }
  }
  if (!isFinite(xMin)) {
    xMin = 0;
    xMax = Math.max(0, count - 1);
  }
  void seriesIndex;
  return {
    kind: 'raw',
    data: raw,
    start: 0,
    length: count,
    capacity: 0,
    type: option.type,
    xField: option.xField,
    yField: option.yField,
    xDomain: [xMin, xMax],
    yDomain: isFinite(yMin) ? [yMin, yMax] : null,
    xMonotonic: monotonic,
    sizeExtent: hasSize ? (sMin === sMax ? [sMin, sMin + 1] : [sMin, sMax]) : null,
    categories,
    categoryCounts,
    categorySeq,
    categoryNext: categorySeq.size,
  };
}

/** 分块输入的判定（`sizes` + `loadChunk` 是它的两个必需字段）。 */
function isChunkedInput(data: any): boolean {
  return !!data && !Array.isArray(data) && typeof data === 'object' && Array.isArray(data.sizes) && typeof data.loadChunk === 'function';
}

/**
 * 分块列存（`virtual: true` + `data: { sizes, loadChunk, rangeOf }`）。
 *
 * 归一化**不加载任何块**：只登记块长度、逻辑起点与（可选的）块 x 范围。
 * 真正的加载发生在渲染 / 命中拿到可见窗口之后（见 `util/chunks.ts`）——
 * 这是「内存与数据总量解耦」的关键：初始化 10 亿点的图，代价只是几个数组。
 */
function buildVirtualChunks(input: any, seriesIndex: number): SeriesChunks {
  const fail: (reason: string) => never = (reason) => {
    throw new Error(`[ice-chart] series[${seriesIndex}].virtual ${reason}`);
  };
  const sizes = input.sizes as any[];
  if (!sizes.length) fail('的分块需要至少一块（sizes 为空）。');
  for (const size of sizes) {
    if (!isFinite(Number(size)) || Number(size) <= 0) {
      fail(`的 sizes 必须是正数（收到 ${JSON.stringify(size)}）。`);
    }
  }
  if (typeof input.rangeOf !== 'function') {
    fail('的分块需要 rangeOf(i) 声明每块的 x 范围（否则窗口定位要先把块 load 一遍）。');
  }
  const yDomain = input.yDomain;
  if (!Array.isArray(yDomain) || yDomain.length !== 2 || !yDomain.every((v: any) => isFinite(Number(v)))) {
    fail('的分块需要声明式 yDomain: [min, max]（亿级数据不能为了自动缩放把块全加载一遍）。');
  }
  return createChunks({
    sizes: sizes.map((size) => Number(size)),
    load: (index: number) => {
      const raw = input.loadChunk(index);
      const normalize = (columns: any): { x: Float64Array; y: Float64Array } => {
        if (!columns || typeof columns !== 'object' || columns.x === undefined || columns.y === undefined) {
          fail(`的 loadChunk(${index}) 必须返回 { x, y }。`);
        }
        const size = sizes[index] === undefined ? 0 : Number(sizes[index]);
        const x = columns.x instanceof Float64Array ? columns.x : Float64Array.from(columns.x as ArrayLike<number>, (v: any) => Number(v));
        const y = new Float64Array(size);
        for (let i = 0; i < size; i++) {
          const value = columns.y[i];
          y[i] = value === null || value === undefined || value === '' ? NaN : Number(value);
        }
        if (x.length !== size) fail(`的 loadChunk(${index}) 返回了 ${x.length} 个 x，但 sizes[${index}] 是 ${size}。`);
        return { x, y };
      };
      if (raw && typeof (raw as PromiseLike<any>).then === 'function') {
        return (raw as PromiseLike<any>).then(normalize);
      }
      return normalize(raw);
    },
    rangeOf: input.rangeOf,
    yDomain: [Number(yDomain[0]), Number(yDomain[1])],
    maxResidentChunks: input.maxResidentChunks,
  });
}

/**
 * 虚拟（列存）**稠密矩阵**：热力图的建列。
 *
 * 热力图的数据天然是矩阵（列类目 × 行类目 → 值），所以这里不做「点集 → 列」的搬运，
 * 而是直接按矩阵存：类目定行列，值按行优先排进一个 `Float64Array`。
 * 收益是三件事一起到手 —— 内存（100 万格 8MB）、**命中 O(1)**（类目查表 + 下标运算）、
 * 以及绘制可以按窗口裁剪（不用每帧把所有格子都 fillRect 一遍）。
 *
 * 为什么校验密度：稀疏数据用矩阵存会**更费**内存（1000 个类目里只有 100 个格子有值，
 * 矩阵还是 100 万格）。低于阈值直接报错，让调用方走普通路径。
 */
const VIRTUAL_GRID_MIN_DENSITY = 0.25;

function buildVirtualGrid(option: SeriesOption, seriesIndex: number): SeriesGrid {
  const fail: (reason: string) => never = (reason) => {
    throw new Error(`[ice-chart] series[${seriesIndex}].virtual ${reason}`);
  };
  const data: any = option.data;
  const xCategories: any[] = [];
  const yCategories: any[] = [];
  let values: Float64Array | null = null;
  /** 元组输入时实际提供了值的格子数（密度校验用）。 */
  let provided = 0;
  let fromTuples = false;

  if (data && !Array.isArray(data) && typeof data === 'object' && (data as any).values !== undefined) {
    const source: any = data;
    if (Array.isArray(source.xCategories)) xCategories.push(...source.xCategories);
    if (Array.isArray(source.yCategories)) yCategories.push(...source.yCategories);
    const cols = xCategories.length;
    const rows = yCategories.length;
    if (!cols || !rows) fail('的矩阵需要非空的 xCategories / yCategories。');
    const expected = cols * rows;
    const length = Number(source.values.length) || 0;
    if (length !== expected) fail(`的 values 长度（${length}）应等于 ${cols} × ${rows} = ${expected}。`);
    values =
      source.values instanceof Float64Array
        ? source.values
        : Float64Array.from(source.values as ArrayLike<number>, (v: any) =>
            v === null || v === undefined ? NaN : Number(v)
          );
    provided = expected;
  } else if (Array.isArray(data)) {
    fromTuples = true;
    const xLookup = new Map<any, number>();
    const yLookup = new Map<any, number>();
    const cells: Array<{ col: number; row: number; value: number }> = [];
    for (let i = 0; i < data.length; i++) {
      const item: any = data[i];
      if (!Array.isArray(item) || item.length < 3) continue;
      let col = xLookup.get(item[0]);
      if (col === undefined) {
        col = xCategories.length;
        xLookup.set(item[0], col);
        xCategories.push(item[0]);
      }
      let row = yLookup.get(item[1]);
      if (row === undefined) {
        row = yCategories.length;
        yLookup.set(item[1], row);
        yCategories.push(item[1]);
      }
      const value = toNumber(item[2]);
      if (value === null) continue;
      cells.push({ col, row, value });
      provided += 1;
    }
    const cols = xCategories.length;
    const rows = yCategories.length;
    if (!cols || !rows) fail('的矩阵是空的（没有可用的 [x类目, y类目, 值] 数据项）。');
    values = new Float64Array(cols * rows).fill(NaN);
    for (const cell of cells) values[cell.row * cols + cell.col] = cell.value;
  } else {
    fail('需要 data（矩阵 { xCategories, yCategories, values } 或 [x类目, y类目, 值] 数组）。');
  }

  const cols = xCategories.length;
  const rows = yCategories.length;
  if (fromTuples && provided / Math.max(1, cols * rows) < VIRTUAL_GRID_MIN_DENSITY) {
    fail(
      `的矩阵太稀疏（${provided}/${cols * rows} 格有值）：虚拟热力图按稠密矩阵存，` +
        '稀疏数据请用普通路径（去掉 virtual）。'
    );
  }
  const matrix = values as Float64Array;
  const xIndex = new Map<any, number>();
  const yIndex = new Map<any, number>();
  for (let i = 0; i < cols; i++) xIndex.set(xCategories[i], i);
  for (let i = 0; i < rows; i++) yIndex.set(yCategories[i], i);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < matrix.length; i++) {
    const value = matrix[i];
    if (Number.isNaN(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    xCategories,
    yCategories,
    values: matrix,
    xIndex,
    yIndex,
    valueDomain: isFinite(min) ? [min, max] : null,
  };
}

/** 推断 x 轴类型：显式配置优先，其次是「有柱状图 → 类目」。 */
function resolveXAxisType(option: AxisOption, series: InternalSeries[]): 'linear' | 'category' | 'time' | 'log' {
  if (option.type) return option.type;
  if (
    series.some(
      (s) =>
        s.type === 'bar' ||
        s.type === 'heatmap' ||
        s.type === 'boxplot' ||
        s.type === 'waterfall' ||
        // 分布组图：观测值按**组**排布，x 天然是类目（数值 x 也是「第几组」的意思）
        s.type === 'violin' ||
        s.type === 'beeswarm'
    )
  )
    return 'category';
  const values: any[] = [];
  for (const s of series) {
    for (let i = 0, n = s.pointCount; i < n; i++) {
      values.push(s.xValueAt(i));
      if (values.length > 2000) break;
    }
  }
  if (values.some((v) => v instanceof Date)) return 'time';
  if (values.some((v) => typeof v === 'number' && Math.abs(v) > 1e11)) return 'time';
  if (values.some((v) => typeof v === 'string' && !isFinite(Number(v)))) {
    // 非数字字符串：当作类目（时间字符串需要显式声明 type: 'time'）
    return 'category';
  }
  return 'linear';
}

/** 是否为横向排布：声明了类目 y 轴（type: 'category' 或给了 data），而 x 轴不是类目轴。 */
export function isHorizontalLayout(xAxis: AxisOption, yAxis: AxisOption): boolean {
  const yIsCategory = yAxis.type === 'category' || (Array.isArray(yAxis.data) && yAxis.data.length > 0);
  if (!yIsCategory) return false;
  if (xAxis.type === 'category' || (Array.isArray(xAxis.data) && xAxis.data.length > 0)) return false;
  return true;
}

/**
 * 类目轴上的类目列表：
 * 1. 轴自己声明的 data（横向柱状图常用写法）；
 * 2. 否则从数据项推导 —— 对象数据的 name、或 xValue（我们内部统一用 xValue 存「类目」这一维）。
 */
export function buildCategoryValues(option: AxisOption, series: InternalSeries[]): any[] {
  if (Array.isArray(option.data) && option.data.length) return option.data.slice();
  const seen: Record<string, boolean> = {};
  const out: any[] = [];
  for (const s of series) {
    // 惰性原始点（自定义系列）：类目表是**增量维护**的，直接用（滚动窗口下每帧重扫是 3ms 级）
    if (s.raw) {
      for (const value of s.raw.categories) {
        const key = String(value);
        if (seen[key]) continue;
        seen[key] = true;
        out.push(value);
      }
      continue;
    }
    for (let i = 0, n = s.pointCount; i < n; i++) {
      const point = s.pointAt(i);
      const value = point.name === undefined ? point.xValue : point.name;
      const key = String(value);
      if (seen[key]) continue;
      seen[key] = true;
      out.push(value);
    }
  }
  return out;
}

/**
 * 把轴上声明的类目按**下标**回填到数据点。
 *
 * 只在「数据点没有自带类目」时回填（默认 xValue === index），
 * 这样 `{name:'A', value:1}` 这类自带类目的数据不会被覆盖。
 */
export function applyAxisCategories(axis: AxisOption, series: InternalSeries[]): void {
  if (!axis || !Array.isArray(axis.data) || !axis.data.length) return;
  const data = axis.data;
  for (const s of series) {
    // 列存（虚拟）系列的类目顺序在「建列那一趟」就定死了（列是事实来源），
    // 这里回填只会写入合成出来的临时对象，白跑 100 万次
    if (s.virtual) continue;
    // 写回点（列存系列在 Phase 3 换「写列」分支；普通系列就是写 points 里那一个对象）
    for (let i = 0, n = s.pointCount; i < n; i++) {
      const point = s.pointAt(i);
      if (point.xValue !== point.index) continue;
      if (data[point.index] === undefined) continue;
      point.xValue = data[point.index];
      if (point.name === undefined) point.name = String(data[point.index]);
    }
  }
}

/**
 * 函数绘图 / 参数曲线的「数据点」：由表达式在参数区间上现算。
 *
 * 这些点同时承担三个角色：
 * 1. 提示框 / 高亮环的锚点（下标稳定，随可视区间重新生成）；
 * 2. x 轴数据域的来源（function 用 x，parametric 用 `domainXValues` = x(t)）；
 * 3. y 轴数据域的来源（用稳健范围，避免 `1/x`、`tan(x)` 的尖峰把轴拉到 ±2500）。
 *
 * 表达式编译失败**不抛异常**（否则一个手滑的输入会把整张图搞崩），
 * 而是把原因写进 `expressionError`，由 `chart.expressionErrors()` 暴露给表单。
 */
function buildCurvePoints(option: SeriesOption, context?: NormalizeContext): { points: DataPoint[]; hasExplicitX: boolean } {
  const points: DataPoint[] = [];
  const params = option.params || {};
  const isFunction = option.type === 'function';
  // 极坐标简写：`polarExpression` = r(θ)，展开成 (r·cosθ, r·sinθ) 的参数曲线
  const polarSource = option.polarExpression === undefined || option.polarExpression === null ? '' : String(option.polarExpression).trim();
  const isPolar = !isFunction && polarSource !== '';
  const source = isFunction ? String(option.expression || '') : isPolar ? polarSource : String(option.xExpression || '');
  const sourceY = isFunction || isPolar ? '' : String(option.yExpression || '');
  let compiledX: { evaluate: (scope: Record<string, number>) => number } | null = null;
  let compiledY: { evaluate: (scope: Record<string, number>) => number } | null = null;
  try {
    compiledX = compileExpression(source);
    if (!isFunction && !isPolar) compiledY = compileExpression(sourceY);
  } catch (err) {
    // 编译失败：点全部为空（曲线不画），原因由 applyCurveDomain 记录到 expressionError
    compiledX = null;
    compiledY = null;
  }

  const fallbackDomain: [number, number] = isFunction ? [-10, 10] : [0, Math.PI * 2];
  const declared = Array.isArray(option.domain) && option.domain.length >= 2 ? option.domain : null;
  let from = declared ? Number(declared[0]) : fallbackDomain[0];
  let to = declared ? Number(declared[1]) : fallbackDomain[1];
  // 函数图的参数区间 = 当前可视 x 区间（缩放后重新生成锚点，y 轴才会自动贴合）
  if (isFunction && context && Array.isArray(context.xDomain) && context.xDomain.length >= 2) {
    const winFrom = Number(context.xDomain[0]);
    const winTo = Number(context.xDomain[1]);
    if (isFinite(winFrom) && isFinite(winTo) && winTo > winFrom) {
      from = winFrom;
      to = winTo;
    }
  }
  if (!isFinite(from) || !isFinite(to) || to === from) {
    from = fallbackDomain[0];
    to = fallbackDomain[1];
  }

  const requested = Number(option.samples);
  const count = Math.max(24, Math.min(6000, isFinite(requested) && requested > 0 ? Math.round(requested) : isFunction ? 240 : 360));
  const scope: Record<string, number> = { ...params };
  const variable = isFunction ? 'x' : 't';

  for (let i = 0; i < count; i++) {
    const parameter = from + ((to - from) * i) / (count - 1);
    scope[variable] = parameter;
    let x = parameter;
    let y = NaN;
    let radius = NaN;
    if (compiledX) {
      if (isFunction) {
        y = compiledX.evaluate(scope);
      } else if (isPolar) {
        radius = compiledX.evaluate(scope);
        x = radius * Math.cos(parameter);
        y = radius * Math.sin(parameter);
      } else if (compiledY) {
        x = compiledX.evaluate(scope);
        y = compiledY.evaluate(scope);
      }
    }
    const finite = isFinite(x) && isFinite(y);
    points.push({
      index: i,
      // function 的 xValue 就是横坐标；parametric 的 xValue 是参数 t（横坐标另存在 raw.x）
      xValue: isFunction ? parameter : parameter,
      y: finite ? y : null,
      raw: isFunction ? { x: parameter, y } : isPolar ? { t: parameter, x, y, r: radius } : { t: parameter, x, y },
      base: 0,
      top: finite ? y : 0,
      name: isFunction ? source : isPolar ? `r = ${source}` : `(${source}, ${sourceY})`,
    });
  }
  return { points, hasExplicitX: true };
}

/** 把曲线系列的「数据域采样值」挂到内部系列上（y 用稳健范围，x 取 x(t) 的极值）。 */
function applyCurveDomain(series: InternalSeries, option: SeriesOption, context?: NormalizeContext): void {
  if (option.type !== 'function' && option.type !== 'parametric') return;
  const ys: number[] = [];
  const xs: number[] = [];
  for (let i = 0, n = series.pointCount; i < n; i++) {
    const point = series.pointAt(i);
    const raw: any = point.raw;
    if (raw && typeof raw === 'object') {
      if (typeof raw.x === 'number') xs.push(raw.x);
      if (typeof raw.y === 'number') ys.push(raw.y);
    }
  }
  const finiteYs = ys.filter((v) => isFinite(v));
  if (finiteYs.length) series.domainValues = robustRange(finiteYs);
  if (option.type === 'parametric') {
    const finiteXs = xs.filter((v) => isFinite(v));
    if (finiteXs.length) series.domainXValues = [Math.min(...finiteXs), Math.max(...finiteXs)];
  }
  // 表达式诊断：语法 → 未定义变量 / 参数没用上 → 整段画不出来 / 输出恒定。
  // 图表永远不崩：错误只挂在这里，表单可以标红，控制台不必猜。
  const params = option.params || {};
  let diagnostics: ReturnType<typeof diagnoseExpression> = [];
  if (option.type === 'function') {
    diagnostics = diagnoseExpression(String(option.expression || ''), {
      variable: 'x',
      params,
      values: ys,
    });
  } else if (option.polarExpression !== undefined && option.polarExpression !== null && String(option.polarExpression).trim() !== '') {
    // 极坐标：诊断看的是 r(θ) 本身（x/y 是它的派生值，用它俩判断会给出误导性的提示）
    const radii: number[] = [];
    for (let i = 0, n = series.pointCount; i < n; i++) {
      const point = series.pointAt(i);
      const raw: any = point.raw;
      if (raw && typeof raw === 'object' && typeof raw.r === 'number') radii.push(raw.r);
    }
    diagnostics = diagnoseExpression(String(option.polarExpression), { variable: 't', params, values: radii }).map((item) => ({
      ...item,
      message: `r(θ)：${item.message}`,
    }));
  } else {
    const sourceX = String(option.xExpression || '');
    const sourceY = String(option.yExpression || '');
    const varsX = expressionVariables(sourceX);
    const varsY = expressionVariables(sourceY);
    const withPrefix = (list: ReturnType<typeof diagnoseExpression>, prefix: string) =>
      list.map((item) => ({ ...item, message: `${prefix}：${item.message}` }));
    diagnostics = [
      // x(t) 与 y(t) 是两条表达式：各自的错误分别报，参数「没用上」按两条的并集判断
      ...withPrefix(diagnoseExpression(sourceX, { variable: 't', params, values: xs, additionalVariables: varsY }), 'x(t)'),
      ...withPrefix(diagnoseExpression(sourceY, { variable: 't', params, values: ys, additionalVariables: varsX }), 'y(t)'),
    ];
  }
  if (diagnostics.length) {
    series.expressionDiagnostics = diagnostics;
    const firstError = diagnostics.find((item) => item.severity === 'error');
    if (firstError) series.expressionError = firstError.message;
  }
  void context;
}

/** 取表达式的自由变量；编译失败就返回空（错误由诊断负责报）。 */
function expressionVariables(source: string): string[] {
  try {
    return compileExpression(source).variables;
  } catch (err) {
    return [];
  }
}

/**
 * 两张类目表是否**逐项同一**（`!==`，不做字符串转换）。
 *
 * 用它当「同一张表」的判据：通过就意味着两张表连值的类型都一样，
 * 合并去重的结果必然与其中一张相同 —— 于是可以省掉一整趟 `String()` + 哈希。
 * 任何一处不同（哪怕只是 `1` 与 `'1'` 这类字符串相等）就老实退回合并。
 */
function sameCategories(a: SeriesRawPoints, b: SeriesRawPoints): boolean {
  const left = a.categories;
  const right = b.categories;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/**
 * 把声明了 `xFrom` 的系列从类目合并里摘出去（见 `SeriesOption.xFrom`）。
 *
 * 一条声明只在「被引用的系列确实在、且两者点数相同」时生效 —— 应用抄错了只会退回合并
 * （慢一点），不会给出一张错的轴。派生系列（均线 / MACD / 成交量）在百万点规模下
 * 正是靠这条把「每帧 N 张 1M 表的合并」整个省掉。
 */
function withoutAliasedX(series: InternalSeries[]): InternalSeries[] {
  const hasAlias = series.some((s) => {
    const from = (s.option as any) && (s.option as any).xFrom;
    return typeof from === 'string' && from.length > 0;
  });
  if (!hasAlias) return series;
  return series.filter((s) => {
    const from = (s.option as any) && (s.option as any).xFrom;
    if (typeof from !== 'string' || !from) return true;
    const source = series.find((item) => item.id === from);
    if (!source) return true;
    return source.pointCount !== s.pointCount;
  });
}

/**
 * 数组 / 对象的稳定身份编号（WeakMap：不阻止回收，也不长期持有）。
 *
 * 只用来当**缓存键**：同一个数组对象 = 同一份数据。调用方就地改内容属于越界用法 ——
 * 这与惰性原始点那条「原始数据按引用保留」是同一条口径（见 `AGENTS.md` 的虚拟化一节）。
 */
const sourceIdentities = new WeakMap<object, number>();
let sourceIdentitySeq = 0;
function identityOf(value: any): number {
  if (!value || typeof value !== 'object') return 0;
  const existing = sourceIdentities.get(value);
  if (existing !== undefined) return existing;
  sourceIdentitySeq += 1;
  sourceIdentities.set(value, sourceIdentitySeq);
  return sourceIdentitySeq;
}

/**
 * 增量表的查表口：下标 = 自己的绝对序号 − 首项序号（与 `rawCategoryIndex` 同一口径）。
 *
 * ⚠️ 它读的是**增量维护中的那张 Map**，所以只对「当前这一帧的域」有效 ——
 * `BandScale` 每次重建都会拿到新查表口（`buildScales` 里现取），照常使用没问题；
 * 别把它存下来跨帧用（下一帧头部淘汰后同一个 key 的绝对序号没变，但基准变了）。
 */
function incrementalLookup(state: OrdinaryCategoryIncremental): (key: string) => number {
  const base = state.values.length ? state.seq.get(String(state.values[0])) : undefined;
  const from = base === undefined ? 0 : base;
  return (key: string) => {
    const at = state.seq.get(key);
    return at === undefined ? -1 : at - from;
  };
}

function incrementalResult(state: OrdinaryCategoryIncremental): {
  domain: any[];
  categories: any[];
  categoryLookup: (key: string) => number;
} {
  // 域是**只读约定**：交一份拷贝出去，表自己的数组留着继续增量维护
  const owned = state.values.slice();
  return { domain: owned, categories: owned, categoryLookup: incrementalLookup(state) };
}

/**
 * 增量：只认「头部淘汰 + 尾部追加」这一种形状，而且**逐项验过**才认。
 *
 * 验不过返回 null —— 调用方走全量聚合（宁可多算一次，不给错的轴）。
 * 验证用的是「上一次的 x 值序列」和这一次的逐项**同一性**比较（不做字符串转换），
 * 所以中间被换掉、换了数据源、窗口内出现重复类目，都会当场被挡下来。
 */
function tryIncrementalCategoryDomain(
  series: InternalSeries,
  state: OrdinaryCategoryIncremental
): { domain: any[]; categories: any[]; categoryLookup: (key: string) => number } | null {
  const n = series.pointCount;
  const values = state.values;
  if (!state.unique || !n || !values.length) return null;
  const head = state.seq.get(String(series.xValueAt(0)));
  const base = state.seq.get(String(values[0]));
  if (head === undefined || base === undefined || head < base) return null;
  const shift = head - base; // 头部淘汰了几项
  const overlap = Math.min(n, values.length - shift);
  if (overlap <= 0) return null;
  for (let i = 0; i < overlap; i++) {
    if (series.xValueAt(i) !== values[i + shift]) return null;
  }
  const added: any[] = [];
  const addedKeys: string[] = [];
  for (let i = overlap; i < n; i++) {
    const value = series.xValueAt(i);
    const key = String(value);
    if (state.seq.has(key)) return null; // 出现重复类目 → 增量前提不成立
    added.push(value);
    addedKeys.push(key);
  }
  // 全验过了才动状态：上面任何一处 return null 都不许留下半成品
  for (let i = 0; i < shift; i++) state.seq.delete(String(values[i]));
  const kept = values.slice(shift, shift + overlap);
  if (shift + overlap < values.length) {
    /**
     * 尾部被裁掉：这几个序号也一并作废，并把 `next` 压回「最后一个存活序号 + 1」。
     *
     * 不压回去就会留下**空洞**（存活序号不连续），而下标 = 序号 − 首项序号 ——
     * 空洞会让后面追加的类目下标整体偏大：`BandScale` 一看越界就判「不在域里」，
     * 那些柱子 / 点直接不画（实测：窗口先变短、再追加一项就会踩到）。
     */
    for (let i = shift + overlap; i < values.length; i++) state.seq.delete(String(values[i]));
    const lastSeq = kept.length ? state.seq.get(String(kept[kept.length - 1])) : undefined;
    state.next = lastSeq === undefined ? 0 : lastSeq + 1;
  }
  for (let i = 0; i < addedKeys.length; i++) state.seq.set(addedKeys[i], state.next++);
  state.values = kept.concat(added);
  return incrementalResult(state);
}

/**
 * 这些来源的 x 是不是与给定域**逐项同一**（值相同、顺序相同）？
 *
 * 单来源时它是「窗口内类目互不相同」的判据（那时域就是那串 x）；
 * 多来源时它还多一个用途 —— **逐项相同时，合并域必然就是这张表本身**，
 * 于是「K 线 + 量柱 + 均线共用同一批 x」这种形状不必每帧再合并一遍
 * （实测 10 万点 3 系列：48.3ms/tick → 只剩增量那几毫秒）。
 */
function sourcesMatchDomain(series: InternalSeries[], domain: any[]): boolean {
  for (const item of series) {
    if (item.pointCount !== domain.length) return false;
    for (let i = 0; i < domain.length; i++) {
      if (item.xValueAt(i) !== domain[i]) return false;
    }
  }
  return true;
}

/**
 * 全量聚合之后把状态记下来（下次才有得增量）；类目有重复就不记（前提不成立）。
 *
 * `seq` 直接**复用聚合那趟的 `seen`**（同样是「key → 下标」，而此时序号恰好就是下标 ——
 * 类目互不相同的窗口里序号从 0 连号排下来），`values` 也复用那份类目数组 ——
 * 否则「验证没过、退回全量」的每一帧都会白建一张 10 万条的 Map（实测 +2.3ms/tick）。
 */
function recordOrdinaryCategoryIncremental(
  series: InternalSeries,
  categories: any[],
  seen: Map<string, number>,
  cache?: CategoryDomainCache
): void {
  if (!cache) return;
  if (categories.length !== series.pointCount) {
    cache.incremental = null;
    return;
  }
  cache.incremental = { seriesId: series.id, values: categories, seq: seen, next: categories.length, unique: true };
}

function buildXDomain(
  type: string,
  series: InternalSeries[],
  option: AxisOption,
  cache?: CategoryDomainCache
): { domain: any[]; categories: any[]; categoryLookup?: (key: string) => number } {
  if (type === 'category') series = withoutAliasedX(series);
  /** 类目域的指纹：任一存储变了（长度 / 新增计数 / 类目表大小 / 首末键）就不再命中。 */
  const cacheKey = (): string => {
    let key = type;
    /**
     * 轴自己声明的类目：域直接来自这个数组 —— 它的**身份**必须进键。
     *
     * 只按「系列的长度 / 首末 x」记键是不健全的：换一份同长度、首末相同的
     * `axis.data`（改中间一项）会命中过期的域（已修，见 `tests/option/category-domain-cache.test.ts`）。
     */
    const axisData = (option as any).data;
    if (Array.isArray(axisData) && axisData.length) {
      key += `|ax:${identityOf(axisData)}:${axisData.length}`;
    }
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      if (s.raw) {
        const cat = s.raw.categories;
        key += `|r${i}:${cat.length}:${s.raw.categoryNext}:${s.raw.categoryCounts.size}:${String(cat[0])}:${String(cat[cat.length - 1])}`;
      } else if (s.option && Array.isArray(s.option.data)) {
        /**
         * 普通系列：**数组身份**（同一份数组 = 同一份数据）。长度与首末照旧带着 ——
         * 就地改首末仍然是能认出来的（改中间认不出来，那是「原始数据按引用保留」的既定口径）。
         */
        const rows = s.option.data as any[];
        const n = s.pointCount;
        key += `|d${i}:${identityOf(rows)}:${n}:${n ? String(s.xValueAt(0)) : ''}:${n ? String(s.xValueAt(n - 1)) : ''}`;
      } else {
        const n = s.pointCount;
        key += `|p${i}:${n}:${n ? String(s.xValueAt(0)) : ''}:${n ? String(s.xValueAt(n - 1)) : ''}`;
      }
    }
    return key;
  };
  const hit = cache ? cache.key === cacheKey() : false;
  if (hit && cache) return cache.result;
  const remember = (result: { domain: any[]; categories: any[]; categoryLookup?: (key: string) => number }) => {
    if (cache) {
      cache.key = cacheKey();
      cache.result = result;
    }
    return result;
  };
  if (type === 'category') {
    /**
     * 列存（虚拟）热力图：类目顺序由矩阵定死（值矩阵按这个顺序排），
     * 优先于「轴自己声明的 data」与数据聚合 —— 顺序错了格子就整体错位。
     */
    const grid = series.find((s) => s.grid);
    if (grid && grid.grid) return remember({ domain: grid.grid.xCategories.slice(), categories: grid.grid.xCategories.slice() });
    // 轴自己声明了类目就用它（顺序即轴的顺序），否则从数据里聚合
    if (Array.isArray(option.data) && option.data.length) {
      return remember({ domain: option.data.slice(), categories: option.data.slice() });
    }
    /**
     * **普通来源：先试增量**（滚动窗口那趟「头部淘汰 + 尾部追加」）。
     *
     * 背景：这条路上每 tick 都要把类目重新去重一遍 —— 10 万点实测 2.9ms/tick，
     * 是普通路径里最大的一笔（函数级 profile 见 `plans/incremental-pipeline.md` 第 5 期）。
     * 多来源时先算第一条的增量表，再验证**其余来源与它逐项同一** —— 同一就不必再合并
     * （K 线 + 量柱 + 均线共用同一批 x 的形状，实测 3 系列 10 万点 48.3ms/tick）。
     * 具体形状与纪律见 `OrdinaryCategoryIncremental`。
     */
    const plainSource = (item: InternalSeries): boolean => !!(item && !item.raw && !item.grid && item.option && Array.isArray(item.option.data));
    const leader = series.length && series.every(plainSource) ? series[0] : null;
    const incremental = cache && cache.incremental ? cache.incremental : null;
    if (leader && incremental && incremental.seriesId === leader.id) {
      const built = tryIncrementalCategoryDomain(leader, incremental);
      if (built && sourcesMatchDomain(series, built.categories)) return remember(built);
    }
    /**
     * 合并去重：`Map<key, 下标>` —— 它一趟同时给出「见没见过」和「在合并域里的下标」，
     * 于是合并那条路也能交出 `categoryLookup`（BandScale 就不必再自建一张同规模的表）。
     */
    const seen = new Map<string, number>();
    const categories: any[] = [];
    /**
     * **单一「惰性原始点」来源的快路径**（2026-09-23）。
     *
     * 这类系列的存储里那张表本来就是「去重 + 首次出现顺序」，而且是**增量维护**的
     * （见 `SeriesRawPoints` 的 categories / categoryCounts，滚动窗口只动两头）。
     * 只有一个来源时再走一遍 `seen` 去重是白跑：10 万类目 × 每帧两趟归一化 =
     * 每 tick 二十万次 `String()` 哈希，实测占整条流水线的三分之一。
     *
     * 多个来源（多系列各自带类目）才需要合并去重，那条路原样保留。
     */
    if (series.length === 1 && series[0].raw) {
      // 复制一份再交出去：域是**只读约定**，但把存储那个数组直接共享出去的话，
      // 下游按数组身份做的缓存（BandScale 的索引表）会在存储就地追加 / 淘汰时读到过期内容。
      // `slice()` 只是一趟 memcpy，比重新做一遍字符串去重便宜一个量级。
      const store = series[0].raw as SeriesRawPoints;
      const owned = store.categories.slice();
      // 查表口直连存储那张增量维护的表：类目轴不必每帧重建一遍 10 万条的 Map。
      return remember({ domain: owned, categories: owned, categoryLookup: (key: string) => rawCategoryIndex(store, key) });
    }
    /**
     * **多个来源但类目表逐项相同**：直接复用第一张表（连查表口一起）。
     *
     * 滚动看盘就是这种形状：K 线、量柱、均线的 x 本来就是同一批，而下面那条合并去重
     * 要对**每一张表**跑一遍 `String()` + 哈希 —— 100 万 × 2 实测 **200ms/次**
     * （整帧从 4ms 掉到 4fps 的元凶）。
     *
     * 判据是**逐项同一性**（`!==`，不做字符串转换）：通过就意味着两张表连值的类型都一样，
     * 「合并去重」的结果必然就是第一张表本身 —— 与下面那条路的结论**逐项一致**；
     * 任何一处不同（哪怕只是 `1` 与 `'1'` 这类字符串相等），就老实退回下面合并。
     */
    if (series.length > 1 && series.every((s) => !!s.raw)) {
      /**
       * 先把**逐项相同**的表归成一组：滚动看盘里 K 线 / 量柱 / 均线常常共享同一批 x，
       * 而下面那趟合并要对**每一张表**跑一遍 `String()` + 哈希（100 万 × 5 实测 ~500ms/次）。
       * 判据是**逐项同一性**（`!==`，不做字符串转换）：不同的表才进合并，
       * 与「全量合并」的结论逐项一致（相同的表本来就贡献不了新类目）。
       */
      const distinct: SeriesRawPoints[] = [];
      for (const s of series) {
        const store = s.raw as SeriesRawPoints;
        let known = false;
        for (const kept of distinct) {
          if (sameCategories(kept, store)) {
            known = true;
            break;
          }
        }
        if (!known) distinct.push(store);
      }
      if (distinct.length === 1) {
        const only = distinct[0];
        const owned = only.categories.slice();
        return remember({ domain: owned, categories: owned, categoryLookup: (key: string) => rawCategoryIndex(only, key) });
      }
      for (const store of distinct) {
        for (const value of store.categories) {
          const key = String(value);
          if (!seen.has(key)) {
            seen.set(key, categories.length);
            categories.push(value);
          }
        }
      }
      return remember({ domain: categories, categories, categoryLookup: (key: string) => { const at = seen.get(key); return at === undefined ? -1 : at; } });
    }
    for (const s of series) {
      // 惰性原始点：类目表增量维护在存储里（滚动窗口下别每帧重扫）
      if (s.raw) {
        for (const value of s.raw.categories) {
          const key = String(value);
          if (!seen.has(key)) {
            seen.set(key, categories.length);
            categories.push(value);
          }
        }
        continue;
      }
      for (let i = 0, n = s.pointCount; i < n; i++) {
        const xValue = s.xValueAt(i);
        const key = String(xValue);
        if (!seen.has(key)) {
          seen.set(key, categories.length);
          categories.push(xValue);
        }
      }
    }
    /**
     * 全量聚合完，把状态记下来 —— 下一帧的滚动窗口就能走增量。
     * 只有「所有来源与这张表逐项同一」才记：多来源时合并域通常不等于任何单条的 x 序列，
     * 那种形状没法用增量表表示（记了就是错的域），退回每帧全量合并。
     */
    if (leader && sourcesMatchDomain(series, categories)) recordOrdinaryCategoryIncremental(leader, categories, seen, cache);
    return remember({
      domain: categories,
      categories,
      categoryLookup: (key: string) => {
        const at = seen.get(key);
        return at === undefined ? -1 : at;
      },
    });
  }

  const values: number[] = [];
  for (const s of series) {
    // 虚拟（列存）系列：数据域在归一化那一趟里算好了，别再扫一遍全量数据
    const domain = storeDomainOf(s);
    if (domain) {
      values.push(domain.xDomain[0], domain.xDomain[1]);
      continue;
    }
    // 参数曲线的横坐标不是 xValue（那是参数 t），要用 x(t) 的极值
    if (s.domainXValues && s.domainXValues.length) {
      for (const v of s.domainXValues) if (isFinite(v)) values.push(v);
      continue;
    }
    for (let i = 0, n = s.pointCount; i < n; i++) {
      const xValue = s.xValueAt(i);
      const v = type === 'time' ? toTimestamp(xValue) : Number(xValue);
      if (isFinite(v)) values.push(v);
    }
  }
  let [min, max] = extent(values);
  const minFixed = isFiniteNumber(option.min as number);
  const maxFixed = isFiniteNumber(option.max as number);
  if (minFixed) min = option.min as number;
  if (maxFixed) max = option.max as number;
  if (option.nice !== false) [min, max] = niceDomain([min, max], option.tickCount || 5);
  if (type !== 'log') {
    // 留白放在取整**之后**：先留白会把 40 抬到 42，再取整变成 50（白多一整格）；
    // 先取整再留白，得到的就是「整刻度 + 5% 余量」，刻度值也不受影响。
    [min, max] = padDomain(min, max, option, minFixed, maxFixed);
  }
  return { domain: [min, max], categories: [] };
}

/**
 * 把「缩放窗口」落到 x 轴上。
 *
 * 数值/时间轴：窗口就是 [起始值, 结束值] 两个数。
 * **类目轴：窗口是两个类目，必须切成类目数组的一个区间** ——
 * 直接赋值成 `[起始类目, 结束类目]` 会把 36 个类目的轴塌缩成 2 个类目，
 * 表现是柱子突然变得极宽、刻度只剩两个（这是真实踩过的坑）。
 */
function resolveXDomain(
  type: string,
  fullDomain: any[],
  window: [any, any] | null | undefined,
  lookup?: (key: string) => number
): { domain: any[]; offset: number } {
  if (!window) return { domain: fullDomain, offset: 0 };
  if (type !== 'category') return { domain: [window[0], window[1]], offset: 0 };
  /**
   * 端点在**整张类目表**里的下标。有现成查表口就别 `indexOf`：那是两趟 O(n)，
   * 10 万类目的滚动窗口每次归一化都要扫到底（实测 0.3ms/次）——
   * 而查表口是一次 Map 查询（`rawCategoryIndex`）。
   */
  const at = (value: any): number => {
    if (!lookup) return fullDomain.indexOf(value);
    const index = lookup(String(value));
    return index >= 0 && index < fullDomain.length ? index : -1;
  };
  const from = at(window[0]);
  const to = at(window[1]);
  // `offset` 一并交出去：窗口的域是整张表的一段，BandScale 要靠它把「全表下标」换算成窗口内下标
  if (from >= 0 && to >= from) return { domain: fullDomain.slice(from, to + 1), offset: from };
  // 窗口端点不在类目里（例如来自滑块的比例换算抖动）：退化为原域
  return { domain: fullDomain, offset: 0 };
}

/**
 * 等比坐标（`aspect: 'equal'`，MATLAB 的 `axis equal`）。
 *
 * 做法：把两个轴的数据**跨度**拉齐到较大的那个（各自按中心扩展），
 * 配合布局阶段把绘图区收缩成正方形 —— 于是「1 个单位 = 相同像素数」。
 *
 * 为什么不是只收缩绘图区：正方形只保证画布上的宽高相等，
 * x 跨度 2、y 跨度 10 时单位长度仍然不等，圆还是椭圆。
 * 为什么不是只拉数据域：绘图区还是长方形，网格会空出一大片，曲线缩在中间很别扭。
 *
 * 类目轴不参与（把类目之间的间距拉齐没有意义）。
 */
function applyEqualAspect(option: ChartOption, kind: string, xAxis: InternalAxis, yAxes: InternalAxis[]): void {
  if (option.aspect !== 'equal' || kind !== 'cartesian') return;
  if (xAxis.type === 'category') return;
  const yAxis = yAxes[0];
  if (!yAxis || yAxis.type === 'category') return;
  const x0 = Number(xAxis.domain[0]);
  const x1 = Number(xAxis.domain[1]);
  const y0 = Number(yAxis.domain[0]);
  const y1 = Number(yAxis.domain[1]);
  if (![x0, x1, y0, y1].every((v) => isFinite(v))) return;
  const xSpan = Math.abs(x1 - x0);
  const ySpan = Math.abs(y1 - y0);
  const span = Math.max(xSpan, ySpan);
  if (!(span > 0)) return;
  if (xSpan < span) {
    const center = (x0 + x1) / 2;
    xAxis.domain = [center - span / 2, center + span / 2];
  }
  if (ySpan < span) {
    const center = (y0 + y1) / 2;
    yAxis.domain = [center - span / 2, center + span / 2];
  }
}

function buildYDomain(series: InternalSeries[], axisIndex: number, option: AxisOption, type: string): [number, number] {
  const values: number[] = [];
  let includeZero = false;
  for (const s of series) {
    if (s.hidden) continue;
    if (s.axisIndex !== axisIndex) continue;
    if (s.type === 'bar' || s.type === 'area') includeZero = true;
    // 虚拟（列存）系列：数据域在归一化那一趟里算好了
    const domain = storeDomainOf(s);
    if (domain) {
      if (domain.yDomain) values.push(domain.yDomain[0], domain.yDomain[1]);
      continue;
    }
    // 函数绘图：数据域用稳健范围（分位数剪掉尖峰），而不是逐点求 min/max
    if (s.domainValues && s.domainValues.length) {
      const [lo, hi] = robustRange(s.domainValues);
      values.push(lo, hi);
      continue;
    }
    for (let i = 0, n = s.pointCount; i < n; i++) {
      const p = s.pointAt(i);
      if (p.y !== null) values.push(p.y);
      // 箱线图的须（min/max）也要进数据域
      if (p.boxplot) {
        values.push(p.boxplot[0], p.boxplot[4]);
      }
      // 小提琴图按**密度网格的端点**进域（不是观测极值）：轮廓比观测范围宽出 3 个带宽，
      // 用观测极值会让两端的尖角被绘图区边缘切平
      if (p.violin && p.violin.grid.length) {
        values.push(p.violin.grid[0], p.violin.grid[p.violin.grid.length - 1]);
      }
      if (s.option.stack) {
        values.push(p.base);
        values.push(p.top);
      }
      // 瀑布图的每根柱子都从 base 长到 top，两端都要进数据域
      if (s.type === 'waterfall') {
        values.push(p.base, p.top);
      }
    }
  }
  let [min, max] = extent(values);
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  const minFixed = isFiniteNumber(option.min as number);
  const maxFixed = isFiniteNumber(option.max as number);
  if (minFixed) min = option.min as number;
  if (maxFixed) max = option.max as number;
  if (option.nice !== false && type !== 'log') {
    [min, max] = niceDomain([min, max], option.tickCount || 5);
  }
  if (type !== 'log') {
    // 留白放在取整之后（同上）；柱子 / 面积的基线（被 includeZero 拉到 0 的那一侧）保持贴在轴上
    const baselineMin = includeZero && !minFixed && Math.abs(min) < 1e-12;
    const baselineMax = includeZero && !maxFixed && Math.abs(max) < 1e-12;
    [min, max] = padDomain(min, max, option, minFixed || baselineMin, maxFixed || baselineMax);
  }
  if (type === 'log') {
    const positive = values.filter((v) => v > 0);
    if (positive.length) {
      min = Math.min(...positive);
      max = Math.max(...positive);
    } else {
      min = 1;
      max = 10;
    }
    if (isFiniteNumber(option.min as number) && (option.min as number) > 0) min = option.min as number;
    if (isFiniteNumber(option.max as number) && (option.max as number) > 0) max = option.max as number;
  }
  return [round(min, 10), round(max, 10)];
}

/** 雷达图每个指标轴的数据域：indicator.max 优先，否则取各系列在该指标上的最大值。 */
function buildRadarDomains(radar: RadarOption, series: InternalSeries[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const count = Array.isArray(radar.indicators) ? radar.indicators.length : 0;
  for (let i = 0; i < count; i++) {
    const indicator = radar.indicators[i] || { name: String(i) };
    let max = -Infinity;
    for (const s of series) {
      if (s.type !== 'radar' || s.hidden) continue;
      const point = s.pointAt(i);
      if (!point || point.y === null) continue;
      if (point.y > max) max = point.y;
    }
    if (!isFinite(max)) max = 1;
    const min = isFiniteNumber(indicator.min as number) ? (indicator.min as number) : 0;
    const declaredMax = isFiniteNumber(indicator.max as number) ? (indicator.max as number) : max;
    out.push([min, declaredMax > min ? declaredMax : min + 1]);
  }
  return out;
}

/** 堆叠：同名 stack 的系列在同一 x 上累加，写入每个点的 base/top。 */
/**
 * 瀑布图：按累计值推导每根柱子的 base / top。
 *
 * - 普通项：base = 当前累计，top = 累计 + 数值，然后累计 += 数值；
 * - 合计项（数据项标了 `total: true`）：base = 0、top = 当前累计，**不改变累计**。
 */
function applyWaterfall(series: InternalSeries[]): void {
  for (const s of series) {
    if (s.type !== 'waterfall') continue;
    if (s.virtual) continue; // 列存系列不在这里改点（虚拟系列也不支持堆叠 / 瀑布）
    let cumulative = 0;
    // 写回点（列存系列在 Phase 3 换「写列」分支）
    for (let i = 0, n = s.pointCount; i < n; i++) {
      const point = s.pointAt(i);
      const raw: any = point.raw;
      const isTotal = !!(raw && typeof raw === 'object' && !Array.isArray(raw) && raw.total);
      const value = point.y || 0;
      if (isTotal) {
        point.base = 0;
        point.top = cumulative;
      } else {
        point.base = cumulative;
        point.top = cumulative + value;
        cumulative += value;
      }
    }
  }
}

/** 箱线图：原始观测值 → [min, Q1, median, Q3, max]（五数概括）。 */
/** 矩形树图节点的数值：有子节点时取子节点之和。 */
export function treemapNodeValue(node: any): number {
  if (!node) return 0;
  if (Array.isArray(node.children) && node.children.length) {
    return node.children.reduce((sum: number, child: any) => sum + treemapNodeValue(child), 0);
  }
  const value = Number(node.value);
  return isFinite(value) && value > 0 ? value : 0;
}

export function computeBoxplotSummary(values: number[]): [number, number, number, number, number] {
  const sorted = values.filter((v) => isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return [0, 0, 0, 0, 0];
  const quantile = (p: number): number => {
    const pos = (sorted.length - 1) * p;
    const lower = Math.floor(pos);
    const upper = Math.ceil(pos);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
  };
  return [sorted[0], quantile(0.25), quantile(0.5), quantile(0.75), sorted[sorted.length - 1]];
}

function applyStacking(series: InternalSeries[]): void {
  const groups: Record<string, InternalSeries[]> = {};
  for (const s of series) {
    // 列存（虚拟）系列不支持堆叠，也没有可写的点（列是事实来源）——
    // 别在这里白跑 100 万次
    if (s.virtual) continue;
    if (!s.option.stack) {
      for (let i = 0, n = s.pointCount; i < n; i++) {
        const p = s.pointAt(i);
        p.base = 0;
        p.top = p.y === null ? 0 : p.y;
      }
      continue;
    }
    // 堆叠按「轴 + stack 名」分组：不同 y 轴上的同名 stack 不应互相累加
    const key = `${s.axisIndex}::${s.option.stack}`;
    (groups[key] = groups[key] || []).push(s);
  }
  for (const key in groups) {
    const group = groups[key];
    const cumulative: Record<string, number> = {};
    for (const s of group) {
      // 写回点（列存系列在 Phase 3 换「写列」分支）
      for (let i = 0, n = s.pointCount; i < n; i++) {
        const p = s.pointAt(i);
        const k = String(p.xValue);
        const base = cumulative[k] || 0;
        const value = p.y === null ? 0 : p.y;
        p.base = base;
        p.top = base + value;
        cumulative[k] = p.top;
      }
    }
  }
}

/** 从 option 里剔除函数与 undefined，得到可 JSON 序列化的配置。 */
export function toSerializableOption(option: any): any {
  if (option === null || option === undefined) return option;
  if (Array.isArray(option)) return option.map(toSerializableOption);
  if (typeof option === 'function') return undefined;
  if (typeof option === 'object') {
    const out: any = {};
    for (const key in option) {
      if (!Object.prototype.hasOwnProperty.call(option, key)) continue;
      const value = toSerializableOption(option[key]);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  return option;
}
