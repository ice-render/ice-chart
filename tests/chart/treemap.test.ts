import { createChart } from '../../src/index';
import { normalizeOption, treemapNodeValue } from '../../src/option/normalize';
import { layoutTreemap } from '../../src/layout/treemap';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const TREE = [
  {
    name: '华东',
    children: [
      { name: '手机', value: 420 },
      { name: '电脑', value: 280 },
      { name: '配件', value: 120 },
    ],
  },
  {
    name: '华北',
    children: [
      { name: '手机', value: 300 },
      { name: '电脑', value: 160 },
    ],
  },
  { name: '华南', value: 240 },
];

const OPTION: ChartOption = {
  title: { text: '区域品类构成' },
  legend: { show: false },
  treemap: { gap: 2, minLabelRatio: 0.02, depthFade: 0.2 },
  series: [{ id: 'tm', type: 'treemap', name: '销售额', data: TREE as any }],
};

describe('矩形树图（纯函数层）', () => {
  it('sums children into the parent value', () => {
    expect(treemapNodeValue(TREE[0])).toBe(820);
    expect(treemapNodeValue(TREE[2])).toBe(240);
  });

  it('lays out nested rectangles inside the given rect', () => {
    const rect = { x: 0, y: 0, width: 600, height: 400 };
    const layout = layoutTreemap(TREE as any, rect, OPTION.treemap);
    expect(layout.length).toBe(8); // 3 个顶层 + 5 个子节点（华东 3 + 华北 2）
    for (const node of layout) {
      expect(node.rect.x).toBeGreaterThanOrEqual(rect.x - 1);
      expect(node.rect.y).toBeGreaterThanOrEqual(rect.y - 1);
      expect(node.rect.x + node.rect.width).toBeLessThanOrEqual(rect.x + rect.width + 1);
      expect(node.rect.y + node.rect.height).toBeLessThanOrEqual(rect.y + rect.height + 1);
      expect(node.rect.width).toBeGreaterThan(0);
    }
  });

  it('keeps children strictly inside their parent', () => {
    const rect = { x: 0, y: 0, width: 600, height: 400 };
    const layout = layoutTreemap(TREE as any, rect, OPTION.treemap);
    const byId = new Map(layout.map((n) => [n.id, n]));
    for (const node of layout) {
      if (node.parent < 0) continue;
      const parent = byId.get(node.parent)!;
      expect(node.rect.x).toBeGreaterThanOrEqual(parent.rect.x - 0.001);
      expect(node.rect.y).toBeGreaterThanOrEqual(parent.rect.y - 0.001);
      expect(node.rect.x + node.rect.width).toBeLessThanOrEqual(parent.rect.x + parent.rect.width + 0.001);
      expect(node.rect.y + node.rect.height).toBeLessThanOrEqual(parent.rect.y + parent.rect.height + 0.001);
    }
  });

  it('computes ratios that add up to 1 across the leaves', () => {
    const layout = layoutTreemap(TREE as any, { x: 0, y: 0, width: 600, height: 400 }, OPTION.treemap);
    const leaves = layout.filter((n) => !n.hasChildren);
    const sum = leaves.reduce((acc, n) => acc + n.ratio, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('produces roughly squarish cells (squarified, not sliced)', () => {
    const layout = layoutTreemap(TREE as any, { x: 0, y: 0, width: 600, height: 400 }, OPTION.treemap);
    const leaves = layout.filter((n) => !n.hasChildren);
    let thin = 0;
    for (const leaf of leaves) {
      const ratio = Math.max(leaf.rect.width / leaf.rect.height, leaf.rect.height / leaf.rect.width);
      if (ratio > 6) thin++;
    }
    // squarified 的意义就是避免「又细又长」的切片
    expect(thin).toBe(0);
  });

  it('flattens points in the same order as the layout', () => {
    const norm = normalizeOption(OPTION);
    const layout = layoutTreemap(TREE as any, { x: 0, y: 0, width: 600, height: 400 }, OPTION.treemap);
    expect(norm.series[0].points.map((p) => p.name)).toEqual(layout.map((n) => n.name));
  });
});

describe('矩形树图（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 440;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  async function mount(): Promise<ICEChart> {
    chart = createChart(canvas, OPTION);
    await chart.render();
    return chart;
  }

  it('hits the deepest node under the pointer', async () => {
    const c = await mount();
    const tree: any = c.seriesComponents[0];
    const nodes: any[] = tree.treemap.layout;
    const leaf = nodes.find((n) => !n.hasChildren)!;
    const sx = c.layout.plot.x + (leaf.rect.x - c.layout.plot.x) + leaf.rect.width / 2;
    const sy = c.layout.plot.y + (leaf.rect.y - c.layout.plot.y) + leaf.rect.height / 2;
    expect(c.ice.hitTest(sx, sy)).toBe(tree);
    expect(c.controller.resolveTarget(sx, sy).index).toBe(leaf.id);
  });

  it('shows name, value and share in the tooltip', async () => {
    const c = await mount();
    const tree: any = c.seriesComponents[0];
    const nodes: any[] = tree.treemap.layout;
    const leaf = nodes.find((n) => !n.hasChildren)!;
    const sx = c.layout.plot.x + leaf.rect.x - c.layout.plot.x + leaf.rect.width / 2;
    const sy = c.layout.plot.y + leaf.rect.y - c.layout.plot.y + leaf.rect.height / 2;
    c.controller.handlePointerMove(sx, sy);
    const content = c.tooltip!.content!;
    expect(content.title).toBe(leaf.name);
    expect(content.rows[0].value).toMatch(/（\d+\.\d%）/);
  });

  it('keeps the layout in sync with the series points', async () => {
    const c = await mount();
    const tree: any = c.seriesComponents[0];
    const nodes: any[] = tree.treemap.layout;
    const points = c.norm.series[0].points;
    expect(nodes.map((n) => n.name)).toEqual(points.map((p) => p.name));
    // 每个节点都能给出像素锚点
    for (let i = 0; i < nodes.length; i++) {
      expect(tree.pixelAt(i)).not.toBeNull();
    }
  });
});
