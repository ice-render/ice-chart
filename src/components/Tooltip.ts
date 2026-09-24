import { ChartComponent } from './ChartComponent';
import { roundRect } from './Legend';
import type { ChartTheme, TooltipOption } from '../types';
import type { ChartLayout, Rect } from '../internal';
import { measureTextWidth } from '../util/text';
import { shouldAnimate } from '../animation/motion';

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
 * 提示框。画在画布内（不使用 HTML 浮层），因此无 DOM 的宿主（headless / 测试桩）同样可用，
 * 也能被引擎的离屏缓存 / 脏矩形机制正确擦除。
 */
export class Tooltip extends ChartComponent {
  public theme: ChartTheme | null = null;
  public option: TooltipOption = {};
  public layout: ChartLayout | null = null;
  /**
   * 提示框的避让边界；`null` = 整块绘图区（默认路径）。
   * 面板矩阵里由 InteractionController 设成指针所在的那块面板。
   */
  public plot: Rect | null = null;
  public content: TooltipContent | null = null;
  public anchor: [number, number] = [0, 0];
  /** 是否让提示框跟随指针（axis 触发器常关掉，让它固定在数据列上方）。 */
  public follow = true;
  /** 最近一次实际绘制的面板矩形（图表坐标系），供外观审计 / 测试断言使用。 */
  public lastRect: { x: number; y: number; width: number; height: number } | null = null;
  /** 淡出中：等透明度到 0 再清内容（避免「淡入很柔、消失很硬」）。 */
  private pendingClear = false;

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
  }

  public show(content: TooltipContent, anchor: [number, number]): this {
    // 淡出中被重新唤起时也要重新淡入，否则会停在半透明的中间态
    const needsFadeIn = !this.content || this.pendingClear || this.currentOpacity() < 0.999;
    this.content = content;
    this.anchor = anchor;
    this.pendingClear = false;
    if (needsFadeIn) this.playFade(true);
    return this.markDirty();
  }

  public hide(): this {
    if (!this.content) return this;
    if (!shouldAnimate()) {
      this.content = null;
      this.lastRect = null;
      return this.markDirty();
    }
    this.pendingClear = true;
    this.playFade(false);
    return this.markDirty();
  }

  /** 绘制用的透明度：没有动画状态时按「完全不透明」处理（向后兼容）。 */
  public panelOpacity(): number {
    const value = Number(this.state.panelOpacity);
    return isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  }

  /** 动画起点用的当前透明度：还没有任何状态时是 0（面板尚未出现）。 */
  private currentOpacity(): number {
    const value = Number(this.state.panelOpacity);
    return isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  }

  /** 面板出现/消失：淡入 + 轻微上移（消失只淡出，不做位移，避免「飘走」的错觉）。 */
  private playFade(inOut: boolean): void {
    if (!shouldAnimate()) {
      this.setState({ panelOpacity: inOut ? 1 : 0, slideY: 0 });
      if (!inOut) {
        this.content = null;
        this.lastRect = null;
      }
      return;
    }
    const animations: any = { ...((this.props as any).animations || {}) };
    animations.panelOpacity = {
      from: this.currentOpacity(),
      to: inOut ? 1 : 0,
      duration: inOut ? 140 : 110,
      easing: inOut ? 'easeOutCubic' : 'easeInQuad',
      startTime: undefined,
      finished: false,
    };
    if (inOut) {
      animations.slideY = { from: 6, to: 0, duration: 180, easing: 'easeOutCubic', startTime: undefined, finished: false };
      this.state.slideY = 6;
    }
    (this.props as any).animations = animations;
    if (this.ice && this.ice.animationManager) this.ice.animationManager.add(this);
    this.markDirty();
  }

  protected doRender(): void {
    this.lastRect = null;
    if (!this.content || !this.theme || !this.layout) return;
    const alpha = this.panelOpacity();
    if (this.pendingClear && alpha <= 0.02) {
      this.content = null;
      this.pendingClear = false;
      return;
    }
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

    const bounds = this.layout.canvas;
    /**
     * 避让的边界：默认是整块绘图区；面板矩阵里由 InteractionController 设成
     * **指针所在的那块面板** —— 否则第一行面板里的提示框会以「整张图的下沿」为准，
     * 一路压住那块面板自己的十字准星数值标签（审计抓到的 `tooltip-over-axis-label`）。
     */
    const plot = this.plot || this.layout.plot;
    let x = this.anchor[0] + offset[0];
    let y = this.anchor[1] + offset[1];
    if (x + width > bounds.width) x = this.anchor[0] - offset[0] - width;
    // 横向也优先待在绘图区内：避免压住 y 轴刻度标签；放不下时才退回画布内对齐
    if (width <= plot.width - 4) {
      x = Math.max(plot.x + 2, Math.min(x, plot.x + plot.width - width - 2));
    } else {
      x = Math.max(2, Math.min(x, Math.max(2, bounds.width - width - 2)));
    }
    if (y + height > bounds.height) y = this.anchor[1] - offset[1] - height;
    // 优先待在绘图区内：贴底的数据点提示框翻到上方，避免压住坐标轴上的数值标签。
    // 十字准星的数值标签是以绘图区底边为中心的一条带状区域，这里显式让开它。
    const plotBottom = plot.y + plot.height;
    const axisBand = fontSize + 8;
    const limitBottom = plotBottom - axisBand / 2;
    if (y + height > limitBottom) {
      const above = this.anchor[1] - offset[1] - height;
      y = above >= plot.y + 2 ? above : Math.max(plot.y + 2, limitBottom - height);
    }
    y = Math.max(2, Math.min(y, Math.max(2, bounds.height - height - 2)));
    this.lastRect = { x, y, width, height };

    const ctx = this.ctx;
    const unit = this.unit();
    ctx.beginPath();
    ctx.save();
    ctx.globalAlpha = alpha;
    // 出现时从下方 6px 滑入
    y += Number(this.state.slideY) || 0;
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
