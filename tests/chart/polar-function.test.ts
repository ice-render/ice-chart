import { createChart, setMotionPreference } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/**
 * 极坐标函数 r(θ)（`polarExpression` 简写）+ 极坐标网格。
 *
 * 几何契约：r(θ) 展开成参数曲线 (r·cosθ, r·sinθ)；
 * 坐标轴等比（aspect: 'equal'）时，曲线上的点到原点的**像素**距离 = r × 单位长度。
 */

const ROSE: ChartOption = {
  aspect: 'equal',
  polarGrid: { splitNumber: 4, spokeCount: 12 },
  legend: { show: false },
  tooltip: { trigger: 'item' },
  xAxis: { type: 'value' },
  yAxis: {},
  series: [
    {
      id: 'rose',
      type: 'parametric',
      name: 'r = cos(3θ)',
      polarExpression: 'cos(3*t)',
      domain: [0, Math.PI * 2],
      samples: 240,
    },
  ],
};

describe('极坐标函数（纯函数层）', () => {
  it('r(θ) 展开成 (r·cosθ, r·sinθ)：采样点都满足 r = cos(3θ)', () => {
    const norm = normalizeOption(ROSE);
    expect(norm.series[0].points.length).toBe(240);
    for (let i = 0; i < norm.series[0].points.length; i += 7) {
      const raw: any = norm.series[0].points[i].raw;
      const t = raw.t;
      expect(raw.r).toBeCloseTo(Math.cos(3 * t), 9);
      expect(raw.x).toBeCloseTo(Math.cos(3 * t) * Math.cos(t), 9);
      expect(raw.y).toBeCloseTo(Math.cos(3 * t) * Math.sin(t), 9);
    }
    // 玫瑰线 r=cos(3θ) 的最大半径是 1
    const [x0, x1] = norm.xAxis.domain as number[];
    expect(x1).toBeGreaterThan(0.9);
    expect(x0).toBeLessThan(-0.9);
  });

  it('等比坐标：x / y 跨度相同（否则圆会被拉成椭圆）', () => {
    const norm = normalizeOption(ROSE);
    const xSpan = Math.abs(Number(norm.xAxis.domain[1]) - Number(norm.xAxis.domain[0]));
    const ySpan = Math.abs(Number(norm.yAxis.domain[1]) - Number(norm.yAxis.domain[0]));
    expect(xSpan).toBeCloseTo(ySpan, 6);
  });

  it('表达式诊断按 r(θ) 报（而不是拿派生的 x/y 去判断）', () => {
    const norm = normalizeOption({
      ...ROSE,
      series: [{ id: 'bad', type: 'parametric', name: 'bad', polarExpression: 'b*cos(3*t)', params: { a: 1 } }],
    });
    const codes = (norm.series[0].expressionDiagnostics || []).map((d) => d.code);
    expect(codes).toContain('unknown-variable');
    expect(codes).toContain('unused-parameter');
    expect((norm.series[0].expressionDiagnostics || [])[0].message).toMatch(/^r\(θ\)：/);
  });
});

describe('极坐标函数（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    setMotionPreference('instant');
    canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 520;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  async function mount(option: ChartOption = ROSE): Promise<ICEChart> {
    chart = createChart(canvas, option);
    await chart.render();
    chart.finishAnimations();
    await chart.render();
    return chart;
  }

  it('曲线按 r(θ) 画出来：像素上「到原点的距离 / 单位长度」等于 r', () => {
    return mount().then(async (c) => {
      const component: any = c.seriesComponents[0];
      const xScale: any = c.norm.xAxis.scale;
      const yScale: any = c.norm.yAxis.scale;
      const unit = Math.abs(xScale.map(1) - xScale.map(0));
      expect(unit).toBeGreaterThan(1);
      const originX = xScale.map(0);
      const originY = yScale.map(0);
      const points = component.series.points;
      for (let i = 0; i < points.length; i += 11) {
        const pixel = component.pixelAt(i)!;
        const raw: any = points[i].raw;
        const radiusPx = Math.hypot(pixel[0] - originX, pixel[1] - originY);
        expect(radiusPx / unit).toBeCloseTo(Math.abs(raw.r), 4);
      }
    });
  });

  it('极坐标网格：同心圆数量与配置一致，且不会画出绘图区', async () => {
    const c = await mount();
    const grid: any = c.polarGrid;
    expect(grid.state.display).toBe(true);
    const geo = grid.geometry();
    expect(geo).not.toBeNull();
    // 圆心到最近边界的距离 = 网格半径（同心圆必然落在绘图区内）
    const plot = c.layout.plot;
    const expected = Math.min(
      Math.abs(geo.cx - plot.x),
      Math.abs(plot.x + plot.width - geo.cx),
      Math.abs(geo.cy - plot.y),
      Math.abs(plot.y + plot.height - geo.cy)
    );
    expect(geo.radiusPx).toBeCloseTo(expected, 6);
    expect(geo.rMax).toBeGreaterThan(0);
  });

  it('没开 aspect:equal 时不画极坐标网格（否则圆是椭圆、网格对不上）', async () => {
    const c = await mount({ ...ROSE, aspect: 'auto' });
    expect((c.polarGrid as any).state.display).toBe(false);
  });

  it('r(θ) 曲线可命中、提示框给出坐标', async () => {
    const c = await mount();
    const component: any = c.seriesComponents[0];
    const pixel = component.pixelAt(0)!;
    const sx = c.layout.plot.x + pixel[0];
    const sy = c.layout.plot.y + pixel[1];
    expect(c.ice.hitTest(sx, sy)).toBe(component);
    expect(c.controller.resolveTarget(sx, sy).index).toBe(0);
    c.controller.handlePointerMove(sx, sy);
    await c.render();
    const hover: any = c.controller.hover;
    expect(hover).not.toBeNull();
    expect(hover.item.point.index).toBe(0);
    expect(c.tooltip!.lastRect).not.toBeNull();
  });
});
