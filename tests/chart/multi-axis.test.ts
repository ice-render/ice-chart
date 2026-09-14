import { createChart } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import { computeLayout } from '../../src/layout/layout';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const OPTION: ChartOption = {
  yAxis: [{ name: '成交量' }, { name: '涨跌幅(%)', type: 'linear' }],
  series: [
    { id: 'volume', type: 'bar', name: '成交量', data: [1200, 1350, 980, 1500] },
    { id: 'change', type: 'line', name: '涨跌幅', yAxisIndex: 1, data: [1.2, -0.8, 2.4, -1.6] },
  ],
};

describe('多 y 轴（纯函数层）', () => {
  it('binds each series to an axis and computes an independent domain', () => {
    const norm = normalizeOption(OPTION);
    expect(norm.yAxes).toHaveLength(2);
    expect(norm.series[0].axisIndex).toBe(0);
    expect(norm.series[1].axisIndex).toBe(1);
    // 主轴按柱形包含 0，副轴只包含涨跌幅
    expect(norm.yAxes[0].domain[0]).toBeLessThanOrEqual(0);
    expect(norm.yAxes[0].domain[1]).toBeGreaterThanOrEqual(1500);
    expect(norm.yAxes[1].domain[0]).toBeLessThan(0);
    expect(norm.yAxes[1].domain[1]).toBeLessThan(10);
  });

  it('assigns the first axis to the left and the rest to the right by default', () => {
    const norm = normalizeOption(OPTION);
    expect(norm.yAxes[0].position).toBe('left');
    expect(norm.yAxes[1].position).toBe('right');
  });

  it('honours an explicit position', () => {
    const norm = normalizeOption({
      yAxis: [{ position: 'right' }],
      series: [{ type: 'line', data: [1, 2, 3] }],
    });
    expect(norm.yAxes[0].position).toBe('right');
  });

  it('does not stack series that live on different axes', () => {
    const norm = normalizeOption({
      yAxis: [{}, {}],
      series: [
        { id: 'a', type: 'bar', stack: 'total', data: [1, 2] },
        { id: 'b', type: 'bar', stack: 'total', yAxisIndex: 1, data: [10, 20] },
      ],
    });
    expect(norm.series[1].points[0]).toMatchObject({ base: 0, top: 10 });
  });

  it('reserves space on both sides in the layout', () => {
    const norm = normalizeOption(OPTION);
    const layout = computeLayout(norm, null, { x: 0, y: 0, width: 800, height: 400 });
    expect(layout.yAxes).toHaveLength(2);
    expect(layout.yAxes[0].offset).toBe(0);
    expect(layout.yAxes[1].offset).toBe(0);
    // 右轴占用空间 → 绘图区右边界内缩
    const single = computeLayout(
      normalizeOption({ yAxis: { name: '成交量' }, series: OPTION.series.slice(0, 1) }),
      null,
      { x: 0, y: 0, width: 800, height: 400 }
    );
    expect(layout.plot.width).toBeLessThan(single.plot.width);
  });

  it('offsets axes that sit on the same side', () => {
    const norm = normalizeOption({
      yAxis: [{}, {}],
      series: [
        { type: 'line', data: [1, 2, 3] },
        { type: 'line', yAxisIndex: 1, data: [100, 200, 300] },
      ],
    });
    // 第二个轴显式放到左边
    norm.yAxes[1].position = 'left';
    const layout = computeLayout(norm, null, { x: 0, y: 0, width: 800, height: 400 });
    expect(layout.yAxes[1].offset).toBeGreaterThan(0);
  });
});

describe('多 y 轴（引擎集成）', () => {
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

  it('creates one axis component per y axis and renders both scales', async () => {
    chart = createChart(canvas, OPTION);
    await chart.render();
    expect(chart.axisYList).toHaveLength(2);
    expect(chart.axisYList[0].position).toBe('left');
    expect(chart.axisYList[1].position).toBe('right');
    // 两个系列的像素位置分别由各自的比例尺决定
    const plotHeight = chart.layout.plot.height;
    const volume = chart.seriesComponents[0];
    const change = chart.seriesComponents[1];
    // 柱形：检查真实几何（柱顶在画面上部、柱底落在 0 基线），而不是锚点位置
    const rect = (volume as any).barRectAt(0)!;
    expect(rect.y).toBeLessThan(plotHeight * 0.3);
    expect(rect.y + rect.height).toBeCloseTo(plotHeight, 0);
    // 折线：涨跌幅 -1.6 贴近底部（域含 5% 留白，所以不是「贴到边上」而是「压在下部」）
    expect(change.pixelAt(3)![1]).toBeGreaterThan(plotHeight * 0.85);
    expect(chart.norm.yAxes[0].scale!.map(1200)).not.toBeCloseTo(chart.norm.yAxes[1].scale!.map(1200), 0);
  });

  it('keeps a stable axis component when the option is re-applied', async () => {
    chart = createChart(canvas, OPTION);
    await chart.render();
    const first = chart.axisYList[1];
    chart.setOption({ ...OPTION });
    await chart.render();
    expect(chart.axisYList[1]).toBe(first);
  });

  it('supports an independent data window per axis', async () => {
    chart = createChart(canvas, OPTION);
    await chart.render();
    chart.setAxisDomain(1, [-2, 3]);
    expect(chart.getAxisDomain(1)).toEqual([-2, 3]);
    expect(chart.getAxisDomain(0)[1]).toBeGreaterThanOrEqual(1500);
  });

  it('drops axes when the option no longer declares them', async () => {
    chart = createChart(canvas, OPTION);
    await chart.render();
    chart.setOption({ series: [OPTION.series[0]] });
    await chart.render();
    expect(chart.axisYList).toHaveLength(1);
    expect(chart.norm.yAxes).toHaveLength(1);
  });

  it('keeps bars anchored to their category after zooming (no off-window bars)', async () => {
    chart = createChart(canvas, OPTION);
    await chart.render();
    const bars: any = chart.seriesComponents[0];
    const before = bars.barRectAt(0);
    expect(before).not.toBeNull();
    // 缩放到只保留后两个类目
    chart.setDomain('x', [2, 3]);
    await chart.render();
    // 窗口外的类目必须没有柱子（此前会用数据下标当类目下标，把柱子画到右轴上）
    expect(bars.barRectAt(0)).toBeNull();
    expect(bars.barRectAt(3)).not.toBeNull();
    const rect = bars.barRectAt(3)!;
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(chart.layout.plot.width + 0.5);
  });
});
