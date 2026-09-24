/**
 * **同帧批合并**（`chart.batch(fn)`）：一帧里对多个系列的更新，只跑一次流水线。
 *
 * 起因（实测）：3 个 10 万点的普通系列，逐系列 `setData` 是 **51.8ms/tick** ——
 * 每次调用都跑一整条归一化 + 布局 + 同步，而且**中间态里各系列天然不对齐**
 * （第一条已经滑过去，第二三条还没），类目那套「逐项同一」的增量因此也用不上。
 * 包进 `batch()` 之后：① 只跑一次流水线；② 流水线看到的是**全部更新完**的一致状态。
 *
 * 语义承诺（与「不许为了性能牺牲语义」对齐）：
 * - `batch()` 返回时图表**已经**是新状态（同步，不是「下一帧才生效」）；
 * - 批内不发布 `data:change`，出批后按调用顺序补发 —— 监听者读到的图永远是自洽的；
 * - 批内抛异常也会 flush（`finally`），状态不会停在半路。
 */
import * as normalizeModule from '../../src/option/normalize';
import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

function option(): ChartOption {
  const rows = (offset: number) =>
    Array.from({ length: 20 }, (_v, i) => ({ x: `D${i}`, y: offset + i }));
  return {
    animation: { enabled: false },
    legend: { show: false },
    xAxis: { type: 'category' },
    yAxis: {},
    series: [
      { id: 'a', type: 'line', data: rows(0) },
      { id: 'b', type: 'line', data: rows(100) },
      { id: 'c', type: 'line', data: rows(200) },
    ],
  };
}

const shifted = (offset: number, extra: number) =>
  Array.from({ length: 20 }, (_v, i) => ({ x: `D${i + extra}`, y: offset + i }));

/** 连续类目 Dfrom..Dto（写期望值时用，别手抄）。 */
const D = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_v, i) => `D${from + i}`);

describe('同帧批合并', () => {
  let canvas: any;
  let chart: ICEChart | null = null;
  let spy: jest.SpyInstance;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    document.body.appendChild(canvas);
    spy = jest.spyOn(normalizeModule, 'normalizeOption');
  });

  afterEach(() => {
    spy.mockRestore();
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  test('批内 N 次 setData：只跑一遍归一化', () => {
    chart = createChart(canvas, option());
    spy.mockClear();
    chart.batch(() => {
      chart!.setData('a', shifted(1, 1));
      chart!.setData('b', shifted(101, 1));
      chart!.setData('c', shifted(201, 1));
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('batch 返回时图表已经是新状态（同步语义不变）', () => {
    chart = createChart(canvas, option());
    chart.batch(() => {
      chart!.setData('a', shifted(1, 1));
      chart!.setData('b', shifted(101, 1));
      chart!.setData('c', shifted(201, 1));
    });
    expect(chart.norm.series.map((s) => s.pointCount)).toEqual([20, 20, 20]);
    expect(chart.norm.xAxis.domain).toEqual(D(1, 20));
    // 三个系列都换成同一批 x（对齐）→ 类目域走增量：只追加一个新类目
    expect((chart as any).__categoryCache.incremental.values.length).toBe(20);
  });

  test('批内不发布事件，出批后按调用顺序补发（且此时读到的图是自洽的）', () => {
    chart = createChart(canvas, option());
    const seen: Array<{ id: any; domain: number }> = [];
    chart.on('data:change', (payload: any) => {
      seen.push({ id: payload.seriesId, domain: (chart as ICEChart).norm.xAxis.domain.length });
    });
    chart.batch(() => {
      chart!.setData('a', shifted(1, 1));
      chart!.setData('b', shifted(101, 1));
    });
    expect(seen).toEqual([
      { id: 'a', domain: 21 },
      { id: 'b', domain: 21 },
    ]);
  });

  test('批内抛异常：照样 flush，异常继续往外抛', () => {
    chart = createChart(canvas, option());
    expect(() =>
      chart!.batch(() => {
        chart!.setData('a', shifted(1, 1));
        throw new Error('boom');
      })
    ).toThrow('boom');
    // 域的顺序是「系列序 + 首次出现」：a 已经滑到 D1..D20，b/c 还停在 D0..D19 → D0 排到最后
    expect(chart.norm.xAxis.domain).toEqual([...D(1, 20), 'D0']);
  });

  test('嵌套批：只在最外层出批时跑一遍', () => {
    chart = createChart(canvas, option());
    spy.mockClear();
    chart.batch(() => {
      chart!.setData('a', shifted(1, 1));
      chart!.batch(() => {
        chart!.setData('b', shifted(101, 1));
      });
      chart!.appendData('c', [{ x: 'D20', y: 7 }]);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(chart.norm.xAxis.domain).toEqual([...D(1, 20), 'D0']);
  });

  test('不在批里的调用完全不变：一次更新一遍归一化', () => {
    chart = createChart(canvas, option());
    spy.mockClear();
    chart.setData('a', shifted(1, 1));
    chart.appendData('b', [{ x: 'D20', y: 7 }]);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
