import { createChart, ICEChart, isChartSnapshot, SNAPSHOT_VERSION } from '../../src/index';
import type { ChartOption } from '../../src/types';

/** 每种场景各来一份，验证「导出 → 还原」之后语义完全一致。 */
const SCENARIOS: Array<{ name: string; option: ChartOption; zoom?: [any, any] }> = [
  {
    name: '直角坐标（多系列 + 缩放窗口）',
    option: {
      title: { text: '流量' },
      legend: { show: true, position: 'top' },
      xAxis: { type: 'category' },
      yAxis: { name: '值' },
      series: [
        { id: 'a', type: 'line', name: 'A', data: [10, 30, 20, 45, 35, 50, 25] },
        { id: 'b', type: 'bar', name: 'B', data: [4, 9, 6, 13, 7, 15, 10] },
      ],
    },
    zoom: [2, 5],
  },
  {
    name: '多 y 轴',
    option: {
      yAxis: [{ name: '量' }, { name: '%', position: 'right' }],
      xAxis: { type: 'category' },
      series: [
        { id: 'v', type: 'bar', name: '成交量', data: [1200, 1350, 980, 1500] },
        { id: 'c', type: 'line', name: '涨跌幅', yAxisIndex: 1, data: [1.2, -0.8, 2.4, -1.6] },
      ],
    },
  },
  {
    name: '饼图（含隐藏扇区）',
    option: {
      legend: { show: true, position: 'right' },
      series: [
        {
          id: 'share',
          type: 'pie',
          name: '份额',
          data: [
            { name: 'A', value: 60 },
            { name: 'B', value: 25 },
            { name: 'C', value: 15 },
          ],
        },
      ],
    },
  },
  {
    name: '雷达图',
    option: {
      radar: { indicators: [{ name: '攻击', max: 100 }, { name: '防御', max: 100 }, { name: '速度', max: 100 }] },
      series: [{ id: 'r', type: 'radar', name: '选手', data: [80, 60, 70] }],
    },
  },
  {
    name: '函数绘图（表达式 + 参数）',
    option: {
      xAxis: { type: 'value' },
      yAxis: {},
      series: [
        {
          id: 'f',
          type: 'function',
          name: 'a*sin(x)/x',
          expression: 'a*sin(x)/x',
          domain: [-8, 8],
          params: { a: 2 },
        },
        {
          id: 'p',
          type: 'parametric',
          name: '李萨如',
          xExpression: 'sin(3*t)',
          yExpression: 'cos(2*t)',
          domain: [0, Math.PI * 2],
        },
      ],
    },
  },
  {
    name: 'K 线',
    option: {
      xAxis: { type: 'category' },
      yAxis: { name: '价格' },
      series: [
        {
          id: 'k',
          type: 'candlestick',
          name: 'K',
          data: [
            [100, 110, 95, 115],
            [110, 105, 100, 118],
          ],
        },
      ],
    },
  },
  {
    name: '热力图',
    option: {
      xAxis: { type: 'category' },
      yAxis: { type: 'category' },
      series: [
        {
          id: 'heat',
          type: 'heatmap',
          name: '热度',
          data: [
            ['周一', '上午', 10],
            ['周一', '下午', 30],
            ['周二', '上午', 90],
          ],
        },
      ],
    },
  },
  {
    name: '桑基图',
    option: {
      sankey: {
        nodes: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
        links: [
          { source: 'A', target: 'B', value: 10 },
          { source: 'B', target: 'C', value: 6 },
        ],
      },
      series: [{ id: 's', type: 'sankey', name: '流向' }],
    },
  },
];

function makeCanvas(): any {
  const canvas = document.createElement('canvas');
  canvas.width = 700;
  canvas.height = 400;
  document.body.appendChild(canvas);
  return canvas;
}

