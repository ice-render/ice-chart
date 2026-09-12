import { ChartComponent } from '../ChartComponent';
import type { ChartTheme, SeriesType } from '../../types';
import type { DataPoint, InternalSeries, Rect } from '../../internal';
import type { Scale } from '../../scale';

export interface SeriesCoord {
  plot: Rect;
  canvas: Rect;
  xScale: Scale;
  yScale: Scale;
  /** 该系列绑定的 y 轴下标。 */
  yAxisIndex?: number;
  theme: ChartTheme;
}

export interface BarSlot {
  index: number;
  count: number;
}

/**
 * 系列基类：数据 → 像素的缓存、动画插值、命中判定都收敛在这里。
 *
 * 三件事值得注意：
 *
 * 1. **像素缓存**：数据点的像素坐标只在数据 / 比例尺 / 尺寸变化时重算一次，
 *    render 与命中判定共用同一份缓存 —— 保证「画出来的样子」和「点得到的位置」必然一致。
 *
 * 2. **命中判定进引擎**：`containsLocalPoint` 由子类实现为「按数据语义判定」，
 *    于是 `ice.hitTest()` / 引擎事件派发天然就能分辨「点在折线上」还是「点在空白处」，
 *    不需要在图表外面再写一套坐标反查。
 *
 * 3. **动画走引擎的 AnimationManager**：`state.progress` 由引擎逐帧写入，
 *    本组件按 progress 在「上一份数据的有效值」与「新数据」之间插值。
 */
export abstract class SeriesBase extends ChartComponent {
  public abstract seriesType: SeriesType;
  public series: InternalSeries;
  public coord: SeriesCoord | null = null;
  /** 分组柱形的位置（由 Chart 计算）。 */
  public barSlot: BarSlot = { index: 0, count: 1 };

  /** 每个点的像素坐标，2n 长度，[x0,y0,x1,y1,...]；缺失点为 NaN。 */
  protected pixels: Float64Array = new Float64Array(0);
  /** 每个点的有效数据值 [base, top]，用于动画插值与柱形绘制。 */
  protected effective: Float64Array = new Float64Array(0);
  /** 上一帧的有效值，作为动画起点。 */
  protected fromEffective: Float64Array | null = null;
  private cacheKey = '';
  private localBoxScratch: number[] = [0, 0, 0, 0];

  constructor(series: InternalSeries, props: { left: number; top: number; width: number; height: number; zIndex?: number }) {
    super({ interactive: true, ...props });
    this.series = series;
  }

  /** 组件本地盒向四周外扩，容纳线宽、标记与阴影。 */
  protected __localBox(): number[] {
    const pad = this.paintPad();
    const box = this.localBoxScratch;
    box[0] = -pad;
    box[1] = -pad;
    box[2] = (this.state.width || 0) + pad;
    box[3] = (this.state.height || 0) + pad;
    return box;
  }

  protected paintPad(): number {
    const option = this.series.option;
    const symbol = option.showSymbol === false ? 0 : (option.symbolSize || 8) / 2 + 4;
    return Math.max(symbol, (option.lineWidth || 2) + 4, 6);
  }

  public setCoord(coord: SeriesCoord): this {
    this.coord = coord;
    this.cacheKey = '';
    return this.markDirty();
  }

  /**
   * 替换数据。`animate` 为真时，把当前有效值记为动画起点（首次进入时从 0 开始），
   * 由 Chart 触发引擎动画把 state.progress 从 0 推到 1。
   */
  public updateSeries(series: InternalSeries, animate: boolean): this {
    this.fromEffective =
      animate && this.effective.length === series.points.length * 2 ? new Float64Array(this.effective) : null;
    this.series = series;
    this.cacheKey = '';
    return this.markDirty();
  }

  /** 与当前绘制一致的像素位置；缺失点返回 null。 */
  public pixelAt(index: number): [number, number] | null {
    this.rebuildPixels();
    const x = this.pixels[index * 2];
    const y = this.pixels[index * 2 + 1];
    if (!isFinite(x) || !isFinite(y)) return null;
    return [x, y];
  }

  /** 数据点的像素矩形（柱形用）。 */
  public barRectAt(_index: number): Rect | null {
    return null;
  }

  /** 命中判定：返回数据下标，-1 表示未命中。入参是组件本地像素坐标。 */
  public abstract hitTestIndex(localX: number, localY: number): number;

  protected containsLocalPoint(localX: number, localY: number): boolean {
    return this.hitTestIndex(localX, localY) >= 0;
  }

