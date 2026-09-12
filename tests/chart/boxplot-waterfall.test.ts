import { createChart } from '../../src/index';
import { normalizeOption, computeBoxplotSummary } from '../../src/option/normalize';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const BOXPLOT: ChartOption = {
  title: { text: '各渠道响应时长' },
  legend: { show: false },
  xAxis: { type: 'category' },
  yAxis: { name: '毫秒' },
  series: [
    {
      id: 'latency',
      type: 'boxplot',
      name: '响应时长',
      data: [
        [120, 200, 260, 340, 520],
        [90, 150, 210, 280, 610],
        [140, 230, 300, 380, 480],
      ],
    },
  ],
};

const WATERFALL: ChartOption = {
  title: { text: '利润构成' },
  legend: { show: false },
  xAxis: { type: 'category' },
  yAxis: { name: '万元' },
  waterfall: { increaseColor: '#198754', decreaseColor: '#dc3545', totalColor: '#0d6efd' },
  series: [
    {
      id: 'profit',
      type: 'waterfall',
      name: '利润',
      data: [
        { name: '营收', value: 1200 },
        { name: '成本', value: -420 },
        { name: '税费', value: -160 },
        { name: '其它', value: 90 },
        { name: '净利润', value: 0, total: true },
      ],
    },
  ],
};

describe('箱线图（纯函数层）', () => {
  it('accepts a five-number summary as-is', () => {
    const norm = normalizeOption(BOXPLOT);
    expect(norm.series[0].points[0].boxplot).toEqual([120, 200, 260, 340, 520]);
    // 数据点的值取中位数（提示框与键盘导航用）
    expect(norm.series[0].points[0].y).toBe(260);
  });

  it('treats arrays with more than 5 numbers as raw observations (not a summary)', () => {
    // 回归：曾经用 `tuple.length >= 5` 判断，40 个原始观测值被截成前 5 个当五数概括，
    // 结果 min/max 包不住四分位 —— 箱体错乱，悬停还点不中。
    const samples = Array.from({ length: 40 }, (_, i) => 100 + i * 3);
    const norm = normalizeOption({
      ...BOXPLOT,
      series: [{ id: 'raw', type: 'boxplot', name: '原始观测', data: [samples] as any }],
    });
    const summary = norm.series[0].points[0].boxplot!;
    expect(summary).toHaveLength(5);
    expect(summary[0]).toBe(100);
    expect(summary[4]).toBe(217);
    // 五数概括必须有序（min ≤ Q1 ≤ median ≤ Q3 ≤ max）
    for (let i = 1; i < 5; i++) expect(summary[i]).toBeGreaterThanOrEqual(summary[i - 1]);
    // 不是「取前 5 个原始值」（那样 max 会是 103 而不是 217）
    expect(norm.series[0].points[0].y).toBe(summary[2]);
  });

  it('computes quantiles from raw observations', () => {
    const summary = computeBoxplotSummary([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(summary[0]).toBe(1);
    expect(summary[4]).toBe(10);
    expect(summary[2]).toBeCloseTo(5.5, 6);
    expect(summary[1]).toBeCloseTo(3.25, 6);
    expect(summary[3]).toBeCloseTo(7.75, 6);
  });

  it('includes whiskers in the y domain', () => {
    const norm = normalizeOption(BOXPLOT);
    expect(norm.yAxis.domain[0]).toBeLessThanOrEqual(90);
    expect(norm.yAxis.domain[1]).toBeGreaterThanOrEqual(610);
  });
});

describe('瀑布图（纯函数层）', () => {
  it('derives base/top by cumulative sum and keeps totals flat', () => {
    const norm = normalizeOption(WATERFALL);
    const points = norm.series[0].points;
    expect(points[0]).toMatchObject({ base: 0, top: 1200 });
    expect(points[1]).toMatchObject({ base: 1200, top: 780 });
    expect(points[2]).toMatchObject({ base: 780, top: 620 });
    expect(points[3]).toMatchObject({ base: 620, top: 710 });
    // 合计项：从 0 画到累计值，且不改变累计
    expect(points[4]).toMatchObject({ base: 0, top: 710 });
  });

  it('uses a category axis and includes both ends of every bar in the domain', () => {
    const norm = normalizeOption(WATERFALL);
    expect(norm.xAxis.type).toBe('category');
    expect(norm.yAxis.domain[0]).toBeLessThanOrEqual(0);
    expect(norm.yAxis.domain[1]).toBeGreaterThanOrEqual(1200);
  });
});

describe('箱线图 / 瀑布图（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 720;
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

  it('draws a box per category and hits the whole whisker range', async () => {
    const c = await mount(BOXPLOT);
    const box: any = c.seriesComponents[0];
    const rect = box.boxRectAt(1)!;
    expect(rect.width).toBeGreaterThan(4);
    expect(rect.height).toBeGreaterThan(4);
    const sx = c.layout.plot.x + rect.x + rect.width / 2;
    // 中位线处命中
    const sy = c.layout.plot.y + rect.y + rect.height / 2;
    expect(c.ice.hitTest(sx, sy)).toBe(box);
    expect(c.controller.resolveTarget(sx, sy).index).toBe(1);
    // 须的末梢也在命中范围内
    const yScale: any = c.norm.yAxis.scale;
    const whiskerY = c.layout.plot.y + yScale.map(610);
    expect(c.controller.resolveTarget(sx, whiskerY).index).toBe(1);
  });

  it('shows the five-number summary in the tooltip', async () => {
    const c = await mount(BOXPLOT);
    const box: any = c.seriesComponents[0];
    const rect = box.boxRectAt(0)!;
    c.controller.handlePointerMove(c.layout.plot.x + rect.x + rect.width / 2, c.layout.plot.y + rect.y + rect.height / 2);
    const content = c.tooltip!.content!;
    expect(content.rows.map((r) => r.name)).toEqual(['最小值', '下四分位', '中位数', '上四分位', '最大值']);
    expect(content.rows[4].value).toBe('520');
  });

  it('renders waterfall bars with increase/decrease/total colours', async () => {
    const c = await mount(WATERFALL);
    const bars: any = c.seriesComponents[0];
    expect(bars.barColorAt(0).toLowerCase()).toBe('#198754');
    expect(bars.barColorAt(1).toLowerCase()).toBe('#dc3545');
    expect(bars.barColorAt(4).toLowerCase()).toBe('#0d6efd');
    // 每根柱子都落在绘图区内
    for (let i = 0; i < 5; i++) {
      const rect = bars.barRectAt(i)!;
      expect(rect.y).toBeGreaterThanOrEqual(-0.5);
      expect(rect.y + rect.height).toBeLessThanOrEqual(c.layout.plot.height + 0.5);
    }
  });

  it('reports delta and running total in the waterfall tooltip', async () => {
    const c = await mount(WATERFALL);
    const bars: any = c.seriesComponents[0];
    const rect = bars.barRectAt(1)!;
    c.controller.handlePointerMove(c.layout.plot.x + rect.x + rect.width / 2, c.layout.plot.y + rect.y + rect.height / 2);
    const content = c.tooltip!.content!;
    expect(content.title).toBe('成本');
    expect(content.rows[0]).toMatchObject({ name: '减少', value: '-420' });
    expect(content.rows[1]).toMatchObject({ name: '累计', value: '780' });
  });
});
