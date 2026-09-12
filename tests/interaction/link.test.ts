import { createChart, linkCharts } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';

const OPTION = {
  series: [{ id: 'a', type: 'line' as const, name: 'A', data: [10, 30, 20, 45, 35] }],
};

describe('linkCharts（跨图联动）', () => {
  const charts: ICEChart[] = [];
  const canvases: any[] = [];

  function makeCanvas(): any {
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 300;
    document.body.appendChild(canvas);
    canvases.push(canvas);
    return canvas;
  }

  afterEach(() => {
    for (const c of charts) c.destroy();
    charts.length = 0;
    for (const canvas of canvases) if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvases.length = 0;
  });

  async function twoCharts() {
    const a = createChart(makeCanvas(), OPTION);
    const b = createChart(makeCanvas(), OPTION);
    charts.push(a, b);
    await a.render();
    await b.render();
    return [a, b] as const;
  }

  it('mirrors hover across charts by x data value', async () => {
    const [a, b] = await twoCharts();
    const handle = linkCharts([a, b], { hover: true, zoom: false, brush: false });
    const plot = a.layout.plot;
    const pixel = a.seriesComponents[0].pixelAt(3)!;
    a.controller.handlePointerMove(plot.x + pixel[0], plot.y + pixel[1]);
    expect(b.controller.hover).not.toBeNull();
    expect(b.tooltip!.content).not.toBeNull();
    expect(b.crosshair!.pixelX).not.toBeNull();
    handle.unlink();
  });

  it('mirrors zoom across charts', async () => {
    const [a, b] = await twoCharts();
    const handle = linkCharts([a, b], { hover: false, zoom: true, brush: false });
    a.setDomain('x', [1, 2]);
    expect(Number(b.getDomain('x')[0])).toBeCloseTo(1, 6);
    expect(Number(b.getDomain('x')[1])).toBeCloseTo(2, 6);
    handle.unlink();
  });

  it('stops mirroring after unlink', async () => {
    const [a, b] = await twoCharts();
    const handle = linkCharts([a, b], { hover: true, zoom: true, brush: false });
    handle.unlink();
    a.setDomain('x', [1, 2]);
    expect(Number(b.getDomain('x')[0])).toBeCloseTo(0, 6);
  });
});
