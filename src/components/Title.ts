import { ChartComponent } from './ChartComponent';
import type { ChartTheme } from '../types';
import type { ChartLayout } from '../internal';

/** 标题 / 副标题。 */
export class Title extends ChartComponent {
  public layout: ChartLayout | null = null;
  public theme: ChartTheme | null = null;

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
  }

  protected doRender(): void {
    const title = this.layout && this.layout.title;
    if (!title || !this.theme || !this.layout) return;
    const canvas = this.layout.canvas;
    const ctx = this.ctx;
    const anchorX = title.align === 'left' ? 0 : title.align === 'right' ? canvas.width : canvas.width / 2;
    let y = title.y;
    ctx.save();
    ctx.textAlign = title.align;
    ctx.textBaseline = 'top';
    if (title.text) {
      this.setFont(title.textStyle.fontSize, this.theme.fontFamily, title.textStyle.fontWeight);
      ctx.fillStyle = title.textStyle.color;
      ctx.fillText(title.text, anchorX, y);
      y += title.textStyle.fontSize * 1.5;
    }
    if (title.subtext) {
      this.setFont(title.subtextStyle.fontSize, this.theme.fontFamily);
      ctx.fillStyle = title.subtextStyle.color;
      ctx.fillText(title.subtext, anchorX, y);
    }
    ctx.restore();
  }
}
