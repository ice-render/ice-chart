import type { Scale } from './Scale';

/** 数值轴的默认标签格式（按步长自适应精度）。 */
export function formatNumberTick(value: number, step: number): string {
  if (!isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e9 || abs < 1e-4)) return value.toExponential(1);
  let digits = 0;
  if (step > 0 && step < 1) {
    digits = Math.min(6, Math.ceil(-Math.log10(step)));
  } else if (!Number.isInteger(value)) {
    digits = 2;
  }
  const fixed = value.toFixed(digits);
  const trimmed = digits > 0 ? fixed.replace(/\.?0+$/, '') : fixed;
  const [intPart, decPart] = trimmed.split('.');
  const withSeparator = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart ? `${withSeparator}.${decPart}` : withSeparator;
}

/** 轴标签格式化：优先用用户的 formatter，其次按比例尺类型自适应。 */
export function formatTick(
  value: any,
  scale: Scale,
  index: number,
  formatter?: (v: any, i: number) => string
): string {
  if (typeof formatter === 'function') {
    const out = formatter(value, index);
    return out === undefined || out === null ? '' : String(out);
  }
  if (scale.type === 'time') {
    return scale.format(value, index);
  }
  if (scale.type === 'linear' || scale.type === 'log') {
    return formatNumberTick(Number(value), tickStep(scale));
  }
  return String(value);
}

/** 相邻刻度的最小间距（用于推断标签精度）。 */
function tickStep(scale: Scale): number {
  const ticks = scale.ticks(5);
  let step = Infinity;
  for (let i = 1; i < ticks.length; i++) {
    const d = Math.abs(Number(ticks[i]) - Number(ticks[i - 1]));
    if (d > 0 && d < step) step = d;
  }
  return isFinite(step) ? step : 0;
}
