import { normalizeOption } from '../../src/option/normalize';
import { appendRawItems, rawCategoryIndex } from '../../src/internal';
import type { SeriesRawPoints } from '../../src/internal';
import { createChart } from '../../src/index';

/**
 * **惰性原始点的类目索引表**（2026-09-23，增量流水线那条线）。
 *
 * 背景：类目轴每帧都要「类目 → 下标」这张表，而滚动窗口每 tick 从头部淘汰一项 ——
 * 如果下标是直接存在表里的值，每帧都得整体重写（实测占整条流水线的一半）。
 * 现在表里存的是**绝对序号**，「下标」由 `rawCategoryIndex()` 用首项序号相减得到。
 *
 * 这里锁住的不变式只有一条，但它是这个设计成立的全部依据：
 * **`rawCategoryIndex(key)` 必须与「在 `categories` 数组里找第一次出现」逐项一致**
 * —— 无论中间经历了追加、从头部淘汰、还是淘汰掉一个中间的类目。
 */

const storeOf = (rows: any[]): SeriesRawPoints => {
  const norm = normalizeOption({
    legend: { show: false },
    xAxis: { type: 'category' },
    yAxis: {},
    series: [{ id: 's', type: 'bar', yField: 'y', virtual: true, data: rows }],
  } as any);
  return (norm.series[0] as any).raw as SeriesRawPoints;
};

/** 参照实现：直接用数组找第一次出现（就是被替换掉的那条老路）。 */
const reference = (store: SeriesRawPoints, key: string): number =>
  store.categories.findIndex((value) => String(value) === key);

/** 把整张表对着参照实现核一遍（含表里没有的 key）。 */
const expectTableMatches = (store: SeriesRawPoints, extraKeys: string[] = []): void => {
  for (const value of store.categories) {
    const key = String(value);
    expect({ key, index: rawCategoryIndex(store, key) }).toEqual({ key, index: reference(store, key) });
  }
  for (const key of extraKeys) {
    expect(rawCategoryIndex(store, key)).toBe(reference(store, key));
  }
};

