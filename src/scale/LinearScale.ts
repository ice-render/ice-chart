import type { Scale } from './Scale';
import { formatNumberTick } from './format';
import { niceStep, round } from '../util/math';

/** 连续数值比例尺。 */
export class LinearScale implements Scale {
  public readonly type = 'linear' as const;
  public domain: [number, number];
  public range: [number, number];

  constructor(domain: [number, number], range: [number, number]) {
    this.domain = normalize(domain);
    this.range = range;
  }

  public map(value: any): number {
    const v = Number(value);
    if (!isFinite(v)) return NaN;
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    return r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
  }

  public invert(pixel: number): number {
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    if (r1 === r0) return d0;
    return d0 + ((pixel - r0) / (r1 - r0)) * (d1 - d0);
  }

  public ticks(count = 5): number[] {
    const [d0, d1] = this.domain;
    const step = niceStep(d1 - d0, count);
    const out: number[] = [];
    const start = Math.ceil(d0 / step) * step;
    for (let v = start; v <= d1 + step * 1e-6 && out.length < 1000; v += step) {
      out.push(round(v));
    }
    return out;
  }

  public bandwidth(): number {
    return 0;
  }

  public bandStart(value: any): number {
    return this.map(value);
  }

  public step(): number {
    const ticks = this.ticks(5);
    return ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 0;
  }

  public isBand(): boolean {
    return false;
  }

  public indexAt(_pixel: number): number {
    return -1;
  }

  public fractionOf(value: any): number {
    const [d0, d1] = this.domain;
    return d1 === d0 ? 0 : (Number(value) - d0) / (d1 - d0);
  }

  public valueAtFraction(fraction: number): number {
    const [d0, d1] = this.domain;
    return d0 + fraction * (d1 - d0);
  }

  public span(): number {
    return this.domain[1] - this.domain[0];
  }

  public format(value: any, _index: number): string {
    const ticks = this.ticks(5);
    let step = Infinity;
    for (let i = 1; i < ticks.length; i++) {
      const d = Math.abs(ticks[i] - ticks[i - 1]);
      if (d > 0 && d < step) step = d;
    }
    return formatNumberTick(Number(value), isFinite(step) ? step : 0);
  }

  public clone(): LinearScale {
    return new LinearScale([this.domain[0], this.domain[1]], [this.range[0], this.range[1]]);
  }
}

function normalize(domain: [number, number]): [number, number] {
  const d0 = Number(domain[0]);
  const d1 = Number(domain[1]);
  if (d0 === d1) {
    const pad = Math.abs(d0) > 1 ? Math.abs(d0) * 0.1 : 1;
    return [d0 - pad, d1 + pad];
  }
  return [d0, d1];
}
