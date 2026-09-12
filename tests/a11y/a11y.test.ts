import { createChart } from '../../src/index';
import { buildDataNodes, chartTitle } from '../../src/a11y';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const OPTION: ChartOption = {
  title: { text: '近 3 天访问量' },
  xAxis: { type: 'category', name: '日期' },
  yAxis: { name: '访问量' },
  series: [
    { id: 'pv', type: 'line', name: '访问量', data: [820, 932, 901] },
    { id: 'uv', type: 'line', name: '独立访客', data: [[0, 320], [1, 402], [2, 391]] },
  ],
};

describe('无障碍（数据表 / 节点树）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 360;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  async function mount(option: ChartOption = OPTION): Promise<ICEChart> {
    chart = createChart(canvas, option);
    await chart.render();
    return chart;
  }

  it('builds a cartesian table aligned by x value', async () => {
    const c = await mount();
    const table = c.getDataTable();
    expect(table.caption).toBe('近 3 天访问量');
    expect(table.columns).toEqual(['日期', '访问量', '独立访客']);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0][0]).toBe('0');
    expect(table.rows[0][1]).toBe('820');
    expect(table.rows[2][2]).toBe('391');
  });

  it('drops hidden series from the table', async () => {
    const c = await mount();
    c.toggleSeries('uv');
    const table = c.getDataTable();
    expect(table.columns).toEqual(['日期', '访问量']);
    expect(table.rows[0]).toHaveLength(2);
  });

  it('builds a slice table with percentages', async () => {
    const c = await mount({
      title: { text: '份额' },
      series: [
        {
          id: 'share',
          type: 'pie',
          name: '份额',
          data: [
            { name: 'Chrome', value: 75 },
            { name: 'Safari', value: 25 },
          ],
        },
      ],
    });
    const table = c.getDataTable();
    expect(table.columns).toEqual(['扇区', '数值', '占比']);
    expect(table.rows[0]).toEqual(['Chrome', '75', '75.0%']);
    expect(table.rows[1][2]).toBe('25.0%');
    // 隐藏一个扇区后占比重算
    c.toggleSlice('share', 0);
    const after = c.getDataTable();
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0][2]).toBe('100.0%');
  });

  it('builds a radar table with one row per indicator', async () => {
    const c = await mount({
      radar: { indicators: [{ name: '攻击' }, { name: '防御' }] },
      series: [{ id: 'a', type: 'radar', name: '选手 A', data: [80, 60] }],
    });
    const table = c.getDataTable();
    expect(table.columns).toEqual(['指标', '选手 A']);
    expect(table.rows).toEqual([
      ['攻击', '80'],
      ['防御', '60'],
    ]);
  });

  it('exposes per-data-point a11y nodes with screen boxes', async () => {
    const c = await mount();
    const nodes = c.getA11yTree({ maxDataNodesPerSeries: 10 });
    const dataNodes = nodes.filter((n: any) => n.seriesId);
    expect(dataNodes).toHaveLength(6);
    const first = dataNodes[0];
    expect(first.id).toBe('pv#0');
    expect(first.label).toContain('访问量');
    expect(first.label).toContain('820');
    expect(first.box.width).toBeGreaterThan(0);
    expect(first.focusable).toBe(true);
  });

  it('caps data nodes per series', async () => {
    const many = Array.from({ length: 500 }, (_, i) => i);
    const c = await mount({ series: [{ id: 'a', type: 'line', name: 'A', data: many }] });
    expect(buildDataNodes(c as any, { maxDataNodesPerSeries: 20 }).length).toBe(20);
    expect(buildDataNodes(c as any, { maxDataNodesPerSeries: 0 }).length).toBe(0);
  });

  it('labels the root component with the chart title for the engine tree', async () => {
    const c = await mount();
    expect(chartTitle(c.norm)).toBe('近 3 天访问量');
    expect(c.root.state.ariaLabel).toBe('近 3 天访问量');
    const tree = c.ice.getAccessibilityTree();
    expect(tree.length).toBeGreaterThan(0);
    expect(tree[0].label).toBe('近 3 天访问量');
  });

  it('attaches a visually hidden table and wires aria-describedby', async () => {
    const c = await mount();
    expect(c.attachA11yMirror()).toBe(true);
    expect(c.a11yMirrorAttached).toBe(true);
    const wrapper: any = document.querySelector('[data-ice-chart-a11y="mirror"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper.getAttribute('style')).toContain('clip-path');
    const table = wrapper.querySelector('table');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(table.querySelectorAll('thead th')).toHaveLength(3);
    expect(canvas.getAttribute('aria-describedby')).toBe(wrapper.id);
    expect(canvas.getAttribute('aria-label')).toBe('近 3 天访问量');

    expect(wrapper.parentNode).toBe(canvas.parentNode);
  });

  it('announces the hovered data point through the live region', async () => {
    const c = await mount();
    c.attachA11yMirror();
    const wrapper: any = document.querySelector('[data-ice-chart-a11y="mirror"]');
    const live = wrapper.querySelector('[aria-live="polite"]');
    const pixel = c.seriesComponents[0].pixelAt(1)!;
    c.controller.handlePointerMove(c.layout.plot.x + pixel[0], c.layout.plot.y + pixel[1]);
    expect(live.textContent).toContain('访问量');
    expect(live.textContent).toContain('932');
  });

  it('refreshes the mirror when data changes and removes it on detach', async () => {
    const c = await mount();
    c.attachA11yMirror();
    const wrapperId = canvas.getAttribute('aria-describedby');
    c.setData('pv', [1, 2, 3, 4]);
    await c.render();
    const wrapper: any = document.getElementById(wrapperId);
    expect(wrapper.querySelectorAll('tbody tr')).toHaveLength(4);
    c.detachA11yMirror();
    expect(c.a11yMirrorAttached).toBe(false);
    expect(document.getElementById(wrapperId)).toBeNull();
    expect(canvas.getAttribute('aria-describedby')).toBeNull();
  });
});
