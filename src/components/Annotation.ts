import { ChartComponent } from './ChartComponent';
import { resolveAnnotation, type AnnotationContext, type ResolvedAnnotation } from '../annotation/resolve';
import type { AnnotationDiagnostic, AnnotationOption, ChartTheme } from '../types';
import type { InternalAxis, Rect } from '../internal';
import { measureTextWidth } from '../util/text';

/** 一处落墨（供审计 / 测试 / 无障碍读取）：标注画在了哪儿、画的是什么字。 */
export interface AnnotationInk {
  kind: 'line' | 'point' | 'area';
  index: number;
  /** 图表坐标系里的绘制盒。 */
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

/**
 * 标注图层：目标线 / 阈值线、异常点、目标区间。
 *
 * 定位与边界判定全在 `resolveAnnotation()`（纯函数），本组件只负责：
 * 把解析结果画出来、把落墨盒记下来给审计用。
 *
 * 三处刻意如此的设计：
 * - **盒 = 整块画布**（与坐标轴 / 图例 / 覆盖层同款）：标注的文字会伸到绘图区之外，
 *   用绘图区当盒就得扩展包围盒才能画得出来。整块画布的盒天然覆盖全部墨迹，
 *   脏矩形与离屏缓存不会把标注切掉半截。
 * - **`interactive: false`**：标注是「说明」，压在数据点上也应该点到下面的数据。
 * - **不参与动画**：位置只由比例尺决定，缩放 / 平移时与坐标轴同步重绘即可。
 */
export class Annotation extends ChartComponent {
  /** 解析结果（图表坐标系），供测试与审计断言几何。 */
  public resolved: ResolvedAnnotation = { lines: [], points: [], areas: [] };
  /** 最近一次同步产生的诊断（越界 / 值非法 / 场景不支持）。 */
  public diagnostics: AnnotationDiagnostic[] = [];
  /** 最近一次绘制的落墨盒（图表坐标系）。 */
  public ink: AnnotationInk[] = [];
  public theme: ChartTheme | null = null;
  private option: AnnotationOption | null = null;

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
  }

  /**
   * 由 ICEChart 在坐标轴与比例尺就绪之后调用。
   *
   * 每次都重算解析结果 —— 它只读比例尺，所以「缩放 / 平移 / 数据更新 / resize」全部自动跟随，
   * 不需要额外的失效逻辑（与网格线读坐标轴位置是同一个理由）。
   */
  public sync(annotation: AnnotationOption | null | undefined, ctx: AnnotationContext): void {
    this.option = annotation || null;
    this.theme = ctx.theme;
    const { resolved, diagnostics } = resolveAnnotation(annotation, ctx);
    this.resolved = resolved;
    this.diagnostics = diagnostics;
    this.markDirty();
  }

  /** 有没有东西要画（没有就整层跳过绘制）。 */
  private get hasInk(): boolean {
    return this.resolved.lines.length > 0 || this.resolved.points.length > 0 || this.resolved.areas.length > 0;
  }

  protected __localBox(): number[] {
    // 盒 = 整块画布：标注的文字会画到绘图区之外，用绘图区当盒就会被脏矩形切掉半截
    const box = this.__boxScratch;
    box[0] = 0;
    box[1] = 0;
    box[2] = this.state.width || 0;
    box[3] = this.state.height || 0;
    return box;
  }

  private __boxScratch: number[] = [0, 0, 0, 0];

  protected doRender(): void {
    const theme = this.theme;
    if (!theme || !this.hasInk) {
      this.ink = [];
      return;
    }
    const plot = this.plot;
    const ink: AnnotationInk[] = [];
    // 顺序：区间（底）→ 线 → 点（顶）。同一层里先铺面积，文字才不会被自己的填充压住
    this.drawAreas(ink, plot);
    this.drawLines(ink, plot);
    this.drawPoints(ink);
    this.ink = ink;
  }

  /** 绘图区矩形，由 ICEChart 在同步时写入。 */
  public plot: Rect = { x: 0, y: 0, width: 0, height: 0 };
  /** x 轴（用于 vLine 的端点与文字避让），由 ICEChart 在同步时写入。 */
  public xAxis: InternalAxis | null = null;
  public yAxes: InternalAxis[] = [];

