import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';
import { computeBeeswarmOffsets } from '../../layout/density';

/**
 * 蜂群图（抖动条带）：每个观测一个点，同一类目里挤在一起的点横向错开。
 *
 * 与散点图的关系：数据形态、绘制、命中判定都是散点那一套（逐点 `[x, y]`），
 * 唯一的区别是 x 不是直接映射出来的，而是**在 band 内避让之后**的位置。
 * 避让发生在像素空间，所以算在 `rebuildPixels()` 里 —— 归一化阶段没有比例尺。
 */
export class BeeswarmSeries extends SeriesBase {
  public seriesType: SeriesType = 'beeswarm';
  protected supportsSampling = false;
  protected clipToBox = true;
  private swarmKey = '';

  /** 标记的形状与配色（与散点同一套字段，别各写一份）。 */
  private symbolStyle(): { shape: string; fill: string; stroke: string } {
    const option = this.series.option;
    const color = this.pointColor(0);
    return {
      shape: option.symbol || 'circle',
      fill: option.symbolFill || color,
      // 描边是「把点从背景与邻点里分出来」的那一圈，默认走主题的对比色：
      // 写死白色在深色主题下会糊成一片白（`labelHaloColor` 就是为这件事存在的）。
      stroke: option.symbolStroke || (this.chartTheme ? this.chartTheme.labelHaloColor : 'rgba(255,255,255,0.9)'),
    };
  }

  /**
   * 像素缓存 = 避让后的点位置，**绘制与命中共用这一份**（铁律 2）。
   */
  protected rebuildPixels(): void {
    const coord = this.coord;
    const n = this.series.pointCount;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const step = coord.xScale.step ? coord.xScale.step() : coord.xScale.bandwidth() || 40;
    const bandWidth = coord.xScale.bandwidth() || step * 0.5;
    const radius = Math.max(1, this.maxSymbolSize() / 2);
    // 单侧最大偏移：默认 band 的 40%，再夹在「半个步长」以内 ——
    // 超过半个步长，相邻类目的点云会互相压过来（视觉上就分不清是哪一组了）
    const spread = Number(this.series.option.spread);
    const ratio = !isFinite(spread) || spread <= 0 ? 0.8 : Math.min(1, spread);
    const maxOffset = Math.max(0, Math.min((bandWidth * ratio) / 2, step / 2 - radius));

    const key = this.buildSeriesKey([n, radius, maxOffset, coord.plot.width, coord.plot.height]);
    if (key === this.swarmKey && this.pixels.length === n * 2) return;
    this.swarmKey = key;
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    this.pixels.fill(NaN);

    // 按类目分组：同一组的点一起避让（不同组各自从中心线开始铺）
    const groups = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const value = this.series.yValueAt(i);
      if (value === null || !isFinite(value)) continue;
      const key = String(this.series.xValueAt(i));
      const bucket = groups.get(key);
      if (bucket) bucket.push(i);
      else groups.set(key, [i]);
    }

    for (const indexes of groups.values()) {
      const values = new Array<number>(indexes.length);
      for (let k = 0; k < indexes.length; k++) values[k] = this.series.yValueAt(indexes[k]) as number;
      const offsets = computeBeeswarmOffsets(values, {
        yOf: (value) => coord.yScale.map(value),
        radius,
        maxOffset,
      });
      for (let k = 0; k < indexes.length; k++) {
        const i = indexes[k];
        const x = coord.xScale.map(this.series.xValueAt(i));
        const y = coord.yScale.map(values[k]);
        if (!isFinite(x) || !isFinite(y)) continue;
        this.pixels[i * 2] = x + offsets[k];
        this.pixels[i * 2 + 1] = y;
      }
    }
    // 同一类目内横向错开之后 x 不再单调：不走二分，直接线性扫（见 hitTestIndex）
    this.xMonotonic = false;
    this.renderIndices = null;
  }

  public hitTestIndex(localX: number, localY: number): number {
    this.rebuildPixels();
    const option = this.series.option;
    const tolerance = option.hitRadius ? Number(option.hitRadius) : this.maxSymbolSize() / 2 + 4;
    const maxDist = tolerance * tolerance;
    let best = -1;
    let bestDist = maxDist;
    const n = this.pixels.length / 2;
    for (let i = 0; i < n; i++) {
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      const dx = x - localX;
      if (dx > tolerance || dx < -tolerance) continue;
      const dy = y - localY;
      const dist = dx * dx + dy * dy;
      if (dist <= bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  protected doRender(): void {
    this.rebuildPixels();
    const coord = this.coord;
    const n = this.pixels.length / 2;
    if (!coord || !n) return;
    /**
     * 密度纪律（与散点同一条口径）：点比像素列还多时按步长落墨，
     * 落墨量与像素数同级；**命中与提示框仍走全量**（`hitTestIndex` 读的是完整 `pixels`）。
     */
    const stride = n > 4096 ? Math.max(1, Math.floor(n / (coord.plot.width * 2))) : 1;
    const { shape, fill, stroke } = this.symbolStyle();
    const entering = this.isEntering();
    this.computeItemProgress();
    this.beginDraw();
    for (let i = 0; i < n; i += stride) {
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      const p = entering ? this.itemProgress[i] : 1;
      if (p <= 0) continue;
      const size = this.symbolSizeAt(i) * (entering ? 0.2 + 0.8 * p : 1) * this.hoverBoost(i, 0.18);
      if (entering && p < 1) this.ctx.globalAlpha = 0.25 + 0.75 * p;
      this.drawSymbol(x, y, shape, size, fill, stroke);
      if (entering && p < 1) this.ctx.globalAlpha = 1;
    }
    this.endDraw();
  }
}
