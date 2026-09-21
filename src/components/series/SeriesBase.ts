import { ChartComponent } from '../ChartComponent';
import { roundRect } from '../Legend';
import type { ChartTheme, SeriesType } from '../../types';
import type { DataPoint, InternalSeries, Rect } from '../../internal';
import type { Scale } from '../../scale';
import { shouldAnimate } from '../../animation/motion';

export interface SeriesCoord {
  plot: Rect;
  canvas: Rect;
  xScale: Scale;
  yScale: Scale;
  /** 该系列绑定的 y 轴下标。 */
  yAxisIndex?: number;
  theme: ChartTheme;
}

export interface BarSlot {
  index: number;
  count: number;
}

/**
 * 系列基类：数据 → 像素的缓存、动画插值、命中判定都收敛在这里。
 *
 * 三件事值得注意：
 *
 * 1. **像素缓存**：数据点的像素坐标只在数据 / 比例尺 / 尺寸变化时重算一次，
 *    render 与命中判定共用同一份缓存 —— 保证「画出来的样子」和「点得到的位置」必然一致。
 *
 * 2. **命中判定进引擎**：`containsLocalPoint` 由子类实现为「按数据语义判定」，
 *    于是 `ice.hitTest()` / 引擎事件派发天然就能分辨「点在折线上」还是「点在空白处」，
 *    不需要在图表外面再写一套坐标反查。
 *
 * 3. **动画走引擎的 AnimationManager**：`state.progress` 由引擎逐帧写入，
 *    本组件按 progress 在「上一份数据的有效值」与「新数据」之间插值。
 */
export abstract class SeriesBase extends ChartComponent {
  public abstract seriesType: SeriesType;
  public series: InternalSeries;
  /** 图表主题（由 Chart 注入，供绘制标签 / 文本使用）。 */
  public chartTheme: ChartTheme | null = null;
  /** 被隐藏的数据项下标（饼图扇区 / 漏斗阶段）。 */
  public hiddenSlices: number[] = [];
  public coord: SeriesCoord | null = null;
  /** 分组柱形的位置（由 Chart 计算）。 */
  public barSlot: BarSlot = { index: 0, count: 1 };

  /** 每个点的像素坐标，2n 长度，[x0,y0,x1,y1,...]；缺失点为 NaN。 */
  protected pixels: Float64Array = new Float64Array(0);
  /** 每个点的有效数据值 [base, top]，用于动画插值与柱形绘制。 */
  protected effective: Float64Array = new Float64Array(0);
  /** 上一帧的有效值，作为动画起点。 */
  protected fromEffective: Float64Array | null = null;
  /** 实际参与绘制的点下标（降采样后可能少于总点数）；null 表示全部点。 */
  protected renderIndices: number[] | null = null;
  /** 像素 x 是否单调递增（降采样与二分查找的前提）。 */
  protected xMonotonic = true;
  /** 第三维（气泡尺寸）的取值范围，映射到 symbolSizeRange。 */
  protected sizeExtent: [number, number] = [0, 1];
  /** 每个数据项各自的动画进度（错峰入场用），0~1。 */
  protected itemProgress: Float64Array = new Float64Array(0);
  /** 错峰比例：0 = 所有项同时动画。 */
  protected stagger = 0;
  /** 当前动画阶段：enter 可以「画出来」，update 只能「动起来」。 */
  protected animationKind: 'enter' | 'update' = 'enter';
  /** 当前悬停的数据项（0 表示没有）。 */
  public hoverIndex: number | null = null;
  private cacheKey = '';
  /** 散点等「每个点都必须画」的系列不参与降采样。 */
  protected supportsSampling = true;
  /**
   * 是否把绘制裁剪到组件盒（= 本场景的绘图区）。
   *
   * 直角坐标系列必须开：缩放后落在窗口外的数据点会被映射到很远的位置，
   * 不裁剪就会一路画到 y 轴标签、图例甚至画布外面去（用户实测反馈的问题）。
   * 折线要的是「被绘图区边缘裁掉」，而不是「在边界处断开」，所以只能靠 clip，不能靠过滤点。
   */
  protected clipToBox = false;
  private localBoxScratch: number[] = [0, 0, 0, 0];

