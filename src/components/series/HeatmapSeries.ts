import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';
import type { Rect } from '../../internal';

/** 热力图：数据项是 [x类目, y类目, 数值]，x/y 都是类目轴。 */
export class HeatmapSeries extends SeriesBase {
  public seriesType: SeriesType = 'heatmap';
  protected supportsSampling = false;
  protected clipToBox = true;
  private heatCacheKey = '';

  /**
   * 覆盖基类的像素缓存：热力图每个点的「位置」是单元格中心，
   * 而不是「x 比例尺 + y 比例尺」直接映射出来的坐标（y 轴是类目带）。
   */
  protected rebuildPixels(): void {
    const coord = this.coord;
    const n = this.series.pointCount;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const key = this.buildSeriesKey([n, coord.plot.width, coord.plot.height, String(coord.yScale.domain.join(','))]);
    if (key === this.heatCacheKey && this.pixels.length === n * 2) return;
    this.heatCacheKey = key;
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const rect = this.cellRectAt(i);
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

  private valueRange(): [number, number] {
    // 列存（虚拟）矩阵：值域在建列那一趟算好了，别再逐格合成数据点
    const grid = this.series.grid;
    if (grid) return grid.valueDomain || [0, 1];
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0, n = this.series.pointCount; i < n; i++) {
      const y = this.series.pointAt(i).y;
      if (y === null || !isFinite(y)) continue;
      if (y < min) min = y;
      if (y > max) max = y;
    }
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    if (min === max) return [min, min + 1];
    return [min, max];
  }

  /** 配色（普通与列存两条绘制路径共用，别各写一份）。 */
  private heatColors(): { from: string; to: string } {
    const option = this.series.option.heatmap || {};
    return { from: option.minColor || '#EFF6FF', to: option.maxColor || this.series.color };
  }

  private cellRectAt(index: number): Rect | null {
    if (this.series.grid) return this.virtualCellRect(index);
    const coord = this.coord;
    const point = this.series.pointAt(index);
    if (!coord || !point) return null;
    const xStart = coord.xScale.bandStart(point.xValue, undefined as any);
    const yValue = point.name === undefined ? point.index : point.name;
    const yStart = coord.yScale.bandStart(yValue, undefined as any);
    if (!isFinite(xStart) || !isFinite(yStart)) return null;
    const width = coord.xScale.bandwidth() || coord.xScale.step() * 0.8;
    const height = coord.yScale.bandwidth() || coord.yScale.step() * 0.8;
    // y 轴的 range 是 [height, 0]（屏幕坐标向下），band 从起点往「上」延伸，
    // 这里必须按 range 方向摆正矩形，否则单元格会整体落到绘图区之外。
    const xDirection = coord.xScale.range[1] >= coord.xScale.range[0] ? 1 : -1;
    const yDirection = coord.yScale.range[1] >= coord.yScale.range[0] ? 1 : -1;
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    return {
      x: xDirection > 0 ? xStart : xStart - w,
      y: yDirection > 0 ? yStart : yStart - h,
      width: w,
      height: h,
    };
  }

  protected doRender(): void {
    const coord = this.coord;
    if (!coord) return;
    if (this.series.grid) {
      this.renderVirtual();
      return;
    }
    const ctx = this.ctx;
    const [min, max] = this.valueRange();
    const { from, to } = this.heatColors();
    const entering = this.isEntering();
    this.computeItemProgress();
    const columns = coord.xScale.domain.length || 1;
    this.beginDraw();
    for (let i = 0; i < this.series.pointCount; i++) {
      const point = this.series.pointAt(i);
      const rect = this.cellRectAt(i);
      if (!rect) continue;
      const ratio = point.y === null ? 0 : (point.y - min) / (max - min || 1);
      // 入场：按「对角线」逐格浮现（左上先、右下后）
      let alpha = 1;
      if (entering) {
        const row = Math.floor(i / columns);
        const column = i % columns;
        const phase = ((column + row) % Math.max(1, columns)) / Math.max(1, columns);
        const t = this.progress();
        alpha = Math.max(0, Math.min(1, (t - phase * (this.stagger || 0.35)) / Math.max(0.05, 1 - phase * (this.stagger || 0.35))));
        if (alpha <= 0) continue;
        ctx.globalAlpha = alpha;
      }
      ctx.fillStyle = mixColors(from, to, Math.max(0, Math.min(1, ratio)));
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      if (entering) ctx.globalAlpha = 1;
    }
    // 悬停：给单元格叠一层提亮 + 描边（不改几何 —— 单元格紧挨着，改大小会盖住邻居）
    if (this.hoverIndex !== null) this.drawHoverOverlay(this.hoverIndex, this.cellRectAt(this.hoverIndex) as Rect, { radius: 0 });
    this.endDraw();
  }

