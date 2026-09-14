import { CHART_PALETTE } from '../../theme/chartTheme';
import { BarSeries } from './BarSeries';
import type { SeriesType } from '../../types';

/**
 * 瀑布图：在柱状图之上做两件事 ——
 * 1. 每根柱子的颜色按「增 / 减 / 合计」区分；
 * 2. 相邻柱子之间画一条连接虚线，标出累计值的传递。
 *
 * base/top 的累计在归一化阶段算好（见 applyWaterfall），所以几何直接复用柱状图。
 */
export class WaterfallSeries extends BarSeries {
  public seriesType: SeriesType = 'waterfall';

  private isTotalItem(index: number): boolean {
    const raw: any = this.series.points[index] && this.series.points[index].raw;
    return !!(raw && typeof raw === 'object' && !Array.isArray(raw) && raw.total);
  }

  private isIncrease(index: number): boolean {
    const point = this.series.points[index];
    return point ? (point.y || 0) >= 0 : true;
  }

  /** 每根柱子的颜色：增（success）/ 减（danger）/ 合计（primary），可配置。 */
  protected barColorAt(index: number): string {
    const option: any = waterfallOptionOf(this.series);
    const theme = this.chartTheme;
    const palette = (theme && theme.colorPalette) || CHART_PALETTE;
    if (this.isTotalItem(index)) return option.totalColor || palette[0];
    return this.isIncrease(index) ? option.increaseColor || palette[1] : option.decreaseColor || palette[2];
  }

  protected doRender(): void {
    super.doRender();
    const option: any = waterfallOptionOf(this.series);
    if (option.connector === false) return;
    const coord = this.coord;
    if (!coord) return;
    const ctx = this.ctx;
    const unit = this.unit();
    const theme = this.chartTheme;
    const isHorizontal = (coord.yScale as any).isBand && (coord.yScale as any).isBand();
    ctx.save();
    ctx.strokeStyle = (theme && theme.subTextColor) || '#6C757D';
    ctx.lineWidth = unit;
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([4 * unit, 3 * unit]);
    ctx.beginPath();
    for (let i = 0; i < this.series.points.length - 1; i++) {
      const current = this.barRectAt(i);
      const next = this.barRectAt(i + 1);
      if (!current || !next) continue;
      if (isHorizontal) {
        // 横向：连接线在「当前柱子的值端」与下一根的起点之间（同一 y 带内不画）
        const level = Math.max(current.x + current.width, next.x + next.width);
        const y0 = current.y + current.height / 2;
        const y1 = next.y + next.height / 2;
        ctx.moveTo(level, y0);
        ctx.lineTo(level, y1);
      } else {
        // 纵向：从当前柱子的值端水平连到下一根的起点
        const level = Math.min(current.y, next.y);
        const x0 = current.x + current.width / 2;
        const x1 = next.x + next.width / 2;
        ctx.moveTo(x0, level);
        ctx.lineTo(x1, level);
      }
    }
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    ctx.restore();
  }
}

/**
 * 取本系列的瀑布配置：归一化时已经把「系列级优先，其次顶层 `option.waterfall`」解析好，
 * 这里再兜一层系列自身的字段（直接 new 出系列组件、没走归一化的场景）。
 */
function waterfallOptionOf(series: any): any {
  if (series && series.waterfallOption) return series.waterfallOption;
  return (series && series.option && series.option.waterfall) || {};
}
