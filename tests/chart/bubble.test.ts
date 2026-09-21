import { createChart } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import { ScatterSeries } from '../../src/components/series/ScatterSeries';
import { LinearScale } from '../../src/scale/LinearScale';
import { resolveChartTheme } from '../../src/theme/chartTheme';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';
import type { DataPoint, InternalSeries } from '../../src/internal';
import { arrayAccessors } from '../../src/internal';

const BUBBLE: ChartOption = {
  title: { text: '城市 GDP / 人口' },
  legend: { show: false },
  xAxis: { type: 'value', name: '人口(万)' },
  yAxis: { type: 'value', name: 'GDP(亿)' },
  series: [
    {
      id: 'city',
      type: 'scatter',
      name: '城市',
      symbolSizeRange: [10, 50],
      data: [
        [500, 1200, 8],
        [1200, 3200, 25],
        [2400, 4800, 60],
        [800, 900, 3],
      ],
    },
  ],
};

function makeSeries(values: number[], extra: any = {}): InternalSeries {
  const points: DataPoint[] = values.map((y, i) => ({ index: i, xValue: i, y, raw: y, base: 0, top: y }));
  return {
    id: 's',
    index: 0,
    type: 'scatter',
    name: 'S',
    color: '#0D6EFD',
    option: { type: 'scatter', data: values, ...extra },
    points,
    pointCount: points.length,
    ...arrayAccessors(points),
    hasExplicitX: false,
    hidden: false,
    axisIndex: 0,
  };
}

describe('气泡图（纯函数层）', () => {
  it('reads the third dimension from tuples and objects', () => {
    const norm = normalizeOption(BUBBLE);
    expect(norm.series[0].points.map((p) => p.size)).toEqual([8, 25, 60, 3]);

    const objects = normalizeOption({
      xAxis: { type: 'value' },
      yAxis: { type: 'value' },
      series: [{ type: 'scatter', data: [{ x: 1, y: 2, size: 30 }] }],
    });
    expect(objects.series[0].points[0].size).toBe(30);
  });

  it('maps the third dimension onto symbolSizeRange', () => {
    const series = makeSeries([1, 2, 3, 4], { symbolSizeRange: [10, 50] });
    series.points.forEach((p, i) => {
      p.size = [3, 8, 25, 60][i];
    });
    const component = new ScatterSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord({
      plot: { x: 0, y: 0, width: 400, height: 300 },
      canvas: { x: 0, y: 0, width: 400, height: 300 },
      xScale: new LinearScale([0, 3], [0, 400]),
      yScale: new LinearScale([0, 4], [300, 0]),
      theme: resolveChartTheme('light'),
    });
    // sizeExtent 在 rebuildPixels 里计算（生产路径由 render / pixelAt 触发）
    (component as any).rebuildPixels();
    const sizes = [0, 1, 2, 3].map((i) => component.symbolSizeAt(i));
    expect(sizes[0]).toBeCloseTo(10, 0);
    expect(sizes[3]).toBeCloseTo(50, 0);
    expect(sizes[1]).toBeLessThan(sizes[2]);
    expect(sizes[2]).toBeLessThan(sizes[3]);
  });

  it('supports a symbolSize function', () => {
    const series = makeSeries([1, 2, 3], { symbolSize: (value: number) => value * 10 });
    const component = new ScatterSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    expect(component.symbolSizeAt(2)).toBe(30);
  });
});

describe('气泡图（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 700;
    canvas.height = 420;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  it('renders bubbles with size-driven geometry and hits them', async () => {
    chart = createChart(canvas, BUBBLE);
    await chart.render();
    const component: any = chart.seriesComponents[0];
    expect(component.symbolSizeAt(2)).toBeGreaterThan(component.symbolSizeAt(0));

    const pixel = component.pixelAt(2)!;
    const sx = chart.layout.plot.x + pixel[0];
    const sy = chart.layout.plot.y + pixel[1];
    expect(chart.ice.hitTest(sx, sy)).toBe(component);
    expect(chart.controller.resolveTarget(sx, sy).index).toBe(2);
  });
});
