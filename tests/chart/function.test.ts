import { createChart, setMotionPreference } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import { computeLayout } from '../../src/layout/layout';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const OPTION: ChartOption = {
  legend: { show: true },
  tooltip: { trigger: 'item' },
  xAxis: { type: 'value' },
  yAxis: {},
  series: [
    { id: 'f1', type: 'function', name: 'sin(x)/x', expression: 'sin(x)/x', domain: [-10, 10], color: '#0D6EFD' },
    { id: 'f2', type: 'function', name: 'x^2/20-2', expression: 'x^2/20 - 2', domain: [-10, 10], color: '#DC3545' },
  ],
};

describe('函数绘图（纯函数层）', () => {
  it('按表达式生成锚点，x 覆盖声明区间', () => {
    const norm = normalizeOption({ ...OPTION, series: [OPTION.series![0]] });
    expect(norm.kind).toBe('cartesian');
    const points = norm.series[0].points;
    expect(points.length).toBe(240);
    expect(points[0].xValue).toBe(-10);
    expect(points[points.length - 1].xValue).toBe(10);
    // sin(x)/x 在 x→0 处 → 1（0 不在采样点上，取最近点的近似）
    const near = points.reduce((best, p) => (Math.abs(p.xValue) < Math.abs(best.xValue) ? p : best), points[0]);
    expect(near.y).toBeCloseTo(1, 3);
  });

  it('y 轴数据域用稳健范围：1/x 的尖峰不会把轴拉到 ±2500', () => {
    const norm = normalizeOption({
      ...OPTION,
      series: [{ id: 'inv', type: 'function', name: '1/x', expression: '1/x' }],
    });
    const [min, max] = norm.yAxis.domain as [number, number];
    expect(Math.abs(min)).toBeLessThan(50);
    expect(Math.abs(max)).toBeLessThan(50);
    expect(max).toBeGreaterThan(min);
  });

  it('表达式编译失败不抛异常，但会把原因记下来', () => {
    const norm = normalizeOption({
      ...OPTION,
      series: [{ id: 'bad', type: 'function', name: 'bad', expression: 'sin(x' }],
    });
    expect(norm.series[0].expressionError).toMatch(/缺少右括号/);
    expect(norm.series[0].points.every((p) => p.y === null)).toBe(true);
  });

  it('参数曲线：x 轴数据域来自 x(t) 而不是参数 t', () => {
    const norm = normalizeOption({
      legend: { show: false },
      xAxis: { type: 'value' },
      yAxis: {},
      series: [
        {
          id: 'circle',
          type: 'parametric',
          name: 'circle',
          xExpression: 'cos(t)',
          yExpression: 'sin(t)',
          domain: [0, Math.PI * 2],
        },
      ],
    });
    const [min, max] = norm.xAxis.domain as [number, number];
    expect(min).toBeLessThanOrEqual(-0.9);
    expect(max).toBeGreaterThanOrEqual(0.9);
    expect(norm.series[0].points[0].xValue).toBe(0); // xValue 是参数 t
    expect((norm.series[0].points[0].raw as any).x).toBeCloseTo(1, 6);
  });

  it('布局后绘图区正常（不因为「没有 data」而塌缩）', () => {
    const ctx: any = { measureText: (t: string) => ({ width: String(t).length * 6 }) };
    const norm = normalizeOption(OPTION);
    const layout = computeLayout(norm, ctx, { x: 0, y: 0, width: 600, height: 400 });
    expect(layout.plot.width).toBeGreaterThan(300);
    expect(layout.plot.height).toBeGreaterThan(200);
  });
});

