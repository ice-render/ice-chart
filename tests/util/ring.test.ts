import { createRing, ringAccessors, ringAppend, ringLastX, ringXAt, ringYAt, refreshRingDomains } from '../../src/util/ring';

/**
 * 环形缓冲：实时流滑动窗口的存储。
 *
 * 这里最容易错的只有一件事 —— **物理下标 ≠ 逻辑下标**：
 * 绕回之后 `ring.y[0]` 是「最新那根」还是「最老那根」，取决于起点。
 * 所以测试专门盯绕圈、淘汰与逻辑顺序读取。
 */
describe('环形缓冲（滑动窗口）', () => {
  const push = (ring: any, values: Array<number | null>, startX = 0): void => {
    ringAppend(
      ring,
      values.map((y, i) => ({ x: startX + i, y })),
      0
    );
    refreshRingDomains(ring);
  };

  it('没满时顺序写入，逻辑顺序就是写入顺序', () => {
    const ring = createRing(5);
    push(ring, [10, 20, 30]);
    expect(ring.length).toBe(3);
    expect([0, 1, 2].map((i) => ringYAt(ring, i))).toEqual([10, 20, 30]);
    expect(ring.xDomain).toEqual([0, 2]);
    expect(ring.yDomain).toEqual([10, 30]);
    expect(ring.xMonotonic).toBe(true);
  });

  it('满了之后覆盖最老的，逻辑顺序始终是「老 → 新」', () => {
    const ring = createRing(3);
    push(ring, [1, 2, 3]);
    push(ring, [4, 5], 3);
    expect(ring.length).toBe(3);
    expect([0, 1, 2].map((i) => ringYAt(ring, i))).toEqual([3, 4, 5]);
    expect([0, 1, 2].map((i) => ringXAt(ring, i))).toEqual([2, 3, 4]);
    // 物理槽位确实绕回来了（起点前移了 2，逻辑第 0 个点在物理 start 上）
    expect(ring.start).toBe(2);
    expect(ring.y[ring.start]).toBe(3);
  });

  it('一次追加超过容量：只留最后 capacity 根', () => {
    const ring = createRing(3);
    push(ring, [1, 2, 3, 4, 5]);
    expect(ring.length).toBe(3);
    expect([0, 1, 2].map((i) => ringYAt(ring, i))).toEqual([3, 4, 5]);
  });

  it('没有 x 的点顺着上一根 +1', () => {
    const ring = createRing(4);
    push(ring, [7, 8], 100);
    ringAppend(ring, [{ x: undefined, y: 9 }], ringLastX(ring) + 1);
    expect(ringXAt(ring, 2)).toBe(102);
    refreshRingDomains(ring);
    expect(ring.xDomain).toEqual([100, 102]);
  });

  it('断点（null）在环里是 NaN，域计算忽略它', () => {
    const ring = createRing(4);
    push(ring, [10, null, 30]);
    expect(Number.isNaN(ringYAt(ring, 1))).toBe(true);
    expect(ring.yDomain).toEqual([10, 30]);
    const accessors = ringAccessors(ring);
    expect(accessors.pointAt(1).y).toBeNull();
    expect(accessors.yValueAt(1)).toBeNull();
    expect(accessors.topAt(1)).toBe(0);
  });

  it('访问器按逻辑下标读（越界不泄露环里的陈旧槽位）', () => {
    const ring = createRing(3);
    push(ring, [1, 2, 3]);
    push(ring, [4], 3);
    const accessors = ringAccessors(ring);
    expect(accessors.xValueAt(0)).toBe(1);
    expect(accessors.xValueAt(2)).toBe(3);
    expect(accessors.xValueAt(3)).toBeUndefined();
    expect(accessors.xValueAt(-1)).toBeUndefined();
    expect(accessors.yValueAt(3)).toBeNull();
  });
});
