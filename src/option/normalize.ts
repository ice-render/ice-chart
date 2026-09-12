import type { AxisOption, ChartOption, ChartTheme, SeriesOption } from '../types';
import type { DataPoint, InternalAxis, InternalSeries, NormalizedOption } from '../internal';
import { resolveChartTheme } from '../theme/chartTheme';
import { extent, isFiniteNumber, isNil, niceDomain, round } from '../util/math';
import { toTimestamp } from '../scale/TimeScale';

const DEFAULT_MARGIN = { top: 12, right: 16, bottom: 12, left: 12 };

const DEFAULT_ANIMATION = { enabled: true, duration: 480, easing: 'cubicOut' };

export interface NormalizeContext {
  hiddenIds?: Record<string, boolean>;
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
  merged.dataZoom = option.dataZoom || {};
  merged.theme = option.theme;
  merged.tooltip = { show: option.tooltip?.show !== false, ...merged.tooltip };
  merged.crosshair = { show: option.crosshair?.show !== false, ...merged.crosshair };

  const series = buildSeries(option.series, theme, merged.legend?.selected || {});
  const hiddenIds: Record<string, boolean> = { ...(context.hiddenIds || {}) };
  for (const s of series) {
    if (merged.legend?.selected && merged.legend.selected[s.name] === false) {
      hiddenIds[s.id] = true;
    }
    s.hidden = !!hiddenIds[s.id] || s.option.show === false;
  }

  const xAxisOption: AxisOption = merged.xAxis;
  const xType = resolveXAxisType(xAxisOption, series);
  const { domain: rawXDomain, categories } = buildXDomain(xType, series, xAxisOption);
  const xDomain = context.xDomain ? [context.xDomain[0], context.xDomain[1]] : rawXDomain;

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
  const yAxes: InternalAxis[] = yAxisOptions.map((option, index) => {
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
    option: merged,
    theme,
    series,
    xAxis,
    yAxes,
    yAxis,
    categories,
    visibleSeries: series.filter((s) => !s.hidden),
    hiddenIds,
  };
}

function buildSeries(seriesOptions: SeriesOption[], theme: ChartTheme, _selected: Record<string, boolean>): InternalSeries[] {
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
    const { points, hasExplicitX } = buildPoints(option);
    out.push({ id, index: i, type: option.type, name, color, option, points, hasExplicitX, hidden: false, axisIndex: 0 });
  }
  return out;
}

function buildPoints(option: SeriesOption): { points: DataPoint[]; hasExplicitX: boolean } {
  const raw = Array.isArray(option.data) ? option.data : [];
  const points: DataPoint[] = [];
  let hasExplicitX = false;
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
    points.push({ index: i, xValue, y, raw: item, base: 0, top: y === null ? 0 : y });
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
  if (series.some((s) => s.type === 'bar')) return 'category';
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

function buildYDomain(series: InternalSeries[], axisIndex: number, option: AxisOption, type: string): [number, number] {
  const values: number[] = [];
  let includeZero = false;
  for (const s of series) {
    if (s.hidden) continue;
    if (s.axisIndex !== axisIndex) continue;
    if (s.type === 'bar' || s.type === 'area') includeZero = true;
    for (const p of s.points) {
      if (p.y !== null) values.push(p.y);
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
