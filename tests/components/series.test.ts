import { BandScale } from '../../src/scale/BandScale';
import { LinearScale } from '../../src/scale/LinearScale';
import { resolveChartTheme } from '../../src/theme/chartTheme';
import { LineSeries } from '../../src/components/series/LineSeries';
import { BarSeries } from '../../src/components/series/BarSeries';
import { ScatterSeries } from '../../src/components/series/ScatterSeries';
import { arrayAccessors } from '../../src/internal';
import type { DataPoint, InternalSeries } from '../../src/internal';
import type { SeriesCoord } from '../../src/components/series/SeriesBase';

function points(values: number[]): DataPoint[] {
  return values.map((y, i) => ({ index: i, xValue: i, y, raw: y, base: 0, top: y }));
}

function makeSeries(type: any, values: number[], extra: any = {}): InternalSeries {
  const data = points(values);
  return {
    id: 's',
    index: 0,
    type,
    name: 'S',
    color: '#3B82F6',
    option: { type, data: values, ...extra },
    points: data,
    virtual: false,
    pointCount: data.length,
    ...arrayAccessors(data),
    hasExplicitX: false,
    hidden: false,
  };
}

const plot = { x: 0, y: 0, width: 400, height: 300 };
const theme = resolveChartTheme('light');

function cartesianCoord(): SeriesCoord {
  return {
    plot,
    canvas: { x: 0, y: 0, width: 400, height: 300 },
    xScale: new LinearScale([0, 3], [0, 400]),
    yScale: new LinearScale([0, 100], [300, 0]),
    theme,
  };
}

function bandCoord(): SeriesCoord {
  return {
    plot,
    canvas: { x: 0, y: 0, width: 400, height: 300 },
    xScale: new BandScale(['a', 'b', 'c', 'd'], [0, 400], { paddingInner: 0.2, paddingOuter: 0.1 }),
    yScale: new LinearScale([0, 100], [300, 0]),
    theme,
  };
}

describe('LineSeries 命中判定', () => {
  it('hits a data point by proximity', () => {
    const series = makeSeries('line', [10, 50, 90, 20]);
    const component = new LineSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord(cartesianCoord());
    const pixel = component.pixelAt(1)!;
    expect(component.hitTestIndex(pixel[0], pixel[1])).toBe(1);
    expect(component.hitTestIndex(pixel[0] + 3, pixel[1] + 3)).toBe(1);
  });

  it('hits the polyline between two points (not only the markers)', () => {
    const series = makeSeries('line', [10, 50, 90, 20]);
    const component = new LineSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord(cartesianCoord());
    const a = component.pixelAt(0)!;
    const b = component.pixelAt(1)!;
    const midX = (a[0] + b[0]) / 2;
    const midY = (a[1] + b[1]) / 2 + 2;
    expect(component.hitTestIndex(midX, midY)).toBeGreaterThanOrEqual(0);
  });

  it('misses when far away from the line', () => {
    const series = makeSeries('line', [10, 50, 90, 20]);
    const component = new LineSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord(cartesianCoord());
    expect(component.hitTestIndex(200, 5)).toBe(-1);
  });

  it('breaks the line on null values instead of drawing to zero', () => {
    const series = makeSeries('line', [10, 50, 90, 20]);
    series.points[1].y = null;
    series.points[1].top = null as any;
    const component = new LineSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord(cartesianCoord());
    expect(component.pixelAt(1)).toBeNull();
    expect(component.pixelAt(0)).not.toBeNull();
  });
});

describe('BarSeries 命中与布局', () => {
  it('computes a bar rect per category and hits inside it', () => {
    const series = makeSeries('bar', [30, 60, 90, 20]);
    // 就地改：访问器读的是建系列时那一个 points 数组，**不要重新赋值 series.points**
    series.points.forEach((p, i) => {
      p.xValue = ['a', 'b', 'c', 'd'][i];
    });
    const component = new BarSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord(bandCoord());
    component.barSlot = { index: 0, count: 1 };
    const rect = component.barRectAt(1)!;
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    expect(component.hitTestIndex(rect.x + rect.width / 2, rect.y + rect.height / 2)).toBe(1);
    expect(component.hitTestIndex(rect.x - 10, rect.y + rect.height / 2)).toBe(-1);
  });

  it('splits the band between grouped bars', () => {
    const series = makeSeries('bar', [30, 60, 90, 20]);
    series.points.forEach((p, i) => {
      p.xValue = ['a', 'b', 'c', 'd'][i];
    });
    const component = new BarSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord(bandCoord());
    component.barSlot = { index: 1, count: 3 };
    const rect = component.barRectAt(1)!;
    expect(rect.width).toBeLessThanOrEqual(bandCoord().xScale.bandwidth());
  });
});

describe('BarSeries 逐项配色', () => {
  it('数据项带 color 时按项取色（红涨绿跌 / 告警分级都靠它）', () => {
    const series = makeSeries('bar', [10, 20, 30]);
    series.points.forEach((p, i) => {
      p.raw = { value: p.y as number, color: ['#f04438', '#12b76a', '#f5a524'][i] };
    });
    const component: any = new BarSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord(bandCoord());
    expect(component.barColorAt(0)).toBe('#f04438');
    expect(component.barColorAt(1)).toBe('#12b76a');
    expect(component.barColorAt(2)).toBe('#f5a524');
  });

  it('数据项没有 color 时回落系列色', () => {
    const series = makeSeries('bar', [10, 20]);
    const component: any = new BarSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord(bandCoord());
    expect(component.barColorAt(0)).toBe('#3B82F6');
  });
});

describe('ScatterSeries 命中判定', () => {
  it('hits by symbol radius', () => {
    const series = makeSeries('scatter', [10, 50, 90, 20], { symbolSize: 16 });
    const component = new ScatterSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord(cartesianCoord());
    const pixel = component.pixelAt(2)!;
    expect(component.hitTestIndex(pixel[0], pixel[1])).toBe(2);
    expect(component.hitTestIndex(pixel[0] + 20, pixel[1])).toBe(-1);
  });
});
