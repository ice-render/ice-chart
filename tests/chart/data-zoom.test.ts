import { createChart } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import { computeLayout } from '../../src/layout/layout';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const OPTION: ChartOption = {
  dataZoom: { start: 50, end: 100 },
  xAxis: { type: 'category' },
  series: [{ id: 'a', type: 'line', name: 'A', data: [10, 30, 20, 45, 35, 50, 25, 60, 40, 55] }],
};

describe('dataZoom 滑块（纯函数层）', () => {
  it('reserves a slider rect when dataZoom is declared', () => {
    const norm = normalizeOption(OPTION);
    const layout = computeLayout(norm, null, { x: 0, y: 0, width: 800, height: 420 });
    expect(layout.slider).not.toBeNull();
    expect(layout.slider!.y).toBeGreaterThan(layout.plot.y + layout.plot.height);
    expect(layout.slider!.width).toBe(layout.plot.width);
  });

  it('omits the slider when not configured or explicitly hidden', () => {
    const without = computeLayout(
      normalizeOption({ series: [{ type: 'line', data: [1, 2, 3] }] }),
      null,
      { x: 0, y: 0, width: 800, height: 420 }
    );
    expect(without.slider).toBeNull();
    const hidden = computeLayout(
      normalizeOption({ ...OPTION, dataZoom: { start: 50, end: 100, slider: { show: false } } }),
      null,
      { x: 0, y: 0, width: 800, height: 420 }
    );
    expect(hidden.slider).toBeNull();
  });

  it('does not reserve slider space for polar scenes', () => {
    const layout = computeLayout(
      normalizeOption({ dataZoom: {}, series: [{ type: 'pie', data: [1, 2] }] }),
      null,
      { x: 0, y: 0, width: 800, height: 420 }
    );
    expect(layout.slider).toBeNull();
  });

  it('keeps a category axis as a slice of categories (not two boundary values)', () => {
    // 图表层的缩放窗口是通过 xDomain 传进归一化的（等价于 dataZoom 50~100）
    const norm = normalizeOption(OPTION, { xDomain: [5, 9] });
    // dataZoom 50~100 → 类目 5..9，共 5 个类目，而不是 [5, 9] 两个值
    expect(norm.xAxis.domain).toHaveLength(5);
    expect(norm.xAxis.domain[0]).toBe(5);
    expect(norm.xAxis.domain[norm.xAxis.domain.length - 1]).toBe(9);
  });
});

describe('dataZoom 滑块（引擎集成）', () => {
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

  async function mount(option: ChartOption = OPTION): Promise<ICEChart> {
    chart = createChart(canvas, option);
    await chart.render();
    return chart;
  }

  it('reflects the initial window from dataZoom.start/end', async () => {
    const c = await mount();
    const slider = c.dataZoomSlider!;
    expect(slider.state.display).toBe(true);
    expect(slider.start).toBeCloseTo(0.5, 2);
    expect(slider.end).toBeCloseTo(1, 2);
    expect(c.getDomain('x')).toEqual([5, 6, 7, 8, 9]);
  });

  it('drags the window and updates the x domain', async () => {
    const c = await mount({ ...OPTION, dataZoom: { start: 0, end: 50 } });
    const slider = c.dataZoomSlider!;
    const rect = c.layout.slider!;
    const midY = rect.y + rect.height / 2;
    const events: any[] = [];
    c.on('zoom:change', (p: any) => events.push(p));
    // 抓取窗口中间并右移 20% 轨道宽度
    c.controller.handlePointerDown(rect.x + rect.width * 0.25, midY);
    expect(slider.activePart).toBe('window');
    c.controller.handlePointerMove(rect.x + rect.width * 0.45, midY);
    c.controller.handlePointerUp(rect.x + rect.width * 0.45, midY);
    const domain = c.getDomain('x');
    expect(Number(domain[0])).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].x.length).toBe(2);
  });

  it('drags a single handle to resize the window', async () => {
    const c = await mount({ ...OPTION, dataZoom: { start: 0, end: 100 } });
    const rect = c.layout.slider!;
    const midY = rect.y + rect.height / 2;
    c.controller.handlePointerDown(rect.x + rect.width, midY);
    expect(c.dataZoomSlider!.activePart).toBe('end');
    c.controller.handlePointerMove(rect.x + rect.width * 0.4, midY);
    c.controller.handlePointerUp(rect.x + rect.width * 0.4, midY);
    const domain = c.getDomain('x');
    expect(Number(domain[1])).toBeLessThan(9);
    expect(Number(domain[0])).toBe(0);
  });

  it('recenters the window when the track is clicked', async () => {
    const c = await mount({ ...OPTION, dataZoom: { start: 0, end: 30 } });
    const rect = c.layout.slider!;
    const midY = rect.y + rect.height / 2;
    c.controller.handlePointerDown(rect.x + rect.width * 0.8, midY);
    c.controller.handlePointerUp(rect.x + rect.width * 0.8, midY);
    const domain = c.getDomain('x');
    expect(Number(domain[0])).toBeGreaterThan(5);
  });

  it('maps fractions back to a value domain for numeric axes', async () => {
    const c = await mount({
      dataZoom: { start: 0, end: 100 },
      series: [{ id: 'a', type: 'line', data: [[0, 1], [100, 2]] }],
    });
    c.setDomainFromFractions(0.25, 0.75, 'slider');
    // 断言往返一致（而不是写死 25/75）：轴的完整域含留白，比例 → 域的换算要跟着它走
    const [start, end] = c.domainFractions();
    expect(start).toBeCloseTo(0.25, 2);
    expect(end).toBeCloseTo(0.75, 2);
    const domain = c.getDomain('x').map(Number);
    const full = c.fullXDomain.map(Number);
    expect(domain[0]).toBeCloseTo(full[0] + (full[1] - full[0]) * 0.25, 0);
    expect(domain[1]).toBeCloseTo(full[0] + (full[1] - full[0]) * 0.75, 0);
  });

  it('hides the slider when the option switches to polar', async () => {
    const c = await mount();
    c.setOption({ series: [{ id: 'p', type: 'pie', data: [1, 2, 3] }] }, { preserveView: false });
    await c.render();
    expect(c.dataZoomSlider!.state.display).toBe(false);
    expect(c.layout.slider).toBeNull();
  });
});