  constructor(series: InternalSeries, props: { left: number; top: number; width: number; height: number; zIndex?: number }) {
    super({ interactive: true, ...props });
    this.series = series;
  }

  /** 组件本地盒向四周外扩，容纳线宽、标记与阴影。 */
  protected __localBox(): number[] {
    const pad = this.paintPad();
    const box = this.localBoxScratch;
    box[0] = -pad;
    box[1] = -pad;
    box[2] = (this.state.width || 0) + pad;
    box[3] = (this.state.height || 0) + pad;
    return box;
  }

  protected paintPad(): number {
    const option = this.series.option;
    const symbol = option.showSymbol === false ? 0 : this.maxSymbolSize() / 2 + 4;
    return Math.max(symbol, (option.lineWidth || 2) + 4, 6);
  }

  /**
   * 数据点尺寸：三种来源按优先级解析。
   * 1. `symbolSize` 是函数 → 交给调用方决定；
   * 2. 数据项带第三维（气泡图的 `[x, y, size]`）→ 按 series 内的取值范围映射到 `symbolSizeRange`；
   * 3. 固定数值 `symbolSize`。
   */
  public symbolSizeAt(index: number): number {
    const option = this.series.option;
    const size = option.symbolSize;
    if (typeof size === 'function') {
      const value = this.series.yValueAt(index);
      let out = NaN;
      try {
        // 虚拟（列存）系列没有原始数据项 → data 为 undefined（契约见 SeriesOption.virtual）
        const point = this.series.virtual ? null : this.series.pointAt(index);
        out = Number(size(value, { dataIndex: index, data: point ? point.raw : undefined, seriesName: this.series.name }));
      } catch (err) {
        out = NaN;
      }
      return isFinite(out) && out > 0 ? out : 8;
    }
    const own = this.series.sizeAt(index);
    if (typeof own === 'number' && isFinite(own)) {
      const range = Array.isArray(option.symbolSizeRange) ? option.symbolSizeRange : [8, 40];
      const [min, max] = this.sizeExtent;
      const t = max > min ? (own - min) / (max - min) : 0.5;
      return range[0] + (range[1] - range[0]) * Math.max(0, Math.min(1, t));
    }
    const numeric = Number(size);
    return isFinite(numeric) && numeric > 0 ? numeric : 8;
  }

  /** 本系列的最大标记尺寸（脏矩形留白与命中容差要用）。 */
  protected maxSymbolSize(): number {
    const option = this.series.option;
    if (typeof option.symbolSize === 'function' || this.hasPointSize()) {
      const range = Array.isArray(option.symbolSizeRange) ? option.symbolSizeRange : [8, 40];
      return Math.max(8, Number(range[1]) || 40);
    }
    const numeric = Number(option.symbolSize);
    return isFinite(numeric) && numeric > 0 ? numeric : 8;
  }

  /** 数据里是否带第三维（气泡图尺寸）—— 逐点取值，列存系列也适用。 */
  protected hasPointSize(): boolean {
    const columns = this.series.columns;
    if (this.series.virtual) return !!(columns && columns.sizeExtent);
    const series = this.series;
    for (let i = 0, n = series.pointCount; i < n; i++) {
      if (typeof series.sizeAt(i) === 'number') return true;
    }
    return false;
  }

  public setCoord(coord: SeriesCoord): this {
    this.coord = coord;
    this.cacheKey = '';
    if (this.series.virtual) this.syncVirtualMeta();
    return this.markDirty();
  }

  /** 设置被隐藏的数据项（图表层在每次同步时写入）。 */
  public setHiddenSlices(indexes: number[]): this {
    this.hiddenSlices = indexes || [];
    return this.markDirty();
  }

  /** 图表层在每次播放动画前注入该阶段的配置（错峰比例会存下来供逐项计算）。 */
  public setAnimationStage(stage: { stagger?: number; kind?: 'enter' | 'update' } | null | undefined): this {
    this.stagger = stage && isFinite(Number(stage.stagger)) ? Math.max(0, Math.min(0.95, Number(stage.stagger))) : 0;
    this.animationKind = stage && stage.kind === 'update' ? 'update' : 'enter';
    return this;
  }

