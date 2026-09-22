import { SeriesBase } from './SeriesBase';
import type { PieLabelParams, SeriesType } from '../../types';
import type { PolarLayout, Rect } from '../../internal';
import { measureTextWidth } from '../../util/text';

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

/** 从 a 到 b 的最短角度差（结果落在 (-π, π]）。 */
function shortestAngleDelta(a: number, b: number): number {
  let delta = normalizeAngle(b - a);
  if (delta > Math.PI) delta -= TAU;
  return delta;
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
  /** 每个扇区 [a0, a1, r0, r1]，本地坐标空间。 */
  private slices = new Float64Array(0);
  private pieCacheKey = '';
  /** 图例切换扇区显隐时的起点几何（按下标对齐）：隐藏一个扇区，其余扇区「挪过去」而不是跳过去。 */
  private sliceFrom: Float64Array | null = null;

  public setCoord(coord: any): this {
    this.polar = (coord || null) as PolarSeriesCoord | null;
    this.pieCacheKey = '';
    return this.markDirty();
  }

  public setHiddenSlices(indexes: number[]): this {
    // 只有显隐真的变了才记起点：syncComponents 每轮都会调这个方法
    if (indexes.join(',') !== this.hiddenSlices.join(',') && this.slices.length) {
      this.sliceFrom = new Float64Array(this.slices);
    }
    super.setHiddenSlices(indexes);
    this.pieCacheKey = '';
    return this;
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
    const series = this.series;
    if (!coord) {
      this.pixels = new Float64Array(0);
      this.slices = new Float64Array(0);
      return;
    }
    const option = this.series.option;
    const key = [
      series.pointCount,
      option.startAngle,
      option.clockwise,
      option.roseType,
      option.radius,
      option.innerRadius,
      coord.polar.radius,
      coord.plot.width,
      this.hiddenSlices.join(','),
      this.progress(),
      series.pointCount ? String(series.pointAt(0).y) : '',
    ].join('|');
    if (key === this.pieCacheKey) return;
    this.pieCacheKey = key;

    const n = series.pointCount;
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    if (this.slices.length !== n * 4) this.slices = new Float64Array(n * 4);
    const [cx, cy] = this.localCenter();
    const radius = coord.polar.radius;

    let total = 0;
    let maxValue = 0;
    for (let i = 0; i < n; i++) {
      if (this.hiddenSlices.indexOf(i) >= 0) continue;
      const value = series.pointAt(i).y || 0;
      if (value > 0) total += value;
      if (value > maxValue) maxValue = value;
    }

    // 每个扇区用自己的进度：入场时扇形「依次扫开」
    this.computeItemProgress();
    const dir = option.clockwise === false ? -1 : 1;
    let angle = -((option.startAngle === undefined ? 90 : Number(option.startAngle)) * Math.PI) / 180;
    const innerRatio = Math.max(0, Math.min(0.95, Number(option.innerRadius) || 0));
    const roseType = option.roseType;

    for (let i = 0; i < n; i++) {
      const hidden = this.hiddenSlices.indexOf(i) >= 0;
      const value = hidden ? 0 : series.pointAt(i).y || 0;
      const sweep = total > 0 ? (value / total) * TAU * (hidden ? 0 : this.itemProgress[i]) : 0;
      const a0 = angle;
      const a1 = angle + dir * sweep;
      angle = a1;

      let outer = radius;
      if (roseType && maxValue > 0) {
        outer =
          roseType === 'area'
            ? radius * Math.sqrt(Math.max(0, value) / maxValue)
            : radius * (Math.max(0, value) / maxValue);
        outer = Math.max(3, outer);
      }
      const inner = radius * innerRatio;
      this.slices[i * 4] = a0;
      this.slices[i * 4 + 1] = a1;
      this.slices[i * 4 + 2] = inner;
      this.slices[i * 4 + 3] = outer;
    }

    this.blendSliceMorph(this.isEntering());
    for (let i = 0; i < n; i++) this.writeCentroid(i, cx, cy);
  }

  /**
   * 显隐切换的过渡：从 `sliceFrom` 插值到新几何。
   *
   * 角度按**最短方向**走（跨 2π 的扇区不会绕一整圈），半径线性。
   * 被隐藏的扇区因此是「收拢到 0 再消失」，其余扇区平滑挪到新位置。
   */
  private blendSliceMorph(entering: boolean): void {
    const from = this.sliceFrom;
    if (!from || entering || from.length < this.slices.length) return;
    const t = Math.max(0, Math.min(1, this.progress()));
    if (t >= 1) {
      this.sliceFrom = null;
      return;
    }
    for (let i = 0; i < this.slices.length / 4; i++) {
      // 起点角按最短方向走；扫过角（带方向）单独插值 ——
      // 直接插值两个端点会让被隐藏的扇形在中途「先变宽再收拢」，看起来像抖了一下。
      const startA = from[i * 4];
      const startB = this.slices[i * 4];
      const a0 = startA + shortestAngleDelta(startA, startB) * t;
      const sweepFrom = from[i * 4 + 1] - startA;
      const sweepTo = this.slices[i * 4 + 1] - startB;
      this.slices[i * 4] = a0;
      this.slices[i * 4 + 1] = a0 + sweepFrom + (sweepTo - sweepFrom) * t;
      for (const k of [2, 3]) {
        const a = from[i * 4 + k];
        this.slices[i * 4 + k] = a + (this.slices[i * 4 + k] - a) * t;
      }
    }
  }

  /** 扇形质心写进像素缓存（命中与高亮锚点共用的那一份几何）。 */
  private writeCentroid(index: number, cx: number, cy: number): void {
    const a0 = this.slices[index * 4];
    const a1 = this.slices[index * 4 + 1];
    const inner = this.slices[index * 4 + 2];
    const outer = this.slices[index * 4 + 3];
    if (Math.abs(a1 - a0) <= 1e-9) {
      this.pixels[index * 2] = NaN;
      this.pixels[index * 2 + 1] = NaN;
      return;
    }
    const mid = (a0 + a1) / 2;
    const centroidRadius = inner + (outer - inner) * 0.6;
    this.pixels[index * 2] = cx + Math.cos(mid) * centroidRadius;
    this.pixels[index * 2 + 1] = cy + Math.sin(mid) * centroidRadius;
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

    const n = this.series.pointCount;
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
    const n = this.series.pointCount;
    const labelOption = this.series.option.label;
    const showLabel = !(labelOption && labelOption.show === false) && n > 0 && n <= 16;
    const inside = labelOption && labelOption.position === 'inside';
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (this.hiddenSlices.indexOf(i) >= 0) continue;
      const value = this.series.pointAt(i).y || 0;
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
      const color = this.series.pointAt(i).color || this.series.color;
      // 悬停反馈：扇形沿中角向外「脱出」一点（经典饼图交互）
      const boost = this.hoverBoost(i, 1);
      const offset = boost > 1 ? 7 * (boost - 1) * this.unit() : 0;
      const midAngle = (a0 + a1) / 2;
      const ox = Math.cos(midAngle) * offset;
      const oy = Math.sin(midAngle) * offset;
      ctx.beginPath();
      if (inner > 0) {
        ctx.arc(cx + ox, cy + oy, outer, a0, a1, dir < 0);
        ctx.arc(cx + ox, cy + oy, inner, a1, a0, dir > 0);
      } else {
        ctx.moveTo(cx + ox, cy + oy);
        ctx.arc(cx + ox, cy + oy, outer, a0, a1, dir < 0);
      }
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      if (n > 1) {
        // 扇形之间的白色分隔线：图形的一部分，不随主题变（深色底上它是切分依据）
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = unit;
        ctx.stroke();
      }
    }

    // 标签
    if (showLabel) {
      this.setFont(this.fontSize(), this.fontFamily());
      // 内部标签的防重叠：相邻角度太近就沿半径逐级外推（玫瑰图的小扇区尤其需要）
      let lastAngle = NaN;
      let stackLevel = 0;
      // 外侧标签先收集、后统一布局（同侧按 y 推开），避免小扇区的标签叠在一起
      const outerLabels: Array<{
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        x3: number;
        y3: number;
        text: string;
        right: boolean;
      }> = [];
      for (let i = 0; i < n; i++) {
        const a0 = this.slices[i * 4];
        const a1 = this.slices[i * 4 + 1];
        const inner = this.slices[i * 4 + 2];
        const outer = this.slices[i * 4 + 3];
        if (Math.abs(a1 - a0) <= 1e-9) continue;
        // 太窄的扇形不画标签，避免文字互相压叠（玫瑰图里小扇区尤其明显）
        const point = this.series.pointAt(i);
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
        const text =
          labelOption && typeof labelOption.formatter === 'function'
            ? String(labelOption.formatter(params))
            : `${params.name} ${percent.toFixed(1)}%`;
        const mid = (a0 + a1) / 2;
        if (inside) {
          if (isFinite(lastAngle)) {
            const gap = Math.abs(Math.atan2(Math.sin(mid - lastAngle), Math.cos(mid - lastAngle)));
            stackLevel = gap < 0.42 ? Math.min(3, stackLevel + 1) : 0;
          } else {
            stackLevel = 0;
          }
          lastAngle = mid;
          const anchor = inner + (outer - inner) * 0.62 + stackLevel * (this.fontSize() + 4);
          // 文字比扇区弧长还宽就不画内部标签：与其叠成一团，不如交给图例与提示框
          const arcWidth = Math.abs(a1 - a0) * anchor;
          if (measureTextWidth(this.ctx, text, this.fontSize(), this.fontFamily()) <= arcWidth + 6) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, cx + Math.cos(mid) * anchor, cy + Math.sin(mid) * anchor);
            continue;
          }
          // 装不下就落到下面的「外侧标签」分支 —— 以前这里是 continue（静默丢弃），
          // 于是「扇形小 + 系列多」的玫瑰图会出现「有的系列没有标签」（2026-09-14 修）。
        }
        const elbow = radius + 8;
        const end = radius + 26;
        const right = Math.cos(mid) >= 0;
        outerLabels.push({
          x1: cx + Math.cos(mid) * outer,
          y1: cy + Math.sin(mid) * outer,
          x2: cx + Math.cos(mid) * elbow,
          y2: cy + Math.sin(mid) * elbow,
          x3: cx + Math.cos(mid) * end + (right ? 8 : -8),
          y3: cy + Math.sin(mid) * end,
          text,
          right,
        });
      }

      // 外侧标签统一布局：同侧按 y 排序后互相推开；底部越界就整列上移
      const labelGap = this.fontSize() * 1.45;
      for (const side of [true, false]) {
        const col = outerLabels.filter((l) => l.right === side).sort((a, b) => a.y3 - b.y3);
        for (let i = 1; i < col.length; i++) {
          if (col[i].y3 - col[i - 1].y3 < labelGap) col[i].y3 = col[i - 1].y3 + labelGap;
        }
        if (col.length) {
          const overflow = col[col.length - 1].y3 - (cy + coord.polar.radius + labelGap * 2);
          if (overflow > 0) for (const l of col) l.y3 -= overflow;
        }
        for (const l of col) {
          ctx.strokeStyle = 'rgba(148,163,184,0.9)';
          ctx.lineWidth = unit;
          ctx.beginPath();
          ctx.moveTo(l.x1, l.y1);
          ctx.lineTo(l.x2, l.y2);
          ctx.lineTo(l.x2, l.y3);
          ctx.lineTo(l.x3, l.y3);
          ctx.stroke();
          ctx.textAlign = l.right ? 'left' : 'right';
          ctx.textBaseline = 'middle';
          // 文字用主题的坐标轴标签色（保证浅底/深底都可读）；与扇区的关联由引线承担
          ctx.fillStyle = (this.chartTheme && this.chartTheme.axisLabelColor) || '#475569';
          ctx.fillText(l.text, l.x3 + (l.right ? 4 : -4) * unit, l.y3);
        }
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
