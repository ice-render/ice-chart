import { createChart } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import { forceLayout } from '../../src/layout/force';
import { shouldLabelGraphNode } from '../../src/layout/force';
import { placeGraphLabels } from '../../src/layout/force';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const GRAPH: ChartOption = {
  title: { text: '协作网络' },
  legend: { show: false },
  graph: {
    layout: 'force',
    repulsion: 5000,
    edgeLength: 60,
    iterations: 160,
    categories: [
      { name: '前端', color: '#0d6efd' },
      { name: '后端', color: '#198754' },
    ],
    nodes: [
      { id: 'a', name: '阿青', value: 10, category: '前端' },
      { id: 'b', name: '小白', value: 6, category: '前端' },
      { id: 'c', name: '老周', value: 12, category: '后端' },
      { id: 'd', name: '小李', value: 4, category: '后端' },
      { id: 'e', name: '小赵', value: 3, category: '前端' },
    ],
    links: [
      { source: 'a', target: 'c', value: 3 },
      { source: 'a', target: 'b', value: 1 },
      { source: 'c', target: 'd', value: 2 },
      { source: 'b', target: 'e', value: 1 },
    ],
  },
  series: [{ id: 'net', type: 'graph', name: '协作' }],
};

describe('力导向布局（纯函数层）', () => {
  const rect = { x: 0, y: 0, width: 600, height: 400 };

  it('is deterministic: the same input gives the same output', () => {
    const a = forceLayout(GRAPH.graph!.nodes, GRAPH.graph!.links, rect, GRAPH.graph!);
    const b = forceLayout(GRAPH.graph!.nodes, GRAPH.graph!.links, rect, GRAPH.graph!);
    expect(a.nodes.map((n) => [Math.round(n.x * 100), Math.round(n.y * 100)])).toEqual(
      b.nodes.map((n) => [Math.round(n.x * 100), Math.round(n.y * 100)])
    );
  });

  it('keeps every node inside the rect', () => {
    const layout = forceLayout(GRAPH.graph!.nodes, GRAPH.graph!.links, rect, GRAPH.graph!);
    for (const node of layout.nodes) {
      expect(node.x - node.size / 2).toBeGreaterThanOrEqual(rect.x - 0.5);
      expect(node.y - node.size / 2).toBeGreaterThanOrEqual(rect.y - 0.5);
      expect(node.x + node.size / 2).toBeLessThanOrEqual(rect.x + rect.width + 0.5);
      expect(node.y + node.size / 2).toBeLessThanOrEqual(rect.y + rect.height + 0.5);
    }
  });

  it('separates nodes (repulsion actually runs)', () => {
    const layout = forceLayout(GRAPH.graph!.nodes, GRAPH.graph!.links, rect, GRAPH.graph!);
    let minDistance = Infinity;
    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        const d = Math.hypot(layout.nodes[i].x - layout.nodes[j].x, layout.nodes[i].y - layout.nodes[j].y);
        if (d < minDistance) minDistance = d;
      }
    }
    // 环形初始铺开的相邻间距约 96，力学迭代后不应挤在一起
    expect(minDistance).toBeGreaterThan(20);
  });

  it('sizes nodes by weight and computes degrees', () => {
    const layout = forceLayout(GRAPH.graph!.nodes, GRAPH.graph!.links, rect, GRAPH.graph!);
    const qing = layout.nodes[0];
    const zhao = layout.nodes[4];
    expect(qing.size).toBeGreaterThan(zhao.size);
    expect(layout.nodes[2].degree).toBe(2);
    expect(layout.nodes[3].degree).toBe(1);
  });

  it('colors nodes by category', () => {
    const layout = forceLayout(GRAPH.graph!.nodes, GRAPH.graph!.links, rect, GRAPH.graph!);
    expect(layout.nodes[0].color).toBe('#0d6efd');
    expect(layout.nodes[2].color).toBe('#198754');
  });

  /**
   * 密集图（几十上百个节点）全标名字会糊成一片，所以给一个「只标主要节点」的口子。
   * 判据走纯函数，组件只负责调用 —— 画布桩是空实现，断不了「画了哪些文字」。
   */
  it('密集图可以只给主要节点标名（show / minSize）', () => {
    expect(shouldLabelGraphNode(20, undefined)).toBe(true);
    expect(shouldLabelGraphNode(20, { show: false })).toBe(false);
    expect(shouldLabelGraphNode(40, { minSize: 30 })).toBe(true);
    expect(shouldLabelGraphNode(20, { minSize: 30 })).toBe(false);
  });

  /**
   * 标签落点（2026-09-25）：189 个节点的关系图要给**每个人**都标名字，光靠调力参数排不开 ——
   * 实测同一组参数在不同环境里结果能差一个数量级（浏览器里挤成一团、Node 里铺得很开），
   * 把「名字能不能读」押在力参数上太脆。所以标签自己找位置：先试下方（旧行为），
   * 撞了就试上方 / 右侧 / 左侧，都不行才选重叠最少的那一侧。
   */
  describe('placeGraphLabels：给每个标签找不撞的位置', () => {
    const options = {
      box: { width: 400, height: 300 },
      lineHeight: 14,
      gap: 6,
      measure: (text: string) => text.length * 12,
    };
    const node = (name: string, x: number, y: number, size = 10) => ({ name, x, y, size });

    it('放得下时全在节点下方（与旧行为一致）', () => {
      const placed = placeGraphLabels([node('甲', 100, 100), node('乙', 300, 100)], options);
      expect(placed).toHaveLength(2);
      expect(placed[0].y).toBeGreaterThan(100);
      expect(placed[0].y).toBeCloseTo(100 + 5 + 6 + 7, 1);
      expect(placed[0].x).toBe(100);
    });

    it('下方放不下（贴盒底）就翻到上方', () => {
      const placed = placeGraphLabels([node('甲', 100, 294)], options);
      expect(placed[0].y).toBeLessThan(294);
    });

    it('上下都和别人撞了，就挪到左右', () => {
      // 三个节点竖向叠在一起：第 1、2 个占掉下方/上方，第 3 个只能去侧面
      const placed = placeGraphLabels(
        [node('甲', 100, 100), node('乙', 100, 101), node('丙', 100, 102)],
        options
      );
      const xs = placed.map((p) => p.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(10);
    });

    it('怎么放都撞时，选重叠最少的一侧且结果确定', () => {
      const nodes = [node('甲', 100, 100), node('乙', 100, 100), node('丙', 100, 100)];
      const a = placeGraphLabels(nodes, options);
      const b = placeGraphLabels(nodes, options);
      expect(a).toEqual(b);
      expect(a).toHaveLength(3);
    });
  });

  it('supports circular layout and explicit coordinates', () => {
    const circular = forceLayout(GRAPH.graph!.nodes, GRAPH.graph!.links, rect, { ...GRAPH.graph!, layout: 'circular' });
    const radius = Math.hypot(circular.nodes[0].x - 300, circular.nodes[0].y - 200);
    expect(radius).toBeGreaterThan(10);
    const fixed = forceLayout([{ name: 'A', x: 100, y: 120 }, { name: 'B', x: 400, y: 300 }], [], rect, {
      nodes: [],
      links: [],
      layout: 'none',
    });
    expect(fixed.nodes[0].x).toBeCloseTo(100, 0);
    expect(fixed.nodes[1].y).toBeCloseTo(300, 0);
  });
});

