import {
  createChart,
  registerSeriesType,
  unregisterSeriesType,
  clearCustomSeriesTypes,
  listSeriesTypes,
  isBuiltinSeriesType,
  getSeriesTypeFactory,
  SeriesBase,
  LineSeries,
} from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/**
 * 自定义系列类型：每个数据点画一根小竖条（微缩条形图），命中按最近点算。
 * 用来验证「任何 SeriesBase 子类都能作为一等系列接进来」。
 */
class SparkSeries extends SeriesBase {
  public seriesType = 'sparkline';
  protected clipToBox = true;

  protected doRender(): void {
    this.rebuildPixels();
    const n = this.pixels.length / 2;
    if (!n) return;
    const option: any = this.series.option;
    const slot = Math.max(2, (this.state.width / n) * 0.6);
    this.beginDraw();
    this.ctx.fillStyle = option.color || '#0D6EFD';
    for (let i = 0; i < n; i++) {
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      // 从数据点向下画一小段，作为「火花条」
      this.ctx.fillRect(x - slot / 2, y, slot, Math.max(2, 10));
    }
    this.endDraw();
  }

  public hitTestIndex(localX: number, localY: number): number {
    this.rebuildPixels();
    const n = this.pixels.length / 2;
    let best = -1;
    let bestDist = 14 * 14;
    for (let i = 0; i < n; i++) {
      const dx = this.pixels[i * 2] - localX;
      const dy = this.pixels[i * 2 + 1] - localY;
      const dist = dx * dx + dy * dy;
      if (dist <= bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }
}

describe('系列类型注册表', () => {
  let canvas: HTMLCanvasElement;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    clearCustomSeriesTypes();
  });

  it('注册后可以用自定义类型画图，且拿到归一化后的数据点', async () => {
    registerSeriesType('sparkline', (series, props) => new SparkSeries(series, props));
    chart = createChart(canvas, {
      xAxis: { type: 'category' },
      yAxis: {},
      series: [{ id: 's', type: 'sparkline', data: [3, 6, 2, 8] }],
    } as ChartOption);
    await chart.render();
    const comp = chart.seriesComponents[0];
    expect(comp).toBeInstanceOf(SparkSeries);
    expect(chart.norm.series[0].points).toHaveLength(4);
    expect(comp.pixelAt(3)).not.toBeNull();
  });

  it('自定义系列参与命中与悬停（提示框照常）', async () => {
    registerSeriesType('sparkline', (series, props) => new SparkSeries(series, props));
    chart = createChart(canvas, {
      xAxis: { type: 'category' },
      yAxis: {},
      tooltip: { trigger: 'item' },
      series: [{ id: 's', type: 'sparkline', name: '火花', data: [3, 6, 2, 8] }],
    } as ChartOption);
    await chart.render();
    const comp: any = chart.seriesComponents[0];
    const pixel = comp.pixelAt(2)!;
    chart.controller.handlePointerMove(chart.layout.plot.x + pixel[0], chart.layout.plot.y + pixel[1]);
    await chart.render();
    expect(comp.hoverIndex).toBe(2);
    expect(chart.tooltip!.content).not.toBeNull();
  });

  it('[x, y] 与对象数据也能吃到通用归一化', async () => {
    registerSeriesType('sparkline', (series, props) => new SparkSeries(series, props));
    chart = createChart(canvas, {
      xAxis: { type: 'value' },
      yAxis: {},
      series: [{ id: 's', type: 'sparkline', data: [[0, 1], [1, 4], [2, 2]] }],
    } as ChartOption);
    await chart.render();
    expect(chart.norm.series[0].points.map((p) => p.y)).toEqual([1, 4, 2]);

    chart.destroy();
    chart = createChart(canvas, {
      xAxis: { type: 'value' },
      yAxis: {},
      series: [{ id: 's2', type: 'sparkline', data: [{ x: 1, y: 5 }, { x: 2, y: 7 }] }],
    } as ChartOption);
    await chart.render();
    expect(chart.norm.series[0].points.map((p) => p.y)).toEqual([5, 7]);
  });

  it('内置类型不允许覆盖', () => {
    expect(() => registerSeriesType('line', (series, props) => new SparkSeries(series, props))).toThrow(/内置类型/);
    expect(() => registerSeriesType('bar', (series, props) => new SparkSeries(series, props))).toThrow(/内置类型/);
  });

  it('类型名非法 / factory 非法都会明确报错', () => {
    expect(() => registerSeriesType('', (s, p) => new SparkSeries(s, p))).toThrow(/类型名/);
    expect(() => registerSeriesType('2bad', (s, p) => new SparkSeries(s, p))).toThrow(/类型名/);
    expect(() => registerSeriesType('has space', (s, p) => new SparkSeries(s, p))).toThrow(/类型名/);
    expect(() => registerSeriesType('ok-name', null as any)).toThrow(/factory/);
  });

  it('同名重复注册不同工厂会报错，相同工厂是幂等的', () => {
    const factory = (series: any, props: any) => new SparkSeries(series, props);
    registerSeriesType('sparkline', factory);
    expect(() => registerSeriesType('sparkline', factory)).not.toThrow();
    expect(() => registerSeriesType('sparkline', (s, p) => new SparkSeries(s, p))).toThrow(/已经注册过/);
  });

  it('注销后退回折线渲染（不会整张图空白）', async () => {
    registerSeriesType('sparkline', (series, props) => new SparkSeries(series, props));
    expect(unregisterSeriesType('sparkline')).toBe(true);
    expect(unregisterSeriesType('sparkline')).toBe(false);
    chart = createChart(canvas, {
      xAxis: { type: 'category' },
      yAxis: {},
      series: [{ id: 's', type: 'sparkline', data: [1, 2, 3] }],
    } as ChartOption);
    await chart.render();
    expect(chart.seriesComponents[0]).toBeInstanceOf(LineSeries);
  });

  it('listSeriesTypes / isBuiltinSeriesType / getSeriesTypeFactory', () => {
    const builtins = listSeriesTypes();
    expect(builtins).toEqual(expect.arrayContaining(['line', 'bar', 'pie', 'liquid']));
    expect(isBuiltinSeriesType('line')).toBe(true);
    expect(isBuiltinSeriesType('sparkline')).toBe(false);
    const factory = (series: any, props: any) => new SparkSeries(series, props);
    registerSeriesType('sparkline', factory);
    expect(listSeriesTypes()).toContain('sparkline');
    expect(getSeriesTypeFactory('sparkline')).toBe(factory);
    expect(getSeriesTypeFactory('nope')).toBeNull();
  });

  it('自定义系列的 option 依然可以序列化 / 还原（option 是唯一事实来源）', async () => {
    registerSeriesType('sparkline', (series, props) => new SparkSeries(series, props));
    chart = createChart(canvas, {
      xAxis: { type: 'category' },
      yAxis: {},
      series: [{ id: 's', type: 'sparkline', name: '火花', data: [3, 6, 2, 8] }],
    } as ChartOption);
    await chart.render();
    const json = chart.toJSONString();
    expect(JSON.parse(json).option.series[0].type).toBe('sparkline');
    chart.destroy();
    chart = createChart(canvas, json as any);
    await chart.render();
    expect(chart.seriesComponents[0]).toBeInstanceOf(SparkSeries);
    expect(chart.norm.series[0].points).toHaveLength(4);
  });
});
