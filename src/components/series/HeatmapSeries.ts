import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';
import type { Rect } from '../../internal';

/** 热力图：数据项是 [x类目, y类目, 数值]，x/y 都是类目轴。 */
export class HeatmapSeries extends SeriesBase {
  public seriesType: SeriesType = 'heatmap';
  protected supportsSampling = false;
  protected clipToBox = true;
  private heatCacheKey = '';

  /**
   * 覆盖基类的像素缓存：热力图每个点的「位置」是单元格中心，
   * 而不是「x 比例尺 + y 比例尺」直接映射出来的坐标（y 轴是类目带）。
   */
  protected rebuildPixels(): void {
    const coord = this.coord;
    const n = this.series.points.length;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const key = this.buildSeriesKey([n, coord.plot.width, coord.plot.height, String(coord.yScale.domain.join(','))]);
    if (key === this.heatCacheKey && this.pixels.length === n * 2) return;
    this.heatCacheKey = key;
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const rect = this.cellRectAt(i);
      if (!rect) {
        this.pixels[i * 2] = NaN;
        this.pixels[i * 2 + 1] = NaN;
        continue;
      }
      this.pixels[i * 2] = rect.x + rect.width / 2;
      this.pixels[i * 2 + 1] = rect.y + rect.height / 2;
    }
    this.xMonotonic = false;
    this.renderIndices = null;
  }

  private valueRange(): [number, number] {
    let min = Infinity;
    let max = -Infinity;
    for (const point of this.series.points) {
      if (point.y === null || !isFinite(point.y)) continue;
      if (point.y < min) min = point.y;
      if (point.y > max) max = point.y;
    }
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    if (min === max) return [min, min + 1];
    return [min, max];
  }

  private cellRectAt(index: number): Rect | null {
    const coord = this.coord;
    const point = this.series.points[index];
    if (!coord || !point) return null;
    const xStart = coord.xScale.bandStart(point.xValue, undefined as any);
    const yValue = point.name === undefined ? point.index : point.name;
    const yStart = coord.yScale.bandStart(yValue, undefined as any);
    if (!isFinite(xStart) || !isFinite(yStart)) return null;
    const width = coord.xScale.bandwidth() || coord.xScale.step() * 0.8;
    const height = coord.yScale.bandwidth() || coord.yScale.step() * 0.8;
    // y 轴的 range 是 [height, 0]（屏幕坐标向下），band 从起点往「上」延伸，
    // 这里必须按 range 方向摆正矩形，否则单元格会整体落到绘图区之外。
    const xDirection = coord.xScale.range[1] >= coord.xScale.range[0] ? 1 : -1;
    const yDirection = coord.yScale.range[1] >= coord.yScale.range[0] ? 1 : -1;
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    return {
      x: xDirection > 0 ? xStart : xStart - w,
      y: yDirection > 0 ? yStart : yStart - h,
      width: w,
      height: h,
    };
  }

  protected doRender(): void {
    const coord = this.coord;
    if (!coord) return;
    const ctx = this.ctx;
    const [min, max] = this.valueRange();
    const option = this.series.option.heatmap || {};
    const from = option.minColor || '#EFF6FF';
    const to = option.maxColor || this.series.color;
    const entering = this.isEntering();
    this.computeItemProgress();
    const columns = coord.xScale.domain.length || 1;
    this.beginDraw();
    for (let i = 0; i < this.series.points.length; i++) {
      const point = this.series.points[i];
      const rect = this.cellRectAt(i);
      if (!rect) continue;
      const ratio = point.y === null ? 0 : (point.y - min) / (max - min || 1);
      // 入场：按「对角线」逐格浮现（左上先、右下后）
      let alpha = 1;
      if (entering) {
        const row = Math.floor(i / columns);
        const column = i % columns;
        const phase = ((column + row) % Math.max(1, columns)) / Math.max(1, columns);
        const t = this.progress();
        alpha = Math.max(0, Math.min(1, (t - phase * (this.stagger || 0.35)) / Math.max(0.05, 1 - phase * (this.stagger || 0.35))));
        if (alpha <= 0) continue;
        ctx.globalAlpha = alpha;
      }
      ctx.fillStyle = mixColors(from, to, Math.max(0, Math.min(1, ratio)));
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      if (entering) ctx.globalAlpha = 1;
    }
    this.endDraw();
  }

  public hitTestIndex(localX: number, localY: number): number {
    for (let i = 0; i < this.series.points.length; i++) {
      const rect = this.cellRectAt(i);
      if (!rect) continue;
      if (localX >= rect.x && localX <= rect.x + rect.width && localY >= rect.y && localY <= rect.y + rect.height) return i;
    }
    return -1;
  }

  protected paintPad(): number {
    return 4;
  }
}

/** 两个十六进制颜色之间做线性插值。 */
export function mixColors(from: string, to: string, ratio: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return to;
  const r = Math.round(a[0] + (b[0] - a[0]) * ratio);
  const g = Math.round(a[1] + (b[1] - a[1]) * ratio);
  const bl = Math.round(a[2] + (b[2] - a[2]) * ratio);
  return `rgb(${r},${g},${bl})`;
}

function parseHex(color: string): [number, number, number] | null {
  if (typeof color !== 'string') return null;
  let hex = color.trim();
  if (hex.indexOf('#') === 0) {
    hex = hex.slice(1);
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length !== 6) return null;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const match = hex.match(/rgba?\(([^)]+)\)/);
  if (match) {
    const parts = match[1].split(',').map((v) => parseFloat(v));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }
  return null;
}
