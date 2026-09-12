import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';
import type { Rect } from '../../internal';
import { roundRect } from '../Legend';
import { hexToRgba } from './LineSeries';

/** 柱状图（支持分组与堆叠）。 */
export class BarSeries extends SeriesBase {
  public seriesType: SeriesType = 'bar';
  protected clipToBox = true;
  private barCacheKey = '';

  /** 横向柱状图：类目在 y 轴上（排行榜最常见的形式）。 */
  private isHorizontal(): boolean {
    const coord = this.coord;
    return !!coord && coord.yScale.isBand() && !coord.xScale.isBand();
  }

  /**
   * 像素缓存 = 每根柱子的中心。
   * 基类按「xValue → x 比例尺」映射，横向图上 xValue 是类目、x 轴是数值，映射不出坐标；
   * 柱子本来就是矩形，用矩形中心作为「数据点的位置」才是对的（高亮、提示框锚点都受益）。
   */
  protected rebuildPixels(): void {
    const coord = this.coord;
    const n = this.series.points.length;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const key = this.buildSeriesKey([n, coord.plot.width, coord.plot.height, this.isHorizontal() ? 'h' : 'v', String(coord.yScale.domain.join(','))]);
    if (key === this.barCacheKey && this.pixels.length === n * 2) return;
    this.barCacheKey = key;
    this.computeEffective();
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const rect = this.barRectAt(i);
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

  /** 单根柱子的像素矩形（组件本地坐标）。 */
  public barRectAt(index: number): Rect | null {
    const coord = this.coord;
    const point = this.series.points[index];
    if (!coord || !point) return null;
    // 纯几何函数：不触发 rebuildPixels（否则 rebuildPixels → barRectAt 会递归）
    if (this.effective.length !== this.series.points.length * 2) this.computeEffective();
    const top = this.effective[index * 2 + 1];
    const base = this.effective[index * 2];
    if (!isFinite(top)) return null;
    if (this.isHorizontal()) {
      // 横向：类目在 y 轴（band），数值在 x 轴（value）
      const bandStart = coord.yScale.bandStart(point.xValue);
      if (!isFinite(bandStart)) return null;
      const bandWidth = coord.yScale.bandwidth() || coord.yScale.step() * 0.6;
      const slotCount = Math.max(1, this.barSlot.count);
      const slotWidth = bandWidth / slotCount;
      const barWidth = this.resolveBarWidth(bandWidth, slotWidth);
      const direction = coord.yScale.range[1] >= coord.yScale.range[0] ? 1 : -1;
      // 槽位偏移必须跟随 range 方向：y 轴的 range 是 [height, 0]（向下为负），
      // 直接加偏移会把最下方那根柱子顶出绘图区底边（实测会越过坐标轴）。
      const slotOffset = slotWidth * this.barSlot.index + (slotWidth - barWidth) / 2;
      const near = bandStart + direction * slotOffset;
      const y = direction > 0 ? near : near - barWidth;
      const x0 = coord.xScale.map(base);
      const x1 = coord.xScale.map(top);
      if (!isFinite(x0) || !isFinite(x1)) return null;
      return { x: Math.min(x0, x1), y, width: Math.abs(x1 - x0), height: barWidth };
    }
    // 必须按「类目值」定位，不能传数据下标：类目轴缩放后可见窗口是类目的一个子集，
    // 用下标会被当成可见窗口内的位置，把窗口外的柱子画到错误的地方（曾因此把高亮框画到右轴上）。
    const bandStart = coord.xScale.bandStart(point.xValue);
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

  /** 单根柱子的颜色（瀑布图按增/减/合计覆写）。 */
  protected barColorAt(index: number): string {
    return this.pointColor(index);
  }

  protected doRender(): void {
    this.rebuildPixels();
    const coord = this.coord;
    if (!coord) return;
    const radius = Number(this.series.option.barRadius);
    const ctx = this.ctx;
    this.beginDraw();
    for (let i = 0; i < this.series.points.length; i++) {
      const rect = this.barRectAt(i);
      if (!rect || rect.height <= 0) continue;
      const color = this.barColorAt(i);
      ctx.beginPath();
      roundRect(ctx, rect.x, rect.y, rect.width, rect.height, isFinite(radius) ? radius : 0);
      if (ctx.createLinearGradient) {
        // 渐变方向跟着柱子的长度方向走
        const gradient = this.isHorizontal()
          ? ctx.createLinearGradient(rect.x, 0, rect.x + rect.width, 0)
          : ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.height);
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
    this.rebuildPixels();
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
