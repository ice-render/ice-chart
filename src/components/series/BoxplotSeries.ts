import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';
import type { Rect } from '../../internal';

/** 箱线图：每个数据项是 [min, Q1, median, Q3, max]。 */
export class BoxplotSeries extends SeriesBase {
  public seriesType: SeriesType = 'boxplot';
  protected clipToBox = true;
  private boxCacheKey = '';

  private boxWidthAt(bandWidth: number): number {
    const raw = Number(this.series.option.barWidth);
    if (!isFinite(raw) || raw <= 0) return Math.max(4, bandWidth * 0.5);
    return raw <= 1 ? Math.max(4, bandWidth * raw) : Math.max(4, raw * this.unit());
  }

  /** 每个箱线图的像素几何（本地坐标）。 */
  public boxRectAt(index: number): Rect | null {
    const coord = this.coord;
    const point = this.series.points[index];
    if (!coord || !point || !point.boxplot) return null;
    const centerX = coord.xScale.map(point.xValue);
    if (!isFinite(centerX)) return null;
    const bandWidth = coord.xScale.bandwidth() || coord.xScale.step() * 0.5;
    const boxWidth = this.boxWidthAt(bandWidth);
    const [, q1, , q3] = point.boxplot;
    const [min, , , , max] = point.boxplot;
    const yQ1 = coord.yScale.map(q1);
    const yQ3 = coord.yScale.map(q3);
    const yMin = coord.yScale.map(min);
    const yMax = coord.yScale.map(max);
    if (!isFinite(yQ1) || !isFinite(yQ3) || !isFinite(yMin) || !isFinite(yMax)) return null;
    return {
      x: centerX - boxWidth / 2,
      y: Math.min(yQ1, yQ3),
      width: boxWidth,
      height: Math.max(Math.abs(yQ3 - yQ1), this.unit()),
    };
  }

  /** 像素缓存 = 箱体中心（高亮与提示框锚点）。 */
  protected rebuildPixels(): void {
    const coord = this.coord;
    const n = this.series.points.length;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const key = [n, coord.plot.width, coord.plot.height, String(coord.xScale.domain.join(','))].join('|');
    if (key === this.boxCacheKey && this.pixels.length === n * 2) return;
    this.boxCacheKey = key;
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const rect = this.boxRectAt(i);
      const point = this.series.points[i];
      if (!rect || !point || !point.boxplot) {
        this.pixels[i * 2] = NaN;
        this.pixels[i * 2 + 1] = NaN;
        continue;
      }
      // 锚点放在中位线上，视觉上更像「这个数据点的值」
      this.pixels[i * 2] = rect.x + rect.width / 2;
      this.pixels[i * 2 + 1] = coord.yScale.map(point.boxplot[2]);
    }
    this.xMonotonic = false;
    this.renderIndices = null;
  }

  public hitTestIndex(localX: number, localY: number): number {
    this.rebuildPixels();
    const coord = this.coord;
    if (!coord) return -1;
    for (let i = 0; i < this.series.points.length; i++) {
      const point = this.series.points[i];
      const rect = this.boxRectAt(i);
      if (!point || !point.boxplot || !rect) continue;
      // 水平范围按箱体，垂直范围覆盖整条须（min..max）——和 K 线的命中语义一致
      const centerX = rect.x + rect.width / 2;
      if (Math.abs(localX - centerX) > rect.width / 2 + 1) continue;
      const yMin = coord.yScale.map(point.boxplot[0]);
      const yMax = coord.yScale.map(point.boxplot[4]);
      const lo = Math.min(yMin, yMax);
      const hi = Math.max(yMin, yMax);
      if (localY >= lo - 2 && localY <= hi + 2) return i;
    }
    return -1;
  }

  protected doRender(): void {
    const coord = this.coord;
    if (!coord || !this.chartTheme) return;
    this.rebuildPixels();
    const ctx = this.ctx;
    const theme = this.chartTheme;
    const unit = this.unit();
    const color = this.pointColor(0);
    this.beginDraw();
    for (let i = 0; i < this.series.points.length; i++) {
      const point = this.series.points[i];
      const rect = this.boxRectAt(i);
      if (!point || !point.boxplot || !rect) continue;
      const [min, q1, median, q3, max] = point.boxplot;
      const centerX = rect.x + rect.width / 2;
      const yMin = coord.yScale.map(min);
      const yMax = coord.yScale.map(max);
      const yMedian = coord.yScale.map(median);

      // 须
      ctx.beginPath();
      ctx.moveTo(centerX, yMax);
      ctx.lineTo(centerX, rect.y);
      ctx.moveTo(centerX, rect.y + rect.height);
      ctx.lineTo(centerX, yMin);
      ctx.strokeStyle = color;
      ctx.lineWidth = unit;
      ctx.stroke();
      // 须帽
      ctx.beginPath();
      ctx.moveTo(centerX - rect.width / 4, yMax);
      ctx.lineTo(centerX + rect.width / 4, yMax);
      ctx.moveTo(centerX - rect.width / 4, yMin);
      ctx.lineTo(centerX + rect.width / 4, yMin);
      ctx.stroke();

      // 箱体
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.fillStyle = hexWithAlpha(color, 0.28);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = unit;
      ctx.stroke();

      // 中位线
      ctx.beginPath();
      ctx.moveTo(rect.x, yMedian);
      ctx.lineTo(rect.x + rect.width, yMedian);
      ctx.lineWidth = Math.max(unit, 2 * unit);
      ctx.stroke();
      void q1;
      void q3;
      void theme;
    }
    this.endDraw();
  }
}

function hexWithAlpha(color: string, alpha: number): string {
  if (!color) return `rgba(0,0,0,${alpha})`;
  let hex = color.replace('#', '');
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (hex.length !== 6) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
