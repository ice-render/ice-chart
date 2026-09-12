import { ChartComponent } from './ChartComponent';
import { roundRect } from './Legend';
import type { ChartTheme } from '../types';
import { clamp } from '../util/math';

export type SliderPart = 'start' | 'end' | 'window' | 'track';

/**
 * dataZoom 滑块。
 *
 * 组件只关心「0~1 的窗口比例」：把比例换算成数据域是图表层的职责
 * （类目轴按索引窗口、数值/时间轴按线性插值），因此这个组件对坐标系一无所知。
 */
export class DataZoomSlider extends ChartComponent {
  public theme: ChartTheme | null = null;
  /** 窗口比例（0~1）。 */
  public start = 0;
  public end = 1;
  public activePart: SliderPart | null = null;
  private handleWidth = 12;

  constructor(props: { left?: number; top?: number; width: number; height: number; zIndex?: number }) {
    super({ interactive: true, ...props });
  }

  public setWindow(start: number, end: number): this {
    const s = clamp(start, 0, 1);
    const e = clamp(end, 0, 1);
    if (Math.abs(s - this.start) < 1e-6 && Math.abs(e - this.end) < 1e-6) return this;
    this.start = s;
    this.end = e;
    return this.markDirty();
  }

  public setActive(part: SliderPart | null): this {
    if (this.activePart === part) return this;
    this.activePart = part;
    return this.markDirty();
  }

  /** 指针落在滑块的哪一部分。 */
  public hitPart(localX: number, localY: number): SliderPart | null {
    const { width, height } = this.state;
    if (localX < 0 || localX > width || localY < 0 || localY > height) return null;
    const x0 = this.start * width;
    const x1 = this.end * width;
    const half = this.handleWidth / 2;
    if (Math.abs(localX - x0) <= half) return 'start';
    if (Math.abs(localX - x1) <= half) return 'end';
    if (localX > x0 && localX < x1) return 'window';
    return 'track';
  }

  public fractionAt(localX: number): number {
    const width = this.state.width || 1;
    return clamp(localX / width, 0, 1);
  }

  protected doRender(): void {
    if (!this.theme) return;
    const ctx = this.ctx;
    const { width, height } = this.state;
    const unit = this.unit();
    const trackHeight = Math.max(4, Math.round(height * 0.34));
    const trackY = (height - trackHeight) / 2;
    const x0 = this.start * width;
    const x1 = this.end * width;
    const accent = this.theme.colorPalette[0];
    const handleWidth = this.handleWidth;

    ctx.beginPath();
    ctx.save();
    // 轨道
    ctx.fillStyle = this.theme.splitLineColor;
    roundRect(ctx, 0, trackY, width, trackHeight, trackHeight / 2);
    ctx.fill();
    // 选中窗口
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.85;
    roundRect(ctx, x0, trackY, Math.max(2, x1 - x0), trackHeight, trackHeight / 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    // 手柄
    for (const [x, part] of [
      [x0, 'start'],
      [x1, 'end'],
    ] as Array<[number, SliderPart]>) {
      const hx = clamp(x - handleWidth / 2, 0, Math.max(0, width - handleWidth));
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = this.activePart === part ? accent : this.theme.axisLineColor;
      ctx.lineWidth = (this.activePart === part ? 2 : 1) * unit;
      roundRect(ctx, hx, 1, handleWidth, height - 2, 3);
      ctx.fill();
      ctx.stroke();
      // 手柄里的两道竖纹
      ctx.beginPath();
      ctx.moveTo(hx + handleWidth / 2 - 2, trackY - 3);
      ctx.lineTo(hx + handleWidth / 2 - 2, trackY + trackHeight + 3);
      ctx.moveTo(hx + handleWidth / 2 + 2, trackY - 3);
      ctx.lineTo(hx + handleWidth / 2 + 2, trackY + trackHeight + 3);
      ctx.strokeStyle = this.theme.subTextColor;
      ctx.lineWidth = unit;
      ctx.stroke();
    }
    ctx.restore();
  }
}