  public hitTestIndex(localX: number, localY: number): number {
    if (this.series.grid) return this.hitTestGrid(localX, localY);
    for (let i = 0; i < this.series.pointCount; i++) {
      const rect = this.cellRectAt(i);
      if (!rect) continue;
      if (localX >= rect.x && localX <= rect.x + rect.width && localY >= rect.y && localY <= rect.y + rect.height) return i;
    }
    return -1;
  }

  protected paintPad(): number {
    return 4;
  }

  // ------------------------------------------------- 列存（虚拟）稠密矩阵

  /** 逐格绘制的上限：超过就按像素块聚合（一屏几十万个 fillRect 是画不完的）。 */
  private static readonly MAX_DIRECT_CELLS = 20000;
  /** 聚合后的块数上限（决定块边长取多大）。 */
  private static readonly MAX_BLOCKS = 20000;

  /** 几何缓存（按「数据量 + 绘图区 + 类目域」失效）：列 / 行的像素位置与聚合块。 */
  private gridKey = '';
  private gridX: Float64Array = new Float64Array(0);
  private gridY: Float64Array = new Float64Array(0);
  private gridCellW = 1;
  private gridCellH = 1;
  private gridVisibleCols: number[] = [];
  private gridVisibleRows: number[] = [];
  private gridBlocks: Float64Array = new Float64Array(0);
  private gridBlockCols = 0;
  private gridBlockRows = 0;
  private gridBlockPx = 0;

