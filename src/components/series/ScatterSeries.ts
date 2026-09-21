import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';

/** 散点图：只画数据标记。 */
export class ScatterSeries extends SeriesBase {
  public seriesType: SeriesType = 'scatter';
  /** 散点图的每个点都是图形本身，不参与降采样。 */
  protected supportsSampling = false;
  protected clipToBox = true;

  protected doRender(): void {
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
    const option = this.series.option;
    const color = this.pointColor(0);
    const shape = option.symbol || 'circle';
    const fill = option.symbolFill || color;
    const stroke = option.symbolStroke || '#ffffff';
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
}
