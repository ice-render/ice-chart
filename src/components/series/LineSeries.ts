import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';

/** 折线 / 面积图。fillArea 为 true 时在折线下方填充到基线（堆叠时基线为前序堆叠值）。 */
export class LineSeries extends SeriesBase {
  public seriesType: SeriesType = 'line';
  /** 折线/面积必须裁剪到绘图区：缩放后窗口外的点会被映射到画布之外 */
  protected clipToBox = true;
  /** 面积填充（面积系列恒为 true）。 */
  public fillArea = false;

  protected doRender(): void {
    this.rebuildPixels();
    const pts = this.renderPoints();
    if (!pts.length) return;
    const option = this.series.option;
    const color = this.pointColor(0);
    const unit = this.unit();
    const lineWidth = this.lineWidthDevice() * unit;
    const symbol = option.symbol || 'circle';
    const showSymbol = option.showSymbol === true || this.seriesType === 'scatter';
    const ctx = this.ctx;

    this.beginDraw();
    if (this.fillArea) this.drawArea(color, pts);

    // 必须自己 beginPath：引擎的脏矩形局部重绘会在 ctx 上留下 clip 用的 rect 路径，
    // 直接 stroke() 会把那条残留路径一起描出来（表现为画布边缘莫名多出一圈线）。
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (typeof ctx.setLineDash === 'function' && Array.isArray(option.lineDash)) {
      ctx.setLineDash((option.lineDash as number[]).map((d) => d * unit));
    }
    if (option.smooth) this.drawSmoothLine(pts, typeof option.smooth === 'number' ? option.smooth : 0.5);
    else this.drawStraightLine(pts);
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);

    if (showSymbol && symbol !== 'none') {
      const fill = option.symbolFill || color;
      const stroke = option.symbolStroke || '#ffffff';
      for (let k = 0; k < pts.length; k++) {
        const point = pts[k];
        this.drawSymbol(point[0], point[1], symbol, this.symbolSizeAt(this.renderIndexAt(k)), fill, stroke);
      }
    }
    this.endDraw();
  }

  /**
   * 取本次要绘制的点。
   *
   * 降采样后点集可能少于原始数据（LTTB 保留下标），绘制与「折线在哪」始终一致；
   * 命中判定则走全量像素缓存，因此不会因为抽稀而点不到某个数据点。
   */
  protected renderPoints(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    const count = this.renderCount();
    for (let k = 0; k < count; k++) {
      const i = this.renderIndexAt(k);
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      out.push([x, y]);
    }
    return out;
  }

  private drawStraightLine(pts: Array<[number, number]>): void {
    const ctx = this.ctx;
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]);
      else ctx.lineTo(pts[i][0], pts[i][1]);
    }
  }

  /** 基数样条：以相邻四点的差分构造贝塞尔控制点，smooth ∈ (0,1]。 */
  private drawSmoothLine(pts: Array<[number, number]>, smooth: number): void {
    const ctx = this.ctx;
    const factor = Math.max(0.05, Math.min(1, smooth)) / 3;
    if (pts.length < 2) {
      if (pts.length === 1) ctx.moveTo(pts[0][0], pts[0][1]);
      return;
    }
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const prev = i > 0 ? pts[i - 1] : pts[i];
      const cur = pts[i];
      const next = pts[i + 1];
      const next2 = i + 2 < pts.length ? pts[i + 2] : next;
      const c1x = cur[0] + (next[0] - prev[0]) * factor;
      const c1y = cur[1] + (next[1] - prev[1]) * factor;
      const c2x = next[0] - (next2[0] - cur[0]) * factor;
      const c2y = next[1] - (next2[1] - cur[1]) * factor;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, next[0], next[1]);
    }
  }

  /** 面积填充：折线 → 基线 → 闭合。堆叠时基线为 base 的像素位置。 */
  private drawArea(color: string, pts: Array<[number, number]>): void {
    const coord = this.coord;
    if (!coord || pts.length < 2) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], this.baselineYFor(pts, 0));
    for (const [x, y] of pts) ctx.lineTo(x, y);
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i][0], this.baselineYFor(pts, i));
    ctx.closePath();
    const opacity = Number(this.series.option.areaOpacity);
    const topAlpha = isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0.28;
    const gradient = ctx.createLinearGradient ? ctx.createLinearGradient(0, 0, 0, coord.plot.height) : null;
    if (gradient) {
      gradient.addColorStop(0, hexToRgba(color, topAlpha));
      gradient.addColorStop(1, hexToRgba(color, 0.02));
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = hexToRgba(color, topAlpha);
    }
    ctx.fill();
  }

  private baselineYFor(_pts: Array<[number, number]>, index: number): number {
    const coord = this.coord as any;
    if (!coord) return 0;
    const original = this.renderIndexAt(index);
    const base = this.effective[original * 2];
    return isFinite(base) ? coord.yScale.map(base) : coord.plot.height;
  }

  public hitTestIndex(localX: number, localY: number): number {
    this.rebuildPixels();
    const n = this.pixels.length / 2;
    if (!n) return -1;
    const option = this.series.option;
    const baseTolerance = option.hitRadius ? Number(option.hitRadius) : Math.max(8, this.maxSymbolSize() / 2 + 4);

    // 大点数：先用二分找到最近的 x，只在其邻域里做精确判定
    if (n > 1024 && this.xMonotonic) {
      const anchor = this.nearestIndexAtX(localX);
      if (anchor < 0) return -1;
      let best = -1;
      let bestDist = baseTolerance * baseTolerance;
      const from = Math.max(0, anchor - 2);
      const to = Math.min(n - 1, anchor + 2);
      for (let i = from; i <= to; i++) {
        const x = this.pixels[i * 2];
        const y = this.pixels[i * 2 + 1];
        if (!isFinite(x) || !isFinite(y)) continue;
        const dx = x - localX;
        const dy = y - localY;
        const dist = dx * dx + dy * dy;
        if (dist <= bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      if (best >= 0) return best;
      const lineTolerance = Math.max(4, this.lineWidthDevice() + 4);
      for (let i = Math.max(0, anchor - 1); i <= Math.min(n - 2, anchor); i++) {
        const d = distanceToSegment(
          localX,
          localY,
          this.pixels[i * 2],
          this.pixels[i * 2 + 1],
          this.pixels[(i + 1) * 2],
          this.pixels[(i + 1) * 2 + 1]
        );
        if (d <= lineTolerance) return Math.abs(localX - this.pixels[i * 2]) <= Math.abs(localX - this.pixels[(i + 1) * 2]) ? i : i + 1;
      }
      return -1;
    }

    // 小点数：全量扫描（优先命中标记，其次命中折线本身）
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
