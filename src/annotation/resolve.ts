import type {
  AnnotationAreaOption,
  AnnotationDiagnostic,
  AnnotationDiagnosticCode,
  AnnotationLineOption,
  AnnotationOption,
  AnnotationPointOption,
  AnnotationPointTextPosition,
  AnnotationTextPosition,
  ChartTheme,
} from '../types';
import type { InternalAxis, Rect } from '../internal';
import { toTimestamp } from '../scale/TimeScale';

/**
 * 标注的「数据 → 像素」解析。
 *
 * 这一层是**纯函数**（不碰 ctx、不碰 DOM），与 `normalizeOption` / `computeLayout` 同属可单测层：
 * 表单要预览、审计要断言几何、调用方要解释「为什么不画」，都只需要喂一份 option + 坐标轴。
 *
 * 三条约定：
 * 1. 定位一律走轴的 `scale.map()`，**并在这里加上绘图区偏移** —— `scale.map()` 返回的是
 *    绘图区本地坐标（0..plot.width），覆盖层直接用它就会整块画到左上角（PolarGrid 踩过）。
 * 2. 线 / 点落在可视域外**不画**（诊断说明原因）；区间只画可见的那一段。
 * 3. 任何一条坏标注都不影响其它标注，也不让图表崩 —— 错误进诊断，图形照画。
 */

export interface ResolvedLine {
  kind: 'line';
  index: number;
  axis: 'x' | 'y';
  axisIndex: number;
  /** 图表坐标系里的定位像素（已含绘图区偏移）。 */
  pixel: number;
  text: string;
  color: string;
  lineWidth: number;
  lineDash: number[];
  textPosition: AnnotationTextPosition;
  textColor: string;
  fontSize: number;
}

export interface ResolvedPoint {
  kind: 'point';
  index: number;
  axisIndex: number;
  /** 图表坐标系里的点位置。 */
  x: number;
  y: number;
  text: string;
  color: string;
  symbol: 'circle' | 'rect' | 'diamond' | 'triangle';
  symbolSize: number;
  textPosition: AnnotationPointTextPosition;
  textColor: string;
  fontSize: number;
}

export interface ResolvedArea {
  kind: 'area';
  index: number;
  axis: 'x' | 'y';
  axisIndex: number;
  /**
   * 区间在定位轴上的两端像素，**保持 from → to 的数据顺序**（y 轴是反的，所以 from 可能大于 to）。
   * 两端都已夹到绘图区范围内：区间有一部分在窗外时只画看得见的那一段。
   */
  from: number;
  to: number;
  color: string;
  text: string;
  textPosition: AnnotationTextPosition;
  textColor: string;
  fontSize: number;
}

export interface ResolvedAnnotation {
  lines: ResolvedLine[];
  points: ResolvedPoint[];
  areas: ResolvedArea[];
}

export interface AnnotationContext {
  /** 场景类型：只有直角坐标才有标注用的坐标系。 */
  kind: string;
  plot: Rect;
  xAxis: InternalAxis;
  yAxes: InternalAxis[];
  theme: ChartTheme;
}

/** 默认虚线：6/4（像素）。标注是「说明」，实线会跟数据线抢视线。 */
const DEFAULT_DASH = [6, 4];

type AxisHit =
  | { ok: true; pixel: number; inside: boolean; label: string }
  | { ok: false; code: AnnotationDiagnosticCode; message: string };

/**
 * 把一个数据值解析成像素。
 *
 * `pixel` 在值越界时照样算得出来（数值轴是线性外推），由调用方决定怎么处理 ——
 * 线 / 点要的是「越界就不画」，区间要的是「夹到绘图区边缘」，两种语义都需要这个原始像素。
 *
 * 类目轴额外允许**写下标**：`{ axis: 'x', value: 2 }` 等价于第 3 个类目。这条只在
 * 「下标不在类目集合里」时启用 —— 否则数值类目（x 就是 0/1/2…）会被下标语义抢走
 * （与 `BandScale.indexOf` 不做数值兜底是同一个理由）。
 */
