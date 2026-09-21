import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';
import { crosshairGlideDuration } from '../../src/components/Crosshair';

const OPTION: ChartOption = {
  title: { text: '交互外观审计' },
  legend: { show: true, position: 'top' },
  tooltip: { trigger: 'axis' },
  crosshair: { show: true, axis: 'x', showAxisLabel: true },
  dataZoom: { start: 0, end: 100 },
  xAxis: { type: 'category', name: '日期' },
  yAxis: { name: '数量' },
  interaction: {
    hover: { enabled: true },
    zoom: { enabled: true, axes: 'x', wheel: true },
    pan: { enabled: true, axes: 'x' },
    brush: { enabled: true, axes: 'x', mode: 'select' },
    select: { enabled: true, mode: 'single' },
  },
  series: [
    { id: 'a', type: 'line', name: 'A', data: [120, 60, 200, 140, 90, 260, 180] },
    { id: 'b', type: 'bar', name: 'B', data: [40, 90, 60, 130, 70, 150, 100] },
  ],
};

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

function inside(inner: Rect, outer: Rect, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

describe('准星跟随时长（按距离缩放，不吃更新时间动画）', () => {
  it('小位移当帧就到（不会因为固定时长而追不上指针）', () => {
    expect(crosshairGlideDuration(2, 90)).toBe(16);
    expect(crosshairGlideDuration(10, 90)).toBe(16);
  });

  it('大跨度跳转有一段可见的滑动，但不超过上限', () => {
    expect(crosshairGlideDuration(150, 90)).toBe(30);
    expect(crosshairGlideDuration(1000, 90)).toBe(90);
  });

  it('followDuration = 0 时立即跟随', () => {
    expect(crosshairGlideDuration(500, 0)).toBe(0);
  });

});

describe('交互外观审计', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 440;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  async function mount(option: ChartOption = OPTION): Promise<ICEChart> {
    chart = createChart(canvas, option);
    await chart.render();
    return chart;
  }

  function pointScreen(c: ICEChart, seriesIndex: number, dataIndex: number): [number, number] {
    const pixel = c.seriesComponents[seriesIndex].pixelAt(dataIndex)!;
    return [c.layout.plot.x + pixel[0], c.layout.plot.y + pixel[1]];
  }

  /** 逐点扫悬停，逐步断言「没有越界、没有压住坐标轴标签、没有压住图例」。 */
  it('悬停扫描：提示框始终不越界、不压坐标轴标签、不压图例', async () => {
    const c = await mount();
    const canvasRect = c.layout.canvas;
    const legendItems = c.layout.legend ? c.layout.legend.items : [];
    const points = c.norm.series[0].points.length;
    for (let i = 0; i < points; i++) {
      const [sx, sy] = pointScreen(c, 0, i);
      c.controller.handlePointerMove(sx, sy);
      await c.render();
      const rect = c.tooltip!.lastRect;
      expect(rect).not.toBeNull();
      expect(inside(rect as Rect, canvasRect)).toBe(true);
      for (const chip of c.crosshair!.lastChipRects) {
        expect(overlaps(rect as Rect, chip)).toBe(false);
      }
      for (const item of legendItems) {
        expect(overlaps(rect as Rect, { x: item.x, y: item.y, width: item.width, height: item.height })).toBe(false);
      }
      // 高亮环必须落在绘图区内
      for (const mark of c.highlight!.hoverItems) {
        // x/y 是标记中心；贴边的点允许半个标记探出绘图区（与主流写法一致）
        const half = Math.max(mark.size || 0, mark.width || 0, mark.height || 0) / 2;
        const box = { x: mark.x - half, y: mark.y - half, width: half * 2, height: half * 2 };
        expect(inside(box, c.layout.plot, half + 1)).toBe(true);
      }
    }
  });

  it('贴底数据点的提示框翻到上方，不覆盖底部轴标签', async () => {
    const c = await mount({
      ...OPTION,
      series: [{ id: 'a', type: 'line', name: 'A', data: [100, 120, 90, 110, 95, 105, 100] }],
    });
    // 找一个贴近底部的点（数值最小）
    const points = c.norm.series[0].points;
    let minIndex = 0;
    points.forEach((p, i) => {
      if ((p.y || 0) < (points[minIndex].y || 0)) minIndex = i;
    });
    const [sx, sy] = pointScreen(c, 0, minIndex);
    c.controller.handlePointerMove(sx, sy);
    await c.render();
    const rect = c.tooltip!.lastRect as Rect;
    const plotBottom = c.layout.plot.y + c.layout.plot.height;
    expect(rect.y + rect.height).toBeLessThanOrEqual(plotBottom + 1);
    for (const chip of c.crosshair!.lastChipRects) {
      expect(overlaps(rect, chip)).toBe(false);
    }
  });

  it('缩放后悬停视觉跟随数据（准星不脱离曲线）', async () => {
    const c = await mount();
    const [sx, sy] = pointScreen(c, 0, 5);
    c.controller.handlePointerMove(sx, sy);
    await c.render();
    const beforeHover = c.controller.hover as any;
    expect(beforeHover).not.toBeNull();
    const xValue = beforeHover.kind === 'axis' ? beforeHover.column.xValue : beforeHover.item.point.xValue;
    const beforePixel = c.crosshair!.pixelX!;

    c.setDomain('x', [2, 6]);
    await c.render();
    const afterHover = c.controller.hover as any;
    expect(afterHover).not.toBeNull();
    const afterXValue = afterHover.kind === 'axis' ? afterHover.column.xValue : afterHover.item.point.xValue;
    expect(afterXValue).toBe(xValue);
    // 准星位置必须等于该数据点的新像素位置，而不是停在旧位置
    const expected = c.layout.plot.x + c.seriesComponents[0].pixelAt(5)![0];
    expect(c.crosshair!.pixelX!).toBeCloseTo(expected, 1);
    expect(c.crosshair!.pixelX!).not.toBeCloseTo(beforePixel, 1);
  });

  it('隐藏正在悬停的系列后，悬停视觉被清理（不留残影）', async () => {
    const c = await mount({
      ...OPTION,
      series: [
        { id: 'a', type: 'line', name: 'A', data: [120, 60, 200, 140, 90, 260, 180] },
        { id: 'b', type: 'line', name: 'B', data: [40, 90, 60, 130, 70, 150, 100] },
      ],
      tooltip: { trigger: 'item' },
    });
    const [sx, sy] = pointScreen(c, 0, 3);
    c.controller.handlePointerMove(sx, sy);
    await c.render();
    expect(c.tooltip!.lastRect).not.toBeNull();
    c.toggleSeries('a');
    await c.render();
    expect(c.tooltip!.lastRect).toBeNull();
    expect(c.crosshair!.pixelX).toBeNull();
    expect(c.highlight!.hoverItems).toHaveLength(0);
  });

  it('框选拖动期间收起悬停视觉，松手后恢复', async () => {
    const c = await mount();
    const plot = c.layout.plot;
    const [sx, sy] = pointScreen(c, 0, 3);
    c.controller.handlePointerMove(sx, sy);
    await c.render();
    expect(c.tooltip!.lastRect).not.toBeNull();

    c.controller.handlePointerDown(plot.x + plot.width * 0.15, plot.y + plot.height * 0.5);
    c.controller.handlePointerMove(plot.x + plot.width * 0.45, plot.y + plot.height * 0.5);
    await c.render();
    expect(c.tooltip!.lastRect).toBeNull();
    expect(c.brushComponent!.rect).not.toBeNull();

    c.controller.handlePointerUp(plot.x + plot.width * 0.45, plot.y + plot.height * 0.5);
    await c.render();
    // 松手后按指针位置重新取悬停，提示框回来且仍在画布内
    expect(c.tooltip!.lastRect).not.toBeNull();
    expect(inside(c.tooltip!.lastRect as Rect, c.layout.canvas)).toBe(true);
  });

  it('拖 dataZoom 滑块时机提示框让位，松手后回到绘图区', async () => {
    const c = await mount();
    const rect = c.layout.slider!;
    const midY = rect.y + rect.height / 2;
    const [sx, sy] = pointScreen(c, 0, 3);
    c.controller.handlePointerMove(sx, sy);
    await c.render();

    c.controller.handlePointerDown(rect.x + rect.width * 0.3, midY);
    c.controller.handlePointerMove(rect.x + rect.width * 0.5, midY);
    await c.render();
    expect(c.tooltip!.lastRect).toBeNull();

    c.controller.handlePointerUp(rect.x + rect.width * 0.5, midY);
    await c.render();
    if (c.tooltip!.lastRect) {
      expect(inside(c.tooltip!.lastRect, c.layout.canvas)).toBe(true);
    }
    expect(c.dataZoomSlider!.activePart).toBeNull();
  });

  it('图例悬停高亮与提示框互斥（不会同时出现）', async () => {
    const c = await mount();
    const [sx, sy] = pointScreen(c, 0, 2);
    c.controller.handlePointerMove(sx, sy);
    await c.render();
    expect(c.tooltip!.lastRect).not.toBeNull();

    const item = c.layout.legend!.items[0];
    c.controller.handlePointerMove(item.x + item.width / 2, item.y + item.height / 2);
    await c.render();
    expect(c.tooltip!.content).toBeNull();
    expect(c.legend!.hoverIndex).toBe(0);
  });

  it('interaction.hover.mark = false 时不画悬停标记（只留准星）', async () => {
    // 标记环是一圈半透明白填充：落在蜡烛上会遮住正要看的那一根，
    // 而 axis 悬停时同一列里每个系列各画一个。只做十字准星的场景要能关掉。
    const marked = await mount(OPTION);
    marked.controller.handlePointerMove(...pointScreen(marked, 0, 3));
    expect(marked.highlight!.hoverItems.length).toBeGreaterThan(0);

    marked.destroy();
    chart = null;
    const plain = await mount({
      ...OPTION,
      interaction: { ...OPTION.interaction, hover: { enabled: true, mark: false } },
    });
    plain.controller.handlePointerMove(...pointScreen(plain, 0, 3));
    // 悬停本身照常生效（准星在），只是不画标记
    expect(plain.controller.hover).not.toBeNull();
    expect(plain.crosshair!.pixelX).not.toBeNull();
    expect(plain.highlight!.hoverItems).toHaveLength(0);
  });

  it('准星跟随时长与 animation.update.duration 无关（默认 90ms）', async () => {
    const c = await mount({ ...OPTION, animation: { update: { duration: 420 } } });
    expect(c.crosshair!.followDuration).toBe(90);
  });

  it('crosshair.followDuration 可覆盖（0 = 立即跟随）', async () => {
    const c = await mount({ ...OPTION, crosshair: { show: true, axis: 'x', followDuration: 0 } });
    expect(c.crosshair!.followDuration).toBe(0);
  });
});
