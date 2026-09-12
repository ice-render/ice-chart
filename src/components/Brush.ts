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
    // 有选框时让边框「流动」起来（蚂蚁线），清空时停掉，避免无谓的每帧重绘
    if (rect) this.keepAnimating();
    else this.stopAnimating();
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
    // 蚂蚁线：虚线相位随时间推进（与引擎 lineDashFlow 同一套做法）
    if (typeof ctx.setLineDash === 'function') {
      const dash = [5 * unit, 4 * unit];
      const period = dash[0] + dash[1] || 1;
      ctx.setLineDash(dash);
      if (typeof ctx.lineDashOffset === 'number') ctx.lineDashOffset = -((Date.now() / 1000) * 26) % period;
    }
    ctx.strokeRect(this.rect.x, this.rect.y, this.rect.width, this.rect.height);
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    ctx.restore();
  }
}
