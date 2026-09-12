import { createChart } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import { computeLayout } from '../../src/layout/layout';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const PIE_OPTION: ChartOption = {
  legend: { show: true, position: 'right' },
  series: [
    {
      id: 'share',
      type: 'pie',
      name: '浏览器份额',
      radius: 0.8,
      data: [
        { name: 'Chrome', value: 62 },
        { name: 'Safari', value: 19 },
        { name: 'Edge', value: 11 },
        { name: 'Firefox', value: 8 },
      ],
    },
  ],
};

describe('饼图（纯函数层）', () => {
  it('switches the scene to polar and keeps slice names/colors', () => {
    const norm = normalizeOption(PIE_OPTION);
    expect(norm.kind).toBe('polar');
    expect(norm.series[0].points.map((p) => p.name)).toEqual(['Chrome', 'Safari', 'Edge', 'Firefox']);
    expect(norm.series[0].points.map((p) => p.color)).toEqual(norm.theme.colorPalette.slice(0, 4));
  });

  it('builds legend items from slices (with dataIndex) instead of series', () => {
    const norm = normalizeOption(PIE_OPTION);
    const layout = computeLayout(norm, null, { x: 0, y: 0, width: 800, height: 400 });
    const items = layout.legend!.items;
    expect(items).toHaveLength(4);
    expect(items.map((it) => it.name)).toEqual(['Chrome', 'Safari', 'Edge', 'Firefox']);
    expect(items[0].dataIndex).toBe(0);
    expect(items[3].dataIndex).toBe(3);
  });

  it('lays out a circle inside the canvas and shrinks the plot box to it', () => {
    const norm = normalizeOption(PIE_OPTION);
    const layout = computeLayout(norm, null, { x: 0, y: 0, width: 800, height: 400 });
    expect(layout.polar).not.toBeNull();
    const { cx, cy, radius } = layout.polar!;
    expect(cx - radius).toBeGreaterThanOrEqual(-1);
    expect(cx + radius).toBeLessThanOrEqual(801);
    expect(layout.plot.width).toBeCloseTo(radius * 2, 0);
  });

  it('treats [name, value] tuples as slices too', () => {
    const norm = normalizeOption({
      series: [{ type: 'pie', data: [['A', 3], ['B', 7]] }],
    });
    expect(norm.series[0].points[0]).toMatchObject({ name: 'A', y: 3 });
    expect(norm.series[0].points[1].y).toBe(7);
  });
});

describe('饼图（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 420;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  async function mount(option: ChartOption = PIE_OPTION): Promise<ICEChart> {
    chart = createChart(canvas, option);
    await chart.render();
    return chart;
  }

  function sliceScreen(c: ICEChart, index: number): [number, number] {
    const pixel = c.seriesComponents[0].pixelAt(index);
    if (!pixel) throw new Error('扇区没有质心');
    return [c.layout.plot.x + pixel[0], c.layout.plot.y + pixel[1]];
  }

  it('hits the slice under the pointer and ignores the donut hole', async () => {
    const c = await mount({ ...PIE_OPTION, series: [{ ...PIE_OPTION.series[0], innerRadius: 0.5 }] });
    const [sx, sy] = sliceScreen(c, 1);
    expect(c.ice.hitTest(sx, sy)).toBe(c.seriesComponents[0]);
    const target = c.controller.resolveTarget(sx, sy);
    expect(target.kind).toBe('series');
    expect(target.index).toBe(1);
    // 圆环中心是空的：不应命中任何数据
    const center = [c.layout.polar!.cx, c.layout.polar!.cy] as [number, number];
    expect(c.controller.resolveTarget(center[0], center[1]).kind).not.toBe('series');
  });

  it('emits item:click with the slice name', async () => {
    const c = await mount();
    const events: any[] = [];
    c.on('item:click', (p: any) => events.push(p));
    const [sx, sy] = sliceScreen(c, 2);
    c.controller.handleClick(sx, sy);
    expect(events).toHaveLength(1);
    expect(events[0].dataIndex).toBe(2);
    expect(events[0].seriesType).toBe('pie');
  });

  it('shows a slice-oriented tooltip instead of an axis tooltip', async () => {
    const c = await mount();
    const [sx, sy] = sliceScreen(c, 0);
    c.controller.handlePointerMove(sx, sy);
    expect(c.tooltip!.content).not.toBeNull();
    expect(c.tooltip!.content!.title).toBe('浏览器份额');
    expect(c.tooltip!.content!.rows[0].name).toBe('Chrome');
    expect(c.tooltip!.content!.rows[0].value).toMatch(/%$/);
    // 极坐标下没有十字准星
    expect(c.crosshair!.pixelX).toBeNull();
  });

  it('toggles a slice from the legend and recomputes percentages', async () => {
    const c = await mount();
    const events: any[] = [];
    c.on('legend:toggle', (p: any) => events.push(p));
    const item = c.layout.legend!.items[0];
    const x = item.x + item.width / 2;
    const y = item.y + item.height / 2;
    expect(c.ice.hitTest(x, y)).toBe(c.legend);
    c.controller.handleClick(x, y);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seriesId: 'share', dataIndex: 0, selected: false });
    expect(c.norm.hiddenSlices['share#0']).toBe(true);
    expect((c.seriesComponents[0] as any).hiddenSlices).toEqual([0]);
    // 隐藏后该扇区不再命中
    const [sx, sy] = sliceScreen(c, 1);
    const target = c.controller.resolveTarget(sx, sy);
    expect(target.index).toBe(1);
  });

  it('supports rose charts (radius varies with value)', async () => {
    const c = await mount({
      series: [{ id: 'rose', type: 'pie', name: '玫瑰', roseType: 'radius', data: [10, 40, 20, 5] }],
    });
    const component: any = c.seriesComponents[0];
    const slices = component.slices;
    // 第 2 个扇区数值最大 → 外半径最大
    expect(slices[1 * 4 + 3]).toBeGreaterThan(slices[0 * 4 + 3]);
    expect(slices[3 * 4 + 3]).toBeLessThan(slices[2 * 4 + 3]);
  });

  it('serializes hidden slices', async () => {
    const c = await mount();
    c.toggleSlice('share', 1);
    const json = c.toJSONString();
    expect(JSON.parse(json).hiddenSlices['share#1']).toBe(true);
    c.toggleSlice('share', 1);
  });
});
