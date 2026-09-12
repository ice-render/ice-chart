import { createChart } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import { computeLayout } from '../../src/layout/layout';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const RADAR_OPTION: ChartOption = {
  legend: { show: true, position: 'top' },
  radar: {
    indicators: [
      { name: '攻击', max: 100 },
      { name: '防御', max: 100 },
      { name: '速度', max: 100 },
      { name: '耐力', max: 100 },
      { name: '技巧', max: 100 },
    ],
    splitNumber: 4,
  },
  series: [
    { id: 'a', type: 'radar', name: '选手 A', data: [85, 60, 90, 70, 78] },
    { id: 'b', type: 'radar', name: '选手 B', data: [60, 88, 65, 86, 70] },
  ],
};

describe('雷达图（纯函数层）', () => {
  it('builds one vertex per indicator', () => {
    const norm = normalizeOption(RADAR_OPTION);
    expect(norm.kind).toBe('radar');
    expect(norm.series[0].points).toHaveLength(5);
    expect(norm.series[0].points.map((p) => p.name)).toEqual(['攻击', '防御', '速度', '耐力', '技巧']);
    expect(norm.series[0].points[0].y).toBe(85);
  });

  it('derives per-indicator domains from indicator.max or data', () => {
    const norm = normalizeOption(RADAR_OPTION);
    expect(norm.radarDomains).toHaveLength(5);
    expect(norm.radarDomains[0]).toEqual([0, 100]);

    const auto = normalizeOption({
      radar: { indicators: [{ name: 'A' }, { name: 'B' }] },
      series: [{ type: 'radar', data: [30, 90] }],
    });
    expect(auto.radarDomains[0]).toEqual([0, 30]);
    expect(auto.radarDomains[1]).toEqual([0, 90]);
  });

  it('defaults the tooltip trigger to item for non-cartesian scenes', () => {
    const norm = normalizeOption(RADAR_OPTION);
    expect(norm.option.tooltip.trigger).toBe('item');
  });

  it('lays out a circle for the radar web', () => {
    const norm = normalizeOption(RADAR_OPTION);
    const layout = computeLayout(norm, null, { x: 0, y: 0, width: 600, height: 400 });
    expect(layout.polar!.radius).toBeGreaterThan(50);
    expect(layout.plot.width).toBeCloseTo(layout.polar!.radius * 2, 0);
  });
});

describe('雷达图（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 700;
    canvas.height = 460;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  async function mount(option: ChartOption = RADAR_OPTION): Promise<ICEChart> {
    chart = createChart(canvas, option);
    await chart.render();
    return chart;
  }

  it('hits a vertex through the engine hit test', async () => {
    const c = await mount();
    const component = c.seriesComponents[0];
    const vertex = component.pixelAt(2)!;
    const sx = c.layout.plot.x + vertex[0];
    const sy = c.layout.plot.y + vertex[1];
    expect(c.ice.hitTest(sx, sy)).toBe(component);
    const target = c.controller.resolveTarget(sx, sy);
    expect(target.index).toBe(2);
  });

  it('hits the inside of the polygon by nearest indicator', async () => {
    const c = await mount();
    const component = c.seriesComponents[0];
    const vertex = component.pixelAt(2)!;
    const sx = c.layout.plot.x + vertex[0] * 0.5;
    const sy = c.layout.plot.y + vertex[1] * 0.5;
    const target = c.controller.resolveTarget(sx, sy);
    expect(target.kind).toBe('series');
    expect(target.index).toBeGreaterThanOrEqual(0);
  });

  it('shows every indicator in the tooltip', async () => {
    const c = await mount();
    const vertex = c.seriesComponents[0].pixelAt(0)!;
    c.controller.handlePointerMove(c.layout.plot.x + vertex[0], c.layout.plot.y + vertex[1]);
    expect(c.tooltip!.content).not.toBeNull();
    expect(c.tooltip!.content!.title).toBe('选手 A');
    expect(c.tooltip!.content!.rows.map((r) => r.name)).toEqual(['攻击', '防御', '速度', '耐力', '技巧']);
    expect(c.crosshair!.pixelX).toBeNull();
  });

  it('keeps both series hittest-able and independent', async () => {
    const c = await mount();
    expect(c.seriesComponents).toHaveLength(2);
    const aVertex = c.seriesComponents[0].pixelAt(0)!;
    const bVertex = c.seriesComponents[1].pixelAt(1)!;
    expect(aVertex[0]).not.toBeCloseTo(bVertex[0], 1);
  });

  it('renders the radar grid component', async () => {
    const c = await mount();
    expect(c.radarGrid.coord).not.toBeNull();
    expect(c.radarGrid.state.display).toBe(true);
    c.setOption({ ...RADAR_OPTION, series: [{ id: 'a', type: 'line', data: [1, 2, 3] }] });
    await c.render();
    expect(c.radarGrid.state.display).toBe(false);
  });
});