  private drawAreas(ink: AnnotationInk[], plot: Rect): void {
    for (const area of this.resolved.areas) {
      const ctx = this.ctx;
      ctx.beginPath();
      // 区间两端保持 from → to 的数据顺序（y 轴像素是反的），画之前取上下界
      const lo = Math.min(area.from, area.to);
      const hi = Math.max(area.from, area.to);
      const x = area.axis === 'x' ? lo : plot.x;
      const y = area.axis === 'y' ? lo : plot.y;
      const width = area.axis === 'x' ? hi - lo : plot.width;
      const height = area.axis === 'y' ? hi - lo : plot.height;
      if (width <= 0 || height <= 0) continue;
      // 区间是按像素夹取过的，必然落在绘图区内，不需要再裁剪
      ctx.save();
      ctx.fillStyle = area.color;
      ctx.fillRect(x, y, width, height);
      ctx.restore();
      let textBox: AnnotationInk | null = null;
      if (area.text) {
        ctx.save();
        this.setFont(area.fontSize, this.theme!.fontFamily, 'normal');
        ctx.fillStyle = area.textColor;
        const padding = 6;
        if (area.axis === 'y') {
          const align = area.textPosition === 'start' ? 'left' : area.textPosition === 'end' ? 'right' : 'center';
          const tx =
            area.textPosition === 'start'
              ? plot.x + padding
              : area.textPosition === 'end'
                ? plot.x + plot.width - padding
                : plot.x + plot.width / 2;
          ctx.textAlign = align as CanvasTextAlign;
          ctx.textBaseline = 'middle';
          const ty = (area.from + area.to) / 2;
          this.strokeHalo(() => ctx.strokeText(area.text, tx, ty));
          ctx.fillText(area.text, tx, ty);
          textBox = {
            kind: 'area',
            index: area.index,
            x:
              align === 'right'
                ? tx - this.textWidth(area.text, area.fontSize)
                : align === 'center'
                  ? tx - this.textWidth(area.text, area.fontSize) / 2
                  : tx,
            y: ty - area.fontSize / 2,
            width: this.textWidth(area.text, area.fontSize),
            height: area.fontSize,
            text: area.text,
          };
        } else {
          const tx = (area.from + area.to) / 2;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          const ty = plot.y + padding;
          this.strokeHalo(() => ctx.strokeText(area.text, tx, ty));
          ctx.fillText(area.text, tx, ty);
          textBox = {
            kind: 'area',
            index: area.index,
            x: tx - this.textWidth(area.text, area.fontSize) / 2,
            y: ty,
            width: this.textWidth(area.text, area.fontSize),
            height: area.fontSize,
            text: area.text,
          };
        }
        ctx.restore();
      }
      ink.push({ kind: 'area', index: area.index, x, y, width, height, text: area.text });
      if (textBox) ink.push(textBox);
    }
  }

  private drawLines(ink: AnnotationInk[], plot: Rect): void {
    for (const line of this.resolved.lines) {
      const ctx = this.ctx;
      const horizontal = line.axis === 'y';
      const pixel = this.snap(line.pixel);
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.lineWidth * this.unit();
      if (typeof ctx.setLineDash === 'function') {
        ctx.setLineDash(line.lineDash.map((d) => d * this.unit()));
      }
      if (horizontal) {
        ctx.moveTo(plot.x, pixel);
        ctx.lineTo(plot.x + plot.width, pixel);
      } else {
        ctx.moveTo(pixel, plot.y);
        ctx.lineTo(pixel, plot.y + plot.height);
      }
      ctx.stroke();
      ctx.restore();

      const box: AnnotationInk = horizontal
        ? {
            kind: 'line',
            index: line.index,
            x: plot.x,
            y: line.pixel - 1,
            width: plot.width,
            height: 2,
            text: line.text,
          }
        : {
            kind: 'line',
            index: line.index,
            x: line.pixel - 1,
            y: plot.y,
            width: 2,
            height: plot.height,
            text: line.text,
          };
      ink.push(box);
      if (line.text) ink.push(this.drawLineText(line, plot, horizontal));
    }
  }

  /** 线的说明文字：横向线写在线上方、竖向线写在右手边；贴边时自动翻到另一侧。 */
  private drawLineText(line: ResolvedAnnotation['lines'][number], plot: Rect, horizontal: boolean): AnnotationInk {
    const ctx = this.ctx;
    const padding = 6;
    const gap = 4;
    ctx.save();
    this.setFont(line.fontSize, this.theme!.fontFamily, 'normal');
    ctx.fillStyle = line.textColor;
    const width = this.textWidth(line.text, line.fontSize);
    let box: AnnotationInk;
    if (horizontal) {
      const align = line.textPosition === 'start' ? 'left' : line.textPosition === 'end' ? 'right' : 'center';
      const tx =
        line.textPosition === 'start'
          ? plot.x + padding
          : line.textPosition === 'end'
            ? plot.x + plot.width - padding
            : plot.x + plot.width / 2;
      // 线贴近绘图区上沿时文字翻到线的下方，否则会压到标题 / 画出绘图区
      const below = line.pixel - line.fontSize - gap < plot.y;
      const ty = below ? line.pixel + gap : line.pixel - gap;
      ctx.textAlign = align as CanvasTextAlign;
      ctx.textBaseline = below ? 'top' : 'bottom';
      this.strokeHalo(() => ctx.strokeText(line.text, tx, ty));
      ctx.fillText(line.text, tx, ty);
      const left = align === 'right' ? tx - width : align === 'center' ? tx - width / 2 : tx;
      box = {
        kind: 'line',
        index: line.index,
        x: left,
        y: below ? ty : ty - line.fontSize,
        width,
        height: line.fontSize,
        text: line.text,
      };
    } else {
      const align: CanvasTextAlign = 'left';
      // 竖线把文字放在线的右侧；贴近右沿时翻到左侧
      const flip = line.pixel + gap + width > plot.x + plot.width;
      const tx = flip ? line.pixel - gap : line.pixel + gap;
      const top = plot.y + padding;
      ctx.textAlign = flip ? 'right' : align;
      ctx.textBaseline = 'top';
      this.strokeHalo(() => ctx.strokeText(line.text, tx, top));
      ctx.fillText(line.text, tx, top);
      box = {
        kind: 'line',
        index: line.index,
        x: flip ? tx - width : tx,
        y: top,
        width,
        height: line.fontSize,
        text: line.text,
      };
    }
    ctx.restore();
    return box;
  }