describe('函数绘图（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    setMotionPreference('instant');
    canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 400;
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
    chart.finishAnimations();
    await chart.render();
    return chart;
  }

  it('画出曲线：采样点覆盖绘图区，且锚点与曲线上的点一致', async () => {
    const c = await mount();
    const component: any = c.seriesComponents[0];
    // 曲线采样数 ≥ 基础采样数（自适应会加点）
    expect(component.sampleCount()).toBeGreaterThanOrEqual(240);
    const curve = component.curvePoints();
    let inside = 0;
    for (let i = 0; i < curve.length; i += 2) {
      const x = curve[i];
      const y = curve[i + 1];
      if (isFinite(x) && isFinite(y) && x >= 0 && x <= c.layout.plot.width && y >= 0 && y <= c.layout.plot.height) inside++;
    }
    expect(inside).toBeGreaterThan(100);
  });

  it('曲线可命中：指针移到曲线上能拿到数据点与提示框', async () => {
    const c = await mount();
    const component: any = c.seriesComponents[0];
    const index = 120;
    const pixel = component.pixelAt(index)!;
    const sx = c.layout.plot.x + pixel[0];
    const sy = c.layout.plot.y + pixel[1];
    expect(c.ice.hitTest(sx, sy)).toBe(component);
    const target = c.controller.resolveTarget(sx, sy);
    expect(target.index).toBe(index);
    c.controller.handlePointerMove(sx, sy);
    await c.render();
    const hover: any = c.controller.hover;
    expect(hover).not.toBeNull();
    expect(hover.item.point.index).toBe(index);
    const rect = c.tooltip!.lastRect as any;
    expect(rect).not.toBeNull();
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(c.layout.canvas.width + 0.5);
  });

  it('缩放到局部后按可视区间重新采样（y 轴自动贴合）', async () => {
    // 单系列：sin(x)/x 在 x∈[-10,10] 的值域约 [-0.22, 1]，缩到 [-1,1] 后应贴到 [0.84, 1]
    const c = await mount({ ...OPTION, series: [OPTION.series![0]] });
    const before = (c.norm.yAxis.domain as number[]).slice();
    c.setDomain('x', [-1, 1]);
    await c.render();
    const after = (c.norm.yAxis.domain as number[]).slice();
    expect(after[1] - after[0]).toBeLessThan(before[1] - before[0]);
    expect(after[0]).toBeGreaterThan(0.5);
    expect(after[1]).toBeLessThan(1.5);
  });

  it('表达式错误通过 expressionErrors() 暴露，图表照常渲染', async () => {
    const c = await mount({ ...OPTION, series: [{ id: 'bad', type: 'function', name: 'bad', expression: 'sin(x' }] });
    const errors = c.expressionErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].seriesId).toBe('bad');
    expect(errors[0].message).toMatch(/缺少右括号/);
  });

  it('参数曲线：曲线闭合、可命中、提示框给 (x, y)', async () => {
    const c = await mount({
      legend: { show: false },
      tooltip: { trigger: 'item' },
      xAxis: { type: 'value' },
      yAxis: {},
      series: [
        {
          id: 'p',
          type: 'parametric',
          name: 'circle',
          xExpression: 'cos(t)',
          yExpression: 'sin(t)',
          domain: [0, Math.PI * 2],
        },
      ],
    });
    const component: any = c.seriesComponents[0];
    // 单位圆上的锚点都落在圆上（数据坐标 → 像素，再反查）
    const pixel = component.pixelAt(0)!;
    const sx = c.layout.plot.x + pixel[0];
    const sy = c.layout.plot.y + pixel[1];
    expect(c.ice.hitTest(sx, sy)).toBe(component);
    expect(c.controller.resolveTarget(sx, sy).index).toBe(0);
    c.controller.handlePointerMove(sx, sy);
    await c.render();
    const hover: any = c.controller.hover;
    expect(hover).not.toBeNull();
    const raw: any = hover.item.point.raw;
    expect(Math.hypot(raw.x, raw.y)).toBeCloseTo(1, 6);
    expect(c.tooltip!.lastRect).not.toBeNull();
  });

  it('参数扫动：instant 模式停在起点（截图确定），full 模式随时间推进', async () => {
    const option: ChartOption = {
      ...OPTION,
      series: [
        {
          id: 's',
          type: 'function',
          name: 'a*sin(x)',
          expression: 'a*sin(x)',
          params: { a: 1 },
          sweep: { name: 'a', from: -2, to: 2, duration: 900, mode: 'linear' as any },
        },
      ],
    };
    setMotionPreference('instant');
    const still = await mount(option);
    const component: any = still.seriesComponents[0];
    expect(component.paramValue('a')).toBe(-2);
    expect(component.props.animations && component.props.animations.__tick).toBeFalsy();
    still.destroy();
    chart = null;

    setMotionPreference('full');
    const animated = await mount(option);
    const moving: any = animated.seriesComponents[0];
    const first = moving.paramValue('a');
    // 扫动时组件进入持续重绘（每帧重算曲线）
    expect(!!(moving.props.animations && moving.props.animations.__tick)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 260));
    const later = moving.paramValue('a');
    expect(later).not.toBeCloseTo(first, 3);
    expect(later).toBeGreaterThanOrEqual(-2);
    expect(later).toBeLessThanOrEqual(2);
  });

  it('aspect: equal —— 单位圆在像素上是圆的，绘图区是正方形', async () => {
    const option: ChartOption = {
      aspect: 'equal',
      legend: { show: false },
      xAxis: { type: 'value' },
      yAxis: {},
      series: [
        {
          id: 'c',
          type: 'parametric',
          name: 'circle',
          xExpression: 'cos(t)',
          yExpression: 'sin(t)',
          domain: [0, Math.PI * 2],
          samples: 240,
        },
      ],
    };
    const c = await mount(option);
    const plot = c.layout.plot;
    // 1) 绘图区是正方形
    expect(Math.abs(plot.width - plot.height)).toBeLessThanOrEqual(1);
    // 2) 单位长度在 x / y 上等长（圆才是圆）
    const xScale: any = c.norm.xAxis.scale;
    const yScale: any = c.norm.yAxis.scale;
    const pxPerUnitX = Math.abs(xScale.map(1) - xScale.map(0));
    const pxPerUnitY = Math.abs(yScale.map(1) - yScale.map(0));
    expect(pxPerUnitX).toBeCloseTo(pxPerUnitY, 1);
    // 3) 曲线在像素上确实是圆（取 t=0 与 t=π/2 两点，到圆心距离相等）
    const component: any = c.seriesComponents[0];
    const points = component.series.points;
    const nearest = (tx: number, ty: number) => {
      let best = 0;
      let bestDist = Infinity;
      points.forEach((point: any, i: number) => {
        const d = Math.hypot(point.raw.x - tx, point.raw.y - ty);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      return component.pixelAt(best)!;
    };
    const right = nearest(1, 0);
    const top = nearest(0, 1);
    const centerX = plot.width / 2;
    const centerY = plot.height / 2;
    const radiusRight = Math.hypot(right[0] - centerX, right[1] - centerY);
    const radiusTop = Math.hypot(top[0] - centerX, top[1] - centerY);
    expect(radiusRight).toBeCloseTo(radiusTop, 0);
    // 不等比时会被拉伸 2 倍以上 —— 这条断言就是回归门禁
    expect(Math.abs(radiusRight - radiusTop)).toBeLessThan(2);
  });

  it('aspect: equal 不影响类目轴（照旧按 band 排布）', async () => {
    const c = await mount({
      aspect: 'equal',
      legend: { show: false },
      xAxis: { type: 'category' },
      yAxis: {},
      series: [{ id: 'b', type: 'bar', name: 'B', data: [3, 8, 5] }],
    });
    expect(c.norm.xAxis.domain).toEqual([0, 1, 2]);
    expect(c.seriesComponents[0].pixelAt(1)).not.toBeNull();
  });
});
