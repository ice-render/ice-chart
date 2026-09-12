import { ChartComponent } from './ChartComponent';
import type { ChartTheme, GridOption } from '../types';
import type { Rect } from '../internal';
import type { Scale } from '../scale';

/** 网格线。绘制在 series 之下，不参与命中测试。 */
export class GridLines extends ChartComponent {
  public xScale: Scale | null = null;
  public yScale: Scale | null = null;
  /** 水平网格线：每个 y 轴一组（默认只有主轴画网格线）。 */
  public horizontal: Array<{ scale: Scale; ticks: any[] }> = [];
  public plot: Rect = { x: 0, y: 0, width: 0, height: 0 };
  public grid: GridOption = {};
  public theme: ChartTheme | null = null;

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
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
          const y = this.snap(plot.y + group.scale.map(tick));
          if (!isFinite(y)) continue;
          ctx.moveTo(plot.x, y);
          ctx.lineTo(plot.x + plot.width, y);
        }
      }
      ctx.stroke();
    }
    if (this.grid.x) {
      ctx.beginPath();
      for (const tick of this.xScale.ticks(5)) {
        const x = this.snap(plot.x + this.xScale.map(tick));
        if (!isFinite(x)) continue;
        ctx.moveTo(x, plot.y);
        ctx.lineTo(x, plot.y + plot.height);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