  private drawPoints(ink: AnnotationInk[]): void {
    for (const point of this.resolved.points) {
      const ctx = this.ctx;
      const r = point.symbolSize / 2;
      ctx.save();
      ctx.beginPath();
      ctx.fillStyle = point.color;
      if (point.symbol === 'circle') {
        ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
      } else if (point.symbol === 'rect') {
        ctx.rect(point.x - r, point.y - r, point.symbolSize, point.symbolSize);
      } else if (point.symbol === 'diamond') {
        ctx.moveTo(point.x, point.y - r);
        ctx.lineTo(point.x + r, point.y);
        ctx.lineTo(point.x, point.y + r);
        ctx.lineTo(point.x - r, point.y);
        ctx.closePath();
      } else {
        ctx.moveTo(point.x, point.y - r);
        ctx.lineTo(point.x + r, point.y + r);
        ctx.lineTo(point.x - r, point.y + r);
        ctx.closePath();
      }
      ctx.fill();
      ctx.restore();
      ink.push({
        kind: 'point',
        index: point.index,
        x: point.x - r,
        y: point.y - r,
        width: point.symbolSize,
        height: point.symbolSize,
        text: point.text,
      });
      if (point.text) ink.push(this.drawPointText(point));
    }
  }

  private drawPointText(point: ResolvedAnnotation['points'][number]): AnnotationInk {
    const ctx = this.ctx;
    const gap = 6;
    const r = point.symbolSize / 2;
    ctx.save();
    this.setFont(point.fontSize, this.theme!.fontFamily, 'normal');
    ctx.fillStyle = point.textColor;
    const width = this.textWidth(point.text, point.fontSize);
    let x = point.x;
    let y = point.y;
    let align: CanvasTextAlign = 'center';
    let baseline: CanvasTextBaseline = 'bottom';
    if (point.textPosition === 'top') {
      align = 'center';
      baseline = 'bottom';
      y = point.y - r - gap / 2;
    } else if (point.textPosition === 'bottom') {
      align = 'center';
      baseline = 'top';
      y = point.y + r + gap / 2;
    } else if (point.textPosition === 'left') {
      align = 'right';
      baseline = 'middle';
      x = point.x - r - gap / 2;
    } else {
      align = 'left';
      baseline = 'middle';
      x = point.x + r + gap / 2;
    }
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    this.strokeHalo(() => ctx.strokeText(point.text, x, y));
    ctx.fillText(point.text, x, y);
    ctx.restore();
    const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    const size = point.fontSize;
    const top = baseline === 'bottom' ? y - size : baseline === 'middle' ? y - size / 2 : y;
    return { kind: 'point', index: point.index, x: left, y: top, width, height: size, text: point.text };
  }

  /**
   * 文字描边走主题的 `labelHaloColor`：标注常常压在数据线上，没有描边就会糊在一起。
   * 浅色主题是白描边、深色主题是深描边（写死白色在深色大屏里会变成一层白糊）。
   */
  private strokeHalo(draw: () => void): void {
    const ctx = this.ctx;
    const halo = this.theme ? this.theme.labelHaloColor : null;
    if (!halo) return;
    const previousWidth = ctx.lineWidth;
    const previousJoin = ctx.lineJoin;
    const previousStyle = ctx.strokeStyle;
    ctx.lineWidth = 3 * this.unit();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = halo;
    draw();
    ctx.lineWidth = previousWidth;
    ctx.lineJoin = previousJoin;
    ctx.strokeStyle = previousStyle;
  }

  /** 量文字宽度（走 util/text：拿不到真实 ctx 时退化为估算）。 */
  private textWidth(text: string, fontSize: number): number {
    return measureTextWidth(this.ctx, text, fontSize, this.theme ? this.theme.fontFamily : 'sans-serif');
  }
}
