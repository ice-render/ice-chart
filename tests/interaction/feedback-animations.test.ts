import { createChart, setMotionPreference } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/**
 * 交互反馈动画：悬停放大、提示框淡入淡出、准星平滑跟随、桑基流动、树图形变。
 *
 * 这些动画都由组件自己驱动引擎的 AnimationManager，所以断言必须看**渲染态**
 * （barDrawRectAt / highlightRectAt / panelOpacity …），不能只看源数据 ——
 * 源数据在动画开始前就是终态了，看它永远「通过」。
 */

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BAR_OPTION: ChartOption = {
  legend: { show: false },
  animation: { enter: { duration: 60, easing: 'linear' }, update: { duration: 60, easing: 'linear' } },
  xAxis: { type: 'category' },
  yAxis: {},
  series: [{ id: 'bar', type: 'bar', name: '销量', data: [40, 90, 60, 130, 70] }],
};

const TREEMAP_OPTION: ChartOption = {
  legend: { show: false },
  animation: { enter: { duration: 60 }, update: { duration: 400, easing: 'linear' } },
  treemap: { gap: 2 },
  series: [
    {
      id: 'tm',
      type: 'treemap',
      name: '销售额',
      data: [
        { name: 'A', children: [{ name: 'A1', value: 400 }, { name: 'A2', value: 200 }] },
        { name: 'B', children: [{ name: 'B1', value: 300 }, { name: 'B2', value: 100 }] },
      ] as any,
    },
  ],
};