describe('关系图（引擎集成）', () => {
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
    chart = createChart(canvas, GRAPH);
    await chart.render();
    return chart;
  }

  it('builds points for nodes and links in layout order', async () => {
    const c = await mount();
    const norm = normalizeOption(GRAPH);
    const points = norm.series[0].points;
    expect(points).toHaveLength(5 + 4);
    expect(points[0].name).toBe('阿青');
    expect(points[5].name).toBe('阿青 → 老周');
    const component: any = c.seriesComponents[0];
    expect(component.graph.layout.nodes.map((n: any) => n.name)).toEqual(points.slice(0, 5).map((p) => p.name));
    void c;
  });

  it('hits a node and a link through the engine hit test', async () => {
    const c = await mount();
    const component: any = c.seriesComponents[0];
    const node = component.graph.layout.nodes[0];
    const sx = node.x;
    const sy = node.y;
    expect(c.ice.hitTest(sx, sy)).toBe(component);
    expect(c.controller.resolveTarget(sx, sy).index).toBe(0);

    // 连线中点（缓曲线取中点）
    const linkIndex = 5;
    const pixel = component.pixelAt(linkIndex)!;
    const lx = c.layout.plot.x + pixel[0];
    const ly = c.layout.plot.y + pixel[1];
    expect(c.controller.resolveTarget(lx, ly).index).toBe(linkIndex);
  });

  it('shows node weight/degree and link endpoints in the tooltip', async () => {
    const c = await mount();
    const component: any = c.seriesComponents[0];
    const node = component.graph.layout.nodes[0];
    c.controller.handlePointerMove(node.x, node.y);
    expect(c.tooltip!.content!.title).toBe('阿青');
    expect(c.tooltip!.content!.rows[0]).toMatchObject({ name: '权重' });
    expect(c.tooltip!.content!.rows[1]).toMatchObject({ name: '连接数', value: '2' });

    const pixel = component.pixelAt(5)!;
    c.controller.handlePointerMove(c.layout.plot.x + pixel[0], c.layout.plot.y + pixel[1]);
    expect(c.tooltip!.content!.title).toBe('阿青 → 老周');
  });

  it('drags a node and keeps it where it was dropped', async () => {
    const c = await mount();
    const component: any = c.seriesComponents[0];
    const before = { ...component.graph.layout.nodes[3] };
    const targetX = before.x + 120;
    const targetY = before.y + 60;
    c.controller.handlePointerDown(before.x, before.y);
    c.controller.handlePointerMove(targetX, targetY);
    c.controller.handlePointerUp(targetX, targetY);
    await c.render();
    const after = component.graph.layout.nodes[3];
    expect(Math.abs(after.x - targetX)).toBeLessThan(80);
    expect(Math.abs(after.y - targetY)).toBeLessThan(80);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(20);
    // 拖过的节点被固定住
    expect(after.fixed).toBe(true);
  });

  it('renders without a base map (pure nodes + links)', async () => {
    const c = await mount();
    expect(c.norm.kind).toBe('graph');
    expect(c.axisX.state.display).toBe(false);
    expect(c.grid.state.display).toBe(false);
    expect(c.radarGrid.state.display).toBe(false);
  });
});
