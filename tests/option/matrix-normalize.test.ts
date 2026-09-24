import { normalizeOption } from '../../src/option/normalize';

describe('matrix 归一化', () => {
  it('把 option.matrix 归一化到 norm.matrix，并把越界 panel 夹回合法范围', () => {
    const norm = normalizeOption({
      matrix: { rows: 2, columns: 2 },
      series: [
        { type: 'line', data: [1, 2, 3], panel: 3 },
        { type: 'line', data: [3, 2, 1], panel: -5 },
        { type: 'line', data: [2, 2, 2] },
      ],
    });
    expect(norm.matrix!.panelCount).toBe(4);
    expect(norm.matrix!.rows).toEqual([1, 1]);
    expect(norm.matrix!.gap).toBe(8);
    expect(norm.series.map((s) => s.panel)).toEqual([3, 0, 0]);
  });

  it('越界的大数字也夹回最后一个面板', () => {
    const norm = normalizeOption({
      matrix: { rows: 1, columns: 2 },
      series: [{ type: 'line', data: [1, 2, 3], panel: 99 }],
    });
    expect(norm.series[0].panel).toBe(1);
  });

  it('不给 matrix 时 norm.matrix 为 null，series.panel 恒为 0', () => {
    const norm = normalizeOption({ series: [{ type: 'line', data: [1, 2, 3], panel: 2 }] });
    expect(norm.matrix).toBeNull();
    expect(norm.series[0].panel).toBe(0);
  });

  it('非整数 / 非数字的 panel 按 0 处理', () => {
    const norm = normalizeOption({
      matrix: { rows: 1, columns: 3 },
      series: [
        { type: 'line', data: [1, 2, 3], panel: 1.7 },
        { type: 'line', data: [1, 2, 3], panel: 'x' as any },
      ],
    });
    expect(norm.series.map((s) => s.panel)).toEqual([1, 0]);
  });
});
