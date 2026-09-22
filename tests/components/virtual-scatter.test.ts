import { ScatterSeries } from '../../src/components/series/ScatterSeries';
import { LinearScale } from '../../src/scale/LinearScale';
import { resolveChartTheme } from '../../src/theme/chartTheme';
import { normalizeOption } from '../../src/option/normalize';
import type { SeriesCoord } from '../../src/components/series/SeriesBase';

/**
 * 列存（虚拟）散点：**不物化任何按点缓存**，像素与命中都从列现算。
 *
 * 这条路径不能用「像素缓存唯一」那把尺子量（它是那条铁律的例外，理由见 ScatterSeries），
 * 所以这里专门盯三件事：缓存确实是空的、现算的像素与比例尺一致、最近邻与命中仍然准。
 */
function mountVirtual(values: any[], extra: any = {}): { component: any; coord: SeriesCoord } {
  const norm = normalizeOption({
    legend: { show: false },
    series: [{ id: 's', type: 'scatter', virtual: true, data: values, ...extra }],
  });
  const coord: SeriesCoord = {
    plot: { x: 0, y: 0, width: 400, height: 300 },
    canvas: { x: 0, y: 0, width: 400, height: 300 },
    xScale: new LinearScale([0, 1], [0, 400]),
    yScale: new LinearScale([0, 100], [300, 0]),
    theme: resolveChartTheme('light'),
  };
  const component: any = new ScatterSeries(norm.series[0], { left: 0, top: 0, width: 400, height: 300 });
  component.setCoord(coord);
  return { component, coord };
}

describe('虚拟（列存）散点的渲染与命中', () => {
  const trio = [
    [0, 10],
    [0.5, 50],
    [1, 90],
  ];

  it('命中与取锚点之后，像素缓存仍然是空的', () => {
    const { component } = mountVirtual(trio);
    expect(component.pixelAt(1)).toEqual([200, 150]);
    component.hitTestIndex(10, 10);
    expect(component.pixels.length).toBe(0);
    expect(component.effective.length).toBe(0);
  });

  it('像素按需现算，与比例尺一致；断点没有像素', () => {
    const { component } = mountVirtual(trio);
    expect(component.pixelAt(0)).toEqual([0, 270]);
    expect(component.pixelAt(1)).toEqual([200, 150]);
    expect(component.pixelAt(2)).toEqual([400, 30]);
    expect(component.pixelAt(3)).toBeNull();
    const broken = mountVirtual([
      [0, 10],
      [0.5, null],
    ]);
    expect(broken.component.pixelAt(1)).toBeNull();
  });

  it('命中：点附近命中该点，远处不命中', () => {
    const { component } = mountVirtual(trio);
    const [px, py] = component.pixelAt(1);
    expect(component.hitTestIndex(px + 2, py - 2)).toBe(1);
    expect(component.hitTestIndex(px + 200, py)).toBe(-1);
  });

  it('最近邻：单调列上二分，结果不比左右邻居远', () => {
    const values: Array<[number, number]> = [];
    for (let i = 0; i < 20000; i++) values.push([i / 20000, (i * 7) % 100]);
    const { component } = mountVirtual(values);
    for (const localX of [0, 1.5, 37, 199.5, 399, 400]) {
      const index = component.nearestIndexAtX(localX);
      expect(index).toBeGreaterThanOrEqual(0);
      const anchor = component.pixelAt(index)![0];
      for (const j of [index - 1, index + 1]) {
        const pixel = component.pixelAt(j);
        if (!pixel) continue;
        expect(Math.abs(anchor - localX)).toBeLessThanOrEqual(Math.abs(pixel[0] - localX) + 1e-9);
      }
    }
  });

  it('尺寸列走 sizeAt（气泡映射），不依赖 points', () => {
    const { component } = mountVirtual([
      [0, 10, 5],
      [0.5, 50, 25],
    ]);
    expect(component.symbolSizeAt(0)).toBe(8);
    expect(component.symbolSizeAt(1)).toBe(40);
  });
});
