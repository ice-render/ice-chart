import { createChart, setMotionPreference } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import { computeLayout } from '../../src/layout/layout';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const FUNNEL: ChartOption = {
  title: { text: '转化漏斗' },
  legend: { show: true, position: 'right' },
  series: [
    {
      id: 'funnel',
      type: 'funnel',
      name: '转化',
      data: [
        { name: '曝光', value: 1000 },
        { name: '点击', value: 620 },
        { name: '加购', value: 310 },
        { name: '下单', value: 120 },
      ],
    },
  ],
};

const GAUGE: ChartOption = {
  legend: { show: false },
  gauge: {
    min: 0,
    max: 100,
    splitNumber: 5,
    axisLineColor: [
      [0.6, '#198754'],
      [0.85, '#ffc107'],
      [1, '#dc3545'],
    ],
    detail: { formatter: (v) => `${Math.round(v)}%` },
  },
  series: [{ id: 'g', type: 'gauge', name: '完成率', data: [{ name: '季度目标', value: 72 }] }],
};

describe('漏斗图（纯函数层）', () => {
  it('switches the scene to funnel', () => {
    const norm = normalizeOption(FUNNEL);
    expect(norm.kind).toBe('funnel');
    expect(norm.funnel).not.toBeNull();
    expect(norm.option.tooltip.trigger).toBe('item');
  });

  it('builds legend items from stages (not series)', () => {
    const norm = normalizeOption(FUNNEL);
    const layout = computeLayout(norm, null, { x: 0, y: 0, width: 700, height: 420 });
    const items = layout.legend!.items;
    expect(items.map((i) => i.name)).toEqual(['曝光', '点击', '加购', '下单']);
    expect(items[0].dataIndex).toBe(0);
  });

  it('keeps the funnel inside the plot box', () => {
    const norm = normalizeOption(FUNNEL);
    const layout = computeLayout(norm, null, { x: 0, y: 0, width: 700, height: 420 });
    expect(layout.polar).toBeNull();
    expect(layout.plot.height).toBeGreaterThan(100);
  });
});

describe('仪表盘（纯函数层）', () => {
  it('switches the scene to gauge and prepares a circle', () => {
    const norm = normalizeOption(GAUGE);
    expect(norm.kind).toBe('gauge');
    expect(norm.gauge).not.toBeNull();
    const layout = computeLayout(norm, null, { x: 0, y: 0, width: 700, height: 420 });
    expect(layout.polar!.radius).toBeGreaterThan(layout.plot.height * 0.2);
    expect(layout.plot.width).toBeCloseTo(layout.polar!.radius * 2, 0);
  });
});

