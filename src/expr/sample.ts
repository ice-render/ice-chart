/**
 * 曲线采样：均匀打底 + 按曲率自适应细分。
 *
 * 为什么不能只均匀采样：`tan(x)` 在极点附近、`exp(-x^2)` 在峰顶附近，
 * 均匀采样的折线要么「削平峰顶」要么「漏掉极点」。自适应细分只在折线与真实曲线
 * 偏差大的地方加点，点数可控（有 maxSamples 上限，不会因为奇异点爆掉）。
 *
 * 非有限值（NaN / ±Inf / 过大）一律写成 `[x, NaN]` 作为**断点**，
 * 渲染时按断点分段 —— 这样 `tan(x)`、`1/x` 会画出真正的渐近线缺口，而不是连一条竖线。
 */

export interface SampleOptions {
  /** 基础均匀采样点数（至少 2），默认 240。 */
  base?: number;
  /** 是否做自适应细分，默认 true。 */
  adaptive?: boolean;
  /** 相对 y 跨度的偏差阈值：越小越精细，默认 0.0025。 */
  tolerance?: number;
  /** 采样点总数上限，默认 6000（奇异点附近会疯狂细分，必须有闸）。 */
  maxSamples?: number;
  /** 递归深度上限，默认 7。 */
  maxDepth?: number;
}

export type CurvePoint = [number, number];

/** 视为「数值爆掉」的阈值：超过它按断点处理（1/x 这种竖直冲刺不该连成线）。 */
const HUGE = 1e7;

/**
 * 稳健取值范围：用四分位距（IQR）丢掉离群点。
 *
 * 为什么不用 min/max：`1/x`、`tan(x)` 的尖峰能把 y 轴拉到 ±2500，
 * 整条曲线会被压成一条直线。用 IQR 之外的数值剪掉之后，画面才像 MATLAB。
 */
export function robustRange(values: number[], k = 6): [number, number] {
  const finite = values.filter((v) => typeof v === 'number' && isFinite(v) && Math.abs(v) < HUGE);
  if (!finite.length) return [-1, 1];
  const sorted = finite.slice().sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
  const median = at(0.5);
  const iqr = at(0.75) - at(0.25);
  let lo = sorted[0];
  let hi = sorted[sorted.length - 1];
  if (iqr > 0) {
    lo = Math.max(lo, median - k * iqr);
    hi = Math.min(hi, median + k * iqr);
  }
  if (!(hi > lo)) {
    const center = (hi + lo) / 2;
    const pad = Math.max(1, Math.abs(center) * 0.2);
    lo = center - pad;
    hi = center + pad;
  }
  return [lo, hi];
}

