import { LineSeries } from '../../src/components/series/LineSeries';
import { AreaSeries } from '../../src/components/series/AreaSeries';
import { LinearScale } from '../../src/scale/LinearScale';
import { resolveChartTheme } from '../../src/theme/chartTheme';
import { normalizeOption } from '../../src/option/normalize';
import type { SeriesCoord } from '../../src/components/series/SeriesBase';

/**
 * 列存（虚拟）折线 / 面积：与散点共用基类的虚拟内核（窗口二分 + 现算像素），
 * 差异只在「窗口怎么压缩成折线」—— 按像素列分桶保留首 / 最低 / 最高 / 末，
 * 于是尖峰不会被采样吃掉（这是折线的底线：丢掉极值就是撒谎）。
 */
function mountVirtual(type: 'line' | 'area', count: number): { component: any; coord: SeriesCoord } {
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    x[i] = i / (count - 1);
    // 每 1000 个点埋一个尖峰：抽稀若只看步长采样就会把它吃掉
    y[i] = 50 + Math.sin(i / 37) * 10 + (i % 1000 === 500 ? 35 : 0);
  }
  const norm = normalizeOption({
    legend: { show: false },
    animation: { enabled: false },
    series: [{ id: 's', type, virtual: true, data: { x, y } }],
  });
  const coord: SeriesCoord = {
    plot: { x: 0, y: 0, width: 400, height: 300 },
    canvas: { x: 0, y: 0, width: 400, height: 300 },
    xScale: new LinearScale([0, 1], [0, 400]),
    yScale: new LinearScale([0, 100], [300, 0]),
    theme: resolveChartTheme('light'),
  };
  const component: any = new (type === 'area' ? AreaSeries : LineSeries)(norm.series[0], {
    left: 0,
    top: 0,
    width: 400,
    height: 300,
  });
  component.setCoord(coord);
  return { component, coord };
}

describe('虚拟（列存）折线 / 面积', () => {
  it('不建像素缓存，也不建有效值缓存', () => {
    const { component } = mountVirtual('line', 50000);
    expect(component.revealedPointCount()).toBeGreaterThan(0);
    expect(component.pixels.length).toBe(0);
    expect(component.effective.length).toBe(0);
  });

  it('小窗口逐点画（与普通折线同语义）', () => {
    const { component } = mountVirtual('line', 500);
    // 500 点 < 4096 → stride = 1：每个点都在
    expect(component.revealedPointCount()).toBe(500);
  });

  it('大窗口按像素列压缩，但尖峰仍在（每列保留最低 / 最高）', () => {
    const { component } = mountVirtual('line', 100000);
    const count = component.revealedPointCount();
    expect(count).toBeGreaterThan(0);
    // 上界：每像素列最多 4 个点
    expect(count).toBeLessThanOrEqual(400 * 4 + 4);
    const ys = component.renderPoints().map((p: [number, number]) => p[1]);
    // 埋的尖峰（y ≈ 85）必须还在最上方附近：不能只剩稀薄的平均线
    const minY = Math.min(...ys);
    expect(minY).toBeLessThan(60);
  });

  it('命中：折线上命中、远处不命中，且不依赖像素缓存', () => {
    const { component } = mountVirtual('line', 100000);
    const pixel = component.pixelAt(50000);
    expect(pixel).not.toBeNull();
    expect(component.hitTestIndex(pixel[0], pixel[1])).toBeGreaterThanOrEqual(0);
    expect(component.hitTestIndex(pixel[0], 5)).toBe(-1);
    expect(component.pixels.length).toBe(0);
  });

  it('面积：基线落在 0（列存不支持堆叠）', () => {
    const { component, coord } = mountVirtual('area', 100000);
    const baseline = (component as any).baselineYForIndex(0);
    expect(baseline).toBeCloseTo(coord.yScale.map(0), 6);
  });
});
