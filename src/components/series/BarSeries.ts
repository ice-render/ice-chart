import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';
import type { Rect } from '../../internal';
import { roundRect } from '../Legend';
import { hexToRgba } from './LineSeries';

/**
 * 稠密模式下**每个像素列最多抽几根**（与散点 / 折线的密度抽稀同一条思路）。
 *
 * 为什么需要：柱子细到亚像素之后，一列里塞着几十几百根（1M 根挤 800px），
 * 逐根 `beginPath + roundRect + 渐变 + fill` 实测 **1.7s/帧**（那还只是绘制，
 * 渐变对象本身 180ms、`barRectAt` 167ms）。抽样之后落墨量与像素数同级。
 */
const DENSE_SAMPLES_PER_PIXEL = 8;
/** 每像素列超过这么多根就走稠密模式（再密下去 1px 的柱子已经完全叠在一起了）。 */
const DENSE_BARS_PER_PIXEL = 2;

/** 柱状图（支持分组与堆叠）。 */
export class BarSeries extends SeriesBase {
  public seriesType: SeriesType = 'bar';
  protected clipToBox = true;
  private barCacheKey = '';
  /** 稠密模式的聚合缓冲（按组件复用，不每帧分配）：每列一个 [base, top] 区间。 */
  private denseLow = new Float64Array(0);
  private denseHigh = new Float64Array(0);
  private denseSeen = new Uint8Array(0);
  private denseLimit = 0;

  /** 横向柱状图：类目在 y 轴上（排行榜最常见的形式）。 */
  private isHorizontal(): boolean {
    const coord = this.coord;
    return !!coord && coord.yScale.isBand() && !coord.xScale.isBand();
  }

