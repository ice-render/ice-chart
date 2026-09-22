import { SeriesBase } from './SeriesBase';
import type { LiquidOption, SeriesType } from '../../types';
import type { PolarLayout, Rect } from '../../internal';
import { hexToRgba } from './LineSeries';
import { shouldAnimate } from '../../animation/motion';

export interface LiquidSeriesCoord {
  polar: PolarLayout;
  plot: Rect;
  canvas: Rect;
  options: LiquidOption;
}

const TAU = Math.PI * 2;

/**
 * 水位图（液位球）：一个圆里装水，水位随数值升降，水面是持续起伏的波浪。
 *
 * 这是数据大屏里最有辨识度的一张图，
 * 引擎这边两个能力刚好都用上：
 * - **补间**：水位随 `progress()` 升降（入场从 0 涨上来、更新时涨落到位）；
 * - **持续重绘**：波相位用 `Date.now()` 算（`keepAnimating`），和蚂蚁线同一套路。
 *
 * 动效偏好为 `instant`（无障碍 / 截图）时相位固定为 0 —— 画面确定、可做像素比对。
 */
export class LiquidSeries extends SeriesBase {
  public seriesType: SeriesType = 'liquid';
  public liquid: LiquidSeriesCoord | null = null;
  private liquidKey = '';
  /** 更新动画的起点水位（占「当前渲染值」，不是 0 —— 高频 setData 才不会每次从空涨起）。 */
  private fromRatio: number | null = null;

  public setCoord(coord: any): this {
    this.liquid = (coord || null) as LiquidSeriesCoord | null;
    this.liquidKey = '';
    return this.markDirty();
  }

  protected paintPad(): number {
    return 6;
  }

  private localCenter(): [number, number] {
    const coord = this.liquid as LiquidSeriesCoord;
    return [coord.polar.cx - coord.plot.x, coord.polar.cy - coord.plot.y];
  }

  private range(): { min: number; max: number } {
    const options = (this.liquid && this.liquid.options) || {};
    const min = isFinite(Number(options.min)) ? Number(options.min) : 0;
    const max = isFinite(Number(options.max)) ? Number(options.max) : 100;
    return { min, max: max > min ? max : min + 1 };
  }

