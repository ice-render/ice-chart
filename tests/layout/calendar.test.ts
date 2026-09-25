import { buildCalendarGrid, calendarCellAt, calendarCellRect } from '../../src/layout/calendar';

/**
 * 日历热力的几何是纯函数：日期 → (第几周, 星期几) 的换算、格子排布、月份刻度都在这里钉死。
 * 日期一律按 **UTC 的 Y/M/D** 计算 —— 用本地时区会让 `2026-01-01` 在东八区和平球另一侧落到不同星期。
 */
describe('buildCalendarGrid', () => {
  it('按星期排布：周一起始时 2026-01-01（周四）在第 1 列', () => {
    const grid = buildCalendarGrid(
      [
        { date: '2026-01-01', value: 1 },
        { date: '2026-01-04', value: 4 },
        { date: '2026-01-05', value: 5 },
      ],
      { weekStart: 1 }
    );
    const byDate = new Map(grid.cells.map((cell) => [cell.date, cell]));
    expect(byDate.get('2026-01-01')!.week).toBe(0);
    expect(byDate.get('2026-01-01')!.weekday).toBe(3); // 周四（周一为 0）
    expect(byDate.get('2026-01-04')!.weekday).toBe(6); // 周日
    expect(byDate.get('2026-01-05')!.week).toBe(1);
    expect(byDate.get('2026-01-05')!.weekday).toBe(0);
  });

  it('周日起始（weekStart: 0）时同一批日期落在不同列', () => {
    const grid = buildCalendarGrid([{ date: '2026-01-01', value: 1 }], { weekStart: 0 });
    expect(grid.cells[0].weekday).toBe(4); // 周日为 0 时，周四是 4
  });

  it('周数与月份刻度：跨月时给每个月的第一周一个刻度', () => {
    const grid = buildCalendarGrid(
      [
        { date: '2026-01-20', value: 1 },
        { date: '2026-02-10', value: 2 },
        { date: '2026-03-02', value: 3 },
      ],
      { weekStart: 1 }
    );
    expect(grid.weeks).toBeGreaterThanOrEqual(6);
    expect(grid.months.map((month) => month.label)).toEqual(['1月', '2月', '3月']);
    // 每个刻度落在该月第一次出现的那一列
    for (const month of grid.months) {
      expect(month.week).toBeGreaterThanOrEqual(0);
      expect(month.week).toBeLessThan(grid.weeks);
    }
    expect(grid.months[0].week).toBeLessThan(grid.months[1].week);
  });

  it('同一天多次出现取和（一天一条是常态，容错不崩）', () => {
    const grid = buildCalendarGrid(
      [
        { date: '2026-01-05', value: 2 },
        { date: '2026-01-05', value: 3 },
        { date: '2026-01-06', value: 1 },
      ],
      { weekStart: 1 }
    );
    expect(grid.cells).toHaveLength(2);
    expect(grid.cells[0].value).toBe(5);
  });

  it('坏日期 / 非数值跳过，不抛异常', () => {
    const grid = buildCalendarGrid(
      [
        { date: '不是日期', value: 1 },
        { date: '2026-02-30', value: 2 },
        { date: '2026-01-05', value: Number.NaN },
        { date: '2026-01-06', value: 3 },
      ],
      { weekStart: 1 }
    );
    expect(grid.cells).toHaveLength(1);
    expect(grid.cells[0].date).toBe('2026-01-06');
  });

  it('空输入得到空格子（周数为 0）', () => {
    const grid = buildCalendarGrid([], { weekStart: 1 });
    expect(grid.cells).toHaveLength(0);
    expect(grid.weeks).toBe(0);
  });
});

describe('calendarCellRect', () => {
  const grid = buildCalendarGrid(
    [
      { date: '2026-01-05', value: 1 },
      { date: '2026-01-06', value: 2 },
      { date: '2026-03-30', value: 3 },
    ],
    { weekStart: 1 }
  );
  const rect = { x: 40, y: 20, width: 600, height: 200 };

  it('格子等比铺满：宽高由较短的一边决定，网格居中', () => {
    const cell = calendarCellRect(0, grid, rect);
    expect(cell.size).toBeGreaterThan(1);
    expect(cell.x).toBeGreaterThanOrEqual(rect.x);
    expect(cell.y).toBeGreaterThanOrEqual(rect.y);
    const last = calendarCellRect(grid.cells.length - 1, grid, rect);
    expect(last.x + last.size).toBeLessThanOrEqual(rect.x + rect.width + 0.5);
    expect(last.y + last.size).toBeLessThanOrEqual(rect.y + rect.height + 0.5);
  });

  it('格子均匀排布：同列的 y 间隔 = 格子尺寸 + 间隙', () => {
    const first = calendarCellRect(0, grid, rect);
    const second = calendarCellRect(1, grid, rect);
    const step = second.y - first.y;
    // 相邻两天（01-05 → 01-06）在同一列上下紧挨：间距 = 格子尺寸 + 2px 间隙
    expect(step).toBeGreaterThan(first.size);
    expect(step).toBeLessThan(first.size * 2);
    expect(second.x).toBeCloseTo(first.x, 6);
  });

  it('命中是反解：格心与缝隙都归到同一格，界外返回 null', () => {
    const target = grid.cells[1]; // 2026-01-06
    const rectOfCell = calendarCellRect(1, grid, rect);
    expect(calendarCellAt(rectOfCell.x + rectOfCell.size / 2, rectOfCell.y + rectOfCell.size / 2, grid, rect)).toEqual({
      week: target.week,
      weekday: target.weekday,
    });
    // 落在格子与格子之间（gap 里）也算这一格
    expect(calendarCellAt(rectOfCell.x + rectOfCell.size + 1, rectOfCell.y, grid, rect)).toEqual({
      week: grid.cells[1].week,
      weekday: grid.cells[1].weekday,
    });
    expect(calendarCellAt(rect.x - 50, rect.y - 50, grid, rect)).toBeNull();
  });
});
