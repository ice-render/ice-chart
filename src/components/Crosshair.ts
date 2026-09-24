import { ChartComponent } from './ChartComponent';
import type { ChartTheme, CrosshairOption } from '../types';
import type { ChartLayout, Rect } from '../internal';
import { shouldAnimate } from '../animation/motion';

/**
 * 准星跟随时长：**距离越大走得越快**，上限 `maxDuration`（0 = 立即跟随）。
 *
 * 为什么不是固定时长：指针是连续移动的，每次 mousemove 都会重新设定目标。
 * 如果每次都从当前位置开一段固定时长（比如 420ms）的补间，指针一动就重新计时，
 * 实际位置永远追不上目标 —— 实测快速拖动时滞后 50~300px，看起来就是「准星飘来飘去」。
 * 改成按距离给时长（5px/ms）之后：相邻数据点之间的小位移当帧就到，
 * 只有跨越大段距离（比如从绘图区左端跳到右端）才有一段看得见的滑动。
 */
export function crosshairGlideDuration(distance: number, maxDuration: number, speed = 5): number {
  if (!isFinite(maxDuration) || maxDuration <= 0) return 0;
  const span = Math.abs(distance);
  if (!isFinite(span) || span <= 0) return 0;
  return Math.max(16, Math.min(maxDuration, span / speed));
}

