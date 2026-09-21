import {
  chunkAccessors,
  chunkIndexOf,
  chunkRangeForX,
  createChunks,
  pickChunksForWindow,
  requestChunk,
  requestChunksForWindow,
} from '../../src/util/chunks';

/**
 * 分块列存：亿级数据的按需加载。
 *
 * 盯三件事：① 逻辑下标 → 块 / 块内下标（offsets 二分）；② 未驻留的点读出来是「没有值」；
 * ③ 常驻块数有上限（LRU），不会因为一路平移把内存吃光。
 */
function makeLoader(sizes: number[]) {
  const loads: number[] = [];
  const make = (index: number) => {
    const size = sizes[index];
    const x = new Float64Array(size);
    const y = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      x[i] = index * 100 + i;
      y[i] = (index * 100 + i) % 97;
    }
    return { x, y };
  };
  return {
    loads,
    load: (index: number) => {
      loads.push(index);
      return make(index);
    },
  };
}

describe('分块列存（按需加载）', () => {
  const sizes = [100, 100, 100];
  /** 三块连续覆盖 x ∈ [0, 299]。 */
  const rangeOf = (i: number): [number, number] => [i * 100, i * 100 + 99];

  it('逻辑下标 → 块：offsets 上二分', () => {
    const { load } = makeLoader(sizes);
    const chunks = createChunks({ sizes, load, rangeOf, yDomain: [0, 100] });
    expect(chunkIndexOf(chunks, 0)).toBe(0);
    expect(chunkIndexOf(chunks, 99)).toBe(0);
    expect(chunkIndexOf(chunks, 100)).toBe(1);
    expect(chunkIndexOf(chunks, 250)).toBe(2);
    expect(chunks.total).toBe(300);
  });

  it('未驻留的点读出来是「没有值」，驻留之后才有', () => {
    const { load } = makeLoader(sizes);
    const chunks = createChunks({ sizes, load, rangeOf, yDomain: [0, 100] });
    const accessors = chunkAccessors(chunks);
    expect(accessors.xValueAt(5)).toBeUndefined();
    expect(accessors.yValueAt(5)).toBeNull();
    requestChunk(chunks, 0, () => {});
    expect(accessors.xValueAt(5)).toBe(5);
    expect(accessors.pointAt(5)).toMatchObject({ index: 5, xValue: 5, y: 5 });
  });

  it('窗口请求：把覆盖到的块都请求一遍，且幂等（不重复 load）', () => {
    const { load, loads } = makeLoader(sizes);
    const chunks = createChunks({ sizes, load, rangeOf, yDomain: [0, 100] });
    requestChunksForWindow(chunks, 90, 210, () => {});
    // 90..210 跨 0/1/2 三块
    expect(loads.sort()).toEqual([0, 1, 2]);
    requestChunksForWindow(chunks, 90, 210, () => {});
    expect(loads.length).toBe(3);
  });

  it('窗口远大于驻留预算时**按预算取样**（不能把窗口内每块都请求一遍）', () => {
    // 实测教训：10 亿点缩到全量视图，窗口覆盖 1 万块，全请求 = 1 万次加载、
    // 初始化 22 秒；按预算取样之后是 3 次、初始化 3ms。
    expect(pickChunksForWindow(0, 9999, 3)).toEqual([0, 5000, 9999]);
    expect(pickChunksForWindow(0, 2, 3)).toEqual([0, 1, 2]);
    expect(pickChunksForWindow(10, 12, 10)).toEqual([10, 11, 12]);
    expect(pickChunksForWindow(5, 4, 3)).toEqual([]);
  });

  it('窗口请求走取样：1 万块的窗口只加载 3 块', () => {
    const sizes = Array.from({ length: 10000 }, () => 10);
    const { load, loads } = makeLoader(sizes);
    const chunks = createChunks({
      sizes,
      load,
      rangeOf: (i) => [i * 10, i * 10 + 9],
      yDomain: [0, 100],
      maxResidentChunks: 3,
    });
    requestChunksForWindow(chunks, 0, chunks.total - 1, () => {});
    expect(loads.length).toBe(3);
    expect(chunks.resident.filter(Boolean).length).toBe(3);
  });

  it('x 范围 → 块区间：定位不依赖加载', () => {
    const { load } = makeLoader(sizes);
    const chunks = createChunks({ sizes, load, rangeOf, yDomain: [0, 100] });
    expect(chunkRangeForX(chunks, 50, 60)).toEqual({ from: 0, to: 1 });
    expect(chunkRangeForX(chunks, 150, 160)).toEqual({ from: 0, to: 2 });
    expect(chunkRangeForX(chunks, 250, 260)).toEqual({ from: 1, to: 2 });
    expect(chunkRangeForX(chunks, 9999, 10000)).toEqual({ from: 0, to: -1 });
  });

  it('常驻块数有上限：一路加载会被 LRU 淘汰', () => {
    const { load } = makeLoader(sizes);
    const chunks = createChunks({
      sizes,
      load,
      rangeOf,
      yDomain: [0, 100],
      maxResidentChunks: 2,
    });
    requestChunk(chunks, 0, () => {});
    requestChunk(chunks, 1, () => {});
    expect(chunks.resident.filter(Boolean).length).toBe(2);
    requestChunk(chunks, 2, () => {});
    expect(chunks.resident.filter(Boolean).length).toBe(2);
    // 最久没用过的 0 被淘汰
    expect(chunks.resident[0]).toBeNull();
    expect(chunks.resident[1]).not.toBeNull();
    expect(chunks.resident[2]).not.toBeNull();
  });

  it('声明式的域：x 范围来自 rangeOf、y 值域来自调用方（不随加载漂移）', () => {
    const { load } = makeLoader(sizes);
    const chunks = createChunks({ sizes, load, rangeOf, yDomain: [-5, 42] });
    expect(chunks.xDomain).toEqual([0, 299]);
    expect(chunks.yDomain).toEqual([-5, 42]);
    requestChunk(chunks, 1, () => {});
    expect(chunks.yDomain).toEqual([-5, 42]);
  });
});