describe('惰性原始点：类目索引表', () => {
  it('无重复类目时下标就是出现顺序', () => {
    const store = storeOf([
      { x: 'A', y: 1 },
      { x: 'B', y: 2 },
      { x: 'C', y: 3 },
    ]);
    expect(rawCategoryIndex(store, 'A')).toBe(0);
    expect(rawCategoryIndex(store, 'B')).toBe(1);
    expect(rawCategoryIndex(store, 'C')).toBe(2);
    expect(rawCategoryIndex(store, 'D')).toBe(-1);
  });

  it('重复类目按下标取「第一次出现」的那个（与 domain.indexOf 同语义）', () => {
    const store = storeOf([
      { x: 'A', y: 1 },
      { x: 'B', y: 2 },
      { x: 'A', y: 3 },
    ]);
    expect(store.categories).toEqual(['A', 'B']);
    expect(rawCategoryIndex(store, 'A')).toBe(0);
    expect(rawCategoryIndex(store, 'B')).toBe(1);
  });

  it('数值与字符串混用按宽松匹配（查表键是 String 化的）', () => {
    const store = storeOf([
      { x: 1, y: 1 },
      { x: '2', y: 2 },
    ]);
    expect(rawCategoryIndex(store, '1')).toBe(0);
    // 与 BandScale 的查表契约一致：调用方负责把类目 String 化（`1` 与 `'1'` 是同一类目）
    expect(rawCategoryIndex(store, String(2))).toBe(1);
    expect(rawCategoryIndex(store, String(1))).toBe(0);
  });

  it('环形滑动（从头部淘汰）之后整张表仍与参照实现一致', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ x: `D${i}`, y: i }));
    let store = storeOf(rows);
    store = appendRawItems(store, [{ x: 'N0', y: 99 }], 10);
    expect(store.categories.length).toBe(10);
    expectTableMatches(store, ['D0', 'D1', 'N0', 'D11', 'N9']);
    store = appendRawItems(store, [{ x: 'N1', y: 98 }], 10);
    store = appendRawItems(store, [{ x: 'N2', y: 97 }], 10);
    expect(store.categories[0]).toBe('D5');
    expectTableMatches(store, ['D0', 'D2', 'D3', 'N2']);
  });

  it('淘汰掉一个中间类目（不是首项）之后也一致', () => {
    /**
     * B 出现两次（首项、第三项）：淘汰掉「第一个 B」时它还在窗口里，只是计数 -1；
     * 等到淘汰 A 时，被摘掉的 A 在表里是**中间项**（下标 1）—— 这一下会在序号里留个洞。
     */
    let store = storeOf([
      { x: 'B', y: 1 },
      { x: 'A', y: 2 },
      { x: 'B', y: 3 },
      { x: 'C', y: 4 },
    ]);
    expect(store.categories).toEqual(['B', 'A', 'C']);
    // 容量 4：淘汰首项（第一个 B）—— B 还在表里，只是计数 -1
    store = appendRawItems(store, [{ x: 'D', y: 5 }], 4);
    expect(store.categories).toEqual(['B', 'A', 'C', 'D']);
    expectTableMatches(store, ['A', 'B', 'D']);
    // 再追加一项：这次淘汰掉 A（表里的**中间项**）—— 序号要靠压紧重新变成连续段
    store = appendRawItems(store, [{ x: 'E', y: 6 }], 4);
    expect(store.categories).toEqual(['B', 'C', 'D', 'E']);
    expect(rawCategoryIndex(store, 'A')).toBe(-1);
    expect(rawCategoryIndex(store, 'B')).toBe(0);
    expect(rawCategoryIndex(store, 'C')).toBe(1);
    expect(rawCategoryIndex(store, 'E')).toBe(3);
    expectTableMatches(store, ['A', 'B', 'C', 'D', 'E', 'F']);
    // 压紧之后继续滚动，不变式必须还成立
    store = appendRawItems(store, [{ x: 'F', y: 7 }], 4);
    store = appendRawItems(store, [{ x: 'G', y: 8 }], 4);
    expectTableMatches(store, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  });

  it('普通（非环）追加同样一致', () => {
    let store = storeOf([{ x: 'A', y: 1 }]);
    store = appendRawItems(
      store,
      [
        { x: 'B', y: 2 },
        { x: 'A', y: 3 },
      ],
      0
    );
    expect(store.categories).toEqual(['A', 'B']);
    expectTableMatches(store, ['A', 'B', 'Z']);
  });

  it('转成环形（第一次给 maxPoints）时类目表按窗口重装', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ x: `D${i}`, y: i }));
    let store = storeOf(rows);
    // 容量 3：只留最后三项 —— 前面三项必须从类目表里消失
    store = appendRawItems(store, [{ x: 'N0', y: 9 }], 3);
    expect(store.categories).toEqual(['D4', 'D5', 'N0']);
    expect(rawCategoryIndex(store, 'D0')).toBe(-1);
    expect(rawCategoryIndex(store, 'D4')).toBe(0);
    expect(rawCategoryIndex(store, 'N0')).toBe(2);
    expectTableMatches(store, ['D0', 'D3', 'D4', 'N0']);
  });

  it('接线：类目轴拿到的查表口与 band 位置逐项一致（含滚动之后）', async () => {
    const canvas: any = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 400;
    document.body.appendChild(canvas);
    const data = Array.from({ length: 40 }, (_, i) => ({ x: `D${i}`, y: i }));
    const chart = createChart(canvas, {
      legend: { show: false },
      animation: { enabled: false },
      xAxis: { type: 'category' },
      yAxis: {},
      series: [{ id: 's', type: 'bar', yField: 'y', virtual: true, data }],
    } as any);
    try {
      await chart.render();
      /**
       * 黑盒断言：`map(类目)` 必须等于「按下标算的 band 中心」。
       * `bandStart(value, index)` 传了下标就绕开了查表 —— 两者不一致说明查表口给错了下标。
       */
      const check = (): void => {
        const scale: any = chart.norm.xAxis.scale;
        const domain: any[] = chart.norm.xAxis.domain;
        for (let i = 0; i < domain.length; i++) {
          expect(scale.map(domain[i])).toBeCloseTo(scale.bandStart(domain[i], i) + scale.bandwidth() / 2, 6);
        }
        expect(Number.isNaN(scale.map('不在表里的类目'))).toBe(true);
      };
      check();
      // 滚动窗口：追加 5 根，逼出「头部淘汰 + 序号基准推进」
      for (let i = 0; i < 5; i++) chart.appendData('s', [{ x: `N${i}`, y: 100 + i }], { maxPoints: 40 });
      await chart.render();
      expect(chart.norm.xAxis.domain[0]).not.toBe('D0');
      check();
    } finally {
      chart.destroy();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }
  });
});