/** 折线首尾之间的「弯曲程度」：用中点算，递归细化时收敛很快。 */
function midDeviation(x0: number, y0: number, x1: number, y1: number, mx: number, my: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(mx - x0, my - y0);
  let t = ((mx - x0) * dx + (my - y0) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(mx - (x0 + t * dx), my - (y0 + t * dy));
}

interface RefineContext<T> {
  tolerance: number;
  maxDepth: number;
  maxSamples: number;
  count: number;
  adaptive: boolean;
  evaluate: (parameter: number) => T;
  isBreak: (value: T) => boolean;
  deviation: (left: T, mid: T, right: T) => number;
  /** 把采样点写成 [x, y] 两个数字，按顺序追加到 out。 */
  emit: (parameter: number, value: T, out: number[]) => void;
}

/**
 * 在 [a, b] 之间递归细分，**按参数递增顺序**产出采样点（中序）。
 *
 * 端点值由调用方传入（避免每层重复求值 —— 采样是每帧的热路径）。
 */
function refineSegment<T>(
  ctx: RefineContext<T>,
  a: number,
  valueA: T,
  b: number,
  valueB: T,
  depth: number,
  out: number[]
): void {
  const mid = (a + b) / 2;
  if (!isFinite(mid) || mid === a || mid === b) return;
  const valueMid = ctx.evaluate(mid);
  if (ctx.isBreak(valueMid)) {
    // 区间内部有断点（极点）：标一个 NaN 缺口就停 —— 渲染时会在这里断开
    out.push(mid, NaN);
    return;
  }
  const canRefine =
    ctx.adaptive &&
    depth < ctx.maxDepth &&
    ctx.count < ctx.maxSamples &&
    !ctx.isBreak(valueA) &&
    !ctx.isBreak(valueB) &&
    ctx.deviation(valueA, valueMid, valueB) > ctx.tolerance;
  if (!canRefine) return;
  ctx.count++;
  refineSegment(ctx, a, valueA, mid, valueMid, depth + 1, out);
  ctx.emit(mid, valueMid, out);
  refineSegment(ctx, mid, valueMid, b, valueB, depth + 1, out);
}

/** 采样 y = f(x)。返回按 x 升序的点列，断点用 y = NaN 表示。 */
export function sampleFunctionCurve(
  fn: (x: number) => number,
  x0: number,
  x1: number,
  options: SampleOptions = {}
): CurvePoint[] {
  const base = Math.max(2, Math.round(options.base || 240));
  const xs = new Float64Array(base);
  const ys = new Float64Array(base);
  for (let i = 0; i < base; i++) {
    const x = x0 + ((x1 - x0) * i) / (base - 1);
    const y = fn(x);
    xs[i] = x;
    ys[i] = isFinite(y) && Math.abs(y) < HUGE ? y : NaN;
  }
  const [lo, hi] = robustRange(Array.from(ys));
  const span = Math.max(1e-9, hi - lo);
  const ctx: RefineContext<number> = {
    tolerance: Math.max(1e-9, (options.tolerance === undefined ? 0.0025 : options.tolerance) * span),
    maxDepth: options.maxDepth === undefined ? 7 : options.maxDepth,
    maxSamples: options.maxSamples === undefined ? 6000 : options.maxSamples,
    count: base,
    adaptive: options.adaptive !== false,
    evaluate: (x) => fn(x),
    isBreak: (y) => !isFinite(y) || Math.abs(y) > HUGE,
    deviation: (left, mid, right) => Math.abs(mid - (left + right) / 2),
    emit: (x, y, out) => {
      out.push(x, y);
    },
  };
  const out: number[] = [];
  for (let i = 0; i < base; i++) {
    out.push(xs[i], isFinite(ys[i]) ? ys[i] : NaN);
    if (i === base - 1) break;
    refineSegment(ctx, xs[i], ys[i], xs[i + 1], ys[i + 1], 0, out);
  }
  const points: CurvePoint[] = [];
  for (let i = 0; i < out.length; i += 2) points.push([out[i], out[i + 1]]);
  return breakPoles(points, span);
}

/**
 * 极点补刀：`tan(x)` 在 π/2 两侧是 +2500 与 -2500，
 * 单独看每个点都「有限」，连起来却是一条竖直的假线 —— 相邻点符号相反且跳变
 * 远大于可视范围时插一个断点（THU 阈值用可视跨度做尺度，陡峭但连续的函数不受影响）。
 */
function breakPoles(points: CurvePoint[], span: number): CurvePoint[] {
  const threshold = Math.max(1e-9, span) * 20;
  const out: CurvePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const previous = out.length ? out[out.length - 1] : null;
    if (
      previous &&
      isFinite(previous[1]) &&
      isFinite(current[1]) &&
      previous[1] * current[1] < 0 &&
      Math.abs(current[1] - previous[1]) > threshold
    ) {
      out.push([(previous[0] + current[0]) / 2, NaN]);
    }
    out.push(current);
  }
  return out;
}

/** 采样参数曲线 (x(t), y(t))：偏差按平面距离算（曲线可能拐回来，不能只看 y）。 */
export function sampleParametricCurve(
  fx: (t: number) => number,
  fy: (t: number) => number,
  t0: number,
  t1: number,
  options: SampleOptions = {}
): CurvePoint[] {
  const base = Math.max(2, Math.round(options.base || 360));
  const ts = new Float64Array(base);
  const xs = new Float64Array(base);
  const ys = new Float64Array(base);
  for (let i = 0; i < base; i++) {
    const t = t0 + ((t1 - t0) * i) / (base - 1);
    ts[i] = t;
    xs[i] = fx(t);
    ys[i] = fy(t);
  }
  const [xLo, xHi] = robustRange(Array.from(xs));
  const [yLo, yHi] = robustRange(Array.from(ys));
  const diagonal = Math.max(1e-9, Math.hypot(xHi - xLo, yHi - yLo));
  const ctx: RefineContext<CurvePoint> = {
    tolerance: Math.max(1e-9, (options.tolerance === undefined ? 0.0015 : options.tolerance) * diagonal),
    maxDepth: options.maxDepth === undefined ? 7 : options.maxDepth,
    maxSamples: options.maxSamples === undefined ? 8000 : options.maxSamples,
    count: base,
    adaptive: options.adaptive !== false,
    evaluate: (t) => [fx(t), fy(t)] as CurvePoint,
    isBreak: (point) => !isFinite(point[0]) || !isFinite(point[1]) || Math.abs(point[0]) > HUGE || Math.abs(point[1]) > HUGE,
    deviation: (left, mid, right) => midDeviation(left[0], left[1], right[0], right[1], mid[0], mid[1]),
    emit: (_t, point, out) => {
      out.push(point[0], point[1]);
    },
  };
  const out: number[] = [];
  for (let i = 0; i < base; i++) {
    const px = xs[i];
    const py = ys[i];
    const bad = !isFinite(px) || !isFinite(py) || Math.abs(px) > HUGE || Math.abs(py) > HUGE;
    out.push(bad ? NaN : px, bad ? NaN : py);
    if (i === base - 1) break;
    refineSegment(
      ctx,
      ts[i],
      [xs[i], ys[i]] as CurvePoint,
      ts[i + 1],
      [xs[i + 1], ys[i + 1]] as CurvePoint,
      0,
      out
    );
  }
  const points: CurvePoint[] = [];
  for (let i = 0; i < out.length; i += 2) points.push([out[i], out[i + 1]]);
  return points;
}
