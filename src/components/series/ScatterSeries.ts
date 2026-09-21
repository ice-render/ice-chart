import { SeriesBase } from './SeriesBase';
import type { SeriesCoord } from './SeriesBase';
import type { SeriesType } from '../../types';
import type { InternalSeries } from '../../internal';

/** 散点图：只画数据标记。 */
export class ScatterSeries extends SeriesBase {
  public seriesType: SeriesType = 'scatter';
  /** 散点图的每个点都是图形本身，不参与降采样。 */
  protected supportsSampling = false;
  protected clipToBox = true;

  /** 标记的形状与配色（普通与虚拟两条绘制路径共用，别各写一份）。 */
  private symbolStyle(): { shape: string; fill: string; stroke: string } {
    const option = this.series.option;
    const color = this.pointColor(0);
    return {
      shape: option.symbol || 'circle',
      fill: option.symbolFill || color,
      stroke: option.symbolStroke || '#ffffff',
    };
  }

  /**
   * **列存（虚拟）系列的像素来源**（虚拟化 Phase 2，2026-09-21）。
   *
   * 铁律说「像素缓存唯一」，这里是**唯一的例外**，理由必须记住：
   * 100 万点的像素缓存就是 `Float64Array(2n)` = 16MB，加上动画用的 `effective`（16MB）
   * 与每项进度（8MB），光缓存 40MB —— 虚拟化省下来的内存会被它们原样吃回去。
   * 所以虚拟系列**不物化任何按点缓存**：数据列是唯一事实来源，
   * 渲染与命中都从「列 + 同一份比例尺」现算（同一个公式，不存在两套坐标的分叉），
   * 只是算完不存。只有 scatter 能开 `virtual`（归一化里校验），别的类型照旧。
   */
  protected rebuildPixels(_force = false): void {
    if (!this.series.virtual) {
      super.rebuildPixels(_force);
      return;
    }
    this.syncVirtualMeta();
  }

  /**
   * 虚拟系列的元信息（x 是否单调、尺寸范围）来自列，不来自像素缓存 ——
   * 所以在「换系列 / 换坐标」时同步一次，别让它停在上一份数据上。
   */
  private syncVirtualMeta(): void {
    if (this.pixels.length) this.pixels = new Float64Array(0);
    const columns = this.series.columns;
    this.xMonotonic = !!(columns && columns.xMonotonic);
    this.renderIndices = null;
    if (columns && columns.sizeExtent) this.sizeExtent = columns.sizeExtent;
  }

  public setCoord(coord: SeriesCoord): this {
    super.setCoord(coord);
    if (this.series.virtual) this.syncVirtualMeta();
    return this;
  }

  public updateSeries(series: InternalSeries, animate: boolean, preserveAnimation = false): this {
    super.updateSeries(series, animate, preserveAnimation);
    if (series.virtual) this.syncVirtualMeta();
    return this;
  }

  /** 虚拟系列的尺寸范围来自列（归一化那一趟算好的），不必再扫全量数据。 */
  protected hasPointSize(): boolean {
    const columns = this.series.columns;
    if (this.series.virtual && columns) return !!columns.sizeExtent;
    return super.hasPointSize();
  }

  /** 虚拟系列的点像素：按需现算，不落缓存。 */
  private virtualPixelAt(index: number): [number, number] | null {
    const coord = this.coord;
    const series = this.series;
    if (!coord || index < 0 || index >= series.pointCount) return null;
    const value = series.yValueAt(index);
    if (value === null) return null;
    const x = coord.xScale.map(series.xValueAt(index));
    const y = coord.yScale.map(value);
    if (!isFinite(x) || !isFinite(y)) return null;
    return [x, y];
  }

  public pixelAt(index: number): [number, number] | null {
    if (!this.series.virtual) return super.pixelAt(index);
    // 同步 xMonotonic / sizeExtent（虚拟路径没有像素可建，这只是两个标量字段）
    this.rebuildPixels();
    return this.virtualPixelAt(index);
  }

