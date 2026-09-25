import { alluvialTargetAt, layoutAlluvial } from '../../src/layout/alluvial';

const AREA = { x: 0, y: 0, width: 600, height: 300 };
const CONFIG = { axes: ['渠道', '地区', '品类'], valueField: 'value' };
const ROWS = [
  { 渠道: '线上', 地区: '华东', 品类: '手机', value: 30 },
  { 渠道: '线上', 地区: '华北', 品类: '配件', value: 10 },
  { 渠道: '线下', 地区: '华东', 品类: '手机', value: 20 },
  { 渠道: '线下', 地区: '华东', 品类: '配件', value: 20 },
];

describe('layoutAlluvial', () => {
  it('每个轴按流量堆叠，节点高度与流量成比例', () => {
    const layout = layoutAlluvial(ROWS, CONFIG, AREA);
    expect(layout.axes).toHaveLength(3);
    const channels = layout.axes[0].categories;
    expect(channels.map((category) => category.name)).toEqual(['线上', '线下']);
    expect(channels[0].total).toBe(40);
    expect(channels[1].total).toBe(40);
    expect(channels[0].height).toBeCloseTo(channels[1].height, 6);
    // 从上到下依次排开，并留出间隙
    expect(channels[1].y).toBeGreaterThanOrEqual(channels[0].y + channels[0].height);
  });

  it('相邻轴的流量按 (from, to) 聚合，且两端各自首尾相接（不重叠）', () => {
    const layout = layoutAlluvial(ROWS, CONFIG, AREA);
    const first = layout.flows.filter((flow) => flow.axis === 0);
    expect(first).toHaveLength(3); // 线上→华东 / 线上→华北 / 线下→华东
    const online = first.filter((flow) => flow.fromName === '线上').sort((a, b) => a.source[0] - b.source[0]);
    expect(online[0].source[1]).toBeCloseTo(online[1].source[0], 6);
    const east = first.filter((flow) => flow.toName === '华东').sort((a, b) => a.target[0] - b.target[0]);
    expect(east[0].target[1]).toBeCloseTo(east[1].target[0], 6);
  });

  it('后一轴与前轴对齐的类目排在相应的位置（不是死按名字序）', () => {
    const layout = layoutAlluvial(
      [
        { 渠道: 'A', 地区: '远', value: 50 },
        { 渠道: 'B', 地区: '近', value: 50 },
      ],
      { axes: ['渠道', '地区'], valueField: 'value' },
      AREA
    );
    // 第一轴流量并列 → 稳定地按名字序（A、B）
    expect(layout.axes[0].categories.map((category) => category.name)).toEqual(['A', 'B']);
    // 带子按「源节点顺序」排：A→远 先出现，B→近 随后 —— 两条带不交叉
    const flows = layout.flows;
    expect(flows[0].fromName).toBe('A');
    expect(flows[1].fromName).toBe('B');
  });

  it('空表 / 缺列 / 非数值都不崩，返回空布局', () => {
    expect(layoutAlluvial([], CONFIG, AREA).axes).toEqual([]);
    expect(layoutAlluvial(ROWS, { axes: [] }, AREA).axes).toEqual([]);
    const layout = layoutAlluvial([{ 渠道: '线上', value: 'x' }], CONFIG, AREA);
    expect(layout.axes[0].categories).toEqual([]);
  });

  it('命中：节点优先，带子在两端之间按插值判定', () => {
    const layout = layoutAlluvial(ROWS, CONFIG, AREA);
    const node = layout.axes[0].categories[0];
    expect(alluvialTargetAt(layout.axes[0].x + 2, node.y + node.height / 2, layout)).toEqual({
      kind: 'node',
      axis: 0,
      index: node.index,
    });

    const flowIndex = layout.flows.findIndex((item) => item.fromName === '线上' && item.toName === '华东');
    expect(flowIndex).toBeGreaterThanOrEqual(0);
    const flow = layout.flows[flowIndex];
    const leftEdge = layout.axes[flow.axis].x + layout.axes[flow.axis].width;
    const rightEdge = layout.axes[flow.axis + 1].x;
    const midX = (leftEdge + rightEdge) / 2;
    const midY = (flow.source[0] + flow.source[1] + flow.target[0] + flow.target[1]) / 4;
    expect(alluvialTargetAt(midX, midY, layout)).toEqual({ kind: 'flow', index: flowIndex });
    // 带子之外的空白不命中
    expect(alluvialTargetAt(midX, AREA.height + 20, layout)).toBeNull();
  });
});
