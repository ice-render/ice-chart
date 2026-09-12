import { BandScale } from '../../src/scale/BandScale';
import { LinearScale } from '../../src/scale/LinearScale';
import { LogScale } from '../../src/scale/LogScale';
import { TimeScale } from '../../src/scale/TimeScale';
import { createScale, formatTick } from '../../src/scale';

describe('LinearScale', () => {
  it('maps and inverts linearly', () => {
    const scale = new LinearScale([0, 100], [0, 200]);
    expect(scale.map(0)).toBe(0);
    expect(scale.map(50)).toBe(100);
    expect(scale.map(100)).toBe(200);
    expect(scale.invert(100)).toBe(50);
  });

  it('supports inverted ranges (screen y axis)', () => {
    const scale = new LinearScale([0, 100], [300, 0]);
    expect(scale.map(0)).toBe(300);
    expect(scale.map(100)).toBe(0);
    expect(scale.invert(0)).toBe(100);
  });

  it('expands degenerate domains instead of dividing by zero', () => {
    const scale = new LinearScale([5, 5], [0, 100]);
    expect(scale.domain[0]).toBeLessThan(scale.domain[1]);
    expect(isFinite(scale.map(5))).toBe(true);
  });

  it('produces nice ticks inside the domain', () => {
    const scale = new LinearScale([0, 97], [0, 100]);
    const ticks = scale.ticks(5);
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks[0]).toBeGreaterThanOrEqual(0);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(97);
    expect(ticks[1] - ticks[0]).toBeCloseTo(ticks[2] - ticks[1], 6);
  });

  it('converts between values and 0~1 fractions (cross-chart linking)', () => {
    const scale = new LinearScale([0, 200], [0, 500]);
    expect(scale.fractionOf(50)).toBeCloseTo(0.25, 6);
    expect(scale.valueAtFraction(0.25)).toBeCloseTo(50, 6);
  });
});

describe('BandScale', () => {
  const scale = new BandScale(['Mon', 'Tue', 'Wed', 'Thu'], [0, 400], { paddingInner: 0, paddingOuter: 0 });

  it('lays out bands sequentially', () => {
    expect(scale.step()).toBeCloseTo(100, 6);
    expect(scale.bandwidth()).toBeCloseTo(100, 6);
    expect(scale.bandStart('Mon')).toBeCloseTo(0, 6);
    expect(scale.bandStart('Wed')).toBeCloseTo(200, 6);
  });

  it('maps a category to the band center', () => {
    expect(scale.map('Mon')).toBeCloseTo(50, 6);
    expect(scale.map('Thu')).toBeCloseTo(350, 6);
  });

  it('resolves the band under a pixel and falls back to the nearest', () => {
    expect(scale.indexAt(210)).toBe(2);
    expect(scale.indexAt(-40)).toBe(-1);
    expect(scale.nearestIndex(-40)).toBe(0);
    expect(scale.invert(210)).toBe('Wed');
    expect(scale.invert(390)).toBe('Thu');
  });

  it('tolerates string/number mismatches from CSV data', () => {
    const numeric = new BandScale(['0', '1', '2'], [0, 300], { paddingInner: 0, paddingOuter: 0 });
    expect(numeric.bandStart(1)).toBeCloseTo(100, 6);
  });
});

describe('TimeScale', () => {
  it('maps timestamps and produces monotonic ticks', () => {
    const day = 24 * 3600 * 1000;
    const start = Date.UTC(2026, 0, 1);
    const scale = new TimeScale([start, start + day * 10], [0, 500]);
    expect(scale.map(start)).toBeCloseTo(0, 6);
    expect(scale.map(start + day * 10)).toBeCloseTo(500, 6);
    const ticks = scale.ticks(5);
    expect(ticks.length).toBeGreaterThan(1);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }
  });

  it('formats a tick into something human readable', () => {
    const start = Date.UTC(2026, 5, 1);
    const scale = new TimeScale([start, start + 24 * 3600 * 1000], [0, 100]);
    const label = formatTick(start + 3600 * 1000, scale, 0);
    expect(label.length).toBeGreaterThan(0);
    expect(label).toContain(':');
  });
});

describe('LogScale', () => {
  it('maps powers of ten evenly', () => {
    const scale = new LogScale([1, 1000], [0, 300]);
    expect(scale.map(1)).toBeCloseTo(0, 6);
    expect(scale.map(10)).toBeCloseTo(100, 6);
    expect(scale.map(1000)).toBeCloseTo(300, 6);
    expect(scale.invert(100)).toBeCloseTo(10, 6);
  });

  it('returns the powers of the base as ticks', () => {
    const scale = new LogScale([1, 10000], [0, 100]);
    expect(scale.ticks(4)).toEqual([1, 10, 100, 1000, 10000]);
  });
});

describe('createScale', () => {
  it('creates the scale matching the axis type', () => {
    expect(createScale('linear', [0, 1], [0, 1]).type).toBe('linear');
    expect(createScale('category', ['a', 'b'], [0, 1]).type).toBe('category');
    expect(createScale('time', [0, 1], [0, 1]).type).toBe('time');
    expect(createScale('log', [1, 10], [0, 1]).type).toBe('log');
  });
});
