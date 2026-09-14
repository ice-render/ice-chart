import { normalizeOption } from '../../src/option/normalize';
import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/**
 * 数据域留白（CSS padding 的意思）：曲线不贴绘图区边框。
 *
 * 起因是实测：46 张示例直角坐标图里 34 张的系列墨迹贴到了绘图区边缘（距离 < 2px），
 * 看起来像"画到框外面去了"。
 */
describe('数据域留白', () => {
  it('数值轴默认上下各留 5%，数据最大值不再贴着上边界', () => {
    const norm = normalizeOption({
      series: [{ type: 'line', data: [100, 200, 150] }],
    });
    const [min, max] = norm.yAxis.domain;
    expect(min).toBeLessThanOrEqual(100);
    expect(max).toBeGreaterThan(200);
    // 5% 留白按「数据跨度」算：跨度 100 → 上下各 5 → 至少到 205
    expect(max).toBeGreaterThanOrEqual(205);
    expect(min).toBeLessThanOrEqual(95);
  });

  it('显式写 min / max 的一侧不受留白影响（用户说了算）', () => {
    const norm = normalizeOption({
      yAxis: { min: 0, max: 200 },
      series: [{ type: 'line', data: [100, 200, 150] }],
    });
    expect(norm.yAxis.domain).toEqual([0, 200]);
  });

  it('柱子 / 面积的 0 基线保持贴在轴上，只在上方留白', () => {
    const norm = normalizeOption({
      series: [{ type: 'bar', data: [300, 500, 400] }],
    });
    const [min, max] = norm.yAxis.domain;
    expect(min).toBe(0);
    expect(max).toBeGreaterThan(500);
  });

  it('padding: 0 关掉留白（需要精确贴边的场景）', () => {
    const norm = normalizeOption({
      yAxis: { padding: 0 },
      series: [{ type: 'line', data: [100, 200, 150] }],
    });
    expect(norm.yAxis.domain[1]).toBe(200);
  });

  it('padding 可以调大（例如给标注留地方）', () => {
    const norm = normalizeOption({
      yAxis: { padding: 0.2 },
      series: [{ type: 'line', data: [0, 100] }],
    });
    expect(norm.yAxis.domain[1]).toBeGreaterThanOrEqual(120);
  });

  it('log 轴不做留白（按对数比例外扩会失真）', () => {
    const norm = normalizeOption({
      yAxis: { type: 'log' },
      series: [{ type: 'line', data: [1, 10, 100] }],
    });
    expect(norm.yAxis.domain).toEqual([1, 100]);
  });
});

/**
 * 交互窗口兜底：不能把曲线压成一个点。
 *
 * 起因是实测：dataZoom 滑块拖到最右（窗口 [0.98, 1]）时，
 * 30 天逐小时的数据窗口落进了「取整出来的空白区」——可视点数为 0，
 * 整条曲线什么都不画（墨迹 0×0）。
 */
describe('交互窗口至少盖住 2 个数据点', () => {
  let canvas: HTMLCanvasElement;
  let chart: ICEChart | null = null;

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  const mount = (option: ChartOption) => {
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 400;
    document.body.appendChild(canvas);
    chart = createChart(canvas, option);
    return chart;
  };

  const numeric = (): ChartOption => ({
    dataZoom: { start: 0, end: 100 },
    xAxis: { type: 'value' },
    yAxis: {},
    series: [{ id: 'a', type: 'line', data: Array.from({ length: 30 }, (_, i) => [i, i % 5]) }],
  });

  const visibleCount = (c: ICEChart) => {
    const dom = c.norm.xAxis.domain.map(Number);
    return c.seriesComponents[0].series.points.filter((p) => Number(p.xValue) >= dom[0] && Number(p.xValue) <= dom[1]).length;
  };

  it('滑块拖到最右（窗口只剩空白区）时，窗口被扩回至少 2 个点', () => {
    const c = mount(numeric());
    c.setDomainFromFractions(0.98, 1, 'slider', true);
    expect(visibleCount(c)).toBeGreaterThanOrEqual(2);
  });

  it('滚轮缩放到极窄时同样至少盖住 2 个点', () => {
    const c = mount(numeric());
    const full = c.fullXDomain.map(Number);
    const span = full[1] - full[0];
    // 一个只盖住 1 个点的窗口（数据点在整数位置）
    c.setDomain('x', [full[1] - span * 0.001, full[1]], 'zoom');
    expect(visibleCount(c)).toBeGreaterThanOrEqual(2);
  });

  it('程序化调用不受兜底影响（纯映射，比例 → 域是确定的）', () => {
    const c = mount(numeric());
    const full = c.fullXDomain.map(Number);
    c.setDomainFromFractions(0.25, 0.75, 'slider');
    const [start, end] = c.domainFractions();
    expect(start).toBeCloseTo(0.25, 3);
    expect(end).toBeCloseTo(0.75, 3);
    expect(Number(c.getDomain('x')[0])).toBeCloseTo(full[0] + (full[1] - full[0]) * 0.25, 1);
  });

  it('类目轴窗口至少保留 2 个类目', () => {
    const c = mount({
      dataZoom: { start: 0, end: 100 },
      xAxis: { type: 'category', data: ['A', 'B', 'C', 'D', 'E'] },
      yAxis: {},
      series: [{ id: 'a', type: 'bar', data: [1, 2, 3, 4, 5] }],
    });
    c.setDomainFromFractions(0.4, 0.41, 'slider', true);
    expect(c.norm.xAxis.domain.length).toBeGreaterThanOrEqual(2);
  });
});
