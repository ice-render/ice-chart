/**
 * 类目（合并）域的一次性缓存：**键要不健全，轴就会给出上一帧的类目**。
 *
 * 现在普通系列的缓存键是「点数 + 首末 x」。滚动窗口每 tick 都在动首末，所以看着没问题 ——
 * 但只要「长度、首、末都没变、中间变了」（改数据、按窗口重取一段、批量替换），
 * 就会命中一个**过期的域**：类目轴上凭空少/多一个类目，而且再也自愈不了。
 */
import { normalizeOption } from '../../src/option/normalize';
import type { CategoryDomainCache } from '../../src/option/normalize';
import type { ChartOption } from '../../src/types';

function option(rows: Array<{ x: string; y: number }>): ChartOption {
  return {
    animation: { enabled: false },
    legend: { show: false },
    xAxis: { type: 'category' },
    yAxis: {},
    series: [{ id: 's', type: 'line', data: rows }],
  };
}

const newCache = (): CategoryDomainCache => ({ key: '', result: null as any });

describe('类目域缓存：键必须能识别「中间变了」', () => {
  test('首末没变、中间换了一个类目：域要跟着变', () => {
    const cache = newCache();
    normalizeOption(option([{ x: 'A', y: 1 }, { x: 'B', y: 2 }, { x: 'C', y: 3 }]), { categoryCache: cache });
    const next = normalizeOption(
      option([{ x: 'A', y: 1 }, { x: 'X', y: 2 }, { x: 'C', y: 3 }]),
      { categoryCache: cache }
    );
    expect(next.xAxis.domain).toEqual(['A', 'X', 'C']);
  });

  test('多系列合并：首末没变、中间换了一个类目，合并域也要跟着变', () => {
    const cache = newCache();
    const multi = (second: string): ChartOption => ({
      animation: { enabled: false },
      legend: { show: false },
      xAxis: { type: 'category' },
      yAxis: {},
      series: [
        { id: 'a', type: 'line', data: [{ x: 'A', y: 1 }, { x: second, y: 2 }, { x: 'C', y: 3 }] },
        { id: 'b', type: 'line', data: [{ x: 'A', y: 1 }, { x: second, y: 2 }, { x: 'C', y: 3 }] },
      ],
    });
    normalizeOption(multi('B'), { categoryCache: cache });
    const next = normalizeOption(multi('X'), { categoryCache: cache });
    expect(next.xAxis.domain).toEqual(['A', 'X', 'C']);
  });

  test('轴自己声明类目时：换掉 axis.data（同长度、首末相同）域要跟着变', () => {
    const cache = newCache();
    const withAxis = (middle: string): ChartOption => ({
      animation: { enabled: false },
      legend: { show: false },
      xAxis: { type: 'category', data: ['A', middle, 'C'] },
      yAxis: {},
      series: [{ id: 's', type: 'line', data: [1, 2, 3] }],
    });
    normalizeOption(withAxis('B'), { categoryCache: cache });
    const next = normalizeOption(withAxis('X'), { categoryCache: cache });
    expect(next.xAxis.domain).toEqual(['A', 'X', 'C']);
  });
});

