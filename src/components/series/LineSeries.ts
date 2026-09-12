import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';

/** 折线 / 面积图。area 为 true 时在折线下方填充到基线。 */
export class LineSeries extends SeriesBase {
  public seriesType: SeriesType = 'line';
  /** 面积填充（area 系列恒为 true）。 */
  public fillArea = false;

  protected doRender(): void {
    this.rebuildPixels();
    const n = this.series.points.length;
    if (!n) return;
    const option = this.series.option;
    const color = this.pointColor(0);
    const unit = this.unit();
    const lineWidth = this.lineWidthDevice() * unit;
    const symbol = option.symbol || 'circle';
    const symbolSize = this.symbolSize();
    const showSymbol = option.showSymbol === true || this.seriesType === 'scatter';
    this.beginDraw();
    const ctx = this.ctx;

    if (this.fillArea) {
      this.drawArea(color);
    }

    // 必须自己 beginPath：引擎的脏矩形局部重绘会在 ctx 上留下 clip 用的 rect 路径，
    // 直接 stroke() 会把那条残留路径一起描出来（表现为画布边缘莫名多出一圈线）。
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (typeof ctx.setLineDash === 'function' && Array.isArray(option.lineDash)) {
      ctx.setLineDash((option.lineDash as number[]).map((d) => d * unit));
    }
    if (option.smooth) {
      this.drawSmoothLine(typeof option.smooth === 'number' ? option.smooth : 0.5);
    } else {
      this.drawStraightLine();
    }
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);

    if (showSymbol && symbol !== 'none') {
      const fill = option.symbolFill || color;
      const stroke = option.symbolStroke || '#ffffff';
      for (let i = 0; i < n; i++) {
        const x = this.pixels[i * 2];
        const y = this.pixels[i * 2 + 1];
        if (!isFinite(x) || !isFinite(y)) continue;
        this.drawSymbol(x, y, symbol, symbolSize, fill, stroke);
      }
    }
    this.endDraw();
  }

  private drawStraightLine(): void {
    const ctx = this.ctx;
    let started = false;
    const n = this.pixels.length / 2;
    for (let i = 0; i < n; i++) {
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
  }

  /** 基数样条：以相邻四点的差分构造贝塞尔控制点，smooth ∈ (0,1]。 */
  private drawSmoothLine(smooth: number): void {
    const ctx = this.ctx;
    const n = this.pixels.length / 2;
    const factor = Math.max(0.05, Math.min(1, smooth)) / 3;
    let started = false;
    for (let i = 0; i < n; i++) {
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
        continue;
      }
      const prev = this.pixelOr(i - 1, x, y);
      const next = this.pixelOr(i + 1, x, y);
      const next2 = this.pixelOr(i + 2, next[0], next[1]);
      const c1x = x + (next[0] - prev[0]) * factor;
      const c1y = y + (next[1] - prev[1]) * factor;
      const c2x = next[0] - (next2[0] - x) * factor;
      const c2y = next[1] - (next2[1] - y) * factor;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, next[0], next[1]);
    }
  }

  private pixelOr(index: number, fallbackX: number, fallbackY: number): [number, number] {
    const x = this.pixels[index * 2];
    const y = this.pixels[index * 2 + 1];
    if (index < 0 || index >= this.pixels.length / 2 || !isFinite(x) || !isFinite(y)) return [fallbackX, fallbackY];
    return [x, y];
  }

  /** 面积填充：折线 → 基线 → 闭合。堆叠时基线为 base 的像素位置。 */
  private drawArea(color: string): void {
    const ctx = this.ctx;
    const coord = this.coord as any;
    const unit = this.unit();
    const n = this.pixels.length / 2;
    const segments: Array<Array<[number, number, number]>> = [];
    let current: Array<[number, number, number]> = [];
    for (let i = 0; i < n; i++) {
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) {
        if (current.length) segments.push(current);
        current = [];
        continue;
      }
      const base = this.effective[i * 2];
      const baseY = isFinite(base) ? coord.yScale.map(base) : coord.plot.height;
      current.push([x, y, baseY]);
    }
    if (current.length) segments.push(current);

    const opacity = Number(this.series.option.areaOpacity);
    const topAlpha = isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0.28;
    for (const seg of segments) {
      if (seg.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(seg[0][0], seg[0][2]);
      for (const [x, y] of seg) ctx.lineTo(x, y);
      for (let i = seg.length - 1; i >= 0; i--) ctx.lineTo(seg[i][0], seg[i][2]);
      ctx.closePath();
      const gradient = ctx.createLinearGradient
        ? ctx.createLinearGradient(0, 0, 0, coord.plot.height)
        : null;
      if (gradient) {
        gradient.addColorStop(0, hexToRgba(color, topAlpha));
        gradient.addColorStop(1, hexToRgba(color, 0.02));
        ctx.fillStyle = gradient;
      } else {
        ctx.fillStyle = hexToRgba(color, topAlpha);
      }
      ctx.fill();
      void unit;
    }
  }

  public hitTestIndex(localX: number, localY: number): number {
    this.rebuildPixels();
    const n = this.pixels.length / 2;
    if (!n) return -1;
    const option = this.series.option;
    const baseTolerance = option.hitRadius ? Number(option.hitRadius) : Math.max(8, this.symbolSize() / 2 + 4);
    // 1) 优先命中数据标记附近
    let bestIndex = -1;
    let bestDist = baseTolerance * baseTolerance;
    for (let i = 0; i < n; i++) {
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      const dx = x - localX;
      const dy = y - localY;
      const dist = dx * dx + dy * dy;
      if (dist <= bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) return bestIndex;
    // 2) 再命中折线本身：点到线段的距离
    const lineTolerance = Math.max(4, this.lineWidthDevice() + 4);
    let hit = -1;
    this.eachSegment((x0, y0, x1, y1, i) => {
      if (hit >= 0) return;
      const d = distanceToSegment(localX, localY, x0, y0, x1, y1);
      if (d <= lineTolerance) {
        hit = Math.abs(localX - x0) <= Math.abs(localX - x1) ? i : i + 1;
      }
    });
    return hit;
  }
}

/** 点到线段距离。 */
export function distanceToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x0, py - y0);
  let t = ((px - x0) * dx + (py - y0) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** #RRGGBB / rgb() 颜色 → rgba 字符串。 */
export function hexToRgba(color: string, alpha: number): string {
  if (!color) return `rgba(0,0,0,${alpha})`;
  if (color.indexOf('rgba') === 0) return color;
  if (color.indexOf('rgb(') === 0) {
    return color.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  }
  let hex = color.replace('#', '');
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  if (hex.length !== 6) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
