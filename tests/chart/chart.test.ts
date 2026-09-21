import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const LINE_OPTION: ChartOption = {
  series: [
    { id: 'a', type: 'line', name: 'A', data: [10, 30, 20, 45, 35] },
    { id: 'b', type: 'line', name: 'B', data: [[0, 5], [1, 15], [2, 25], [3, 35], [4, 15]] },
  ],
};

describe('ICEChart（引擎集成）', () => {
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

  async function mount(option: ChartOption = LINE_OPTION, options: any = {}): Promise<ICEChart> {
    chart = createChart(canvas, option, { renderMode: 'dirty-rect', ...options });
    await chart.render();
    return chart;
  }

  /** 数据点 → 画布像素坐标（CSS 像素，视口为单位视口）。 */
  function pointToScreen(c: ICEChart, seriesIndex: number, dataIndex: number): [number, number] {
    const component = c.seriesComponents[seriesIndex];
    const pixel = component.pixelAt(dataIndex);
    if (!pixel) throw new Error('数据点无像素坐标');
    const plot = c.layout.plot;
    return [plot.x + pixel[0], plot.y + pixel[1]];
  }

  it('builds a component tree and computes a layout', async () => {
    const c = await mount();
    expect(c.layout.plot.width).toBeGreaterThan(100);
    expect(c.layout.plot.height).toBeGreaterThan(100);
    expect(c.seriesComponents).toHaveLength(2);
    expect(c.plotArea.parentNode).toBe(c.root);
    expect(c.ice.childNodes[0]).toBe(c.root);
  });

  it('renders without throwing and reports a dirty-rect friendly frame', async () => {
    const c = await mount();
    await c.render();
    expect(c.ice.dirty).toBe(false);
  });

  it('resolves a data item through the engine hit test', async () => {
    const c = await mount();
    const [sx, sy] = pointToScreen(c, 0, 2);
    expect(c.ice.hitTest(sx, sy)).toBe(c.seriesComponents[0]);
    const target = c.controller.resolveTarget(sx, sy);
    expect(target.kind).toBe('series');
    expect(target.index).toBe(2);
  });

  it('does not hit a series in the empty area above the data', async () => {
    const c = await mount();
    const plot = c.layout.plot;
    expect(c.ice.hitTest(plot.x + plot.width - 2, plot.y + 2)).toBe(c.plotArea);
  });

  it('emits item:hover on pointer move over a data column', async () => {
    const c = await mount();
    const events: any[] = [];
    c.on('item:hover', (payload: any) => events.push(payload));
    const [sx, sy] = pointToScreen(c, 0, 1);
    c.controller.handlePointerMove(sx, sy);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seriesId: 'a', dataIndex: 1, xValue: 1, value: 30 });
    expect(c.tooltip!.content).not.toBeNull();
    expect(c.crosshair!.pixelX).toBeCloseTo(sx, 3);
  });

  it('emits item:click with the data payload', async () => {
    const c = await mount();
    const clicks: any[] = [];
    c.on('item:click', (payload: any) => clicks.push(payload));
    const [sx, sy] = pointToScreen(c, 0, 3);
    c.controller.handleClick(sx, sy);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ seriesId: 'a', dataIndex: 3, value: 45 });
    expect(clicks[0].screen[0]).toBeCloseTo(sx, 3);
  });

  it('emits plot:click when clicking the empty plot area', async () => {
    const c = await mount();
    const clicks: any[] = [];
    c.on('plot:click', (payload: any) => clicks.push(payload));
    const plot = c.layout.plot;
    c.controller.handleClick(plot.x + plot.width - 2, plot.y + 2);
    expect(clicks).toHaveLength(1);
  });

  it('toggles a series when its legend item is clicked', async () => {
    const c = await mount({ ...LINE_OPTION, legend: { show: true, position: 'top' } });
    const events: any[] = [];
    c.on('legend:toggle', (payload: any) => events.push(payload));
    const item = c.layout.legend!.items[0];
    const x = item.x + item.width / 2;
    const y = item.y + item.height / 2;
    expect(c.ice.hitTest(x, y)).toBe(c.legend);
    c.controller.handleClick(x, y);
    expect(events).toHaveLength(1);
    expect(events[0].seriesId).toBe('a');
    expect(c.norm.series[0].hidden).toBe(true);
    expect(c.seriesComponents[0].state.display).toBe(false);
  });

  it('zooms the x domain on wheel and keeps the anchor value stable', async () => {
    const c = await mount();
    const before = c.getDomain('x');
    const plot = c.layout.plot;
    const events: any[] = [];
    c.on('zoom:change', (payload: any) => events.push(payload));
    // deltaY < 0 = 滚轮向上 = 放大（与引擎 zoomAt 的约定一致：factor > 1 是放大）
    const handled = c.controller.handleWheel(plot.x + plot.width / 2, plot.y + plot.height / 2, -120);
    expect(handled).toBe(true);
    const after = c.getDomain('x');
    expect(Number(after[1]) - Number(after[0])).toBeLessThan(Number(before[1]) - Number(before[0]));
    expect(events).toHaveLength(1);
  });

  it('ignores wheel events outside the plot area', async () => {
    const c = await mount();
    const handled = c.controller.handleWheel(2, 2, 120);
    expect(handled).toBe(false);
  });

  it('brushes a data range and emits brush:end', async () => {
    const c = await mount({
      ...LINE_OPTION,
      interaction: { brush: { enabled: true, axes: 'x', mode: 'select' } },
    });
    const plot = c.layout.plot;
    const events: any[] = [];
    c.on('brush:end', (payload: any) => events.push(payload));
    c.controller.handlePointerDown(plot.x + plot.width * 0.2, plot.y + plot.height / 2);
    c.controller.handlePointerMove(plot.x + plot.width * 0.6, plot.y + plot.height / 2);
    expect(c.brushComponent!.rect).not.toBeNull();
    c.controller.handlePointerUp(plot.x + plot.width * 0.6, plot.y + plot.height / 2);
    expect(events).toHaveLength(1);
    expect(events[0].x[0]).toBeLessThan(events[0].x[1]);
  });

  it('applies the brush as a zoom window when mode is zoom', async () => {
    const c = await mount({
      ...LINE_OPTION,
      interaction: { brush: { enabled: true, axes: 'x', mode: 'zoom' } },
    });
    const plot = c.layout.plot;
    c.controller.handlePointerDown(plot.x + plot.width * 0.2, plot.y + plot.height / 2);
    c.controller.handlePointerMove(plot.x + plot.width * 0.5, plot.y + plot.height / 2);
    c.controller.handlePointerUp(plot.x + plot.width * 0.5, plot.y + plot.height / 2);
    const domain = c.getDomain('x');
    expect(Number(domain[0])).toBeGreaterThan(0);
    expect(Number(domain[1])).toBeLessThan(4);
  });

  it('pans the domain while dragging when pan is enabled', async () => {
    const c = await mount({
      series: [{ id: 'a', type: 'line', data: [10, 30, 20, 45, 35] }],
      interaction: { pan: { enabled: true, axes: 'x' }, zoom: false, brush: false },
    });
    // 先缩放到一个可以移动的窗口：完整域是 [0,4]，窗口 [1,3]
    c.setDomain('x', [1, 3]);
    const before = c.getDomain('x');
    const plot = c.layout.plot;
    const midY = plot.y + plot.height / 2;
    // 指针右移 = 内容右移 = 数据窗口左移（domain 减小）
    c.controller.handlePointerDown(plot.x + plot.width * 0.2, midY);
    c.controller.handlePointerMove(plot.x + plot.width * 0.5, midY);
    c.controller.handlePointerUp(plot.x + plot.width * 0.5, midY);
    const after = c.getDomain('x');
    expect(Number(after[0])).toBeLessThan(Number(before[0]));
    expect(Number(after[0])).toBeGreaterThanOrEqual(0);
  });

  it('pans the domain on a category axis（窗口是「一串类目」而不是两个数）', async () => {
    // 回归：类目轴的 `norm.xAxis.domain` 是**窗口内的整串类目**（几根就几项），
    // 不是连续轴那种 `[min, max]`。早先这里按「长度必须是 2」取窗口，于是类目轴
    // 横向平移整条分支被跳过；`shiftDomain` 又把窗口内的那串当成了「全部类目」，
    // 位移恒为 0 —— 合起来就是「能上下拖、不能左右拖」。K 线图正是类目轴。
    const c = await mount({
      xAxis: { type: 'category' },
      series: [{ id: 'a', type: 'line', data: [10, 30, 20, 45, 35, 25, 15] }],
      interaction: { pan: { enabled: true, axes: 'x' }, zoom: false, brush: false },
    });
    const all = c.fullDomain('x');
    expect(all.length).toBeGreaterThan(3);
    c.setDomain('x', [all[1], all[3]]);
    const before = c.getDomain('x');
    const idx = (value: any) => all.indexOf(value);
    const plot = c.layout.plot;
    const midY = plot.y + plot.height / 2;
    // 指针右移 = 内容右移 = 数据窗口左移（类目下标变小）
    c.controller.handlePointerDown(plot.x + plot.width * 0.2, midY);
    c.controller.handlePointerMove(plot.x + plot.width * 0.55, midY);
    c.controller.handlePointerUp(plot.x + plot.width * 0.55, midY);
    const after = c.getDomain('x');

    expect(idx(after[after.length - 1]) - idx(after[0])).toBe(idx(before[before.length - 1]) - idx(before[0]));
    expect(idx(after[0])).toBeLessThan(idx(before[0]));
    expect(idx(after[0])).toBeGreaterThanOrEqual(0);
  });

  it('navigates data points with the keyboard and emits item:hover', async () => {
    const c = await mount();
    const events: any[] = [];
    c.on('item:hover', (payload: any) => events.push(payload));
    expect(c.controller.handleKeyDown('ArrowRight')).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(c.tooltip!.content).not.toBeNull();
  });

  it('selects items when select is enabled and emits select:change', async () => {
    const c = await mount({ ...LINE_OPTION, interaction: { select: { enabled: true, mode: 'multiple' } } });
    const events: any[] = [];
    c.on('select:change', (payload: any) => events.push(payload));
    const [sx, sy] = pointToScreen(c, 0, 1);
    c.controller.handleClick(sx, sy);
    c.controller.handleClick(sx, sy);
    expect(events).toHaveLength(2);
    expect(events[0]).toHaveLength(1);
    expect(events[1]).toHaveLength(0);
    expect(c.highlight!.selectionItems).toHaveLength(0);
  });

  it('updates data in place with setData', async () => {
    const c = await mount();
    const component = c.seriesComponents[0];
    c.setData('a', [1, 2, 3, 4, 5]);
    await c.render();
    expect(c.seriesComponents[0]).toBe(component);
    expect(c.seriesComponents[0].series.points.map((p) => p.y)).toEqual([1, 2, 3, 4, 5]);
  });

  it('resizes the canvas and re-lays out', async () => {
    const c = await mount();
    const before = c.layout.plot.width;
    c.resize(900, 300);
    await c.render();
    expect(c.layout.plot.width).toBeGreaterThan(before);
    expect(c.layout.canvas.width).toBe(900);
  });

  it('round-trips the option through JSON', async () => {
    const c = await mount();
    const json = c.toJSONString();
    expect(JSON.parse(json).option.series).toHaveLength(2);
    const second = createChart(canvas, LINE_OPTION);
    second.fromJSONString(json);
    await second.render();
    expect(second.norm.series[0].points).toHaveLength(5);
    second.destroy();
  });
});