  /** 虚拟系列的二分：比较的是「列上的 x 值映射出的像素」（x 单调时顺序一致）。 */
  public nearestIndexAtX(localX: number): number {
    if (!this.series.virtual) return super.nearestIndexAtX(localX);
    const coord = this.coord;
    const series = this.series;
    const n = series.pointCount;
    if (!coord || !n) return -1;
    const pixelX = (i: number): number => coord.xScale.map(series.xValueAt(i));
    if (!this.xMonotonic) {
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < n; i++) {
        const x = pixelX(i);
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
      const x = pixelX(mid);
      if (!isFinite(x) || x < localX) lo = mid + 1;
      else hi = mid;
    }
    let best = -1;
    let bestDist = Infinity;
    for (const i of [lo, lo - 1]) {
      if (i < 0 || i >= n) continue;
      const x = pixelX(i);
      if (!isFinite(x)) continue;
      const dist = Math.abs(x - localX);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  /** 列上二分：第一个 x ≥ target 的下标（再往左留一格）。 */
  private lowerBoundValue(target: number): number {
    const series = this.series;
    let lo = 0;
    let hi = series.pointCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Number(series.xValueAt(mid)) < target) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  }

  /** 列上二分：最后一个 x ≤ target 的下标（再往右留一格）。 */
  private upperBoundValue(target: number): number {
    const series = this.series;
    const n = series.pointCount;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Number(series.xValueAt(mid)) <= target) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(n - 1, lo);
  }

  protected doRender(): void {
    if (this.series.virtual) {
      this.renderVirtual();
      return;
    }
    this.rebuildPixels();
    const n = this.pixels.length / 2;
    if (!n) return;
    /**
     * **只画可见窗口**（虚拟化 Phase 1，2026-09-21）。
     *
     * 背景：散点每帧对**全部**点调用 `drawSymbol()`（一次 canvas 路径 + 填充）。
     * 100 万点实测 **472.7 ms/帧（≈2 fps）、62 个长任务** —— 点都在屏幕外也照画。
     * x 单调（时间序列 / 均匀采样是绝大多数场景）时用二分定位可见下标区间，
     * 两侧各留一个最大符号尺寸的余量（符号可能跨出绘图区）。
     * 语义不变：看不见的点本来就被 `clipToBox` 裁掉，这里只是**不进循环**。
     */
    let i0 = 0;
    let i1 = n - 1;
    if (this.xMonotonic && n > 2048) {
      const box = this.__localBox();
      const pad = this.maxSymbolSize();
      i0 = this.__lowerBoundX(box[0] - pad);
      i1 = this.__upperBoundX(box[2] + pad);
    }
    if (i1 < i0) {
      this.beginDraw();
      this.endDraw();
      return;
    }
    /**
     * **密度抽稀**（虚拟化 Phase 1，2026-09-21）：可见点数远超像素列数时按步长画。
     *
     * 为什么必须做：1M 散点在默认视图下**全部可见**（1M 个点挤 960px），窗口裁剪帮不上忙，
     * 每点一次 `drawSymbol()`（各自 beginPath/arc/fill）实测 **470ms/帧**。
     * 抽稀后每帧落墨 ≈ 2 点/像素列（1M → ~1,900），视觉上仍是同一条"点云"；
     * **命中与提示框不受影响**：`hitTestIndex` 读的是全量 `pixels`（二分 + 邻域扫描）。
     * 放大到可见点数不多时 stride = 1，逐点绘制、与从前逐像素一致。
     */
    const visibleCount = i1 - i0 + 1;
    const plotWidth = this.coord ? this.coord.plot.width : 960;
    const stride = this.xMonotonic && visibleCount > 4096 ? Math.max(1, Math.floor(visibleCount / (plotWidth * 2))) : 1;
    const { shape, fill, stroke } = this.symbolStyle();
    this.beginDraw();
    // 入场：气泡按顺序「弹」出来（先小后大 + 淡入）；更新：位置插值，不再缩放
    const entering = this.isEntering();
    this.computeItemProgress();
    for (let i = i0; i <= i1; i += stride) {
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      const p = entering ? this.itemProgress[i] : 1;
      if (p <= 0) continue;
      const size = this.symbolSizeAt(i) * (entering ? 0.2 + 0.8 * p : 1) * this.hoverBoost(i, 0.18);
      if (entering && p < 1) this.ctx.globalAlpha = 0.25 + 0.75 * p;
      // 气泡图：每个点用自己解析出来的尺寸
      this.drawSymbol(x, y, shape, size, fill, stroke);
      if (entering && p < 1) this.ctx.globalAlpha = 1;
    }
    this.endDraw();
  }

