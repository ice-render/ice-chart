import type { DataPoint } from '../internal';

/**
 * **环形缓冲**：实时流的「滑动窗口」存储（`series.virtual: true` + `appendData(id, items, { maxPoints })`）。
 *
 * 为什么普通路径做不了这件事：`appendData` 会先把数据 concat 成新数组、再整条重跑
 * 「归一化 → 布局 → 重建像素」。窗口 1500 点时实测 **11ms/次**（AGENTS 里有账），
 * 60Hz 推送就吃掉 66% 的帧预算；窗口再大就完全跑不动。
 * 环形缓冲把每次追加变成「写 1 个槽位 + 挪一次起点」：容量固定，最老的槽位被覆盖，
 * **没有任何 O(n) 的数据搬运**（数据域是唯一还要扫一遍的东西，窗口几千点时约 0.02ms）。
 *
 * 与 `SeriesColumns`（连续列）的关系：两者对上层是同一件事 —— 都是「逻辑下标 → 值」，
 * 所以共用同一组访问器契约（`pointAt` / `xValueAt` / …）。区别只在物理布局：
 * 这里的 `x` / `y` 是**物理顺序**，逻辑第 i 个点在 `(start + i) % capacity` 上。
 * **因此不许绕过访问器直读 `ring.x[i]`** —— 环回之后那就是另一个点的值。
 */
export interface SeriesRing {
  kind: 'ring';
  /** 容量的上限（= 滑动窗口大小）。 */
  capacity: number;
  /** 逻辑起点在物理数组里的下标。 */
  start: number;
  /** 当前长度（≤ capacity）。 */
  length: number;
  /** 物理存储的 x（**不是**逻辑顺序）。 */
  x: Float64Array;
  /** 物理存储的 y，NaN = 断点。 */
  y: Float64Array;
  /** 逻辑顺序的 x 数据域。 */
  xDomain: [number, number];
  /** 逻辑顺序的 y 数据域（忽略断点）；全是断点时为 null。 */
  yDomain: [number, number] | null;
  /** 逻辑顺序的 x 是否单调不减（滑动窗口天然是）。 */
  xMonotonic: boolean;
  /** 环形缓冲不带第三维（气泡不流式）。 */
  sizeExtent: null;
}

/** 建一个空环（容量至少 1）。 */
export function createRing(capacity: number): SeriesRing {
  const size = Math.max(1, Math.floor(capacity) || 1);
  return {
    kind: 'ring',
    capacity: size,
    start: 0,
    length: 0,
    x: new Float64Array(size),
    y: new Float64Array(size),
    xDomain: [0, 1],
    yDomain: null,
    xMonotonic: true,
    sizeExtent: null,
  };
}

/** 逻辑下标 → 物理下标。 */
export function ringSlot(ring: SeriesRing, index: number): number {
  return (ring.start + index) % ring.capacity;
}

/** 逻辑第 i 个点的 x / y（越界返回 undefined / NaN）。 */
export function ringXAt(ring: SeriesRing, index: number): number {
  return ring.x[ringSlot(ring, index)];
}

export function ringYAt(ring: SeriesRing, index: number): number {
  return ring.y[ringSlot(ring, index)];
}

/**
 * 追加若干个点（逻辑顺序）。超过容量就覆盖最老的。
 *
 * `nextX` 给「没有显式 x」的追加用：调用方传上一根的 x，这里按 +1 递推。
 */
export function ringAppend(
  ring: SeriesRing,
  points: Array<{ x: number | undefined | null; y: number | null }>,
  nextX: number
): void {
  for (const point of points) {
    let slot: number;
    if (ring.length >= ring.capacity) {
      // 满了：**先**取走最老的槽位再推进起点（顺序反了会把最新的那根盖掉）
      slot = ring.start;
      ring.start = (ring.start + 1) % ring.capacity;
    } else {
      slot = (ring.start + ring.length) % ring.capacity;
      ring.length += 1;
    }
    const x = point.x;
    ring.x[slot] = x === undefined || x === null || !isFinite(x) ? nextX : x;
    ring.y[slot] = point.y === null ? NaN : point.y;
    nextX = ring.x[slot] + 1;
  }
}

/**
 * 按逻辑顺序重算数据域（追加之后调用）。
 *
 * 窗口几千点时这是 O(n) 的一趟扫描（约 0.02ms），比维护单调队列简单得多；
 * 真要做百万级窗口的实时流，该换的是分块 + 增量域，而不是这里加复杂度。
 */
export function refreshRingDomains(ring: SeriesRing): void {
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let monotonic = true;
  let prevX = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const x = ringXAt(ring, i);
    if (!isFinite(x)) continue;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (x < prevX) monotonic = false;
    prevX = x;
    const y = ringYAt(ring, i);
    if (Number.isNaN(y)) continue;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  ring.xDomain = isFinite(xMin) ? [xMin, xMax] : [0, 1];
  ring.yDomain = isFinite(yMin) ? [yMin, yMax] : null;
  ring.xMonotonic = monotonic;
}

/** 逻辑最后一个点的 x（空环返回 0，供「没有显式 x」的追加递推）。 */
export function ringLastX(ring: SeriesRing): number {
  if (!ring.length) return 0;
  const value = ringXAt(ring, ring.length - 1);
  return isFinite(value) ? value : 0;
}

/** 环形缓冲的访问器：逻辑下标进，值出（上层的提示框 / 命中 / 绘制全都不用改）。 */
export function ringAccessors(ring: SeriesRing): {
  pointAt(index: number): DataPoint;
  xValueAt(index: number): any;
  yValueAt(index: number): number | null;
  baseAt(index: number): number;
  topAt(index: number): number;
  sizeAt(index: number): number | undefined;
} {
  const yAt = (index: number): number | null => {
    if (index < 0 || index >= ring.length) return null;
    const value = ringYAt(ring, index);
    return Number.isNaN(value) ? null : value;
  };
  return {
    pointAt: (index: number): DataPoint => {
      const value = yAt(index);
      return {
        index,
        xValue: ringXAt(ring, index),
        y: value,
        raw: undefined,
        base: 0,
        top: value === null ? 0 : value,
        name: undefined,
      };
    },
    // 越界与数组语义一致（undefined）—— 别把环里的陈旧槽位当成新数据漏出去
    xValueAt: (index: number): any => (index < 0 || index >= ring.length ? undefined : ringXAt(ring, index)),
    yValueAt: yAt,
    baseAt: (): number => 0,
    topAt: (index: number): number => {
      const value = yAt(index);
      return value === null ? 0 : value;
    },
    sizeAt: (): number | undefined => undefined,
  };
}
