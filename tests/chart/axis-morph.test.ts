import { createChart, setMotionPreference } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/**
 * 坐标轴刻度过渡。
 *
 * 缩放 / 平移 / 数据更新会换掉一批刻度。硬切会让标签「跳」，这里断言的是**渲染位置**：
 * 保留的刻度从旧位置滑到新位置，中途必须既不在旧位置也不在新位置。
 */

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CATEGORIES = Array.from({ length: 12 }, (_, i) => `C${i + 1}`);

const OPTION: ChartOption = {
  legend: { show: false },
  animation: { enter: { duration: 60 }, update: { duration: 300, easing: 'linear' } },
  xAxis: { type: 'category', data: CATEGORIES },
  yAxis: {},
  series: [{ id: 's', type: 'line', name: 'S', data: CATEGORIES.map((_, i) => i * 5 + 10) }],
};

describe('坐标轴刻度过渡', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 400;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    setMotionPreference('instant');
  });

  async function mount(): Promise<ICEChart> {
    chart = createChart(canvas, OPTION);
    await chart.render();
    chart.finishAnimations();
    await chart.render();
    return chart;
  }

  it('instant 模式：刻度直接落到新位置（不做过渡）', async () => {
    setMotionPreference('instant');
    const c = await mount();
    const axis: any = (c as any).axisX;
    const ticksBefore = c.layout.xAxisLayout.ticks.slice();
    c.setDomain('x', [3, 9]);
    await c.render();
    expect(axis.morphing()).toBe(false);
    const ticksAfter = c.layout.xAxisLayout.ticks;
    const shared = ticksAfter.find((tick: any) => ticksBefore.indexOf(tick) >= 0);
    if (shared !== undefined) {
      const expected = c.layout.plot.x + (c.norm.xAxis.scale as any).map(shared);
      expect(axis.renderedTickPos(shared)).toBeCloseTo(expected, 6);
    }
  });

  it('full 模式：缩放后保留的刻度滑过去，中途位置介于新旧之间', async () => {
    setMotionPreference('full');
    const c = await mount();
    const axis: any = (c as any).axisX;
    const ticksBefore = c.layout.xAxisLayout.ticks.slice();
    const beforePositions = new Map<string, number>();
    for (const tick of ticksBefore) {
      const pos = axis.renderedTickPos(tick);
      if (pos !== null) beforePositions.set(String(tick), pos);
    }

    c.setDomain('x', ['C4', 'C10']);
    await c.render();
    expect(axis.morphing()).toBe(true);

    const shared = c.layout.xAxisLayout.ticks.find((tick: any) => beforePositions.has(String(tick)));
    expect(shared).not.toBeUndefined();
    const before = beforePositions.get(String(shared))!;
    const target = c.layout.plot.x + (c.norm.xAxis.scale as any).map(shared);
    expect(target).not.toBeCloseTo(before, 1); // 这个刻度确实要移动
    // 等一小会儿再取样：t=0 时标签还停在旧位置上（那正是「不硬切」的证明）
    await wait(110);
    await c.render();
    const mid = axis.renderedTickPos(shared)!;
    // 滑动中：既不是旧位置，也不是新位置
    expect(mid).not.toBeCloseTo(before, 3);
    expect(mid).not.toBeCloseTo(target, 3);
    expect(mid).toBeGreaterThan(Math.min(before, target) - 0.001);
    expect(mid).toBeLessThan(Math.max(before, target) + 0.001);

    await wait(420);
    await c.render();
    expect(axis.morphing()).toBe(false);
    expect(axis.renderedTickPos(shared)).toBeCloseTo(target, 3);
  });

  it('数据更新换掉刻度时也会过渡，且 finishAnimations() 能一次到位', async () => {
    setMotionPreference('full');
    const c = await mount();
    const axis: any = (c as any).axisX;
    c.setDomain('x', ['C3', 'C8']);
    await c.render();
    expect(axis.morphing()).toBe(true);
    c.finishAnimations();
    await c.render();
    expect(axis.morphing()).toBe(false);
    const yAxis: any = (c as any).axisYList[0];
    expect(yAxis.morphing()).toBe(false);
  });

  it('刻度没变时不启动动画（避免无谓的每帧重绘）', async () => {
    setMotionPreference('full');
    const c = await mount();
    const axis: any = (c as any).axisX;
    expect(axis.morphing()).toBe(false);
    // 同样的配置再同步一次：刻度集合完全一致
    c.setOption(c.getOption(), { animate: false, preserveView: true });
    await c.render();
    expect(axis.morphing()).toBe(false);
  });
});