function resolveAxisValue(axis: InternalAxis, raw: any, plotOffset: number, axisLabel: string): AxisHit {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, code: 'annotation:invalid-value', message: `${axisLabel} 标注缺少定位值。` };
  }
  const scale: any = axis.scale;
  if (!scale || typeof scale.map !== 'function') {
    return { ok: false, code: 'annotation:unsupported-scene', message: '当前场景没有可用于定位的坐标系。' };
  }
  const domain: any[] = scale.domain || [];

  let value = raw;
  if (axis.type === 'category') {
    let index = domain.indexOf(value);
    if (index < 0) index = domain.findIndex((item) => String(item) === String(value));
    if (index < 0) {
      const asIndex = Number(value);
      if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < domain.length) {
        index = asIndex;
      } else {
        return {
          ok: false,
          code: 'annotation:unknown-category',
          message: `${axisLabel} 轴没有类目「${String(raw)}」。`,
        };
      }
    }
    value = domain[index];
    const pixel = Number(scale.map(value));
    if (!isFinite(pixel)) {
      return { ok: false, code: 'annotation:unknown-category', message: `${axisLabel} 轴定位不到「${String(raw)}」。` };
    }
    return { ok: true, pixel: plotOffset + pixel, inside: true, label: String(value) };
  }

  let numeric: number;
  if (axis.type === 'time') {
    numeric = toTimestamp(value);
    if (!isFinite(numeric)) {
      return {
        ok: false,
        code: 'annotation:invalid-value',
        message: `${axisLabel} 标注的「${String(raw)}」不是合法时间。`,
      };
    }
  } else {
    numeric = Number(value);
    if (!isFinite(numeric)) {
      return {
        ok: false,
        code: 'annotation:invalid-value',
        message: `${axisLabel} 标注的「${String(raw)}」不是合法数值。`,
      };
    }
  }
  const pixel = Number(scale.map(numeric));
  if (!isFinite(pixel)) {
    return { ok: false, code: 'annotation:out-of-range', message: `${axisLabel} 标注的「${String(raw)}」无法定位。` };
  }
  const [lo, hi] = domainRange(domain);
  const inside = lo === null || hi === null ? true : numeric >= lo - 1e-9 && numeric <= hi + 1e-9;
  return { ok: true, pixel: plotOffset + pixel, inside, label: String(raw) };
}

/** 数值域的上下界；类目域返回下标范围。 */
function domainRange(domain: any[]): [number | null, number | null] {
  if (!domain || !domain.length) return [null, null];
  const numbers = domain.map((item) => Number(item));
  if (numbers.length && numbers.every((n) => isFinite(n))) {
    return [Math.min(...numbers), Math.max(...numbers)];
  }
  return [0, domain.length - 1];
}

/** 取定位用的轴；多 y 轴时按 `axisIndex` 选，越界退回主轴。 */
function pickAxis(ctx: AnnotationContext, axis: 'x' | 'y', axisIndex?: number): InternalAxis {
  if (axis === 'x') return ctx.xAxis;
  const index = Number.isInteger(axisIndex) && Number(axisIndex) >= 0 ? Number(axisIndex) : 0;
  return ctx.yAxes[index] || ctx.yAxes[0] || ctx.xAxis;
}

function positiveNumber(value: any, fallback: number): number {
  const n = Number(value);
  return isFinite(n) && n > 0 ? n : fallback;
}

function textPosition(value: any, fallback: AnnotationTextPosition): AnnotationTextPosition {
  return value === 'start' || value === 'center' || value === 'end' ? value : fallback;
}

function pointTextPosition(value: any): AnnotationPointTextPosition {
  return value === 'bottom' || value === 'left' || value === 'right' || value === 'top' ? value : 'top';
}

function resolvedLineDash(option: AnnotationLineOption): number[] {
  if (Array.isArray(option.lineDash)) {
    return option.lineDash.filter((n) => isFinite(Number(n)) && Number(n) >= 0).map(Number);
  }
  if (option.dashed === false) return [];
  return DEFAULT_DASH;
}

