import { ChartComponent } from './ChartComponent';
import { roundRect } from './Legend';
import type { ChartTheme } from '../types';

export interface HighlightItem {
  /** 标记中心：圆环是圆心，柱形是矩形中心。 */
  x: number;
  y: number;
  color: string;
  /** 圆点标记的直径（shape 为 circle 时使用）。 */
  size: number;
  /** 标记形状：数据点用圆环，柱形用矩形描边（更贴合图形语义）。 */
  shape?: 'circle' | 'rect';
  /** shape 为 rect 时的尺寸（以 x/y 为中心的宽高）。 */
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
  /**
   * 只许画在这个矩形里（画布坐标）—— 一般就是绘图区，`null` = 不裁剪。
   *
   * 为什么必须有（2026-09-23，审计 `ink-over-right-axis` 的那个缺陷）：
   * 标记环是**以数据点为中心**画的，而滑动窗口 / 缩放之后最常见的状态就是
   * 「当前点正好落在绘图区边界上」—— 环半径那几个像素就必然画到轴带里去。
   * 实测在 40px 宽的轴带里量到 44~58 个饱和像素，就是半颗环。
   *
   * 裁剪盒与 `item.x / item.y` **同一个坐标系**（都由图表按绘图区矩形给出），
   * 所以这里直接用 `ctx.rect(clipBox)`，不需要再做任何换算。
   */
  public clipBox: { x: number; y: number; width: number; height: number } | null = null;

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

  /** 设置裁剪盒；**没变就不置脏**（否则每帧重建都会把高亮层标脏，局部重绘的收益就没了）。 */
  public setClipBox(box: { x: number; y: number; width: number; height: number } | null): this {
    const prev = this.clipBox;
    const same =
      (!prev && !box) ||
      (!!prev &&
        !!box &&
        prev.x === box.x &&
        prev.y === box.y &&
        prev.width === box.width &&
        prev.height === box.height);
    this.clipBox = box;
    return same ? this : this.markDirty();
  }

  protected doRender(): void {
    if (!this.theme) return;
    const ctx = this.ctx;
    const unit = this.unit();
    ctx.beginPath();
    ctx.save();
    if (this.clipBox) {
      ctx.beginPath();
      ctx.rect(this.clipBox.x, this.clipBox.y, this.clipBox.width, this.clipBox.height);
      ctx.clip();
    }
    for (const item of this.hoverItems) {
      if (item.shape === 'rect') {
        const w = item.width || 0;
        const h = item.height || 0;
        if (w <= 0 || h <= 0) continue;
        ctx.strokeStyle = item.color;
        ctx.lineWidth = Math.max(unit, 1.5 * unit);
        roundRect(ctx, item.x - w / 2, item.y - h / 2, w, h, Math.min(4, w / 2, h / 2));
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
        roundRect(ctx, item.x - w / 2 - 2, item.y - h / 2 - 2, w + 4, h + 4, 5);
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
