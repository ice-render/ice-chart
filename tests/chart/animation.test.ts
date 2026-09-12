import { createChart, setMotionPreference, shouldAnimate, getMotionPreference } from '../../src/index';
import { normalizeAnimation, DEFAULT_ANIMATION_STAGES } from '../../src/option/normalize';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const OPTION: ChartOption = {
  legend: { show: false },
  animation: { enter: { duration: 300, easing: 'linear', stagger: 0 }, update: { duration: 300, easing: 'linear' } },
  xAxis: { type: 'category' },
  yAxis: {},
  series: [{ id: 'a', type: 'bar', name: 'A', data: [10, 30, 20, 45] }],
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('动画配置归一化', () => {
  it('animation: false 关掉所有阶段', () => {
    const result = normalizeAnimation(false);
    expect(result.enabled).toBe(false);
    expect(result.enter).toBe(false);
    expect(result.update).toBe(false);
    expect(result.highlight).toBe(false);
  });

  it('扁平写法等价于 enter 的配置（向后兼容）', () => {
    const result = normalizeAnimation({ duration: 900, easing: 'springSnappy', stagger: 0.5 });
    expect(result.enter.duration).toBe(900);
    expect(result.enter.easing).toBe('springSnappy');
    expect(result.enter.stagger).toBe(0.5);
    // 其它阶段仍是默认值
    expect(result.update.duration).toBe(DEFAULT_ANIMATION_STAGES.update.duration);
  });

  it('三段可以分别配置，也可以用 false 单独关掉', () => {
    const result = normalizeAnimation({ enter: {}, update: { duration: 120 }, highlight: false });
    expect(result.enter.duration).toBe(DEFAULT_ANIMATION_STAGES.enter.duration);
    expect(result.update.duration).toBe(120);
    expect(result.highlight).toBe(false);
  });
});

describe('动效偏好（无障碍）', () => {
  afterEach(() => setMotionPreference('instant'));

  it('instant 模式下不播动画，直接落到终态', async () => {
    setMotionPreference('instant');
    expect(shouldAnimate()).toBe(false);
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 320;
    document.body.appendChild(canvas);
    const chart = createChart(canvas, OPTION);
    await chart.render();
    const component: any = chart.seriesComponents[0];
    expect(component.getAnimationState().progress).toBe(1);
    chart.destroy();
    canvas.remove();
  });

  it('full 模式下会播动画，并可用 finishAnimations() 一次性推到终态', async () => {
    setMotionPreference('full');
    expect(getMotionPreference()).toBe('full');
    expect(shouldAnimate()).toBe(true);
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 320;
    document.body.appendChild(canvas);
    const chart = createChart(canvas, OPTION);
    const component: any = chart.seriesComponents[0];
    // 首次渲染就会开始播入场动画（历史 bug：构造时不播）
    expect(component.getAnimationState().progress).toBeLessThan(1);
    chart.finishAnimations();
    expect(component.getAnimationState().progress).toBe(1);
    chart.destroy();
    canvas.remove();
  });
});

describe('动画在真实帧循环里的表现', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    setMotionPreference('full');
    canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    setMotionPreference('instant');
  });

  it('入场动画：progress 单调推进到 1', async () => {
    chart = createChart(canvas, OPTION);
    const component: any = chart.seriesComponents[0];
    const samples: number[] = [component.getAnimationState().progress];
    for (let i = 0; i < 4; i++) {
      await wait(90);
      samples.push(component.getAnimationState().progress);
    }
    await wait(320);
    samples.push(component.getAnimationState().progress);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
    expect(samples[samples.length - 1]).toBe(1);
    expect(samples[0]).toBeLessThan(1);
  });

  it('错峰：队列靠前的数据项进度领先（波浪入场）', async () => {
    chart = createChart(canvas, {
      ...OPTION,
      animation: { enter: { duration: 600, easing: 'linear', stagger: 0.8 } },
    } as ChartOption);
    const component: any = chart.seriesComponents[0];
    await wait(260);
    const state = component.getAnimationState();
    expect(state.stagger).toBeCloseTo(0.8, 3);
    expect(state.itemProgress[0]).toBeGreaterThan(state.itemProgress[3]);
    expect(state.itemProgress[3]).toBeLessThan(1);
  });

  it('更新动画：柱子从旧高度长到新高度（不是瞬跳）', async () => {
    chart = createChart(canvas, OPTION);
    chart.finishAnimations();
    await chart.render();
    const component: any = chart.seriesComponents[0];
    const before = component.barRectAt(0)!.height;

    chart.setData('a', [40, 30, 20, 10]);
    await chart.render();
    const midState = component.getAnimationState();
    expect(midState.kind).toBe('update');
    const mid = component.barRectAt(0)!.height;
    await wait(400);
    const after = component.barRectAt(0)!.height;

    expect(after).toBeGreaterThan(before);
    // 动画进行中：高度处于新旧之间（既不是旧值也不是新值）
    if (midState.progress < 1) {
      expect(mid).toBeGreaterThan(before);
      expect(mid).toBeLessThan(after);
    }
  });

  it('折线入场是「从左到右画出来」', async () => {
    chart = createChart(canvas, {
      ...OPTION,
      animation: { enter: { duration: 800, easing: 'linear', stagger: 0 } },
      series: [{ id: 'line', type: 'line', name: 'L', data: [10, 30, 20, 45, 35, 50, 25, 40] }],
    } as ChartOption);
    const component: any = chart.seriesComponents[0];
    await wait(200);
    const state = component.getAnimationState();
    expect(state.kind).toBe('enter');
    expect(state.progress).toBeGreaterThan(0);
    expect(state.progress).toBeLessThan(1);
    // 揭示点数随时间增长（入场是「画出来」而不是整体淡入）
    const revealed = component.revealedPointCount();
    expect(revealed).toBeGreaterThanOrEqual(1);
    expect(revealed).toBeLessThan(8);
    chart.finishAnimations();
    expect(component.revealedPointCount()).toBe(8);
  });
});
