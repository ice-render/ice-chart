import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';

/** 散点图：只画数据标记。 */
export class ScatterSeries extends SeriesBase {
  public seriesType: SeriesType = 'scatter';

  protected doRender(): void {
    this.rebuildPixels();
    const n = this.pixels.length / 2;
    if (!n) return;
    const option = this.series.option;
    const color = this.pointColor(0);
    const shape = option.symbol || 'circle';
    const size = this.symbolSize();
    const fill = option.symbolFill || color;
    const stroke = option.symbolStroke || '#ffffff';
    this.beginDraw();
    for (let i = 0; i < n; i++) {
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      this.drawSymbol(x, y, shape, size, fill, stroke);
    }
    this.endDraw();
  }

  public hitTestIndex(localX: number, localY: number): number {
    this.rebuildPixels();
    const option = this.series.option;
    const tolerance = option.hitRadius ? Number(option.hitRadius) : this.symbolSize() / 2 + 4;
    const maxDist = tolerance * tolerance;
    let best = -1;
    let bestDist = maxDist;
    const n = this.pixels.length / 2;
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
