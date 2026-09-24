import { SeriesBase } from './SeriesBase';
import { heatColorRange, mixColors } from './HeatmapSeries';
import type { SeriesType } from '../../types';
import { computeHexBins, hexToPixel, pixelToHex, type HexbinBin } from '../../layout/hexbin';

/**
 * 六边形分箱：把点云聚成蜂窝格上的计数 / 聚合值。
 *
 * 与热力图的关系：热力图是**方形格**（每格一个数据项，格点由类目 / 数值轴决定），
 * hexbin 是**蜂窝格**（格点由像素半径决定，与轴无关）—— 方形格在对角方向有方向偏置，
 * 蜂窝格没有，所以看「有没有成团」时更可信。
 *
 * 分箱在像素空间（见 `layout/hexbin.ts` 的口径），所以缩放会重新分格；
 * `pixels` 存的是**格心**：绘制、高亮、命中都围绕它，`hitTestIndex` 返回的是格子下标。
 */
export class HexbinSeries extends SeriesBase {
  public seriesType: SeriesType = 'hexbin';
  protected supportsSampling = false;
  protected clipToBox = true;
  private bins: HexbinBin[] = [];
  private binsByKey = new Map<string, number>();
  private binsKey = '';
  private valueExtent: [number, number] = [0, 1];

  /** 半径（像素）：`hexbin.radius`，默认 14。 */
  private radius(): number {
    const raw = Number(this.series.option.hexbin && this.series.option.hexbin.radius);
    return isFinite(raw) && raw > 0 ? Math.min(48, Math.max(3, raw)) : 14;
  }

  private aggregate(): 'count' | 'sum' | 'mean' | 'max' {
    const raw = this.series.option.hexbin && this.series.option.hexbin.aggregate;
    return raw === 'sum' || raw === 'mean' || raw === 'max' ? raw : 'count';
  }

  /** 当前分箱结果（供提示框 / 测试读取）。 */
  public binCount(): number {
    this.rebuildPixels();
    return this.bins.length;
  }

  public binAt(index: number): HexbinBin {
    this.rebuildPixels();
    return this.bins[index];
  }

  /**
   * 分箱：数据点 → 本地像素 → 蜂窝格。
   *
   * 缓存键带上坐标系指纹与半径（都在 `buildSeriesKey` 里）——
   * 缩放 / 平移 / 改半径之后必须重新分格，否则格子会停在旧位置。
   */
  protected rebuildPixels(): void {
    const coord = this.coord;
    const n = this.series.pointCount;
    if (!coord) {
      this.bins = [];
      this.binsByKey.clear();
      this.pixels = new Float64Array(0);
      return;
    }
    const radius = this.radius();
    const aggregate = this.aggregate();
    const key = this.buildSeriesKey([n, radius, aggregate]);
    if (key === this.binsKey && this.pixels.length === this.bins.length * 2) return;
    this.binsKey = key;

    const local: Array<[number, number] | [number, number, number]> = [];
    for (let i = 0; i < n; i++) {
      const value = this.series.yValueAt(i);
      if (value === null) continue;
      const x = coord.xScale.map(this.series.xValueAt(i));
      const y = coord.yScale.map(value);
      if (!isFinite(x) || !isFinite(y)) continue;
      // 第三个数当权重（`[x, y, value]`，与散点的第三维同一个位置）
      const weight = Number((this.series.pointAt(i).raw as any)?.[2]);
      local.push(isFinite(weight) ? [x, y, weight] : [x, y]);
    }

    this.bins = computeHexBins(local, { radius, aggregate });
    this.binsByKey.clear();
    for (let i = 0; i < this.bins.length; i++) {
      this.binsByKey.set(`${this.bins[i].q},${this.bins[i].r}`, i);
    }
    if (this.pixels.length !== this.bins.length * 2) this.pixels = new Float64Array(this.bins.length * 2);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.bins.length; i++) {
      this.pixels[i * 2] = this.bins[i].cx;
      this.pixels[i * 2 + 1] = this.bins[i].cy;
      if (this.bins[i].value < min) min = this.bins[i].value;
      if (this.bins[i].value > max) max = this.bins[i].value;
    }
    this.valueExtent = isFinite(min) && isFinite(max) ? [min, max] : [0, 1];
    this.xMonotonic = false;
    this.renderIndices = null;
  }

  /** 命中：像素 → 轴向坐标 → 格子（O(1)）。 */
  public hitTestIndex(localX: number, localY: number): number {
    this.rebuildPixels();
    if (!this.bins.length) return -1;
    const cell = pixelToHex(localX, localY, this.radius());
    const index = this.binsByKey.get(`${cell.q},${cell.r}`);
    return index === undefined ? -1 : index;
  }

  /** 某个聚合值对应的颜色（浅 → 深，与热力图同一套插值）。 */
  private colorOf(value: number): string {
    const [min, max] = this.valueExtent;
    const ratio = max > min ? (value - min) / (max - min) : 1;
    const option: any = this.series.option.hexbin || {};
    // 与热力图共用同一套默认色阶（浅端一个浅蓝、深端系列色），换默认观感只改一处
    const range = heatColorRange({ minColor: option.minColor, maxColor: option.maxColor }, this.series.color);
    return mixColors(range.from, range.to, Math.max(0, Math.min(1, ratio)));
  }

  protected doRender(): void {
    const coord = this.coord;
    if (!coord || !this.chartTheme) return;
    this.rebuildPixels();
    const ctx = this.ctx;
    const unit = this.unit();
    const radius = this.radius();
    const entering = this.isEntering();
    const progress = entering ? this.progress() : 1;
    if (progress <= 0) return;
    this.beginDraw();
    for (let i = 0; i < this.bins.length; i++) {
      const bin = this.bins[i];
      // 入场：格子从中心长出来（与瀑布 / 箱线的「从基线展开」同一种叙事）
      const r = entering ? radius * (0.2 + 0.8 * progress) : radius;
      ctx.beginPath();
      for (let corner = 0; corner < 6; corner++) {
        const angle = (Math.PI / 180) * (60 * corner - 30);
        const x = bin.cx + Math.cos(angle) * r;
        const y = bin.cy + Math.sin(angle) * r;
        if (corner === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = this.colorOf(bin.value);
      ctx.fill();
      if (bin === this.bins[this.hoverIndex as number]) {
        // 悬停：同一份几何叠一层描边（不改形状 —— 格子尺寸是密度口径，不该随悬停变形）
        const alpha = this.hoverAlpha(i);
        if (alpha > 0.01) {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = 'rgba(255,255,255,0.95)';
          ctx.lineWidth = Math.max(unit, 2 * unit);
          ctx.stroke();
          ctx.restore();
        }
      }
    }
    this.endDraw();
  }

  /** 格子中心（图表坐标系用不到，这里给测试与网格装饰留个口子）。 */
  public centerOf(q: number, r: number): { x: number; y: number } {
    return hexToPixel(q, r, this.radius());
  }
}
