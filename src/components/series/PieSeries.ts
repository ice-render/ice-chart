import { SeriesBase } from './SeriesBase';
import type { PieLabelParams, SeriesType } from '../../types';
import type { PolarLayout, Rect } from '../../internal';

export interface PolarSeriesCoord {
  polar: PolarLayout;
  /** 组件盒（极坐标外接正方形，图表坐标系）。 */
  plot: Rect;
  canvas: Rect;
}

const TAU = Math.PI * 2;

function normalizeAngle(value: number): number {
  return ((value % TAU) + TAU) % TAU;
}

/**
 * 饼图 / 玫瑰图。
 *
 * 命中判定与渲染共用同一份扇形几何（`slices`：每个扇区的起止角与内外半径），
 * 因此「画出来的扇形」与「点得到的扇形」必然一致 —— 与折线/柱形遵循同一条约定。
 */
export class PieSeries extends SeriesBase {
  public seriesType: SeriesType = 'pie';
  public polar: PolarSeriesCoord | null = null;
  /** 被隐藏的扇区下标（由图表层写入）。 */
  public hiddenSlices: number[] = [];
  /** 每个扇区 [a0, a1, r0, r1]，本地坐标空间。 */
  private slices = new Float64Array(0);
  private pieCacheKey = '';

  public setCoord(coord: any): this {
    this.polar = (coord || null) as PolarSeriesCoord | null;
    this.pieCacheKey = '';
    return this.markDirty();
  }

  public setHiddenSlices(indexes: number[]): this {
    this.hiddenSlices = indexes || [];
    this.pieCacheKey = '';
    return this.markDirty();
  }

  /** 标签可能画到圆外，脏矩形要留出余量。 */
  protected paintPad(): number {
    const label = this.series.option.label;
    return label && label.show === false ? 4 : 48;
  }

  private localCenter(): [number, number] {
    const coord = this.polar as PolarSeriesCoord;
    return [coord.polar.cx - coord.plot.x, coord.polar.cy - coord.plot.y];
  }

  /** 扇区几何 + 质心像素（质心供高亮与提示框锚点使用）。 */
  protected rebuildPixels(): void {
    const coord = this.polar;
    const points = this.series.points;
    if (!coord) {
      this.pixels = new Float64Array(0);
      this.slices = new Float64Array(0);
      return;
    }
    const option = this.series.option;
    const key = [
      points.length,
      option.startAngle,
      option.clockwise,
      option.roseType,
      option.radius,
      option.innerRadius,
      coord.polar.radius,
      coord.plot.width,
      this.hiddenSlices.join(','),
      this.progress(),
      points.length ? String(points[0].y) : '',
    ].join('|');
    if (key === this.pieCacheKey) return;
    this.pieCacheKey = key;

    const n = points.length;
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    if (this.slices.length !== n * 4) this.slices = new Float64Array(n * 4);
    const [cx, cy] = this.localCenter();
    const radius = coord.polar.radius;

    let total = 0;
    let maxValue = 0;
    for (let i = 0; i < n; i++) {
      if (this.hiddenSlices.indexOf(i) >= 0) continue;
      const value = points[i].y || 0;
      if (value > 0) total += value;
      if (value > maxValue) maxValue = value;
    }

    const progress = this.progress();
    const dir = option.clockwise === false ? -1 : 1;
    let angle = -((option.startAngle === undefined ? 90 : Number(option.startAngle)) * Math.PI) / 180;
    const innerRatio = Math.max(0, Math.min(0.95, Number(option.innerRadius) || 0));
    const roseType = option.roseType;

    for (let i = 0; i < n; i++) {
      const hidden = this.hiddenSlices.indexOf(i) >= 0;
      const value = hidden ? 0 : points[i].y || 0;
      const sweep = total > 0 ? (value / total) * TAU * progress : 0;
      const a0 = angle;
      const a1 = angle + dir * sweep;
      angle = a1;

      let outer = radius;
      if (roseType && maxValue > 0) {
        outer = roseType === 'area' ? radius * Math.sqrt(Math.max(0, value) / maxValue) : radius * (Math.max(0, value) / maxValue);
        outer = Math.max(3, outer);
      }
      const inner = radius * innerRatio;
      this.slices[i * 4] = a0;
      this.slices[i * 4 + 1] = a1;
      this.slices[i * 4 + 2] = inner;
      this.slices[i * 4 + 3] = outer;

      if (sweep <= 1e-9) {
        this.pixels[i * 2] = NaN;
        this.pixels[i * 2 + 1] = NaN;
        continue;
      }
      const mid = (a0 + a1) / 2;
      const centroidRadius = inner + (outer - inner) * 0.6;
      this.pixels[i * 2] = cx + Math.cos(mid) * centroidRadius;
      this.pixels[i * 2 + 1] = cy + Math.sin(mid) * centroidRadius;
    }
  }

