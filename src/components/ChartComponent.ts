import { ICEComponent } from 'ice-render';

export interface ChartComponentProps {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  zIndex?: number;
  interactive?: boolean;
  [key: string]: any;
}

/**
 * ice-chart 所有组件的基类。
 *
 * 与引擎默认组件有三处差异：
 * 1. origin 用 'top-left'，图表内部统一按「左上角为原点」的笛卡尔直觉坐标绘制与命中；
 * 2. draggable / transformable / linkable 一律关闭 —— 图表图元不是编辑器图元；
 * 3. keyboardEvtHandler 覆写为空 —— 引擎默认用方向键移动组件，这对图表是灾难
 *    （按一下方向键整条折线平移 2px）。键盘导航由交互层统一接管。
 */
export class ChartComponent extends ICEComponent {
  private loopRegistered = false;
  constructor(props: ChartComponentProps = {}) {
    super({
      origin: 'top-left',
      fill: false,
      stroke: false,
      draggable: false,
      transformable: false,
      linkable: false,
      interactive: false,
      ...props,
    });
  }

  /** 图表组件不响应引擎默认的键盘移动。 */
  protected keyboardEvtHandler(): void {
    // 有意留空：键盘导航由 InteractionController 统一处理
  }

  /** 左上角原点的盒式命中判定。 */
  protected containsLocalPoint(localX: number, localY: number): boolean {
    return localX >= 0 && localY >= 0 && localX <= this.state.width && localY <= this.state.height;
  }

  /**
   * 一个「设备像素」在当前 ctx 变换下对应的本地长度。
   * 用于把 1px 轴线 / 边框画清晰（视口缩放与 HiDPI 下都不发虚）。
   */
  protected unit(): number {
    const ice: any = this.ice;
    if (!ice) return 1;
    const scale = (ice.viewport && ice.viewport.scale) || 1;
    const dpr = ice.dpr || 1;
    return 1 / (scale * dpr);
  }

  /** 把坐标对齐到设备像素中心，保证 1px 线不发虚。 */
  protected snap(value: number): number {
    const ice: any = this.ice;
    if (!ice) return value;
    const scale = ((ice.viewport && ice.viewport.scale) || 1) * (ice.dpr || 1);
    return Math.round(value * scale) / scale + 0.5 / scale;
  }

  /** 标记自身需要重绘，并唤醒渲染器。 */
  public markDirty(): this {
    this.dirty = true;
    if (this.ice) {
      this.ice.dirty = true;
    }
    return this;
  }

  /**
   * 让组件「持续重绘」：给引擎挂一个 100ms 循环动画。
   *
   * 这正是引擎蚂蚁线（lineDashFlow）的做法 —— 动画值本身没意义，
   * 作用是每帧 setState → 标脏 → 重绘；真正的动效（如虚线相位）用 Date.now() 算。
   * 注意：持续重绘会让脏矩形局部重绘失去意义，只在确实需要「一直动」时用，且要能停。
   */
  protected keepAnimating(): void {
    if (this.loopRegistered) return;
    this.loopRegistered = true;
    const animations: any = { ...((this.props as any).animations || {}), __tick: { from: 0, to: 1, duration: 100, loop: true } };
    (this.props as any).animations = animations;
    if (this.ice && this.ice.animationManager) this.ice.animationManager.add(this);
    this.markDirty();
  }

  /** 停止持续重绘。 */
  protected stopAnimating(): void {
    if (!this.loopRegistered) return;
    this.loopRegistered = false;
    // 整体替换成一份新的（props.animations 的默认值是引擎共享的冻结对象，不能原地改）
    const animations: any = { ...((this.props as any).animations || {}) };
    for (const key in animations) {
      if (animations[key]) animations[key].finished = true;
    }
    delete animations.__tick;
    (this.props as any).animations = animations;
    if (this.ice && this.ice.animationManager) this.ice.animationManager.remove(this);
  }

  /** 统一的字体设置。 */
  protected setFont(fontSize: number, fontFamily: string, weight: string | number = 'normal'): void {
    this.ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
  }
}
