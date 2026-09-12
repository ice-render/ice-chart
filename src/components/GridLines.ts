import { ChartComponent } from './ChartComponent';
import { AXIS_MORPH_DURATION } from './Axis';
import type { ChartTheme, GridOption } from '../types';
import type { Rect } from '../internal';
import type { Scale } from '../scale';

/** 网格线。绘制在 series 之下，不参与命中测试。 */
export class GridLines extends ChartComponent {
  public xScale: Scale | null = null;
  public yScale: Scale | null = null;
  /** 水平网格线：每个 y 轴一组（默认只有主轴画网格线）。 */
  public horizontal: Array<{ scale: Scale; ticks: any[]; index?: number }> = [];
  public plot: Rect = { x: 0, y: 0, width: 0, height: 0 };
  public grid: GridOption = {};
  public theme: ChartTheme | null = null;
  /** 坐标轴组件：网格线的位置**全部问坐标轴要**，保证过渡期间两者不脱节。 */
  public axisX: any = null;
  public axisYList: any[] = [];

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
  }

  /**
   * 由 ICEChart 在坐标轴同步之后调用。
   *
   * 网格线不自己算位置（位置全部读坐标轴的 `renderedTickPos`），但必须**每帧重绘**，
   * 所以借一条与刻度同长的补间当「脏驱动」——否则标签在滑动、网格线却停在旧位置。
   */
  public syncTicks(): void {
    // 任何一个轴在过渡，网格就得跟着重绘（只看 x 轴会漏掉「只缩放 y」的情况）
    const drivers = [this.axisX, ...this.axisYList].filter(Boolean);
    const morphing = drivers.some((axis: any) => typeof axis.morphing === 'function' && axis.morphing());
    if (!morphing) return;
    const animations: any = { ...((this.props as any).animations || {}) };
    animations.axisMorph = {
      from: 0,
      to: 1,
      duration: AXIS_MORPH_DURATION,
      easing: 'easeOutCubic',
      startTime: undefined,
      finished: false,
    };
    (this.props as any).animations = animations;
    if (this.ice && this.ice.animationManager) this.ice.animationManager.add(this);
    this.markDirty();
  }

  /** 某个 y 轴刻度的当前渲染位置（过渡中取中间值）。 */
  private yTickPos(index: number | undefined, tick: any, fallback: number): number {
    const axis = index === undefined ? null : this.axisYList[index];
    if (!axis || typeof axis.renderedTickPos !== 'function') return fallback;
    const pos = axis.renderedTickPos(tick);
    return pos === null || pos === undefined ? fallback : pos;
  }

  private xTickPos(tick: any, fallback: number): number {
    const axis = this.axisX;
    if (!axis || typeof axis.renderedTickPos !== 'function') return fallback;
    const pos = axis.renderedTickPos(tick);
    return pos === null || pos === undefined ? fallback : pos;
  }

  protected doRender(): void {
    if (!this.theme || !this.xScale || !this.yScale || this.grid.show === false) return;
    const { plot } = this;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.save();
    ctx.strokeStyle = this.grid.color || this.theme.splitLineColor;
    ctx.lineWidth = (this.grid.lineWidth || 1) * this.unit();
    if (typeof ctx.setLineDash === 'function') {
      ctx.setLineDash((this.grid.lineDash || []).map((d) => d * this.unit()));
    }
    const horizontal = this.horizontal.length
      ? this.horizontal
      : this.yScale
        ? [{ scale: this.yScale, ticks: this.yScale.ticks(5) }]
        : [];
    if (this.grid.y !== false) {
      ctx.beginPath();
      for (const group of horizontal) {
        for (const tick of group.ticks) {
          const fallback = plot.y + group.scale.map(tick);
          if (!isFinite(fallback)) continue;
          const y = this.snap(this.yTickPos(group.index, tick, fallback));
          ctx.moveTo(plot.x, y);
          ctx.lineTo(plot.x + plot.width, y);
        }
      }
      ctx.stroke();
    }
    if (this.grid.x) {
      ctx.beginPath();
      for (const tick of this.xScale.ticks(5)) {
        const fallback = plot.x + this.xScale.map(tick);
        if (!isFinite(fallback)) continue;
        const x = this.snap(this.xTickPos(tick, fallback));
        ctx.moveTo(x, plot.y);
        ctx.lineTo(x, plot.y + plot.height);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
