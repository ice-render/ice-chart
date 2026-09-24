import { computeHexBins, hexToPixel, pixelToHex } from '../../src/layout/hexbin';

/**
 * 六边形分箱的几何是纯函数：格子的坐标换算、落点归属、聚合口径都在这里钉死。
 * 组件只负责「数据 → 像素」和画格子 —— 与蜂群避让同一条思路（像素空间的计算放在能单测的地方）。
 */
describe('六边形格点几何', () => {
  it('格心与格点互为逆运算（尖顶六边形）', () => {
    for (const [q, r] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [-2, 3],
      [5, -2],
    ]) {
      const center = hexToPixel(q, r, 10);
      expect(pixelToHex(center.x, center.y, 10)).toEqual({ q, r });
    }
  });

  it('相邻格心之间的距离等于 2 倍外接圆半径（无缝拼接）', () => {
    const radius = 12;
    const origin = hexToPixel(0, 0, radius);
    for (const [q, r] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, -1],
      [-1, 1],
    ]) {
      const center = hexToPixel(q, r, radius);
      const dx = center.x - origin.x;
      const dy = center.y - origin.y;
      expect(Math.sqrt(dx * dx + dy * dy)).toBeCloseTo(radius * Math.sqrt(3), 6);
    }
  });

  it('格子内的任意点都归到同一个格', () => {
    const center = hexToPixel(3, -1, 8);
    for (const [dx, dy] of [
      [0, 0],
      [3, 2],
      [-3, -2],
      [2, -3],
    ]) {
      expect(pixelToHex(center.x + dx, center.y + dy, 8)).toEqual({ q: 3, r: -1 });
    }
  });
});

describe('computeHexBins', () => {
  const points: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [100, 100],
    [101, 99],
    [100.5, 100.5],
  ];

  it('默认按计数聚合，并给出格心（用于绘制与高亮锚点）', () => {
    const bins = computeHexBins(points, { radius: 20 });
    expect(bins.length).toBe(2);
    const biggest = bins.find((bin) => bin.count === 3)!;
    expect(biggest.value).toBe(3);
    const center = hexToPixel(biggest.q, biggest.r, 20);
    expect(biggest.cx).toBeCloseTo(center.x, 6);
    expect(biggest.cy).toBeCloseTo(center.y, 6);
  });

  it('aggregate=sum / mean / max 用第三个数当权重', () => {
    const weighted: Array<[number, number, number]> = [
      [0, 0, 10],
      [0.5, 0.5, 20],
      [1, 1, 60],
      [200, 200, 5],
    ];
    const sum = computeHexBins(weighted, { radius: 30, aggregate: 'sum' });
    expect(sum[0].value).toBe(90);
    const mean = computeHexBins(weighted, { radius: 30, aggregate: 'mean' });
    expect(mean[0].value).toBeCloseTo(30, 6);
    const max = computeHexBins(weighted, { radius: 30, aggregate: 'max' });
    expect(max[0].value).toBe(60);
  });

  it('缺失第三维时按计数，且只数得到点（不造空格）', () => {
    const bins = computeHexBins(
      [
        [0, 0, 5],
        [1, 1],
      ] as any,
      { radius: 30, aggregate: 'sum' }
    );
    expect(bins).toHaveLength(1);
    expect(bins[0].value).toBe(6);
  });

  it('非有限坐标直接跳过（坏数据不参与统计）', () => {
    const bins = computeHexBins(
      [
        [0, 0],
        [NaN, 1],
        [1, Infinity],
      ] as any,
      { radius: 30 }
    );
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(1);
  });

  it('空输入返回空数组（不抛异常）', () => {
    expect(computeHexBins([], { radius: 10 })).toEqual([]);
  });
});
