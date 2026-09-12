import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';
import type { Rect } from '../../internal';
import { roundRect } from '../Legend';
import { hexToRgba } from './LineSeries';

/** 柱状图（支持分组与堆叠）。 */
export class BarSeries extends SeriesBase {
  public seriesType: SeriesType = 'bar';

  /** 单根柱子的像素矩形（组件本地坐标）。 */
  public barRectAt(index: number): Rect | null {
    this.rebuildPixels();
    const coord = this.coord;
    const point = this.series.points[index];
    if (!coord || !point) return null;
    const top = this.effective[index * 2 + 1];
    const base = this.effective[index * 2];
    if (!isFinite(top)) return null;
    const bandStart = coord.xScale.bandStart(point.xValue, index);
    if (!isFinite(bandStart)) return null;
    const bandWidth = coord.xScale.bandwidth() || coord.xScale.step() * 0.6;
    const slotCount = Math.max(1, this.barSlot.count);
    const slotWidth = bandWidth / slotCount;
    const barWidth = this.resolveBarWidth(bandWidth, slotWidth);
    const x = bandStart + slotWidth * this.barSlot.index + (slotWidth - barWidth) / 2;
    const y0 = coord.yScale.map(base);
    const y1 = coord.yScale.map(top);
    if (!isFinite(y0) || !isFinite(y1)) return null;
    return { x, y: Math.min(y0, y1), width: barWidth, height: Math.abs(y1 - y0) };
  }

  private resolveBarWidth(bandWidth: number, slotWidth: number): number {
    const option = this.series.option;
    const raw = Number(option.barWidth);
    if (!isFinite(raw) || raw <= 0) {
      return Math.max(1, slotWidth * (1 - (isFinite(Number(option.barGap)) ? Number(option.barGap) : 0.2)));
    }
    // 0~1 视为 band 占比，>1 视为设备像素
    return raw <= 1 ? Math.max(1, bandWidth * raw) : Math.max(1, raw * this.unit());
  }

  protected doRender(): void {
    this.rebuildPixels();
    const coord = this.coord;
    if (!coord) return;
    const color = this.pointColor(0);
    const radius = Number(this.series.option.barRadius);
    const ctx = this.ctx;
    this.beginDraw();
    for (let i = 0; i < this.series.points.length; i++) {
      const rect = this.barRectAt(i);
      if (!rect || rect.height <= 0) continue;
      ctx.beginPath();
      roundRect(ctx, rect.x, rect.y, rect.width, rect.height, isFinite(radius) ? radius : 0);
      if (ctx.createLinearGradient) {
        const gradient = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.height);
        gradient.addColorStop(0, hexToRgba(color, 0.95));
        gradient.addColorStop(1, hexToRgba(color, 0.7));
        ctx.fillStyle = gradient;
      } else {
        ctx.fillStyle = color;
      }
      ctx.fill();
    }
    this.endDraw();
  }

  public hitTestIndex(localX: number, localY: number): number {
    const n = this.series.points.length;
    for (let i = 0; i < n; i++) {
      const rect = this.barRectAt(i);
      if (!rect) continue;
      if (localX >= rect.x && localX <= rect.x + rect.width && localY >= rect.y && localY <= rect.y + rect.height) {
        return i;
      }
    }
    return -1;
  }
}
