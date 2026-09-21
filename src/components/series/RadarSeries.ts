import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';
import type { PolarLayout, Rect } from '../../internal';
import { hexToRgba } from './LineSeries';

export interface RadarSeriesCoord {
  polar: PolarLayout;
  plot: Rect;
  canvas: Rect;
  /** 每个指标轴的数据上限（用于把数值映射到半径）。 */
  domains: Array<[number, number]>;
}

/**
 * 雷达图：一个系列 = 一个多边形。
 *
 * 数据按指标顺序排列（`data: [80, 90, 70, 60, 85]` 对应 `radar.indicators` 的顺序）。
 * 顶点几何同时用于绘制与命中判定：指针靠近某个顶点即命中该指标，
 * 落在多边形内部时按角度取最近的指标。
 */
export class RadarSeries extends SeriesBase {
  public seriesType: SeriesType = 'radar';
  public radar: RadarSeriesCoord | null = null;
  private radarCacheKey = '';

  public setCoord(coord: any): this {
    this.radar = (coord || null) as RadarSeriesCoord | null;
    this.radarCacheKey = '';
    return this.markDirty();
  }

  protected paintPad(): number {
    return 14;
  }

  private localCenter(): [number, number] {
    const coord = this.radar as RadarSeriesCoord;
    return [coord.polar.cx - coord.plot.x, coord.polar.cy - coord.plot.y];
  }

  /** 顶点像素（本地坐标）。 */
  protected rebuildPixels(): void {
    const coord = this.radar;
    const series = this.series;
    const n = series.pointCount;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const key = [n, coord.polar.radius, coord.plot.width, this.progress(), coord.domains.map((d) => d.join(':')).join('|')].join('::');
    if (key === this.radarCacheKey && this.pixels.length === n * 2) return;
    this.radarCacheKey = key;
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    const [cx, cy] = this.localCenter();
    const progress = this.progress();
    for (let i = 0; i < n; i++) {
      const angle = -Math.PI / 2 + (i / Math.max(1, n)) * Math.PI * 2;
      const domain = coord.domains[i] || [0, 1];
      const raw = series.pointAt(i).y;
      const value = raw === null || raw === undefined ? domain[0] : raw;
      const span = domain[1] - domain[0];
      let ratio = span > 0 ? (value - domain[0]) / span : 0;
      ratio = Math.max(0, Math.min(1, ratio));
      ratio *= progress;
      const r = coord.polar.radius * ratio;
      this.pixels[i * 2] = cx + Math.cos(angle) * r;
      this.pixels[i * 2 + 1] = cy + Math.sin(angle) * r;
    }
  }

  protected doRender(): void {
    const coord = this.radar;
    if (!coord) return;
    this.rebuildPixels();
    const n = this.pixels.length / 2;
    if (!n) return;
    const ctx = this.ctx;
    const color = this.pointColor(0);
    const unit = this.unit();
    const [cx, cy] = this.localCenter();
    this.beginDraw();

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = hexToRgba(color, 0.22);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = this.lineWidthDevice() * unit;
    ctx.stroke();

    // 顶点
    for (let i = 0; i < n; i++) {
      // 悬停：该指标顶点鼓起来（命中容差本来就比顶点大，不需要跟着改）
      const boost = this.hoverBoost(i, 0.3);
      this.drawSymbol(this.pixels[i * 2], this.pixels[i * 2 + 1], 'circle', this.symbolSizeAt(i) * boost, color, '#ffffff');
    }
    void cx;
    void cy;
    this.endDraw();
  }

  public hitTestIndex(localX: number, localY: number): number {
    this.rebuildPixels();
    const n = this.pixels.length / 2;
    if (!n) return -1;
    const option = this.series.option;
    const tolerance = option.hitRadius ? Number(option.hitRadius) : 24;
    let best = -1;
    let bestDist = tolerance * tolerance;
    for (let i = 0; i < n; i++) {
      const dx = this.pixels[i * 2] - localX;
      const dy = this.pixels[i * 2 + 1] - localY;
      const dist = dx * dx + dy * dy;
      if (dist <= bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    if (best >= 0) return best;
    // 多边形内部：按角度取最近指标
    if (this.containsPointInPolygon(localX, localY)) {
      const [cx, cy] = this.localCenter();
      const angle = Math.atan2(localY - cy, localX - cx);
      const step = (Math.PI * 2) / n;
      const normalized = ((angle + Math.PI / 2) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      return Math.round(normalized / step) % n;
    }
    return -1;
  }

  private containsPointInPolygon(x: number, y: number): boolean {
    const n = this.pixels.length / 2;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = this.pixels[i * 2];
      const yi = this.pixels[i * 2 + 1];
      const xj = this.pixels[j * 2];
      const yj = this.pixels[j * 2 + 1];
      const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }
}
