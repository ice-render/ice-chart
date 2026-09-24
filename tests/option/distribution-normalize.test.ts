import { normalizeOption } from '../../src/option/normalize';
import type { ChartOption } from '../../src/types';

const VIOLIN: ChartOption = {
  xAxis: { type: 'category', data: ['A', 'B'] },
  series: [
    {
      id: 'v',
      type: 'violin',
      name: '分布',
      data: [
        [1, 2, 3, 4, 5],
        [10, 11, 12],
      ],
    },
  ],
};

describe('violin 归一化', () => {
  it('每组观测算出一条密度曲线，锚点取中位数', () => {
    const norm = normalizeOption(VIOLIN);
    const series = norm.series[0];
    expect(series.pointCount).toBe(2);
    const point = series.pointAt(0);
    expect(point.violin?.values).toEqual([1, 2, 3, 4, 5]);
    expect(point.violin?.grid.length).toBeGreaterThan(16);
    expect(point.violin?.density).toHaveLength(point.violin?.grid.length as number);
    expect(point.violin?.bandwidth).toBeGreaterThan(0);
    // 值锚点与箱线图同规格：中位数（提示框 / 键盘导航都读它）
    expect(point.y).toBe(3);
    expect(point.violin?.summary).toEqual([1, 2, 3, 4, 5]);
  });

  it('把观测值的极值带进 y 数据域', () => {
    const norm = normalizeOption(VIOLIN);
    expect(norm.yAxes[0].domain[0]).toBeLessThanOrEqual(1);
    expect(norm.yAxes[0].domain[1]).toBeGreaterThanOrEqual(12);
  });

  it('数值 x 也自动落成类目轴（分组语义，与柱状 / 箱线一致）', () => {
    const norm = normalizeOption({ series: [{ type: 'violin', data: [[1, 2, 3], [4, 5, 6]] }] });
    expect(norm.xAxis.type).toBe('category');
  });

  it('支持 { name, values } 具名分组', () => {
    const norm = normalizeOption({
      series: [
        {
          type: 'violin',
          data: [
            { name: '甲组', values: [1, 2, 3] },
            { name: '乙组', values: [4, 5, 6] },
          ],
        } as any,
      ],
    });
    expect(norm.series[0].pointAt(0).name).toBe('甲组');
    expect(norm.series[0].pointAt(1).xValue).toBe('乙组');
  });

  it('坏数据不让图表崩：空组退化成分位数为 0 的空曲线', () => {
    const norm = normalizeOption({
      series: [{ type: 'violin', data: [[], null as any, [1, 2, 3]] }],
    });
    const series = norm.series[0];
    expect(series.pointCount).toBe(3);
    expect(series.pointAt(0).violin?.values).toEqual([]);
    expect(series.pointAt(1).violin?.summary).toEqual([0, 0, 0, 0, 0]);
    expect(series.pointAt(2).violin?.values).toEqual([1, 2, 3]);
  });
});

describe('beeswarm 归一化', () => {
  it('逐点解析 [x, y]，x 就是分组', () => {
    const norm = normalizeOption({
      xAxis: { type: 'category', data: ['A', 'B'] },
      series: [
        {
          type: 'beeswarm',
          data: [
            ['A', 1],
            ['A', 2],
            ['B', 3],
          ],
        },
      ],
    });
    const series = norm.series[0];
    expect(series.pointCount).toBe(3);
    expect(series.pointAt(0).xValue).toBe('A');
    expect(series.pointAt(0).y).toBe(1);
    expect(series.pointAt(2).y).toBe(3);
  });

  it('数值 x 也自动落成类目轴（点按类目成组避让）', () => {
    const norm = normalizeOption({
      series: [
        {
          type: 'beeswarm',
          data: [
            [1, 5],
            [1, 7],
            [2, 9],
          ],
        },
      ],
    });
    expect(norm.xAxis.type).toBe('category');
    expect(norm.series[0].pointCount).toBe(3);
  });
});
