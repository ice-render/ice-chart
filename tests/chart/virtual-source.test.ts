import { createChart } from '../../src/index';
import { ICEVirtualLayer } from 'ice-render';
import type { ICEChart } from '../../src/ICEChart';

/**
 * 把图表的列交给**引擎的虚拟子源**（`VirtualChildSource`）。
 *
 * 这条链路的意义是「列不复制」：图表算出来的列直接成为引擎虚拟层的数据源，
 * 于是引擎侧的窗口裁剪 / 批量落墨 / 命中即物化 / SVG 导出都能用同一份数据。
 * 坐标口径是**组件本地（= 绘图区）像素**，与引擎虚拟子源的「容器局部」一致。
 */
function option(count = 5000): any {
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    x[i] = i;
    y[i] = 50 + Math.sin(i / 37) * 20;
  }
  return {
    legend: { show: false },
    animation: { enabled: false },
    xAxis: { type: 'linear' },
    yAxis: { name: 'y' },
    series: [{ id: 's', type: 'scatter', name: '列存', virtual: true, data: { x, y }, symbolSize: 6 }],
  };
}

describe('虚拟子源（把列交给引擎）', () => {
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

  const mount = async (): Promise<ICEChart> => {
    chart = createChart(canvas, option(), { renderMode: 'dirty-rect' });
    await chart.render();
    return chart;
  };

  it('契约：count 对齐、boxAt 落在像素上、hitTest 给回下标、paint 有落墨', async () => {
    const c = await mount();
    const source: any = c.createVirtualSource('s');
    const component: any = c.seriesComponents[0];
    expect(source.count).toBe(5000);

    const out = new Float64Array(4);
    source.boxAt(100, out);
    const pixel = component.pixelAt(100)!;
    expect((out[0] + out[2]) / 2).toBeCloseTo(pixel[0], 6);
    expect((out[1] + out[3]) / 2).toBeCloseTo(pixel[1], 6);
    expect(out[2] - out[0]).toBeCloseTo(6, 6);

    expect(source.hitTest(pixel[0], pixel[1])).toBe(100);

    // paint：给一个记录调用的 ctx 桩
    const calls: string[] = [];
    const stub: any = new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === 'canvas') return canvas;
          return (...args: any[]) => {
            calls.push(String(key));
            void args;
          };
        },
        set: () => true,
      }
    );
    expect(source.paint(stub)).toBe(true);
    expect(calls).toContain('beginPath');
    expect(calls).toContain('fill');
  });

  it('forEachInBox：只报窗口内的点（x 范围落成下标范围）', async () => {
    const c = await mount();
    const source: any = c.createVirtualSource('s');
    const component: any = c.seriesComponents[0];
    const seen: number[] = [];
    const from = component.pixelAt(1000)!;
    const to = component.pixelAt(1100)!;
    source.forEachInBox(from[0], 0, to[0], c.layout.plot.height, (index: number) => seen.push(index));
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(999);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1101);
  });

  it('命中即物化：materialize 造出真图元（只造不挂）', async () => {
    const c = await mount();
    const source: any = c.createVirtualSource('s');
    const star: any = source.materialize(42);
    expect(star).toBeTruthy();
    expect(star.__iceChartDataIndex).toBe(42);
    const pixel = (c.seriesComponents[0] as any).pixelAt(42)!;
    expect(star.state.left).toBeCloseTo(pixel[0] - 3, 6);
  });

  it('引擎集成：ICEVirtualLayer 吃这份源，引擎能命中它', async () => {
    const c = await mount();
    const source: any = c.createVirtualSource('s');
    const plot = c.layout.plot;
    const layer: any = new ICEVirtualLayer({
      left: plot.x,
      top: plot.y,
      width: plot.width,
      height: plot.height,
      childSource: source,
    });
    c.ice.addChild(layer);
    const component: any = c.seriesComponents[0];
    const pixel = component.pixelAt(200)!;
    const hit = c.ice.hitTest(plot.x + pixel[0], plot.y + pixel[1]);
    expect(hit).toBeTruthy();
  });
});
