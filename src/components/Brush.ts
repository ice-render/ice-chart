import { ChartComponent } from './ChartComponent';
import type { ChartTheme } from '../types';
import type { Rect } from '../internal';

/** 刷选框。拖拽期间由交互层每帧更新 rect（图表坐标系）。 */
export class Brush extends ChartComponent {
  public theme: ChartTheme | null = null;
  public rect: Rect | null = null;
  public color: { fill: string; stroke: string } | null = null;

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
  }

  public setRect(rect: Rect | null): this {
    this.rect = rect;
    return this.markDirty();
  }

  protected doRender(): void {
    if (!this.rect || !this.theme) return;
    const ctx = this.ctx;
    const palette = this.color || this.theme.brush;
    const unit = this.unit();
    ctx.beginPath();
    ctx.save();
    ctx.fillStyle = palette.fill;
    ctx.fillRect(this.rect.x, this.rect.y, this.rect.width, this.rect.height);
    ctx.strokeStyle = palette.stroke;
    ctx.lineWidth = unit;
    ctx.strokeRect(this.rect.x, this.rect.y, this.rect.width, this.rect.height);
    ctx.restore();
  }
}
