import { SeriesBase } from './SeriesBase';
import { shouldAnimate } from '../../animation/motion';
import type { Rect } from '../../internal';

/**
 * 「函数曲线」类系列的公共基座（`function` / `parametric`）。
 *
 * 与普通折线的根本区别：**几何不是从数据点来的，而是从表达式算出来的**。
 * 于是有三件事必须由组件自己负责：
 *
 * 1. **采样**：按当前可视区间重新采样（缩放后要看到更多细节），
 *    并在曲率大的地方自适应加点（见 `src/expr/sample.ts`）；
 * 2. **参数扫动**：某个参数随时间变化时每帧重算 —— 曲线因此是「连续变形」，
 *    这正是引擎持续重绘能力最自然的用法（`keepAnimating`）；
 * 3. **断点**：极点（tan / 1x）不能连成竖直假线，采样阶段就写成 NaN，
 *    渲染时按 NaN 分段。
 *
 * 锚点（`series.points`）仍然保留：提示框、高亮环、键盘导航都按锚点索引工作，
 * 而锚点的像素位置同样是**用表达式现场算出来的**，所以「看到的曲线」与
 * 「点得到的点」始终一致。
 */
export abstract class CurveSeriesBase extends SeriesBase {
  /** 折线采样点（图表坐标系，[x,y] 交替），NaN 表示断点。 */
  protected curve: number[] = [];
  protected curveKey = '';
  /** 曲线必须裁剪：缩放后窗口外的部分不能画到坐标轴上。 */
  protected clipToBox = true;
  /** 不需要 LTTB：采样点数本来就可控，而且抽稀会破坏曲线形状。 */
  protected supportsSampling = false;

  /** 参数曲线的 x 不单调，二分查找会失效。 */
  protected monotonicX = true;

  /** 取值范围内的采样点（参数空间 → 数据空间 [x, y]）。 */
  protected abstract evaluateAt(parameter: number, params: Record<string, number>): [number, number];

  /** 采样的参数区间（function 是可视 x 区间，parametric 是 t 区间）。 */
  protected abstract parameterRange(rect: Rect): [number, number];

  /** 基础采样点数（自适应细分在此之上加点）。 */
  protected abstract baseSampleCount(): number;

  /** 采样整条曲线（数据空间）。 */
  protected abstract sampleCurve(params: Record<string, number>, rect: Rect): Array<[number, number]>;

  /** 当前参数值：配置里的 params + 扫动动画的实时值。 */
  public resolvedParams(): Record<string, number> {
    const params: Record<string, number> = { ...(this.series.option.params || {}) };
    const sweep = this.series.option.sweep;
    if (sweep && sweep.name) {
      const from = Number(sweep.from);
      const to = Number(sweep.to);
      // 关掉动画（instant / 减少动态效果）时停在起点，保证截图与测试是确定的
      const phase = shouldAnimate() ? this.sweepPhase() : 0;
      params[sweep.name] = from + (to - from) * phase;
    }
    return params;
  }

  /** 扫动相位 0~1：用真实时间算，掉帧也不会走样。 */
  public sweepPhase(): number {
    const sweep = this.series.option.sweep;
    if (!sweep) return 0;
    const duration = Math.max(200, Number(sweep.duration) || 3000);
    const raw = (((Date.now() % duration) + duration) % duration) / duration;
    return sweep.mode === 'loop' ? raw : 1 - Math.abs(2 * raw - 1);
  }

  /** 扫动参数当前值（测试 / 调试用）。 */
  public paramValue(name: string): number | null {
    const params = this.resolvedParams();
    return typeof params[name] === 'number' ? params[name] : null;
  }

  /** 有扫动配置时就持续重绘（每帧重算曲线），没有就停掉，别白占帧循环。 */
  protected syncSweep(): void {
    const sweep = this.series.option.sweep;
    const running = !!(sweep && sweep.name && shouldAnimate() && this.state.display !== false);
    if (running) this.keepAnimating();
    else this.stopAnimating();
  }

