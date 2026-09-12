import type { AxisOption, ChartOption, ChartTheme, SeriesOption } from '../types';
import type { RadarOption, SankeyNodeOption, SankeyOption } from '../types';
import type { DataPoint, InternalAxis, InternalSeries, NormalizedOption } from '../internal';
import { resolveChartTheme } from '../theme/chartTheme';
import { extent, isFiniteNumber, isNil, niceDomain, round } from '../util/math';
import { toTimestamp } from '../scale/TimeScale';

const DEFAULT_MARGIN = { top: 12, right: 16, bottom: 12, left: 12 };

const DEFAULT_ANIMATION = { enabled: true, duration: 480, easing: 'cubicOut' };

export interface NormalizeContext {
  hiddenIds?: Record<string, boolean>;
  /** 被隐藏的扇区（饼图），key 为 `seriesId#dataIndex`。 */
  hiddenSlices?: Record<string, boolean>;
  /** 当前 x 数据域（数据缩放后）。不传表示自动。 */
  xDomain?: [any, any] | null;
  /** 主 y 轴的数据域（缩放后），等价于 yDomains[0]。 */
  yDomain?: [number, number] | null;
  /** 每个 y 轴的数据域（多轴时按 index 区分）。 */
  yDomains?: Array<[number, number] | null>;
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