  public hitTestIndex(localX: number, localY: number): number {
    const coord = this.polar;
    if (!coord) return -1;
    this.rebuildPixels();
    const [cx, cy] = this.localCenter();
    const dx = localX - cx;
    const dy = localY - cy;
    const dist = Math.hypot(dx, dy);
    const radius = coord.polar.radius;
    if (dist > radius + 4) return -1;

    const n = this.series.points.length;
    const angle = Math.atan2(dy, dx);
    for (let i = 0; i < n; i++) {
      const a0 = this.slices[i * 4];
      const a1 = this.slices[i * 4 + 1];
      const inner = this.slices[i * 4 + 2];
      const outer = this.slices[i * 4 + 3];
      const sweep = Math.abs(a1 - a0);
      if (sweep <= 1e-9) continue;
      if (dist < inner - 1) continue;
      const delta = normalizeAngle(a1 > a0 ? angle - a0 : a0 - angle);
      if (delta <= sweep + 1e-9 && dist <= outer + 4) return i;
    }
    return -1;
  }

  protected doRender(): void {
    const coord = this.polar;
    if (!coord) return;
    this.rebuildPixels();
    const ctx = this.ctx;
    const [cx, cy] = this.localCenter();
    const unit = this.unit();
    const dir = this.series.option.clockwise === false ? -1 : 1;
    const n = this.series.points.length;
    const labelOption = this.series.option.label;
    const showLabel = !(labelOption && labelOption.show === false) && n > 0 && n <= 16;
    const inside = labelOption && labelOption.position === 'inside';
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (this.hiddenSlices.indexOf(i) >= 0) continue;
      const value = this.series.points[i].y || 0;
      if (value > 0) total += value;
    }

    this.beginDraw();
    // 扇区
    for (let i = 0; i < n; i++) {
      const a0 = this.slices[i * 4];
      const a1 = this.slices[i * 4 + 1];
      const inner = this.slices[i * 4 + 2];
      const outer = this.slices[i * 4 + 3];
      if (Math.abs(a1 - a0) <= 1e-9) continue;
      const color = this.series.points[i].color || this.series.color;
      ctx.beginPath();
      if (inner > 0) {
        ctx.arc(cx, cy, outer, a0, a1, dir < 0);
        ctx.arc(cx, cy, inner, a1, a0, dir > 0);
      } else {
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, outer, a0, a1, dir < 0);
      }
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      if (n > 1) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = unit;
        ctx.stroke();
      }
    }

    // 标签
    if (showLabel) {
      this.setFont(this.fontSize(), this.fontFamily());
      for (let i = 0; i < n; i++) {
        const a0 = this.slices[i * 4];
        const a1 = this.slices[i * 4 + 1];
        const inner = this.slices[i * 4 + 2];
        const outer = this.slices[i * 4 + 3];
        if (Math.abs(a1 - a0) <= 1e-9) continue;
        // 太窄的扇形不画标签，避免文字互相压叠（玫瑰图里小扇区尤其明显）
        if (Math.abs(a1 - a0) < (inside ? 0.3 : 0.12)) continue;
        const point = this.series.points[i];
        const value = point.y || 0;
        const radius = coord.polar.radius;
        const percent = total > 0 ? (value / total) * 100 : 0;
        const params: PieLabelParams = {
          name: point.name || `${this.series.name} ${i + 1}`,
          value: point.y,
          percent,
          dataIndex: i,
          seriesId: this.series.id,
          seriesName: this.series.name,
          color: point.color || this.series.color,
        };
        const text = labelOption && typeof labelOption.formatter === 'function' ? String(labelOption.formatter(params)) : `${params.name} ${percent.toFixed(1)}%`;
        const mid = (a0 + a1) / 2;
        if (inside) {
          const anchor = inner + (outer - inner) * 0.62;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(text, cx + Math.cos(mid) * anchor, cy + Math.sin(mid) * anchor);
          continue;
        }
        const elbow = radius + 8;
        const end = radius + 26;
        const x1 = cx + Math.cos(mid) * outer;
        const y1 = cy + Math.sin(mid) * outer;
        const x2 = cx + Math.cos(mid) * elbow;
        const y2 = cy + Math.sin(mid) * elbow;
        const right = Math.cos(mid) >= 0;
        const x3 = cx + Math.cos(mid) * end + (right ? 8 : -8);
        const y3 = cy + Math.sin(mid) * end;
        ctx.strokeStyle = 'rgba(148,163,184,0.9)';
        ctx.lineWidth = unit;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x3, y3);
        ctx.stroke();
        ctx.textAlign = right ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = this.series.points[i].color || this.series.color;
        ctx.fillText(text, x3 + (right ? 4 : -4) * unit, y3);
      }
    }
    this.endDraw();
  }

  private fontSize(): number {
    return (this.chartTheme && this.chartTheme.fontSize) || 12;
  }

  private fontFamily(): string {
    return (this.chartTheme && this.chartTheme.fontFamily) || 'Arial';
  }
}
