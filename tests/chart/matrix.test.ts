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
  });
});