  const theme = resolveChartTheme(option.theme);
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
    animation: { ...DEFAULT_ANIMATION, ...(option.animation || {}) },
    margin: { ...DEFAULT_MARGIN, ...(option.margin || {}) },
  };
  merged.series = option.series;
  merged.title = option.title;
  merged.xAxis = option.xAxis || {};
  merged.yAxis = option.yAxis || {};
  merged.dataZoom = option.dataZoom || null;
  merged.theme = option.theme;
  merged.tooltip = { show: option.tooltip?.show !== false, ...merged.tooltip };
  merged.crosshair = { show: option.crosshair?.show !== false, ...merged.crosshair };

  const radar = option.radar || null;
  const series = buildSeries(option.series, theme, merged.legend?.selected || {}, radar, option.sankey || null);
  const hiddenIds: Record<string, boolean> = { ...(context.hiddenIds || {}) };
  for (const s of series) {
    if (merged.legend?.selected && merged.legend.selected[s.name] === false) {
      hiddenIds[s.id] = true;
    }
    s.hidden = !!hiddenIds[s.id] || s.option.show === false;
  }

  const kind: 'cartesian' | 'polar' | 'radar' | 'sankey' | 'funnel' | 'gauge' = series.some((s) => s.type === 'pie')
    ? 'polar'
    : series.some((s) => s.type === 'radar')
      ? 'radar'
      : series.some((s) => s.type === 'sankey')
        ? 'sankey'
        : series.some((s) => s.type === 'funnel')
          ? 'funnel'
          : series.some((s) => s.type === 'gauge')
            ? 'gauge'
            : 'cartesian';
  const sankey = kind === 'sankey' ? option.sankey || null : null;
  const funnel = kind === 'funnel' ? option.funnel || {} : null;
  const gauge = kind === 'gauge' ? option.gauge || {} : null;
  const hiddenSlices: Record<string, boolean> = { ...(context.hiddenSlices || {}) };
  const radarDomains: Array<[number, number]> = radar ? buildRadarDomains(radar, series) : [];
  if (kind !== 'cartesian' && (!option.tooltip || option.tooltip.trigger === undefined)) {
    // 非直角坐标没有「数据列」的概念，默认按数据项触发提示
    merged.tooltip.trigger = 'item';
  }
  const xAxisOption: AxisOption = merged.xAxis;
  // ECharts 习惯用 type: 'value' 表示数值轴，这里统一成内部的 'linear'
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
   * 排布方向：类目轴在 y 上就是横向柱状图（排行榜场景）。
   * 判定依据与 ECharts 一致 —— 声明了类目 y 轴（type 或 data），且 x 轴不是类目轴。
   */
  const horizontal = isHorizontalLayout(xAxisOption, yAxisOptions[0]);
  if (horizontal && (!option.tooltip || option.tooltip.trigger === undefined)) {
    // 横向图的类目在 y 轴上，没有「按 x 取整列」的语义，默认按数据项触发
    merged.tooltip.trigger = 'item';
  }
  // 轴声明了类目时，数据项按**下标**对齐到类目
  //（ECharts 常见写法：series.data 只给数值，类目由 axis.data 提供）
  applyAxisCategories(horizontal ? yAxisOptions[0] : xAxisOption, series);
  const xType = horizontal
    ? xAxisOption.type && xAxisOption.type !== 'category'
      ? xAxisOption.type
      : 'linear'
    : resolveXAxisType(xAxisOption, series);
  let rawXDomain: any[];
  let categories: any[];
  if (horizontal) {
    // 横向：x 轴承载数值（用 y 轴那套值域算法），类目搬到 y 轴
    rawXDomain = buildYDomain(series, 0, xAxisOption, xType) as any[];
    categories = [];
    // 类目轴上的类目：优先用 yAxis.data，其次从数据项的 name / xValue 推导
    const yCategories = buildCategoryValues(yAxisOptions[0], series);
    yAxisOptions[0] = { ...yAxisOptions[0], type: 'category' };
    (yAxisOptions[0] as any).__categories = yCategories;
  } else {
    const built = buildXDomain(xType, series, xAxisOption);
    rawXDomain = built.domain;
    categories = built.categories;
  }
  const xDomain = resolveXDomain(xType, rawXDomain, context.xDomain);

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
      };
    }
    // 热力图需要「类目 y 轴」：y 方向也是离散类目
    if (hasHeatmap && (option.type === undefined || option.type === 'category')) {
      const seen: Record<string, boolean> = {};
      const categories: any[] = [];
      for (const s of series) {
        if (s.type !== 'heatmap') continue;
        for (const point of s.points) {
          const key = String(point.name === undefined ? point.xValue : point.name);
          if (!seen[key]) {
            seen[key] = true;
            categories.push(point.name === undefined ? point.xValue : point.name);
          }
        }
      }
      return { option, type: 'category' as const, domain: categories, scale: null, index, position: option.position || (index === 0 ? 'left' : 'right') };
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

  return {
    kind,
    orientation: horizontal ? 'horizontal' : 'vertical',
    radar,
    sankey,
    funnel,
    gauge,
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

function buildSeries(
  seriesOptions: SeriesOption[],
  theme: ChartTheme,
  _selected: Record<string, boolean>,
  radar?: RadarOption | null,
  sankey?: SankeyOption | null
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
    const { points, hasExplicitX } = buildPoints(option, radar, sankey);
    if (option.type === 'pie') {
      // 饼图：每个扇区一个颜色（可被数据项自身的 color 覆盖）
      for (let p = 0; p < points.length; p++) {
        const raw = points[p].raw;
        const own = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.color : undefined;
        points[p].color = own || (p === 0 && option.color ? option.color : theme.colorPalette[p % theme.colorPalette.length]);
      }
    }
    out.push({ id, index: i, type: option.type, name, color, option, points, hasExplicitX, hidden: false, axisIndex: 0 });
  }
  return out;
}

function buildPoints(
  option: SeriesOption,
  radar?: RadarOption | null,
  sankey?: SankeyOption | null
): { points: DataPoint[]; hasExplicitX: boolean } {
  const raw = Array.isArray(option.data) ? option.data : [];
  const points: DataPoint[] = [];
  let hasExplicitX = false;
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
  // K 线：每个数据项是 [open, close, low, high]
  if (option.type === 'candlestick') {
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      const tuple = Array.isArray(item)
        ? item
        : item && typeof item === 'object' && Array.isArray((item as any).value)
          ? (item as any).value
          : null;
      if (!tuple || tuple.length < 4) {
        points.push({ index: i, xValue: i, y: null, raw: item, base: 0, top: 0 });
        continue;
      }
      const open = toNumber(tuple[0]);
      const close = toNumber(tuple[1]);
      const low = toNumber(tuple[2]);
      const high = toNumber(tuple[3]);
      const name = item && typeof item === 'object' && !Array.isArray(item) && (item as any).name !== undefined ? String((item as any).name) : undefined;
      hasExplicitX = true;
      points.push({
        index: i,
        xValue: name === undefined ? i : name,
        y: close,
        raw: item,
        base: 0,
        top: close === null ? 0 : close,
        name,
        ohlc: [
          open === null ? 0 : open,
          close === null ? 0 : close,
          low === null ? 0 : low,
          high === null ? 0 : high,
        ],
      });
    }
    return { points, hasExplicitX };
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
      const summary: [number, number, number, number, number] =
        tuple.length >= 5 ? [tuple[0], tuple[1], tuple[2], tuple[3], tuple[4]] : computeBoxplotSummary(tuple);
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
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    let xValue: any = i;
    let y: number | null = null;
    /** 第三维（气泡尺寸）。 */
    let size: number | undefined;
    let explicitX = false;
    if (Array.isArray(item)) {
      xValue = item[0];
      y = toNumber(item[1]);
      // 气泡图：第三维是尺寸
      if (item.length > 2) {
        const parsed = toNumber(item[2]);
        size = parsed === null ? undefined : parsed;
      }
      explicitX = true;
    } else if (typeof item === 'number' || item === null) {
      y = toNumber(item);
    } else if (item && typeof item === 'object') {
      const xField = option.xField || 'x';
      const yField = option.yField || 'y';
      if (item[xField] !== undefined) {
        xValue = item[xField];
        explicitX = true;
      } else if (item.x !== undefined) {
        xValue = item.x;
        explicitX = true;
      } else if (item.name !== undefined && option.type === 'bar') {
        xValue = item.name;
        explicitX = true;
      }
      if (item[yField] !== undefined) y = toNumber(item[yField]);
      else if (item.y !== undefined) y = toNumber(item.y);
      else if (item.value !== undefined) y = toNumber(item.value);
      if (item.size !== undefined) {
        const parsed = toNumber(item.size);
        size = parsed === null ? undefined : parsed;
      }
    }
    if (explicitX) hasExplicitX = true;
    let name: string | undefined;
    if (item && typeof item === 'object' && !Array.isArray(item) && item.name !== undefined) {
      name = String(item.name);
    } else if (option.type === 'pie' && Array.isArray(item) && typeof item[0] === 'string') {
      name = item[0];
    }
    points.push({ index: i, xValue, y, raw: item, base: 0, top: y === null ? 0 : y, name, size });
  }
  return { points, hasExplicitX };
}

