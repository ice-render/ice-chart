import { ChartComponent } from './ChartComponent';

/**
 * 绘图区背景 + 空白处交互面。
 *
 * 它存在的意义不只是背景色：当指针落在绘图区但**没有命中任何数据标记**时
 * （系列组件的 containsLocalPoint 返回 false），引擎的命中测试会落到这个组件上，
 * 于是「拖拽平移 / 框选 / 点击空白取消选中」才有明确的宿主。
 */
export class PlotArea extends ChartComponent {
  public background: string | null = null;
  public borderColor: string | null = null;

  constructor(props: { left: number; top: number; width: number; height: number; zIndex?: number }) {
    super({ interactive: true, ...props });
  }

  public setBackground(color: string | null): this {
    this.background = color;
    return this.markDirty();
  }

  protected doRender(): void {
    this.ctx.beginPath();
    const { width, height } = this.state;
    if (this.background) {
      this.ctx.fillStyle = this.background;
      this.ctx.fillRect(0, 0, width, height);
    }
    if (this.borderColor) {
      this.ctx.strokeStyle = this.borderColor;
      this.ctx.lineWidth = this.unit();
      const u = this.unit() / 2;
      this.ctx.strokeRect(u, u, width - this.unit(), height - this.unit());
    }
  }
}
