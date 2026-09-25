import { createChart } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const ALLUVIAL: ChartOption = {
  legend: { show: false },
  animation: { enabled: false },
  alluvial: {
    axes: ['渠道', '地区', '品类'],
    valueField: 'value',
    rows: [
      { 渠道: '线上', 地区: '华东', 品类: '手机', value: 30 },
      { 渠道: '线上', 地区: '华北', 品类: '配件', value: 10 },
      { 渠道: '线下', 地区: '华东', 品类: '手机', value: 20 },
      { 渠道: '线下', 地区: '华东', 品类: '配件', value: 20 },
    ],
  },
  series: [{ id: 'flow', type: 'alluvial', name: '流向' }],
};

describe('多轴分类流（集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 820;
    canvas.height = 460;
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

  it('归一化把节点与流量拆成点集：节点在前，带子在后', () => {
    const norm = normalizeOption(ALLUVIAL);
    expect(norm.kind).toBe('alluvial');
    expect(norm.alluvial).toBeTruthy();
    // 3 个轴：渠道 2 + 地区 2 + 品类 2 = 6 个节点；
    // 带子 6 条：渠道→地区 3 条（线下→华东 由两行合并）+ 地区→品类 3 条
    expect(norm.series[0].pointCount).toBe(6 + 6);
    const node = norm.series[0].pointAt(0) as any;
    expect(node.raw.__alluvialNode).toBe(true);
    expect(node.y).toBeGreaterThan(0);
  });

  it('节点与带子各自可命中，命中返回对应的点下标', async () => {
    const c = await mount(ALLUVIAL);
    const alluvial: any = c.seriesComponents[0];
    // 节点：第 0 个节点的锚点在它自己身上
    const nodeCenter = alluvial.pixelAt(0)!;
    expect(alluvial.hitTestIndex(nodeCenter[0], nodeCenter[1])).toBe(0);
    // 带子：找一个带子的锚点
    const flowIndex = alluvial.isNodeIndex(0) ? 6 : 0; // 节点 6 个，带子从下标 6 开始
    const flowCenter = alluvial.pixelAt(flowIndex)!;
    expect(alluvial.hitTestIndex(flowCenter[0], flowCenter[1])).toBe(flowIndex);
    // 空白处不命中
    expect(alluvial.hitTestIndex(1, alluvial.state.height - 1)).toBe(-1);
  });

  it('提示框：节点给总量，带子给「从谁到谁」', async () => {
    const c = await mount({ ...ALLUVIAL, tooltip: { trigger: 'item' } });
    const alluvial: any = c.seriesComponents[0];
    const nodeCenter = alluvial.pixelAt(0)!;
    c.controller.handlePointerMove(c.layout.plot.x + nodeCenter[0], c.layout.plot.y + nodeCenter[1]);
    let content = c.tooltip!.content!;
    expect(content.title).toContain('：');
    expect(content.rows[0].name).toBe('总量');

    const flowCenter = alluvial.pixelAt(6)!;
    c.controller.handlePointerMove(c.layout.plot.x + flowCenter[0], c.layout.plot.y + flowCenter[1]);
    content = c.tooltip!.content!;
    expect(content.title).toContain('→');
    expect(content.rows[0].name).toBe('流量');
  });

  it('不吃坐标轴（和桑基同一类场景）', async () => {
    const c = await mount(ALLUVIAL);
    expect((c as any).axisX.state.display).toBe(false);
    expect((c as any).grid.state.display).toBe(false);
  });
});
