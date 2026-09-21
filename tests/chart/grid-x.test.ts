/**
 * 垂直网格线（`grid.x`）与 x 轴标签的**同一性**契约。
 *
 * 网格线必须落在**标签正下方**，也就是「抽稀之后真画出来的那几颗刻度」，不能是每个刻度一条：
 * 类目轴的 `scale.ticks()` 会返回整个 domain（视窗里 120 根就是 120 条竖线），
 * 那样打开 `grid.x` 得到的是一片栅栏，而不是网格（实测）。
 *
 * 还有一个多 pane 的前提：上面几块 pane 常常把 x 轴藏起来（`show: false`）省纵向空间，
 * 但网格还得在 —— 所以隐藏的 x 轴也要出那张抽稀表（只是不占排版空间、也不画）。
 */
import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const COUNT = 120;

function option(xAxis: ChartOption['xAxis']): ChartOption {
  const data = Array.from({ length: COUNT }, (_item, index) => ({
    x: `D${index}`,
    y: 100 + Math.sin(index / 6) * 20,
  }));
  return {
    animation: { enabled: false },
    legend: { show: false },
    grid: { x: true },
    xAxis: { type: 'category', ...(xAxis || {}) },
    series: [{ id: 'a', type: 'line', data }],
  };
}

describe('垂直网格线跟 x 轴标签同一批位置', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  const mount = (xAxis: ChartOption['xAxis']): ICEChart => {
    chart = createChart(canvas, option(xAxis));
    return chart;
  };

  it('类目轴上不是「每个刻度一条」：跟抽稀后的标签一致', () => {
    const c = mount({});
    const drawn = (c.axisX as any).lastTicks.filter((tick: any) => tick.drawn).length;
    // 窗口里的 120 根不可能都画标签
    expect(drawn).toBeLessThan(COUNT);
    // 竖线数量 = 真画出来的标签数
    expect(c.grid.xTicks.length).toBe(drawn);
    expect(c.grid.xTicks.length).toBeGreaterThan(1);
  });

  it('x 轴藏起来（show: false）时网格照旧，且位置与显示轴时一致', () => {
    const shown = mount({});
    const shownTicks = shown.grid.xTicks.slice();
    const shownPlot = { x: shown.layout.plot.x, width: shown.layout.plot.width };
    shown.destroy();
    chart = null;

    const hidden = mount({ show: false });
    // 藏了轴，网格一样落在同一批位置
    expect(hidden.grid.xTicks).toEqual(shownTicks);
    // 藏起来只是不占纵向的标签带；横向预留（y 轴那一截）与显示时一致
    expect(hidden.layout.plot.x).toBe(shownPlot.x);
    expect(hidden.layout.plot.width).toBe(shownPlot.width);
    expect(hidden.layout.xAxisLayout.labelHeight).toBe(0);
    expect(hidden.layout.xAxisLayout.ticks.length).toBeGreaterThan(0);
  });

  it('没开 grid.x 时不出竖线（默认行为不变）', () => {
    const c = createChart(canvas, { ...option({}), grid: { x: false } });
    chart = c;
    expect(c.grid.grid.x).toBe(false);
  });
});
