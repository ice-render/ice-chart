import { createChart } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/** 2026 年 1 月（周一起始）：01-01 周四 → 第一列从周一开始，01-05 进第 2 列。 */
const CALENDAR: ChartOption = {
  legend: { show: false },
  animation: { enabled: false },
  calendar: { weekStart: 1 },
  series: [
    {
      id: 'activity',
      type: 'calendar',
      name: '提交',
      data: [
        { date: '2026-01-01', value: 3 },
        { date: '2026-01-05', value: 12 },
        { date: '2026-01-06', value: 1 },
        { date: '2026-03-30', value: 7 },
      ],
    },
  ],
};

describe('日历热力（集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 760;
    canvas.height = 420;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  async function mount(option: ChartOption): Promise<ICEChart> {
    chart = createChart(canvas, option);
    await chart.render();
    return chart;
  }

  it('归一化把日期落到格子上：每周一列、每天一格，跨月仍连续', () => {
    const norm = normalizeOption(CALENDAR);
    expect(norm.kind).toBe('calendar');
    expect(norm.calendar).toBeTruthy();
    const grid = norm.calendar!.grid;
    expect(grid.months.map((month) => month.label)).toEqual(['1月', '3月']);
    const first = norm.series[0].pointAt(0).calendar!;
    const second = norm.series[0].pointAt(1).calendar!;
    expect(first.date).toBe('2026-01-01');
    expect(first.weekday).toBe(3);
    expect(second.week).toBe(first.week + 1);
    expect(second.weekday).toBe(0);
  });

  it('每个格子有自己的像素锚点，点中格心命中那一天', async () => {
    const c = await mount(CALENDAR);
    const calendar: any = c.seriesComponents[0];
    for (let index = 0; index < 4; index++) {
      const center = calendar.pixelAt(index)!;
      expect(calendar.hitTestIndex(center[0], center[1])).toBe(index);
    }
    // 空白处（画布角落）不命中
    expect(calendar.hitTestIndex(0, 0)).toBe(-1);
  });

  it('提示框给日期与数值', async () => {
    const c = await mount({ ...CALENDAR, tooltip: { trigger: 'item' } });
    const calendar: any = c.seriesComponents[0];
    const center = calendar.pixelAt(1)!;
    c.controller.handlePointerMove(c.layout.plot.x + center[0], c.layout.plot.y + center[1]);
    const content = c.tooltip!.content!;
    expect(content.title).toBe('2026-01-05');
    expect(content.rows[0].value).toBe('12');
  });

  it('日历不吃坐标轴：坐标轴组件不显示，绘图区也不为轴留白', async () => {
    const c = await mount(CALENDAR);
    expect((c as any).axisX.state.display).toBe(false);
    expect((c as any).axisYList[0].state.display).toBe(false);
    // 绘图区几乎铺满画布（只留标题与边距）
    expect(c.layout.plot.width).toBeGreaterThan(canvas.width * 0.85);
  });
});
