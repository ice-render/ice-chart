import type { Scale } from './Scale';
import type { CreateScaleOptions } from './Scale';
import { formatNumberTick } from './format';

/** 对数比例尺（数据域必须为正数）。 */
export class LogScale implements Scale {
  public readonly type = 'log' as const;
  public domain: [number, number];
  public range: [number, number];
  public base: number;

  constructor(domain: [number, number], range: [number, number], options: CreateScaleOptions = {}) {
    this.base = options.logBase && options.logBase > 1 ? options.logBase : 10;
    const d0 = Math.max(Number.MIN_VALUE, Number(domain[0]));
    const d1 = Math.max(d0 * 1.0001, Number(domain[1]));
    this.domain = [d0, d1];
    this.range = range;
  }

  private log(value: number): number {
    return Math.log(value) / Math.log(this.base);
  }

  public map(value: any): number {
    const v = Number(value);
    if (!(v > 0)) return NaN;
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    const l0 = this.log(d0);
    const l1 = this.log(d1);
    return r0 + ((this.log(v) - l0) / (l1 - l0)) * (r1 - r0);
  }

  public invert(pixel: number): number {
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    if (r1 === r0) return d0;
    const l0 = this.log(d0);
    const l1 = this.log(d1);
    const l = l0 + ((pixel - r0) / (r1 - r0)) * (l1 - l0);
    return Math.pow(this.base, l);
  }

  public ticks(count = 5): number[] {
    const [d0, d1] = this.domain;
    const out: number[] = [];
    const startExp = Math.floor(this.log(d0));
    const endExp = Math.ceil(this.log(d1));
    const total = endExp - startExp;
    if (total <= count * 2) {
      for (let e = startExp; e <= endExp; e++) {
        const v = Math.pow(this.base, e);
        if (v >= d0 * 0.999999 && v <= d1 * 1.000001) out.push(v);
      }
    } else {
      const stride = Math.max(1, Math.ceil(total / count));
      for (let e = startExp; e <= endExp; e += stride) {
        const v = Math.pow(this.base, e);
        if (v >= d0 * 0.999999 && v <= d1 * 1.000001) out.push(v);
      }
    }
    if (!out.length) out.push(d0, d1);
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
    const l0 = this.log(d0);
    const l1 = this.log(d1);
    return l1 === l0 ? 0 : (this.log(Math.max(Number.MIN_VALUE, Number(value))) - l0) / (l1 - l0);
  }

  public valueAtFraction(fraction: number): number {
    const [d0, d1] = this.domain;
    const l0 = this.log(d0);
    const l1 = this.log(d1);
    return Math.pow(this.base, l0 + fraction * (l1 - l0));
  }

  public span(): number {
    return this.domain[1] - this.domain[0];
  }

  public format(value: any, _index: number): string {
    return formatNumberTick(Number(value), this.step());
  }

  public clone(): LogScale {
    return new LogScale([this.domain[0], this.domain[1]], [this.range[0], this.range[1]], { logBase: this.base });
  }
}
