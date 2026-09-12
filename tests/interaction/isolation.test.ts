import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';

const OPTION = {
  series: [{ id: 'a', type: 'line' as const, name: 'A', data: [10, 30, 20, 45, 35] }],
};

/**
 * 多图事件隔离回归。
 *
 * 引擎的原生事件监听挂在 window 上，同一页面上的每张图都会收到**全页面**的事件。
 * 早先的实现在这里会串扰：在 A 图上移动鼠标会让 B 图把刚镜像过来的悬停清掉，
 * 点空白处会让所有图都抛 chart:click，按方向键所有图一起动。
 */
describe('多图事件隔离', () => {
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

  async function mount(): Promise<ICEChart> {
    const chart = createChart(makeCanvas(), OPTION);
    charts.push(chart);
    await chart.render();
    return chart;
  }

  it('ignores pointer moves outside its own canvas', async () => {
    const [a, b] = [await mount(), await mount()];
    const plot = a.layout.plot;
    const pixel = a.seriesComponents[0].pixelAt(2)!;
    a.controller.handlePointerMove(plot.x + pixel[0], plot.y + pixel[1]);
    expect(a.controller.hover).not.toBeNull();

    // B 图先有一个悬停状态（真实场景里这是从 A 图联动镜像过来的）
    const bPlot = b.layout.plot;
    const bPixel = b.seriesComponents[0].pixelAt(2)!;
    b.controller.handlePointerMove(bPlot.x + bPixel[0], bPlot.y + bPixel[1]);
    expect(b.controller.hover).not.toBeNull();

    // A 图上继续移动鼠标时，B 图也会收到这一事件，但坐标落在 B 的画布之外 —— 必须忽略
    b.controller.handlePointerMove(b.ice.canvasWidth + 200, 150);
    expect(b.controller.hover).not.toBeNull();

    // 反向同理：A 的悬停不应被任何「画布外事件」清掉
    expect(a.controller.hover).not.toBeNull();
  });

  it('does not emit chart:click for clicks outside the canvas', async () => {
    const chart = await mount();
    const events: any[] = [];
    chart.on('chart:click', (p: any) => events.push(p));
    chart.controller.handleClick(-40, -40);
    expect(events).toHaveLength(0);
  });

  it('routes keyboard input to the chart that was last activated', async () => {
    const [a, b] = [await mount(), await mount()];
    const plot = b.layout.plot;
    b.controller.handlePointerDown(plot.x + 10, plot.y + 10);
    expect(a.controller.handleKeyDown('ArrowRight')).toBe(false);
    expect(b.controller.handleKeyDown('ArrowRight')).toBe(true);
  });

  it('never throws when preventDefault is unusable (engine event / passive listener)', async () => {
    const chart = await mount();
    const plot = chart.layout.plot;
    const x = plot.x + plot.width / 2;
    const y = plot.y + plot.height / 2;
    expect(() =>
      chart.controller.handleWheel(x, y, 120, {
        preventDefault() {
          throw new TypeError('Illegal invocation');
        },
      })
    ).not.toThrow();
  });

  it('calls preventDefault on the original DOM event when available', async () => {
    const chart = await mount();
    const plot = chart.layout.plot;
    let called = false;
    chart.controller.handleWheel(plot.x + plot.width / 2, plot.y + plot.height / 2, 120, {
      originalEvent: {
        preventDefault() {
          called = true;
        },
      },
    });
    expect(called).toBe(true);
  });
});
