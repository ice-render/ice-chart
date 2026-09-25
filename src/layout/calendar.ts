import type { Rect } from '../internal';

/**
 * 日历热力的排布（纯函数）：日期 → 「第几周 / 星期几」，以及格子在绘图区里的落点。
 *
 * 两条纪律：
 * 1. **日期一律按 UTC 的 Y/M/D 计算**。用本地时间会让同一份「2026-01-01」在东八区和西五区
 *    落到不同的星期（甚至不同的周），跨时区看到的图不一样 —— 日历图的日期是**标签**，不是时刻。
 * 2. 格子等比：宽高由较短的一边决定，整块网格在绘图区里居中；否则窄卡片里的日历会被拉成面条。
 */

export interface CalendarCell {
  /** 统一成 `YYYY-MM-DD`。 */
  date: string;
  /** 第几周（0 起）。 */
  week: number;
  /** 星期几（0 = 每周的第一天，由 `weekStart` 决定）。 */
  weekday: number;
  /** 这一天聚合后的值（同一天多次出现取和）。 */
  value: number;
}

export interface CalendarGrid {
  cells: CalendarCell[];
  weeks: number;
  /** 每个月的第一个格子所在列 + 标签（画在顶部）。 */
  months: Array<{ week: number; label: string }>;
  /** 供提示框用的日期区间（首尾格）。 */
  start: string;
  end: string;
}

export interface CalendarOptions {
  /** 一周从哪天开始：0 = 周日，1 = 周一（默认）。 */
  weekStart?: 0 | 1;
}

interface PointLike {
  date: any;
  value: any;
}

/** `YYYY-MM-DD` → 当天 0 点的 UTC 时间戳；不合法返回 null。 */
function parseDay(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const stamp = Date.UTC(year, month - 1, day);
    const check = new Date(stamp);
    // 2026-02-30 这种会被 Date 顺延到下个月：回读一遍，对不上就是不合法
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return stamp;
  }
  const stamp = Date.parse(text);
  if (!isFinite(stamp)) return null;
  const date = new Date(stamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function toStamp(stamp: number): string {
  const date = new Date(stamp);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/** 把任意日期写法规范成 `YYYY-MM-DD`；不合法返回 null（归一化侧用它对齐格子，O(1)）。 */
export function normalizeCalendarDate(value: any): string | null {
  const stamp = parseDay(value);
  return stamp === null ? null : toStamp(stamp);
}

export function buildCalendarGrid(points: PointLike[], options: CalendarOptions = {}): CalendarGrid {
  const weekStart = options.weekStart === 0 ? 0 : 1;
  const totals = new Map<number, number>();
  for (const point of points || []) {
    const stamp = parseDay(point && point.date);
    if (stamp === null) continue;
    const value = Number(point.value);
    if (!isFinite(value)) continue;
    totals.set(stamp, (totals.get(stamp) || 0) + value);
  }
  const stamps = [...totals.keys()].sort((a, b) => a - b);
  if (!stamps.length) {
    return { cells: [], weeks: 0, months: [], start: '', end: '' };
  }

  const first = stamps[0];
  const firstWeekday = (new Date(first).getUTCDay() - weekStart + 7) % 7;
  const cells: CalendarCell[] = [];
  const months: Array<{ week: number; label: string }> = [];
  let lastMonth = -1;
  let maxWeek = 0;
  for (const stamp of stamps) {
    const date = new Date(stamp);
    const offset = Math.round((stamp - first) / 86400000) + firstWeekday;
    const week = Math.floor(offset / 7);
    const weekday = offset % 7;
    maxWeek = Math.max(maxWeek, week);
    const month = date.getUTCMonth();
    if (month !== lastMonth) {
      lastMonth = month;
      // 每个月只留第一个刻度；同一列已经被上个月的刻度占了就不重复放
      if (!months.length || months[months.length - 1].week < week) {
        months.push({ week, label: `${month + 1}月` });
      } else {
        months[months.length - 1] = { week, label: `${month + 1}月` };
      }
    }
    cells.push({ date: toStamp(stamp), week, weekday, value: totals.get(stamp) as number });
  }
  return { cells, weeks: maxWeek + 1, months, start: toStamp(first), end: toStamp(stamps[stamps.length - 1]) };
}

export interface CalendarCellRect {
  x: number;
  y: number;
  size: number;
}

/**
 * 局部坐标 → 格子（O(1)：先反解出「第几列 / 第几行」，再查表）。
 *
 * 命中必须是常数时间：一年 365 个格子逐年扫也能用，但「多年 + 多系列」叠起来就是每帧几千次比较，
 * 而这里本来就是两道除法。
 */
export function calendarCellAt(
  x: number,
  y: number,
  grid: CalendarGrid,
  area: Rect,
  gap = 2
): { week: number; weekday: number } | null {
  const columns = Math.max(1, grid.weeks);
  const rows = 7;
  const size = Math.max(
    3,
    Math.min((area.width - gap * (columns - 1)) / columns, (area.height - gap * (rows - 1)) / rows)
  );
  const gridWidth = size * columns + gap * (columns - 1);
  const gridHeight = size * rows + gap * (rows - 1);
  const originX = area.x + (area.width - gridWidth) / 2;
  const originY = area.y + (area.height - gridHeight) / 2;
  const step = size + gap;
  const week = Math.floor((x - originX) / step);
  const weekday = Math.floor((y - originY) / step);
  if (week < 0 || week >= columns || weekday < 0 || weekday >= rows) return null;
  // 落在格子之间的缝隙里也算这一格（2px 的缝不该让指针「点空」）
  return { week, weekday };
}

/** 第 `index` 个格子在绘图区里的落点（等比、居中）。 */
export function calendarCellRect(index: number, grid: CalendarGrid, area: Rect, gap = 2): CalendarCellRect {
  const columns = Math.max(1, grid.weeks);
  const rows = 7;
  const size = Math.max(
    3,
    Math.min((area.width - gap * (columns - 1)) / columns, (area.height - gap * (rows - 1)) / rows)
  );
  const gridWidth = size * columns + gap * (columns - 1);
  const gridHeight = size * rows + gap * (rows - 1);
  const originX = area.x + (area.width - gridWidth) / 2;
  const originY = area.y + (area.height - gridHeight) / 2;
  const cell = grid.cells[index];
  if (!cell) return { x: originX, y: originY, size };
  return {
    x: originX + cell.week * (size + gap),
    y: originY + cell.weekday * (size + gap),
    size,
  };
}
