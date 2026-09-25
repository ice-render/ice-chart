import { SeriesBase } from './SeriesBase';
import { heatColorRange, mixColors } from './HeatmapSeries';
import type { Rect } from '../../internal';
import type { SeriesType } from '../../types';
import { calendarCellAt, calendarCellRect, type CalendarGrid } from '../../layout/calendar';

/**
 * 日历热力：一行一天的热力格（周为列、星期为行）。
 *
 * 自己画标签（左侧星期、顶部月份），不借坐标轴组件 —— 日历的「轴」是日历本身，
 * 套 x/y 轴组件只会得到两排无意义的刻度。命中是**反解**（两道除法 + 查表），与格数无关。
 */
export class CalendarSeries extends SeriesBase {
  public seriesType: SeriesType = 'calendar';
  protected supportsSampling = false;
  protected clipToBox = true;
  private cellsKey = '';
  private cellRects: Array<{ x: number; y: number; size: number }> = [];
  private byCell = new Map<string, number>();
  private valueExtent: [number, number] = [0, 1];

  private grid(): CalendarGrid | null {
    // 日历的排布在归一化里算好（纯函数、可单测），组件只读
    return (this.series as any).calendarGrid || null;
  }

  /** 画格子的区域（右侧不留白；左上给标签让出位置）。 */
  private cellArea(): Rect {
    const option: any = this.series.calendarOption || this.series.option.calendar || {};
    const left = option.weekdayLabels === false ? 4 : 30;
    const top = option.monthLabels === false ? 6 : 20;
    return {
      x: left,
      y: top,
      width: Math.max(1, (this.state.width || 0) - left - 6),
      height: Math.max(1, (this.state.height || 0) - top - 6),
    };
  }

  protected rebuildPixels(): void {
    const grid = this.grid();
    const coord = this.coord;
    if (!grid || !coord || !grid.cells.length) {
      this.cellRects = [];
      this.byCell.clear();
      this.pixels = new Float64Array(0);
      return;
    }
    const area = this.cellArea();
    const key = this.buildSeriesKey([grid.weeks, area.x, area.y, area.width, area.height]);
    if (key === this.cellsKey && this.cellRects.length === grid.cells.length) return;
    this.cellsKey = key;

    const rects: Array<{ x: number; y: number; size: number }> = new Array(grid.cells.length);
    this.byCell.clear();
    for (let i = 0; i < grid.cells.length; i++) {
      rects[i] = calendarCellRect(i, grid, area);
      this.byCell.set(`${grid.cells[i].week},${grid.cells[i].weekday}`, i);
    }
    this.cellRects = rects;
    if (this.pixels.length !== grid.cells.length * 2) this.pixels = new Float64Array(grid.cells.length * 2);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < grid.cells.length; i++) {
      this.pixels[i * 2] = rects[i].x + rects[i].size / 2;
      this.pixels[i * 2 + 1] = rects[i].y + rects[i].size / 2;
      const value = grid.cells[i].value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    this.valueExtent = isFinite(min) && isFinite(max) ? [min, max] : [0, 1];
    this.xMonotonic = false;
    this.renderIndices = null;
  }

  public hitTestIndex(localX: number, localY: number): number {
    const grid = this.grid();
    if (!grid) return -1;
    this.rebuildPixels();
    const cell = calendarCellAt(localX, localY, grid, this.cellArea());
    if (!cell) return -1;
    const index = this.byCell.get(`${cell.week},${cell.weekday}`);
    return index === undefined ? -1 : index;
  }

  private colorOf(value: number): string {
    const [min, max] = this.valueExtent;
    const ratio = max > min ? (value - min) / (max - min) : 1;
    const option: any = this.series.calendarOption || this.series.option.calendar || {};
    const range = heatColorRange({ minColor: option.minColor, maxColor: option.maxColor }, this.series.color);
    return mixColors(range.from, range.to, Math.max(0, Math.min(1, ratio)));
  }

  protected doRender(): void {
    const grid = this.grid();
    const coord = this.coord;
    if (!grid || !coord || !this.chartTheme) return;
    this.rebuildPixels();
    const option = this.series.option.calendar || {};
    const theme = this.chartTheme;
    const ctx = this.ctx;
    const unit = this.unit();
    const fontSize = Math.max(8, Math.min(11, theme.fontSize - 2));
    const entering = this.isEntering();
    const progress = entering ? this.progress() : 1;
    this.beginDraw();

    // 格子
    for (let i = 0; i < grid.cells.length; i++) {
      const rect = this.cellRects[i];
      if (!rect) continue;
      const size = entering ? rect.size * (0.3 + 0.7 * progress) : rect.size;
      const x = rect.x + (rect.size - size) / 2;
      const y = rect.y + (rect.size - size) / 2;
      ctx.beginPath();
      const radius = Math.max(1, Math.min(3, size * 0.25));
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + size - radius, y);
      ctx.quadraticCurveTo(x + size, y, x + size, y + radius);
      ctx.lineTo(x + size, y + size - radius);
      ctx.quadraticCurveTo(x + size, y + size, x + size - radius, y + size);
      ctx.lineTo(x + radius, y + size);
      ctx.quadraticCurveTo(x, y + size, x, y + size - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
      ctx.fillStyle = this.colorOf(grid.cells[i].value);
      ctx.fill();
      // 悬停：同一份几何叠一层描边（格子尺寸代表「一天」，不该随悬停变形）
      if (i === this.hoverIndex && this.hoverAlpha(i) > 0.01) {
        ctx.save();
        ctx.globalAlpha = this.hoverAlpha(i);
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = Math.max(unit, 2 * unit);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 标签
    ctx.fillStyle = theme.subTextColor;
    this.setFont(fontSize, theme.fontFamily);
    if (option.monthLabels !== false && grid.months.length) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const area = this.cellArea();
      const anchor = calendarCellRect(0, grid, area);
      for (const month of grid.months) {
        const x = anchor.x + month.week * (anchor.size + 2);
        if (x > area.x + area.width - fontSize) continue;
        ctx.fillText(month.label, x, area.y - fontSize * 0.9);
      }
    }
    if (option.weekdayLabels !== false) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const area = this.cellArea();
      const anchor = calendarCellRect(0, grid, area);
      // 只标周一 / 周三 / 周五：格子小小的，标满 7 行就是一片糊
      for (const weekday of [0, 2, 4]) {
        const y = anchor.y + weekday * (anchor.size + 2) + anchor.size / 2;
        if (y > area.y + area.height) continue;
        ctx.fillText(['一', '二', '三', '四', '五', '六', '日'][weekday], area.x - 6, y);
      }
    }
    this.endDraw();
  }
}
