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
    // 虚拟系列（数值列 / 惰性原始点）走按需访问器，**不建逐点像素缓存**：
    // 惰性原始点原来照旧建（基类那条「自定义系列的 doRender 直读 pixels」），
    // 但折线 / 面积 / 散点的虚拟分支根本不读它 —— 100 万点白建一趟 ≈ 每帧 1s 量级。
    if (!this.series.virtual) this.rebuildPixels();
    const { pts, indices } = this.renderSequence();
    if (!pts.length) return;
    const option = this.series.option;
    const color = this.pointColor(0);
    const unit = this.unit();
    const lineWidth = this.lineWidthDevice() * unit;
    const symbol = option.symbol || 'circle';
    const showSymbol = option.showSymbol === true || this.seriesType === 'scatter';
    const ctx = this.ctx;

    this.beginDraw();
    if (this.fillArea) this.drawArea(color, pts, indices);

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
        if (!point) continue;
        this.drawSymbol(point[0], point[1], symbol, this.symbolSizeAt(indices[k]), fill, stroke);
      }
    }
    this.endDraw();
  }

  /**
   * 取本次要绘制的序列：点数组 + 每个点对应的**原始下标**。
   *
   * `null` 表示**断点**（抬笔）—— 与函数曲线的 NaN 分段是同一条规则：
   * 数据里的 `null` 是"这里没有数据"，不是"这里等于 0"。
   * 下标单独给一份，是因为加了断点标记之后「第 k 个绘制点」不再等于「第 k 个像素」。
   */
  protected renderSequence(): { pts: Array<[number, number] | null>; indices: number[] } {
    if (this.series.virtual) return this.virtualRenderSequence();
    this.rebuildPixels();
    const pts: Array<[number, number] | null> = [];
    const indices: number[] = [];
    let count = this.renderCount();
    // 入场动画：从左到右「画」出来（按比例揭示前 k 个点）。
    // 更新动画不做截断 —— 那条线本来就是「折点动起来」，截断会变成重画。
    if (this.isEntering()) {
      count = Math.max(1, Math.ceil(count * this.progress()));
    }
    for (let k = 0; k < count; k++) {
      const i = this.renderIndexAt(k);
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) {
        // 断点：抬笔（连续的断点只记一次）
        if (pts.length && pts[pts.length - 1] !== null) {
          pts.push(null);
          indices.push(-1);
        }
        continue;
      }
      pts.push([x, y]);
      indices.push(i);
    }
    return { pts, indices };
  }

  /**
   * 取本次要绘制的点（不含断点标记）。
   *
   * 降采样后点集可能少于原始数据（LTTB 保留下标），绘制与「折线在哪」始终一致；
   * 命中判定则走全量像素缓存，因此不会因为抽稀而点不到某个数据点。
   */
  protected renderPoints(): Array<[number, number]> {
    const { pts } = this.renderSequence();
    return pts.filter((point): point is [number, number] => !!point);
  }

  /** 当前实际绘制的点数（测试与调试用：入场动画会随时间从左到右增加）。 */
  public revealedPointCount(): number {
    this.rebuildPixels();
    return this.renderPoints().length;
  }

  /**
   * 列存（虚拟）折线 / 面积的绘制点。
   *
   * 与散点共用基类的虚拟内核（窗口二分 + 现算像素），差异只在「怎么把窗口压缩成折线」：
   * 折线丢掉极值就是撒谎（尖峰消失），所以按**像素列分桶**，每桶保留
   * 「首点 / 最低点 / 最高点 / 末点」四个下标（按原下标排序去重）——
   * 每列最多 4 个点，形状与极值都保住了，绘制成本也和散点同量级。
   *
   * 采样步长用「每像素列 8 个候选」：比散点（2 个）密一些，因为折线对形状更敏感；
   * 一屏 960px 时每帧扫描约 7700 个点，远低于 60fps 的预算。
   */
  private virtualRenderSequence(): { pts: Array<[number, number] | null>; indices: number[] } {
    const coord = this.coord;
    const series = this.series;
    const n = series.pointCount;
    const empty = { pts: [], indices: [] } as { pts: Array<[number, number] | null>; indices: number[] };
    if (!coord || !n) return empty;
    const { i0, i1 } = this.virtualVisibleWindow(this.maxSymbolSize());
    if (i1 < i0) return empty;
    const visible = i1 - i0 + 1;
    const plotWidth = coord.plot.width;
    // 入场动画：从左到右揭示（与普通折线的截断同语义）
    const entering = this.isEntering();
    const reveal = entering ? Math.max(0, Math.ceil(visible * this.progress())) : visible;
    if (reveal <= 0) return empty;
    const end = Math.min(i1, i0 + reveal - 1);
    const stride = visible > 4096 ? Math.max(1, Math.floor(visible / (plotWidth * 8))) : 1;
    const pts: Array<[number, number] | null> = [];
    const indices: number[] = [];
    const pushBreak = (): void => {
      if (pts.length && pts[pts.length - 1] !== null) {
        pts.push(null);
        indices.push(-1);
      }
    };
    if (stride === 1) {
      for (let i = i0; i <= end; i++) {
        const pixel = this.virtualPixelAt(i);
        if (!pixel) {
          pushBreak();
          continue;
        }
        pts.push(pixel);
        indices.push(i);
      }
      return { pts, indices };
    }
    let column = NaN;
    let first = -1;
    let last = -1;
    let minIndex = -1;
    let maxIndex = -1;
    let minY = Infinity;
    let maxY = -Infinity;
    const flush = (): void => {
      if (first < 0) return;
      const picks: number[] = [];
      for (const index of [first, minIndex, maxIndex, last]) {
        if (index < 0 || picks.indexOf(index) >= 0) continue;
        picks.push(index);
      }
      picks.sort((a, b) => a - b);
      for (const index of picks) {
        const pixel = this.virtualPixelAt(index);
        if (!pixel) continue;
        pts.push(pixel);
        indices.push(index);
      }
      first = -1;
    };
    for (let i = i0; i <= end; i += stride) {
      const value = series.yValueAt(i);
      if (value === null) {
        // 断点：本列到此为止，抬笔之后重开一段
        flush();
        pushBreak();
        column = NaN;
        continue;
      }
      const px = coord.xScale.map(series.xValueAt(i));
      const py = coord.yScale.map(value);
      if (!isFinite(px) || !isFinite(py)) continue;
      const col = Math.floor(px);
      if (col !== column) {
        flush();
        column = col;
        first = i;
        last = i;
        minIndex = i;
        maxIndex = i;
        minY = py;
        maxY = py;
        continue;
      }
      last = i;
      if (py < minY) {
        minY = py;
        minIndex = i;
      }
      if (py > maxY) {
        maxY = py;
        maxIndex = i;
      }
    }
    flush();
    return { pts, indices };
  }

  private drawStraightLine(pts: Array<[number, number] | null>): void {
    const ctx = this.ctx;
    let started = false;
    for (const point of pts) {
      if (!point) {
        started = false; // 断点：抬笔，下一段重新 moveTo
        continue;
      }
      if (started) ctx.lineTo(point[0], point[1]);
      else {
        ctx.moveTo(point[0], point[1]);
        started = true;
      }
    }
  }

  /** 基数样条：以相邻四点的差分构造贝塞尔控制点，smooth ∈ (0,1]。 */
  private drawSmoothLine(pts: Array<[number, number] | null>, smooth: number): void {
    const ctx = this.ctx;
    const factor = Math.max(0.05, Math.min(1, smooth)) / 3;
    // 断点把曲线切成若干段，段内照旧是基数样条
    let run: Array<[number, number]> = [];
    const flush = (): void => {
      if (run.length === 1) ctx.moveTo(run[0][0], run[0][1]);
      else if (run.length > 1) {
        ctx.moveTo(run[0][0], run[0][1]);
        for (let i = 0; i < run.length - 1; i++) {
          const prev = i > 0 ? run[i - 1] : run[i];
          const cur = run[i];
          const next = run[i + 1];
          const next2 = i + 2 < run.length ? run[i + 2] : next;
          const c1x = cur[0] + (next[0] - prev[0]) * factor;
          const c1y = cur[1] + (next[1] - prev[1]) * factor;
          const c2x = next[0] - (next2[0] - cur[0]) * factor;
          const c2y = next[1] - (next2[1] - cur[1]) * factor;
          ctx.bezierCurveTo(c1x, c1y, c2x, c2y, next[0], next[1]);
        }
      }
      run = [];
    };
    for (const point of pts) {
      if (!point) {
        flush();
        continue;
      }
      run.push(point);
    }
    flush();
  }

  /** 面积填充：折线 → 基线 → 闭合。堆叠时基线为 base 的像素位置；断点处分成多块。 */
  private drawArea(color: string, pts: Array<[number, number] | null>, indices: number[]): void {
    const coord = this.coord;
    if (!coord) return;
    const ctx = this.ctx;
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
    let start = 0;
    while (start < pts.length) {
      if (!pts[start]) {
        start += 1;
        continue;
      }
      let end = start;
      while (end < pts.length && pts[end]) end += 1;
      if (end - start >= 2) {
        ctx.beginPath();
        ctx.moveTo(pts[start]![0], this.baselineYForIndex(indices[start]));
        for (let i = start; i < end; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
        for (let i = end - 1; i >= start; i--) ctx.lineTo(pts[i]![0], this.baselineYForIndex(indices[i]));
        ctx.closePath();
        ctx.fill();
      }
      start = end;
    }
  }

  /** 第 `original` 个数据点的基线像素（堆叠时是 base，虚拟系列恒为 0）。 */
  private baselineYForIndex(original: number): number {
    const coord = this.coord as any;
    if (!coord) return 0;
    // 虚拟（列存）系列不支持堆叠 → 基线恒为 0（与普通面积系列的 0 基线同源）
    if (this.series.virtual) {
      const zero = coord.yScale.map(0);
      return isFinite(zero) ? zero : coord.plot.height;
    }
    const base = this.effective[original * 2];
    return isFinite(base) ? coord.yScale.map(base) : coord.plot.height;
  }

  public hitTestIndex(localX: number, localY: number): number {
    if (this.series.virtual) return this.hitTestVirtual(localX, localY);
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

  /**
   * 列存（虚拟）折线的命中：列上二分找锚点，先在邻域里比标记，再比相邻两点连成的线段。
   * 口径与普通折线的大点数分支完全一致（±2 邻域 + ±1 线段），只是像素现算。
   */
  private hitTestVirtual(localX: number, localY: number): number {
    this.rebuildPixels();
    const n = this.series.pointCount;
    if (!n) return -1;
    const option = this.series.option;
    const baseTolerance = option.hitRadius ? Number(option.hitRadius) : Math.max(8, this.maxSymbolSize() / 2 + 4);
    const anchor = this.nearestIndexAtX(localX);
    if (anchor < 0) return -1;
    let best = -1;
    let bestDist = baseTolerance * baseTolerance;
    for (let i = Math.max(0, anchor - 2); i <= Math.min(n - 1, anchor + 2); i++) {
      const pixel = this.virtualPixelAt(i);
      if (!pixel) continue;
      const dx = pixel[0] - localX;
      const dy = pixel[1] - localY;
      const dist = dx * dx + dy * dy;
      if (dist <= bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    if (best >= 0) return best;
    const lineTolerance = Math.max(4, this.lineWidthDevice() + 4);
    for (let i = Math.max(0, anchor - 1); i <= Math.min(n - 2, anchor); i++) {
      const a = this.virtualPixelAt(i);
      const b = this.virtualPixelAt(i + 1);
      if (!a || !b) continue;
      if (distanceToSegment(localX, localY, a[0], a[1], b[0], b[1]) <= lineTolerance) {
        return Math.abs(localX - a[0]) <= Math.abs(localX - b[0]) ? i : i + 1;
      }
    }
    return -1;
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
