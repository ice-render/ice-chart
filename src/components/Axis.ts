import { ChartComponent } from './ChartComponent';
import type { ChartTheme } from '../types';
import type { ChartLayout, InternalAxis } from '../internal';
import { formatTick } from '../scale';

/**
 * 坐标轴（x / y 共用一套绘制逻辑，用 orientation 区分）。
 *
 * 轴组件拥有整块画布作为盒，绘制时直接用图表坐标系（左上角原点），
 * 因此刻度标签、轴名称可以自然画到绘图区之外，不需要扩展包围盒。
 */
export class Axis extends ChartComponent {
  public orientation: 'x' | 'y';
  public axis: InternalAxis | null = null;
  public layout: ChartLayout | null = null;
  public theme: ChartTheme | null = null;

  constructor(props: { orientation: 'x' | 'y'; width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
    this.orientation = props.orientation;
  }

  protected doRender(): void {
    if (!this.axis || !this.layout || !this.theme) return;
    const option = this.axis.option;
    if (option.show === false) return;
    const scale = this.axis.scale;
    if (!scale) return;
    const { plot } = this.layout;
    const axisLayout = this.orientation === 'x' ? this.layout.xAxisLayout : this.layout.yAxisLayout;
    const ticks = axisLayout.ticks;
    const ctx = this.ctx;
    const fontSize = this.theme.fontSize;
    const unit = this.unit();
    const tickGap = 4 + 6;
    ctx.beginPath();
    ctx.save();
    ctx.lineWidth = unit;
    ctx.strokeStyle = this.theme.axisLineColor;
    ctx.fillStyle = this.theme.axisLabelColor;
    this.setFont(fontSize, this.theme.fontFamily);
    ctx.textBaseline = this.orientation === 'x' ? 'top' : 'middle';
    ctx.textAlign = this.orientation === 'x' ? 'center' : 'right';

    if (option.showAxisLine !== false) {
      ctx.beginPath();
      if (this.orientation === 'x') {
        const y = this.snap(plot.y + plot.height);
        ctx.moveTo(plot.x, y);
        ctx.lineTo(plot.x + plot.width, y);
      } else {
        const x = this.snap(plot.x);
        ctx.moveTo(x, plot.y);
        ctx.lineTo(x, plot.y + plot.height);
      }
      ctx.stroke();
    }

    for (let i = 0; i < ticks.length; i++) {
      const label = formatTick(ticks[i], scale, i, option.formatter);
      if (this.orientation === 'x') {
        const x = this.snap(plot.x + scale.map(ticks[i]));
        if (!isFinite(x)) continue;
        if (option.showTick !== false) {
          ctx.beginPath();
          ctx.moveTo(x, plot.y + plot.height);
          ctx.lineTo(x, plot.y + plot.height + 4 * unit);
          ctx.stroke();
        }
        if (!label) continue;
        const labelY = plot.y + plot.height + tickGap * unit;
        if (option.labelRotate) {
          ctx.save();
          ctx.translate(x, labelY);
          ctx.rotate((Number(option.labelRotate) * Math.PI) / 180);
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, 0, 0);
          ctx.restore();
        } else {
          ctx.fillText(label, x, labelY);
        }
      } else {
        const y = this.snap(plot.y + scale.map(ticks[i]));
        if (!isFinite(y)) continue;
        if (option.showTick !== false) {
          ctx.beginPath();
          ctx.moveTo(plot.x - 4 * unit, y);
          ctx.lineTo(plot.x, y);
          ctx.stroke();
        }
        if (label) ctx.fillText(label, plot.x - tickGap * unit, y);
      }
    }

    if (option.name) {
      this.setFont(fontSize, this.theme.fontFamily);
      ctx.fillStyle = this.theme.subTextColor;
      if (this.orientation === 'x') {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const nameY = plot.y + plot.height + (tickGap + axisLayout.labelHeight + 6) * unit + fontSize * 0.5;
        ctx.fillText(option.name, plot.x + plot.width / 2, nameY);
      } else {
        ctx.save();
        ctx.translate(this.layout.margin.left + fontSize * 0.6, plot.y + plot.height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(option.name, 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();
  }
}