  /** 是否正在播「入场」动画（用于「画出来」这类只在入场成立的动效）。 */
  protected isEntering(): boolean {
    return this.animationKind === 'enter' && this.progress() < 1;
  }

  /** 单个数据项的动画进度：把整体进度按「波浪」拆到每一项。 */
  protected progressFor(index: number, total: number): number {
    const t = this.progress();
    if (t >= 1) return 1;
    if (this.stagger <= 0 || total <= 1) return t;
    // 波浪：每项持续 span，起始时间依次后移；最后一项恰好在 t=1 时结束
    const span = 1 / (1 + this.stagger);
    const delay = (index / (total - 1)) * this.stagger * span;
    const local = (t - delay) / span;
    return local <= 0 ? 0 : local >= 1 ? 1 : local;
  }

  /** 每项进度的缓存（数据量变化时重建）。 */
  protected computeItemProgress(): void {
    const n = this.series.pointCount;
    if (this.itemProgress.length !== n) this.itemProgress = new Float64Array(n);
    for (let i = 0; i < n; i++) this.itemProgress[i] = this.progressFor(i, n);
  }

  /** 当前动画状态（测试与调试用；不参与序列化）。 */
  public getAnimationState(): { progress: number; kind: 'enter' | 'update'; stagger: number; itemProgress: number[] } {
    this.computeItemProgress();
    return {
      progress: this.progress(),
      kind: this.animationKind,
      stagger: this.stagger,
      itemProgress: Array.from(this.itemProgress),
    };
  }

  /**
   * 设置/清除悬停项，并用引擎动画把 `highlightT` 从 0 推到 1（或反向）。
   *
   * 反馈动画由组件自己启动：它持有 `ice.animationManager`，不需要图表层代劳，
   * 这样「悬停哪个图元」这件事就完全收敛在系列内部。
   */
  public setHoverIndex(index: number | null): void {
    const next = index === undefined ? null : index;
    if (this.hoverIndex === next) return;
    const hadHover = this.hoverIndex !== null;
    this.hoverIndex = next;
    const from = this.highlightT();
    const to = next === null ? 0 : 1;
    if (!shouldAnimate()) {
      this.setState({ highlightT: to });
      this.markDirty();
      return;
    }
    // 从当前值出发，避免快速划过时来回跳变
    // props.animations 默认是引擎共享的冻结对象：必须复制后再整体替换
    const animations: any = { ...((this.props as any).animations || {}) };
    animations.highlightT = {
      from,
      to,
      duration: next === null ? 180 : 260,
      easing: next === null ? 'easeOutCubic' : 'springSnappy',
      startTime: undefined,
      finished: false,
    };
    (this.props as any).animations = animations;
    if (this.ice && this.ice.animationManager) this.ice.animationManager.add(this);
    if (!hadHover && next !== null) this.markDirty();
  }

  /** 悬停反馈的进度（0~1）。 */
  public highlightT(): number {
    const value = Number(this.state.highlightT);
    return isFinite(value) ? Math.max(0, Math.min(1.2, value)) : 0;
  }

  /** 某个数据项当前的高亮强度：只有被悬停的那一项 > 0。 */
  protected hoverBoost(index: number, amount = 0.12, t?: number): number {
    if (this.hoverIndex !== index) return 1;
    return 1 + amount * (t === undefined ? this.highlightT() : Math.max(0, Math.min(1, t)));
  }

  /** 悬停叠加层的强度（0~1）：只有被悬停的那一项 > 0。 */
  protected hoverAlpha(index: number): number {
    if (this.hoverIndex !== index) return 0;
    return Math.max(0, Math.min(1, this.highlightT()));
  }

