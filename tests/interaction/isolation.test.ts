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
  });

  it('clears its own hover when the pointer leaves the canvas', async () => {
    const chart = await mount();
    const plot = chart.layout.plot;
    const pixel = chart.seriesComponents[0].pixelAt(2)!;
    chart.controller.handlePointerMove(plot.x + pixel[0], plot.y + pixel[1]);
    expect(chart.controller.hover).not.toBeNull();

    // 指针划出画布：本图必须收起悬停（否则提示框会一直挂在画面上）
    chart.controller.handlePointerMove(chart.ice.canvasWidth + 200, 150);
    expect(chart.controller.hover).toBeNull();
  });

  it('keeps an externally mirrored hover when the pointer is outside its canvas', async () => {
    // 跨 pane 十字准星的关键：被联动按 x 值**回显**出悬停的图，本身并没有指针悬停。
    // 同一次 mousemove 会派发到它，它判定「指针不在我身上」→ 以前就把回显删掉了，
    // 于是竖线永远只在指针所在的那一块出现，另外两块怎么都画不出准星。
    const [a, b] = [await mount(), await mount()];
    const plot = a.layout.plot;
    const pixel = a.seriesComponents[0].pixelAt(3)!;
    a.controller.handlePointerMove(plot.x + pixel[0], plot.y + pixel[1]);
    // 联动回显走的就是这条公开入口：按 x **数据值**而不是像素
    b.showHoverAtValue((a.norm.series[0] as any).points[3].xValue);
    expect(b.controller.hover).not.toBeNull();
    expect(b.controller.externalHover).toBe(true);

    // 指针在别处（B 的画布不在这个坐标上）→ 这个悬停不是本图指针放的，不能动
    b.controller.handlePointerMove(-5, -5);
    expect(b.controller.hover).not.toBeNull();
    expect(b.crosshair!.pixelX).not.toBeNull();

    // 只能由放它上来的那一方收回
    b.clearHover();
    expect(b.controller.hover).toBeNull();
    expect(b.controller.externalHover).toBe(false);
  });

  it('never treats a not-laid-out canvas (display:none) as hovered', async () => {
    const chart = await mount();
    // 切页之后被藏起来的图：引擎量不到尺寸，canvasWidth/Height 归零
    (chart.ice as any).canvasWidth = 0;
    (chart.ice as any).canvasHeight = 0;

    // 全页的移动照样会派发到它 —— 必须判为"不在我身上"
    expect(chart.controller.isOverCanvas(120, 90)).toBe(false);
    // 因此不会在错误坐标上锁住悬停（显示出来之后也就不会凭空画提示框）
    chart.controller.handlePointerMove(120, 90);
    expect(chart.controller.hover).toBeNull();
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

  it('prefers the event own preventDefault (ice-render 2.18+ forwards it to the DOM event)', async () => {
    const chart = await mount();
    const plot = chart.layout.plot;
    let ownCalled = false;
    let rawCalled = false;
    chart.controller.handleWheel(plot.x + plot.width / 2, plot.y + plot.height / 2, 120, {
      // 引擎 2.18 起 ICEEvent.preventDefault() 是真实现：它自己会转给原始 DOM 事件
      preventDefault() {
        ownCalled = true;
      },
      originalEvent: {
        preventDefault() {
          rawCalled = true;
        },
      },
    });
    expect(ownCalled).toBe(true);
    // 事件自己有 preventDefault 时，不再越级直接调原始事件（转发由引擎负责）
    expect(rawCalled).toBe(false);
  });
});
