import type { DataPoint } from '../internal';

/** 一个已驻留的块（列）。 */
export interface ChunkColumns {
  x: Float64Array;
  /** NaN = 断点。 */
  y: Float64Array;
}

/**
 * **分块列存**：亿级数据的按需加载。
 *
 * 与连续列 / 环形缓冲的差别只有一个：数据不在内存里，而是**按块取**。
 * 图表只保证「可见窗口覆盖的块」驻留（LRU 有界），其余块可以根本不加载 ——
 * 于是内存与数据总量解耦：10 亿点、每块 100 万点、驻留 4 块 = 32MB 列 + 常数开销。
 *
 * 三条纪律：
 * 1. **未驻留的点读出来是「没有值」**（`xValueAt` → undefined、`yValueAt` → null），
 *    渲染与命中都会跳过它 —— 这不会静默少画：窗口覆盖的块一定会被请求驻留，
 *    到达后 `markDirty()` 触发重绘（异步加载器要的就是这个语义）。
 * 2. 块按 x 递增排列（分块的前提），`rangeOf(i)` 给块 i 的 x 范围；
 *    没给就只能在块加载过之后从它的数据里推。
 * 3. 驻留块数有上限（`maxResidentChunks`），超出按 **LRU** 淘汰；
 *    淘汰之后再回到那片区域会重新请求（加载器可以是纯函数 / 带缓存，由调用方决定）。
 */
export interface SeriesChunks {
  kind: 'chunks';
  /** 每块的逻辑长度。 */
  sizes: number[];
  /** 每块的逻辑起点（`offsets[i]` = 前 i 块之和）。 */
  offsets: number[];
  /** 逻辑总点数。 */
  total: number;
  /** 每块的 x 范围（`rangeOf` 给不出来时是 null，加载后补齐）。 */
  ranges: Array<[number, number] | null>;
  /** 已驻留的块。 */
  resident: Array<ChunkColumns | null>;
  /** 正在加载的块。 */
  loading: Set<number>;
  /** 驻留上限（LRU）。 */
  maxResident: number;
  /** 最近使用的块下标（越靠后越新）。 */
  lru: number[];
  /** 取第 i 块的列（同步或异步）。 */
  load: (index: number) => ChunkColumns | PromiseLike<ChunkColumns>;
  xDomain: [number, number];
  yDomain: [number, number] | null;
  xMonotonic: boolean;
  sizeExtent: null;
}

