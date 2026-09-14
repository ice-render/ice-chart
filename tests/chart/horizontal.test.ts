import { createChart } from '../../src/index';
import { normalizeOption, isHorizontalLayout } from '../../src/option/normalize';
import { computeLayout } from '../../src/layout/layout';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/** 排行榜写法：类目由 yAxis.data 提供，数据只给数值。 */
const RANKING: ChartOption = {
  title: { text: '区域销售额' },
  legend: { show: false },
  xAxis: { type: 'value', name: '万元' },
  yAxis: { type: 'category', data: ['华东', '华北', '华南', '西南', '西北'] },
  series: [{ id: 'sales', type: 'bar', name: '销售额', data: [320, 302, 301, 334, 390] }],
};

/** 分组横向柱状图：类目在数据里（对象 name），yAxis 只声明类型。 */
const GROUPED: ChartOption = {
  legend: { show: true, position: 'top' },
  xAxis: { type: 'value' },
  yAxis: { type: 'category' },
  series: [
    {
      id: 'q1',
      type: 'bar',
      name: 'Q1',
      data: [
        { name: '华东', value: 120 },
        { name: '华北', value: 90 },
      ],
    },
    {
      id: 'q2',
      type: 'bar',
      name: 'Q2',
      data: [
        { name: '华东', value: 160 },
        { name: '华北', value: 140 },
      ],
    },
  ],
};

describe('横向柱状图（纯函数层）', () => {
  it('detects the horizontal layout from a category y axis', () => {
    expect(isHorizontalLayout({ type: 'value' }, { type: 'category' })).toBe(true);
    expect(isHorizontalLayout({ type: 'category' }, { type: 'value' })).toBe(false);
    expect(isHorizontalLayout({ type: 'value' }, { type: 'value' })).toBe(false);
    expect(isHorizontalLayout({}, { data: ['A', 'B'] })).toBe(true);
  });

  it('puts categories on the y axis and values on the x axis', () => {
    const norm = normalizeOption(RANKING);
    expect(norm.orientation).toBe('horizontal');
    expect(norm.xAxis.type).toBe('linear');
    expect(norm.yAxes[0].type).toBe('category');
    expect(norm.yAxes[0].domain).toEqual(['华东', '华北', '华南', '西南', '西北']);
    // x 轴数据域来自「数值」而不是类目
    expect(norm.xAxis.domain[0]).toBeLessThanOrEqual(0);
    expect(norm.xAxis.domain[1]).toBeGreaterThanOrEqual(390);
  });

  it('aligns data items to the axis categories by index', () => {
    const norm = normalizeOption(RANKING);
    expect(norm.series[0].points.map((p) => p.xValue)).toEqual(['华东', '华北', '华南', '西南', '西北']);
    expect(norm.series[0].points.map((p) => p.y)).toEqual([320, 302, 301, 334, 390]);
  });

  it('defaults the tooltip to item trigger for horizontal charts', () => {
    const norm = normalizeOption(RANKING);
    expect(norm.option.tooltip.trigger).toBe('item');
  });

  it('takes categories from the data when the axis does not declare them', () => {
    const norm = normalizeOption(GROUPED);
    expect(norm.orientation).toBe('horizontal');
    expect(norm.yAxes[0].domain).toEqual(['华东', '华北']);
  });

  it('uses category label width for the y axis reserve', () => {
    const layout = computeLayout(normalizeOption(RANKING), null, { x: 0, y: 0, width: 600, height: 400 });
    // 类目「华东」等比数值刻度更宽，左侧留白相应更大
    const narrow = computeLayout(
      normalizeOption({ ...RANKING, yAxis: { type: 'category', data: ['A', 'B'] } }),
      null,
      { x: 0, y: 0, width: 600, height: 400 }
    );
    expect(layout.plot.x).toBeGreaterThan(narrow.plot.x);
  });
});

describe('横向柱状图（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 700;
    canvas.height = 400;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  async function mount(option: ChartOption = RANKING): Promise<ICEChart> {
    chart = createChart(canvas, option);
    await chart.render();
    return chart;
  }

  it('lays bars out along the category axis and lengths them by value', async () => {
    const c = await mount();
    const bars: any = c.seriesComponents[0];
    const first = bars.barRectAt(0)!;
    const last = bars.barRectAt(4)!;
    // 类目轴和数值轴一样「向上生长」：第一个类目在最下方（与主流写法一致）
    expect(first.y).toBeGreaterThan(last.y);
    // 长度随数值：390 > 320
    expect(last.width).toBeGreaterThan(first.width);
    // 都从 0 基线开始（左端对齐）
    expect(first.x).toBeCloseTo(last.x, 0);
    expect(first.x).toBeGreaterThanOrEqual(0);
  });

  it('hits a bar and reports the category as the tooltip title', async () => {
    const c = await mount();
    const bars: any = c.seriesComponents[0];
    const rect = bars.barRectAt(4)!;
    const sx = c.layout.plot.x + rect.x + rect.width / 2;
    const sy = c.layout.plot.y + rect.y + rect.height / 2;
    expect(c.ice.hitTest(sx, sy)).toBe(bars);
    expect(c.controller.resolveTarget(sx, sy).index).toBe(4);

    c.controller.handlePointerMove(sx, sy);
    expect(c.tooltip!.content!.title).toBe('西北');
    expect(c.tooltip!.content!.rows[0]).toMatchObject({ name: '销售额', value: '390' });
    // 横向图不做十字准星
    expect(c.crosshair!.pixelX).toBeNull();
  });

  it('groups multiple series into the same category band', async () => {
    const c = await mount(GROUPED);
    const q1: any = c.seriesComponents[0];
    const q2: any = c.seriesComponents[1];
    const a = q1.barRectAt(0)!;
    const b = q2.barRectAt(0)!;
    // 同组两根柱子在同一个类目带里上下错开，且不重叠
    expect(Math.abs(a.y - b.y)).toBeGreaterThan(0);
    expect(a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5).toBe(true);
  });

  it('keeps every bar inside the plot box (including the bottom-most category)', async () => {
    const c = await mount();
    const bars: any = c.seriesComponents[0];
    const plot = c.layout.plot;
    for (let i = 0; i < 5; i++) {
      const rect = bars.barRectAt(i)!;
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.height).toBeLessThanOrEqual(plot.height + 0.001);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(plot.width + 0.001);
    }
  });

  it('keeps grouped bars inside their own band', async () => {
    const c = await mount(GROUPED);
    const q1: any = c.seriesComponents[0];
    const q2: any = c.seriesComponents[1];
    const yScale: any = c.norm.yAxes[0].scale;
    for (let i = 0; i < 2; i++) {
      for (const rect of [q1.barRectAt(i)!, q2.barRectAt(i)!]) {
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.y + rect.height).toBeLessThanOrEqual(c.layout.plot.height + 0.001);
        expect(rect.height).toBeLessThanOrEqual(yScale.bandwidth() + 0.001);
      }
    }
  });
});
