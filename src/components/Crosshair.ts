import { ChartComponent } from './ChartComponent';
import type { ChartTheme, CrosshairOption } from '../types';
import type { ChartLayout } from '../internal';

/** 十字准星：跟随活动数据列的辅助线 + 坐标轴数值标签。 */
export class Crosshair extends ChartComponent {
  public layout: ChartLayout | null = null;
  public theme: ChartTheme | null = null;
  public option: CrosshairOption = {};
  public pixelX: number | null = null;
  public pixelY: number | null = null;
  public xLabel = '';
  public yLabel = '';

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
  }

  public show(pixelX: number | null, pixelY: number | null, xLabel: string, yLabel: string): this {
    this.pixelX = pixelX;
    this.pixelY = pixelY;
    this.xLabel = xLabel;
    this.yLabel = yLabel;
    return this.markDirty();
  }

  public hide(): this {
    if (this.pixelX === null && this.pixelY === null) return this;
    this.pixelX = null;
    this.pixelY = null;
    return this.markDirty();
  }

  protected doRender(): void {
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
      const x = this.snap(this.pixelX);
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.height);
    }
    if (this.pixelY !== null && (axis === 'y' || axis === 'xy')) {
      const y = this.snap(this.pixelY);
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
        this.drawChip(this.snap(this.pixelX), plot.y + plot.height, this.xLabel);
      }
      if (this.pixelY !== null && this.yLabel && (axis === 'y' || axis === 'xy')) {
        this.drawChip(plot.x, this.snap(this.pixelY), this.yLabel);
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
    ctx.fillRect(x - width / 2, y - height / 2, width, height);
    ctx.fillStyle = theme.crosshair.labelColor;
    ctx.fillText(text, x, y);
  }
}
