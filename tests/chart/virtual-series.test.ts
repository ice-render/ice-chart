import { createChart, ICEChart } from '../../src/index';
import type { ChartOption } from '../../src/types';

/**
 * 列存（虚拟）系列的**引擎集成**：真实渲染 → 真实命中 → 真实事件派发。
 *
 * 这里盯的正是「虚拟」最容易破的两件事：
 * 1. 命中/悬停仍然精确（像素是现算的，但必须和画出来的一致）；
 * 2. 省内存的代价是**显式**的 —— 快照还原与 appendData 直接报错，不静默给空图。
 */
function virtualOption(type: 'scatter' | 'line' | 'area', count = 10000): ChartOption {
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    x[i] = i;
    y[i] = 50 + Math.sin(i / 37) * 20;
  }
  return {
    legend: { show: false },
    animation: { enabled: false },
    tooltip: { trigger: 'item' },
    series: [{ id: 's', type, name: '列存系列', virtual: true, data: { x, y }, symbolSize: 6 }],
  };
}

describe.each(['scatter', 'line', 'area'] as const)('虚拟（列存）%s（引擎集成）', (type) => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 400;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  const mount = async (option: ChartOption = virtualOption(type)): Promise<ICEChart> => {
    chart = createChart(canvas, option, { renderMode: 'dirty-rect' });
    await chart.render();
    return chart;
  };

  it('归一化之后只有列：points 空、pointCount 正确、没有像素缓存', async () => {
    const c = await mount();
    const component: any = c.seriesComponents[0];
    expect(component.series.virtual).toBe(true);
    expect(component.series.points).toHaveLength(0);
    expect(component.series.pointCount).toBe(10000);
    expect(component.pixels.length).toBe(0);
    expect(c.ice.dirty).toBe(false);
  });

  it('引擎命中仍然落在正确的数据点上，悬停能拿到 x/y', async () => {
    const c = await mount();
    const component: any = c.seriesComponents[0];
    const index = 4321;
    const pixel = component.pixelAt(index)!;
    const plot = c.layout.plot;
    const sx = plot.x + pixel[0];
    const sy = plot.y + pixel[1];
    expect(c.ice.hitTest(sx, sy)).toBe(component);
    c.controller.handlePointerMove(sx, sy);
    const hover: any = (c.controller as any).hover;
    expect(hover && hover.kind).toBe('item');
    expect(hover.item.point.index).toBe(index);
    expect(hover.item.point.xValue).toBe(index);
    expect(Math.round(hover.item.point.y)).toBe(Math.round(component.series.yValueAt(index)));
  });

  it('快照还原与 appendData 都显式报错（省内存的代价不许静默）', async () => {
    const c = await mount();
    const json = c.toJSONString();
    const parsed = JSON.parse(json);
    expect(parsed.option.series[0].virtual).toBe(true);
    expect(parsed.option.series[0].data).toBeUndefined();
    const target = document.createElement('canvas');
    target.width = 300;
    target.height = 200;
    document.body.appendChild(target);
    expect(() => ICEChart.restore(target, json)).toThrow(/虚拟（列存）系列/);
    expect(() => c.appendData('s', [[1, 2]])).toThrow(/appendData/);
    target.parentNode.removeChild(target);
  });
});