function toNumber(value: any): number | null {
  if (isNil(value)) return null;
  const n = Number(value);
  return isFinite(n) ? n : null;
}

/** 推断 x 轴类型：显式配置优先，其次是「有柱状图 → 类目」。 */
function resolveXAxisType(option: AxisOption, series: InternalSeries[]): 'linear' | 'category' | 'time' | 'log' {
  if (option.type) return option.type;
  if (
    series.some((s) => s.type === 'bar' || s.type === 'candlestick' || s.type === 'heatmap' || s.type === 'boxplot' || s.type === 'waterfall')
  )
    return 'category';
  const values: any[] = [];
  for (const s of series) {
    for (const p of s.points) {
      values.push(p.xValue);
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
 * 1. 轴自己声明的 data（ECharts 写法，横向柱状图常用）；
 * 2. 否则从数据项推导 —— 对象数据的 name、或 xValue（我们内部统一用 xValue 存「类目」这一维）。
 */
export function buildCategoryValues(option: AxisOption, series: InternalSeries[]): any[] {
  if (Array.isArray(option.data) && option.data.length) return option.data.slice();
  const seen: Record<string, boolean> = {};
  const out: any[] = [];
  for (const s of series) {
    for (const point of s.points) {
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
    for (const point of s.points) {
      if (point.xValue !== point.index) continue;
      if (data[point.index] === undefined) continue;
      point.xValue = data[point.index];
      if (point.name === undefined) point.name = String(data[point.index]);
    }
  }
}

function buildXDomain(
  type: string,
  series: InternalSeries[],
  option: AxisOption
): { domain: any[]; categories: any[] } {
  if (type === 'category') {
    // 轴自己声明了类目就用它（顺序即轴的顺序），否则从数据里聚合
    if (Array.isArray(option.data) && option.data.length) {
      return { domain: option.data.slice(), categories: option.data.slice() };
    }
    const seen: Record<string, boolean> = {};
    const categories: any[] = [];
    for (const s of series) {
      for (const p of s.points) {
        const key = String(p.xValue);
        if (!seen[key]) {
          seen[key] = true;
          categories.push(p.xValue);
        }
      }
    }
    return { domain: categories, categories };
  }

  const values: number[] = [];
  for (const s of series) {
    for (const p of s.points) {
      const v = type === 'time' ? toTimestamp(p.xValue) : Number(p.xValue);
      if (isFinite(v)) values.push(v);
    }
  }
  let [min, max] = extent(values);
  if (isFiniteNumber(option.min as number)) min = option.min as number;
  if (isFiniteNumber(option.max as number)) max = option.max as number;
  if (option.nice !== false) [min, max] = niceDomain([min, max], option.tickCount || 5);
  return { domain: [min, max], categories: [] };
}

/**
 * 把「缩放窗口」落到 x 轴上。
 *
 * 数值/时间轴：窗口就是 [起始值, 结束值] 两个数。
 * **类目轴：窗口是两个类目，必须切成类目数组的一个区间** ——
 * 直接赋值成 `[起始类目, 结束类目]` 会把 36 个类目的轴塌缩成 2 个类目，
 * 表现是柱子/K 线突然变得极宽、刻度只剩两个（这是真实踩过的坑）。
 */
function resolveXDomain(type: string, fullDomain: any[], window: [any, any] | null | undefined): any[] {
  if (!window) return fullDomain;
  if (type !== 'category') return [window[0], window[1]];
  const from = fullDomain.indexOf(window[0]);
  const to = fullDomain.indexOf(window[1]);
  if (from >= 0 && to >= from) return fullDomain.slice(from, to + 1);
  // 窗口端点不在类目里（例如来自滑块的比例换算抖动）：退化为原域
  return fullDomain;
}

function buildYDomain(series: InternalSeries[], axisIndex: number, option: AxisOption, type: string): [number, number] {
  const values: number[] = [];
  let includeZero = false;
  for (const s of series) {
    if (s.hidden) continue;
    if (s.axisIndex !== axisIndex) continue;
    if (s.type === 'bar' || s.type === 'area') includeZero = true;
    for (const p of s.points) {
      if (p.y !== null) values.push(p.y);
      // K 线的影线（low/high）也要进数据域，否则影线会被裁掉
      if (p.ohlc) {
        values.push(p.ohlc[2], p.ohlc[3]);
      }
      // 箱线图的须（min/max）也要进数据域
      if (p.boxplot) {
        values.push(p.boxplot[0], p.boxplot[4]);
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
  if (isFiniteNumber(option.min as number)) min = option.min as number;
  if (isFiniteNumber(option.max as number)) max = option.max as number;
  if (option.nice !== false && type !== 'log') {
    [min, max] = niceDomain([min, max], option.tickCount || 5);
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
      const point = s.points[i];
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
    let cumulative = 0;
    for (const point of s.points) {
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
    if (!s.option.stack) {
      for (const p of s.points) {
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
      for (const p of s.points) {
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
