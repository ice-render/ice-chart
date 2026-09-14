import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const OPTION: ChartOption = {
  xAxis: { type: 'category', data: ['1月', '2月', '3月', '4月'] },
  yAxis: { min: 0, max: 200 },
  series: [{ id: 's', type: 'line', name: '销量', data: [120, 142, 168, 154] }],
};

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2024, 0, 1);
const TIME_OPTION: ChartOption = {
  xAxis: { type: 'time' },
  yAxis: { min: 0, max: 100 },
  series: [
    {
      id: 's',
      type: 'line',
      data: [
        [T0, 20],
        [T0 + DAY, 40],
        [T0 + 2 * DAY, 30],
        [T0 + 3 * DAY, 60],
      ],
    },
  ],
};

/**
 * 标注（annotation）：目标线 / 阈值线 / 异常点 / 目标区间。
 *
 * 它不是新的系列类型，而是**坐标系上的一个图层** —— 数据来自 option、几何来自比例尺，
 * 因此这里断言的是「同一个值算出来的像素必须与系列/坐标轴一致」，而不是「画出来像不像」。
 */
describe('标注（annotation）', () => {
  let canvas: HTMLCanvasElement;
  let chart: ICEChart | null = null;

  const mount = (option: ChartOption = OPTION) => {
    canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 400;
    document.body.appendChild(canvas);
    chart = createChart(canvas, option);
    return chart;
  };

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  /** 某个值在图表坐标系（画布左上角为原点）里的像素位置。 */
  const pixelOf = (axis: 'x' | 'y', value: any, axisIndex = 0): number => {
    const plot = chart!.layout.plot;
    if (axis === 'x') {
      const scale: any = chart!.norm.xAxis.scale;
      return plot.x + Number(scale.map(value));
    }
    const scale: any = chart!.norm.yAxes[axisIndex].scale;
    return plot.y + Number(scale.map(value));
  };

  const line = (index = 0) => chart!.annotation.resolved.lines[index];
  const codes = () => chart!.annotationDiagnostics().map((item) => item.code);

  it('lines：数值轴按值定位，像素与比例尺一致', async () => {
    const c = mount({ ...OPTION, annotation: { lines: [{ axis: 'y', value: 120, text: '目标 120' }] } });
    await c.render();

    expect(c.annotation.resolved.lines).toHaveLength(1);
    expect(line().pixel).toBeCloseTo(pixelOf('y', 120), 1);
    expect(line().text).toBe('目标 120');
    expect(c.annotationDiagnostics()).toHaveLength(0);
  });

  it('lines：类目轴按「类目名」和「下标」都能定位', async () => {
    const c = mount({
      ...OPTION,
      annotation: {
        lines: [
          { axis: 'x', value: '3月', text: '上线' },
          { axis: 'x', value: 2, text: '按下标' },
        ],
      },
    });
    await c.render();

    expect(c.annotation.resolved.lines).toHaveLength(2);
    expect(line(0).pixel).toBeCloseTo(pixelOf('x', '3月'), 1);
    // 下标 2 == 第 3 个类目
    expect(line(1).pixel).toBeCloseTo(pixelOf('x', '3月'), 1);
    expect(c.annotationDiagnostics()).toHaveLength(0);
  });

  it('lines：时间轴按时间戳与日期串定位', async () => {
    const c = mount({
      ...TIME_OPTION,
      annotation: {
        lines: [
          { axis: 'x', value: T0 + DAY, text: 'A' },
          { axis: 'x', value: '2024-01-03T00:00:00.000Z', text: 'B' },
        ],
      },
    });
    await c.render();

    expect(c.annotation.resolved.lines).toHaveLength(2);
    expect(line(0).pixel).toBeCloseTo(pixelOf('x', T0 + DAY), 1);
    expect(line(1).pixel).toBeCloseTo(pixelOf('x', T0 + 2 * DAY), 1);
    expect(c.annotationDiagnostics()).toHaveLength(0);
  });

  it('lines：越界不画，并给出结构化诊断', async () => {
    const c = mount({
      ...OPTION,
      annotation: {
        lines: [
          { axis: 'y', value: 500, text: '越界' },
          { axis: 'x', value: '9月', text: '没有这个类目' },
        ],
      },
    });
    await c.render();

    expect(c.annotation.resolved.lines).toHaveLength(0);
    expect(codes()).toEqual(['annotation:out-of-range', 'annotation:unknown-category']);
    const [first] = c.annotationDiagnostics();
    expect(first.severity).toBe('warning');
    expect(first.kind).toBe('line');
    expect(first.index).toBe(0);
  });

  it('lines：值非法是错误（标红用），且不影响其它标注', async () => {
    const c = mount({
      ...OPTION,
      annotation: {
        lines: [
          { axis: 'y', text: '忘了写值' },
          { axis: 'y', value: 80, text: '正常' },
        ],
      },
    });
    await c.render();

    expect(c.annotation.resolved.lines).toHaveLength(1);
    expect(line().text).toBe('正常');
    expect(codes()).toEqual(['annotation:invalid-value']);
    expect(c.annotationDiagnostics()[0].severity).toBe('error');
  });

  it('lines：随缩放重新定位，滑出可视窗口后自行消失', async () => {
    const c = mount({ ...OPTION, annotation: { lines: [{ axis: 'y', value: 120 }] } });
    await c.render();
    const before = line().pixel;

    c.setDomain('y', [0, 100], 'api');
    await c.render();
    expect(c.annotation.resolved.lines).toHaveLength(0);
    expect(codes()).toEqual(['annotation:out-of-range']);

    c.setDomain('y', [0, 200], 'api');
    await c.render();
    expect(line().pixel).toBeCloseTo(before, 1);
  });

  it('lines：默认虚线、默认不吃主题之外的颜色；可配实线与色值', async () => {
    const c = mount({
      ...OPTION,
      annotation: {
        lines: [
          { axis: 'y', value: 60 },
          { axis: 'y', value: 80, dashed: false, color: '#f59e0b', lineWidth: 2 },
        ],
      },
    });
    await c.render();

    expect(line(0).lineDash.length).toBeGreaterThan(0);
    expect(line(1).lineDash).toEqual([]);
    expect(line(1).color).toBe('#f59e0b');
    expect(line(1).lineWidth).toBe(2);
  });

  it('areas / points：区间与点也走同一套比例尺', async () => {
    const c = mount({
      ...OPTION,
      annotation: {
        areas: [{ axis: 'y', from: 0, to: 100, text: '达标区' }],
        points: [{ x: '3月', y: 168, text: '异常点' }],
      },
    });
    await c.render();

    expect(c.annotation.resolved.areas).toHaveLength(1);
    expect(c.annotation.resolved.areas[0].from).toBeCloseTo(pixelOf('y', 0), 1);
    expect(c.annotation.resolved.areas[0].to).toBeCloseTo(pixelOf('y', 100), 1);

    expect(c.annotation.resolved.points).toHaveLength(1);
    expect(c.annotation.resolved.points[0].x).toBeCloseTo(pixelOf('x', '3月'), 1);
    expect(c.annotation.resolved.points[0].y).toBeCloseTo(pixelOf('y', 168), 1);
    expect(c.annotationDiagnostics()).toHaveLength(0);
  });

  it('areas：区间两端越界时只画可见的那一段，整段不可见才不画', async () => {
    const c = mount({
      ...OPTION,
      annotation: {
        areas: [
          { axis: 'y', from: -50, to: 100, text: '跨出去一半' },
          { axis: 'y', from: 300, to: 400 },
        ],
      },
    });
    await c.render();

    expect(c.annotation.resolved.areas).toHaveLength(1);
    expect(c.annotation.resolved.areas[0].from).toBeCloseTo(pixelOf('y', 0), 1);
    expect(c.annotation.resolved.areas[0].to).toBeCloseTo(pixelOf('y', 100), 1);
    expect(codes()).toEqual(['annotation:out-of-range']);
  });

  it('标注不参与命中：压在数据点上也点的是数据', async () => {
    const c = mount({
      ...OPTION,
      annotation: { points: [{ x: '3月', y: 168, text: '异常点' }] },
    });
    await c.render();

    const x = pixelOf('x', '3月');
    const y = pixelOf('y', 168);
    expect(c.ice.hitTest(x, y)).toBe(c.seriesComponents[0]);
  });

  it('非直角坐标场景：标注没有坐标系可用，给出提示而不是静默', async () => {
    const c = mount({
      series: [
        {
          id: 'p',
          type: 'pie',
          data: [
            { name: 'A', value: 3 },
            { name: 'B', value: 5 },
          ],
        },
      ],
      annotation: { lines: [{ axis: 'y', value: 50, text: '目标' }] },
    } as ChartOption);
    await c.render();

    expect(c.annotation.resolved.lines).toHaveLength(0);
    expect(codes()).toEqual(['annotation:unsupported-scene']);
  });

  it('横向排布（类目在 y 轴）：数值轴的竖线 + 类目轴的横线都能定位', async () => {
    // 排行榜写法：x 轴是数值、y 轴是类目 —— 目标线这时是**竖线**（axis: 'x'）
    const c = mount({
      xAxis: { type: 'value', name: '万元' },
      yAxis: { type: 'category', data: ['华东', '华北', '华南', '西南', '西北'] },
      series: [{ id: 'sales', type: 'bar', data: [320, 302, 301, 334, 390] }],
      annotation: {
        lines: [
          { axis: 'x', value: 350, text: '区域目标 350' },
          { axis: 'y', value: '华南', text: '华南' },
        ],
      },
    } as ChartOption);
    await c.render();

    expect(c.annotation.resolved.lines).toHaveLength(2);
    expect(line(0).pixel).toBeCloseTo(pixelOf('x', 350), 1);
    expect(line(1).pixel).toBeCloseTo(pixelOf('y', '华南'), 1);
    expect(c.annotationDiagnostics()).toHaveLength(0);
  });

  it('多 y 轴：axisIndex 指定贴哪根轴定位', async () => {
    const c = mount({
      yAxis: [{ name: '成交量' }, { name: '涨跌幅(%)' }],
      series: [
        { id: 'volume', type: 'bar', data: [1200, 1350, 980, 1500] },
        { id: 'change', type: 'line', yAxisIndex: 1, data: [1.2, -0.8, 2.4, -1.6] },
      ],
      annotation: {
        lines: [
          { axis: 'y', value: 1400, text: '成交量警戒' },
          { axis: 'y', value: 2, text: '涨幅警戒', axisIndex: 1 },
        ],
      },
    } as ChartOption);
    await c.render();

    expect(c.annotation.resolved.lines).toHaveLength(2);
    // 副轴（右轴）的 2% 与主轴刻度的像素完全不是一回事 —— 这条能挡住「多轴时全按主轴算」
    expect(line(1).pixel).toBeCloseTo(pixelOf('y', 2, 1), 1);
    expect(Math.abs(line(1).pixel - pixelOf('y', 2, 0))).toBeGreaterThan(10);
    expect(c.annotationDiagnostics()).toHaveLength(0);
  });

  it('序列化往返：标注进快照、还原后像素一致、再导出一致', async () => {
    const c = mount({
      ...OPTION,
      annotation: {
        lines: [{ axis: 'y', value: 120, text: '目标', color: '#f59e0b', textPosition: 'start' }],
        areas: [{ axis: 'y', from: 0, to: 100 }],
        points: [{ x: '2月', y: 142, text: '异常点' }],
      },
    });
    await c.render();

    const json = c.toJSONString();
    expect(json).toContain('"annotation"');

    const restoredCanvas = document.createElement('canvas');
    restoredCanvas.width = 720;
    restoredCanvas.height = 400;
    document.body.appendChild(restoredCanvas);
    const restored = createChart(restoredCanvas, json as any);
    await restored.render();

    expect(restored.annotation.resolved.lines[0].pixel).toBeCloseTo(line().pixel, 1);
    expect(restored.toJSONString()).toBe(json);
    restored.destroy();
    restoredCanvas.parentNode?.removeChild(restoredCanvas);
  });
});
