import { ChartComponent } from './ChartComponent';
import { roundRect } from './Legend';
import type { ChartTheme, TooltipOption } from '../types';
import type { ChartLayout } from '../internal';
import { measureTextWidth } from '../util/text';

export interface TooltipRow {
  name: string;
  value: string;
  color: string;
}

export interface TooltipContent {
  title: string;
  rows: TooltipRow[];
}

/**
 * 提示框。画在画布内（不使用 HTML 浮层），因此小程序等无 DOM 运行时同样可用，
 * 也能被引擎的离屏缓存 / 脏矩形机制正确擦除。
 */
export class Tooltip extends ChartComponent {
  public theme: ChartTheme | null = null;
  public option: TooltipOption = {};
  public layout: ChartLayout | null = null;
  public content: TooltipContent | null = null;
  public anchor: [number, number] = [0, 0];
  /** 是否让提示框跟随指针（axis 触发器常关掉，让它固定在数据列上方）。 */
  public follow = true;

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
  }

  public show(content: TooltipContent, anchor: [number, number]): this {
    this.content = content;
    this.anchor = anchor;
    return this.markDirty();
  }

  public hide(): this {
    if (!this.content) return this;
    this.content = null;
    return this.markDirty();
  }

  protected doRender(): void {
    if (!this.content || !this.theme || !this.layout) return;
    const theme = this.theme;
    const option = this.option;
    const cfg = theme.tooltip;
    const fontSize = option.fontSize || cfg.fontSize;
    const family = theme.fontFamily;
    const padding = cfg.padding;
    const rowHeight = fontSize * 1.6;
    const dotWidth = 8;
    const gap = 8;

    const rows = this.content.rows;
    const titleWidth = this.content.title ? measureTextWidth(this.ctx, this.content.title, fontSize, family) : 0;
    let rowsWidth = 0;
    for (const row of rows) {
      const w =
        dotWidth + gap + measureTextWidth(this.ctx, row.name, fontSize, family) + gap * 2 + measureTextWidth(this.ctx, row.value, fontSize, family);
      if (w > rowsWidth) rowsWidth = w;
    }
    const contentWidth = Math.max(titleWidth, rowsWidth);
    const width = contentWidth + padding * 2;
    const height = padding * 2 + (this.content.title ? rowHeight : 0) + rows.length * rowHeight;
    const offset: [number, number] = option.offset || [14, 14];

    let x = this.anchor[0] + offset[0];
    let y = this.anchor[1] + offset[1];
    const bounds = this.layout.canvas;
    if (x + width > bounds.width) x = this.anchor[0] - offset[0] - width;
    if (y + height > bounds.height) y = this.anchor[1] - offset[1] - height;
    x = Math.max(2, Math.min(x, bounds.width - width - 2));
    y = Math.max(2, Math.min(y, bounds.height - height - 2));

    const ctx = this.ctx;
    const unit = this.unit();
    ctx.beginPath();
    ctx.save();
    // 阴影 + 面板
    ctx.shadowColor = cfg.shadowColor;
    ctx.shadowBlur = 10 * unit;
    ctx.shadowOffsetY = 2 * unit;
    ctx.fillStyle = option.backgroundColor || cfg.background;
    roundRect(ctx, x, y, width, height, cfg.radius);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = option.borderColor || cfg.borderColor;
    ctx.lineWidth = unit;
    roundRect(ctx, x + unit / 2, y + unit / 2, width - unit, height - unit, cfg.radius);
    ctx.stroke();

    ctx.fillStyle = option.textColor || cfg.textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let cursorY = y + padding + rowHeight / 2;
    if (this.content.title) {
      this.setFont(fontSize, family, 'bold');
      ctx.fillText(this.content.title, x + padding, cursorY);
      cursorY += rowHeight;
    }
    for (const row of rows) {
      const cy = cursorY + rowHeight / 2 - rowHeight / 2 + rowHeight / 2;
      this.setFont(fontSize, family);
      ctx.fillStyle = row.color;
      roundRect(ctx, x + padding, cy - dotWidth / 2, dotWidth, dotWidth, 2);
      ctx.fill();
      ctx.fillStyle = option.textColor || cfg.textColor;
      ctx.fillText(row.name, x + padding + dotWidth + gap, cy);
      ctx.textAlign = 'right';
      ctx.fillText(row.value, x + width - padding, cy);
      ctx.textAlign = 'left';
      cursorY += rowHeight;
    }
    ctx.restore();
  }
}
