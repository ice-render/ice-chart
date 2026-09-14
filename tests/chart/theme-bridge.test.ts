import { createChart, chartThemeToEnginePatch, BOOTSTRAP_CHART_THEME, BOOTSTRAP_DARK_CHART_THEME } from '../../src/index';
import { DARK_THEME } from 'ice-render';
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
    // 拿引擎的暗色主题做基准比对，避免把引擎的色值变化复制到本库的测试里
    expect(c.ice.getTheme().semantic.background).toBe(DARK_THEME.semantic.background);
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

  /**
   * `theme:'auto'` 的「跟随」以前只在**建图 / setOption 那一刻采样一次**：
   * 宿主之后调 `ice.setTheme('dark')`，图表纹丝不动（轴、系列、图例全是亮色）。
   * 现在引擎在主题变更时会广播，图表订阅后重新归一化 —— 明暗重新判定、立即重绘。
   */
  describe("theme:'auto' 被动跟随引擎主题", () => {
    it('引擎换主题 → 图表跟着换（不用等下一次 setOption）', () => {
      const c = mount({ ...BASE, theme: 'auto' });
      expect(c.norm.theme.textColor).toBe(BOOTSTRAP_CHART_THEME.textColor);

      c.ice.setTheme('dark');

      expect(c.norm.theme.textColor).toBe(BOOTSTRAP_DARK_CHART_THEME.textColor);
    });

    it('引擎切回亮色 → 图表切回亮色（两个方向都跟）', () => {
      const c = mount({ ...BASE, theme: 'auto' });
      c.ice.setTheme('dark');
      expect(c.norm.theme.textColor).toBe(BOOTSTRAP_DARK_CHART_THEME.textColor);

      c.ice.setTheme('default');

      expect(c.norm.theme.textColor).toBe(BOOTSTRAP_CHART_THEME.textColor);
    });

    it('显式主题不跟随（light / dark / 自定义都不受影响），也不反过来覆盖宿主刚设的主题', () => {
      const c = mount({ ...BASE, theme: 'light' });
      c.ice.setTheme('dark');
      expect(c.norm.theme.textColor).toBe(BOOTSTRAP_CHART_THEME.textColor);
      // 图表没有把 light 再推回去压掉宿主的选择
      expect(c.ice.getTheme().semantic.background).toBe(DARK_THEME.semantic.background);
    });

    it('destroy() 之后退订：引擎再换主题也不会回头画已销毁的图', () => {
      const c = mount({ ...BASE, theme: 'auto' });
      const rebuild = jest.fn();
      (c as any).rebuild = rebuild;
      c.destroy();
      c.ice.setTheme('dark');
      expect(rebuild).not.toHaveBeenCalled();
    });
  });
});
