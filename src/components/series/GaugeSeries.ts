import { SeriesBase } from './SeriesBase';
import type { GaugeOption, SeriesType } from '../../types';
import type { PolarLayout, Rect } from '../../internal';
import { measureTextWidth } from '../../util/text';

export interface GaugeSeriesCoord {
  polar: PolarLayout;
  plot: Rect;
  canvas: Rect;
  options: GaugeOption;
}

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/**
 * 仪表盘。
 *
 * 角度约定：配置里的角度沿用 ECharts 习惯（0° = 3 点方向、逆时针为正、90° = 12 点方向），
 * 内部换算成 canvas 角度时取负号（canvas 的 y 轴向下，角度顺时针为正）。
 * 默认 225° → -45°，即从左下扫到右下、经过正上方，共 270°。
 */
export class GaugeSeries extends SeriesBase {
  public seriesType: SeriesType = 'gauge';
  public gauge: GaugeSeriesCoord | null = null;
  private gaugeKey = '';

  public setCoord(coord: any): this {
    this.gauge = (coord || null) as GaugeSeriesCoord | null;
    this.gaugeKey = '';
    return this.markDirty();
  }

  protected paintPad(): number {
    return 8;
  }

  private angles(): { a0: number; a1: number; sweep: number } {
    const options = (this.gauge && this.gauge.options) || {};
    const startDeg = options.startAngle === undefined ? 225 : Number(options.startAngle);
    const endDeg = options.endAngle === undefined ? -45 : Number(options.endAngle);
    const a0 = -startDeg * DEG;
    let a1 = -endDeg * DEG;
    while (a1 <= a0) a1 += TAU;
    return { a0, a1, sweep: a1 - a0 };
  }

  private range(): { min: number; max: number } {
    const options = (this.gauge && this.gauge.options) || {};
    const min = isFinite(Number(options.min)) ? Number(options.min) : 0;
    const max = isFinite(Number(options.max)) ? Number(options.max) : 100;
    return { min, max: max > min ? max : min + 1 };
  }

