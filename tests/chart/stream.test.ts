import { createChart, setMotionPreference } from '../../src/index';
import { BandScale } from '../../src/scale/BandScale';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/**
 * 实时数据流：`appendData` 的滑动窗口语义。
 *
 * 契约：
 * - 追加到末尾，超过 `maxPoints` 从**头部**裁掉（窗口滑动）；
 * - 默认不做值插值（窗口滑动会让下标整体前移，插值会把每个点拖向邻居的值）；
 * - 走常规更新路径，缩放窗口不变（`preserveView`），并派发 `data:change`。
 */

const OPTION: ChartOption = {
  legend: { show: false },
  animation: { enter: { duration: 60 }, update: { duration: 200 } },
  xAxis: { type: 'value' },
  yAxis: { min: 0, max: 100 },
  series: [{ id: 'cpu', type: 'line', name: 'CPU', data: [[0, 10], [1, 20], [2, 30]] }],
};

describe('实时数据流 appendData', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    setMotionPreference('instant');
    canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  async function mount(option: ChartOption = OPTION): Promise<ICEChart> {
    // 深拷贝：appendData 会就地改传进来的 option（与 setData 一致），
    // 直接用模块级常量会让用例之间互相污染（踩过）
    chart = createChart(canvas, JSON.parse(JSON.stringify(option)));
    await chart.render();
    chart.finishAnimations();
    await chart.render();
    return chart;
  }

  it('追加到末尾，超过 maxPoints 时从头裁掉（滑动窗口）', async () => {
    const c = await mount();
    c.appendData('cpu', [[3, 40], [4, 50]], { maxPoints: 4 });
    await c.render();
    const data = c.getOption().series![0].data as any[];
    expect(data.length).toBe(4);
    expect(data.map((d) => d[0])).toEqual([1, 2, 3, 4]); // 头部裁掉，窗口向右滑
    expect(c.norm.series[0].points.length).toBe(4);
    expect(c.norm.series[0].points[3].y).toBe(50);
  });

  /**
   * 滚动窗口的**类目轴**：视窗裁剪之后仍然走增量查表（`categoryLookup` + `categoryOffset`）。
   *
   * 契约（2026-09-24）：惰性原始点的类目表是增量维护的，归一化要把查表口**连窗口偏移一起**
   * 交下去 —— 否则 BandScale 会为「整张 10 万条的表」每帧重建一张索引 Map（实测 ~1ms/次，
   * 10 万类目的滚动窗口里是归一化最大的一笔）。这里锁住映射结果与「自建表」逐点一致。
   */
  it('视窗裁剪后仍然带着查表口：窗口内的类目映射与自建表逐点一致，窗口外的不认', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ x: `D${i}`, y: 100 + (i % 7) }));
    const c = await mount({
      legend: { show: false },
      animation: { enabled: false },
      xAxis: { type: 'category' },
      yAxis: {},
      series: [{ id: 's', type: 'bar', name: 'S', virtual: true, data: rows }],
    } as any);
    // 视窗落在中间一段（两端都在类目表里）
    c.setDomain('x', ['D50', 'D59'], 'api');
    await c.render();

    const axis = c.norm.xAxis;
    expect(axis.domain).toEqual(rows.slice(50, 60).map((row) => row.x));
    // 窗口起点在整张表里的下标
    expect(axis.categoryOffset).toBe(50);
    // 查表口不该因为视窗裁剪被丢掉
    expect(typeof axis.categoryLookup).toBe('function');

    // 参照实现：同一段域、**不给**查表口（走自建索引表那条老路）
    const reference = new BandScale(axis.domain.slice(), [0, Math.max(1, c.layout.plot.width)]);
    for (const key of ['D50', 'D52', 'D59']) {
      expect(axis.scale!.map(key)).toBeCloseTo(reference.map(key), 6);
    }
    // 窗口外的类目不许被锚到窗口内（那条纪律见 BandScale.indexOf）
    expect(Number.isNaN(axis.scale!.bandStart('D49'))).toBe(true);
    expect(Number.isNaN(axis.scale!.bandStart('D60'))).toBe(true);
    // 自建表那条路对窗口外的类目同样「不认」—— 两条路的结论必须一致
    expect(Number.isNaN(reference.bandStart('D49'))).toBe(true);
  });

  it('窗口滑动后 x 轴窗口跟着右移（不需要手动 setDomain）', async () => {
    const c = await mount();
    const before = (c.norm.xAxis.domain as number[]).slice();
    for (let t = 3; t < 40; t++) {
      c.appendData('cpu', [[t, 50 + Math.sin(t / 3) * 20]], { maxPoints: 10 });
    }
    await c.render();
    const after = c.norm.xAxis.domain as number[];
    expect(after[0]).toBeGreaterThan(before[0]);
    expect(c.norm.series[0].points.length).toBe(10);
  });

  it('默认不做值插值：新点立刻落在终值上（滑动窗口不会「拖」）', async () => {
    const c = await mount();
    c.appendData('cpu', [[3, 90]], { maxPoints: 10 });
    const component: any = c.seriesComponents[0];
    expect(Number(component.state.progress)).toBe(1);
    // 末点像素 = y 轴映射后的 90
    const pixel = component.pixelAt(3)!;
    const expected = (c.norm.yAxis.scale as any).map(90);
    expect(pixel[1]).toBeCloseTo(expected, 6);
  });

  it('显式 animate: true 时才走更新动画', async () => {
    setMotionPreference('full');
    const c = await mount();
    c.appendData('cpu', [[3, 90]], { maxPoints: 10, animate: true });
    const component: any = c.seriesComponents[0];
    expect(Number(component.state.progress)).toBeLessThan(1);
    c.finishAnimations();
    expect(Number(component.state.progress)).toBe(1);
  });

  it('派发 data:change，且不改动缩放窗口（preserveView）', async () => {
    const c = await mount();
    c.setDomain('x', [0, 2]);
    await c.render();
    const seen: any[] = [];
    c.on('data:change', (payload: any) => seen.push(payload));
    c.appendData('cpu', [[3, 40]], { maxPoints: 10 });
    expect(seen).toHaveLength(1);
    expect(seen[0].seriesId).toBe('cpu');
    // 缩放窗口保留：不会被新数据的完整数据域顶掉
    expect(c.getDomain('x')).toEqual([0, 2]);
  });

  it('系列标识传错直接报错，不会「碰巧」落到第一个系列上', async () => {
    const c = await mount();
    expect(() => c.appendData('nope' as any, [[1, 1]])).toThrow(/找不到系列/);
    expect(() => c.appendData(undefined as any, [[1, 1]])).toThrow(/需要系列 id/);
    // 空数组是合法的空操作（调用方不必判空）
    c.appendData('cpu', []);
    expect((c.getOption().series![0].data as any[]).length).toBe(3);
  });

  it('连续推送 200 次不炸、窗口稳定、末点可命中（数据流冒烟）', async () => {
    const c = await mount();
    const window = 60;
    for (let t = 3; t < 203; t++) {
      c.appendData('cpu', [[t, 50 + Math.sin(t / 5) * 30]], { maxPoints: window });
    }
    await c.render();
    const component: any = c.seriesComponents[0];
    expect(component.series.points.length).toBe(window);
    expect(c.norm.series[0].points[window - 1].y).toBeCloseTo(50 + Math.sin(202 / 5) * 30, 6);
    // 末点可以正常命中（数据流的「最新点」是交互热点）
    const pixel = component.pixelAt(window - 1)!;
    const sx = c.layout.plot.x + pixel[0];
    const sy = c.layout.plot.y + pixel[1];
    expect(c.ice.hitTest(sx, sy)).toBe(component);
    expect(c.controller.resolveTarget(sx, sy).index).toBe(window - 1);
  });

  it('多系列各自追加互不干扰', async () => {
    const c = await mount({
      ...OPTION,
      series: [
        { id: 'a', type: 'line', name: 'A', data: [[0, 10]] },
        { id: 'b', type: 'line', name: 'B', data: [[0, 20]] },
      ],
    });
    c.appendData('a', [[1, 11]], { maxPoints: 10 });
    c.appendData('b', [[1, 21]], { maxPoints: 10 });
    await c.render();
    expect((c.getOption().series![0].data as any[]).length).toBe(2);
    expect((c.getOption().series![1].data as any[]).length).toBe(2);
    expect(c.norm.series[1].points[1].y).toBe(21);
  });

  it('数据更新不打断正在跑的悬停反馈动画（实时流 + 悬停的真实组合）', async () => {
    setMotionPreference('full');
    const c = await mount({
      ...OPTION,
      series: [{ id: 'cpu', type: 'bar', name: 'CPU', data: [[0, 30], [1, 50], [2, 40]] }],
    });
    const component: any = c.seriesComponents[0];
    const pixel = component.pixelAt(1)!;
    c.controller.handlePointerMove(c.layout.plot.x + pixel[0], c.layout.plot.y + pixel[1]);
    await c.render();
    expect(component.hoverIndex).toBe(1);
    // 反馈动画跑到一半时来了新数据
    await new Promise((resolve) => setTimeout(resolve, 60));
    c.appendData('cpu', [[3, 60]], { maxPoints: 10 });
    await c.render();
    const mid = component.highlightT();
    expect(mid).toBeGreaterThan(0);
    // 关键：update 阶段（progress 补间）不能把 highlightT 冲掉，它必须继续跑到 1
    await new Promise((resolve) => setTimeout(resolve, 400));
    await c.render();
    expect(component.highlightT()).toBeGreaterThan(0.9);
  });
});
