import { ChartComponent } from './ChartComponent';
import type { ChartTheme, CrosshairOption } from '../types';
import type { ChartLayout } from '../internal';
import { shouldAnimate } from '../animation/motion';

/** 十字准星：跟随活动数据列的辅助线 + 坐标轴数值标签。 */
export class Crosshair extends ChartComponent {
  public layout: ChartLayout | null = null;
  public theme: ChartTheme | null = null;
  public option: CrosshairOption = {};
  public pixelX: number | null = null;
  public pixelY: number | null = null;
  public xLabel = '';
  public yLabel = '';
  /** 最近一次绘制的轴数值标签矩形（图表坐标系），供外观审计 / 测试断言使用。 */
  public lastChipRects: Array<{ x: number; y: number; width: number; height: number }> = [];
  /** 换列时的跟随时长（毫秒）：由图表按 `animation.update.duration` 下发。 */
  public followDuration = 110;

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
  }

  public show(pixelX: number | null, pixelY: number | null, xLabel: string, yLabel: string): this {
    this.pixelX = pixelX;
    this.pixelY = pixelY;
    this.xLabel = xLabel;
    this.yLabel = yLabel;
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
    if (!shouldAnimate() || x === null) {
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
    // 注意：props.animations 的默认值是引擎共享的**冻结**对象，
    // 直接往上面挂字段会抛 "Cannot add property ... object is not extensible"。
    // 必须先复制成新对象，再整体替换（这条在 jsdom 的 instant 模式下测不出来，只有真动画才暴露）。
    const animations: any = { ...((this.props as any).animations || {}) };
    const duration = Math.max(40, Number(this.followDuration) || 110);
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
    const { plot } = this.layout;
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