describe('交互反馈动画', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    setMotionPreference('full');
    canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 400;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    setMotionPreference('instant');
  });

  async function mount(option: ChartOption): Promise<ICEChart> {
    chart = createChart(canvas, option);
    await chart.render();
    chart.finishAnimations();
    await chart.render();
    return chart;
  }

  function hoverBar(c: ICEChart, index: number): void {
    const pixel = c.seriesComponents[0].pixelAt(index)!;
    c.controller.handlePointerMove(c.layout.plot.x + pixel[0], c.layout.plot.y + pixel[1]);
  }

  it('悬停柱子：柱子被拉长，移开后回落到原始高度', async () => {
    const c = await mount(BAR_OPTION);
    const component: any = c.seriesComponents[0];
    const baseHeight = component.barRectAt(2)!.height;
    expect(component.hoverIndex).toBeNull();
    expect(component.highlightT()).toBe(0);

    hoverBar(c, 2);
    await c.render();
    expect(component.hoverIndex).toBe(2);
    // 反馈是补间出来的，不是硬切：刚进入时还没到 1
    expect(component.highlightT()).toBeLessThan(1);

    await wait(400);
    await c.render();
    expect(component.highlightT()).toBeGreaterThan(0.9);
    expect(component.barDrawRectAt(2)!.height).toBeGreaterThan(baseHeight);
    // 未被悬停的柱子不受影响
    expect(component.barDrawRectAt(0)!.height).toBeCloseTo(component.barRectAt(0)!.height, 6);
    // 锚在基线：柱子只向上长，底边不动
    const base = component.barRectAt(2)!;
    const grown = component.barDrawRectAt(2)!;
    expect(grown.y + grown.height).toBeCloseTo(base.y + base.height, 6);

    // 移开（清理悬停视觉）→ 反馈回落
    (c.controller as any).clearHoverVisuals();
    await c.render();
    expect(component.hoverIndex).toBeNull();
    await wait(400);
    await c.render();
    expect(component.highlightT()).toBeLessThan(0.05);
    expect(component.barDrawRectAt(2)!.height).toBeCloseTo(baseHeight, 3);
  });

  it('数据更新时不丢悬停（实时刷新场景：仪表盘 / 监控）', async () => {
    const c = await mount({ ...BAR_OPTION, tooltip: { trigger: 'item' } } as ChartOption);
    hoverBar(c, 2);
    await c.render();
    expect(c.controller.hover).not.toBeNull();
    expect(c.tooltip!.lastRect).not.toBeNull();

    // 模拟实时刷新：同一个下标换了数值
    c.setData('bar', [40, 90, 200, 130, 70] as any);
    await c.render();

    const hover: any = c.controller.hover;
    expect(hover).not.toBeNull();
    expect(hover.kind).toBe('item');
    expect(hover.item.point.index).toBe(2);
    // 悬停的是**新**数据，不是上一轮的快照
    expect(hover.item.point.y).toBe(200);
    expect(c.seriesComponents[0].hoverIndex).toBe(2);
    expect(c.tooltip!.lastRect).not.toBeNull();
  });

  it('非直角坐标场景数据更新也不丢悬停（雷达 / 饼图的 axis 悬停）', async () => {
    const c = await mount({
      legend: { show: false },
      tooltip: { trigger: 'axis' }, // 显式 axis：雷达上「同一指标」的对比是有意义的
      radar: {
        indicators: [
          { name: '算力', max: 100 },
          { name: '存储', max: 100 },
          { name: '带宽', max: 100 },
        ],
      },
      series: [
        { id: 'east', type: 'radar', name: '华东', data: [80, 70, 90] },
        { id: 'north', type: 'radar', name: '华北', data: [60, 85, 75] },
      ],
    } as ChartOption);
    const component: any = c.seriesComponents[0];
    const pixel = component.pixelAt(0)!;
    c.controller.handlePointerMove(component.state.left + pixel[0], component.state.top + pixel[1]);
    await c.render();
    expect(c.controller.hover).not.toBeNull();

    c.setData('east', [55, 65, 75]);
    await c.render();
    const hover: any = c.controller.hover;
    // 关键：数据更新后悬停仍在（以前非直角坐标会被直接清空），且拿到的是新值
    expect(hover).not.toBeNull();
    expect(hover.kind).toBe('axis');
    expect(hover.column.items[0].point.y).toBe(55);
  });

  it('提示框淡入出现、淡出后才清空内容（不是瞬间消失）', async () => {
    const c = await mount(BAR_OPTION);
    const tooltip = c.tooltip!;
    expect(tooltip.lastRect).toBeNull();

    hoverBar(c, 1);
    await c.render();
    // 刚出现：还没到全不透明
    expect(tooltip.panelOpacity()).toBeLessThan(1);
    await wait(300);
    await c.render();
    expect(tooltip.panelOpacity()).toBeCloseTo(1, 2);
    expect(tooltip.lastRect).not.toBeNull();

    (c.controller as any).clearHoverVisuals();
    await c.render();
    await wait(50);
    await c.render();
    // 淡出期间透明度在下降、内容还在（否则就是硬消失）
    expect(tooltip.panelOpacity()).toBeLessThan(1);
    expect(tooltip.lastRect).not.toBeNull();
    await wait(300);
    await c.render();
    expect(tooltip.lastRect).toBeNull();
  });

  it('淡出途中重新悬停，提示框会重新淡入而不是停在半透明', async () => {
    const c = await mount(BAR_OPTION);
    const tooltip = c.tooltip!;
    hoverBar(c, 1);
    await c.render();
    await wait(300);

    (c.controller as any).clearHoverVisuals();
    await c.render();
    await wait(40);
    await c.render();
    const mid = tooltip.panelOpacity();
    expect(mid).toBeLessThan(1);

    hoverBar(c, 3);
    await c.render();
    await wait(300);
    await c.render();
    expect(tooltip.panelOpacity()).toBeCloseTo(1, 2);
    expect(tooltip.lastRect).not.toBeNull();
  });

  it('准星跟随：大跨度有滑动，小位移当帧就到（不会追不上指针）', async () => {
    const c = await mount({
      ...BAR_OPTION,
      // 更新时间动画给到 600ms：准星**不该**被它拖慢（这正是用户看到「准星飘」的根因）
      animation: { enter: { duration: 60 }, update: { duration: 600, easing: 'linear' } },
      tooltip: { trigger: 'axis' },
      crosshair: { show: true, axis: 'x', showAxisLabel: true },
    } as ChartOption);
    const crosshair = c.crosshair!;
    hoverBar(c, 0);
    await c.render();
    const first = crosshair.pixelX!;
    expect(crosshair.state.axisX as number).toBeCloseTo(first, 1);

    hoverBar(c, 4);
    await c.render();
    const target = c.seriesComponents[0].pixelAt(4)![0] + c.layout.plot.x;
    expect(crosshair.pixelX).toBeCloseTo(target, 3);
    // 大跨度（跨了 4 列）：补间在飞行中，绘制位置严格落在起点与目标之间
    await wait(20);
    await c.render();
    const drawn = crosshair.state.axisX as number;
    expect(drawn).toBeGreaterThan(first);
    expect(drawn).toBeLessThan(target);

    // 收敛有上界：跟随时长按距离缩放、上限 90ms，300ms 足够
    await wait(300);
    await c.render();
    expect(crosshair.state.axisX as number).toBeCloseTo(target, 1);

    // 相邻列的小位移：一个采样周期内就落位（旧实现每次 mousemove 重启 420ms 补间，永远追不上）
    const from = crosshair.state.axisX as number;
    hoverBar(c, 3);
    await c.render();
    const next = c.seriesComponents[0].pixelAt(3)![0] + c.layout.plot.x;
    expect(Math.abs(next - from)).toBeGreaterThan(10); // 确实是另一个列
    await wait(40);
    await c.render();
    expect(crosshair.state.axisX as number).toBeCloseTo(next, 1);
  });

  it('桑基图 flow:true 会持续重绘，flow 关闭时不占帧循环', async () => {
    const base: ChartOption = {
      legend: { show: false },
      sankey: {
        nodes: [{ name: 'A' }, { name: 'B' }],
        links: [{ source: 'A', target: 'B', value: 10 }],
      },
      series: [{ id: 's', type: 'sankey', name: '流量' }],
    };
    const c = await mount({ ...base, sankey: { ...base.sankey, flow: true } });
    const flowing: any = c.seriesComponents[0];
    expect(flowing.loopRegistered).toBe(true);
    expect(flowing.props.animations.__tick).toBeTruthy();

    // 同一张画布不能挂两张图：换一块画布验证关闭 flow 的对照
    c.destroy();
    chart = null;
    const canvas2 = document.createElement('canvas');
    canvas2.width = 720;
    canvas2.height = 400;
    document.body.appendChild(canvas2);
    const c2 = createChart(canvas2, { ...base, sankey: { ...base.sankey, flow: false } });
    await c2.render();
    const still: any = c2.seriesComponents[0];
    expect(still.loopRegistered).toBeFalsy();
    c2.destroy();
    canvas2.remove();
  });

  it('树图数据更新：矩形在旧布局与新布局之间形变，中途无空隙且子节点不越出父节点', async () => {
    const c = await mount(TREEMAP_OPTION);
    const component: any = c.seriesComponents[0];
    const nodeCount = c.norm.series[0].points.length;
    const before = Array.from({ length: nodeCount }, (_, i) => component.highlightRectAt(i)!);

    c.setData('tm', [
      { name: 'A', children: [{ name: 'A1', value: 100 }, { name: 'A2', value: 500 }] },
      { name: 'B', children: [{ name: 'B1', value: 100 }, { name: 'B2', value: 300 }] },
    ] as any);
    await c.render();
    await wait(150);
    await c.render();
    expect(component.progress()).toBeGreaterThan(0);
    expect(component.progress()).toBeLessThan(1);
    const mid = Array.from({ length: nodeCount }, (_, i) => component.highlightRectAt(i)!);

    // 至少有一个节点的渲染矩形既不是旧值也不是新值（确实在形变）
    const changed = mid.filter((rect, i) => Math.abs(rect.width - before[i].width) > 0.5);
    expect(changed.length).toBeGreaterThan(0);

    // 形变中途：子节点必须仍然待在自己父节点的矩形里（不能露缝/错位）
    const layout = component.treemap.layout;
    for (let i = 0; i < layout.length; i++) {
      const node = layout[i];
      if (node.parent < 0) continue;
      const child = mid[i];
      const parent = mid[node.parent];
      expect(child.x).toBeGreaterThanOrEqual(parent.x - 0.5);
      expect(child.y).toBeGreaterThanOrEqual(parent.y - 0.5);
      expect(child.x + child.width).toBeLessThanOrEqual(parent.x + parent.width + 0.5);
      expect(child.y + child.height).toBeLessThanOrEqual(parent.y + parent.height + 0.5);
    }

    await wait(600);
    await c.render();
    expect(component.progress()).toBe(1);
    const after = Array.from({ length: nodeCount }, (_, i) => component.highlightRectAt(i)!);
    expect(after.some((rect, i) => Math.abs(rect.width - before[i].width) > 1)).toBe(true);
  });

  describe('逐类型悬停反馈接线', () => {
    /** 把指针移到某个数据项的像素位置（组件盒 + 本地像素）。 */
    async function hoverItem(c: ICEChart, seriesIndex: number, dataIndex: number, label = ''): Promise<void> {
      const component = c.seriesComponents[seriesIndex] as any;
      const pixel = component.pixelAt(dataIndex);
      if (!pixel) throw new Error(`${label} pixelAt(${dataIndex}) 为 null`);
      c.controller.handlePointerMove(component.state.left + pixel[0], component.state.top + pixel[1]);
      await c.render();
      await wait(420);
      await c.render();
    }

    it('漏斗：悬停那一级向两侧摊开（命中宽度同步放大）', async () => {
      const c = await mount({
        legend: { show: false },
        series: [
          {
            id: 'f',
            type: 'funnel',
            name: 'F',
            data: [
              { name: '曝光', value: 1000 },
              { name: '点击', value: 620 },
              { name: '下单', value: 120 },
            ],
          },
        ],
      } as ChartOption);
      const component: any = c.seriesComponents[0];
      await hoverItem(c, 0, 1);
      expect(component.hoverIndex).toBe(1);
      expect(component.hoverBoost(1, 0.06)).toBeGreaterThan(1);
      // 未被悬停的那一级不变
      expect(component.hoverBoost(0, 0.06)).toBe(1);
    });

    it('关系图：悬停节点鼓起来，高亮环半径跟着长（边缘不会抖）', async () => {
      const c = await mount({
        legend: { show: false },
        graph: {
          nodes: [
            { id: 'a', name: 'A', value: 10 },
            { id: 'b', name: 'B', value: 6 },
            { id: 'c', name: 'C', value: 4 },
          ],
          links: [
            { source: 'a', target: 'b', value: 2 },
            { source: 'b', target: 'c', value: 1 },
          ],
        },
        series: [{ id: 'g', type: 'graph', name: 'G' }],
      } as ChartOption);
      const component: any = c.seriesComponents[0];
      const before = component.nodeSizeAt(0);
      await hoverItem(c, 0, 0);
      expect(component.hoverIndex).toBe(0);
      expect(component.nodeSizeAt(0)).toBeGreaterThan(before);
      // 放大后的半径仍在命中范围内（不会「指针停下就丢悬停」）
      const pixel = component.pixelAt(0)!;
      const radius = (component.graph.layout.nodes[0].size / 2) * component.hoverBoost(0, 0.28);
      expect(component.hitTestIndex(pixel[0] + radius - 1, pixel[1])).toBe(0);
    });

    it('紧挨着的图元（热力图 / 箱线图 / 树图）用叠加高亮，不自作主张改几何', async () => {
      const cases: Array<{ name: string; option: ChartOption; index: number }> = [
        {
          name: 'heatmap',
          index: 0,
          option: {
            legend: { show: false },
            xAxis: { type: 'category' },
            yAxis: { type: 'category' },
            series: [
              {
                id: 'h',
                type: 'heatmap',
                name: 'H',
                data: [
                  ['一', '甲', 1],
                  ['一', '乙', 2],
                  ['二', '甲', 3],
                  ['二', '乙', 4],
                  ['三', '甲', 5],
                ],
              } as any,
            ],
          },
        },
        {
          name: 'boxplot',
          index: 1,
          option: {
            legend: { show: false },
            xAxis: { type: 'category' },
            yAxis: {},
            series: [
              {
                id: 'b',
                type: 'boxplot',
                name: 'B',
                data: [
                  [120, 200, 260, 340, 520],
                  [90, 150, 210, 280, 610],
                ],
              },
            ],
          },
        },
        {
          name: 'treemap',
          index: 1,
          option: {
            legend: { show: false },
            series: [
              {
                id: 't',
                type: 'treemap',
                name: 'T',
                data: [
                  { name: 'A', value: 300 },
                  { name: 'B', value: 200 },
                ],
              },
            ],
          },
        },
      ];
      for (const testCase of cases) {
        const c = await mount(testCase.option);
        const component: any = c.seriesComponents[0];
        await hoverItem(c, 0, testCase.index, testCase.name);
        expect({ type: testCase.name, hoverIndex: component.hoverIndex }).toEqual({
          type: testCase.name,
          hoverIndex: testCase.index,
        });
        // 叠加层强度已经推进起来（真正参与绘制的值，不是只看 hoverIndex）
        expect(component.hoverAlpha(testCase.index)).toBeGreaterThan(0.6);
        // 未悬停的图元不会被叠加
        expect(component.hoverAlpha(testCase.index === 0 ? 1 : 0)).toBe(0);
        c.destroy();
        chart = null;
      }
    });
  });
});
