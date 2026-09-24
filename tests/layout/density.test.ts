import { computeBeeswarmOffsets, computeKdeProfile, silvermanBandwidth } from '../../src/layout/density';

/** 梯形法积分，用来验证密度曲线「面积 = 1」。 */
function integrate(grid: number[], density: number[]): number {
  let sum = 0;
  for (let i = 1; i < grid.length; i++) {
    sum += ((density[i] + density[i - 1]) / 2) * (grid[i] - grid[i - 1]);
  }
  return sum;
}

const NORMALISH = [
  10.2, 10.5, 10.9, 11.1, 11.3, 11.4, 11.6, 11.8, 12.0, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7,
  12.9, 13.0, 13.2, 13.4, 13.7, 14.0, 14.4, 15.1, 16.2,
];

describe('silvermanBandwidth', () => {
  it('uses the smaller of σ and IQR/1.34, scaled by n^-1/5', () => {
    // 手算基准：这组数的 [σ, IQR/1.34] 里 IQR 那条更小，带宽应当贴着它
    const sorted = NORMALISH.slice().sort((a, b) => a - b);
    const mean = NORMALISH.reduce((a, b) => a + b, 0) / NORMALISH.length;
    const sigma = Math.sqrt(NORMALISH.reduce((acc, v) => acc + (v - mean) ** 2, 0) / NORMALISH.length);
    const q1 = sorted[Math.floor((sorted.length - 1) * 0.25)];
    const q3 = sorted[Math.floor((sorted.length - 1) * 0.75)];
    const expected = 0.9 * Math.min(sigma, (q3 - q1) / 1.34) * Math.pow(NORMALISH.length, -1 / 5);
    expect(silvermanBandwidth(NORMALISH)).toBeCloseTo(expected, 6);
  });

  it('keeps a positive bandwidth when every observation is identical', () => {
    const bandwidth = silvermanBandwidth([5, 5, 5, 5, 5]);
    expect(bandwidth).toBeGreaterThan(0);
    expect(isFinite(bandwidth)).toBe(true);
  });

  it('returns 0 for an empty sample', () => {
    expect(silvermanBandwidth([])).toBe(0);
  });
});

describe('computeKdeProfile', () => {
  it('returns a grid of the requested resolution whose density integrates to 1', () => {
    const profile = computeKdeProfile(NORMALISH, { samples: 64 });
    expect(profile.grid).toHaveLength(64);
    expect(profile.density).toHaveLength(64);
    expect(integrate(profile.grid, profile.density)).toBeCloseTo(1, 2);
  });

  it('returns an ascending grid with non-negative density', () => {
    const profile = computeKdeProfile(NORMALISH);
    for (let i = 1; i < profile.grid.length; i++) {
      expect(profile.grid[i]).toBeGreaterThan(profile.grid[i - 1]);
    }
    expect(Math.min(...profile.density)).toBeGreaterThanOrEqual(0);
  });

  it('puts the peak next to the sample mean', () => {
    const profile = computeKdeProfile(NORMALISH, { samples: 128 });
    let peak = 0;
    for (let i = 1; i < profile.density.length; i++) {
      if (profile.density[i] > profile.density[peak]) peak = i;
    }
    const mean = NORMALISH.reduce((a, b) => a + b, 0) / NORMALISH.length;
    expect(Math.abs(profile.grid[peak] - mean)).toBeLessThan(profile.bandwidth);
  });

  it('lets an explicit bandwidth override the automatic one and flattens the peak', () => {
    const auto = computeKdeProfile(NORMALISH, { samples: 128 });
    const wide = computeKdeProfile(NORMALISH, { bandwidth: auto.bandwidth * 3, samples: 128 });
    expect(wide.bandwidth).toBeCloseTo(auto.bandwidth * 3, 6);
    expect(Math.max(...wide.density)).toBeLessThan(Math.max(...auto.density));
  });

  it('stays finite when the sample has no spread', () => {
    const profile = computeKdeProfile([5, 5, 5, 5]);
    expect(profile.grid.every((v) => isFinite(v))).toBe(true);
    expect(profile.density.every((v) => isFinite(v))).toBe(true);
    expect(Math.max(...profile.density)).toBeGreaterThan(0);
  });

  it('degrades to an empty profile instead of throwing', () => {
    const profile = computeKdeProfile([]);
    expect(profile.grid).toHaveLength(0);
    expect(profile.density).toHaveLength(0);
  });
});

/** 避让是像素空间的事，纯函数里 y 由调用方注入（组件传 `yScale.map`）。 */
const yOf = (value: number): number => value;

describe('computeBeeswarmOffsets', () => {
  it('keeps same-height points at least one diameter apart', () => {
    const offsets = computeBeeswarmOffsets([50, 50, 50, 50], { yOf, radius: 3, maxOffset: 40 });
    expect(offsets).toHaveLength(4);
    for (let i = 0; i < offsets.length; i++) {
      for (let j = i + 1; j < offsets.length; j++) {
        expect(Math.abs(offsets[i] - offsets[j])).toBeGreaterThanOrEqual(6 - 1e-9);
      }
    }
  });

  it('leaves vertically separated points where they are', () => {
    expect(computeBeeswarmOffsets([0, 50, 100], { yOf, radius: 3, maxOffset: 40 })).toEqual([0, 0, 0]);
  });

  it('treats points exactly one diameter apart as non-overlapping', () => {
    expect(computeBeeswarmOffsets([50, 56], { yOf, radius: 3, maxOffset: 40 })).toEqual([0, 0]);
  });

  it('spreads to both sides and never leaves the jitter window', () => {
    const offsets = computeBeeswarmOffsets(new Array(7).fill(50), { yOf, radius: 3, maxOffset: 40 });
    expect(Math.min(...offsets)).toBeLessThan(0);
    expect(Math.max(...offsets)).toBeGreaterThan(0);
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(40 + 1e-9);
  });

  it('stays bounded and still spread when there are far more points than slots', () => {
    const offsets = computeBeeswarmOffsets(new Array(500).fill(50), { yOf, radius: 3, maxOffset: 40 });
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(40 + 1e-9);
    expect(new Set(offsets.map((o) => o.toFixed(3))).size).toBeGreaterThan(50);
  });

  it('is deterministic', () => {
    const values = [1, 1, 2, 2.5, 2.5, 2.5, 3, 3, 9];
    const options = { yOf, radius: 2, maxOffset: 12 };
    const first = computeBeeswarmOffsets(values, options);
    const second = computeBeeswarmOffsets(values.slice(), options);
    expect(first).toEqual(second);
  });

  it('returns zeros when the mark has no radius', () => {
    expect(computeBeeswarmOffsets([1, 1, 1], { yOf, radius: 0, maxOffset: 10 })).toEqual([0, 0, 0]);
  });
});
