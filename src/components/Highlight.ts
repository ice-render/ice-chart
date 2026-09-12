import { ChartComponent } from './ChartComponent';
import { roundRect } from './Legend';
import type { ChartTheme } from '../types';

export interface HighlightItem {
  x: number;
  y: number;
  color: string;
  /** 圆点标记的直径（shape 为 circle 时使用）。 */
  size: number;
  /** 标记形状：数据点用圆环，柱形用矩形描边（更贴合图形语义）。 */
  shape?: 'circle' | 'rect';
  /** shape 为 rect 时的尺寸（图表坐标系，矩形左上角 + 宽高）。 */
  width?: number;
  height?: number;
}

/**
 * 高亮层：悬停标记环 + 选中标记环。
 *
 * 它是一块独立的小组件，而不是让 series 重绘自己 —— 鼠标在数据点上移动时，
 * 只有这一个组件变脏，脏矩形就是标记环那一小块像素，series 的折线/柱子完全不动。
 */
export class Highlight extends ChartComponent {
  public theme: ChartTheme | null = null;
  public hoverItems: HighlightItem[] = [];
  public selectionItems: HighlightItem[] = [];

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
  }

  public setHover(items: HighlightItem[]): this {
    this.hoverItems = items;
    return this.markDirty();
  }

  public setSelection(items: HighlightItem[]): this {
    this.selectionItems = items;
    return this.markDirty();
  }

  protected doRender(): void {
    if (!this.theme) return;
    const ctx = this.ctx;
    const unit = this.unit();
    ctx.beginPath();
    ctx.save();
    for (const item of this.hoverItems) {
      if (item.shape === 'rect') {
        const w = item.width || 0;
        const h = item.height || 0;
        if (w <= 0 || h <= 0) continue;
        ctx.strokeStyle = item.color;
        ctx.lineWidth = Math.max(unit, 1.5 * unit);
        roundRect(ctx, item.x, item.y, w, h, Math.min(4, w / 2, h / 2));
        ctx.stroke();
      } else {
        const radius = Math.max(3, item.size / 2 + 3);
        ctx.beginPath();
        ctx.arc(item.x, item.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(item.x, item.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = item.color;
        ctx.lineWidth = Math.max(unit, 1.5 * unit);
        ctx.stroke();
      }
    }
    for (const item of this.selectionItems) {
      ctx.strokeStyle = this.theme.selection.stroke;
      ctx.lineWidth = Math.max(unit, 1.5 * unit);
      if (item.shape === 'rect') {
        const w = item.width || 0;
        const h = item.height || 0;
        if (w <= 0 || h <= 0) continue;
        roundRect(ctx, item.x - 2, item.y - 2, w + 4, h + 4, 5);
        ctx.stroke();
      } else {
        const radius = Math.max(3, item.size / 2 + 3);
        ctx.beginPath();
        ctx.arc(item.x, item.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