  protected rebuildPixels(): void {
    const coord = this.coord;
    if (!coord) {
      this.pixels = new Float64Array(0);
      this.curve = [];
      return;
    }
    this.syncSweep();
    const params = this.resolvedParams();
    const plot = coord.plot;
    const [from, to] = this.parameterRange(plot);
    const key = this.buildSeriesKey([
      this.paramKey(params),
      plot.width,
      plot.height,
      Number(from).toPrecision(12),
      Number(to).toPrecision(12),
    ]);
    if (key === this.curveKey) return;
    this.curveKey = key;

    // 锚点：按 series.points 的参数值现场求值（提示框 / 高亮 / 键盘导航都用它）
    const points = this.series.points;
    const n = points.length;
    if (this.pixels.length !== n * 2) this.pixels = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const [x, y] = this.evaluateAt(Number(points[i].xValue), params);
      const px = isFinite(x) ? coord.xScale.map(x) : NaN;
      const py = isFinite(y) ? coord.yScale.map(y) : NaN;
      this.pixels[i * 2] = px;
      this.pixels[i * 2 + 1] = py;
    }

    // 曲线：自适应采样后映射到像素
    const samples = this.sampleCurve(params, plot);
    const curve: number[] = new Array(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      const [x, y] = samples[i];
      curve[i * 2] = isFinite(x) ? coord.xScale.map(x) : NaN;
      curve[i * 2 + 1] = isFinite(y) ? coord.yScale.map(y) : NaN;
    }
    this.curve = curve;

    this.xMonotonic = this.monotonicX;
    this.computeEffective();
    this.renderIndices = null;
  }

  /** 参数指纹：扫动时每帧都不同，缓存必须失效（否则曲线会冻在第一帧）。 */
  private paramKey(params: Record<string, number>): string {
    const names = Object.keys(params).sort();
    return names.map((name) => `${name}=${Number(params[name]).toPrecision(10)}`).join(',');
  }

  /** 采样点数（测试 / 调试用）。 */
  public sampleCount(): number {
    this.rebuildPixels();
    return this.curve.length / 2;
  }

  /** 命中：曲线上离指针最近的锚点（锚点密度 = 采样密度，缩放后依然密）。 */
  public hitTestIndex(localX: number, localY: number): number {
    this.rebuildPixels();
    const n = this.pixels.length / 2;
    if (!n) return -1;
    const option: any = this.series.option;
    const tolerance = Math.max(6, this.lineWidthDevice() + 4) + (isFinite(Number(option.hitRadius)) ? Number(option.hitRadius) : 0);
    let best = -1;
    let bestDist = tolerance * tolerance;
    for (let i = 0; i < n; i++) {
      const dx = this.pixels[i * 2] - localX;
      const dy = this.pixels[i * 2 + 1] - localY;
      if (!isFinite(dx) || !isFinite(dy)) continue;
      const dist = dx * dx + dy * dy;
      if (dist <= bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  /** 悬停时线宽略粗一点：函数曲线是一条线，用粗细表达「选中了这条」。 */
  protected hoverLineScale(): number {
    const index = this.hoverIndex;
    if (index === null) return 1;
    return 1 + this.highlightT() * 0.45;
  }

  protected doRender(): void {
    this.rebuildPixels();
    if (!this.curve.length) return;
    const ctx = this.ctx;
    const unit = this.unit();
    const color = this.pointColor(0);
    const option: any = this.series.option;
    this.beginDraw();

    ctx.strokeStyle = color;
    ctx.lineWidth = this.lineWidthDevice() * unit * this.hoverLineScale();
    if (typeof ctx.setLineDash === 'function' && Array.isArray(option.lineDash)) {
      ctx.setLineDash((option.lineDash as number[]).map((d) => d * unit));
    }
    ctx.beginPath();
    // 入场：从左到右「画出来」（按采样点数比例揭示）
    const reveal = this.isEntering() ? Math.max(0.001, Math.min(1, this.progress())) : 1;
    const total = this.curve.length / 2;
    const limit = Math.max(1, Math.ceil(total * reveal));
    let started = false;
    for (let i = 0; i < limit; i++) {
      const x = this.curve[i * 2];
      const y = this.curve[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) {
        // 断点：抬笔，下一段重新 moveTo
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
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    this.endDraw();
  }

  /** 曲线的当前绘制点（测试用：验证「画出来的」与「算出来的」一致）。 */
  public curvePoints(): number[] {
    this.rebuildPixels();
    return this.curve;
  }
}
