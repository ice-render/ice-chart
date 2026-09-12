import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';
import type { Rect } from '../../internal';

/** K 线（蜡烛图）：每个数据项是 [open, close, low, high]。 */
export class CandlestickSeries extends SeriesBase {
  public seriesType: SeriesType = 'candlestick';
  protected supportsSampling = false;
  protected clipToBox = true;

  public hitTestIndex(localX: number, localY: number): number {
    const rects = this.candleRects();
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      if (!rect) continue;
      if (localX >= rect.x - 2 && localX <= rect.x + rect.width + 2 && localY >= rect.y - 2 && localY <= rect.y + rect.height + 2) {
        return i;
      }
    }
    return -1;
  }

  /** 每根蜡烛的外接矩形（影线 + 实体），本地坐标。 */
  private candleRects(): Array<Rect | null> {
    const coord = this.coord;
    if (!coord) return [];
    const out: Array<Rect | null> = [];
    const bandWidth = coord.xScale.bandwidth() || coord.xScale.step() * 0.6;
    const bodyWidth = this.resolveBodyWidth(bandWidth);
    for (let i = 0; i < this.series.points.length; i++) {
      const point = this.series.points[i];
      if (!point.ohlc) {
        out.push(null);
        continue;
      }
      const centerX = coord.xScale.isBand() ? coord.xScale.map(point.xValue) : coord.xScale.map(point.xValue);
      if (!isFinite(centerX)) {
        out.push(null);
        continue;
      }
      const high = coord.yScale.map(point.ohlc[3]);
      const low = coord.yScale.map(point.ohlc[2]);
      if (!isFinite(high) || !isFinite(low)) {
        out.push(null);
        continue;
      }
      out.push({
        x: centerX - bodyWidth / 2,
        y: Math.min(high, low),
        width: bodyWidth,
        height: Math.abs(low - high),
      });
    }
    return out;
  }

  private resolveBodyWidth(bandWidth: number): number {
    const raw = Number(this.series.option.barWidth);
    if (!isFinite(raw) || raw <= 0) return Math.max(2, bandWidth * 0.6);
    return raw <= 1 ? Math.max(2, bandWidth * raw) : Math.max(2, raw * this.unit());
  }

  protected doRender(): void {
    const coord = this.coord;
    if (!coord) return;
    const ctx = this.ctx;
    const unit = this.unit();
    const candle = this.series.option.candle || {};
    const upColor = candle.upColor || '#EF4444';
    const downColor = candle.downColor || '#10B981';
    const borderWidth = Math.max(unit, (Number(candle.borderWidth) || 1) * unit);
    const bandWidth = coord.xScale.bandwidth() || coord.xScale.step() * 0.6;
    const bodyWidth = this.resolveBodyWidth(bandWidth);
    const rects = this.candleRects();

    this.beginDraw();
    for (let i = 0; i < this.series.points.length; i++) {
      const point = this.series.points[i];
      const rect = rects[i];
      if (!point.ohlc || !rect) continue;
      const [open, close, low, high] = point.ohlc;
      const rising = close >= open;
      const color = rising ? upColor : downColor;
      const centerX = rect.x + rect.width / 2;
      const yOpen = coord.yScale.map(open);
      const yClose = coord.yScale.map(close);
      const yLow = coord.yScale.map(low);
      const yHigh = coord.yScale.map(high);

      // 影线
      ctx.beginPath();
      ctx.moveTo(centerX, yHigh);
      ctx.lineTo(centerX, yLow);
      ctx.strokeStyle = color;
      ctx.lineWidth = borderWidth;
      ctx.stroke();

      // 实体（涨用空心、跌用实心，与国际惯例一致的可读性折中：这里统一描边 + 填充同色）
      const top = Math.min(yOpen, yClose);
      const height = Math.max(borderWidth, Math.abs(yClose - yOpen));
      ctx.beginPath();
      ctx.rect(centerX - bodyWidth / 2, top, bodyWidth, height);
      ctx.fillStyle = color;
      ctx.globalAlpha = rising ? 0.55 : 0.95;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = borderWidth;
      ctx.stroke();
    }
    this.endDraw();
  }
}
