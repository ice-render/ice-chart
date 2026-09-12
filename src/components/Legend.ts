import { ChartComponent } from './ChartComponent';
import type { ChartTheme } from '../types';
import type { ChartLayout, LegendItemLayout } from '../internal';

/**
 * 图例。每个图例项都是命中目标：containsLocalPoint 只在自己项的矩形内返回 true，
 * 因此引擎的命中测试会把点击精确交给图例本身，而不是整块画布。
 */
export class Legend extends ChartComponent {
  public layout: ChartLayout | null = null;
  public theme: ChartTheme | null = null;
  public selectable = true;
  /** 当前悬停的图例项下标；-1 表示无。 */
  public hoverIndex = -1;

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: true, ...props });
  }

  public get items(): LegendItemLayout[] {
    return this.layout && this.layout.legend ? this.layout.legend.items : [];
  }

  /** 命中项下标；-1 表示没命中。 */
  public hitItem(localX: number, localY: number): number {
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (localX >= it.x && localX <= it.x + it.width && localY >= it.y && localY <= it.y + it.height) {
        return i;
      }
    }
    return -1;
  }

  protected containsLocalPoint(localX: number, localY: number): boolean {
    return this.selectable && this.hitItem(localX, localY) >= 0;
  }

  protected doRender(): void {
    if (!this.theme || !this.layout || !this.layout.legend) return;
    const ctx = this.ctx;
    const items = this.layout.legend.items;
    const option = this.layout.legend;
    void option;
    ctx.beginPath();
    ctx.save();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const cy = it.y + it.height / 2;
      const itemWidth = 12;
      const itemHeight = 12;
      ctx.globalAlpha = it.hidden ? 0.45 : 1;
      ctx.fillStyle = it.color;
      roundRect(ctx, it.x, cy - itemHeight / 2, itemWidth, itemHeight, Math.min(3, itemWidth / 2));
      ctx.fill();

      this.setFont(this.theme.fontSize, this.theme.fontFamily);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = it.hidden ? this.theme.legend.inactiveColor : this.theme.legend.textColor;
      ctx.fillText(it.name, it.x + itemWidth + 6, cy);

      if (this.hoverIndex === i) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = this.theme.axisLineColor;
        ctx.lineWidth = this.unit();
        roundRect(ctx, it.x - 4, it.y + 1, it.width + 8, it.height - 2, 4);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/** 圆角矩形路径（不依赖 roundRect API，兼容小程序基础库）。 */
export function roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (radius <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}