  /**
   * 像素缓存 = 每根柱子的中心。
   * 基类按「xValue → x 比例尺」映射，横向图上 xValue 是类目、x 轴是数值，映射不出坐标；
   * 柱子本来就是矩形，用矩形中心作为「数据点的位置」才是对的（高亮、提示框锚点都受益）。
   */
  protected rebuildPixels(): void {
    const coord = this.coord;
    const n = this.series.pointCount;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const key = this.buildSeriesKey([n, coord.plot.width, coord.plot.height, this.isHorizontal() ? 'h' : 'v', String(coord.yScale.domain.join(','))]);
    if (key === this.barCacheKey && this.pixels.length === n * 2) return;
    this.barCacheKey = key;
    this.computeEffective();
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const rect = this.barRectAt(i);
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

  /** 单根柱子的像素矩形（组件本地坐标）。 */
  public barRectAt(index: number): Rect | null {
    const coord = this.coord;
    // 热路径（`rebuildPixels` 每根都要调）走**标量访问器**：`pointAt` 会为每根合成一个
    // `DataPoint` 对象，100 万根就是 100 万个短命对象（实测 rebuildPixels 704ms/3s）。
    const xValue = this.series.xValueAt(index);
    if (!coord || xValue === undefined) return null;
    // 纯几何函数：不触发 rebuildPixels（否则 rebuildPixels → barRectAt 会递归）
    if (this.effective.length !== this.series.pointCount * 2) this.computeEffective();
    const top = this.effective[index * 2 + 1];
    const base = this.effective[index * 2];
    if (!isFinite(top)) return null;
    if (this.isHorizontal()) {
      // 横向：类目在 y 轴（band），数值在 x 轴（value）
      const bandStart = coord.yScale.bandStart(xValue);
      if (!isFinite(bandStart)) return null;
      const bandWidth = coord.yScale.bandwidth() || coord.yScale.step() * 0.6;
      const slotCount = Math.max(1, this.barSlot.count);
      const slotWidth = bandWidth / slotCount;
      const barWidth = this.resolveBarWidth(bandWidth, slotWidth);
      const direction = coord.yScale.range[1] >= coord.yScale.range[0] ? 1 : -1;
      // 槽位偏移必须跟随 range 方向：y 轴的 range 是 [height, 0]（向下为负），
      // 直接加偏移会把最下方那根柱子顶出绘图区底边（实测会越过坐标轴）。
      const slotOffset = slotWidth * this.barSlot.index + (slotWidth - barWidth) / 2;
      const near = bandStart + direction * slotOffset;
      const y = direction > 0 ? near : near - barWidth;
      const x0 = coord.xScale.map(base);
      const x1 = coord.xScale.map(top);
      if (!isFinite(x0) || !isFinite(x1)) return null;
      return { x: Math.min(x0, x1), y, width: Math.abs(x1 - x0), height: barWidth };
    }
    // 必须按「类目值」定位，不能传数据下标：类目轴缩放后可见窗口是类目的一个子集，
    // 用下标会被当成可见窗口内的位置，把窗口外的柱子画到错误的地方（曾因此把高亮框画到右轴上）。
    const bandStart = coord.xScale.bandStart(xValue);
    if (!isFinite(bandStart)) return null;
    const bandWidth = coord.xScale.bandwidth() || coord.xScale.step() * 0.6;
    const slotCount = Math.max(1, this.barSlot.count);
    const slotWidth = bandWidth / slotCount;
    const barWidth = this.resolveBarWidth(bandWidth, slotWidth);
    const x = bandStart + slotWidth * this.barSlot.index + (slotWidth - barWidth) / 2;
    const y0 = coord.yScale.map(base);
    const y1 = coord.yScale.map(top);
    if (!isFinite(y0) || !isFinite(y1)) return null;
    return { x, y: Math.min(y0, y1), width: barWidth, height: Math.abs(y1 - y0) };
  }

  private resolveBarWidth(bandWidth: number, slotWidth: number): number {
    const option = this.series.option;
    const raw = Number(option.barWidth);
    if (!isFinite(raw) || raw <= 0) {
      return Math.max(1, slotWidth * (1 - (isFinite(Number(option.barGap)) ? Number(option.barGap) : 0.2)));
    }
    // 0~1 视为 band 占比，>1 视为设备像素
    return raw <= 1 ? Math.max(1, bandWidth * raw) : Math.max(1, raw * this.unit());
  }

  /**
   * 单根柱子的颜色（瀑布图按增/减/合计覆写）。
   *
   * 支持**逐项配色**：数据项写成 `{ value, color }` 就按项取色 ——
   * 「红涨绿跌」「告警分级」「正负值分色」这类大屏常见需求都靠它，
   * 以前只有系列级颜色，只能靠拆成多个系列去凑（还会把柱子排成一组一组的）。
   */
  protected barColorAt(index: number): string {
    const point = this.series.pointAt(index);
    const raw: any = point && (point as any).raw;
    const own = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.color : undefined;
    return own || this.pointColor(index);
  }

  /**
   * 悬停时实际绘制的矩形：沿柱子的「值方向」外扩一点点，锚点始终在基线，
   * 所以柱子只会变长，不会整体平移（水平柱同理，往值增大的方向伸长）。
   * 越出绘图区的部分由引擎裁剪，不会盖到坐标轴。
   *
   * `t` 用来取「动画到某个进度时」的矩形：高亮描边层用 `t = 1` 取终态，
   * 这样描边始终贴着柱子的最终轮廓，不会出现「描边画在柱子中间」的接缝。
   */
  public barDrawRectAt(index: number, t?: number): Rect | null {
    const rect = this.barRectAt(index);
    const coord = this.coord;
    if (!rect || !coord) return rect;
    const amount = this.hoverBoost(index, 0.08, t) - 1;
    if (amount <= 0) return rect;
    const base = this.effective[index * 2];
    if (this.isHorizontal()) {
      const grow = rect.width * amount;
      const growsRight = rect.x + rect.width / 2 >= coord.xScale.map(base);
      return growsRight
        ? { x: rect.x, y: rect.y, width: rect.width + grow, height: rect.height }
        : { x: rect.x - grow, y: rect.y, width: rect.width + grow, height: rect.height };
    }
    const grow = rect.height * amount;
    const growsUp = rect.y + rect.height / 2 <= coord.yScale.map(base);
    return growsUp
      ? { x: rect.x, y: rect.y - grow, width: rect.width, height: rect.height + grow }
      : { x: rect.x, y: rect.y, width: rect.width, height: rect.height + grow };
  }

  protected doRender(): void {
    const coord = this.coord;
    if (!coord) return;
    const radius = Number(this.series.option.barRadius);
    const ctx = this.ctx;
    this.beginDraw();
    // 稠密模式：柱子已经细到亚像素（一列叠着好几根）→ 每像素列画一根聚合矩形
    if (this.shouldDrawDense(coord)) {
      // 稠密模式**不建每根一个的像素缓存**（100 万根 ≈ 5.6ms/帧，而绘制用不到它 ——
      // 悬停锚点走 `pixelAt` → 虚拟系列的按需分支，命中走下面的稠密分支）
      this.drawDense(coord);
      this.endDraw();
      return;
    }
    this.rebuildPixels();
    for (let i = 0; i < this.series.pointCount; i++) {
      const rect = this.barDrawRectAt(i);
      if (!rect || rect.height <= 0) continue;
      const color = this.barColorAt(i);
      const drawRect = rect;
      ctx.beginPath();
      roundRect(ctx, drawRect.x, drawRect.y, drawRect.width, drawRect.height, isFinite(radius) ? radius : 0);
      /**
       * 渐变只在柱子**看得出来**的时候建：每根柱子 new 一个 CanvasGradient（+2 个色停）
       * 在几千根时无所谓，到了十万根量级就是纯浪费 —— 那时柱高常常只有几像素。
       * 阈值定在「柱高 ≥ 3 设备像素」：再矮的柱子上渐变与纯色肉眼无差。
       */
      const gradientWorthy = drawRect.height >= 3 * this.unit();
      if (gradientWorthy && ctx.createLinearGradient) {
        // 渐变方向跟着柱子的长度方向走
        const gradient = this.isHorizontal()
          ? ctx.createLinearGradient(drawRect.x, 0, drawRect.x + drawRect.width, 0)
          : ctx.createLinearGradient(0, drawRect.y, 0, drawRect.y + drawRect.height);
        gradient.addColorStop(0, hexToRgba(color, 0.95));
        gradient.addColorStop(1, hexToRgba(color, 0.7));
        ctx.fillStyle = gradient;
      } else {
        ctx.fillStyle = color;
      }
      ctx.fill();
    }
    this.endDraw();
  }

  /** 要不要走稠密模式：类目轴 + 一屏柱子数远超像素列数（亚像素）。 */
  private shouldDrawDense(coord: NonNullable<BarSeries['coord']>): boolean {
    const n = this.series.pointCount;
    const width = Math.max(1, coord.plot.width);
    // 只有类目轴能按「下标比例」分列；数值轴上的柱子位置由值决定，抽样会改变摆放
    if (!coord.xScale.isBand()) return false;
    return n / width > DENSE_BARS_PER_PIXEL;
  }

  /**
   * 稠密模式的绘制：**每个像素列一根聚合矩形**，画的是该列所有柱子的并集
   * （`[min(base, 最低值), max(base, 最高值)]`），颜色取该列最后一根的取色规则。
   *
   * 两条纪律与散点 / 折线的密度抽稀一致：
   * 1. **列内均匀抽 8 个样本**（`DENSE_SAMPLES_PER_PIXEL`）—— 一列几千根时逐根扫是
   *    白白烧时间；密度没到「每列 8 根」时 `stride = 1`，与逐根绘制**逐像素一致**；
   * 2. **命中与提示框不受影响**：`hitTestIndex` 仍然给出真实的柱子下标（见那里的稠密分支）。
   */
  private drawDense(coord: NonNullable<BarSeries['coord']>): void {
    const n = this.series.pointCount;
    const plot = coord.plot;
    // 稠密模式跳过了 `rebuildPixels`（那会物化每根一个的像素点），所以 effective 自己保证
    if (this.effective.length !== n * 2) this.computeEffective();
    const limit = Math.max(1, Math.round(plot.width));
    if (this.denseLimit !== limit) {
      this.denseLow = new Float64Array(limit);
      this.denseHigh = new Float64Array(limit);
      this.denseSeen = new Uint8Array(limit);
      this.denseLimit = limit;
    }
    const low = this.denseLow;
    const high = this.denseHigh;
    const seen = this.denseSeen;
    seen.fill(0);
    const perPixel = n / limit;
    const stride = perPixel > DENSE_SAMPLES_PER_PIXEL ? Math.max(1, Math.floor(perPixel / DENSE_SAMPLES_PER_PIXEL)) : 1;
    const scale = limit / n;
    const ctx = this.ctx;
    for (let i = 0; i < n; i += stride) {
      const top = this.effective[i * 2 + 1];
      const base = this.effective[i * 2];
      if (!isFinite(top) || !isFinite(base)) continue;
      const column = Math.max(0, Math.min(limit - 1, Math.floor(i * scale)));
      const lo = Math.min(base, top);
      const hi = Math.max(base, top);
      if (!seen[column]) {
        seen[column] = 1;
        low[column] = lo;
        high[column] = hi;
        continue;
      }
      if (lo < low[column]) low[column] = lo;
      if (hi > high[column]) high[column] = hi;
    }
    const step = plot.width / limit;
    const barWidth = Math.max(1, step);
    for (let column = 0; column < limit; column++) {
      if (!seen[column]) continue;
      // 颜色取该列**最后一根**的取色规则（与逐根绘制同一口径）
      const last = Math.min(n - 1, Math.max(0, Math.ceil((column + 1) / scale) - 1));
      const color = this.barColorAt(last);
      // 组件本地坐标（比例尺的 range 已经从 0 起算，见 buildScales）
      const top = coord.yScale.map(high[column]);
      const bottom = coord.yScale.map(low[column]);
      if (!isFinite(top) || !isFinite(bottom)) continue;
      ctx.fillStyle = color;
      ctx.fillRect(column * step, Math.min(top, bottom), barWidth, Math.max(1, Math.abs(bottom - top)));
    }
  }

  /**
   * 命中：**稠密模式下不逐根扫**（1M 根时每次 mousemove 扫 1M 个矩形 = 掉帧）。
   *
   * 类目轴的带宽等距，柱子又是按类目排的 —— 所以「指针在哪一根」可以直接由 x 的比例
   * 反推出下标，再验一根的矩形就够。非稠密（或数值轴）仍然逐根扫，保证语义不变。
   */
  public hitTestIndex(localX: number, localY: number): number {
    const n = this.series.pointCount;
    const coord = this.coord;
    if (coord && n && this.shouldDrawDense(coord)) {
      const step = coord.plot.width / n;
      if (!(step > 0)) return -1;
      const guess = Math.round(localX / step - 0.5);
      // 邻域各扫 2 根：柱宽可能大于步距（barWidth 显式给大时），也可能因取整落偏
      for (let i = Math.max(0, guess - 2); i <= Math.min(n - 1, guess + 2); i++) {
        const rect = this.barRectAt(i);
        if (!rect) continue;
        if (localX >= rect.x && localX <= rect.x + rect.width && localY >= rect.y && localY <= rect.y + rect.height) return i;
      }
      return -1;
    }
    this.rebuildPixels();
    for (let i = 0; i < n; i++) {
      const rect = this.barRectAt(i);
      if (!rect) continue;
      if (localX >= rect.x && localX <= rect.x + rect.width && localY >= rect.y && localY <= rect.y + rect.height) {
        return i;
      }
    }
    return -1;
  }
}