/** 逻辑下标 → 块下标（二分 `offsets`）。 */
export function chunkIndexOf(chunks: SeriesChunks, index: number): number {
  let lo = 0;
  let hi = chunks.sizes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chunks.offsets[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 逻辑下标 → 它的块（与块内下标）；块没驻留时返回 null。 */
export function chunkAt(chunks: SeriesChunks, index: number): { columns: ChunkColumns; local: number } | null {
  if (index < 0 || index >= chunks.total) return null;
  const chunk = chunkIndexOf(chunks, index);
  const columns = chunks.resident[chunk];
  if (!columns) return null;
  return { columns, local: index - chunks.offsets[chunk] };
}

/** 造一个分块存储（驻留表先留空）。 */
export function createChunks(input: {
  sizes: number[];
  load: (index: number) => ChunkColumns | PromiseLike<ChunkColumns>;
  /** 块 i 的 x 范围（窗口定位用，声明式，不依赖加载）。 */
  rangeOf: (index: number) => [number, number];
  /** y 值域（声明式，避免坐标轴随加载漂移）。 */
  yDomain: [number, number];
  maxResidentChunks?: number;
}): SeriesChunks {
  const sizes = input.sizes.map((size) => Math.max(0, Math.floor(size) || 0));
  const offsets: number[] = [];
  let total = 0;
  for (const size of sizes) {
    offsets.push(total);
    total += size;
  }
  const ranges = sizes.map((_, index) => input.rangeOf(index));
  const known = ranges.filter((range): range is [number, number] => !!range);
  return {
    kind: 'chunks',
    sizes,
    offsets,
    total,
    ranges,
    resident: sizes.map(() => null),
    loading: new Set<number>(),
    maxResident: Math.max(1, Math.floor(input.maxResidentChunks || 4)),
    lru: [],
    load: input.load,
    xDomain: known.length
      ? [Math.min(...known.map((r) => r[0])), Math.max(...known.map((r) => r[1]))]
      : [0, 1],
    yDomain: input.yDomain,
    xMonotonic: true,
    sizeExtent: null,
  };
}

/**
 * 请求第 i 块驻留；到货后调 `onReady`（图表据此重绘）。
 * 已经在驻留表里 / 正在加载 → 直接返回（幂等）。
 */
export function requestChunk(chunks: SeriesChunks, index: number, onReady: () => void): void {
  if (index < 0 || index >= chunks.sizes.length) return;
  if (chunks.resident[index] || chunks.loading.has(index)) {
    touchLru(chunks, index);
    return;
  }
  chunks.loading.add(index);
  const settle = (columns: ChunkColumns | null): void => {
    chunks.loading.delete(index);
    if (!columns) return;
    chunks.resident[index] = columns;
    touchLru(chunks, index);
    refreshChunkMeta(chunks, index);
    evictChunks(chunks);
    onReady();
  };
  try {
    const result = chunks.load(index);
    if (result && typeof (result as PromiseLike<ChunkColumns>).then === 'function') {
      (result as PromiseLike<ChunkColumns>).then(
        (columns) => settle(columns),
        () => settle(null)
      );
    } else {
      settle(result as ChunkColumns);
    }
  } catch (err) {
    settle(null);
  }
}

/** 窗口 [from, to]（逻辑下标）覆盖到的块全部驻留。 */
export function requestChunksForWindow(chunks: SeriesChunks, from: number, to: number, onReady: () => void): void {
  if (!chunks.sizes.length || to < from) return;
  const first = chunkIndexOf(chunks, Math.max(0, from));
  const last = chunkIndexOf(chunks, Math.min(chunks.total - 1, to));
  for (const index of pickChunksForWindow(first, last, chunks.maxResident)) requestChunk(chunks, index, onReady);
}

/**
 * 窗口覆盖的块 → **按驻留预算取样**要请求哪些块。
 *
 * 为什么不能「窗口内每块都请求」：把 10 亿点缩到全量视图时，窗口覆盖 1 万块 ——
 * 全请求就是 1 万次加载（实测初始化要 22 秒、每次还白分配 16MB），而 LRU 只留 3 块，
 * 多出来的请求纯属浪费。所以按预算**均匀取样**（含首尾两块）：
 * 全量视图画出的是「等距抽样的几段」，放到窗口只有几块时则一块不少。
 * 这与散点 / 折线的密度抽稀是同一条思路 —— 屏幕上放不下的东西，抽稀而不是硬画。
 */
export function pickChunksForWindow(from: number, to: number, budget: number): number[] {
  const count = to - from + 1;
  if (count <= 0) return [];
  const limit = Math.max(1, Math.min(Math.max(1, budget), count));
  if (count === limit) {
    const all: number[] = [];
    for (let i = from; i <= to; i++) all.push(i);
    return all;
  }
  const picked: number[] = [];
  for (let k = 0; k < limit; k++) {
    const at = from + Math.round((k * (count - 1)) / (limit - 1));
    if (picked[picked.length - 1] !== at) picked.push(at);
  }
  return picked;
}

/**
 * 把可见的 x 范围落到块区间上（块按 x 递增）。
 *
 * 优先用 `rangeOf` 给的范围（不必加载就能定位）；没给时只能用已驻留块的范围推算 ——
 * 那时会退化成「从第一个已驻留块起，尽量往前请求」，并在下一帧收敛。
 */
export function chunkRangeForX(chunks: SeriesChunks, x0: number, x1: number): { from: number; to: number } {
  const n = chunks.sizes.length;
  if (!n) return { from: 0, to: -1 };
  // 范围是声明式的（rangeOf），所以定位不用加载任何块
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    const range = chunks.ranges[i];
    if (!range) continue;
    if (range[1] < x0 || range[0] > x1) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) return { from: 0, to: -1 };
  // 相邻块之间留一块余量：窗口边缘正在加载时也能连上
  return { from: Math.max(0, first - 1), to: Math.min(n - 1, last + 1) };
}

function touchLru(chunks: SeriesChunks, index: number): void {
  const at = chunks.lru.indexOf(index);
  if (at >= 0) chunks.lru.splice(at, 1);
  chunks.lru.push(index);
}

/** 超出驻留上限就淘汰最久没用过的块（正在加载的不动）。 */
function evictChunks(chunks: SeriesChunks): void {
  while (chunks.lru.length > chunks.maxResident) {
    const victim = chunks.lru.find((index) => !chunks.loading.has(index));
    if (victim === undefined) return;
    const at = chunks.lru.indexOf(victim);
    chunks.lru.splice(at, 1);
    chunks.resident[victim] = null;
  }
}

/** 块到货后补齐它的 x 范围（值域是声明式的，不动）。 */
function refreshChunkMeta(chunks: SeriesChunks, index: number): void {
  const columns = chunks.resident[index];
  if (!columns) return;
  const size = chunks.sizes[index];
  if (size) {
    const first = columns.x[0];
    const last = columns.x[size - 1];
    if (isFinite(first) && isFinite(last)) chunks.ranges[index] = [Math.min(first, last), Math.max(first, last)];
  }
  const known = chunks.ranges.filter((range): range is [number, number] => !!range);
  if (known.length) {
    chunks.xDomain = [Math.min(...known.map((r) => r[0])), Math.max(...known.map((r) => r[1]))];
  }
}

/** 分块存储的访问器：**未驻留的点读出来是「没有值」**（渲染与命中都会跳过）。 */
export function chunkAccessors(chunks: SeriesChunks): {
  /**
   * 注意返回类型：未驻留 / 越界时**运行期就是 `undefined`**（与数组实现的越界同语义），
   * 调用方照老写法判真假即可 —— 类型上与其它存储的访问器保持一致。
   */
  pointAt(index: number): DataPoint;
  xValueAt(index: number): any;
  yValueAt(index: number): number | null;
  baseAt(index: number): number;
  topAt(index: number): number;
  sizeAt(index: number): number | undefined;
} {
  const yAt = (index: number): number | null => {
    const found = chunkAt(chunks, index);
    if (!found) return null;
    const value = found.columns.y[found.local];
    return Number.isNaN(value) ? null : value;
  };
  return {
    pointAt: (index: number): DataPoint => {
      const found = chunkAt(chunks, index);
      if (!found) return undefined as unknown as DataPoint;
      const value = yAt(index);
      return {
        index,
        xValue: found.columns.x[found.local],
        y: value,
        raw: undefined,
        base: 0,
        top: value === null ? 0 : value,
        name: undefined,
      };
    },
    xValueAt: (index: number): any => {
      const found = chunkAt(chunks, index);
      return found ? found.columns.x[found.local] : undefined;
    },
    yValueAt: yAt,
    baseAt: (): number => 0,
    topAt: (index: number): number => {
      const value = yAt(index);
      return value === null ? 0 : value;
    },
    sizeAt: (): number | undefined => undefined,
  };
}