describe('图表 JSON 序列化 / 反序列化', () => {
  const canvases: any[] = [];
  const charts: ICEChart[] = [];

  afterEach(() => {
    charts.forEach((c) => c.destroy());
    charts.length = 0;
    canvases.forEach((c) => c.parentNode && c.parentNode.removeChild(c));
    canvases.length = 0;
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.name}：导出 → 还原后语义一致`, async () => {
      const canvasA = makeCanvas();
      const canvasB = makeCanvas();
      canvases.push(canvasA, canvasB);

      const a = createChart(canvasA, scenario.option);
      charts.push(a);
      await a.render();
      if (scenario.zoom) {
        a.setDomain('x', scenario.zoom);
        await a.render();
      }

      const snapshot = a.toJSON();
      const b = createChart(canvasB, snapshot);
      charts.push(b);
      await b.render();

      // 场景类型、数据、域、显隐状态一致
      expect(b.norm.kind).toBe(a.norm.kind);
      expect(b.toJSONString()).toBe(a.toJSONString());
      expect(b.norm.series.map((s) => s.points.map((p) => p.y))).toEqual(
        a.norm.series.map((s) => s.points.map((p) => p.y))
      );
      expect(b.getDomain('x')).toEqual(a.getDomain('x'));
      // 还原后的图确实能交互（命中测试走真实引擎）
      const component = b.seriesComponents[0];
      const pixel = component.pixelAt(0);
      if (pixel) {
        const target = b.controller.resolveTarget(b.layout.plot.x + pixel[0], b.layout.plot.y + pixel[1]);
        expect(target.kind).toBe('series');
      }
    });
  }

  it('快照可 JSON 字符串化并解析回来（真正的存盘路径）', async () => {
    const canvasA = makeCanvas();
    const canvasB = makeCanvas();
    canvases.push(canvasA, canvasB);
    const a = createChart(canvasA, SCENARIOS[0].option);
    charts.push(a);
    await a.render();
    a.setDomain('x', [1, 4]);
    a.toggleSeries('b');

    const json = a.toJSONString();
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(SNAPSHOT_VERSION);
    expect(typeof json).toBe('string');

    const b = createChart(canvasB, json);
    charts.push(b);
    await b.render();
    expect(b.getDomain('x')).toEqual([1, 2, 3, 4]);
    expect(b.norm.series.find((s) => s.id === 'b')!.hidden).toBe(true);
    expect(b.seriesComponents[1].state.display).toBe(false);
  });

  it('还原后继续操作，再导出仍然稳定（幂等）', async () => {
    const canvasA = makeCanvas();
    const canvasB = makeCanvas();
    canvases.push(canvasA, canvasB);
    const a = createChart(canvasA, SCENARIOS[0].option);
    charts.push(a);
    await a.render();
    const first = a.toJSONString();

    const b = createChart(canvasB, first);
    charts.push(b);
    await b.render();
    expect(b.toJSONString()).toBe(first);
  });

  it('扇区显隐也被序列化', async () => {
    const canvasA = makeCanvas();
    const canvasB = makeCanvas();
    canvases.push(canvasA, canvasB);
    const a = createChart(canvasA, SCENARIOS[2].option);
    charts.push(a);
    await a.render();
    a.toggleSlice('share', 1);

    const b = createChart(canvasB, a.toJSON());
    charts.push(b);
    await b.render();
    expect(b.norm.hiddenSlices['share#1']).toBe(true);
    expect((b.seriesComponents[0] as any).hiddenSlices).toEqual([1]);
    // 隐藏扇区的数据表占比也随之重算
    const table = b.getDataTable();
    expect(table.rows.map((r) => r[0])).toEqual(['A', 'C']);
    expect(table.rows[0][2]).toBe('80.0%');
  });

  it('函数字段（formatter）无法进 JSON，可用 optionPatch 补回来', async () => {
    const canvas = makeCanvas();
    canvases.push(canvas);
    const option: ChartOption = {
      xAxis: { type: 'category' },
      tooltip: { trigger: 'axis', formatter: () => '原始 formatter' },
      series: [{ id: 'a', type: 'line', name: 'A', data: [1, 2, 3] }],
    };
    const a = createChart(canvas, option);
    charts.push(a);
    await a.render();
    const json = a.toJSONString();
    expect(json.indexOf('formatter')).toBe(-1);

    const canvas2 = makeCanvas();
    canvases.push(canvas2);
    const restored = ICEChart.restore(canvas2, json, {
      optionPatch: { tooltip: { formatter: () => '补回来的 formatter' } as any },
    });
    charts.push(restored);
    await restored.render();
    expect(typeof restored.getOption().tooltip!.formatter).toBe('function');
    expect(restored.getOption().tooltip!.formatter!({ items: [], dataIndex: 0, xValue: 0 })).toBe('补回来的 formatter');
    // 数据没有被补丁覆盖
    expect(restored.norm.series[0].points.map((p) => p.y)).toEqual([1, 2, 3]);
  });

  it('optionPatch 按系列 id 合并，不会丢掉数据', async () => {
    const canvas = makeCanvas();
    canvases.push(canvas);
    const a = createChart(canvas, SCENARIOS[0].option);
    charts.push(a);
    await a.render();
    const patch = { series: [{ id: 'b', color: '#123456', label: { show: true } }] };
    const b = createChart(makeCanvas(), a.toJSON());
    canvases.push(b.canvasElement);
    charts.push(b);
    b.fromJSONObject(a.toJSON(), { optionPatch: patch as any });
    await b.render();
    const seriesB = b.norm.series.find((s) => s.id === 'b')!;
    expect(seriesB.color).toBe('#123456');
    expect(seriesB.points.map((p) => p.y)).toEqual([4, 9, 6, 13, 7, 15, 10]);
  });

  it('isChartSnapshot 能区分快照与普通 option', () => {
    expect(isChartSnapshot({ option: { series: [] }, version: 1 })).toBe(true);
    expect(isChartSnapshot({ series: [] })).toBe(false);
    expect(isChartSnapshot(null)).toBe(false);
  });

  it('拒绝加载更高版本的快照', async () => {
    const canvas = makeCanvas();
    canvases.push(canvas);
    const chart = createChart(canvas, SCENARIOS[0].option);
    charts.push(chart);
    await chart.render();
    const snapshot = { ...chart.toJSON(), version: SNAPSHOT_VERSION + 5 };
    expect(() => chart.fromJSONObject(snapshot)).toThrow(/快照版本/);
  });

  it('引擎级组件树不是图表的持久化格式（记录设计边界）', async () => {
    const canvas = makeCanvas();
    canvases.push(canvas);
    const chart = createChart(canvas, SCENARIOS[0].option);
    charts.push(chart);
    await chart.render();
    // 引擎能导出组件树（几何 + 样式），但里面没有数据语义
    const tree = JSON.parse((chart.ice as any).toJSONString());
    expect(Array.isArray(tree.childNodes)).toBe(true);
    // 快照里存的是 option，而不是组件树 —— 两者刻意分开
    const snapshot = chart.toJSON();
    expect(snapshot.option).toBeDefined();
    expect((snapshot as any).childNodes).toBeUndefined();
  });
});
