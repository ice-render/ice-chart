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

describe('虚拟（列存）系列（scatter）', () => {
  const virtualScatter = (extra: any = {}): any => ({
    id: 's',
    type: 'scatter',
    virtual: true,
    data: [
      [0, 1],
      [1, 3],
      [2, null],
      [3, 7],
    ],
    ...extra,
  });

  it('只建列：points 为空、数量对、访问器按需合成', () => {
    const norm = normalizeOption({ series: [virtualScatter()] });
    const series = norm.series[0];
    expect(series.virtual).toBe(true);
    expect(series.points).toEqual([]);
    expect(series.pointCount).toBe(4);
    expect(series.pointAt(1)).toMatchObject({ index: 1, xValue: 1, y: 3, base: 0, top: 3 });
    // 断点在列里是 NaN，读出来仍然是 null（与普通系列同语义）
    expect(series.pointAt(2).y).toBeNull();
    expect(series.yValueAt(2)).toBeNull();
    expect(series.topAt(2)).toBe(0);
    expect(series.xValueAt(3)).toBe(3);
    // 数据域是建列那一趟算好的
    expect(series.columns!.yDomain).toEqual([1, 7]);
    expect(series.columns!.xDomain).toEqual([0, 3]);
    expect(norm.xAxis.type).toBe('linear');
    expect(norm.yAxis.domain[1]).toBeGreaterThanOrEqual(7);
  });

  it('归一化之后释放原始 data（图表不再持有百万级输入）', () => {
    const option: any = { series: [virtualScatter()] };
    normalizeOption(option);
    expect(option.series[0].data).toBeUndefined();
    expect(option.series[0].virtual).toBe(true);
  });

  it('列式输入直接采用（Float64Array 不复制）', () => {
    const x = new Float64Array([0, 1, 2]);
    const y = new Float64Array([1, 2, 3]);
    const norm = normalizeOption({ series: [{ id: 's', type: 'scatter', virtual: true, data: { x, y } }] });
    expect(norm.series[0].columns!.x).toBe(x);
    expect(norm.series[0].columns!.y).toBe(y);
    expect(norm.series[0].pointCount).toBe(3);
  });

  it('第三维进 size 列（气泡图）', () => {
    const norm = normalizeOption({
      series: [
        virtualScatter({
          data: [
            [0, 1, 5],
            [1, 2, 9],
          ],
        }),
      ],
    });
    expect(norm.series[0].columns!.sizeExtent).toEqual([5, 9]);
    expect(norm.series[0].sizeAt(1)).toBe(9);
    expect(norm.series[0].sizeAt(0)).toBe(5);
  });

  it('非法用法显式报错（类型 / 类目轴 / 非数值 x / 堆叠）', () => {
    expect(() => normalizeOption({ xAxis: { type: 'category' }, series: [virtualScatter()] })).toThrow(/数值型 x 轴/);
    expect(() => normalizeOption({ series: [virtualScatter({ data: [['a', 1]] })] })).toThrow(/数值型 x/);
    expect(() => normalizeOption({ series: [virtualScatter({ stack: 'g' })] })).toThrow(/堆叠/);
    expect(() => normalizeOption({ series: [{ id: 's', type: 'scatter', virtual: true }] })).toThrow(/需要 data/);
  });

  describe('惰性原始点（自定义系列 / 非数值列类型）', () => {
    const rows = [
      { x: 'D1', o: 100, c: 110, l: 95, h: 115 },
      { x: 'D2', o: 110, c: 105, l: 100, h: 118 },
    ];

    it('保留原始数据、不建 DataPoint：字段与普通系列逐字一致', () => {
      const option: any = { xAxis: { type: 'category' }, series: [{ id: 'k', type: 'bar', virtual: true, data: rows }] };
      const norm = normalizeOption(option);
      const series = norm.series[0];
      expect(series.virtual).toBe(true);
      expect(series.points).toEqual([]);
      expect(series.pointCount).toBe(2);
      expect(series.raw!.length).toBe(2);
      // 原始数据**不释放**（它是存储本身）：提示框的 params.data 仍然给得出来
      expect(option.series[0].data).toBe(rows);
      const lazy = series.pointAt(1);
      expect(lazy).toMatchObject({ index: 1, xValue: 'D2', y: null, name: undefined });
      expect(lazy.raw).toBe(rows[1]);
      // 普通系列同一条数据：合成出来的字段应当逐字一致（同一个 readGenericPoint）
      const plain = normalizeOption({ xAxis: { type: 'category' }, series: [{ id: 'k', type: 'bar', data: rows }] })
        .series[0]
        .pointAt(1);
      expect({ ...lazy, raw: undefined, index: lazy.index }).toEqual({ ...plain, raw: undefined, index: plain.index });
    });

    it('数值型 x / y 一样算域与单调性；yField 决定 y', () => {
      const norm = normalizeOption({
        series: [
          {
            id: 'k',
            type: 'bar',
            virtual: true,
            yField: 'c',
            data: [
              [1, 10],
              [2, 20],
              [3, 30],
            ],
          },
        ],
      } as any);
      const series = norm.series[0];
      expect(series.raw!.xDomain).toEqual([1, 3]);
      expect(series.raw!.yDomain).toEqual([10, 30]);
      expect(series.raw!.xMonotonic).toBe(true);
      expect(series.pointAt(2).y).toBe(30);
    });

    it('类目 x 不算数值域、也不声称单调（数值域留给类目轴自己）', () => {
      const norm = normalizeOption({ xAxis: { type: 'category' }, series: [{ id: 'k', type: 'bar', virtual: true, data: rows }] } as any);
      expect(norm.series[0].raw!.xMonotonic).toBe(false);
      expect(norm.categories).toEqual(['D1', 'D2']);
    });

    it('数据在 option 里，所以**照旧能进快照**（与数值列系列的取舍相反）', () => {
      const option: any = { xAxis: { type: 'category' }, series: [{ id: 'k', type: 'bar', virtual: true, data: rows }] };
      const norm = normalizeOption(option);
      expect(norm.series[0].pointCount).toBe(2);
      // 普通（非 ring）形态下 data 还在，快照自然带上它
      expect(option.series[0].data).toBe(rows);
    });
  });

  it('热力图：元组输入落成稠密矩阵（类目顺序即行列顺序）', () => {
    const norm = normalizeOption({
      xAxis: { type: 'category' },
      yAxis: { type: 'category' },
      series: [
        {
          id: 'h',
          type: 'heatmap',
          virtual: true,
          data: [
            ['周一', '上午', 10],
            ['周二', '上午', 20],
            ['周一', '下午', 30],
          ],
        },
      ],
    });
    const series = norm.series[0];
    expect(series.virtual).toBe(true);
    expect(series.points).toEqual([]);
    expect(series.grid!.xCategories).toEqual(['周一', '周二']);
    expect(series.grid!.yCategories).toEqual(['上午', '下午']);
    // 行优先：2 行 × 2 列 = 4 格，缺的那格是 NaN（没有值）
    expect(series.pointCount).toBe(4);
    expect(Array.from(series.grid!.values, (v) => (Number.isNaN(v) ? null : v))).toEqual([10, 20, 30, null]);
    expect(series.grid!.valueDomain).toEqual([10, 30]);
    // 访问器与普通热力图的 DataPoint 语义一致：xValue 是列类目、name 是行类目
    expect(series.pointAt(0)).toMatchObject({ xValue: '周一', name: '上午', y: 10 });
    expect(series.pointAt(3).y).toBeNull();
    expect(norm.categories).toEqual(['周一', '周二']);
    expect(norm.yAxis.domain).toEqual(['上午', '下午']);
  });

  it('热力图：矩阵输入直接采用 value 数组（不复制）', () => {
    const values = new Float64Array([1, 2, 3, 4, 5, 6]);
    const norm = normalizeOption({
      xAxis: { type: 'category' },
      yAxis: { type: 'category' },
      series: [
        {
          id: 'h',
          type: 'heatmap',
          virtual: true,
          data: { xCategories: ['a', 'b', 'c'], yCategories: ['r1', 'r2'], values },
        },
      ],
    });
    expect(norm.series[0].grid!.values).toBe(values);
    expect(norm.series[0].pointCount).toBe(6);
    expect(norm.series[0].pointAt(4)).toMatchObject({ xValue: 'b', name: 'r2', y: 5 });
  });

  it('热力图：稀疏 / 尺寸不符 / 轴类型不对都显式报错', () => {
    // 10 × 10 的类目却只给了 20 格 → 密度 0.2，低于 0.25
    const sparseTuples: any[] = [];
    for (let c = 0; c < 10; c++) {
      sparseTuples.push([`c${c}`, `r${c}`, c]);
      sparseTuples.push([`c${c}`, `r${(c + 3) % 10}`, c + 1]);
    }
    const okGrid = { xCategories: ['a', 'b'], yCategories: ['x', 'y'], values: new Float64Array(4) };
    expect(() =>
      normalizeOption({
        xAxis: { type: 'category' },
        yAxis: { type: 'category' },
        series: [{ type: 'heatmap', virtual: true, data: sparseTuples }],
      })
    ).toThrow(/太稀疏/);
    expect(() =>
      normalizeOption({
        xAxis: { type: 'category' },
        yAxis: { type: 'category' },
        series: [
          {
            type: 'heatmap',
            virtual: true,
            data: { xCategories: ['a', 'b'], yCategories: ['x'], values: new Float64Array(5) },
          },
        ],
      })
    ).toThrow(/values 长度/);
    expect(() =>
      normalizeOption({
        xAxis: { type: 'linear' },
        yAxis: { type: 'category' },
        series: [{ type: 'heatmap', virtual: true, data: { ...okGrid } }],
      })
    ).toThrow(/x 轴必须是类目轴/);
    expect(() =>
      normalizeOption({
        xAxis: { type: 'category' },
        yAxis: { type: 'linear' },
        series: [{ type: 'heatmap', virtual: true, data: { ...okGrid } }],
      })
    ).toThrow(/y 轴必须是类目轴/);
  });

  it('折线 / 面积同样能开列存（面积仍然带 0 基线）', () => {
    const line = normalizeOption({
      series: [
        { id: 'l', type: 'line', virtual: true, data: { x: new Float64Array([0, 1, 2]), y: new Float64Array([1, 2, 3]) } },
      ],
    });
    expect(line.series[0].virtual).toBe(true);
    expect(line.series[0].points).toEqual([]);
    expect(line.series[0].pointCount).toBe(3);
    expect(line.yAxis.domain[0]).toBeGreaterThan(0);

    const area = normalizeOption({ series: [{ id: 'a', type: 'area', virtual: true, data: [5, 6, 7] }] });
    expect(area.series[0].virtual).toBe(true);
    expect(area.series[0].pointCount).toBe(3);
    // 面积图的 y 域含 0（与普通面积系列同一条规则）
    expect(area.yAxis.domain[0]).toBe(0);
  });
});
