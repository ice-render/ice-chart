import { createChart } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import { computeLayout } from '../../src/layout/layout';
import { layoutSankey } from '../../src/layout/sankey';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const OPTION: ChartOption = {
  title: { text: '流量来源' },
  legend: { show: false },
  sankey: {
    nodes: [
      { name: '搜索' },
      { name: '社交' },
      { name: '首页' },
      { name: '详情页' },
      { name: '下单' },
      { name: '离开' },
    ],
    links: [
      { source: '搜索', target: '首页', value: 40 },
      { source: '搜索', target: '详情页', value: 25 },
      { source: '社交', target: '首页', value: 15 },
      { source: '社交', target: '离开', value: 10 },
      { source: '首页', target: '详情页', value: 30 },
      { source: '首页', target: '离开', value: 25 },
      { source: '详情页', target: '下单', value: 35 },
      { source: '详情页', target: '离开', value: 20 },
    ],
    nodeWidth: 16,
    nodePadding: 12,
  },
  series: [{ id: 'flow', type: 'sankey', name: '流量' }],
};

describe('桑基图（纯函数层）', () => {
  it('switches the scene to sankey', () => {
    const norm = normalizeOption(OPTION);
    expect(norm.kind).toBe('sankey');
    expect(norm.sankey).not.toBeNull();
  });

  it('builds points for nodes and links', () => {
    const norm = normalizeOption(OPTION);
    const points = norm.series[0].points;
    expect(points).toHaveLength(6 + 8);
    expect(points[0].name).toBe('搜索');
    expect(points[0].y).toBe(65); // 40 + 25
    expect(points[6].name).toBe('搜索 → 首页');
    expect((points[6].raw as any).__sankeyLink).toBe(true);
  });

  it('lays nodes out in columns by longest path', () => {
    const rect = { x: 0, y: 0, width: 600, height: 400 };
    const layout = layoutSankey(OPTION.sankey!.nodes, OPTION.sankey!.links, rect, OPTION.sankey!);
    const depthOf = (name: string) => layout.nodes.find((n) => n.name === name)!.depth;
    expect(depthOf('搜索')).toBe(0);
    expect(depthOf('首页')).toBe(1);
    expect(depthOf('详情页')).toBe(2);
    expect(depthOf('下单')).toBe(3);
    // 同层节点不重叠
    const first = layout.nodes.filter((n) => n.depth === 0).sort((a, b) => a.y - b.y);
    for (let i = 1; i < first.length; i++) {
      expect(first[i].y).toBeGreaterThanOrEqual(first[i - 1].y + first[i - 1].height);
    }
  });

  it('keeps links inside the rect and thickness proportional to value', () => {
    const rect = { x: 0, y: 0, width: 600, height: 400 };
    const layout = layoutSankey(OPTION.sankey!.nodes, OPTION.sankey!.links, rect, OPTION.sankey!);
    for (const node of layout.nodes) {
      expect(node.y).toBeGreaterThanOrEqual(-0.5);
      expect(node.y + node.height).toBeLessThanOrEqual(rect.height + 0.5);
      expect(node.x).toBeGreaterThanOrEqual(-0.5);
      expect(node.x + node.width).toBeLessThanOrEqual(rect.width + 0.5);
    }
    for (const link of layout.links) {
      expect(link.width).toBeGreaterThan(0);
    }
    const thick = layout.links.find((l) => l.value === 40)!;
    const thin = layout.links.find((l) => l.value === 10)!;
    expect(thick.width).toBeGreaterThan(thin.width);
  });

  it('reserves no axis space for the sankey scene', () => {
    const norm = normalizeOption(OPTION);
    const layout = computeLayout(norm, null, { x: 0, y: 0, width: 600, height: 400 });
    expect(layout.polar).toBeNull();
    expect(layout.plot.width).toBeGreaterThan(500);
  });
});