  /**
   * 同步几何：列 / 行的像素位置（band 起点）、可见窗口、聚合块。
   *
   * 为什么聚合：稠密矩阵（1000 × 1000 = 100 万格）挤进 960 × 420 的画布时，
   * 每格都不足一个像素 —— 逐格 fillRect 既画不完也没有意义。于是按**屏幕像素块**聚合，
   * 块内取**最大值**（热点是热力图最该保住的信息，平均会把它抹平），
   * 把绘制量压到块数上限以内；聚合结果按几何键缓存，悬停帧不再重算。
   */
  private syncGrid(): void {
    const coord = this.coord;
    const grid = this.series.grid;
    if (!coord || !grid) return;
    const cols = grid.xCategories.length;
    const rows = grid.yCategories.length;
    const axisKey = (scale: any): string =>
      `${scale.domain.length}:${String(scale.domain[0])}~${String(scale.domain[scale.domain.length - 1])}`;
    const key = [
      this.series.pointCount,
      coord.plot.width.toFixed(2),
      coord.plot.height.toFixed(2),
      axisKey(coord.xScale),
      axisKey(coord.yScale),
    ].join('|');
    if (key === this.gridKey) return;
    this.gridKey = key;

    const xDirection = coord.xScale.range[1] >= coord.xScale.range[0] ? 1 : -1;
    const yDirection = coord.yScale.range[1] >= coord.yScale.range[0] ? 1 : -1;
    const cellW = Math.max(0.01, coord.xScale.bandwidth() || coord.xScale.step() * 0.8);
    const cellH = Math.max(0.01, coord.yScale.bandwidth() || coord.yScale.step() * 0.8);
    const xs = new Float64Array(cols);
    const ys = new Float64Array(rows);
    for (let c = 0; c < cols; c++) {
      const start = coord.xScale.bandStart(grid.xCategories[c], undefined as any);
      xs[c] = xDirection > 0 ? start : start - cellW;
    }
    for (let r = 0; r < rows; r++) {
      const start = coord.yScale.bandStart(grid.yCategories[r], undefined as any);
      ys[r] = yDirection > 0 ? start : start - cellH;
    }
    this.gridX = xs;
    this.gridY = ys;
    this.gridCellW = cellW;
    this.gridCellH = cellH;

    const plotWidth = coord.plot.width;
    const plotHeight = coord.plot.height;
    const visibleCols: number[] = [];
    const visibleRows: number[] = [];
    for (let c = 0; c < cols; c++) {
      // NaN = 该列不在当前窗口（缩放后的类目域是子集）→ 直接跳过；
      // 注意不能让 NaN 漏进「可见」分支：NaN 的比较全是 false，会整列混进来
      if (!isFinite(xs[c]) || xs[c] + cellW < -1 || xs[c] > plotWidth + 1) continue;
      visibleCols.push(c);
    }
    for (let r = 0; r < rows; r++) {
      if (!isFinite(ys[r]) || ys[r] + cellH < -1 || ys[r] > plotHeight + 1) continue;
      visibleRows.push(r);
    }
    this.gridVisibleCols = visibleCols;
    this.gridVisibleRows = visibleRows;

    const visible = visibleCols.length * visibleRows.length;
    const blockPx =
      visible <= HeatmapSeries.MAX_DIRECT_CELLS
        ? 0
        : Math.max(1, Math.ceil(Math.sqrt(visible / HeatmapSeries.MAX_BLOCKS)));
    this.gridBlockPx = blockPx;
    if (blockPx === 0) {
      this.gridBlocks = new Float64Array(0);
      this.gridBlockCols = 0;
      this.gridBlockRows = 0;
      return;
    }
    const blockCols = Math.max(1, Math.ceil(plotWidth / blockPx));
    const blockRows = Math.max(1, Math.ceil(plotHeight / blockPx));
    const blocks = new Float64Array(blockCols * blockRows).fill(NaN);
    const values = grid.values;
    for (const row of visibleRows) {
      const rowOffset = row * cols;
      const by = Math.min(blockRows - 1, Math.max(0, Math.floor((ys[row] + cellH / 2) / blockPx)));
      for (const col of visibleCols) {
        const value = values[rowOffset + col];
        if (Number.isNaN(value)) continue;
        const bx = Math.min(blockCols - 1, Math.max(0, Math.floor((xs[col] + cellW / 2) / blockPx)));
        const at = by * blockCols + bx;
        const current = blocks[at];
        if (Number.isNaN(current) || value > current) blocks[at] = value;
      }
    }
    this.gridBlocks = blocks;
    this.gridBlockCols = blockCols;
    this.gridBlockRows = blockRows;
  }

  private virtualCellRect(index: number): Rect | null {
    const grid = this.series.grid;
    const coord = this.coord;
    if (!coord || !grid) return null;
    this.syncGrid();
    const cols = grid.xCategories.length;
    const col = cols > 0 ? index % cols : 0;
    const row = cols > 0 ? (index - col) / cols : 0;
    const x = this.gridX[col];
    const y = this.gridY[row];
    if (!isFinite(x) || !isFinite(y)) return null;
    return { x, y, width: Math.max(1, this.gridCellW), height: Math.max(1, this.gridCellH) };
  }

  /** 单元格中心（与普通热力图的像素语义一致）。 */
  protected virtualPixelAt(index: number): [number, number] | null {
    const rect = this.virtualCellRect(index);
    if (!rect) return null;
    return [rect.x + rect.width / 2, rect.y + rect.height / 2];
  }

  /**
   * 命中：**O(1)**。类目轴反查类目 → 矩阵下标 → 取值。
   *
   * 普通热力图是「逐格比矩形」（100 万格就是 100 万次循环 + 每格一次比例尺查表），
   * 矩阵存下来之后这件事退化成一次查表 + 一次下标运算。
   */
  private hitTestGrid(localX: number, localY: number): number {
    const coord = this.coord;
    const grid = this.series.grid;
    if (!coord || !grid) return -1;
    const { width, height } = this.state;
    if (localX < 0 || localY < 0 || localX > width || localY > height) return -1;
    const col = grid.xIndex.get(String(coord.xScale.invert(localX)));
    const row = grid.yIndex.get(String(coord.yScale.invert(localY)));
    if (col === undefined || row === undefined) return -1;
    const index = row * grid.xCategories.length + col;
    // 空格不命中（普通热力图里它根本没有对应的数据点）
    return Number.isNaN(grid.values[index]) ? -1 : index;
  }

