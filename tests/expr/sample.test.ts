import { robustRange, sampleFunctionCurve, sampleParametricCurve } from '../../src/expr/sample';

describe('曲线采样', () => {
  it('均匀采样覆盖整个区间且 x 单调递增', () => {
    const points = sampleFunctionCurve((x) => x, 0, 1, { base: 10, adaptive: false });
    expect(points).toHaveLength(10);
    expect(points[0][0]).toBe(0);
    expect(points[points.length - 1][0]).toBe(1);
    for (let i = 1; i < points.length; i++) expect(points[i][0]).toBeGreaterThan(points[i - 1][0]);
  });

  it('自适应细分：峰顶附近自动加点，峰值不被削平', () => {
    const coarse = sampleFunctionCurve((x) => Math.exp(-x * x), -3, 3, { base: 41, adaptive: false });
    const fine = sampleFunctionCurve((x) => Math.exp(-x * x), -3, 3, { base: 41, adaptive: true });
    expect(fine.length).toBeGreaterThan(coarse.length);
    // 用折线近似峰值：细分后应非常接近 1
    let peak = 0;
    for (const [, y] of fine) {
      if (isFinite(y) && y > peak) peak = y;
    }
    expect(peak).toBeCloseTo(1, 3);
  });

  it('极点写成断点（NaN），不会连出一条竖线', () => {
    const points = sampleFunctionCurve((x) => 1 / x, -1, 1, { base: 21 });
    expect(points.some(([, y]) => Number.isNaN(y))).toBe(true);
    for (const [, y] of points) {
      if (!Number.isNaN(y)) expect(Math.abs(y)).toBeLessThan(1e7);
    }
  });

  it('tan 的渐近线同样断开（不会把 +∞ 和 -∞ 连起来）', () => {
    const points = sampleFunctionCurve((x) => Math.tan(x), -2, 2, { base: 41 });
    expect(points.some(([, y]) => Number.isNaN(y))).toBe(true);
  });

  it('采样点数有上限：奇异点附近不会失控', () => {
    const points = sampleFunctionCurve((x) => 1 / (x - 0.123456), -1, 1, { base: 200, maxSamples: 800 });
    expect(points.length).toBeLessThanOrEqual(1200);
  });

  it('参数曲线：单位圆的采样点都落在圆上', () => {
    const points = sampleParametricCurve(Math.cos, Math.sin, 0, Math.PI * 2, { base: 32 });
    expect(points.length).toBeGreaterThanOrEqual(32);
    for (const [x, y] of points) {
      if (!isFinite(x) || !isFinite(y)) continue;
      expect(Math.hypot(x, y)).toBeCloseTo(1, 6);
    }
    // 首尾闭合
    const first = points[0];
    const last = points[points.length - 1];
    expect(Math.hypot(first[0] - Math.cos(Math.PI * 2), first[1] - Math.sin(Math.PI * 2))).toBeCloseTo(0, 6);
    expect(Math.hypot(last[0] - Math.cos(Math.PI * 2), last[1] - Math.sin(Math.PI * 2))).toBeCloseTo(0, 6);
  });

  it('稳健取值范围：离群尖峰不决定整张图的 y 轴', () => {
    const [lo, hi] = robustRange([1, 2, 3, 4, 5, 1e6]);
    expect(lo).toBeGreaterThanOrEqual(1);
    expect(hi).toBeLessThan(100);
    expect(robustRange([])).toEqual([-1, 1]);
    expect(robustRange([2, 2, 2])[1]).toBeGreaterThan(robustRange([2, 2, 2])[0]);
  });
});
