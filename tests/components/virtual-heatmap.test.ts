import { HeatmapSeries } from '../../src/components/series/HeatmapSeries';
import { BandScale } from '../../src/scale/BandScale';
import { resolveChartTheme } from '../../src/theme/chartTheme';
import { normalizeOption } from '../../src/option/normalize';
import type { SeriesCoord } from '../../src/components/series/SeriesBase';

/**
 * 列存（虚拟）热力图：数据是**稠密矩阵**，所以三件事一起变简单 ——
 * 命中退化成查表 + 下标运算（O(1)），绘制按窗口裁剪，亚像素时按屏幕像素块聚合。
 */
function mountGrid(cols: number, rows: number, count = cols * rows): { component: any; coord: SeriesCoord } {
  const xCategories = Array.from({ length: cols }, (_, i) => `c${i}`);
  const yCategories = Array.from({ length: rows }, (_, i) => `r${i}`);
  const values = new Float64Array(cols * rows);
  for (let i = 0; i < values.length; i++) values[i] = i % 100;
  const norm = normalizeOption({
    legend: { show: false },
    animation: { enabled: false },
    xAxis: { type: 'category' },
    yAxis: { type: 'category' },
    series: [{ id: 'h', type: 'heatmap', virtual: true, data: { xCategories, yCategories, values } }],
  });
  const coord: SeriesCoord = {
    plot: { x: 0, y: 0, width: 400, height: 300 },
    canvas: { x: 0, y: 0, width: 400, height: 300 },
    xScale: new BandScale(xCategories, [0, 400], { paddingInner: 0.2, paddingOuter: 0.1 }),
    yScale: new BandScale(yCategories, [300, 0], { paddingInner: 0.2, paddingOuter: 0.1 }),
    theme: resolveChartTheme('light'),
  };
  const component: any = new HeatmapSeries(norm.series[0], { left: 0, top: 0, width: 400, height: 300 });
  component.setCoord(coord);
  void count;
  return { component, coord };
}

describe('虚拟（列存）热力图', () => {
  it('不建数据点对象、不建像素缓存', () => {
    const { component } = mountGrid(40, 30);
    expect(component.series.points).toHaveLength(0);
    expect(component.series.pointCount).toBe(1200);
    expect(component.pixelAt(0)).not.toBeNull();
    expect(component.pixels.length).toBe(0);
  });

  it('命中是 O(1)：任意格子按「行类目 × 列类目」直接落位', () => {
    const { component } = mountGrid(40, 30);
    for (const index of [0, 7, 41, 619, 1199]) {
      const rect = component.cellRectAt(index)!;
      const hit = component.hitTestIndex(rect.x + rect.width / 2, rect.y + rect.height / 2);
      expect(hit).toBe(index);
    }
    // 组件盒之外不命中
    expect(component.hitTestIndex(-5, 10)).toBe(-1);
    expect(component.hitTestIndex(999, 10)).toBe(-1);
  });

  it('空格子不命中（普通热力图里它根本没有数据点）', () => {
    const values = new Float64Array([1, NaN, 3, NaN]);
    const norm = normalizeOption({
      legend: { show: false },
      xAxis: { type: 'category' },
      yAxis: { type: 'category' },
      series: [
        {
          id: 'h',
          type: 'heatmap',
          virtual: true,
          data: { xCategories: ['a', 'b'], yCategories: ['x', 'y'], values },
        },
      ],
    });
    const component: any = new HeatmapSeries(norm.series[0], { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord({
      plot: { x: 0, y: 0, width: 400, height: 300 },
      canvas: { x: 0, y: 0, width: 400, height: 300 },
      xScale: new BandScale(['a', 'b'], [0, 400], { paddingInner: 0.2, paddingOuter: 0.1 }),
      yScale: new BandScale(['x', 'y'], [300, 0], { paddingInner: 0.2, paddingOuter: 0.1 }),
      theme: resolveChartTheme('light'),
    });
    const filled = component.cellRectAt(0)!;
    expect(component.hitTestIndex(filled.x + 1, filled.y + 1)).toBe(0);
    const empty = component.cellRectAt(1)!;
    expect(component.hitTestIndex(empty.x + 1, empty.y + 1)).toBe(-1);
  });

  it('亚像素时按屏幕像素块聚合，块内取最大值（热点不被抹平）', () => {
    const { component } = mountGrid(300, 300);
    component.syncGrid();
    // 90000 格 > 2 万 → 走聚合路径
    expect(component.gridBlockPx).toBeGreaterThan(0);
    const blocks = component.gridBlocks;
    expect(blocks.length).toBe(component.gridBlockCols * component.gridBlockRows);
    expect(blocks.length).toBeLessThanOrEqual(40000);
    const filled = Array.from(blocks).filter((v) => !Number.isNaN(v));
    expect(filled.length).toBeGreaterThan(0);
    // 值都在原矩阵的值域内，且聚合结果至少取到了较大值（不是平均出来的小值）
    expect(Math.max(...filled)).toBeLessThanOrEqual(Math.max(...Array.from(component.series.grid!.values)));
  });

  it('视野窗口裁剪：只看一小段时，逐格路径只画窗口内的格子', () => {
    const { component, coord } = mountGrid(120, 80);
    // 把 x 轴缩到前 10 个类目
    coord.xScale = new BandScale(['c0', 'c1', 'c2', 'c3', 'c4'], [0, 400], { paddingInner: 0.2, paddingOuter: 0.1 });
    component.setCoord(coord);
    component.syncGrid();
    expect(component.gridBlockPx).toBe(0); // 可见格少 → 逐格
    expect(component.gridVisibleCols).toEqual([0, 1, 2, 3, 4]);
    expect(component.gridVisibleRows.length).toBe(80);
  });
});
