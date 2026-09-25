import { ChartComponent } from './ChartComponent';
import { roundRect } from './Legend';
import type { ChartTheme } from '../types';
import { clamp } from '../util/math';

export type SliderPart = 'start' | 'end' | 'window' | 'track';
export type SliderOrientation = 'horizontal' | 'vertical';

/** 手柄底色（两种方向共用一处，别在渲染里各写一遍 —— 仓里有「写死色值只许减」的棘轮）。 */
const HANDLE_FILL = '#ffffff';

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
  /** 选中窗口的颜色；没配就用主题的第一个色板色。 */
  public windowColor: string | null = null;
  /**
   * 轨道方向。横向 = 底部那条（x 窗口），纵向 = 绘图区右侧那条（y 窗口）。
   *
   * 纵向的角度约定：**上 = 大值、下 = 小值**（与屏幕上的 y 轴同向），所以
   * 「从上往下拖」= 窗口朝小值走。与 AGENTS 里「纵向平移的符号和横向是反的」是同一件事，
   * 别照着横向那条把符号抄反。
   */
  public orientation: SliderOrientation = 'horizontal';
  /** 纵向轨道驱动第几根 y 轴（横向那条不用；多 y 轴时由图表层按 option 写进来）。 */
  public axisIndex = 0;
  private handleWidth = 12;

  constructor(props: {
    left?: number;
    top?: number;
    width: number;
    height: number;
    zIndex?: number;
    orientation?: SliderOrientation;
  }) {
    const { orientation, ...rest } = props;
    super({ interactive: true, ...rest });
    if (orientation) this.orientation = orientation;
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
    if (this.orientation === 'vertical') {
      // 纵向：窗口的「起点」在下、「终点」在上（上 = 大值）
      const half = this.handleWidth / 2;
      const bottom = (1 - this.start) * height;
      const top = (1 - this.end) * height;
      if (Math.abs(localY - bottom) <= half) return 'start';
      if (Math.abs(localY - top) <= half) return 'end';
      if (localY > top && localY < bottom) return 'window';
      return 'track';
    }
    const x0 = this.start * width;
    const x1 = this.end * width;
    const half = this.handleWidth / 2;
    if (Math.abs(localX - x0) <= half) return 'start';
    if (Math.abs(localX - x1) <= half) return 'end';
    if (localX > x0 && localX < x1) return 'window';
    return 'track';
  }

  /**
   * 指针位置对应的窗口比例（0~1）。
   *
   * 横向看 `localX`、纵向看 `localY`；纵向做了 `1 - y/height` 的翻转（上 = 大值），
   * 与 `hitPart` 里 `start` 在下 / `end` 在上是同一套约定。
   */
  public fractionAt(localX: number, localY = 0): number {
    if (this.orientation === 'vertical') {
      const height = this.state.height || 1;
      return clamp(1 - localY / height, 0, 1);
    }
    const width = this.state.width || 1;
    return clamp(localX / width, 0, 1);
  }

  protected doRender(): void {
    if (!this.theme) return;
    if (this.orientation === 'vertical') {
      this.drawVertical();
      return;
    }
    const ctx = this.ctx;
    const { width, height } = this.state;
    const unit = this.unit();
    const trackHeight = Math.max(4, Math.round(height * 0.34));
    const trackY = (height - trackHeight) / 2;
    const x0 = this.start * width;
    const x1 = this.end * width;
    const accent = this.windowColor || this.theme.colorPalette[0];
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
      ctx.fillStyle = HANDLE_FILL;
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

  /**
   * 纵向轨道：与横向同一组几何，只是 x / y 对调。
   *
   * 轨道竖着居中（宽度 = 组件的 34%），窗口从 `1-end` 画到 `1-start`
   * （下 = 小值、上 = 大值），手柄画成横向的胶囊、里面两道横纹。
   */
  private drawVertical(): void {
    if (!this.theme) return;
    const ctx = this.ctx;
    const { width, height } = this.state;
    const unit = this.unit();
    const trackWidth = Math.max(4, Math.round(width * 0.34));
    const trackX = (width - trackWidth) / 2;
    // 下 = start（小值）、上 = end（大值）
    const y0 = (1 - this.start) * height;
    const y1 = (1 - this.end) * height;
    const top = Math.min(y0, y1);
    const windowHeight = Math.max(2, Math.abs(y0 - y1));
    const accent = this.theme.colorPalette[0];
    const handleHeight = this.handleWidth;

    ctx.beginPath();
    ctx.save();
    // 轨道
    ctx.fillStyle = this.theme.splitLineColor;
    roundRect(ctx, trackX, 0, trackWidth, height, trackWidth / 2);
    ctx.fill();
    // 选中窗口
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.85;
    roundRect(ctx, trackX, top, trackWidth, windowHeight, trackWidth / 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    // 手柄（横条）：上端是 end、下端是 start，与 hitPart 同一套约定
    for (const [y, part] of [
      [y0, 'start'],
      [y1, 'end'],
    ] as Array<[number, SliderPart]>) {
      const hy = clamp(y - handleHeight / 2, 0, Math.max(0, height - handleHeight));
      ctx.fillStyle = HANDLE_FILL;
      ctx.strokeStyle = this.activePart === part ? accent : this.theme.axisLineColor;
      ctx.lineWidth = (this.activePart === part ? 2 : 1) * unit;
      roundRect(ctx, 1, hy, width - 2, handleHeight, 3);
      ctx.fill();
      ctx.stroke();
      // 手柄里的两道横纹
      ctx.beginPath();
      ctx.moveTo(trackX - 3, hy + handleHeight / 2 - 2);
      ctx.lineTo(trackX + trackWidth + 3, hy + handleHeight / 2 - 2);
      ctx.moveTo(trackX - 3, hy + handleHeight / 2 + 2);
      ctx.lineTo(trackX + trackWidth + 3, hy + handleHeight / 2 + 2);
      ctx.strokeStyle = this.theme.subTextColor;
      ctx.lineWidth = unit;
      ctx.stroke();
    }
    ctx.restore();
  }
}
