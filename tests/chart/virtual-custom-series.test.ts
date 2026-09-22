import { createChart, ICEChart, registerSeriesType, unregisterSeriesType, SeriesBase } from '../../src/index';
import type { ChartOption } from '../../src/types';

/**
 * **虚拟（列存）自定义系列**：`virtual: true` 对任意类型都成立。
 *
 * 数值列 / 矩阵之外的类型走「惰性原始点」：原始数据按引用保留（组件要按自己的字段解析、
 * 提示框要给 `params.data`），省掉的是**每点一个 `DataPoint` 对象**。
 * 追加时：没给窗口就原地 push；给了 `maxPoints` 就转成**原始环**（滚动窗口 O(1)/次）。
 *
 * 这里用一个最小的自定义系列（每点画一根小竖条）把链路走通：
 * 归一化 → 惰性取点 → 渲染 → 命中 → 追加 → 快照。
 */
class ProbeSeries extends SeriesBase {
  public seriesType = 'probe';
  protected clipToBox = true;

  /** 记录每帧「画了几根」，用来断言窗口裁剪 / 追加之后的数量。 */
  public painted = 0;

  protected doRender(): void {
    this.rebuildPixels();
    const n = this.pixels.length / 2;
    this.painted = 0;
    if (!n) return;
    const slot = Math.max(2, (this.state.width / Math.max(1, n)) * 0.6);
    this.beginDraw();
    this.ctx.fillStyle = '#0D6EFD';
    for (let i = 0; i < n; i++) {
      const x = this.pixels[i * 2];
      const y = this.pixels[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      this.ctx.fillRect(x - slot / 2, y, slot, 8);
      this.painted += 1;
    }
    this.endDraw();
  }

  public hitTestIndex(localX: number, _localY: number): number {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.series.pointCount; i++) {
      const pixel = this.pixelAt(i);
      if (!pixel) continue;
      const dist = Math.abs(pixel[0] - localX);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return bestDist <= 6 ? best : -1;
  }
}

describe('虚拟（列存）自定义系列', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeAll(() => {
    registerSeriesType('probe', (series: any, props: any) => new ProbeSeries(series, props));
  });

  afterAll(() => {
    unregisterSeriesType('probe');
  });

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 400;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  const rows = (count: number): any[] =>
    Array.from({ length: count }, (_, i) => ({ x: `D${i}`, v: 10 + (i % 7) }));

  const option = (data: any[], extra: any = {}): ChartOption =>
    ({
      legend: { show: false },
      animation: { enabled: false },
      xAxis: { type: 'category' },
      yAxis: {},
      series: [{ id: 'p', type: 'probe', name: '探针', yField: 'v', virtual: true, data, ...extra }],
    }) as any;

  const mount = async (o: ChartOption): Promise<ICEChart> => {
    chart = createChart(canvas, o, { renderMode: 'dirty-rect' });
    await chart.render();
    return chart;
  };

  it('不建 DataPoint 数组，但原始数据仍在 option 里（快照照样能带上）', async () => {
    const data = rows(50);
    const o: any = option(data);
    const c = await mount(o);
    const series: any = c.norm.series[0];
    expect(series.virtual).toBe(true);
    expect(series.points).toEqual([]);
    expect(series.pointCount).toBe(50);
    expect(series.raw.data).toBe(data);
    // 合成出来的点带着 raw（提示框的 params.data 因此不为空）
    expect(series.pointAt(3).raw).toBe(data[3]);
    expect(o.series[0].data).toBe(data);
  });

  it('渲染与命中都走合成点（自定系列的 pixelAt / hitTestIndex 照常可用）', async () => {
    const c = await mount(option(rows(40)));
    const component: any = c.seriesComponents[0];
    expect(component.painted).toBeGreaterThan(0);
    const pixel = component.pixelAt(10)!;
    expect(pixel).not.toBeNull();
    expect(component.hitTestIndex(pixel[0], pixel[1])).toBe(10);
  });

  it('追加（不给窗口）：原地 push，调用方那个数组也跟着长', async () => {
    const data = rows(20);
    const o: any = option(data);
    const c = await mount(o);
    c.appendData('p', [{ x: 'D20', v: 99 }]);
    const series: any = c.norm.series[0];
    expect(data.length).toBe(21);
    expect(series.pointCount).toBe(21);
    expect(series.pointAt(20).raw).toBe(data[20]);
    expect(series.raw.capacity).toBe(0);
  });

  it('追加（给 maxPoints）：转成原始环，窗口滑动、绕回后逻辑顺序仍然正确', async () => {
    const data = rows(10);
    const o: any = option(data);
    const c = await mount(o);
    // 窗口 5：只留最后 5 根，再追加 3 根 → 逻辑顺序是 D8..D12
    c.appendData(
      'p',
      [
        { x: 'D10', v: 1 },
        { x: 'D11', v: 2 },
        { x: 'D12', v: 3 },
      ],
      { maxPoints: 5 }
    );
    const series: any = c.norm.series[0];
    expect(series.raw.capacity).toBe(5);
    expect(series.pointCount).toBe(5);
    expect([0, 1, 2, 3, 4].map((i) => series.pointAt(i).xValue)).toEqual(['D8', 'D9', 'D10', 'D11', 'D12']);
    // 环形态下原始数据归存储所有：option 里已经摘掉，快照因此不含它
    expect(o.series[0].data).toBeUndefined();
  });

  it('环形态的快照：显式报错（数据不在快照里），而不是悄悄给一张空图', async () => {
    const c = await mount(option(rows(10)));
    c.appendData('p', [{ x: 'D10', v: 1 }], { maxPoints: 5 });
    const json = c.toJSONString();
    expect(JSON.parse(json).option.series[0].virtual).toBe(true);
    expect(JSON.parse(json).option.series[0].data).toBeUndefined();
    const target = document.createElement('canvas');
    target.width = 300;
    target.height = 200;
    document.body.appendChild(target);
    expect(() => ICEChart.restore(target, json)).toThrow(/虚拟（列存）系列/);
    target.parentNode.removeChild(target);
  });
});
