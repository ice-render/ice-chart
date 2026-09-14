import { createChart, chartThemeToEnginePatch, BOOTSTRAP_CHART_THEME, BOOTSTRAP_DARK_CHART_THEME } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/**
 * 图表主题 → 引擎主题：一个图表实例里，**引擎自己画的那层**要跟着图表主题走。
 *
 * 以前两套主题各管一段（图表用 Bootstrap token、引擎用它的 semantic/chrome），
 * 于是「图表是暗的、外壳还是亮的」是一眼可见的不一致。
 */
describe('图表主题 → 引擎主题', () => {
  let canvas: HTMLCanvasElement;
  let chart: ICEChart | null = null;

  const mount = (option: ChartOption) => {
    canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    document.body.appendChild(canvas);
    chart = createChart(canvas, option);
    return chart;
  };

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  const BASE: ChartOption = {
    xAxis: { type: 'category', data: ['1月', '2月', '3月'] },
    series: [{ id: 's', type: 'line', data: [1, 2, 3] }],
  };

  it('映射只用图表主题已有的 token（同名语义）', () => {
    const patch = chartThemeToEnginePatch(BOOTSTRAP_DARK_CHART_THEME);
    expect(patch.background).toBe(BOOTSTRAP_DARK_CHART_THEME.backgroundColor);
    expect(patch.text).toBe(BOOTSTRAP_DARK_CHART_THEME.textColor);
    expect(patch.muted).toBe(BOOTSTRAP_DARK_CHART_THEME.subTextColor);
    expect(patch.border).toBe(BOOTSTRAP_DARK_CHART_THEME.axisLineColor);
    expect(patch.palette).toEqual(BOOTSTRAP_DARK_CHART_THEME.colorPalette);
    expect(patch.chrome.selection.stroke).toBe(BOOTSTRAP_DARK_CHART_THEME.selection.stroke);
    expect(patch.chrome.linkLabel.background).toBe(BOOTSTRAP_DARK_CHART_THEME.tooltip.background);
    expect(patch.chrome.shadow.md).toBe(BOOTSTRAP_DARK_CHART_THEME.tooltip.shadowColor);
    expect(patch.base.fontFamily.base).toBe(BOOTSTRAP_DARK_CHART_THEME.fontFamily);
    expect(patch.base.fontSize.md).toBe(BOOTSTRAP_DARK_CHART_THEME.fontSize);
  });

  it('建图时就把图表主题推给引擎（亮色主题）', async () => {
    const c = mount({ ...BASE, theme: 'light' });
    await c.render();
    const semantic = c.ice.getTheme().semantic;
    expect(semantic.text).toBe(BOOTSTRAP_CHART_THEME.textColor);
    expect(semantic.palette[0]).toBe(BOOTSTRAP_CHART_THEME.colorPalette[0]);
  });

  it('切换图表主题（setOption）时引擎主题跟着换', async () => {
    const c = mount({ ...BASE, theme: 'light' });
    await c.render();
    const lightText = c.ice.getTheme().semantic.text;

    c.setOption({ ...BASE, theme: 'dark' });
    await c.render();
    const darkSemantic = c.ice.getTheme().semantic;
    // 两个主题的 backgroundColor 都是 transparent（图表自己不画底），所以拿文字色比对
    expect(darkSemantic.text).toBe(BOOTSTRAP_DARK_CHART_THEME.textColor);
    expect(darkSemantic.text).not.toBe(lightText);
    expect(darkSemantic.palette[0]).toBe(BOOTSTRAP_DARK_CHART_THEME.colorPalette[0]);
  });

  it("theme:'auto' 跟随引擎实例主题（以前实现里恒等于 light）", async () => {
    const c = mount({ ...BASE, theme: 'auto' });
    await c.render();
    // 引擎是默认（亮）主题 → 图表走亮色
    expect(c.norm.theme.textColor).toBe(BOOTSTRAP_CHART_THEME.textColor);

    // 把引擎切成暗色之后再建一张 auto 图 → 图表走暗色
    c.ice.setTheme('dark');
    c.setOption({ ...BASE, theme: 'auto' });
    await c.render();
    expect(c.norm.theme.textColor).toBe(BOOTSTRAP_DARK_CHART_THEME.textColor);
    // auto 是"跟随引擎"，所以**不该**把图表主题反推回引擎（否则下一轮 auto 读到的是自己推的值）
    expect(c.ice.getTheme().semantic.background).toBe('#111827');
  });

  it('自定义主题片段：推给引擎的是解析后的完整主题', async () => {
    const c = mount({ ...BASE, theme: { colorPalette: ['#ff0000', '#00ff00'], textColor: '#111111' } });
    await c.render();
    const semantic = c.ice.getTheme().semantic;
    expect(semantic.palette[0]).toBe('#ff0000');
    expect(semantic.text).toBe('#111111');
    // 没覆盖的字段仍来自亮色基底
    expect(semantic.border).toBe(BOOTSTRAP_CHART_THEME.axisLineColor);
  });
});
