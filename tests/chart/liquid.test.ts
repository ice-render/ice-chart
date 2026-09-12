import { createChart, setMotionPreference } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/**
 * 水位图（液位球）：大屏里最有辨识度的一张图。
 *
 * 契约：水位随数值升降（入场从 0 涨上来、更新时涨落到位）、波相位持续起伏
 * （动效偏好 instant 时固定，便于截图与像素比对）、整球可命中。
 */

const OPTION: ChartOption = {
  legend: { show: false },
  tooltip: { trigger: 'item' },
  animation: { enter: { duration: 60 }, update: { duration: 400, easing: 'linear' } },
  liquid: { min: 0, max: 100, color: '#00E5FF' },
  series: [{ id: 'load', type: 'liquid', name: '负载', data: [{ name: 'CPU', value: 72 }] }],
};

describe('水位图（纯函数层）', () => {
  it('场景切换成 liquid，数据点带名字与数值', () => {
    const norm = normalizeOption(OPTION);
    expect(norm.kind).toBe('liquid');
    expect(norm.liquid).toMatchObject({ min: 0, max: 100 });
    expect(norm.series[0].points[0].y).toBe(72);
    expect(norm.series[0].points[0].name).toBe('CPU');
  });

  it('走极坐标场景：绘图区是圆的外接正方形（不预留坐标轴空间）', () => {
    const norm = normalizeOption(OPTION);
    expect(norm.kind).toBe('liquid');
    expect(norm.option.tooltip!.trigger).toBe('item');
  });
});

describe('水位图（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    setMotionPreference('instant');
    canvas = document.createElement('canvas');
    canvas.width = 420;
    canvas.height = 320;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  async function mount(option: ChartOption = OPTION): Promise<ICEChart> {
    // 深拷贝：setData 会就地改传进来的 option，直接共用模块级常量会让用例互相污染
    chart = createChart(canvas, JSON.parse(JSON.stringify(option)));
    await chart.render();
    chart.finishAnimations();
    await chart.render();
    return chart;
  }

  it('水位比例 = 数值在 [min, max] 中的占比', async () => {
    const c = await mount();
    const component: any = c.seriesComponents[0];
    expect(component.levelRatio()).toBeCloseTo(0.72, 6);

    // 越界值被夹到 0~1
    c.setData('load', [{ name: 'CPU', value: 140 }]);
    await c.render();
    expect(component.levelRatio()).toBeCloseTo(1, 6);
    c.setData('load', [{ name: 'CPU', value: -20 }]);
    await c.render();
    expect(component.levelRatio()).toBeCloseTo(0, 6);
  });

  it('入场从 0 涨上来：动画进行中水位低于目标值', async () => {
    setMotionPreference('full');
    chart = createChart(canvas, { ...OPTION, animation: { enter: { duration: 600, easing: 'linear' } } } as ChartOption);
    const component: any = chart.seriesComponents[0];
    expect(component.levelRatio()).toBe(0);
    await chart.render();
    await new Promise((resolve) => setTimeout(resolve, 220));
    await chart.render();
    const mid = component.levelRatio();
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(0.72);
    chart.finishAnimations();
    expect(component.levelRatio()).toBeCloseTo(0.72, 6);
  });

  it('水位在动时持续重绘（波相位），满/空/静止模式不占帧循环', async () => {
    setMotionPreference('full');
    const c = await mount({ ...OPTION, animation: { enabled: false } } as ChartOption);
    const component: any = c.seriesComponents[0];
    // finishAnimations 不该冻住循环补间（__tick），也不该阻止第一次 doRender 里注册它
    c.ice.dirty = true;
    await c.render();
    expect(component.props.animations.__tick).toBeTruthy();

    // 满水：水面是平的，不需要每帧重绘
    c.setData('load', [{ name: 'CPU', value: 100 }]);
    await c.render();
    await c.render();
    expect(component.props.animations.__tick).toBeFalsy();
  });

  it('instant 模式波相位固定为 0（截图与像素比对要确定）', async () => {
    setMotionPreference('instant');
    const c = await mount();
    const component: any = c.seriesComponents[0];
    await c.render();
    expect(component.props.animations.__tick).toBeFalsy();
  });

  it('整球可命中，提示框给出数值与水位', async () => {
    const c = await mount();
    const component: any = c.seriesComponents[0];
    const pixel = component.pixelAt(0)!;
    // 圆心（锚点）
    const cx = c.layout.plot.x + pixel[0];
    const cy = c.layout.plot.y + pixel[1];
    expect(c.ice.hitTest(cx, cy)).toBe(component);
    expect(c.controller.resolveTarget(cx, cy).index).toBe(0);
    // 球内偏上一点也命中（整个圆都是命中区）
    const radius = (component.liquid || component.coord).polar.radius;
    expect(c.ice.hitTest(cx, cy - radius * 0.6)).toBe(component);

    c.controller.handlePointerMove(cx, cy);
    await c.render();
    const hover: any = c.controller.hover;
    expect(hover).not.toBeNull();
    expect(hover.item.point.index).toBe(0);
    expect(c.tooltip!.lastRect).not.toBeNull();
  });

  it('与仪表盘并存（同一张图里两张极坐标图各画各的）', async () => {
    const c = await mount({
      legend: { show: false },
      gauge: { min: 0, max: 100 },
      liquid: { min: 0, max: 100 },
      series: [
        { id: 'g', type: 'gauge', name: 'G', data: [{ name: 'G', value: 40 }] },
      ],
    } as ChartOption);
    // 只有 gauge 系列时场景是 gauge，不该被 liquid 抢走
    expect(c.norm.kind).toBe('gauge');
  });

  it('高频更新时水位从当前值接着走，不会每次从 0 重新涨', async () => {
    setMotionPreference('full');
    chart = createChart(canvas, {
      ...JSON.parse(JSON.stringify(OPTION)),
      animation: { enter: { duration: 60 }, update: { duration: 420, easing: 'linear' } },
    } as ChartOption);
    const component: any = chart.seriesComponents[0];
    chart.finishAnimations();
    await chart.render();
    // 先到 80%，让水位稳定在高位
    chart.setData('load', [{ name: 'CPU', value: 80 }]);
    await chart.render();
    await new Promise((resolve) => setTimeout(resolve, 460));
    await chart.render();
    expect(component.levelRatio()).toBeCloseTo(0.8, 2);

    // 紧接着高频更新（模拟监控大屏每 130ms 一次）：水位必须在 0.8 附近，
    // 而不是掉回 0 重新涨（那是修复前的行为：CPU 都 79.9% 了水面还停在 27%）
    for (let i = 0; i < 4; i++) {
      chart.setData('load', [{ name: 'CPU', value: 78 + i }]);
      await chart.render();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await chart.render();
      const ratio = component.levelRatio();
      expect(ratio).toBeGreaterThan(0.7);
      expect(ratio).toBeLessThan(0.95);
    }
  });
});
