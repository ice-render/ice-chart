/**
 * `ICEChart.resize()` 的尺寸契约。
 *
 * 这个方法原先**自己算尺寸**，用的是 `getBoundingClientRect()` 的 **border-box** ——
 * 画布带边框时整体偏大（引擎注释里警告过这个坑："直接用 border-box 会被边框撑大，
 * 示例页画布带 1px 边框"）。而它自己的文档注释写的是"读取 canvas 的内容盒尺寸"，
 * 也就是说那句话一直是**意图**、不是实现。
 *
 * 现在尺寸对齐整体委托给引擎的 `ICE.fitCanvasToDisplaySize()`（ice-render 2.12.0 起），
 * 按内容盒算，并且 backing store × dpr、canvasWidth/Height、命中矩形与内容盒的同步
 * 都只有一份实现。这组用例钉的就是"确实读的是内容盒"。
 */
import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const OPTION: ChartOption = {
  series: [{ id: 'a', type: 'line', name: 'A', data: [10, 30, 20, 45, 35] }],
};

/** 造一个固定尺寸的 rect。jsdom 没有布局引擎，默认 rect 全为 0。 */
function fakeRect(width: number, height: number) {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  };
}

describe('ICEChart.resize()：尺寸契约委托给引擎', () => {
  let canvas: any;
  let chart: ICEChart | null = null;
  let originalGetComputedStyle: any;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 400;
    document.body.appendChild(canvas);
    originalGetComputedStyle = window.getComputedStyle;
  });

  afterEach(() => {
    window.getComputedStyle = originalGetComputedStyle;
    if (chart) chart.destroy();
    chart = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  function mount(options: any = {}): ICEChart {
    chart = createChart(canvas, OPTION, options);
    return chart;
  }

  /** 让这个画布的 computedStyle 报出边框与内边距。 */
  function stubBoxModel(border: number, padding: number): void {
    window.getComputedStyle = ((el: any) => {
      if (el === canvas) {
        return {
          borderLeftWidth: `${border}px`,
          borderRightWidth: `${border}px`,
          borderTopWidth: `${border}px`,
          borderBottomWidth: `${border}px`,
          paddingLeft: `${padding}px`,
          paddingRight: `${padding}px`,
          paddingTop: `${padding}px`,
          paddingBottom: `${padding}px`,
        } as any;
      }
      return originalGetComputedStyle.call(window, el);
    }) as any;
  }

  it('显式传尺寸照常生效', () => {
    const c = mount();
    c.resize(900, 300);

    expect(canvas.width).toBe(900);
    expect(canvas.height).toBe(300);
    expect(canvas.style.width).toBe('900px');
    expect(canvas.style.height).toBe('300px');
    expect(c.ice.canvasWidth).toBe(900);
    expect(c.ice.canvasHeight).toBe(300);
  });

  it('不传尺寸时按**内容盒**读 —— 不再被边框撑大（本次修复的核心）', () => {
    canvas.getBoundingClientRect = () => fakeRect(400, 300);
    stubBoxModel(10, 0);

    const c = mount();
    c.resize();

    // 内容盒 = 400 − 10 − 10 = 380；300 − 10 − 10 = 280
    // 旧实现会取 border-box 的 400×300，画布整体偏大 20px
    expect(canvas.width).toBe(380);
    expect(canvas.height).toBe(280);
    expect(canvas.style.width).toBe('380px');
    expect(c.ice.canvasWidth).toBe(380);
  });

  it('边框之外还扣内边距', () => {
    canvas.getBoundingClientRect = () => fakeRect(400, 300);
    stubBoxModel(4, 6);

    const c = mount();
    c.resize();

    // 400 − 4*2 − 6*2 = 380；300 − 4*2 − 6*2 = 280
    expect(canvas.width).toBe(380);
    expect(canvas.height).toBe(280);
  });

  it('dpr > 1 时 backing store 是逻辑尺寸的倍数，CSS 尺寸固定为逻辑尺寸', () => {
    const c = mount({ dpr: 2 });
    c.resize(500, 250);

    expect(canvas.width).toBe(1000);
    expect(canvas.height).toBe(500);
    expect(canvas.style.width).toBe('500px');
    expect(canvas.style.height).toBe('250px');
    expect(c.ice.canvasWidth).toBe(1000);
  });

  it('尺寸没变时是幂等的', () => {
    const c = mount();
    c.resize(640, 360);
    const first = { w: canvas.width, h: canvas.height, style: canvas.style.width };

    c.resize(640, 360);

    expect(canvas.width).toBe(first.w);
    expect(canvas.height).toBe(first.h);
    expect(canvas.style.width).toBe(first.style);
  });

  it('垃圾尺寸不会把画布写坏（退回当前显示尺寸，而不是写成 0）', () => {
    const c = mount();
    canvas.getBoundingClientRect = () => fakeRect(500, 320);

    c.resize(0, NaN);

    expect(canvas.width).toBe(500);
    expect(canvas.height).toBe(320);
    expect(canvas.width).toBeGreaterThan(0);
  });
});
