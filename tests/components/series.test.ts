import { BandScale } from '../../src/scale/BandScale';
import { LinearScale } from '../../src/scale/LinearScale';
import { resolveChartTheme } from '../../src/theme/chartTheme';
import { normalizeOption } from '../../src/option/normalize';
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

/**
 * 断点（`null`）= **没有数据**，不是「等于 0」。
 *
 * 这条曾经在归一化与绘制之间分叉：`null` 的 `top` 是 0，于是折线在断点处被画到 0
 * （实测像素落在绘图区下方 91px），而命中 / 提示框按 `y === null` 判空 ——
 * 同一份数据，两处语义不一致。现在统一成：断点 → 像素 NaN → 绘制抬笔。
 */
describe('折线断点（null = 没有数据）', () => {
  const mount = (data: any): any => {
    const norm = normalizeOption({ xAxis: { type: 'category' }, yAxis: {}, series: [{ id: 'a', type: 'line', data }] });
    const component: any = new LineSeries(norm.series[0], { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord({
      plot: { x: 0, y: 0, width: 400, height: 300 },
      canvas: { x: 0, y: 0, width: 400, height: 300 },
      xScale: new BandScale(norm.categories, [0, 400], { paddingInner: 0.2, paddingOuter: 0.1 }),
      yScale: new LinearScale([0, 30], [300, 0]),
      theme: resolveChartTheme('light'),
    });
    return component;
  };

  it('断点没有像素（不会被画到 0）', () => {
    const component = mount([10, null, 30]);
    expect(component.series.pointAt(1).y).toBeNull();
    expect(component.pixelAt(1)).toBeNull();
    expect(component.pixelAt(0)).not.toBeNull();
    expect(component.pixelAt(2)).not.toBeNull();
  });

  it('绘制序列在断点处抬笔（与函数曲线的 NaN 分段同一条规则）', () => {
    const component = mount([10, null, 30]);
    const sequence = component.renderSequence();
    expect(sequence.pts.filter((p: any) => p === null)).toHaveLength(1);
    // 断点不占「绘制点」的位置，但它两侧的点各自记住了原始下标
    expect(sequence.indices).toEqual([0, -1, 2]);
  });

  it('列存（虚拟）折线同样按断点抬笔', () => {
    const norm = normalizeOption({
      xAxis: { type: 'linear' },
      yAxis: {},
      series: [{ id: 'a', type: 'line', virtual: true, data: { x: new Float64Array([0, 1, 2]), y: new Float64Array([10, NaN, 30]) } }],
    });
    const component: any = new LineSeries(norm.series[0], { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord({
      plot: { x: 0, y: 0, width: 400, height: 300 },
      canvas: { x: 0, y: 0, width: 400, height: 300 },
      xScale: new LinearScale([0, 2], [0, 400]),
      yScale: new LinearScale([0, 30], [300, 0]),
      theme: resolveChartTheme('light'),
    });
    const sequence = component.renderSequence();
    expect(sequence.pts.filter((p: any) => p === null)).toHaveLength(1);
    expect(component.pixelAt(1)).toBeNull();
  });

  /**
   * 类目轴上的虚拟折线（惰性原始点，2026-09-24）：
   * 「均线挂在时间类目上」这种形状也能开 `virtual` —— 不建 `DataPoint`、**也不建逐点像素缓存**，
   * 绘制走「每像素列抽样」那条路。这是 1M 根窗口里派生折线最大的两块开销。
   */
  it('虚拟折线（类目 x）绘制不物化像素缓存，但照常画出来', () => {
    const norm = normalizeOption({
      xAxis: { type: 'category' },
      yAxis: {},
      series: [{ id: 'ma', type: 'line', virtual: true, data: [['a', 10], ['b', 12], ['c', null], ['d', 9]] }],
    } as any);
    const series: any = norm.series[0];
    // 类目 x 退回惰性原始点
    expect(series.raw).toBeTruthy();
    const component: any = new LineSeries(series, { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord({
      plot: { x: 0, y: 0, width: 400, height: 300 },
      canvas: { x: 0, y: 0, width: 400, height: 300 },
      xScale: new BandScale(norm.xAxis.domain, [0, 400], { paddingInner: 0.2, paddingOuter: 0.1 }),
      yScale: new LinearScale([0, 20], [300, 0]),
      theme: resolveChartTheme('light'),
    });
    const sequence = component.renderSequence();
    expect(sequence.pts.length).toBeGreaterThan(0);
    // 虚拟折线不建逐点像素缓存
    expect(component.pixels.length).toBe(0);
    // 断点仍然抬笔（列里的 null 读出来还是 null）
    expect(sequence.pts.filter((p: any) => p === null).length).toBe(1);
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
  const denseCoord = (count: number): SeriesCoord => ({
    plot,
    canvas: { x: 0, y: 0, width: 400, height: 300 },
    xScale: new BandScale(
      Array.from({ length: count }, (_, i) => `c${i}`),
      [0, 400],
      { paddingInner: 0.2, paddingOuter: 0.1 }
    ),
    yScale: new LinearScale([0, 100], [300, 0]),
    theme,
  });

  const denseSeries = (values: number[]): InternalSeries => {
    const series = makeSeries('bar', values);
    series.points.forEach((p, i) => {
      p.xValue = `c${i}`;
    });
    return series;
  };

  const ctxStub = (rects: any[]) => ({
    fillStyle: '',
    fillRect: (x: number, y: number, w: number, h: number) => rects.push({ x, y, w, h }),
    beginPath: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    fill: () => undefined,
    lineJoin: '',
    lineCap: '',
    globalAlpha: 1,
  });

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

  it('一屏柱子数远超像素列数时走稠密模式（4 根时不走）', () => {
    const wide = new BarSeries(denseSeries(Array.from({ length: 4000 }, () => 30)), { left: 0, top: 0, width: 400, height: 300 });
    wide.setCoord(denseCoord(4000));
    expect((wide as any).shouldDrawDense((wide as any).coord)).toBe(true);

    const few = new BarSeries(denseSeries([30, 60, 90, 20]), { left: 0, top: 0, width: 400, height: 300 });
    few.setCoord(denseCoord(4));
    expect((few as any).shouldDrawDense((few as any).coord)).toBe(false);
  });

  it('稠密绘制：每像素列一根聚合矩形（远少于根数），列内极值不丢', () => {
    // 每 37 根插一个尖峰：抽样也得把尖峰带出来（每列至少 1 个样本，且首样本在列首）
    const values = Array.from({ length: 4000 }, (_, i) => (i % 37 === 0 ? 90 : 10 + (i % 5)));
    const component: any = new BarSeries(denseSeries(values), { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord(denseCoord(4000));
    const rects: any[] = [];
    component.ctx = ctxStub(rects);
    component.drawDense(component.coord);

    expect(rects.length).toBeGreaterThan(0);
    // 落墨量按像素列封顶
    expect(rects.length).toBeLessThanOrEqual(400);
    // 不再逐根画
    expect(rects.length).toBeLessThan(values.length / 4);
    // 第一列含 values[0]=90（尖峰）→ 柱高应当接近 y(0)→y(90) 那一段（≈270px）
    const tallest = rects.reduce((max, r) => Math.max(max, r.h), 0);
    expect(tallest).toBeGreaterThan(200);
  });

  it('稠密模式不建「每根一个」的像素缓存，命中仍然给出真实下标附近的那一根', () => {
    const values = Array.from({ length: 4000 }, () => 40);
    const component: any = new BarSeries(denseSeries(values), { left: 0, top: 0, width: 400, height: 300 });
    component.setCoord(denseCoord(4000));
    component.ctx = ctxStub([]);
    expect(component.pixels.length).toBe(0);
    component.doRender();
    // 稠密绘制不该物化 4000 个像素点
    expect(component.pixels.length).toBe(0);

    // 命中：取第 2000 根的矩形中心，返回的下标必须落在同一个像素列附近
    const rect = component.barRectAt(2000);
    const hit = component.hitTestIndex(rect.x + rect.width / 2, rect.y + rect.height / 2);
    expect(hit).toBeGreaterThan(1900);
    expect(hit).toBeLessThan(2100);
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
