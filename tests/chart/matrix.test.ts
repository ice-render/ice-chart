import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/** 2×3 面板：六个面板各一条折线，数据形状不同以便分辨。 */
function matrixOption(seriesCount = 6): ChartOption {
  return {
    legend: { show: false },
    xAxis: { type: 'category', data: ['一', '二', '三', '四'] },
    yAxis: { name: '销量' },
    matrix: { rows: 2, columns: 3, gap: 8 },
    animation: { enabled: false },
    series: Array.from({ length: seriesCount }, (_, i) => ({
      id: `s${i}`,
      type: 'line' as const,
      name: `面板 ${i + 1}`,
      panel: i,
      data: [1 + i, 3 + i, 2 + i, 4 + i],
    })),
  };
}

describe('面板矩阵（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 520;
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

  it('每个面板的系列组件盒 = 该面板矩形', async () => {
    const c = await mount(matrixOption());
    const panels = c.layout.panels;
    expect(panels).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      const component = c.seriesComponents[i];
      expect(component.state.left).toBeCloseTo(panels[i].x, 6);
      expect(component.state.top).toBeCloseTo(panels[i].y, 6);
      expect(component.state.width).toBeCloseTo(panels[i].width, 6);
      expect(component.state.height).toBeCloseTo(panels[i].height, 6);
    }
  });

  it('同一数据值在不同面板里像素不同，但数据下标与数据值一致', async () => {
    const c = await mount(matrixOption());
    const first: any = c.seriesComponents[0];
    const sixth: any = c.seriesComponents[5];
    expect(sixth.series.pointAt(1).xValue).toEqual(first.series.pointAt(1).xValue);
    const a = first.pixelAt(1)!;
    const b = sixth.pixelAt(1)!;
    // 两个面板的 x range 相同（同宽），所以横向落点一致；纵向因为数据不同而不同
    expect(a[0]).toBeCloseTo(b[0], 6);
    expect(a[1]).not.toBeCloseTo(b[1], 3);
  });

  it('每个面板的像素都落在自己的盒子里（局部坐标 0..宽高）', async () => {
    const c = await mount(matrixOption());
    for (let i = 0; i < 6; i++) {
      const component: any = c.seriesComponents[i];
      const panel = c.layout.panels[i];
      for (let k = 0; k < 4; k++) {
        const pixel = component.pixelAt(k)!;
        expect(pixel[0]).toBeGreaterThanOrEqual(-0.5);
        expect(pixel[0]).toBeLessThanOrEqual(panel.width + 0.5);
        expect(pixel[1]).toBeGreaterThanOrEqual(-0.5);
        expect(pixel[1]).toBeLessThanOrEqual(panel.height + 0.5);
      }
    }
  });

  it('网格按面板各画一份', async () => {
    const c = await mount(matrixOption());
    const grids: any = (c as any).grids;
    expect(grids).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(grids[i].plot.x).toBeCloseTo(c.layout.panels[i].x, 6);
      expect(grids[i].plot.width).toBeCloseTo(c.layout.panels[i].width, 6);
    }
  });

  it('没有 matrix 的图不受影响：单个网格、单个面板、与从前一致', async () => {
    const c = await mount({
      legend: { show: false },
      series: [{ id: 'a', type: 'line', data: [1, 5, 3] }],
    });
    expect(c.layout.panels).toHaveLength(1);
    expect(((c as any).grids as any[]).length).toBe(1);
    expect((c.seriesComponents[0] as any).state.left).toBe(c.layout.plot.x);
    // 轴必须照常显示 —— 面板逻辑不许把它们藏起来（这条曾经真实漏过：单面板时
    // `display: multi && ...` 求值成 false，整张图的 x 轴直接不见了）
    expect((c as any).axisX.state.display).not.toBe(false);
    expect(((c as any).axisYList[0] as any).state.display).not.toBe(false);
  });

  it('轴触发提示框只列指针所在面板的系列', async () => {
    const c = await mount({ ...matrixOption(), tooltip: { trigger: 'axis' } });
    const panel = c.layout.panels[5];
    const series: any = c.seriesComponents[5];
    const pixel = series.pixelAt(1)!;
    c.controller.handlePointerMove(panel.x + pixel[0], panel.y + pixel[1]);

    const hover: any = c.controller.hover;
    expect(hover.kind).toBe('axis');
    expect(hover.column.panel).toBe(5);
    const content = c.tooltip!.content!;
    expect(content.rows).toHaveLength(1);
    expect(content.rows[0].name).toBe('面板 6');
  });

  it('每个面板内都能各自悬停到自己那一列', async () => {
    const c = await mount({ ...matrixOption(), tooltip: { trigger: 'axis' } });
    for (const index of [0, 2, 3, 5]) {
      const panel = c.layout.panels[index];
      const component: any = c.seriesComponents[index];
      const pixel = component.pixelAt(2)!;
      c.controller.handlePointerMove(panel.x + pixel[0], panel.y + pixel[1]);
      const hover: any = c.controller.hover;
      expect(hover && hover.kind).toBe('axis');
      expect(hover.column.panel).toBe(index);
    }
  });

  it('十字准星限制在指针所在面板内', async () => {
    const c = await mount({ ...matrixOption(), tooltip: { trigger: 'axis' } });
    const panel = c.layout.panels[4];
    const component: any = c.seriesComponents[4];
    const pixel = component.pixelAt(1)!;
    c.controller.handlePointerMove(panel.x + pixel[0], panel.y + pixel[1]);
    const crosshair: any = c.crosshair;
    expect(crosshair.plot).toBeTruthy();
    expect(crosshair.plot.x).toBeCloseTo(panel.x, 6);
    expect(crosshair.plot.width).toBeCloseTo(panel.width, 6);
  });

  it('在某个面板里缩放：锚点用那块面板的比例尺，域仍然是全体共享的一份', async () => {
    const c = await mount(matrixOption());
    const panel = c.layout.panels[5];
    const x = panel.x + panel.width * 0.25;
    const y = panel.y + panel.height / 2;
    const before = c.norm.xAxis.domain.slice();
    c.controller.handleWheel(x, y, -120);
    await c.render();
    expect(c.norm.xAxis.domain).not.toEqual(before);
    // 域共享：每个面板的比例尺都拿到新域
    for (const scales of c.panelScales) {
      expect(scales.x.domain).toEqual(c.norm.xAxis.domain);
    }
  });

  it('框选：x 夹到所有面板的并集，y 只夹在起手那块面板里', async () => {
    const c = await mount({
      ...matrixOption(),
      interaction: { brush: { enabled: true, axes: 'xy', mode: 'select' } },
    });
    // 选**顶行**的面板：并集的下沿在它下方很远，y 夹取对不对一眼可辨
    const panel = c.layout.panels[1];
    const startY = panel.y + 10;
    c.controller.handlePointerDown(panel.x + 10, startY);
    // 横向拖到画布另一头、纵向拖到画布底部之外
    c.controller.handlePointerMove(panel.x + panel.width + 200, startY + 500);
    const brush: any = c.brushComponent;
    expect(brush.rect).not.toBeNull();
    // y 不许越过起手那块面板的下沿（没有面板化时这里会一路画到并集底部）
    expect(brush.rect.y + brush.rect.height).toBeLessThanOrEqual(panel.y + panel.height + 0.5);
    // x 允许越过这块面板（并集语义）
    expect(brush.rect.x + brush.rect.width).toBeGreaterThan(panel.x + panel.width);
  });

  it('每列都有自己的 x 轴，且都画出抽稀后的刻度标签', async () => {
    const c = await mount(matrixOption());
    const axes: any[] = (c as any).panelAxisX;
    expect(axes).toHaveLength(3);
    for (const axis of axes) {
      expect(axis.plot).toBeTruthy();
      const drawn = (axis.lastTicks || []).filter((tick: any) => tick.drawn);
      expect(drawn.length).toBeGreaterThan(0);
    }
    // 抽稀按最窄列算：12 个类目 / 每列约 190px → 每列最多 3 个标签
    const kept = (axes[0].lastTicks || []).filter((tick: any) => tick.drawn);
    expect(kept.length).toBeLessThanOrEqual(4);
    // 每列的刻点都落在**自己那一列**的面板里（不能画到隔壁面板上）
    for (let column = 0; column < 3; column++) {
      const panel = c.layout.panels[3 + column];
      for (const tick of (axes[column].lastTicks || []).filter((t: any) => t.drawn)) {
        expect(tick.pos).toBeGreaterThanOrEqual(panel.x - 0.5);
        expect(tick.pos).toBeLessThanOrEqual(panel.x + panel.width + 0.5);
      }
    }
  });

  it('窄条不画 x 轴（它和主图共享一条 x 轴，重复标签只会挤成一团）', async () => {
    const c = await mount({
      legend: { show: false },
      xAxis: { type: 'category', data: ['一', '二', '三', '四', '五', '六', '七', '八'] },
      // 9:1 —— 窄条只有 ~87px，放不下两个标签（阈值 128px）
      matrix: { rows: 1, columns: [9, 1], gap: 10 },
      animation: { enabled: false },
      series: [
        { id: 'main', type: 'line', name: '趋势', panel: 0, data: [1, 3, 2, 5, 4, 6, 5, 7] },
        { id: 'side', type: 'bar', name: '窄条', panel: 1, data: [1, 3, 2, 5, 4, 6, 5, 7] },
      ],
    });
    const axes: any[] = (c as any).panelAxisX;
    expect(axes).toHaveLength(2);
    expect(axes[1].state.display).toBe(false);
    // 主图（宽列）保留足够多的标签
    const drawn = (axes[0].lastTicks || []).filter((tick: any) => tick.drawn);
    expect(drawn.length).toBeGreaterThanOrEqual(3);
  });
});