  /** 列存热力图的「最近列」：axis 触发器的提示器要一个代表点（该列第一个有值的格子）。 */
  public nearestIndexAtX(localX: number): number {
    const grid = this.series.grid;
    const coord = this.coord;
    if (!grid || !coord) return super.nearestIndexAtX(localX);
    const scale: any = coord.xScale;
    const windowIndex = typeof scale.nearestIndex === 'function' ? scale.nearestIndex(localX) : -1;
    if (windowIndex < 0) return -1;
    const col = grid.xIndex.get(String(coord.xScale.domain[windowIndex]));
    if (col === undefined) return -1;
    const cols = grid.xCategories.length;
    for (let row = 0; row < grid.yCategories.length; row++) {
      const index = row * cols + col;
      if (!Number.isNaN(grid.values[index])) return index;
    }
    return -1;
  }

  /**
   * 列存热力图的绘制：窗口裁剪 + 亚像素聚合。
   *
   * 逐格路径（可见格 ≤ 2 万）：与普通热力图逐格绘制同语义，只是格子位置与值来自矩阵；
   * 聚合路径：按屏幕像素块绘制，块内取最大值（热点优先），块数有上限。
   * 入场动画不做逐格错峰（那需要 n 长的进度数组，正是要省掉的东西）。
   */
  private renderVirtual(): void {
    const coord = this.coord;
    const grid = this.series.grid;
    if (!coord || !grid) return;
    this.syncGrid();
    const ctx = this.ctx;
    const [min, max] = this.valueRange();
    const { from, to } = this.heatColors();
    const ratioAt = (value: number): number => {
      const t = max - min ? (value - min) / (max - min) : 0;
      return Math.max(0, Math.min(1, t));
    };
    const cols = grid.xCategories.length;
    const values = grid.values;
    const stepX = Math.max(1, this.gridCellW);
    const stepY = Math.max(1, this.gridCellH);
    this.beginDraw();
    if (this.gridBlockPx === 0) {
      for (const row of this.gridVisibleRows) {
        const y = this.gridY[row];
        const rowOffset = row * cols;
        for (const col of this.gridVisibleCols) {
          const value = values[rowOffset + col];
          if (Number.isNaN(value)) continue;
          ctx.fillStyle = mixColors(from, to, ratioAt(value));
          ctx.fillRect(this.gridX[col], y, stepX, stepY);
        }
      }
    } else {
      const size = this.gridBlockPx;
      for (let by = 0; by < this.gridBlockRows; by++) {
        for (let bx = 0; bx < this.gridBlockCols; bx++) {
          const value = this.gridBlocks[by * this.gridBlockCols + bx];
          if (Number.isNaN(value)) continue;
          ctx.fillStyle = mixColors(from, to, ratioAt(value));
          ctx.fillRect(bx * size, by * size, size, size);
        }
      }
    }
    if (this.hoverIndex !== null) {
      const rect = this.cellRectAt(this.hoverIndex);
      if (rect) this.drawHoverOverlay(this.hoverIndex, rect, { radius: 0 });
    }
    this.endDraw();
  }
}

/** 两个十六进制颜色之间做线性插值。 */
export function mixColors(from: string, to: string, ratio: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return to;
  const r = Math.round(a[0] + (b[0] - a[0]) * ratio);
  const g = Math.round(a[1] + (b[1] - a[1]) * ratio);
  const bl = Math.round(a[2] + (b[2] - a[2]) * ratio);
  return `rgb(${r},${g},${bl})`;
}

function parseHex(color: string): [number, number, number] | null {
  if (typeof color !== 'string') return null;
  let hex = color.trim();
  if (hex.indexOf('#') === 0) {
    hex = hex.slice(1);
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length !== 6) return null;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const match = hex.match(/rgba?\(([^)]+)\)/);
  if (match) {
    const parts = match[1].split(',').map((v) => parseFloat(v));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }
  return null;
}
