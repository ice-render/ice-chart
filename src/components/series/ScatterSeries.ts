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
    const option = this.series.option;
    const color = this.pointColor(0);
    const shape = option.symbol || 'circle';
    const fill = option.symbolFill || color;
    const stroke = option.symbolStroke || '#ffffff';
    this.beginDraw();
    // 入场：气泡按顺序「弹」出来（先小后大 + 淡入）；更新：位置插值，不再缩放
    const entering = this.isEntering();
    this.computeItemProgress();
    for (let i = 0; i < n; i++) {
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      const p = entering ? this.itemProgress[i] : 1;
      if (p <= 0) continue;
      const size = this.symbolSizeAt(i) * (entering ? 0.2 + 0.8 * p : 1);
      if (entering && p < 1) this.ctx.globalAlpha = 0.25 + 0.75 * p;
      // 气泡图：每个点用自己解析出来的尺寸
      this.drawSymbol(x, y, shape, size, fill, stroke);
      if (entering && p < 1) this.ctx.globalAlpha = 1;
    }
    this.endDraw();
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
