import { normalizeOption, toSerializableOption } from '../../src/option/normalize';
import type { ChartOption } from '../../src/types';

function baseOption(extra: Partial<ChartOption> = {}): ChartOption {
  return {
    series: [
      { id: 'a', type: 'line', name: 'A', data: [1, 2, 3] },
      { id: 'b', type: 'line', name: 'B', data: [[0, 4], [1, 5], [2, 6]] },
    ],
    ...extra,
  };
}

describe('normalizeOption', () => {
  it('normalizes plain numbers, tuples and objects into data points', () => {
    const norm = normalizeOption({
      series: [
        { id: 'a', type: 'line', data: [1, null, 3] },
        { id: 'b', type: 'line', data: [[10, 1], [20, 2]] },
        { id: 'c', type: 'line', data: [{ x: 'a', y: 5 }, { x: 'b', y: 6 }], xField: 'x', yField: 'y' },
      ],
    });
    expect(norm.series[0].points[0]).toMatchObject({ xValue: 0, y: 1, base: 0, top: 1 });
    expect(norm.series[0].points[1].y).toBeNull();
    expect(norm.series[1].points[1]).toMatchObject({ xValue: 20, y: 2 });
    expect(norm.series[2].points[0]).toMatchObject({ xValue: 'a', y: 5 });
  });

  it('infers a category axis for bar charts', () => {
    const norm = normalizeOption({ series: [{ type: 'bar', data: [3, 5, 4] }] });
    expect(norm.xAxis.type).toBe('category');
    expect(norm.categories).toEqual([0, 1, 2]);
  });

  it('infers a time axis from Date values', () => {
    const norm = normalizeOption({
      series: [{ type: 'line', data: [[new Date(2026, 0, 1), 1], [new Date(2026, 0, 2), 2]] }],
    });
    expect(norm.xAxis.type).toBe('time');
  });

  it('computes the y domain and includes zero for bars', () => {
    const norm = normalizeOption({ series: [{ type: 'bar', data: [10, 20] }] });
    expect(norm.yAxis.domain[0]).toBeLessThanOrEqual(0);
    expect(norm.yAxis.domain[1]).toBeGreaterThanOrEqual(20);
  });

  it('stacks series that share a stack name', () => {
    const norm = normalizeOption({
      series: [
        { id: 's1', type: 'bar', stack: 'total', data: [1, 2] },
        { id: 's2', type: 'bar', stack: 'total', data: [10, 20] },
      ],
    });
    expect(norm.series[0].points[0]).toMatchObject({ base: 0, top: 1 });
    expect(norm.series[1].points[0]).toMatchObject({ base: 1, top: 11 });
    expect(norm.series[1].points[1]).toMatchObject({ base: 2, top: 22 });
    expect(norm.yAxis.domain[1]).toBeGreaterThanOrEqual(22);
  });

  it('honours legend.selected / hidden ids', () => {
    const norm = normalizeOption(baseOption({ legend: { selected: { B: false } } }));
    expect(norm.hiddenIds.b).toBe(true);
    expect(norm.series[1].hidden).toBe(true);
    expect(norm.visibleSeries.map((s) => s.id)).toEqual(['a']);
  });

  it('applies an explicit x domain (zoom window)', () => {
    const norm = normalizeOption(baseOption(), { xDomain: [10, 20] });
    expect(norm.xAxis.domain).toEqual([10, 20]);
  });

  it('carries theme defaults and palette colours', () => {
    const norm = normalizeOption(baseOption());
    expect(norm.series[0].color).toBe(norm.theme.colorPalette[0]);
    expect(norm.series[1].color).toBe(norm.theme.colorPalette[1]);
  });

  it('rejects a missing series array', () => {
    expect(() => normalizeOption({} as any)).toThrow();
  });
});

describe('toSerializableOption', () => {
  it('drops functions and keeps plain data', () => {
    const option = baseOption({
      tooltip: { formatter: () => 'x' },
      xAxis: { formatter: (v) => String(v) },
    });
    const serializable = toSerializableOption(option);
    expect(serializable.tooltip.formatter).toBeUndefined();
    expect(serializable.xAxis.formatter).toBeUndefined();
    expect(JSON.parse(JSON.stringify(serializable)).series[0].name).toBe('A');
  });
});

describe('InternalSeries.pointAt', () => {
  it('is the very same object as points[index] for a plain series', () => {
    const norm = normalizeOption({ series: [{ id: 'a', type: 'line', data: [1, 2, 3] }] });
    const series = norm.series[0];
    expect(series.pointAt(0)).toBe(series.points[0]);
    expect(series.pointAt(2)).toBe(series.points[2]);
    // 越界与 points[index] 同语义（undefined），调用方照老写法判真假即可
    expect(series.pointAt(3)).toBeUndefined();
    expect(series.pointAt(-1)).toBeUndefined();
  });

  it('exposes exactly the fields a column-store series has to synthesize', () => {
    const norm = normalizeOption({ series: [{ id: 'a', type: 'line', data: [[10, 1]] }] });
    const point = norm.series[0].pointAt(0);
    expect(Object.keys(point)).toEqual(['index', 'xValue', 'y', 'raw', 'base', 'top', 'name', 'size']);
    expect(point).toMatchObject({ index: 0, xValue: 10, y: 1, base: 0, top: 1 });
  });

  it('sees the in-place edits done after buildPoints（堆叠基线 / 轴类目回填）', () => {
    const norm = normalizeOption({
      xAxis: { type: 'category', data: ['一', '二', '三'] },
      series: [
        { id: 'a', type: 'bar', stack: 's', data: [1, 2, 3] },
        { id: 'b', type: 'bar', stack: 's', data: [10, 20, 30] },
      ],
    });
    const [a, b] = norm.series;
    expect(a.pointAt(1).xValue).toBe('二');
    expect(b.pointAt(1)).toMatchObject({ base: 2, top: 22 });
    // 无论中间被改过多少次，读点仍然是 points 里那一个对象
    expect(b.pointAt(1)).toBe(b.points[1]);
  });
});
