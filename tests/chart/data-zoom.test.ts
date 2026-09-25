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

  it('reserves a vertical slider on the right when sliderY is declared', () => {
    const canvas = { x: 0, y: 0, width: 800, height: 420 };
    const before = computeLayout(normalizeOption(OPTION), null, canvas);
    const layout = computeLayout(
      normalizeOption({ ...OPTION, dataZoom: { start: 50, end: 100, sliderY: {} } }),
      null,
      canvas
    );
    expect(layout.sliderY).not.toBeNull();
    // 轨道在绘图区**右侧外**，与绘图区等高；绘图区为它让出宽度
    expect(layout.sliderY!.x).toBeGreaterThan(layout.plot.x + layout.plot.width);
    expect(layout.sliderY!.height).toBe(layout.plot.height);
    expect(layout.plot.width).toBeLessThan(before.plot.width);
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

  it('maps the y window to fractions and back（数值 y 轴）', async () => {
    const c = await mount();
    expect(c.domainYFractions()).toEqual([0, 1]);
    c.setDomainYFromFractions(0.25, 0.75, 'slider');
    const [start, end] = c.domainYFractions();
    expect(start).toBeCloseTo(0.25, 2);
    expect(end).toBeCloseTo(0.75, 2);
    const domain = c.getDomain('y').map(Number);
    const full = c.fullDomain('y').map(Number);
    expect(domain[0]).toBeCloseTo(full[0] + (full[1] - full[0]) * 0.25, 0);
    expect(domain[1]).toBeCloseTo(full[0] + (full[1] - full[0]) * 0.75, 0);
  });

  it('shows a vertical slider that reflects the y window', async () => {
    const c = await mount({ ...OPTION, dataZoom: { start: 0, end: 100, sliderY: {} } });
    const slider = c.dataZoomSliderY!;
    expect(slider.state.display).toBe(true);
    // 轨道摆在布局为它预留的那块矩形上
    expect(slider.state.width).toBe(c.layout.sliderY!.width);
    expect(slider.state.height).toBe(c.layout.sliderY!.height);
    expect(slider.start).toBeCloseTo(0, 2);
    expect(slider.end).toBeCloseTo(1, 2);
    // y 窗口一变，滑块位置跟着回显（滚轮 / 框选 / setAxisDomain 之后同理）
    c.setDomainYFromFractions(0.3, 0.8, 'slider');
    expect(slider.start).toBeCloseTo(0.3, 2);
    expect(slider.end).toBeCloseTo(0.8, 2);
  });

  it('drags the y window toward smaller values when pulled down（上 = 大值）', async () => {
    const c = await mount({ ...OPTION, dataZoom: { start: 0, end: 100, sliderY: {} } });
    const rect = c.layout.sliderY!;
    const midX = rect.x + rect.width / 2;
    c.setDomainYFromFractions(0.25, 0.75, 'slider');
    const before = c.getDomain('y').map(Number);
    c.controller.handlePointerDown(midX, rect.y + rect.height * 0.5);
    expect(c.dataZoomSliderY!.activePart).toBe('window');
    // 往下拖 = 窗口朝小值走（纵向的符号与横向相反，别抄横向那条）
    c.controller.handlePointerMove(midX, rect.y + rect.height * 0.7);
    c.controller.handlePointerUp(midX, rect.y + rect.height * 0.7);
    const after = c.getDomain('y').map(Number);
    expect(after[0]).toBeLessThan(before[0]);
    expect(after[1]).toBeLessThan(before[1]);
    // 平移：跨度不变
    expect(after[1] - after[0]).toBeCloseTo(before[1] - before[0], 3);
  });

  it('drives the axis named by sliderY.axisIndex（多 y 轴）', async () => {
    const multi: ChartOption = {
      dataZoom: { start: 0, end: 100, sliderY: { axisIndex: 1 } },
      yAxis: [{ name: '成交量' }, { name: '涨跌幅' }],
      series: [
        { id: 'volume', type: 'bar', name: '成交量', data: [1200, 1350, 980, 1500] },
        { id: 'change', type: 'line', name: '涨跌幅', yAxisIndex: 1, data: [1.2, -0.8, 2.4, -1.6] },
      ],
    };
    const c = await mount(multi);
    const rect = c.layout.sliderY!;
    const midX = rect.x + rect.width / 2;
    // 回显的是**副轴**的窗口，不是主轴
    c.setAxisDomain(1, [0, 1.5], 'api');
    const before = c.dataZoomSliderY!.start;
    const primaryBefore = c.getDomain('y');
    c.controller.handlePointerDown(midX, rect.y + rect.height * (1 - (before + 0.25)));
    c.controller.handlePointerMove(midX, rect.y + rect.height * (1 - before));
    c.controller.handlePointerUp(midX, rect.y + rect.height * (1 - before));
    // 主轴不受影响，副轴变了
    expect(c.getDomain('y')).toEqual(primaryBefore);
    // 往下拖 = 副轴窗口朝小值走（与单轴那条同一个方向约定）
    expect(c.domainYFractions(1)[0]).toBeLessThan(before);
  });

  it('resizes the y window by dragging the top handle', async () => {
    const c = await mount({ ...OPTION, dataZoom: { start: 0, end: 100, sliderY: {} } });
    const rect = c.layout.sliderY!;
    const midX = rect.x + rect.width / 2;
    // 上端手柄 = 窗口的 end（大值那一侧）
    c.controller.handlePointerDown(midX, rect.y);
    expect(c.dataZoomSliderY!.activePart).toBe('end');
    c.controller.handlePointerMove(midX, rect.y + rect.height * 0.4);
    c.controller.handlePointerUp(midX, rect.y + rect.height * 0.4);
    const [start, end] = c.domainYFractions();
    expect(end).toBeCloseTo(0.6, 1);
    expect(start).toBeCloseTo(0, 1);
  });

  it('recenters the y window when the vertical track is clicked', async () => {
    const c = await mount({ ...OPTION, dataZoom: { start: 0, end: 100, sliderY: {} } });
    const rect = c.layout.sliderY!;
    const midX = rect.x + rect.width / 2;
    c.setDomainYFromFractions(0, 0.3, 'slider');
    // 点轨道靠上（= 大值一侧）→ 窗口上移
    c.controller.handlePointerDown(midX, rect.y + rect.height * 0.1);
    // 松手会清掉 activePart（x 那条用例也是这么断言的），所以这里在松手前看
    expect(c.dataZoomSliderY!.activePart).toBe('window');
    c.controller.handlePointerUp(midX, rect.y + rect.height * 0.1);
    expect(c.domainYFractions()[0]).toBeGreaterThan(0);
  });

  it('keeps the vertical slider out of a category y axis（横向柱不吃 y 视窗）', async () => {
    // 归一化里有一条既有规则：类目 y 轴不吃 y 视窗（两个路径一致）。
    // 给它一条能拖但拖了没反应的轨道只会骗人，所以目标轴是类目轴时不出滑块。
    const c = await mount({
      dataZoom: { sliderY: {} },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] },
      series: [{ id: 'a', type: 'bar', name: 'A', data: [10, 20, 30, 40, 50, 60, 70, 80] }],
    });
    expect(c.layout.sliderY).toBeNull();
    expect(c.dataZoomSliderY!.state.display).toBe(false);
  });

  it('uses dataZoom.slider.color / sliderY.color as the window fill', async () => {
    const c = await mount({
      ...OPTION,
      dataZoom: { start: 0, end: 50, slider: { color: '#ff0000' }, sliderY: { color: '#00ff00' } },
    });
    // 这个字段以前文档里有、代码里从来没用过（组件根本没有颜色字段），一并做实
    expect(c.dataZoomSlider!.windowColor).toBe('#ff0000');
    expect(c.dataZoomSliderY!.windowColor).toBe('#00ff00');
  });

  it('keeps the vertical slider hidden when sliderY is not configured', async () => {
    const c = await mount();
    expect(c.dataZoomSliderY!.state.display).toBe(false);
  });

  it('hides the slider when the option switches to polar', async () => {
    const c = await mount();
    c.setOption({ series: [{ id: 'p', type: 'pie', data: [1, 2, 3] }] }, { preserveView: false });
    await c.render();
    expect(c.dataZoomSlider!.state.display).toBe(false);
    expect(c.layout.slider).toBeNull();
  });
});