  /**
   * 虚拟（列存）系列的绘制：与 Phase 1 的「可见窗口 + 密度抽稀」同一套策略，
   * 只是窗口与像素都从列现算 —— 没有 `pixels` 可读。
   *
   * 窗口用**值空间**二分：先把绘图区（含符号余量）的两端经 `invert` 换算成 x 值，
   * 再到列上二分下标。x 单调是前提（归一化时算好，存在 columns.xMonotonic 里）。
   */
  private renderVirtual(): void {
    const coord = this.coord;
    const series = this.series;
    const n = series.pointCount;
    if (!coord || !n) return;
    this.rebuildPixels();
    const plotWidth = coord.plot.width;
    const pad = this.maxSymbolSize();
    let i0 = 0;
    let i1 = n - 1;
    if (this.xMonotonic) {
      const edgeA = coord.xScale.invert(-pad);
      const edgeB = coord.xScale.invert(plotWidth + pad);
      i0 = this.lowerBoundValue(Math.min(edgeA, edgeB));
      i1 = this.upperBoundValue(Math.max(edgeA, edgeB));
    }
    if (i1 < i0) return;
    const visibleCount = i1 - i0 + 1;
    // 与普通散点同一条密度规则：每像素列约 2 点
    const stride = this.xMonotonic && visibleCount > 4096 ? Math.max(1, Math.floor(visibleCount / (plotWidth * 2))) : 1;
    const { shape, fill, stroke } = this.symbolStyle();
    // 入场：整体进度（虚拟系列不做逐项错峰 —— 那需要 n 长的进度数组，正是要省掉的东西）
    const entering = this.isEntering();
    const p = entering ? this.progress() : 1;
    if (entering && p <= 0) return;
    this.beginDraw();
    for (let i = i0; i <= i1; i += stride) {
      const value = series.yValueAt(i);
      if (value === null) continue;
      const x = coord.xScale.map(series.xValueAt(i));
      const y = coord.yScale.map(value);
      if (!isFinite(x) || !isFinite(y)) continue;
      const size = this.symbolSizeAt(i) * (entering ? 0.2 + 0.8 * p : 1) * this.hoverBoost(i, 0.18);
      if (entering && p < 1) this.ctx.globalAlpha = 0.25 + 0.75 * p;
      this.drawSymbol(x, y, shape, size, fill, stroke);
      if (entering && p < 1) this.ctx.globalAlpha = 1;
    }
    this.endDraw();
  }

  /** 二分：第一个 x ≥ target 的下标（再往左留一格，保证部分可见的点也画）。 */
  private __lowerBoundX(target: number): number {
    const n = this.pixels.length / 2;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.pixels[mid * 2] < target) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  }

  /** 二分：最后一个 x ≤ target 的下标（再往右留一格）。 */
  private __upperBoundX(target: number): number {
    const n = this.pixels.length / 2;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.pixels[mid * 2] <= target) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(n - 1, lo);
  }

  public hitTestIndex(localX: number, localY: number): number {
    if (this.series.virtual) return this.hitTestVirtual(localX, localY);
    this.rebuildPixels();
    const option = this.series.option;
    const tolerance = option.hitRadius ? Number(option.hitRadius) : this.maxSymbolSize() / 2 + 4;
    const maxDist = tolerance * tolerance;
    let best = -1;
    let bestDist = maxDist;
    const n = this.pixels.length / 2;
    if (n > 1024 && this.xMonotonic) {
      const anchor = this.nearestIndexAtX(localX);
      if (anchor < 0) return -1;
      let best = -1;
      let bestDist = maxDist;
      for (let i = Math.max(0, anchor - 3); i <= Math.min(n - 1, anchor + 3); i++) {
        const dx = this.pixels[i * 2] - localX;
        const dy = this.pixels[i * 2 + 1] - localY;
        const dist = dx * dx + dy * dy;
        if (dist <= bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      return best;
    }
    for (let i = 0; i < n; i++) {
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      const dx = x - localX;
      const dy = y - localY;
      const dist = dx * dx + dy * dy;
      if (dist <= bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  /**
   * 虚拟（列存）系列的命中：列上二分定位候选，再对邻域现算像素比距离。
   *
   * 与普通散点的邻域扫描（±3）保持同一口径：1M 点满窗口时一根像素列里本来就挤着
   * 上百个点，取最近邻域是既定语义，不是这次才引入的近似。
   */
  private hitTestVirtual(localX: number, localY: number): number {
    this.rebuildPixels();
    const n = this.series.pointCount;
    if (!n) return -1;
    const option = this.series.option;
    const tolerance = option.hitRadius ? Number(option.hitRadius) : this.maxSymbolSize() / 2 + 4;
    const maxDist = tolerance * tolerance;
    const anchor = this.nearestIndexAtX(localX);
    if (anchor < 0) return -1;
    let best = -1;
    let bestDist = maxDist;
    for (let i = Math.max(0, anchor - 3); i <= Math.min(n - 1, anchor + 3); i++) {
      const pixel = this.virtualPixelAt(i);
      if (!pixel) continue;
      const dx = pixel[0] - localX;
      const dy = pixel[1] - localY;
      const dist = dx * dx + dy * dy;
      if (dist <= bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }
}
