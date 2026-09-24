import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';
import { withAlpha } from '../../util/color';

/**
 * 小提琴图：每个数据项是**一组原始观测值**，轮廓由核密度曲线镜像而来。
 *
 * 几何口径：
 * - 密度曲线在**数据空间**算（归一化里的 `computeKdeProfile`，纯函数可单测），
 *   组件只做「数据空间 → 像素」的映射 —— 与函数绘图同一条思路：几何来自公式，不是逐点数据；
 * - 轮廓宽度按密度**归一化**到「band 内的半宽」，所以峰值贴着最宽处、尾巴收成一条线；
 * - 命中就是**这片轮廓的内部**（与渲染共用同一份多边形，铁律 1 + 铁律 2）。
 */
export class ViolinSeries extends SeriesBase {
  public seriesType: SeriesType = 'violin';
  protected supportsSampling = false;
  protected clipToBox = true;
  private geometryKey = '';
  private pixelKey = '';
  private polygons: Array<Array<[number, number]> | null> = [];

  /** 轮廓的半宽（像素）：`barWidth` 与箱线同口径，0~1 的小数是 band 占比。 */
  private halfWidth(): number {
    const coord = this.coord;
    if (!coord) return 0;
    const bandWidth = coord.xScale.bandwidth() || coord.xScale.step() * 0.5;
    const raw = Number(this.series.option.barWidth);
    const ratio = !isFinite(raw) || raw <= 0 ? 0.8 : raw <= 1 ? raw : Math.min(1, raw / Math.max(1, bandWidth));
    return Math.max(2, (bandWidth * ratio) / 2);
  }

  /**
   * 每条轮廓的像素几何（本地坐标）。
   *
   * 缓存键必须带坐标系指纹与绘图区尺寸（走 `buildSeriesKey`）：缩放 / 平移 / 数据域过渡
   * 之后密度曲线的像素位置全变，键不变就会拿旧轮廓去命中。
   */
  private ensureGeometry(): void {
    const coord = this.coord;
    const n = this.series.pointCount;
    if (!coord) {
      this.polygons = [];
      return;
    }
    const half = this.halfWidth();
    const key = this.buildSeriesKey([n, half]);
    if (key === this.geometryKey) return;
    this.geometryKey = key;

    const side = this.series.option.violin ? this.series.option.violin.side || 'both' : 'both';
    const polygons: Array<Array<[number, number]> | null> = new Array(n);
    for (let i = 0; i < n; i++) {
      const point = this.series.pointAt(i);
      const profile = point && point.violin;
      if (!point || !profile || profile.grid.length < 2) {
        polygons[i] = null;
        continue;
      }
      let peak = 0;
      for (const density of profile.density) if (density > peak) peak = density;
      const centerX = coord.xScale.map(point.xValue);
      if (!(peak > 0) || !isFinite(centerX)) {
        polygons[i] = null;
        continue;
      }
      const right: Array<[number, number]> = [];
      const left: Array<[number, number]> = [];
      for (let k = 0; k < profile.grid.length; k++) {
        const y = coord.yScale.map(profile.grid[k]);
        if (!isFinite(y)) continue;
        const width = half * (profile.density[k] / peak);
        right.push([centerX + width, y]);
        left.push([centerX - width, y]);
      }
      if (right.length < 2) {
        polygons[i] = null;
        continue;
      }
      if (side === 'both') {
        left.reverse();
        polygons[i] = [...right, ...left];
      } else {
        // 半宽形态：曲线回到中心线闭合成片
        const curve = side === 'left' ? left : right;
        polygons[i] = [...curve, [centerX, curve[curve.length - 1][1]], [centerX, curve[0][1]]];
      }
    }
    this.polygons = polygons;
  }

  /** 某一组的轮廓（本地像素坐标，闭合多边形）；没有密度时返回 null。 */
  public violinPolygonAt(index: number): Array<[number, number]> | null {
    this.ensureGeometry();
    return this.polygons[index] || null;
  }

  /** 像素缓存 = 轮廓的「最宽处中心」（高亮与提示框锚点）。 */
  protected rebuildPixels(): void {
    const coord = this.coord;
    const n = this.series.pointCount;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const key = this.buildSeriesKey([n, this.halfWidth()]);
    if (key === this.pixelKey && this.pixels.length === n * 2) return;
    this.pixelKey = key;
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const point = this.series.pointAt(i);
      const profile = point && point.violin;
      if (!point || !profile || !(profile.summary[4] > profile.summary[0]) || point.y === null) {
        this.pixels[i * 2] = NaN;
        this.pixels[i * 2 + 1] = NaN;
        continue;
      }
      this.pixels[i * 2] = coord.xScale.map(point.xValue);
      this.pixels[i * 2 + 1] = coord.yScale.map(point.y);
    }
    this.xMonotonic = false;
    this.renderIndices = null;
  }

  public hitTestIndex(localX: number, localY: number): number {
    this.ensureGeometry();
    for (let i = 0; i < this.polygons.length; i++) {
      const polygon = this.polygons[i];
      if (!polygon) continue;
      if (pointInPolygon(polygon, localX, localY)) return i;
    }
    return -1;
  }

  protected doRender(): void {
    const coord = this.coord;
    if (!coord || !this.chartTheme) return;
    this.ensureGeometry();
    this.rebuildPixels();
    const ctx = this.ctx;
    const unit = this.unit();
    const color = this.pointColor(0);
    const entering = this.isEntering();
    this.computeItemProgress();
    this.beginDraw();
    for (let i = 0; i < this.polygons.length; i++) {
      const polygon = this.polygons[i];
      if (!polygon || !polygon.length) continue;
      const p = entering ? this.itemProgress[i] : 1;
      if (p <= 0) continue;
      const anchor = this.pixels.length === this.polygons.length * 2 ? this.pixels[i * 2 + 1] : NaN;
      ctx.beginPath();
      for (let k = 0; k < polygon.length; k++) {
        const x = polygon[k][0];
        // 入场：以中位线为轴向外展开（密度形状是「长出来」的，不是淡入）
        const y = entering && isFinite(anchor) ? anchor + (polygon[k][1] - anchor) * p : polygon[k][1];
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = withAlpha(color, 0.28 * (entering ? p : 1));
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = unit;
      ctx.stroke();
      // 悬停：同一份几何再叠一层提亮 + 描边（不改形状，命中判定不会与渲染分叉）
      const alpha = this.hoverAlpha(i);
      if (alpha > 0.01) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = Math.max(unit, 2 * unit);
        ctx.stroke();
        ctx.restore();
      }
    }
    this.endDraw();
  }
}

/** 偶奇规则的多边形内部判定（射线法）。 */
function pointInPolygon(polygon: Array<[number, number]>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
