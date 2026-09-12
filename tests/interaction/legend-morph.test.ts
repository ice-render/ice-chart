import { createChart, setMotionPreference } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/**
 * 图例切换（隐藏扇区 / 阶段 / 系列）时的重排过渡。
 *
 * 序列图例项本身是「留在原位变灰」，真正会重排的是饼图扇区与漏斗阶段：
 * 少了一个之后其余几何要重新分配，硬切会看到整块图「跳」一下。
 */

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PIE: ChartOption = {
  legend: { show: true },
  animation: { enter: { duration: 60 }, update: { duration: 500, easing: 'linear' } },
  series: [
    {
      id: 'share',
      type: 'pie',
      name: '份额',
      data: [
        { name: 'A', value: 50 },
        { name: 'B', value: 30 },
        { name: 'C', value: 20 },
      ],
    },
  ],
};

const FUNNEL: ChartOption = {
  legend: { show: true },
  animation: { enter: { duration: 60 }, update: { duration: 500, easing: 'linear' } },
  series: [
    {
      id: 'funnel',
      type: 'funnel',
      name: '转化',
      data: [
        { name: '曝光', value: 1000 },
        { name: '点击', value: 600 },
        { name: '加购', value: 300 },
        { name: '下单', value: 100 },
      ],
    },
  ],
};

describe('图例切换的重排过渡', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    setMotionPreference('full');
    canvas = document.createElement('canvas');
    canvas.width = 760;
    canvas.height = 420;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    setMotionPreference('instant');
  });

  async function mount(option: ChartOption): Promise<ICEChart> {
    chart = createChart(canvas, option);
    await chart.render();
    chart.finishAnimations();
    await chart.render();
    return chart;
  }

  it('饼图：隐藏一个扇区时，其余扇区滑到新角度、被隐藏的那个收拢到 0', async () => {
    const c = await mount(PIE);
    const component: any = c.seriesComponents[0];
    const before = Array.from(component.slices) as number[];
    expect(before[4] - before[5]).not.toBe(0);

    c.toggleSlice('share', 1);
    await c.render();
    const progress = Number(component.state.progress);
    expect(progress).toBeLessThan(1);

    await wait(150);
    await c.render();
    const mid = Array.from(component.slices) as number[];
    // 第二个扇区（被隐藏）正在收拢：还有角度但比原来小
    const sweptBefore = Math.abs(before[5] - before[4]);
    const sweptMid = Math.abs(mid[5] - mid[4]);
    expect(sweptMid).toBeGreaterThan(0);
    expect(sweptMid).toBeLessThan(sweptBefore);
    // 第一个扇区的终点跟着往前挪（不是停在旧角度）
    expect(mid[1]).not.toBeCloseTo(before[1], 4);

    await wait(600);
    await c.render();
    expect(Number(component.state.progress)).toBe(1);
    const after = Array.from(component.slices) as number[];
    // 收拢到位：被隐藏的扇区扫过角为 0
    expect(Math.abs(after[5] - after[4])).toBeLessThan(1e-6);
    // 剩下两个扇区重新占满整圆
    expect(component.pixelAt(1)).toBeNull();
    expect(component.pixelAt(0)).not.toBeNull();
  });

  it('漏斗：隐藏一个阶段时，其余阶段平滑上移（不是瞬间跳）', async () => {
    const c = await mount(FUNNEL);
    const component: any = c.seriesComponents[0];
    const before = component.highlightRectAt(2)!;

    c.toggleSlice('funnel', 1);
    await c.render();
    expect(Number(component.state.progress)).toBeLessThan(1);

    await wait(150);
    await c.render();
    const mid = component.highlightRectAt(2)!;
    expect(mid.y).not.toBeCloseTo(before.y, 3);

    await wait(600);
    await c.render();
    expect(Number(component.state.progress)).toBe(1);
    const after = component.highlightRectAt(2)!;
    expect(after.y).not.toBeCloseTo(before.y, 1);
    // 被隐藏的阶段不再参与布局
    expect(component.highlightRectAt(1)).toBeNull();
  });

  it('系列图例切换也走更新动画（隐藏最大值那条时，坐标轴与其它系列一起过渡）', async () => {
    const c = await mount({
      legend: { show: true },
      animation: { enter: { duration: 60 }, update: { duration: 500, easing: 'linear' } },
      xAxis: { type: 'category' },
      yAxis: {},
      series: [
        { id: 'a', type: 'bar', name: 'A', data: [10, 20, 30] },
        { id: 'b', type: 'bar', name: 'B', data: [500, 400, 300] },
      ],
    } as ChartOption);
    const domainBefore = (c.norm.yAxis.scale as any).domain.slice();
    c.toggleSeries('b');
    await c.render();
    const domainAfter = (c.norm.yAxis.scale as any).domain.slice();
    // 数据域变小了，而且过渡已经在跑（系列进度 < 1）
    expect(Number(domainAfter[1])).toBeLessThan(Number(domainBefore[1]));
    // 只看可见系列：被隐藏那条不进动画（display:false），它的 progress 还停在上一次的终态
    const progress = Number((c.seriesComponents[0] as any).state.progress);
    expect(progress).toBeLessThan(1);
  });
});
