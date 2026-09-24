import { createChart, setMotionPreference } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/**
 * x 轴标签的抽稀（密度高的时候不许糊成一条色带）。
 *
 * 这一条盯的是**真的画出去的那些标签**（`axisX.lastTicks` 上的 `drawn` 标记 + 位置），
 * 不是布局算出来的那张表 —— 2026-09-21 之前这里有两个独立的抽稀实现：
 * `buildAxisLayout` 一张表、`Axis` 组件自己又算一遍步长（还给间距兜了个 1px 的下限
 * `Math.max(1, slot)`）。密度一高两边就打架，实测缩到 3565 根时布局只留 11 个标签、
 * 组件留下 42 个，79.5px 宽的标签按 20.7px 的间隔画出去，末端糊成一条色带。
 * 现在抽稀只有布局那一处，组件照着画。
 */

const WIDE = 900;

function categoryOption(count: number, longLabels = true): ChartOption {
  return {
    xAxis: longLabels
      ? { type: 'category', formatter: (value: any) => `${String(value).padStart(4, '0')}-long-label` }
      : { type: 'category' },
    animation: { enabled: false },
    series: [{ id: 'a', type: 'line', data: Array.from({ length: count }, (_, i) => (i % 11) - 5) }],
  } as ChartOption;
}

describe('x 轴标签抽稀', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  const mount = async (option: ChartOption): Promise<ICEChart> => {
    canvas = document.createElement('canvas');
    canvas.width = WIDE;
    canvas.height = 400;
    document.body.appendChild(canvas);
    chart = createChart(canvas, option);
    await chart.render();
    return chart;
  };

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    setMotionPreference('instant');
  });

  /** 画出去的标签（位置 + 文本）。 */
  const drawnLabels = (c: ICEChart): Array<{ pos: number; label: string }> => {
    const axis: any = (c as any).axisX;
    return (axis.lastTicks || [])
      .filter((tick: any) => tick.drawn)
      .map((tick: any) => ({ pos: tick.pos, label: tick.label }));
  };

  it('4000 个类目：标签数量按可用宽度收敛，相邻间隔不小于 64px', async () => {
    const c = await mount(categoryOption(4000));
    const drawn = drawnLabels(c);
    const plot = c.layout.plot;

    expect(drawn.length).toBeGreaterThan(2);
    expect(drawn.length).toBeLessThan(plot.width / 64 + 2);
    for (let i = 1; i < drawn.length; i++) {
      expect(drawn[i].pos - drawn[i - 1].pos).toBeGreaterThanOrEqual(64 - 1e-6);
    }
    // 首末标签不许被画布边缘切掉：放不下就该整颗丢掉（往里推会压住邻居）
    const half = 90 / 2; // 「0000-long-label」在 12px 字号下约 90px 宽
    expect(drawn[0].pos - half).toBeGreaterThanOrEqual(-plot.x - 1e-6);
    expect(drawn[drawn.length - 1].pos + half).toBeLessThanOrEqual(plot.x + plot.width + (900 - plot.x - plot.width) + 1e-6);
  });

  it('类目不多且间距够：一个不抽，全画', async () => {
    const c = await mount(categoryOption(6, false));
    const drawn = drawnLabels(c);
    // 6 个类目铺满绘图区（140px 一个），远超 64px 的舒适间隔 → 一个都不该抽
    expect(drawn.length).toBe(6);
    for (let i = 1; i < drawn.length; i++) {
      expect(drawn[i].pos - drawn[i - 1].pos).toBeGreaterThanOrEqual(64 - 1e-6);
    }
  });

  it('舒适间隔（64px）优先于「标签不重叠」：20 个短标签也要让出间距', async () => {
    // 这条锁的是 2026-09-14 的决定：数字标签即使不重叠，挤成一片编号也难看
    const c = await mount(categoryOption(20, false));
    const drawn = drawnLabels(c);
    expect(drawn.length).toBeLessThan(20);
    for (let i = 1; i < drawn.length; i++) {
      expect(drawn[i].pos - drawn[i - 1].pos).toBeGreaterThanOrEqual(64 - 1e-6);
    }
  });

  it('类目不多但标签很长：该抽就抽（宽度说话，不是数量说话）', async () => {
    const c = await mount(categoryOption(20));
    const drawn = drawnLabels(c);
    // 「0000-long-label」约 90px 宽，42px 的槽放不下 → 只留能放下的那些
    expect(drawn.length).toBeLessThan(20);
    for (let i = 1; i < drawn.length; i++) {
      expect(drawn[i].pos - drawn[i - 1].pos).toBeGreaterThanOrEqual(64 - 1e-6);
    }
  });

  it('缩放后标签跟着重排，且始终满足最小间隔', async () => {
    const c = await mount(categoryOption(4000));
    const all = c.fullDomain('x');
    const plot = c.layout.plot;
    for (const count of [800, 200, 40]) {
      const visible = all.filter((_, i) => i % Math.max(1, Math.floor(4000 / count)) === 0).slice(0, count);
      c.setDomain('x', [visible[0], visible[visible.length - 1]]);
      await c.render();
      const drawn = drawnLabels(c);
      expect(drawn.length).toBeGreaterThan(1);
      for (let i = 1; i < drawn.length; i++) {
        expect(drawn[i].pos - drawn[i - 1].pos).toBeGreaterThanOrEqual(64 - 1e-6);
      }
      expect(drawn[drawn.length - 1].pos).toBeLessThanOrEqual(c.layout.plot.x + c.layout.plot.width + 1e-6);
      expect(plot.width).toBe(c.layout.plot.width);
    }
  });

  /**
   * 面板矩阵要靠这个：同一套刻度表，画到不同的面板矩形上。
   * 不设 `plot` 时必须完全走旧路径（读 `layout.plot`），否则现有单面板图全会错位。
   */
  it('给 Axis 指定 per-instance plot 后，刻度落点跟着平移', async () => {
    const c = await mount(categoryOption(20));
    const axis: any = (c as any).axisX;
    const before = (axis.lastTicks || []).filter((t: any) => t.drawn).map((t: any) => t.pos);
    expect(before.length).toBeGreaterThan(1);

    const plot = c.layout.plot;
    axis.plot = { x: plot.x + 100, y: plot.y - 50, width: plot.width - 40, height: plot.height };
    // Chart 在面板化之后就是这么调的：先给 plot，再同步刻度表
    axis.syncTicks();
    await c.render();

    const after = (axis.lastTicks || []).filter((t: any) => t.drawn).map((t: any) => t.pos);
    expect(after[0] - before[0]).toBeCloseTo(100, 3);

    // 清掉覆盖后回到旧路径（面板化不许改变默认行为）
    axis.plot = null;
    axis.syncTicks();
    await c.render();
    const restored = (axis.lastTicks || []).filter((t: any) => t.drawn).map((t: any) => t.pos);
    expect(restored[0]).toBeCloseTo(before[0], 3);
  });
});
