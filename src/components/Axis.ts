import { ChartComponent } from './ChartComponent';
import type { ChartTheme } from '../types';
import type { AxisLayout, ChartLayout, InternalAxis } from '../internal';
import { formatTick } from '../scale';

const TICK_LENGTH = 4;
const LABEL_GAP = 6;

/**
 * 坐标轴（x / y 共用一套绘制逻辑）。
 *
 * 轴组件拥有整块画布作为盒，绘制时直接用图表坐标系（左上角原点），
 * 因此刻度标签、轴名称可以自然画到绘图区之外，不需要扩展包围盒。
 *
 * 多 y 轴支持：`axisIndex` 决定读哪个轴的刻度，`position` + `layout.offset`
 * 决定轴线画在绘图区左侧还是右侧、以及同侧多轴时向外偏移多少。
 */
export class Axis extends ChartComponent {
  public orientation: 'x' | 'y';
  /** y 轴下标（对应 norm.yAxes）；x 轴恒为 0。 */
  public axisIndex = 0;
  public position: 'left' | 'right' = 'left';
  public axis: InternalAxis | null = null;
  public layout: ChartLayout | null = null;
  public theme: ChartTheme | null = null;

  constructor(props: {
    orientation: 'x' | 'y';
    width: number;
    height: number;
    zIndex?: number;
    axisIndex?: number;
    position?: 'left' | 'right';
  }) {
    super({ interactive: false, ...props });
    this.orientation = props.orientation;
    this.axisIndex = props.axisIndex || 0;
    this.position = props.position || 'left';
  }

  /** y 轴轴线的 x 坐标（含同侧多层偏移）。 */
  private edgeX(axisLayout: AxisLayout): number {
    const plot = (this.layout as ChartLayout).plot;
    const offset = axisLayout.offset || 0;
    return this.position === 'left' ? plot.x - offset : plot.x + plot.width + offset;
  }

  protected doRender(): void {
    if (!this.axis || !this.layout || !this.theme) return;
    const option = this.axis.option;
    if (option.show === false) return;
    const scale = this.axis.scale;
    if (!scale) return;
    const plot = this.layout.plot;
    const axisLayout =
      this.orientation === 'x' ? this.layout.xAxisLayout : this.layout.yAxes[this.axisIndex] || this.layout.yAxisLayout;
    const ticks = axisLayout.ticks;
    const ctx = this.ctx;
    const fontSize = this.theme.fontSize;
    const unit = this.unit();
    const tickGap = (TICK_LENGTH + LABEL_GAP) * unit;
    ctx.beginPath();
    ctx.save();
    ctx.lineWidth = unit;
    ctx.strokeStyle = this.theme.axisLineColor;
    ctx.fillStyle = this.theme.axisLabelColor;
    this.setFont(fontSize, this.theme.fontFamily);
    ctx.textBaseline = this.orientation === 'x' ? 'top' : 'middle';
    ctx.textAlign = this.orientation === 'x' ? 'center' : this.position === 'left' ? 'right' : 'left';

    const edgeX = this.orientation === 'x' ? plot.x : this.edgeX(axisLayout);

    if (option.showAxisLine !== false) {
      ctx.beginPath();
      if (this.orientation === 'x') {
        const y = this.snap(plot.y + plot.height);
        ctx.moveTo(plot.x, y);
        ctx.lineTo(plot.x + plot.width, y);
      } else {
        const x = this.snap(edgeX);
        ctx.moveTo(x, plot.y);
        ctx.lineTo(x, plot.y + plot.height);
      }
      ctx.stroke();
    }

    const direction = this.position === 'left' ? -1 : 1;
    for (let i = 0; i < ticks.length; i++) {
      const label = formatTick(ticks[i], scale, i, option.formatter);
      if (this.orientation === 'x') {
        const x = this.snap(plot.x + scale.map(ticks[i]));
        if (!isFinite(x)) continue;
        if (option.showTick !== false) {
          ctx.beginPath();
          ctx.moveTo(x, plot.y + plot.height);
          ctx.lineTo(x, plot.y + plot.height + TICK_LENGTH * unit);
          ctx.stroke();
        }
        if (!label) continue;
        const labelY = plot.y + plot.height + tickGap;
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
          ctx.moveTo(edgeX, y);
          ctx.lineTo(edgeX + direction * TICK_LENGTH * unit, y);
          ctx.stroke();
        }
        if (label) ctx.fillText(label, edgeX + direction * tickGap, y);
      }
    }

    if (option.name) {
      this.setFont(fontSize, this.theme.fontFamily);
      ctx.fillStyle = this.theme.subTextColor;
      if (this.orientation === 'x') {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const nameY = plot.y + plot.height + tickGap + axisLayout.labelHeight + 6 * unit + fontSize * 0.5;
        ctx.fillText(option.name, plot.x + plot.width / 2, nameY);
      } else {
        const nameOffset = axisLayout.labelWidth + tickGap + axisLayout.nameHeight + 4 * unit;
        const nameX = edgeX + direction * nameOffset;
        ctx.save();
        ctx.translate(this.position === 'left' ? Math.max(fontSize * 0.6, nameX) : nameX, plot.y + plot.height / 2);
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