describe('桑基图（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 700;
    canvas.height = 440;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  /**
   * 每张图都给一份**自己的** option：拖拽重排会把 `nodeOrder` 就地写回传入的 option
   * （与 `appendData` 同一条口径），共用模块级常量会让用例之间互相污染。
   */
  function freshOption(): ChartOption {
    return JSON.parse(JSON.stringify(OPTION)) as ChartOption;
  }

  async function mount(option?: ChartOption): Promise<ICEChart> {
    chart = createChart(canvas, option || freshOption());
    await chart.render();
    return chart;
  }

  /** 某一列里从上到下的节点名（读的是**渲染用的布局**，不是输入顺序）。 */
  function columnNames(c: ICEChart, depth: number): string[] {
    const component: any = c.seriesComponents[0];
    return (component.sankey.layout.nodes as Array<{ name: string; depth: number; y: number }>)
      .filter((node) => node.depth === depth)
      .sort((a, b) => a.y - b.y)
      .map((node) => node.name);
  }

  /** 第 index 个节点的中心（画布坐标）——拖拽入参就是画布 CSS 像素。 */
  function nodeCenter(c: ICEChart, index: number): [number, number] {
    const component: any = c.seriesComponents[0];
    const pixel = component.pixelAt(index)!;
    return [c.layout.plot.x + pixel[0], c.layout.plot.y + pixel[1]];
  }

  it('hits a node through the engine hit test', async () => {
    const c = await mount();
    const component = c.seriesComponents[0];
    const nodePixel = component.pixelAt(0)!;
    const sx = c.layout.plot.x + nodePixel[0];
    const sy = c.layout.plot.y + nodePixel[1];
    expect(c.ice.hitTest(sx, sy)).toBe(component);
    expect(c.controller.resolveTarget(sx, sy).index).toBe(0);
  });

  it('hits a link and reports source → target', async () => {
    const c = await mount();
    const component = c.seriesComponents[0];
    const linkIndex = c.norm.sankey!.nodes.length + 0;
    const pixel = component.pixelAt(linkIndex)!;
    const sx = c.layout.plot.x + pixel[0];
    const sy = c.layout.plot.y + pixel[1];
    const target = c.controller.resolveTarget(sx, sy);
    expect(target.kind).toBe('series');
    expect(target.index).toBe(linkIndex);
    c.controller.handlePointerMove(sx, sy);
    expect(c.tooltip!.content!.title).toBe('搜索 → 首页');
    expect(c.tooltip!.content!.rows[0].value).toBe('40');
  });

  it('shows the node total in the tooltip', async () => {
    const c = await mount();
    const component = c.seriesComponents[0];
    const nodePixel = component.pixelAt(2)!;
    c.controller.handlePointerMove(c.layout.plot.x + nodePixel[0], c.layout.plot.y + nodePixel[1]);
    expect(c.tooltip!.content!.title).toBe('节点');
    // 首页：入 40+15=55，出 30+25=55 → 取较大者 55
    expect(c.tooltip!.content!.rows[0]).toMatchObject({ name: '首页', value: '55' });
  });

  it('hides cartesian axes and the radar grid', async () => {
    const c = await mount();
    expect(c.axisX.state.display).toBe(false);
    expect(c.axisYList[0].state.display).toBe(false);
    expect(c.grid.state.display).toBe(false);
    expect(c.radarGrid.state.display).toBe(false);
  });

  it('drags a node above its neighbor and writes the new column order back to the option', async () => {
    const c = await mount();
    // 拖**矮**的那个（社交）：节点是被夹在绘图区里的，只有中心能越过邻居时才换得过来
    const [x, y1] = nodeCenter(c, 1);
    const events: any[] = [];
    c.on('sankey:reorder', (payload: any) => events.push(payload));
    expect(columnNames(c, 0)).toEqual(['搜索', '社交']);

    c.controller.handlePointerDown(x, y1);
    c.controller.handlePointerMove(x, c.layout.plot.y - 200);
    c.controller.handlePointerUp(x, c.layout.plot.y - 200);
    await c.render();

    expect(columnNames(c, 0)).toEqual(['社交', '搜索']);
    expect(c.getOption().sankey!.nodeOrder).toEqual(['社交', '搜索']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ nodeIndex: 1, nodeName: '社交', column: 0 });
    expect(events[0].order).toEqual(['社交', '搜索']);
  });

  it('leaves the order alone when the node is dragged back where it started', async () => {
    const c = await mount();
    const [x, y1] = nodeCenter(c, 1);
    const events: any[] = [];
    c.on('sankey:reorder', (payload: any) => events.push(payload));

    c.controller.handlePointerDown(x, y1);
    c.controller.handlePointerMove(x, c.layout.plot.y - 200);
    c.controller.handlePointerMove(x, y1);
    c.controller.handlePointerUp(x, y1);
    await c.render();

    expect(columnNames(c, 0)).toEqual(['搜索', '社交']);
    // 拖出去又拖回来 = 没动过：不留一次「隐形钉住」，也不发事件
    expect(c.getOption().sankey!.nodeOrder).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('keeps the node inside the plot when it is dragged far past the top', async () => {
    const c = await mount();
    const [x, y1] = nodeCenter(c, 1);

    c.controller.handlePointerDown(x, y1);
    c.controller.handlePointerMove(x, c.layout.plot.y - 400);
    c.controller.handlePointerUp(x, c.layout.plot.y - 400);
    await c.render();

    const component: any = c.seriesComponents[0];
    const node = component.sankey.layout.nodes[1];
    expect(node.y).toBeGreaterThanOrEqual(c.layout.plot.y - 0.5);
    expect(node.y + node.height).toBeLessThanOrEqual(c.layout.plot.y + c.layout.plot.height + 0.5);
    expect(columnNames(c, 0)).toEqual(['社交', '搜索']);
  });

  it('does not reorder when sankey.draggable is false', async () => {
    const c = await mount({ ...freshOption(), sankey: { ...(freshOption().sankey as any), draggable: false } });
    const [x, y0] = nodeCenter(c, 0);
    const [, y1] = nodeCenter(c, 1);
    const events: any[] = [];
    c.on('sankey:reorder', (payload: any) => events.push(payload));

    c.controller.handlePointerDown(x, y0);
    c.controller.handlePointerMove(x, y1 + 30);
    c.controller.handlePointerUp(x, y1 + 30);
    await c.render();

    expect(columnNames(c, 0)).toEqual(['搜索', '社交']);
    expect(c.getOption().sankey!.nodeOrder).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('keeps the dragged order through a snapshot round-trip', async () => {
    const c = await mount();
    const [x, y1] = nodeCenter(c, 1);
    c.controller.handlePointerDown(x, y1);
    c.controller.handlePointerMove(x, c.layout.plot.y - 200);
    c.controller.handlePointerUp(x, c.layout.plot.y - 200);
    await c.render();

    const canvas2 = document.createElement('canvas');
    canvas2.width = 700;
    canvas2.height = 440;
    const restored = createChart(canvas2, c.toJSON());
    await restored.render();
    const component: any = restored.seriesComponents[0];
    const names = (component.sankey.layout.nodes as Array<{ name: string; depth: number; y: number }>)
      .filter((node) => node.depth === 0)
      .sort((a, b) => a.y - b.y)
      .map((node) => node.name);
    expect(names).toEqual(['社交', '搜索']);
    restored.destroy();
  });
});
