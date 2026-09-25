import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/**
 * **画布视图**（viewport）的缩放与平移。
 *
 * 背景：`interaction.zoom.mode: 'viewport'` 早就有了（滚轮 → `ice.zoomAt`），
 * 但**平移**只有「改数据域」这一条路 —— 对没有坐标轴的场景（力导向图 / 关系图）等于拖了没反应，
 * 于是「能缩放但不能平移」：放大之后只能看正中间那一块。
 *
 * 这一组用例盯的就是这件事：viewport 模式下拖拽平移的是**视图**（`ice.viewport.tx/ty`），
 * 数据域一个数都不许动。
 */
describe('画布视图缩放与平移（viewport 模式）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 440;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  const mount = async (option: ChartOption): Promise<ICEChart> => {
    chart = createChart(canvas, option);
    await chart.render();
    return chart;
  };

  const VIEWPORT_OPTION: ChartOption = {
    xAxis: { type: 'category' },
    yAxis: {},
    animation: { enabled: false },
    interaction: {
      zoom: { enabled: true, mode: 'viewport', wheel: true },
      pan: { enabled: true, axes: 'xy', mode: 'viewport' },
    },
    series: [{ id: 'a', type: 'line', data: [10, 30, 20, 45, 35, 50] }],
  };

  it('viewport 模式下拖拽平移的是画布视图，不是数据域', async () => {
    const c = await mount(VIEWPORT_OPTION);
    const before = { ...c.ice.viewport };
    const domainX = c.getDomain('x');
    const domainY = c.getDomain('y');
    const plot = c.layout.plot;
    const x0 = plot.x + plot.width * 0.5;
    const y0 = plot.y + plot.height * 0.5;
    c.controller.handlePointerDown(x0, y0);
    c.controller.handlePointerMove(x0 + 40, y0 + 24);
    c.controller.handlePointerUp(x0 + 40, y0 + 24);
    // 视图跟着指针走（tx / ty 各偏移同样的量）
    expect(c.ice.viewport.tx).toBeCloseTo(before.tx + 40, 3);
    expect(c.ice.viewport.ty).toBeCloseTo(before.ty + 24, 3);
    // 数据域一个数都不许动
    expect(c.getDomain('x')).toEqual(domainX);
    expect(c.getDomain('y')).toEqual(domainY);
  });

  it('默认（data 模式）拖拽仍然改数据域，不受这条影响', async () => {
    const c = await mount({
      ...VIEWPORT_OPTION,
      interaction: { zoom: { enabled: true, axes: 'x' }, pan: { enabled: true, axes: 'x' } },
    });
    const before = { ...c.ice.viewport };
    // 满窗口本来就无处可平移 —— 先收一个窗口出来
    const all = c.fullDomain('x');
    c.setDomain('x', [all[1], all[4]], 'api');
    const domainX = c.getDomain('x');
    const plot = c.layout.plot;
    const y0 = plot.y + plot.height / 2;
    c.controller.handlePointerDown(plot.x + plot.width * 0.2, y0);
    c.controller.handlePointerMove(plot.x + plot.width * 0.6, y0);
    c.controller.handlePointerUp(plot.x + plot.width * 0.6, y0);
    expect(c.getDomain('x')).not.toEqual(domainX);
    expect(c.ice.viewport.tx).toBeCloseTo(before.tx, 3);
    expect(c.ice.viewport.ty).toBeCloseTo(before.ty, 3);
  });
});
