import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/** 两组观测：甲组居中（1..9），乙组偏移（20..28）。 */
const VIOLIN: ChartOption = {
  title: { text: '响应时长分布' },
  legend: { show: false },
  xAxis: { type: 'category', data: ['甲组', '乙组'] },
  yAxis: { name: '毫秒' },
  series: [
    {
      id: 'dist',
      type: 'violin',
      name: '响应时长',
      data: [
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 5, 5, 6],
        [20, 21, 22, 23, 24, 25, 26, 27, 28, 24, 24, 25],
      ],
    },
  ],
};

const BEESWARM: ChartOption = {
  legend: { show: false },
  xAxis: { type: 'category', data: ['甲组', '乙组'] },
  yAxis: { name: '毫秒' },
  series: [
    {
      id: 'swarm',
      type: 'beeswarm',
      name: '观测点',
      data: [
        ['甲组', 5],
        ['甲组', 5],
        ['甲组', 5],
        ['甲组', 9],
        ['乙组', 24],
        ['乙组', 24],
        ['乙组', 28],
      ],
    },
  ],
};

describe('小提琴图 / 蜂群图（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 420;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  async function mount(option: ChartOption): Promise<ICEChart> {
    chart = createChart(canvas, option);
    await chart.render();
    return chart;
  }

  it('每组的轮廓是一圈闭合的多边形，且不吃到隔壁分组', async () => {
    const c = await mount(VIOLIN);
    const violin: any = c.seriesComponents[0];
    const polygon = violin.violinPolygonAt(0)!;
    expect(polygon.length).toBeGreaterThan(16);
    const xs = polygon.map((p: number[]) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(4);
    // 轮廓宽度不超过一个 band
    const step = (c.norm.xAxis.scale as any).step();
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(step);
    // 第二组的轮廓整体在第一组右边
    const other = violin.violinPolygonAt(1)!;
    expect(Math.min(...other.map((p: number[]) => p[0]))).toBeGreaterThan(Math.max(...xs));
  });

  it('轮廓内部命中该组，轮廓外的空白不命中', async () => {
    const c = await mount(VIOLIN);
    const violin: any = c.seriesComponents[0];
    const polygon = violin.violinPolygonAt(0)!;
    const yScale: any = c.norm.yAxis.scale;
    // 该组的中位数处，轮廓中心线必然在形状里
    const centerX = (Math.min(...polygon.map((p: number[]) => p[0])) + Math.max(...polygon.map((p: number[]) => p[0]))) / 2;
    const medianY = c.layout.plot.y + yScale.map(5);
    expect(c.controller.resolveTarget(c.layout.plot.x + centerX, medianY).index).toBe(0);
    // 乙组的高度上、甲组的横向位置：形状没有覆盖那里
    const farY = c.layout.plot.y + yScale.map(24);
    const outside = violin.hitTestIndex(centerX, farY - c.layout.plot.y);
    expect(outside).toBe(-1);
  });

  it('提示框给观测数与五数概括', async () => {
    const c = await mount(VIOLIN);
    const violin: any = c.seriesComponents[0];
    const polygon = violin.violinPolygonAt(0)!;
    const xs = polygon.map((p: number[]) => p[0]);
    const yScale: any = c.norm.yAxis.scale;
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    c.controller.handlePointerMove(c.layout.plot.x + x, c.layout.plot.y + yScale.map(5));
    const content = c.tooltip!.content!;
    expect(content.title).toBe('甲组');
    const names = content.rows.map((r) => r.name);
    expect(names).toContain('观测数');
    expect(names).toContain('中位数');
    const count = content.rows.find((r) => r.name === '观测数')!;
    expect(count.value).toBe('12');
  });

  it('蜂群把同高度的观测点错开，逐点可命中', async () => {
    const c = await mount(BEESWARM);
    const swarm: any = c.seriesComponents[0];
    const first = swarm.pixelAt(0)!;
    const second = swarm.pixelAt(1)!;
    const third = swarm.pixelAt(2)!;
    // 三个同值点横向错开至少一个直径
    expect(Math.abs(first[0] - second[0])).toBeGreaterThanOrEqual(6);
    expect(Math.abs(second[0] - third[0])).toBeGreaterThanOrEqual(6);
    expect(swarm.hitTestIndex(first[0], first[1])).toBe(0);
    expect(swarm.hitTestIndex(second[0], second[1])).toBe(1);
    expect(swarm.hitTestIndex(third[0], third[1])).toBe(2);
  });

  it('蜂群命中空白返回 -1，且不串到隔壁分组', async () => {
    const c = await mount(BEESWARM);
    const swarm: any = c.seriesComponents[0];
    const first = swarm.pixelAt(0)!;
    // 甲组的高度范围是 5~9；y = 15 那一带没有任何观测点
    const yScale: any = c.norm.yAxis.scale;
    expect(swarm.hitTestIndex(first[0], yScale.map(15))).toBe(-1);
    // 乙组的点不会被甲组抢走
    const last = swarm.pixelAt(6)!;
    expect(swarm.hitTestIndex(last[0], last[1])).toBe(6);
  });

  it('小提琴 / 蜂群 / 箱线叠在同一类目轴上，各自都能命中', async () => {
    const c = await mount({
      legend: { show: false },
      xAxis: { type: 'category', data: ['甲组', '乙组'] },
      series: [
        { id: 'v', type: 'violin', name: '密度', data: [[1, 2, 3, 4, 5, 6], [20, 21, 22, 23, 24, 25]] },
        {
          id: 'b',
          type: 'boxplot',
          name: '五数',
          data: [
            [1, 2, 3, 4, 6],
            [20, 21, 22.5, 23.5, 25],
          ],
        },
        { id: 's', type: 'beeswarm', name: '观测点', data: [['甲组', 1], ['甲组', 3], ['甲组', 6], ['乙组', 20], ['乙组', 22], ['乙组', 25]] },
      ],
    });
    expect(c.seriesComponents).toHaveLength(3);
    const [violin, box, swarm]: any[] = c.seriesComponents;
    expect(violin.violinPolygonAt(0)).toBeTruthy();
    expect(box.boxRectAt(0)).toBeTruthy();
    expect(swarm.pixelAt(0)).toBeTruthy();
    // 三个组件都落在同一个绘图区里
    for (const component of c.seriesComponents) {
      expect(component.state.left).toBe(c.layout.plot.x);
      expect(component.state.top).toBe(c.layout.plot.y);
    }
  });
});