  /**
   * 在被悬停的矩形上叠一层「提亮 + 描边」。
   *
   * 刻意**只叠加、不改几何**：像热力图 / 树图这种相邻图元紧挨着的类型，
   * 改宽高会让命中区域与渲染区域分叉（指针停在边缘会来回抖），
   * 叠加描边既能表达强调，又完全不动命中判定。
   */
  protected drawHoverOverlay(
    index: number,
    rect: Rect,
    options: { radius?: number; fill?: string; stroke?: string; lineWidth?: number } = {}
  ): void {
    const alpha = this.hoverAlpha(index);
    if (alpha <= 0.01 || rect.width <= 0 || rect.height <= 0) return;
    const ctx = this.ctx;
    const unit = this.unit();
    const radius = Number(options.radius) || 0;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (options.fill !== 'none') {
      roundRect(ctx, rect.x, rect.y, rect.width, rect.height, radius);
      ctx.fillStyle = options.fill || 'rgba(255,255,255,0.16)';
      ctx.fill();
    }
    roundRect(ctx, rect.x, rect.y, rect.width, rect.height, radius);
    ctx.strokeStyle = options.stroke || 'rgba(255,255,255,0.95)';
    ctx.lineWidth = Math.max(unit, (options.lineWidth || 2) * unit);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 派生几何的缓存键。
   *
   * **必须**把参与动画的 state 字段一起放进来（progress / 阶段 / 错峰），
   * 否则动画期间键不变、缓存命中，几何会冻结在动画开始的那一帧。
   * 子类覆写 `rebuildPixels` 时用自己的几何参数组键，请一律走这个方法。
   */
  protected buildSeriesKey(parts: Array<any>): string {
    return [...parts, this.coordKey(), this.progress(), this.animationKind, this.stagger].join('|');
  }

  /**
   * 坐标系指纹：绘图区矩形 + 各比例尺的数据域。
   *
   * 子类自己拼键时最容易漏的就是数据域 —— 表面看不出来，实际后果是
   * **像素缓存不失效**：缩放 / 平移 / 数据域过渡之后 `pixels` 还是旧位置，
   * 「看得见的点」与「点得到的点」就此分叉（悬停高亮画在别处、命中判空）。
   * 只在键里放域的**端点 + 长度**，因为这个函数动画期间每帧都会被调用，不能全量 join。
   */
  private coordKey(): string {
    const coord: any = this.coord;
    if (!coord) return '-';
    const parts: string[] = [];
    if (coord.plot) parts.push(`p${coord.plot.x},${coord.plot.y},${coord.plot.width},${coord.plot.height}`);
    for (const name of ['xScale', 'yScale']) {
      const scale = coord[name];
      const domain = scale && scale.domain;
      if (!domain || !domain.length) continue;
      parts.push(`${name}[${domain.length}]:${String(domain[0])}~${String(domain[domain.length - 1])}`);
    }
    return parts.join(';');
  }

  /**
   * 替换数据。`animate` 为真时，把当前有效值记为动画起点（首次进入时从 0 开始），
   * 由 Chart 触发引擎动画把 state.progress 从 0 推到 1。
   */
  public updateSeries(series: InternalSeries, animate: boolean, preserveAnimation = false): this {
    // preserveAnimation：只换数据引用、**不动**动画起点。
    // 坐标轴数据域过渡期间每帧都会走一次同步，如果这里清掉 fromEffective，值插值就断了。
    if (!preserveAnimation) {
      this.fromEffective =
        animate && this.effective.length === series.pointCount * 2 ? new Float64Array(this.effective) : null;
    }
    this.series = series;
    this.cacheKey = '';
    if (series.virtual) this.syncVirtualMeta();
    return this.markDirty();
  }

  /** 与当前绘制一致的像素位置；缺失点返回 null。 */
  public pixelAt(index: number): [number, number] | null {
    if (this.series.virtual) return this.virtualPixelAt(index);
    this.rebuildPixels();
    const x = this.pixels[index * 2];
    const y = this.pixels[index * 2 + 1];
    if (!isFinite(x) || !isFinite(y)) return null;
    return [x, y];
  }

  /** 数据点的像素矩形（柱形用）。 */
  public barRectAt(_index: number): Rect | null {
    return null;
  }

  /** 命中判定：返回数据下标，-1 表示未命中。入参是组件本地像素坐标。 */
  public abstract hitTestIndex(localX: number, localY: number): number;

  protected containsLocalPoint(localX: number, localY: number): boolean {
    return this.hitTestIndex(localX, localY) >= 0;
  }

  protected progress(): number {
    const p = Number(this.state.progress);
    return isFinite(p) ? Math.max(0, Math.min(1, p)) : 1;
  }

  /** 计算每个点的有效数据值（含动画插值）。 */
  protected computeEffective(): void {
    const series = this.series;
    const n = series.pointCount;
    if (this.effective.length !== n * 2) {
      this.effective = new Float64Array(n * 2);
      this.fromEffective = null;
    }
    this.computeItemProgress();
    const t = this.progress();
    for (let i = 0; i < n; i++) {
      // 每个数据项用**自己的**进度：错峰入场时就是「依次长出来」
      const ti = this.itemProgress[i];
      /**
       * 断点（`y` 为 `null`）= **没有数据**，像素必须是 NaN。
       *
       * 不能拿 `top` 顶上：`null` 的 `top` 是 0，于是断点会被画到 0 的位置
       * ——实测 `data: [10, null, 30]` 的断点像素落在绘图区**下方 91px** 处
       * （画出一条「掉到 0」的假线），而命中与提示框那边是按 `y === null` 判空的，
       * 同一份数据在两处语义分叉。断点一律 NaN，折线绘制再按 NaN 抬笔。
       */
      if (this.series.yValueAt(i) === null) {
        this.effective[i * 2] = NaN;
        this.effective[i * 2 + 1] = NaN;
        continue;
      }
      // 只取标量：列存系列在这里不合成 DataPoint
      const targetTop = series.topAt(i);
      if (targetTop === null || targetTop === undefined) {
        this.effective[i * 2] = NaN;
        this.effective[i * 2 + 1] = NaN;
        continue;
      }
      const rawBase = series.baseAt(i);
      const targetBase = isFinite(rawBase) ? rawBase : 0;
      let fromBase = 0;
      let fromTop = 0;
      if (this.fromEffective) {
        const fb = this.fromEffective[i * 2];
        const ft = this.fromEffective[i * 2 + 1];
        if (isFinite(fb)) fromBase = fb;
        if (isFinite(ft)) fromTop = ft;
      }
      this.effective[i * 2] = ti >= 1 ? targetBase : fromBase + (targetBase - fromBase) * ti;
      this.effective[i * 2 + 1] = ti >= 1 ? targetTop : fromTop + (targetTop - fromTop) * ti;
    }
    if (t >= 1) this.fromEffective = null;
  }

  /** 数据 → 像素（带缓存）。 */
  protected rebuildPixels(force = false): void {
    if (this.series.virtual) {
      // 列存系列不物化像素：只同步元信息（单调性 / 尺寸范围），像素按需现算
      this.syncVirtualMeta();
      return;
    }
    const coord = this.coord;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const key = this.buildCacheKey(coord);
    if (!force && key === this.cacheKey) return;
    /**
     * **纯平移走增量**（虚拟化 Phase 1，2026-09-21）。
     *
     * 平移只改域、不改跨度：线性轴下 `map(v)` 只是整体平移一个像素量，
     * 于是 100 万个点各加一个常数即可 —— 不必再跑 `map()`/`computeEffective()`/
     * `computeSizeExtent()`/`buildRenderIndices()`（实测这正是 1M 散点 472.7ms/帧的来源：
     * 平移每帧都把缓存 key 打失效 → 全量重算）。
     * 只在"x/y 域都还是数值、且 x 跨度与 y 域完全没变"时走这条路；缩放 / 换数据仍然全量重算。
     */
    const xd: any = coord.xScale.domain;
    const yd: any = coord.yScale.domain;
    const incX: any = (this as any).__incrementalXDomain;
    const incY: any = (this as any).__incrementalYDomain;
    const numericPair = (d: any) => Array.isArray(d) && d.length === 2 && typeof d[0] === 'number' && typeof d[1] === 'number' && isFinite(d[0]) && isFinite(d[1]);
    if (
      !force &&
      numericPair(xd) &&
      numericPair(yd) &&
      numericPair(incX) &&
      numericPair(incY) &&
      xd[1] - xd[0] === incX[1] - incX[0] &&
      yd[0] === incY[0] &&
      yd[1] === incY[1] &&
      this.pixels.length === this.series.pointCount * 2
    ) {
      const dx = ((incX[0] - xd[0]) / (xd[1] - xd[0])) * coord.plot.width;
      for (let i = 0; i < this.pixels.length; i += 2) this.pixels[i] += dx;
      (this as any).__incrementalXDomain = [xd[0], xd[1]];
      this.cacheKey = key;
      return;
    }
    this.computeEffective();
    const series = this.series;
    const n = series.pointCount;
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    const { xScale, yScale } = coord;
    let monotonic = true;
    let prevX = -Infinity;
    for (let i = 0; i < n; i++) {
      const px = xScale.map(series.xValueAt(i));
      const value = this.effective[i * 2 + 1];
      const py = isFinite(value) ? yScale.map(value) : NaN;
      this.pixels[i * 2] = px;
      this.pixels[i * 2 + 1] = py;
      if (isFinite(px)) {
        if (px < prevX) monotonic = false;
        prevX = px;
      }
    }
    this.xMonotonic = monotonic;
    this.sizeExtent = computeSizeExtent(series);
    this.renderIndices = this.buildRenderIndices(n, coord.plot.width);
    (this as any).__incrementalXDomain = Array.isArray(xd) && xd.length === 2 ? [xd[0], xd[1]] : null;
    (this as any).__incrementalYDomain = Array.isArray(yd) && yd.length === 2 ? [yd[0], yd[1]] : null;
    this.cacheKey = key;
  }

  // ------------------------------------------------- 虚拟（列存）系列的共用内核

  /**
   * 列存系列的元信息同步：像素缓存留空，单调性与尺寸范围取自数据列。
   *
   * 为什么虚拟系列不建像素缓存：100 万点的 `pixels` + `effective` + `itemProgress`
   * 就是 40MB，省下来的内存会被缓存原样吃回去（详见 AGENTS.md 铁律 2 的例外说明）。
   */
  protected syncVirtualMeta(): void {
    if (this.pixels.length) this.pixels = new Float64Array(0);
    const columns = this.series.columns;
    this.xMonotonic = !!(columns && columns.xMonotonic);
    this.renderIndices = null;
    if (columns && columns.sizeExtent) this.sizeExtent = columns.sizeExtent;
  }

  /** 列上二分：第一个 x（数据值）≥ target 的下标。 */
  protected virtualLowerBound(target: number): number {
    const series = this.series;
    let lo = 0;
    let hi = series.pointCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Number(series.xValueAt(mid)) < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** 列上二分：第一个 x（数据值）> target 的下标。 */
  protected virtualUpperBound(target: number): number {
    const series = this.series;
    let lo = 0;
    let hi = series.pointCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Number(series.xValueAt(mid)) <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * 可见窗口（下标区间，含两端各留一格）。
   *
   * 先把握手用的像素余量经 `invert` 换算成数据值，再在单调的 x 列上二分 ——
   * 于是「窗口外不画」这件事在 100 万点上仍然是 O(log n)，不需要全量像素缓存。
   */
  protected virtualVisibleWindow(pad: number): { i0: number; i1: number } {
    const coord = this.coord;
    const n = this.series.pointCount;
    if (!coord || !n) return { i0: 0, i1: -1 };
    if (!this.xMonotonic) return { i0: 0, i1: n - 1 };
    const edgeA = coord.xScale.invert(-pad);
    const edgeB = coord.xScale.invert(coord.plot.width + pad);
    const i0 = this.virtualLowerBound(Math.min(edgeA, edgeB));
    const i1 = this.virtualUpperBound(Math.max(edgeA, edgeB));
    return { i0: Math.max(0, i0 - 1), i1: Math.min(n - 1, i1) };
  }

  /** 列存系列的点像素：按需现算，不落缓存。 */
  protected virtualPixelAt(index: number): [number, number] | null {
    const coord = this.coord;
    const series = this.series;
    if (!coord || index < 0 || index >= series.pointCount) return null;
    const value = series.yValueAt(index);
    if (value === null) return null;
    const x = coord.xScale.map(series.xValueAt(index));
    const y = coord.yScale.map(value);
    if (!isFinite(x) || !isFinite(y)) return null;
    return [x, y];
  }

  /**
   * 列存系列的最近邻：x 单调时在列上二分，再与左右邻居比一次距离。
   * 非单调（罕见）退化为线性扫描，语义与像素缓存版的 `nearestIndexAtX` 一致。
   */
  protected virtualNearestIndexAtX(localX: number): number {
    const coord = this.coord;
    const series = this.series;
    const n = series.pointCount;
    if (!coord || !n) return -1;
    const pixelX = (i: number): number => coord.xScale.map(series.xValueAt(i));
    if (!this.xMonotonic) {
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < n; i++) {
        const x = pixelX(i);
        if (!isFinite(x)) continue;
        const dist = Math.abs(x - localX);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      return best;
    }
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const x = pixelX(mid);
      if (!isFinite(x) || x < localX) lo = mid + 1;
      else hi = mid;
    }
    let best = -1;
    let bestDist = Infinity;
    for (const i of [lo, lo - 1]) {
      if (i < 0 || i >= n) continue;
      const x = pixelX(i);
      if (!isFinite(x)) continue;
      const dist = Math.abs(x - localX);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  /**
   * 计算实际绘制的点下标。
   *
   * 默认策略：点数超过「绘图区宽度 × 3」时用 LTTB 抽稀 —— 一个像素宽度画 3 个点已经过剩，
   * 继续画只是白白光栅化。首尾点与极值点一定保留，所以看起来仍然「像原曲线」。
   * 命中判定不受影响，它始终读全量像素缓存。
   */
  protected buildRenderIndices(n: number, plotWidth: number): number[] | null {
    if (!this.supportsSampling || !this.xMonotonic) return null;
    const option = this.series.option;
    if (option.sampling === 'none') return null;
    if (!option.sampling && n <= Math.max(2000, plotWidth * 3)) return null;
    const threshold = Math.max(64, Math.min(n, Math.floor(plotWidth * 2)));
    if (n <= threshold + 2) return null;
    return lttbIndices(this.pixels, n, threshold);
  }

  /** 实际参与绘制的点数。 */
  protected renderCount(): number {
    return this.renderIndices ? this.renderIndices.length : this.pixels.length / 2;
  }

  /** 第 k 个参与绘制的点对应的原始下标。 */
  protected renderIndexAt(k: number): number {
    return this.renderIndices ? this.renderIndices[k] : k;
  }

  /**
   * 按 x 像素找最近的数据下标。
   *
   * 单调数据用二分查找（大点数下每次 mousemove 都是 O(n) 会直接掉帧），
   * 非单调数据退化为线性扫描。
   */
  public nearestIndexAtX(localX: number): number {
    this.rebuildPixels();
    if (this.series.virtual) return this.virtualNearestIndexAtX(localX);
    const n = this.pixels.length / 2;
    if (!n) return -1;
    if (!this.xMonotonic) {
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < n; i++) {
        const x = this.pixels[i * 2];
        if (!isFinite(x)) continue;
        const dist = Math.abs(x - localX);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      return best;
    }
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const x = this.pixels[mid * 2];
      if (!isFinite(x) || x < localX) lo = mid + 1;
      else hi = mid;
    }
    // lo 是第一个 >= localX 的点，与邻居比一次即可
    const candidates = [lo, lo - 1].filter((i) => i >= 0 && i < n && isFinite(this.pixels[i * 2]));
    let best = -1;
    let bestDist = Infinity;
    for (const i of candidates) {
      const dist = Math.abs(this.pixels[i * 2] - localX);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  private buildCacheKey(coord: SeriesCoord): string {
    const xd = coord.xScale.domain;
    const yd = coord.yScale.domain;
    return [
      this.series.pointCount,
      this.progress(),
      coord.plot.width,
      coord.plot.height,
      String(xd[0]),
      String(xd[xd.length - 1]),
      String(yd[0]),
      String(yd[1]),
      this.series.pointCount ? String(this.series.xValueAt(0)) : '',
    ].join('|');
  }

  /** 遍历像素点，跳过缺失点形成的断点。 */
  protected eachSegment(fn: (x0: number, y0: number, x1: number, y1: number, i: number) => void): void {
    const n = this.pixels.length / 2;
    for (let i = 0; i < n - 1; i++) {
      const x0 = this.pixels[i * 2];
      const y0 = this.pixels[i * 2 + 1];
      const x1 = this.pixels[(i + 1) * 2];
      const y1 = this.pixels[(i + 1) * 2 + 1];
      if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) continue;
      fn(x0, y0, x1, y1, i);
    }
  }

  protected pointColor(_index: number): string {
    return this.series.option.color || this.series.color;
  }

  protected lineWidthDevice(): number {
    const w = this.series.option.lineWidth;
    return isFinite(w as number) ? (w as number) : 2;
  }

  protected opacity(): number {
    const o = Number(this.series.option.opacity);
    return isFinite(o) ? Math.max(0, Math.min(1, o)) : 1;
  }

  protected beginDraw(): void {
    this.ctx.beginPath();
    this.ctx.save();
    if (this.clipToBox) {
      // 组件盒就是绘图区（系列组件的 left/top/width/height 由 Chart 设成 plot rect）
      this.ctx.beginPath();
      this.ctx.rect(0, 0, this.state.width, this.state.height);
      this.ctx.clip();
    }
    this.ctx.lineJoin = 'round';
    this.ctx.lineCap = 'round';
    this.ctx.globalAlpha = this.opacity();
  }

  protected endDraw(): void {
    this.ctx.restore();
  }

  protected drawSymbol(x: number, y: number, shape: string, size: number, fill: string, stroke: string): void {
    const ctx = this.ctx;
    const unit = this.unit();
    ctx.beginPath();
    if (shape === 'rect') {
      ctx.rect(x - size / 2, y - size / 2, size, size);
    } else {
      ctx.arc(x, y, Math.max(1, size / 2), 0, Math.PI * 2);
    }
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = unit;
      ctx.stroke();
    }
  }

  protected pointByIndex(index: number): DataPoint | null {
    return this.series.pointAt(index) || null;
  }
}

/**
 * LTTB（Largest Triangle Three Buckets）抽稀。
 *
 * 输入是渲染用的像素点集（x/y 交错，含 NaN 断点），返回保留下来的下标数组。
 * 首点与末点一定保留；每个桶内取「与前后桶均值构成三角形面积最大」的点，
 * 因此尖峰不会被抹平 —— 这正是它比等间隔抽样更适合行情/监控曲线的原因。
 */
export function lttbIndices(pixels: Float64Array, n: number, threshold: number): number[] {
  if (threshold >= n || threshold <= 2) {
    const all: number[] = [];
    for (let i = 0; i < n; i++) all.push(i);
    return all;
  }
  const sampled: number[] = [0];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    // 下一个桶的均值（作为三角形的第三个顶点）
    let avgStart = Math.floor((i + 1) * every) + 1;
    let avgEnd = Math.floor((i + 2) * every) + 1;
    if (avgEnd > n) avgEnd = n;
    let avgX = 0;
    let avgY = 0;
    let avgCount = 0;
    for (; avgStart < avgEnd; avgStart++) {
      const y = pixels[avgStart * 2 + 1];
      if (!isFinite(y)) continue;
      avgX += pixels[avgStart * 2];
      avgY += y;
      avgCount++;
    }
    if (!avgCount) {
      avgX = pixels[(n - 1) * 2];
      avgY = pixels[(n - 1) * 2 + 1];
      if (!isFinite(avgY)) {
        avgY = pixels[a * 2 + 1];
        avgX = pixels[a * 2];
      }
    } else {
      avgX /= avgCount;
      avgY /= avgCount;
    }
    const rangeStart = Math.floor(i * every) + 1;
    const rangeEnd = Math.min(Math.floor((i + 1) * every) + 1, n - 1);
    const ax = pixels[a * 2];
    const ay = pixels[a * 2 + 1];
    let maxArea = -1;
    let maxIndex = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const y = pixels[j * 2 + 1];
      if (!isFinite(y)) continue;
      const x = pixels[j * 2];
      const area = Math.abs((ax - avgX) * (y - ay) - (ax - x) * (avgY - ay));
      if (area > maxArea) {
        maxArea = area;
        maxIndex = j;
      }
    }
    sampled.push(maxIndex);
    a = maxIndex;
  }
  sampled.push(n - 1);
  return sampled;
}

/** 数据点第三维的取值范围（气泡尺寸映射用）。 */
export function computeSizeExtent(series: InternalSeries): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0, n = series.pointCount; i < n; i++) {
    const size = series.sizeAt(i);
    if (typeof size !== 'number' || !isFinite(size)) continue;
    if (size < min) min = size;
    if (size > max) max = size;
  }
  if (!isFinite(min)) return [0, 1];
  if (min === max) return [min, min + 1];
  return [min, max];
}
