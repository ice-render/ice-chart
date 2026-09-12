import type { Scale } from './Scale';
import type { CreateScaleOptions } from './Scale';

/**
 * 类目（band）比例尺。
 *
 * 单位约定：`map(category)` 返回 band 的**中心**（折线点 / 散点用），
 * `bandStart(category)` 返回 band 起点（柱形用）。这与 d3.scaleBand + 手动取中心的写法一致，
 * 但避免了「柱子和折线对不上」的经典偏移 bug。
 */
export class BandScale implements Scale {
  public readonly type = 'category' as const;
  public domain: any[];
  public range: [number, number];
  private paddingInner: number;
  private paddingOuter: number;
  private _step: number;

  constructor(domain: any[], range: [number, number], options: CreateScaleOptions = {}) {
    this.domain = domain.length ? domain.slice() : [''];
    this.range = range;
    this.paddingInner = options.paddingInner === undefined ? 0.2 : options.paddingInner;
    this.paddingOuter = options.paddingOuter === undefined ? 0.1 : options.paddingOuter;
    this._step = this.computeStep();
  }

  private computeStep(): number {
    const n = Math.max(1, this.domain.length);
    const [r0, r1] = this.range;
    // 取绝对值：y 轴的 range 是 [height, 0]（屏幕坐标向下），步长仍应为正
    const span = Math.abs(r1 - r0);
    const divisor = n - this.paddingInner + this.paddingOuter * 2;
    return span / Math.max(0.0001, divisor);
  }

  private indexOf(value: any): number {
    let index = this.domain.indexOf(value);
    if (index === -1) {
      // 宽松匹配：数字与字符串混用（CSV 解析出来的类目常是字符串）
      for (let i = 0; i < this.domain.length; i++) {
        if (String(this.domain[i]) === String(value)) return i;
      }
      index = -1;
    }
    if (index === -1 && isFinite(Number(value))) {
      const n = Number(value);
      if (n >= 0 && n < this.domain.length && Math.floor(n) === n) index = n;
    }
    return index;
  }

  public map(value: any): number {
    return this.bandStart(value) + this.bandwidth() / 2;
  }

  public bandStart(value: any, index?: number): number {
    const i = index !== undefined && index >= 0 ? index : this.indexOf(value);
    if (i < 0) return NaN;
    const [r0] = this.range;
    const direction = this.range[1] >= this.range[0] ? 1 : -1;
    return r0 + direction * (this.paddingOuter * this._step + i * this._step);
  }

  public bandwidth(): number {
    return this._step * (1 - this.paddingInner);
  }

  public step(): number {
    return this._step;
  }

  public isBand(): boolean {
    return true;
  }

  public ticks(): any[] {
    return this.domain.slice();
  }

  public indexAt(pixel: number): number {
    const bw = this.bandwidth();
    const direction = this.range[1] >= this.range[0] ? 1 : -1;
    for (let i = 0; i < this.domain.length; i++) {
      const start = this.bandStart(undefined as any, i);
      const end = start + direction * bw;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      if (pixel >= lo && pixel <= hi) return i;
    }
    return -1;
  }

  /** 类目轴的反向查找：优先返回命中的类目，否则返回最近的类目（便于 axis 触发器的「最近列」语义）。 */
  public invert(pixel: number): any {
    const hit = this.indexAt(pixel);
    if (hit >= 0) return this.domain[hit];
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < this.domain.length; i++) {
      const d = Math.abs(this.map(this.domain[i]) - pixel);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    return this.domain[nearest];
  }

  /** 最近类目下标：命中带内直接返回，否则返回最近的（轴提示器需要）。 */
  public nearestIndex(pixel: number): number {
    const hit = this.indexAt(pixel);
    if (hit >= 0) return hit;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < this.domain.length; i++) {
      const d = Math.abs(this.map(this.domain[i]) - pixel);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    return nearest;
  }

  public fractionOf(value: any): number {
    const i = this.indexOf(value);
    if (i < 0) return 0;
    return this.domain.length <= 1 ? 0.5 : (i + 0.5) / this.domain.length;
  }

  public valueAtFraction(fraction: number): any {
    const n = this.domain.length;
    if (!n) return undefined;
    const i = Math.max(0, Math.min(n - 1, Math.round(fraction * n - 0.5)));
    return this.domain[i];
  }

  public span(): number {
    return this.domain.length;
  }

  public format(value: any): string {
    return value === undefined || value === null ? '' : String(value);
  }

  public clone(): BandScale {
    return new BandScale(this.domain.slice(), [this.range[0], this.range[1]], {
      paddingInner: this.paddingInner,
      paddingOuter: this.paddingOuter,
    });
  }
}