function symbolOf(value: any): 'circle' | 'rect' | 'diamond' | 'triangle' {
  return value === 'rect' || value === 'diamond' || value === 'triangle' ? value : 'circle';
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function plainText(value: any): string {
  return value === undefined || value === null ? '' : String(value);
}

/** 把颜色压成低透明度（十六进制 / rgb() 支持，其它写法原样返回）。 */
function withAlpha(color: string, alpha: number): string {
  if (typeof color !== 'string') return `rgba(0,0,0,${alpha})`;
  if (color.charAt(0) === '#') {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length !== 6) return color;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (color.indexOf('rgb(') === 0) return color.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  return color;
}

/**
 * 把 option 里的标注解析成「可绘制的像素几何 + 诊断」。
 *
 * 组件在每次同步时重跑它 —— 因为它只读比例尺，所以缩放 / 平移 / 数据更新之后的位置天然是对的，
 * 不需要任何额外的失效逻辑（与 `GridLines` 读坐标轴位置是同一个理由）。
 */
export function resolveAnnotation(
  annotation: AnnotationOption | null | undefined,
  ctx: AnnotationContext
): { resolved: ResolvedAnnotation; diagnostics: AnnotationDiagnostic[] } {
  const resolved: ResolvedAnnotation = { lines: [], points: [], areas: [] };
  const diagnostics: AnnotationDiagnostic[] = [];
  if (!annotation || typeof annotation !== 'object') return { resolved, diagnostics };

  const lines = Array.isArray(annotation.lines) ? annotation.lines : [];
  const points = Array.isArray(annotation.points) ? annotation.points : [];
  const areas = Array.isArray(annotation.areas) ? annotation.areas : [];
  const total = lines.length + points.length + areas.length;
  if (!total) return { resolved, diagnostics };

  // 非直角坐标（饼图 / 雷达 / 桑基 / 树图 …）没有 x/y 坐标系：说明一次就够，不要逐条刷屏
  if (ctx.kind !== 'cartesian') {
    diagnostics.push({
      code: 'annotation:unsupported-scene',
      severity: 'warning',
      message: '标注需要直角坐标系（x / y 轴），当前场景没有，已跳过全部标注。',
      kind: 'line',
      index: 0,
    });
    return { resolved, diagnostics };
  }

  const theme = ctx.theme;
  const defaultColor = theme.textColor;
  const defaultFontSize = theme.fontSize || 12;

  for (let index = 0; index < areas.length; index++) {
    const option: AnnotationAreaOption = areas[index] || {};
    const axis: 'x' | 'y' = option.axis === 'x' ? 'x' : 'y';
    const axisLabel = axis === 'x' ? 'x' : 'y';
    const internal = pickAxis(ctx, axis, option.axisIndex);
    const offset = axis === 'x' ? ctx.plot.x : ctx.plot.y;
    const span = axis === 'x' ? ctx.plot.width : ctx.plot.height;
    const start = resolveAxisValue(internal, option.from, offset, axisLabel);
    const end = resolveAxisValue(internal, option.to, offset, axisLabel);
    // 类目轴定位不到类目、或值根本不是合法数值 → 整段都画不出来
    if (!start.ok || !end.ok) {
      pushDiagnostic(diagnostics, !start.ok ? start : (end as Extract<AxisHit, { ok: false }>), 'area', index);
      continue;
    }
    // 两端各自夹到绘图区：区间一部分在窗外时只画看得见的那一段；
    // 整段在窗外（同侧越界）夹完会退化成一个点，此时才不画
    const edgeLo = offset;
    const edgeHi = offset + span;
    const from = clamp(start.pixel, edgeLo, edgeHi);
    const to = clamp(end.pixel, edgeLo, edgeHi);
    if (Math.abs(to - from) <= 0) {
      diagnostics.push({
        code: 'annotation:out-of-range',
        severity: 'warning',
        message: `标注区间#${index}：区间「${plainText(option.from)} ~ ${plainText(option.to)}」不在当前可视范围内，已跳过。`,
        kind: 'area',
        index,
      });
      continue;
    }
    resolved.areas.push({
      kind: 'area',
      index,
      axis,
      axisIndex: Number.isInteger(option.axisIndex) ? Number(option.axisIndex) : 0,
      from,
      to,
      color: typeof option.color === 'string' && option.color ? option.color : withAlpha(defaultColor, 0.1),
      text: plainText(option.text),
      textPosition: textPosition(option.textPosition, 'center'),
      textColor: typeof option.textColor === 'string' && option.textColor ? option.textColor : defaultColor,
      fontSize: positiveNumber(option.fontSize, defaultFontSize),
    });
  }

  for (let index = 0; index < lines.length; index++) {
    const option: AnnotationLineOption = lines[index] || {};
    const axis: 'x' | 'y' = option.axis === 'x' ? 'x' : 'y';
    const axisLabel = axis === 'x' ? 'x' : 'y';
    const internal = pickAxis(ctx, axis, option.axisIndex);
    const offset = axis === 'x' ? ctx.plot.x : ctx.plot.y;
    const hit = resolveAxisValue(internal, option.value, offset, axisLabel);
    if (!hit.ok) {
      pushDiagnostic(diagnostics, hit, 'line', index);
      continue;
    }
    if (!hit.inside) {
      pushDiagnostic(
        diagnostics,
        {
          ok: false,
          code: 'annotation:out-of-range',
          message: `${axisLabel} 标注的「${hit.label}」不在当前可视范围内，已跳过。`,
        },
        'line',
        index
      );
      continue;
    }
    const color = typeof option.color === 'string' && option.color ? option.color : defaultColor;
    resolved.lines.push({
      kind: 'line',
      index,
      axis,
      axisIndex: Number.isInteger(option.axisIndex) ? Number(option.axisIndex) : 0,
      pixel: hit.pixel,
      text: plainText(option.text),
      color,
      lineWidth: positiveNumber(option.lineWidth, 1),
      lineDash: resolvedLineDash(option),
      textPosition: textPosition(option.textPosition, 'end'),
      textColor: typeof option.textColor === 'string' && option.textColor ? option.textColor : color,
      fontSize: positiveNumber(option.fontSize, defaultFontSize),
    });
  }

  for (let index = 0; index < points.length; index++) {
    const option: AnnotationPointOption = points[index] || {};
    const x = resolveAxisValue(ctx.xAxis, option.x, ctx.plot.x, 'x');
    const y = resolveAxisValue(pickAxis(ctx, 'y', option.axisIndex), option.y, ctx.plot.y, 'y');
    if (!x.ok || !y.ok || !x.inside || !y.inside) {
      const failing = !x.ok
        ? x
        : !y.ok
          ? y
          : !x.inside
            ? {
                ok: false as const,
                code: 'annotation:out-of-range' as const,
                message: `x 标注的「${x.label}」不在当前可视范围内，已跳过。`,
              }
            : {
                ok: false as const,
                code: 'annotation:out-of-range' as const,
                message: `y 标注的「${(y as any).label}」不在当前可视范围内，已跳过。`,
              };
      pushDiagnostic(diagnostics, failing, 'point', index);
      continue;
    }
    const color = typeof option.color === 'string' && option.color ? option.color : defaultColor;
    resolved.points.push({
      kind: 'point',
      index,
      axisIndex: Number.isInteger(option.axisIndex) ? Number(option.axisIndex) : 0,
      x: x.pixel,
      y: y.pixel,
      text: plainText(option.text),
      color,
      symbol: symbolOf(option.symbol),
      symbolSize: positiveNumber(option.symbolSize, 8),
      textPosition: pointTextPosition(option.textPosition),
      textColor: typeof option.textColor === 'string' && option.textColor ? option.textColor : color,
      fontSize: positiveNumber(option.fontSize, defaultFontSize),
    });
  }

  return { resolved, diagnostics };
}

function pushDiagnostic(
  out: AnnotationDiagnostic[],
  result: Extract<AxisHit, { ok: false }>,
  kind: 'line' | 'point' | 'area',
  index: number
): void {
  const label = kind === 'line' ? '标注线' : kind === 'point' ? '标注点' : '标注区间';
  out.push({
    code: result.code,
    severity: result.code === 'annotation:invalid-value' ? 'error' : 'warning',
    message: `${label}#${index}：${result.message}`,
    kind,
    index,
  });
}