  protected progress(): number {
    const p = Number(this.state.progress);
    return isFinite(p) ? Math.max(0, Math.min(1, p)) : 1;
  }

  /** 计算每个点的有效数据值（含动画插值）。 */
  protected computeEffective(): void {
    const points = this.series.points;
    const n = points.length;
    if (this.effective.length !== n * 2) {
      this.effective = new Float64Array(n * 2);
      this.fromEffective = null;
    }
    const t = this.progress();
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const targetTop = p.top;
      if (targetTop === null || targetTop === undefined) {
        this.effective[i * 2] = NaN;
        this.effective[i * 2 + 1] = NaN;
        continue;
      }
      const targetBase = isFinite(p.base) ? p.base : 0;
      let fromBase = 0;
      let fromTop = 0;
      if (this.fromEffective) {
        const fb = this.fromEffective[i * 2];
        const ft = this.fromEffective[i * 2 + 1];
        if (isFinite(fb)) fromBase = fb;
        if (isFinite(ft)) fromTop = ft;
      }
      this.effective[i * 2] = t >= 1 ? targetBase : fromBase + (targetBase - fromBase) * t;
      this.effective[i * 2 + 1] = t >= 1 ? targetTop : fromTop + (targetTop - fromTop) * t;
    }
    if (t >= 1) this.fromEffective = null;
  }

  /** 数据 → 像素（带缓存）。 */
  protected rebuildPixels(force = false): void {
    const coord = this.coord;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const key = this.buildCacheKey(coord);
    if (!force && key === this.cacheKey) return;
    this.computeEffective();
    const points = this.series.points;
    const n = points.length;
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    const { xScale, yScale } = coord;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const px = xScale.map(p.xValue);
      const value = this.effective[i * 2 + 1];
      const py = isFinite(value) ? yScale.map(value) : NaN;
      this.pixels[i * 2] = px;
      this.pixels[i * 2 + 1] = py;
    }
    this.cacheKey = key;
  }

  private buildCacheKey(coord: SeriesCoord): string {
    const xd = coord.xScale.domain;
    const yd = coord.yScale.domain;
    return [
      this.series.points.length,
      this.progress(),
      coord.plot.width,
      coord.plot.height,
      String(xd[0]),
      String(xd[xd.length - 1]),
      String(yd[0]),
      String(yd[1]),
      this.series.points.length ? String(this.series.points[0].xValue) : '',
    ].join('|');
  }

  /** 遍历像素点，跳过缺失点形成的断点。 */
  protected eachSegment(fn: (x0: number, y0: number, x1: number, y1: number, i: number) => void): void {
    const n = this.pixels.length / 2;
    for (let i = 0; i < n - 1; i++) {
      const x0 = this.pixels[i * 2];
      const y0 = this.pixels[i * 2 + 1];
      const x1 = this.pixels[(i + 1) * 2];
      const y1 = this.pixels[(i + 1) * 2 + 1];
      if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) continue;
      fn(x0, y0, x1, y1, i);
    }
  }

  protected pointColor(_index: number): string {
    return this.series.option.color || this.series.color;
  }

  protected symbolSize(): number {
    const size = this.series.option.symbolSize;
    return isFinite(size as number) ? (size as number) : 8;
  }

  protected lineWidthDevice(): number {
    const w = this.series.option.lineWidth;
    return isFinite(w as number) ? (w as number) : 2;
  }

  protected opacity(): number {
    const o = Number(this.series.option.opacity);
    return isFinite(o) ? Math.max(0, Math.min(1, o)) : 1;
  }

  protected beginDraw(): void {
    this.ctx.beginPath();
    this.ctx.save();
    this.ctx.lineJoin = 'round';
    this.ctx.lineCap = 'round';
    this.ctx.globalAlpha = this.opacity();
  }

  protected endDraw(): void {
    this.ctx.restore();
  }

  protected drawSymbol(x: number, y: number, shape: string, size: number, fill: string, stroke: string): void {
    const ctx = this.ctx;
    const unit = this.unit();
    ctx.beginPath();
    if (shape === 'rect') {
      ctx.rect(x - size / 2, y - size / 2, size, size);
    } else {
      ctx.arc(x, y, Math.max(1, size / 2), 0, Math.PI * 2);
    }
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = unit;
      ctx.stroke();
    }
  }

  protected pointByIndex(index: number): DataPoint | null {
    return this.series.points[index] || null;
  }
}
