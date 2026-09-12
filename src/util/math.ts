/** 数值与数组工具。保持零依赖、可被 tree-shaking。 */

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function isFiniteNumber(value: any): value is number {
  return typeof value === 'number' && isFinite(value);
}

export function isNil(value: any): boolean {
  return value === null || value === undefined || (typeof value === 'number' && isNaN(value));
}

export function extent(values: number[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFiniteNumber(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return [0, 1];
  if (min === max) {
    // 单值数据：给一个对称的假区间，避免比例尺除零
    const pad = Math.abs(min) > 1 ? Math.abs(min) * 0.1 : 1;
    return [min - pad, max + pad];
  }
  return [min, max];
}

/** 生成「整齐」的刻度步长：1/2/5 × 10^k。 */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !(count > 0)) return 1;
  const raw = span / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const residual = raw / magnitude;
  let factor: number;
  if (residual >= 5) factor = 10;
  else if (residual >= 2) factor = 5;
  else if (residual >= 1) factor = 2;
  else factor = 1;
  return factor * magnitude;
}

export function niceDomain(domain: [number, number], count: number): [number, number] {
  const [min, max] = domain;
  const step = niceStep(max - min, count);
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
}

/** 四舍五入到指定小数位，规避浮点误差（0.30000000000000004）。 */
export function round(value: number, digits = 10): number {
  const p = Math.pow(10, digits);
  return Math.round(value * p) / p;
}

/** 判断两个数值 / 数组是否近似相等（用于避免无意义的重绘）。 */
export function nearlyEqual(a: any, b: any, epsilon = 1e-9): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!nearlyEqual(a[i], b[i], epsilon)) return false;
    }
    return true;
  }
  if (isFiniteNumber(a) && isFiniteNumber(b)) return Math.abs(a - b) <= epsilon;
  return a === b;
}

/** 数字的默认展示格式：大数用千分位，小数最多保留 4 位有效数字。 */
export function formatNumber(value: any): string {
  if (!isFiniteNumber(value)) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e9 || abs < 1e-4)) {
    return value.toExponential(2);
  }
  const fixed = abs >= 1000 ? value.toFixed(0) : abs >= 1 ? value.toFixed(Math.abs(value % 1) < 1e-9 ? 0 : 2) : value.toFixed(3);
  const [int, dec] = fixed.split('.');
  const withSeparator = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec ? `${withSeparator}.${dec}` : withSeparator;
}
