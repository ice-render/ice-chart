import { SeriesBase } from './SeriesBase';
import type { FunnelOption, SeriesType } from '../../types';
import type { Rect } from '../../internal';
import { measureTextWidth } from '../../util/text';
import { hexToRgba } from './LineSeries';

export interface FunnelSeriesCoord {
  plot: Rect;
  canvas: Rect;
  options: FunnelOption;
}

interface StageGeom {
  y0: number;
  y1: number;
  topWidth: number;
  bottomWidth: number;
  cx: number;
}

/**
 * 漏斗图：从上到下逐级收窄，每级宽度按数值映射。
 *
 * 相邻两级之间画梯形（本级宽度 → 下一级宽度），这是转化漏斗最常见的形态；
 * `trapezoid: false` 时退化成每一级独立的矩形。
 */
export class FunnelSeries extends SeriesBase {
  public seriesType: SeriesType = 'funnel';
  public funnel: FunnelSeriesCoord | null = null;
  protected clipToBox = true;
  /** 每个数据下标对应的梯形几何（本地坐标）。 */
  private stageGeom: Array<StageGeom | null> = [];
  private stageRects: Array<Rect | null> = [];
  private funnelKey = '';
  /** 阶段显隐切换时的起点几何（按数据下标对齐）：其余阶段「挪过去」而不是跳过去。 */
  private stageFrom: Array<StageGeom | null> | null = null;

  public setHiddenSlices(indexes: number[]): this {
    if (indexes.join(',') !== this.hiddenSlices.join(',') && this.stageGeom.length) {
      this.stageFrom = this.stageGeom.map((geom) => (geom ? { ...geom } : null));
    }
    super.setHiddenSlices(indexes);
    this.funnelKey = '';
    return this;
  }

  public setCoord(coord: any): this {
    this.funnel = (coord || null) as FunnelSeriesCoord | null;
    this.funnelKey = '';
    return this.markDirty();
  }

  protected paintPad(): number {
    return 12;
  }

  public highlightRectAt(index: number): Rect | null {
    this.rebuildPixels();
    return this.stageRects[index] || null;
  }

  private widthAt(geom: StageGeom, y: number): number {
    const span = geom.y1 - geom.y0 || 1;
    const t = Math.max(0, Math.min(1, (y - geom.y0) / span));
    return geom.topWidth + (geom.bottomWidth - geom.topWidth) * t;
  }

  protected rebuildPixels(): void {
    const coord = this.funnel;
    const series = this.series;
    const n = series.pointCount;
    if (!coord || !n) {
      this.pixels = new Float64Array(0);
      this.stageGeom = [];
      this.stageRects = [];
      return;
    }
    const options = coord.options || {};
    const key = this.buildSeriesKey([
      n,
      coord.plot.width,
      coord.plot.height,
      options.sort,
      options.minSize,
      options.trapezoid,
      this.hiddenSlices.join(','),
    ]);
    if (key === this.funnelKey && this.pixels.length === n * 2) return;
    this.funnelKey = key;
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    this.stageGeom = new Array(n).fill(null);
    this.stageRects = new Array(n).fill(null);

    const visible: number[] = [];
    for (let i = 0; i < n; i++) {
      if (this.hiddenSlices.indexOf(i) >= 0) continue;
      if (series.pointAt(i).y === null) continue;
      visible.push(i);
    }
    const sort = options.sort || 'descending';
    if (sort !== 'none') {
      visible.sort((a, b) => (sort === 'ascending' ? (series.pointAt(a).y || 0) - (series.pointAt(b).y || 0) : (series.pointAt(b).y || 0) - (series.pointAt(a).y || 0)));
    }
    if (!visible.length) return;

    const gap = Math.max(0, Number(options.gap) || 2);
    const stageHeight = Math.max(4, (coord.plot.height - gap * (visible.length - 1)) / visible.length);
    const maxValue = Math.max(...visible.map((i) => series.pointAt(i).y || 0), 0);
    const minSize = Math.max(0, Math.min(1, options.minSize === undefined ? 0.12 : Number(options.minSize)));
    const maxWidth = coord.plot.width;
    const cx = coord.plot.width / 2;
    // 入场：所有阶段先等宽（像一个矩形），再收拢成漏斗
    const morph = this.isEntering() ? Math.max(0, Math.min(1, this.progress())) : 1;
    const flatWidth = maxWidth * 0.72;
    const widths = visible.map((i) => {
      const value = series.pointAt(i).y || 0;
      const ratio = maxValue > 0 ? value / maxValue : 1;
      const target = Math.max(maxWidth * minSize, maxWidth * Math.max(0, Math.min(1, ratio)));
      return flatWidth + (target - flatWidth) * morph;
    });
    const trapezoid = options.trapezoid !== false;

    for (let k = 0; k < visible.length; k++) {
      const index = visible[k];
      const y0 = k * (stageHeight + gap);
      const y1 = y0 + stageHeight;
      const topWidth = widths[k];
      const bottomWidth = trapezoid ? (k + 1 < widths.length ? widths[k + 1] : widths[k]) : widths[k];
      const geom: StageGeom = { y0, y1, topWidth, bottomWidth, cx };
      this.stageGeom[index] = geom;
      const halfMax = Math.max(topWidth, bottomWidth) / 2;
      this.stageRects[index] = { x: cx - halfMax, y: y0, width: halfMax * 2, height: y1 - y0 };
      this.pixels[index * 2] = cx;
      this.pixels[index * 2 + 1] = (y0 + y1) / 2;
    }
    this.blendStageMorph();
    this.xMonotonic = false;
    this.renderIndices = null;
  }

