import type { AxisOption, ChartOption, ChartTheme, SeriesOption } from '../types';
import type { RadarOption } from '../types';
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
  const series = buildSeries(option.series, theme, merged.legend?.selected || {}, radar);
  const hiddenIds: Record<string, boolean> = { ...(context.hiddenIds || {}) };
  for (const s of series) {
    if (merged.legend?.selected && merged.legend.selected[s.name] === false) {
      hiddenIds[s.id] = true;
    }
    s.hidden = !!hiddenIds[s.id] || s.option.show === false;
  }

  const kind: 'cartesian' | 'polar' | 'radar' = series.some((s) => s.type === 'pie')
    ? 'polar'
    : series.some((s) => s.type === 'radar')
      ? 'radar'
      : 'cartesian';
  const hiddenSlices: Record<string, boolean> = { ...(context.hiddenSlices || {}) };
  const radarDomains: Array<[number, number]> = radar ? buildRadarDomains(radar, series) : [];
  if (kind !== 'cartesian' && (!option.tooltip || option.tooltip.trigger === undefined)) {
    // 非直角坐标没有「数据列」的概念，默认按数据项触发提示
    merged.tooltip.trigger = 'item';
  }

  const xAxisOption: AxisOption = merged.xAxis;
  const xType = resolveXAxisType(xAxisOption, series);
  const { domain: rawXDomain, categories } = buildXDomain(xType, series, xAxisOption);
  const xDomain = resolveXDomain(xType, rawXDomain, context.xDomain);

  // 多 y 轴：option.yAxis 可以是单个对象或数组；每个系列用 yAxisIndex 绑定到其中一个
  const yAxisOptions: AxisOption[] = Array.isArray(option.yAxis) ? option.yAxis : [option.yAxis || {}];
  if (!yAxisOptions.length) yAxisOptions.push({});
  for (const s of series) {
    const raw = Number(s.option.yAxisIndex);
    s.axisIndex = isFinite(raw) ? Math.max(0, Math.min(yAxisOptions.length - 1, Math.floor(raw))) : 0;
  }

  applyStacking(series);

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
    radar,
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
  radar?: RadarOption | null
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
    const { points, hasExplicitX } = buildPoints(option, radar);
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

function buildPoints(option: SeriesOption, radar?: RadarOption | null): { points: DataPoint[]; hasExplicitX: boolean } {
  const raw = Array.isArray(option.data) ? option.data : [];
  const points: DataPoint[] = [];
  let hasExplicitX = false;
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
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    let xValue: any = i;
    let y: number | null = null;
    let explicitX = false;
    if (Array.isArray(item)) {
      xValue = item[0];
      y = toNumber(item[1]);
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
    }
    if (explicitX) hasExplicitX = true;
    let name: string | undefined;
    if (item && typeof item === 'object' && !Array.isArray(item) && item.name !== undefined) {
      name = String(item.name);
    } else if (option.type === 'pie' && Array.isArray(item) && typeof item[0] === 'string') {
      name = item[0];
    }
    points.push({ index: i, xValue, y, raw: item, base: 0, top: y === null ? 0 : y, name });
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
  if (series.some((s) => s.type === 'bar' || s.type === 'candlestick' || s.type === 'heatmap')) return 'category';
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

function buildXDomain(
  type: string,
  series: InternalSeries[],
  option: AxisOption
): { domain: any[]; categories: any[] } {
  if (type === 'category') {
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
      if (s.option.stack) {
        values.push(p.base);
        values.push(p.top);
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
