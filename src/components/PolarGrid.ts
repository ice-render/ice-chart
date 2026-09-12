import { ChartComponent } from './ChartComponent';
import type { ChartTheme, PolarGridOption } from '../types';
import type { ChartLayout, Rect } from '../internal';
import type { Scale } from '../scale';

export interface PolarGridCoord {
  plot: Rect;
  /** 直角坐标的比例尺：极坐标网格画在直角坐标场景里（配合 aspect: 'equal'）。 */
  xScale: Scale;
  yScale: Scale;
  options: PolarGridOption;
}

/**
 * 极坐标网格：同心圆 + 角度辐条 + 角度刻度（MATLAB `polarplot` 的那套底图）。
 *
 * 为什么画在直角坐标场景里：`r(θ)` 曲线本身就是 `(r·cosθ, r·sinθ)` 的参数曲线，
 * 只要坐标轴等比（`aspect: 'equal'`），几何就是圆的；网格跟着同一套比例尺走即可，
 * 不需要再造一个极坐标场景（雷达图那套有指标轴，语义不同）。
 *
 * 圆心取 **比例尺映射后的原点**（不是绘图区中心）—— 数据域不对称时原点并不在中心。
 * 半径取「原点到最近一条绘图区边界的距离」，保证同心圆始终完整落在绘图区内。
 */
export class PolarGrid extends ChartComponent {
  public coord: PolarGridCoord | null = null;
  public theme: ChartTheme | null = null;
  public layout: ChartLayout | null = null;

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
  }

  /** 网格半径（数据单位）与圆心像素：半径 = 原点到最近边界。 */
  private geometry(): { cx: number; cy: number; radiusPx: number; rMax: number } | null {
    const coord = this.coord;
    if (!coord) return null;
    const { plot } = coord;
    // 比例尺映射到的是「绘图区本地坐标」（0..plot.width），而本组件是覆盖层
    // —— 盒 = 整块画布、本地坐标就是图表坐标，所以要补上 plot 偏移。
    // （这条踩过：不加偏移，网格会整块画到绘图区左上角外面去。）
    const cx = plot.x + coord.xScale.map(0);
    const cy = plot.y + coord.yScale.map(0);
    if (!isFinite(cx) || !isFinite(cy)) return null;
    // 原点到四条边界的像素距离，取最小 —— 这样圆不会被切掉
    const radiusPx = Math.min(
      Math.abs(cx - plot.x),
      Math.abs(plot.x + plot.width - cx),
      Math.abs(cy - plot.y),
      Math.abs(plot.y + plot.height - cy)
    );
    if (!(radiusPx > 1)) return null;
    // 同样的距离换算回数据单位（等比坐标下 x/y 一致）
    const unitX = coord.xScale.map(1) - coord.xScale.map(0);
    const rMax = Math.abs(unitX) > 1e-9 ? radiusPx / Math.abs(unitX) : 0;
    return { cx, cy, radiusPx, rMax };
  }

  protected doRender(): void {
    const coord = this.coord;
    const theme = this.theme;
    if (!coord || !theme || coord.options.show === false) return;
    const geo = this.geometry();
    if (!geo) return;
    const { cx, cy, radiusPx, rMax } = geo;
    const options = coord.options;
    const splits = Math.max(1, Math.min(12, Number(options.splitNumber) || 4));
    const spokes = Math.max(4, Math.min(36, Number(options.spokeCount) || 12));
    const startAngle = ((Number(options.startAngle) || 0) * Math.PI) / 180;
    const unit = this.unit();
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.save();
    ctx.lineWidth = unit;
    ctx.strokeStyle = theme.splitLineColor;

    // 同心圆
    for (let ring = 1; ring <= splits; ring++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (radiusPx * ring) / splits, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 辐条
    ctx.beginPath();
    for (let i = 0; i < spokes; i++) {
      const angle = startAngle + (i / spokes) * Math.PI * 2;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * radiusPx, cy + Math.sin(angle) * radiusPx);
    }
    ctx.stroke();

    // 半径刻度（0..rMax），画在右下 45° 方向上
    if (options.showLabels !== false && rMax > 0) {
      const labelAngle = startAngle + Math.PI / 4;
      const dx = Math.cos(labelAngle);
      const dy = Math.sin(labelAngle);
      this.setFont(theme.fontSize, theme.fontFamily);
      ctx.fillStyle = theme.subTextColor;
      ctx.textBaseline = 'middle';
      for (let ring = 1; ring <= splits; ring++) {
        const r = (rMax * ring) / splits;
        const x = cx + dx * ((radiusPx * ring) / splits);
        const y = cy + dy * ((radiusPx * ring) / splits);
        ctx.textAlign = dx >= 0 ? 'left' : 'right';
        const text = Math.abs(r) >= 1 ? String(Number(r.toPrecision(3))) : String(Number(r.toPrecision(2)));
        ctx.strokeStyle = theme.backgroundColor === 'transparent' ? '#ffffff' : theme.backgroundColor;
        ctx.lineWidth = 3 * unit;
        ctx.strokeText(text, x + dx * 3 * unit, y + dy * 3 * unit);
        ctx.fillText(text, x + dx * 3 * unit, y + dy * 3 * unit);
        ctx.strokeStyle = theme.splitLineColor;
        ctx.lineWidth = unit;
      }
    }

    ctx.restore();
  }
}