  /** 数值 → canvas 角度。 */
  private angleFor(value: number): number {
    const { a0, sweep } = this.angles();
    const { min, max } = this.range();
    const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));
    return a0 + ratio * sweep;
  }

  private localCenter(): [number, number] {
    const coord = this.gauge as GaugeSeriesCoord;
    return [coord.polar.cx - coord.plot.x, coord.polar.cy - coord.plot.y];
  }

  /** 锚点放在指针尖端，提示框与高亮都跟指针走。 */
  protected rebuildPixels(): void {
    const coord = this.gauge;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const options = coord.options || {};
    const value = this.series.points.length ? Number(this.series.points[0].y) || 0 : 0;
    const key = [coord.polar.radius, options.startAngle, options.endAngle, options.min, options.max, value].join('|');
    if (key === this.gaugeKey && this.pixels.length === 2) return;
    this.gaugeKey = key;
    if (this.pixels.length !== 2) this.pixels = new Float64Array(2);
    const [cx, cy] = this.localCenter();
    const pointerLength = Number((options.pointer && options.pointer.length) || 0.72) * coord.polar.radius;
    const angle = this.angleFor(value);
    this.pixels[0] = cx + Math.cos(angle) * pointerLength;
    this.pixels[1] = cy + Math.sin(angle) * pointerLength;
    this.xMonotonic = false;
    this.renderIndices = null;
  }

  /** 整个表盘都是命中区（只有一个数值，点哪里都命中它）。 */
  public hitTestIndex(localX: number, localY: number): number {
    const coord = this.gauge;
    if (!coord || !this.series.points.length) return -1;
    const [cx, cy] = this.localCenter();
    const distance = Math.hypot(localX - cx, localY - cy);
    return distance <= coord.polar.radius + 12 ? 0 : -1;
  }

  protected doRender(): void {
    const coord = this.gauge;
    if (!coord || !this.chartTheme) return;
    this.rebuildPixels();
    const ctx = this.ctx;
    const theme = this.chartTheme;
    const options = coord.options || {};
    const unit = this.unit();
    const [cx, cy] = this.localCenter();
    const radius = coord.polar.radius;
    const { a0, sweep } = this.angles();
    const { min, max } = this.range();
    const lineWidth = Math.max(2, Number(options.lineWidth) || 14);
    const value = this.series.points.length ? Number(this.series.points[0].y) || 0 : 0;

    this.beginDraw();

    // 轴线：按阈值分段配色
    const segments = options.axisLineColor && options.axisLineColor.length
      ? options.axisLineColor
      : ([[1, theme.colorPalette[0]]] as Array<[number, string]>);
    let cursor = 0;
    for (let i = 0; i < segments.length; i++) {
      const [stop, color] = segments[i];
      const from = cursor;
      const to = Math.max(cursor, Math.min(1, Number(stop)));
      cursor = to;
      if (to <= from) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, a0 + from * sweep, a0 + to * sweep);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'butt';
      ctx.stroke();
    }

    // 刻度与刻度值
    const splitNumber = Math.max(1, Number(options.splitNumber) || 5);
    this.setFont(theme.fontSize * 0.85, theme.fontFamily);
    ctx.fillStyle = theme.subTextColor;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let i = 0; i <= splitNumber; i++) {
      const ratio = i / splitNumber;
      const angle = a0 + ratio * sweep;
      const inner = radius - lineWidth - 2 * unit;
      const outer = radius - lineWidth - 8 * unit;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      ctx.strokeStyle = theme.axisLineColor;
      ctx.lineWidth = unit;
      ctx.stroke();
      const labelRadius = radius - lineWidth - 20 * unit;
      ctx.fillText(String(Math.round(min + ratio * (max - min))), cx + Math.cos(angle) * labelRadius, cy + Math.sin(angle) * labelRadius);
    }

    // 指针
    const pointerOption = options.pointer || {};
    if (pointerOption.show !== false) {
      const pointerLength = Math.max(0.1, Number(pointerOption.length) || 0.72) * radius;
      const pointerWidth = Math.max(1, Number(pointerOption.width) || 5) * unit;
      const angle = this.angleFor(value);
      const tipX = cx + Math.cos(angle) * pointerLength;
      const tipY = cy + Math.sin(angle) * pointerLength;
      const leftX = cx + Math.cos(angle + Math.PI / 2) * pointerWidth;
      const leftY = cy + Math.sin(angle + Math.PI / 2) * pointerWidth;
      const rightX = cx + Math.cos(angle - Math.PI / 2) * pointerWidth;
      const rightY = cy + Math.sin(angle - Math.PI / 2) * pointerWidth;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(leftX, leftY);
      ctx.lineTo(rightX, rightY);
      ctx.closePath();
      ctx.fillStyle = theme.textColor;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, pointerWidth * 1.6, 0, TAU);
      ctx.fillStyle = theme.textColor;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, pointerWidth * 0.7, 0, TAU);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }

    // 数值与名称
    const detail = options.detail || {};
    const detailText = detail.formatter
      ? String(detail.formatter(value))
      : `${Math.round(value * 100) / 100}`;
    if (detail.show !== false) {
      const fontSize = Number(detail.fontSize) || Math.max(16, Math.round(radius * 0.26));
      this.setFont(fontSize, theme.fontFamily, 'bold');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = theme.textColor;
      ctx.fillText(detailText, cx, cy + radius * 0.42);
    }
    const title = options.title || {};
    const point = this.series.points[0];
    const name = point && (point.name || point.xValue !== undefined) ? point.name || String(point.xValue) : '';
    if (title.show !== false && name) {
      const fontSize = Number(title.fontSize) || theme.fontSize;
      this.setFont(fontSize, theme.fontFamily);
      const width = measureTextWidth(ctx, name, fontSize, theme.fontFamily);
      void width;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = theme.subTextColor;
      ctx.fillText(name, cx, cy + radius * 0.68);
    }
    this.endDraw();
  }
}
