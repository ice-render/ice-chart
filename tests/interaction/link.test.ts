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

  it('keeps the source hover when a linked chart drops its echoed hover', async () => {
    // 回归：被联动**回显**出悬停的 B 自己把悬停收掉时会抛 item:leave ——
    // 以前这会顺着联动把 A 真正的悬停也清掉，表现是十字准星的竖线一闪就没了。
    // 回显之死不是「离开」，只有源头发的 leave 才算。
    const [a, b] = await twoCharts();
    const handle = linkCharts([a, b], { hover: true, zoom: false, brush: false });
    const plot = a.layout.plot;
    const pixel = a.seriesComponents[0].pixelAt(3)!;
    a.controller.handlePointerMove(plot.x + pixel[0], plot.y + pixel[1]);
    expect(a.controller.hover).not.toBeNull();
    expect(b.controller.hover).not.toBeNull();

    // B 收掉回显出来的悬停（应用层 clearHover / 它自己的指针离开都走这条路）
    b.clearHover();
    expect(b.controller.hover).toBeNull();
    // A 是源头，悬停必须还在（准星竖线不能消失）
    expect(a.controller.hover).not.toBeNull();
    expect(a.crosshair!.pixelX).not.toBeNull();
    handle.unlink();
  });

  it('clears echoed hover when the source itself leaves', async () => {
    const [a, b] = await twoCharts();
    const handle = linkCharts([a, b], { hover: true, zoom: false, brush: false });
    const plot = a.layout.plot;
    const pixel = a.seriesComponents[0].pixelAt(3)!;
    a.controller.handlePointerMove(plot.x + pixel[0], plot.y + pixel[1]);
    expect(b.controller.hover).not.toBeNull();
    // 源头自己离开画布 → 回显也必须跟着收掉，否则副图会一直挂着准星
    a.controller.handlePointerMove(-5, -5);
    expect(a.controller.hover).toBeNull();
    expect(b.controller.hover).toBeNull();
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
    const before = b.getDomain('x').map(Number);
    const handle = linkCharts([a, b], { hover: true, zoom: true, brush: false });
    handle.unlink();
    a.setDomain('x', [1, 2]);
    // 断言「b 的窗口没被带着动」（而不是写死 0）：轴的域含留白，起点不一定是 0
    expect(b.getDomain('x').map(Number)).toEqual(before);
  });
});