describe('漏斗图 / 仪表盘（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 760;
    canvas.height = 440;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  async function mount(option: ChartOption): Promise<ICEChart> {
    chart = createChart(canvas, option);
    await chart.render();
    return chart;
  }

  it('sorts stages by value and keeps the smallest one visible', async () => {
    const c = await mount(FUNNEL);
    const funnel: any = c.seriesComponents[0];
    const first = funnel.highlightRectAt(0)!; // 曝光 1000（最大）
    const last = funnel.highlightRectAt(3)!; // 下单 120（最小）
    expect(first.y).toBeLessThan(last.y);
    expect(first.width).toBeGreaterThan(last.width);
    // minSize 保证最小阶段仍然可见
    expect(last.width).toBeGreaterThan(c.layout.plot.width * 0.1);
    // 全部落在绘图区内
    for (const index of [0, 1, 2, 3]) {
      const rect = funnel.highlightRectAt(index)!;
      expect(rect.y).toBeGreaterThanOrEqual(-0.5);
      expect(rect.y + rect.height).toBeLessThanOrEqual(c.layout.plot.height + 0.5);
    }
  });

  it('hits a stage and reports name + percent in the tooltip', async () => {
    const c = await mount(FUNNEL);
    const funnel: any = c.seriesComponents[0];
    const rect = funnel.highlightRectAt(0)!;
    const sx = c.layout.plot.x + rect.x + rect.width / 2;
    const sy = c.layout.plot.y + rect.y + rect.height / 2;
    expect(c.ice.hitTest(sx, sy)).toBe(funnel);
    expect(c.controller.resolveTarget(sx, sy).index).toBe(0);
    c.controller.handlePointerMove(sx, sy);
    expect(c.tooltip!.content!.title).toBe('曝光');
    expect(c.tooltip!.content!.rows[0].value).toContain('1000');
    expect(c.tooltip!.content!.rows[0].value).toMatch(/%/);
  });

  it('misses the funnel in the blank area beside a stage', async () => {
    const c = await mount(FUNNEL);
    const funnel: any = c.seriesComponents[0];
    const rect = funnel.highlightRectAt(3)!; // 最窄的阶段
    const sx = c.layout.plot.x + c.layout.plot.width - 4;
    const sy = c.layout.plot.y + rect.y + rect.height / 2;
    expect(c.controller.resolveTarget(sx, sy).kind).not.toBe('series');
  });

  it('toggles a stage from the legend', async () => {
    const c = await mount(FUNNEL);
    const item = c.layout.legend!.items[0];
    c.controller.handleClick(item.x + item.width / 2, item.y + item.height / 2);
    expect(c.norm.hiddenSlices['funnel#0']).toBe(true);
    expect((c.seriesComponents[0] as any).hiddenSlices).toEqual([0]);
    // 隐藏后其余阶段重新铺满
    const funnel: any = c.seriesComponents[0];
    expect(funnel.highlightRectAt(0)).toBeNull();
  });

  it('renders a gauge with pointer, ticks and detail text', async () => {
    const c = await mount(GAUGE);
    const gauge: any = c.seriesComponents[0];
    // 整个表盘都是命中区
    const center = c.layout.polar!;
    expect(c.ice.hitTest(center.cx, center.cy)).toBe(gauge);
    expect(c.controller.resolveTarget(center.cx, center.cy).index).toBe(0);
    // 指针锚点在表盘内
    const pixel = gauge.pixelAt(0)!;
    expect(pixel[0]).toBeGreaterThan(0);
    expect(pixel[0]).toBeLessThan(c.layout.plot.width);
    // 提示框给名称与数值
    c.controller.handlePointerMove(center.cx, center.cy);
    expect(c.tooltip!.content!.title).toBe('季度目标');
    expect(c.tooltip!.content!.rows[0].value).toBe('72');
  });

  it('moves the pointer anchor when the value changes', async () => {
    const c = await mount(GAUGE);
    const gauge: any = c.seriesComponents[0];
    const before = gauge.pixelAt(0)!;
    c.setData('g', [{ name: '季度目标', value: 10 }]);
    await c.render();
    const after = gauge.pixelAt(0)!;
    expect(Math.abs(after[0] - before[0]) + Math.abs(after[1] - before[1])).toBeGreaterThan(5);
  });

  it('高频更新时指针从当前值接着扫，不会每次从最小值重来', async () => {
    setMotionPreference('full');
    chart = createChart(canvas, {
      ...JSON.parse(JSON.stringify(GAUGE)),
      animation: { enter: { duration: 60 }, update: { duration: 420, easing: 'linear' } },
    } as ChartOption);
    const gauge: any = chart.seriesComponents[0];
    chart.finishAnimations();
    await chart.render();

    chart.setData('g', [{ name: '季度目标', value: 80 }]);
    await chart.render();
    await new Promise((resolve) => setTimeout(resolve, 460));
    await chart.render();
    expect(gauge.renderedValue()).toBeCloseTo(80, 1);

    // 每 130ms 更新一次（监控大屏的节奏）：指针必须待在 80 附近，而不是掉回 0 附近
    for (let i = 0; i < 4; i++) {
      chart.setData('g', [{ name: '季度目标', value: 78 + i }]);
      await chart.render();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await chart.render();
      expect(gauge.renderedValue()).toBeGreaterThan(70);
    }
  });
});
