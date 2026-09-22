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
  /**
   * 类目 → 下标 的查表缓存（**热路径**）。
   *
   * 原来每次 `indexOf` 都是 `domain.indexOf(value)`（O(n)）：一个 10 万类目的轴
   * 每帧要查上万次（轴刻度、网格线、柱子、K 线…），合起来就是 O(n²) ——
   * 实测 10 万类目时坐标轴一次渲染 3.7s。
   * 缓存按**数组身份**失效（域被换掉就重build），语义与原来一致：先出现者胜。
   */
  private indexCache: Map<string, number> | null = null;
  private indexCacheDomain: any[] | null = null;

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
    // 对象类目：按**身份**找（罕见，保持原语义）
    if (value !== null && typeof value === 'object') {
      const strict = this.domain.indexOf(value);
      if (strict !== -1) return strict;
    }
    // 宽松匹配（数字与字符串混用：CSV 解析出来的类目常是字符串）——查表 O(1)
    const hit = this.indices().get(String(value));
    if (hit !== undefined) return hit;
    // 注意：这里**不要**再退化成「把数值当类目下标」——
    // 数值类目（x 为 0/1/2…）在缩放后可见窗口是类目的子集，
    // 用「值 == 下标」兜底会把窗口外的类目锚到窗口内的位置上（柱子会画错位置）。
    return -1;
  }

  /** 类目 → 下标 的查表（按域数组身份缓存）。 */
  private indices(): Map<string, number> {
    if (this.indexCache && this.indexCacheDomain === this.domain) return this.indexCache;
    const map = new Map<string, number>();
    for (let i = 0; i < this.domain.length; i++) {
      const key = String(this.domain[i]);
      if (!map.has(key)) map.set(key, i);
    }
    this.indexCache = map;
    this.indexCacheDomain = this.domain;
    return map;
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