describe('类目域缓存：滑动窗口下的判定与参照实现逐项一致', () => {
  /** 参照：不吃缓存的归一化（= 每次都从头聚合）。 */
  const reference = (rows: Array<{ x: string; y: number }>): ChartOption => option(rows.map((row) => ({ ...row })));

  const expectSameAsReference = (withCache: ReturnType<typeof normalizeOption>, rows: Array<{ x: string; y: number }>) => {
    const cold = normalizeOption(reference(rows));
    expect(withCache.xAxis.domain).toEqual(cold.xAxis.domain);
    expect(withCache.categories).toEqual(cold.categories);
    // 查表口必须与域本身一致（BandScale 依赖它把类目映射到下标）
    const lookup = (withCache.xAxis as any).categoryLookup as ((key: string) => number) | undefined;
    if (lookup) {
      for (let i = 0; i < cold.xAxis.domain.length; i++) {
        expect(lookup(String(cold.xAxis.domain[i]))).toBe(i);
      }
      expect(lookup('__不存在__')).toBe(-1);
    }
  };

  test('单来源滑动窗口：连续 6 个 tick 每次都正确（含新类目进、旧类目出）', () => {
    const cache = newCache();
    let rows = ['A', 'B', 'C', 'D'].map((x, i) => ({ x, y: i }));
    normalizeOption(option(rows), { categoryCache: cache });
    expectSameAsReference(normalizeOption(option(rows), { categoryCache: cache }), rows);
    for (let tick = 0; tick < 6; tick++) {
      rows = rows.concat([{ x: `N${tick}`, y: tick }]).slice(-4);
      const norm = normalizeOption(option(rows), { categoryCache: cache });
      expect(norm.xAxis.domain).toEqual(rows.map((row) => row.x));
      expectSameAsReference(norm, rows);
    }
  });

  test('窗口内类目重复时（增量前提不成立）也必须与参照一致', () => {
    const cache = newCache();
    let rows = ['A', 'B', 'A'].map((x, i) => ({ x, y: i }));
    normalizeOption(option(rows), { categoryCache: cache });
    for (let tick = 0; tick < 4; tick++) {
      rows = rows.concat([{ x: tick % 2 === 0 ? 'B' : 'C', y: tick }]).slice(-3);
      const norm = normalizeOption(option(rows), { categoryCache: cache });
      expect(norm.xAxis.domain).toEqual(normalizeOption(reference(rows)).xAxis.domain);
    }
  });

  test('滑动窗口里换掉中间一项（不是两端变化）也必须与参照一致', () => {
    const cache = newCache();
    normalizeOption(option(['A', 'B', 'C', 'D'].map((x, i) => ({ x, y: i }))), { categoryCache: cache });
    const swapped = ['A', 'B', 'X', 'D'].map((x, i) => ({ x, y: i }));
    const norm = normalizeOption(option(swapped), { categoryCache: cache });
    expect(norm.xAxis.domain).toEqual(['A', 'B', 'X', 'D']);
  });

  /**
   * 序号一旦出现空洞，查表口算出的下标就会漂：`BandScale` 会因为「下标越界」把点判成
   * 不在域里（柱子 / 点直接不画）。所以「窗口先变短、再追加」这条路径必须把序号压回去。
   */
  test('窗口先变短、再追加：查表口的下标仍然与域逐项对齐', () => {
    const cache = newCache();
    normalizeOption(option(['A', 'B', 'C', 'D'].map((x, i) => ({ x, y: i }))), { categoryCache: cache });

    const shrunk = normalizeOption(option(['B', 'C'].map((x, i) => ({ x, y: i }))), { categoryCache: cache });
    expect(shrunk.xAxis.domain).toEqual(['B', 'C']);

    const grown = normalizeOption(option(['B', 'C', 'X'].map((x, i) => ({ x, y: i }))), { categoryCache: cache });
    expect(grown.xAxis.domain).toEqual(['B', 'C', 'X']);
    const lookup = (grown.xAxis as any).categoryLookup as (key: string) => number;
    expect([lookup('B'), lookup('C'), lookup('X'), lookup('A')]).toEqual([0, 1, 2, -1]);
  });
});

describe('多来源：x 逐项相同时合并域可以复用第一张表', () => {
  /** 多系列共用同一批 x（K 线 + 量柱 + 均线那种形状）。 */
  const multi = (xs: string[], secondSame = true): ChartOption => ({
    animation: { enabled: false },
    legend: { show: false },
    xAxis: { type: 'category' },
    yAxis: {},
    series: [
      { id: 'a', type: 'line', data: xs.map((x, i) => ({ x, y: i })) },
      { id: 'b', type: 'line', data: (secondSame ? xs : xs.map((x) => `${x}#b`)).map((x, i) => ({ x, y: 100 + i })) },
    ],
  });

  test('两系列 x 逐项相同：合并域复用第一张增量表', () => {
    const cache = newCache();
    normalizeOption(multi(['A', 'B', 'C']), { categoryCache: cache });
    expect(cache.incremental).toBeTruthy();
    expect(cache.incremental!.seriesId).toBe('a');
  });

  test('两系列 x 逐项相同的滑动窗口：每个 tick 都与参照实现一致', () => {
    const cache = newCache();
    let xs = ['A', 'B', 'C', 'D'];
    normalizeOption(multi(xs), { categoryCache: cache });
    for (let tick = 0; tick < 5; tick++) {
      xs = xs.concat([`N${tick}`]).slice(-4);
      const withCache = normalizeOption(multi(xs), { categoryCache: cache });
      const cold = normalizeOption(multi(xs));
      expect(withCache.xAxis.domain).toEqual(cold.xAxis.domain);
      const lookup = (withCache.xAxis as any).categoryLookup as ((key: string) => number) | undefined;
      if (lookup) {
        for (let i = 0; i < cold.xAxis.domain.length; i++) expect(lookup(String(cold.xAxis.domain[i]))).toBe(i);
      }
    }
    /**
     * 走的确实是**增量**（不是「碰巧结果对」）：绝对序号每 tick 只涨 1（每条只追加一个新类目），
     * 域长度保持窗口大小；退回全量合并的话序号会被重置成下标长度。
     */
    expect(cache.incremental!.next).toBe(4 + 5);
    expect(cache.incremental!.values.length).toBe(4);
  });

  test('两系列 x 不同：退回全量合并，域仍与参照一致', () => {
    const cache = newCache();
    let xs = ['A', 'B', 'C'];
    normalizeOption(multi(xs, false), { categoryCache: cache });
    for (let tick = 0; tick < 3; tick++) {
      xs = xs.concat([`N${tick}`]).slice(-3);
      const withCache = normalizeOption(multi(xs, false), { categoryCache: cache });
      const cold = normalizeOption(multi(xs, false));
      expect(withCache.xAxis.domain).toEqual(cold.xAxis.domain);
      expect(withCache.xAxis.domain.length).toBe(xs.length * 2);
    }
  });
});
