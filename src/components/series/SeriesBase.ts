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
  /** 图表主题（由 Chart 注入，供绘制标签 / 文本使用）。 */
  public chartTheme: ChartTheme | null = null;
  public coord: SeriesCoord | null = null;
  /** 分组柱形的位置（由 Chart 计算）。 */
  public barSlot: BarSlot = { index: 0, count: 1 };

  /** 每个点的像素坐标，2n 长度，[x0,y0,x1,y1,...]；缺失点为 NaN。 */
  protected pixels: Float64Array = new Float64Array(0);
  /** 每个点的有效数据值 [base, top]，用于动画插值与柱形绘制。 */
  protected effective: Float64Array = new Float64Array(0);
  /** 上一帧的有效值，作为动画起点。 */
  protected fromEffective: Float64Array | null = null;
  /** 实际参与绘制的点下标（降采样后可能少于总点数）；null 表示全部点。 */
  protected renderIndices: number[] | null = null;
  /** 像素 x 是否单调递增（降采样与二分查找的前提）。 */
  protected xMonotonic = true;
  /** 第三维（气泡尺寸）的取值范围，映射到 symbolSizeRange。 */
  protected sizeExtent: [number, number] = [0, 1];
  private cacheKey = '';
  /** 散点等「每个点都必须画」的系列不参与降采样。 */
  protected supportsSampling = true;
  /**
   * 是否把绘制裁剪到组件盒（= 本场景的绘图区）。
   *
   * 直角坐标系列必须开：缩放后落在窗口外的数据点会被映射到很远的位置，
   * 不裁剪就会一路画到 y 轴标签、图例甚至画布外面去（用户实测反馈的问题）。
   * 折线要的是「被绘图区边缘裁掉」，而不是「在边界处断开」，所以只能靠 clip，不能靠过滤点。
   */
  protected clipToBox = false;
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
    const symbol = option.showSymbol === false ? 0 : this.maxSymbolSize() / 2 + 4;
    return Math.max(symbol, (option.lineWidth || 2) + 4, 6);
  }

  /**
   * 数据点尺寸：三种来源按优先级解析。
   * 1. `symbolSize` 是函数 → 交给调用方决定；
   * 2. 数据项带第三维（气泡图的 `[x, y, size]`）→ 按 series 内的取值范围映射到 `symbolSizeRange`；
   * 3. 固定数值 `symbolSize`。
   */
  public symbolSizeAt(index: number): number {
    const option = this.series.option;
    const point = this.series.points[index];
    const size = option.symbolSize;
    if (typeof size === 'function') {
      const value = point ? point.y : null;
      let out = NaN;
      try {
        out = Number(size(value, { dataIndex: index, data: point ? point.raw : undefined, seriesName: this.series.name }));
      } catch (err) {
        out = NaN;
      }
      return isFinite(out) && out > 0 ? out : 8;
    }
    if (point && typeof point.size === 'number' && isFinite(point.size)) {
      const range = Array.isArray(option.symbolSizeRange) ? option.symbolSizeRange : [8, 40];
      const [min, max] = this.sizeExtent;
      const t = max > min ? (point.size - min) / (max - min) : 0.5;
      return range[0] + (range[1] - range[0]) * Math.max(0, Math.min(1, t));
    }
    const numeric = Number(size);
    return isFinite(numeric) && numeric > 0 ? numeric : 8;
  }

  /** 本系列的最大标记尺寸（脏矩形留白与命中容差要用）。 */
  protected maxSymbolSize(): number {
    const option = this.series.option;
    if (typeof option.symbolSize === 'function' || this.series.points.some((p) => typeof p.size === 'number')) {
      const range = Array.isArray(option.symbolSizeRange) ? option.symbolSizeRange : [8, 40];
      return Math.max(8, Number(range[1]) || 40);
    }
    const numeric = Number(option.symbolSize);
    return isFinite(numeric) && numeric > 0 ? numeric : 8;
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
    let monotonic = true;
    let prevX = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const px = xScale.map(p.xValue);
      const value = this.effective[i * 2 + 1];
      const py = isFinite(value) ? yScale.map(value) : NaN;
      this.pixels[i * 2] = px;
      this.pixels[i * 2 + 1] = py;
      if (isFinite(px)) {
        if (px < prevX) monotonic = false;
        prevX = px;
      }
    }
    this.xMonotonic = monotonic;
    this.sizeExtent = computeSizeExtent(points);
    this.renderIndices = this.buildRenderIndices(n, coord.plot.width);
    this.cacheKey = key;
  }

  /**
   * 计算实际绘制的点下标。
   *
   * 默认策略：点数超过「绘图区宽度 × 3」时用 LTTB 抽稀 —— 一个像素宽度画 3 个点已经过剩，
   * 继续画只是白白光栅化。首尾点与极值点一定保留，所以看起来仍然「像原曲线」。
   * 命中判定不受影响，它始终读全量像素缓存。
   */
  protected buildRenderIndices(n: number, plotWidth: number): number[] | null {
    if (!this.supportsSampling || !this.xMonotonic) return null;
    const option = this.series.option;
    if (option.sampling === 'none') return null;
    if (!option.sampling && n <= Math.max(2000, plotWidth * 3)) return null;
    const threshold = Math.max(64, Math.min(n, Math.floor(plotWidth * 2)));
    if (n <= threshold + 2) return null;
    return lttbIndices(this.pixels, n, threshold);
  }

  /** 实际参与绘制的点数。 */
  protected renderCount(): number {
    return this.renderIndices ? this.renderIndices.length : this.pixels.length / 2;
  }

  /** 第 k 个参与绘制的点对应的原始下标。 */
  protected renderIndexAt(k: number): number {
    return this.renderIndices ? this.renderIndices[k] : k;
  }

  /**
   * 按 x 像素找最近的数据下标。
   *
   * 单调数据用二分查找（大点数下每次 mousemove 都是 O(n) 会直接掉帧），
   * 非单调数据退化为线性扫描。
   */
  public nearestIndexAtX(localX: number): number {
    this.rebuildPixels();
    const n = this.pixels.length / 2;
    if (!n) return -1;
    if (!this.xMonotonic) {
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < n; i++) {
        const x = this.pixels[i * 2];
        if (!isFinite(x)) continue;
        const dist = Math.abs(x - localX);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      return best;
    }
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const x = this.pixels[mid * 2];
      if (!isFinite(x) || x < localX) lo = mid + 1;
      else hi = mid;
    }
    // lo 是第一个 >= localX 的点，与邻居比一次即可
    const candidates = [lo, lo - 1].filter((i) => i >= 0 && i < n && isFinite(this.pixels[i * 2]));
    let best = -1;
    let bestDist = Infinity;
    for (const i of candidates) {
      const dist = Math.abs(this.pixels[i * 2] - localX);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
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
    if (this.clipToBox) {
      // 组件盒就是绘图区（系列组件的 left/top/width/height 由 Chart 设成 plot rect）
      this.ctx.beginPath();
      this.ctx.rect(0, 0, this.state.width, this.state.height);
      this.ctx.clip();
    }
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

/**
 * LTTB（Largest Triangle Three Buckets）抽稀。
 *
 * 输入是渲染用的像素点集（x/y 交错，含 NaN 断点），返回保留下来的下标数组。
 * 首点与末点一定保留；每个桶内取「与前后桶均值构成三角形面积最大」的点，
 * 因此尖峰不会被抹平 —— 这正是它比等间隔抽样更适合行情/监控曲线的原因。
 */
export function lttbIndices(pixels: Float64Array, n: number, threshold: number): number[] {
  if (threshold >= n || threshold <= 2) {
    const all: number[] = [];
    for (let i = 0; i < n; i++) all.push(i);
    return all;
  }
  const sampled: number[] = [0];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    // 下一个桶的均值（作为三角形的第三个顶点）
    let avgStart = Math.floor((i + 1) * every) + 1;
    let avgEnd = Math.floor((i + 2) * every) + 1;
    if (avgEnd > n) avgEnd = n;
    let avgX = 0;
    let avgY = 0;
    let avgCount = 0;
    for (; avgStart < avgEnd; avgStart++) {
      const y = pixels[avgStart * 2 + 1];
      if (!isFinite(y)) continue;
      avgX += pixels[avgStart * 2];
      avgY += y;
      avgCount++;
    }
    if (!avgCount) {
      avgX = pixels[(n - 1) * 2];
      avgY = pixels[(n - 1) * 2 + 1];
      if (!isFinite(avgY)) {
        avgY = pixels[a * 2 + 1];
        avgX = pixels[a * 2];
      }
    } else {
      avgX /= avgCount;
      avgY /= avgCount;
    }
    const rangeStart = Math.floor(i * every) + 1;
    const rangeEnd = Math.min(Math.floor((i + 1) * every) + 1, n - 1);
    const ax = pixels[a * 2];
    const ay = pixels[a * 2 + 1];
    let maxArea = -1;
    let maxIndex = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const y = pixels[j * 2 + 1];
      if (!isFinite(y)) continue;
      const x = pixels[j * 2];
      const area = Math.abs((ax - avgX) * (y - ay) - (ax - x) * (avgY - ay));
      if (area > maxArea) {
        maxArea = area;
        maxIndex = j;
      }
    }
    sampled.push(maxIndex);
    a = maxIndex;
  }
  sampled.push(n - 1);
  return sampled;
}

/** 数据点第三维的取值范围（气泡尺寸映射用）。 */
export function computeSizeExtent(points: DataPoint[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (typeof point.size !== 'number' || !isFinite(point.size)) continue;
    if (point.size < min) min = point.size;
    if (point.size > max) max = point.size;
  }
  if (!isFinite(min)) return [0, 1];
  if (min === max) return [min, min + 1];
  return [min, max];
}