  /** 目标值 → 水位比例（0~1）。 */
  private targetRatio(): number {
    const { min, max } = this.range();
    const value = this.series.pointCount ? Number(this.series.pointAt(0).y) || 0 : 0;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

  /** 当前水位比例：入场从 0 涨上来，更新时从旧值涨落（和 gauge 的指针同一个套路）。 */
  private currentRatio(): number {
    const target = this.targetRatio();
    const p = Math.max(0, Math.min(1, this.progress()));
    const from = this.fromRatio === null ? 0 : this.fromRatio;
    return from + (target - from) * p;
  }

  /** 当前**渲染**的水位比例（0~1）：测试与外观审计断言用，不是源数据。 */
  public levelRatio(): number {
    return this.currentRatio();
  }

  /**
   * 数据更新时把「此刻正在渲染的水位」记为动画起点。
   *
   * 仪表盘 / 水位图这类**只由 progress 和目标值推导几何**的图，如果起点恒为 0，
   * 高频 setData（监控大屏每 130ms 一次）会让动画永远跑不完 —— 实测 CPU 已经 79.9%，
   * 水面还停在 27%。从当前渲染值接着走，看到的才是「水位跟着数据涨落」。
   */
  public updateSeries(series: any, animate: boolean, preserveAnimation = false): this {
    // 同 GaugeSeries：捕获起点不受 preserveAnimation 影响（那个参数只管值插值）
    if (animate && this.liquid) this.fromRatio = this.currentRatio();
    return super.updateSeries(series, animate, preserveAnimation);
  }

  /** 波相位：用真实时间算，掉帧也不会走样；静止模式固定 0。 */
  private phase(): number {
    const options = (this.liquid && this.liquid.options) || {};
    if (!shouldAnimate()) return 0;
    const speed = isFinite(Number(options.waveSpeed)) ? Number(options.waveSpeed) : 1.6;
    return (Date.now() / 1000) * speed;
  }

  /** 水位在动（0 < 比例 < 1）时持续重绘；满/空/静止模式就停掉，别白占帧循环。 */
  private syncWave(): void {
    const ratio = this.targetRatio();
    const running = shouldAnimate() && ratio > 0.001 && ratio < 0.999 && this.state.display !== false;
    if (running) this.keepAnimating();
    else this.stopAnimating();
  }

  /** 锚点放在圆心：提示框与高亮都落在球心。 */
  protected rebuildPixels(): void {
    const coord = this.liquid;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const value = this.series.pointCount ? Number(this.series.pointAt(0).y) || 0 : 0;
    const key = this.buildSeriesKey([coord.polar.radius, coord.options.min, coord.options.max, value]);
    if (key === this.liquidKey && this.pixels.length === 2) return;
    this.liquidKey = key;
    if (this.pixels.length !== 2) this.pixels = new Float64Array(2);
    const [cx, cy] = this.localCenter();
    this.pixels[0] = cx;
    this.pixels[1] = cy;
    this.xMonotonic = false;
    this.renderIndices = null;
  }

  /** 整个液位球都是命中区（只有一个数值，点哪里都命中它）。 */
  public hitTestIndex(localX: number, localY: number): number {
    const coord = this.liquid;
    if (!coord || !this.series.pointCount) return -1;
    const [cx, cy] = this.localCenter();
    return Math.hypot(localX - cx, localY - cy) <= coord.polar.radius + 8 ? 0 : -1;
  }

  /** 一条波浪的路径（从左到右的波面）。 */
  private wavePath(ctx: any, cx: number, cy: number, inner: number, level: number, amp: number, len: number, phase: number): void {
    const step = Math.max(1, (inner * 2) / 64);
    ctx.beginPath();
    ctx.moveTo(cx - inner, level + amp * Math.sin(phase));
    for (let x = -inner + step; x <= inner; x += step) {
      ctx.lineTo(cx + x, level + amp * Math.sin((x / len) * TAU + phase));
    }
  }

  protected doRender(): void {
    const coord = this.liquid;
    if (!coord || !this.chartTheme) return;
    this.rebuildPixels();
    this.syncWave();
    const ctx = this.ctx;
    const theme = this.chartTheme;
    const options = coord.options || {};
    const unit = this.unit();
    const [cx, cy] = this.localCenter();
    const radius = coord.polar.radius;
    const borderWidth = Math.max(1, Number(options.borderWidth) || 3) * unit;
    const inner = Math.max(2, radius - borderWidth);
    const color = options.color || this.pointColor(0);
    const ratio = this.currentRatio();
    const waveHeight = isFinite(Number(options.waveHeight)) ? Number(options.waveHeight) : 0.06;
    const waveLength = Math.max(0.15, isFinite(Number(options.waveLength)) ? Number(options.waveLength) : 1.2) * inner;
    const amp = waveHeight * inner;
    const phase = this.phase();

    this.beginDraw();

    // 底色（球内部）：深色底 + 一点内阴影感
    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, TAU);
    ctx.fillStyle = hexToRgba(color, 0.1);
    ctx.fill();

    // 水体：裁到球内，画两层波浪
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, TAU);
    ctx.clip();
    const level = cy + inner - 2 * inner * ratio;
    const layers: Array<{ phase: number; alpha: number; ampScale: number }> = [
      { phase, alpha: 0.34, ampScale: 1.25 },
      { phase: phase + Math.PI * 0.6, alpha: 0.55, ampScale: 1 },
    ];
    for (const layer of layers) {
      this.wavePath(ctx, cx, cy, inner, level, amp * layer.ampScale, waveLength, layer.phase);
      ctx.lineTo(cx + inner, cy + inner + amp * 2);
      ctx.lineTo(cx - inner, cy + inner + amp * 2);
      ctx.closePath();
      ctx.globalAlpha = layer.alpha;
      const gradient = ctx.createLinearGradient ? ctx.createLinearGradient(0, level - amp, 0, cy + inner) : null;
      if (gradient) {
        gradient.addColorStop(0, hexToRgba(color, 0.95));
        gradient.addColorStop(1, hexToRgba(color, 0.55));
        ctx.fillStyle = gradient;
      } else {
        ctx.fillStyle = color;
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // 外圈
    ctx.beginPath();
    ctx.arc(cx, cy, radius - borderWidth / 2, 0, TAU);
    ctx.strokeStyle = options.borderColor || hexToRgba(color, 0.6);
    ctx.lineWidth = borderWidth;
    ctx.stroke();

    // 中心数值
    const detail = options.detail || {};
    if (detail.show !== false) {
      const { min } = this.range();
      const raw = this.series.pointCount ? Number(this.series.pointAt(0).y) || 0 : 0;
      const shown = min + (raw - min) * Math.max(0, Math.min(1, this.progress()));
      const text =
        typeof detail.formatter === 'function'
          ? detail.formatter(shown)
          : `${Number(shown.toPrecision(4))}${options.unit === undefined ? '%' : options.unit}`;
      const name = this.series.pointCount ? this.series.pointAt(0).name : undefined;
      if (name && options.title !== false) {
        this.setFont(theme.fontSize, theme.fontFamily);
        ctx.fillStyle = theme.subTextColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(name), cx, cy - (Number(detail.fontSize) || radius * 0.28) * 0.9 * unit);
      }
      const fontSize = isFinite(Number(detail.fontSize)) ? Number(detail.fontSize) : Math.max(14, radius * 0.42);
      this.setFont(fontSize * unit, theme.fontFamily, 'bold');
      ctx.fillStyle = options.textColor || theme.textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, cx, cy + (name ? fontSize * 0.18 * unit : 0));
    }

    this.endDraw();
  }
}
