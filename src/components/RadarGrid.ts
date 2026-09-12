import { ChartComponent } from './ChartComponent';
import type { ChartTheme } from '../types';
import type { ChartLayout, PolarLayout, Rect } from '../internal';

export interface RadarGridCoord {
  polar: PolarLayout;
  plot: Rect;
  indicators: Array<{ name: string; max: number }>;
  shape: 'polygon' | 'circle';
  splitNumber: number;
}

/** 雷达图的网格：同心环 + 指标轴 + 指标名。 */
export class RadarGrid extends ChartComponent {
  public coord: RadarGridCoord | null = null;
  public theme: ChartTheme | null = null;
  public layout: ChartLayout | null = null;

  constructor(props: { width: number; height: number; zIndex?: number }) {
    super({ interactive: false, ...props });
  }

  protected doRender(): void {
    const coord = this.coord;
    const theme = this.theme;
    if (!coord || !theme) return;
    const ctx = this.ctx;
    const unit = this.unit();
    const n = coord.indicators.length;
    if (!n) return;
    // RadarGrid 的盒是整块画布（与坐标轴/图例同层），本地坐标即图表坐标，
    // 不能再减 plot.x/plot.y —— 只有「盒 = 极坐标外接正方形」的系列组件才需要减。
    const cx = coord.polar.cx;
    const cy = coord.polar.cy;
    const radius = coord.polar.radius;
    const angleOf = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2;
    void this.layout;
    ctx.beginPath();
    ctx.save();
    ctx.lineWidth = unit;
    ctx.strokeStyle = theme.splitLineColor;

    // 同心环
    for (let ring = 1; ring <= coord.splitNumber; ring++) {
      const r = (radius * ring) / coord.splitNumber;
      ctx.beginPath();
      if (coord.shape === 'circle') {
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
      } else {
        for (let i = 0; i < n; i++) {
          const a = angleOf(i);
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      ctx.stroke();
    }

    // 指标轴
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = angleOf(i);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    }
    ctx.stroke();

    // 指标名
    this.setFont(theme.fontSize, theme.fontFamily);
    ctx.fillStyle = theme.subTextColor;
    ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const a = angleOf(i);
      const x = cx + Math.cos(a) * (radius + 10 * unit);
      const y = cy + Math.sin(a) * (radius + 10 * unit);
      const cos = Math.cos(a);
      ctx.textAlign = Math.abs(cos) < 0.2 ? 'center' : cos > 0 ? 'left' : 'right';
      ctx.fillText(coord.indicators[i].name, x, y);
    }
    ctx.restore();
  }
}