  /**
   * 阶段显隐切换的过渡：从旧几何插值到新几何，阶段的高度与宽度一起变化。
   * 被隐藏的阶段直接不再绘制（它已经从 `visible` 里移除）。
   */
  private blendStageMorph(): void {
    const from = this.stageFrom;
    if (!from || this.isEntering()) return;
    const t = Math.max(0, Math.min(1, this.progress()));
    if (t >= 1) {
      this.stageFrom = null;
      return;
    }
    for (let i = 0; i < this.stageGeom.length; i++) {
      const target = this.stageGeom[i];
      const start = from[i];
      if (!target || !start) continue;
      const lerp = (a: number, b: number) => a + (b - a) * t;
      target.y0 = lerp(start.y0, target.y0);
      target.y1 = lerp(start.y1, target.y1);
      target.topWidth = lerp(start.topWidth, target.topWidth);
      target.bottomWidth = lerp(start.bottomWidth, target.bottomWidth);
      const halfMax = Math.max(target.topWidth, target.bottomWidth) / 2;
      this.stageRects[i] = { x: target.cx - halfMax, y: target.y0, width: halfMax * 2, height: target.y1 - target.y0 };
      this.pixels[i * 2] = target.cx;
      this.pixels[i * 2 + 1] = (target.y0 + target.y1) / 2;
    }
  }

  public hitTestIndex(localX: number, localY: number): number {
    this.rebuildPixels();
    for (let i = 0; i < this.stageGeom.length; i++) {
      const geom = this.stageGeom[i];
      if (!geom) continue;
      if (localY < geom.y0 - 1 || localY > geom.y1 + 1) continue;
      // 命中宽度跟着悬停放大，指针停在加宽后的边缘上不会「忽进忽出」
      const half = (this.widthAt(geom, localY) / 2) * this.hoverBoost(i, 0.06) + 1;
      if (Math.abs(localX - geom.cx) <= half) return i;
    }
    return -1;
  }

  protected doRender(): void {
    const coord = this.funnel;
    if (!coord || !this.chartTheme) return;
    this.rebuildPixels();
    const ctx = this.ctx;
    const unit = this.unit();
    const theme = this.chartTheme;
    const options = coord.options || {};
    const labelPosition = options.labelPosition || 'inside';
    let visibleCount = 0;
    for (let i = 0; i < this.stageGeom.length; i++) if (this.stageGeom[i]) visibleCount++;
    let total = 0;
    for (let i = 0; i < this.series.pointCount; i++) {
      if (!this.stageGeom[i]) continue;
      total += this.series.pointAt(i).y || 0;
    }

    this.beginDraw();
    for (let i = 0; i < this.stageGeom.length; i++) {
      const geom = this.stageGeom[i];
      if (!geom) continue;
      const point = this.series.pointAt(i);
      const color = point.color || this.series.color;
      // 悬停：整级向两侧摊开一点（保持中心不动，仍不越过绘图区）
      const boost = this.hoverBoost(i, 0.06);
      const topWidth = geom.topWidth * boost;
      const bottomWidth = geom.bottomWidth * boost;
      ctx.beginPath();
      ctx.moveTo(geom.cx - topWidth / 2, geom.y0);
      ctx.lineTo(geom.cx + topWidth / 2, geom.y0);
      ctx.lineTo(geom.cx + bottomWidth / 2, geom.y1);
      ctx.lineTo(geom.cx - bottomWidth / 2, geom.y1);
      ctx.closePath();
      const gradient = ctx.createLinearGradient(0, geom.y0, 0, geom.y1);
      gradient.addColorStop(0, hexToRgba(color, 0.95));
      gradient.addColorStop(1, hexToRgba(color, 0.75));
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = unit;
      ctx.stroke();
    }

    // 标签
    this.setFont(theme.fontSize, theme.fontFamily);
    ctx.textBaseline = 'middle';
    for (let i = 0; i < this.stageGeom.length; i++) {
      const geom = this.stageGeom[i];
      if (!geom) continue;
      const point = this.series.pointAt(i);
      const value = point.y || 0;
      const percent = total > 0 ? (value / total) * 100 : 0;
      const text = `${point.name || point.xValue}  ${value}${visibleCount > 1 ? `  ${percent.toFixed(1)}%` : ''}`;
      const midY = (geom.y0 + geom.y1) / 2;
      const widthAtMid = this.widthAt(geom, midY);
      if (labelPosition === 'right') {
        ctx.textAlign = 'left';
        ctx.fillStyle = theme.textColor;
        ctx.fillText(text, geom.cx + Math.max(geom.topWidth, geom.bottomWidth) / 2 + 8 * unit, midY);
        continue;
      }
      // 内部标签：放不下就挪到右侧，避免压出漏斗外
      const textWidth = measureTextWidth(ctx, text, theme.fontSize, theme.fontFamily);
      if (textWidth + 12 > widthAtMid) {
        ctx.textAlign = 'left';
        ctx.fillStyle = theme.textColor;
        ctx.fillText(text, geom.cx + Math.max(geom.topWidth, geom.bottomWidth) / 2 + 8 * unit, midY);
      } else {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(text, geom.cx, midY);
      }
    }
    this.endDraw();
  }
}
