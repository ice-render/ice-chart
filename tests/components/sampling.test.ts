import { LineSeries } from '../../src/components/series/LineSeries';
import { ScatterSeries } from '../../src/components/series/ScatterSeries';
import { lttbIndices } from '../../src/components/series/SeriesBase';
import { LinearScale } from '../../src/scale/LinearScale';
import { resolveChartTheme } from '../../src/theme/chartTheme';
import { arrayAccessors } from '../../src/internal';
import type { DataPoint, InternalSeries } from '../../src/internal';
import type { SeriesCoord } from '../../src/components/series/SeriesBase';

function makeSeries(type: any, values: number[], extra: any = {}): InternalSeries {
  const points: DataPoint[] = values.map((y, i) => ({ index: i, xValue: i, y, raw: y, base: 0, top: y }));
  return {
    id: 's',
    index: 0,
    type,
    name: 'S',
    color: '#3B82F6',
    option: { type, data: values, ...extra },
    points,
    pointCount: points.length,
    ...arrayAccessors(points),
    hasExplicitX: false,
    hidden: false,
    axisIndex: 0,
  };
}

function coordFor(width: number, height: number, xMax: number, yMax: number): SeriesCoord {
  return {
    plot: { x: 0, y: 0, width, height },
    canvas: { x: 0, y: 0, width, height },
    xScale: new LinearScale([0, xMax], [0, width]),
    yScale: new LinearScale([0, yMax], [height, 0]),
    theme: resolveChartTheme('light'),
  };
}

describe('LTTB 抽稀', () => {
  it('keeps the first and last point and hits the threshold', () => {
    const n = 1000;
    const pixels = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      pixels[i * 2] = i;
      pixels[i * 2 + 1] = Math.sin(i / 20) * 100;
    }
    const indices = lttbIndices(pixels, n, 100);
    expect(indices).toHaveLength(100);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(n - 1);
  });

  it('preserves a spike instead of flattening it', () => {
    const n = 2000;
    const pixels = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      pixels[i * 2] = i;
      pixels[i * 2 + 1] = i === 1234 ? 1000 : 10;
    }
    const indices = lttbIndices(pixels, n, 80);
    expect(indices).toContain(1234);
  });

  it('returns every index when the threshold is larger than the data', () => {
    const n = 10;
    const pixels = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      pixels[i * 2] = i;
      pixels[i * 2 + 1] = i;
    }
    expect(lttbIndices(pixels, n, 50)).toHaveLength(n);
  });
});

describe('系列降采样', () => {
  it('decimates a large line series to about two points per pixel', () => {
    const values = Array.from({ length: 20000 }, (_, i) => Math.sin(i / 100) * 50 + 50 + (i % 7 === 0 ? 30 : 0));
    const series = makeSeries('line', values);
    const component: any = new LineSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord(coordFor(400, 300, values.length - 1, 100));
    component.rebuildPixels();
    expect(component.renderIndices).not.toBeNull();
    expect(component.renderIndices.length).toBeLessThanOrEqual(800);
    // 首尾点必须保留
    expect(component.renderIndices[0]).toBe(0);
    expect(component.renderIndices[component.renderIndices.length - 1]).toBe(values.length - 1);
  });

  it('keeps every point when sampling is off or the data is small', () => {
    const values = Array.from({ length: 20000 }, (_, i) => i % 100);
    const off: any = new LineSeries(makeSeries('line', values, { sampling: 'none' }), { left: 0, top: 0, width: 400, height: 300 });
    off.setCoord(coordFor(400, 300, values.length - 1, 100));
    off.rebuildPixels();
    expect(off.renderIndices).toBeNull();

    const small: any = new LineSeries(makeSeries('line', [1, 2, 3, 4]), { left: 0, top: 0, width: 400, height: 300 });
    small.setCoord(coordFor(400, 300, 3, 10));
    small.rebuildPixels();
    expect(small.renderIndices).toBeNull();
  });

  it('never decimates scatter series (each dot is the graphic)', () => {
    const values = Array.from({ length: 20000 }, (_, i) => i % 50);
    const series = makeSeries('scatter', values);
    const component: any = new ScatterSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord(coordFor(400, 300, values.length - 1, 60));
    component.rebuildPixels();
    expect(component.renderIndices).toBeNull();
  });

  it('keeps full-resolution pixel cache for hit testing', () => {
    const values = Array.from({ length: 5000 }, (_, i) => (i * 37) % 100);
    const series = makeSeries('line', values);
    const component: any = new LineSeries(series, { left: 0, top: 0, width: 300, height: 200 });
    component.setCoord(coordFor(300, 200, values.length - 1, 100));
    component.rebuildPixels();
    expect(component.pixels.length).toBe(values.length * 2);
    // 任一原始数据点都有精确像素位置
    expect(component.pixelAt(4321)).not.toBeNull();
  });
});

describe('按 x 找最近点（二分）', () => {
  function buildComponent(n: number): any {
    const values = Array.from({ length: n }, (_, i) => (i * 13) % 90);
    const series = makeSeries('line', values);
    const component: any = new LineSeries(series, { left: 0, top: 0, width: n / 4, height: 200 });
    component.setCoord(coordFor(n / 4, 200, n - 1, 90));
    component.rebuildPixels();
    return component;
  }

  it('agrees with a linear scan on sorted data', () => {
    const component = buildComponent(5000);
    for (const x of [0, 12.5, 100.2, 555.7, 1234]) {
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < 5000; i++) {
        const dist = Math.abs(component.pixels[i * 2] - x);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      expect(component.nearestIndexAtX(x)).toBe(best);
    }
  });

  it('falls back to a linear scan when x is not monotonic', () => {
    const values = [10, 20, 30];
    const series = makeSeries('line', values);
    const component: any = new LineSeries(series, { left: 0, top: 0, width: 300, height: 200 });
    // 手工造一个非单调的 x（例如时间倒序的数据）
    series.points[0].xValue = 2;
    series.points[1].xValue = 1;
    series.points[2].xValue = 0;
    component.setCoord(coordFor(300, 200, 2, 40));
    component.rebuildPixels();
    expect(component.xMonotonic).toBe(false);
    const index = component.nearestIndexAtX(300);
    expect(index).toBeGreaterThanOrEqual(0);
  });
});