/** 十字准星：跟随活动数据列的辅助线 + 坐标轴数值标签。 */
export class Crosshair extends ChartComponent {
  public layout: ChartLayout | null = null;
  /**
   * 准星画在哪块绘图区里；`null` = 图表整体的 `layout.plot`（默认路径）。
   * 面板矩阵里由 InteractionController 设成**指针所在面板** —— 准星只在那块里画，
   * 否则一条线会横穿所有面板，指代不清。
   */
  public plot: Rect | null = null;
  public theme: ChartTheme | null = null;
  public option: CrosshairOption = {};
  public pixelX: number | null = null;
  public pixelY: number | null = null;
  public xLabel = '';
  public yLabel = '';
  /** 最近一次绘制的轴数值标签矩形（图表坐标系），供外观审计 / 测试断言使用。 */
  public lastChipRects: Array<{ x: number; y: number; width: number; height: number }> = [];
  /**
   * 换列时的**最大**跟随时长（毫秒），由 `crosshair.followDuration` 下发；0 = 立即跟随。
   * 实际时长按距离缩放（见 `crosshairGlideDuration`）。
   */
  public followDuration = 90;

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
  }

  public show(pixelX: number | null, pixelY: number | null, xLabel: string, yLabel: string): this {
    // 数据流页面每帧都会 refreshHover；目标没变时不要重启补间（否则补间永远到不了头）
    const sameTarget =
      this.pixelX !== null &&
      pixelX !== null &&
      Math.abs(this.pixelX - pixelX) < 0.5 &&
      (this.pixelY === pixelY ||
        (this.pixelY !== null && pixelY !== null && Math.abs(this.pixelY - pixelY) < 0.5));
    this.pixelX = pixelX;
    this.pixelY = pixelY;
    this.xLabel = xLabel;
    this.yLabel = yLabel;
    if (sameTarget) return this.markDirty();
    this.animateAxis(pixelX, pixelY);
    return this.markDirty();
  }

  /** 绘制位置（可能是动画中的中间值）；`pixelX/pixelY` 始终是目标值。 */
  private drawnX(): number | null {
    const value = Number(this.state.axisX);
    if (this.pixelX === null) return null;
    return isFinite(value) ? value : this.pixelX;
  }

  private drawnY(): number | null {
    const value = Number(this.state.axisY);
    if (this.pixelY === null) return null;
    return isFinite(value) ? value : this.pixelY;
  }

  /**
   * 准星平滑：每次悬停换列时从**当前位置**补间到新位置（而不是硬切）。
   * 快速划过时会有轻微跟随感，这正是十字准星该有的手感。
   */
  private animateAxis(x: number | null, y: number | null): void {
    if (!shouldAnimate() || x === null || this.followDuration <= 0) {
      this.setState({ axisX: x, axisY: y });
      return;
    }
    const currentX = this.drawnX();
    const currentY = this.drawnY();
    if (currentX === null) {
      // 从「没有准星」进入：直接落到目标位置
      this.setState({ axisX: x, axisY: y });
      return;
    }
    const distance = Math.abs(x - currentX);
    const duration = crosshairGlideDuration(distance, this.followDuration);
    if (duration <= 0) {
      // 已经在目标上（或用户把跟随时长设成 0）：直接对齐，不排补间
      this.setState({ axisX: x, axisY: y });
      return;
    }
    // 注意：props.animations 的默认值是引擎共享的**冻结**对象，
    // 直接往上面挂字段会抛 "Cannot add property ... object is not extensible"。
    // 必须先复制成新对象，再整体替换（这条在 jsdom 的 instant 模式下测不出来，只有真动画才暴露）。
    const animations: any = { ...((this.props as any).animations || {}) };
    animations.axisX = { from: currentX, to: x, duration, easing: 'easeOutCubic', startTime: undefined, finished: false };
    if (currentY !== null && y !== null) {
      animations.axisY = { from: currentY, to: y, duration, easing: 'easeOutCubic', startTime: undefined, finished: false };
    }
    (this.props as any).animations = animations;
    if (this.ice && this.ice.animationManager) this.ice.animationManager.add(this);
  }

  public hide(): this {
    if (this.pixelX === null && this.pixelY === null) return this;
    this.pixelX = null;
    this.pixelY = null;
    this.stopAxisAnimation();
    return this.markDirty();
  }

  private stopAxisAnimation(): void {
    const animations: any = (this.props as any).animations;
    if (animations) {
      for (const key in animations) {
        if (animations[key]) animations[key].finished = true;
      }
    }
    if (this.ice && this.ice.animationManager) this.ice.animationManager.remove(this);
    this.state.axisX = null;
    this.state.axisY = null;
  }

  protected doRender(): void {
    this.lastChipRects = [];
    if (!this.layout || !this.theme || this.option.show === false || this.option.type === 'none') return;
    if (this.pixelX === null && this.pixelY === null) return;
    const plot = this.plot || this.layout.plot;
    const ctx = this.ctx;
    const unit = this.unit();
    const axis = this.option.axis || 'x';
    ctx.beginPath();
    ctx.save();
    ctx.strokeStyle = this.option.lineColor || this.theme.crosshair.lineColor;
    ctx.lineWidth = unit;
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([3 * unit, 3 * unit]);
    ctx.beginPath();
    if (this.pixelX !== null && axis !== 'y') {
      const x = this.snap(this.drawnX() as number);
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.height);
    }
    if (this.pixelY !== null && (axis === 'y' || axis === 'xy')) {
      const y = this.snap(this.drawnY() as number);
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.width, y);
    }
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);

    if (this.option.showAxisLabel !== false) {
      this.setFont(this.theme.fontSize, this.theme.fontFamily);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (this.pixelX !== null && this.xLabel && axis !== 'y') {
        this.drawChip(this.snap(this.drawnX() as number), plot.y + plot.height, this.xLabel);
      }
      if (this.pixelY !== null && this.yLabel && (axis === 'y' || axis === 'xy')) {
        this.drawChip(plot.x, this.snap(this.drawnY() as number), this.yLabel);
      }
    }
    ctx.restore();
  }

  private drawChip(x: number, y: number, text: string): void {
    const ctx = this.ctx;
    const theme = this.theme as ChartTheme;
    const padX = 6;
    const padY = 3;
    const width = ctx.measureText(text).width + padX * 2;
    const height = theme.fontSize + padY * 2;
    ctx.fillStyle = theme.crosshair.labelBackground;
    this.lastChipRects.push({ x: x - width / 2, y: y - height / 2, width, height });
    ctx.fillRect(x - width / 2, y - height / 2, width, height);
    ctx.fillStyle = theme.crosshair.labelColor;
    ctx.fillText(text, x, y);
  }
}
