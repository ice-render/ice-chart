import { createChart } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import { computeLayout } from '../../src/layout/layout';
import { mixColors } from '../../src/components/series/HeatmapSeries';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const CANDLE_OPTION: ChartOption = {
  title: { text: '日 K' },
  legend: { show: false },
  xAxis: { type: 'category' },
  yAxis: { name: '价格' },
  series: [
    {
      id: 'k',
      type: 'candlestick',
      name: 'K 线',
      data: [
        [100, 110, 95, 115],
        [110, 105, 100, 118],
        [105, 120, 102, 125],
      ],
    },
  ],
};

const HEATMAP_OPTION: ChartOption = {
  title: { text: '时段热度' },
  legend: { show: false },
  xAxis: { type: 'category' },
  yAxis: { type: 'category' },
  series: [
    {
      id: 'heat',
      type: 'heatmap',
      name: '热度',
      data: [
        ['周一', '上午', 10],
        ['周一', '下午', 30],
        ['周二', '上午', 50],
        ['周二', '下午', 90],
      ],
    },
  ],
};

describe('K 线（纯函数层）', () => {
  it('parses [open, close, low, high] and includes wicks in the y domain', () => {
    const norm = normalizeOption(CANDLE_OPTION);
    expect(norm.xAxis.type).toBe('category');
    const point = norm.series[0].points[0];
    expect(point.ohlc).toEqual([100, 110, 95, 115]);
    expect(point.y).toBe(110);
    expect(norm.yAxis.domain[0]).toBeLessThanOrEqual(95);
    expect(norm.yAxis.domain[1]).toBeGreaterThanOrEqual(125);
  });
});

describe('热力图（纯函数层）', () => {
  it('turns the second data field into a category y axis', () => {
    const norm = normalizeOption(HEATMAP_OPTION);
    expect(norm.xAxis.type).toBe('category');
    expect(norm.yAxes[0].type).toBe('category');
    expect(norm.yAxes[0].domain).toEqual(['上午', '下午']);
    expect(norm.xAxis.domain).toEqual(['周一', '周二']);
  });

  it('interpolates between the configured colours', () => {
    expect(mixColors('#000000', '#ffffff', 0)).toBe('rgb(0,0,0)');
    expect(mixColors('#000000', '#ffffff', 1)).toBe('rgb(255,255,255)');
    expect(mixColors('#000000', '#ffffff', 0.5)).toBe('rgb(128,128,128)');
  });

  it('reserves band space for both axes', () => {
    const norm = normalizeOption(HEATMAP_OPTION);
    const layout = computeLayout(norm, null, { x: 0, y: 0, width: 600, height: 400 });
    expect(layout.plot.width).toBeGreaterThan(200);
    expect(layout.plot.height).toBeGreaterThan(150);
  });
});

describe('K 线 / 热力图（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 400;
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

  it('hits a candlestick inside its wick range and shows OHLC in the tooltip', async () => {
    const c = await mount(CANDLE_OPTION);
    const component = c.seriesComponents[0];
    const pixel = component.pixelAt(1)!;
    const sx = c.layout.plot.x + pixel[0];
    const sy = c.layout.plot.y + pixel[1];
    expect(c.ice.hitTest(sx, sy)).toBe(component);
    expect(c.controller.resolveTarget(sx, sy).index).toBe(1);

    c.controller.handlePointerMove(sx, sy);
    const content = c.tooltip!.content!;
    expect(content.rows.map((r) => r.name)).toEqual(['开盘', '收盘', '最低', '最高']);
    expect(content.rows[0].value).toBe('110');
  });

  it('misses a candlestick well above its high', async () => {
    const c = await mount(CANDLE_OPTION);
    const component = c.seriesComponents[0];
    const pixel = component.pixelAt(0)!;
    const target = c.controller.resolveTarget(c.layout.plot.x + pixel[0], c.layout.plot.y + 2);
    expect(target.index).toBe(-1);
  });

  it('hits a heatmap cell and reports its category pair', async () => {
    const c = await mount(HEATMAP_OPTION);
    const component = c.seriesComponents[0];
    const pixel = component.pixelAt(2)!;
    const sx = c.layout.plot.x + pixel[0];
    const sy = c.layout.plot.y + pixel[1];
    expect(c.ice.hitTest(sx, sy)).toBe(component);
    const target = c.controller.resolveTarget(sx, sy);
    expect(target.index).toBe(2);

    c.controller.handlePointerMove(sx, sy);
    expect(c.tooltip!.content!.title).toBe('上午');
    expect(c.tooltip!.content!.rows[0].value).toBe('50');
  });

  it('renders heatmap cells covering the band area', async () => {
    const c = await mount(HEATMAP_OPTION);
    const xScale: any = c.norm.xAxis.scale;
    const yScale: any = c.norm.yAxes[0].scale;
    expect(xScale.bandwidth()).toBeGreaterThan(1);
    expect(yScale.bandwidth()).toBeGreaterThan(1);
  });
});
