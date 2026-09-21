import { createChart, setMotionPreference } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/**
 * 缩放比例限制（类目 / 时间轴）。
 *
 * 口径：限制写成「**每根占多少像素**」（主流看盘软件 / 主流轻量图表库的 `barSpacing` 口径），
 * 而不是「占数据域的百分之几」—— 后者会随「图上载入了多少根」漂移。
 * 实测过的坑：K 线页缩放到底能到 **0.24px/根**（一根占不到一个像素，整片糊成色带），
 * 放大那头则卡在「数据域的 5%」，载入根数一变限制就跟着变。
 */
describe('缩放比例限制', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  const mount = async (option: ChartOption): Promise<ICEChart> => {
    canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 300;
    document.body.appendChild(canvas);
    chart = createChart(canvas, option);
    await chart.render();
    return chart;
  };

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    setMotionPreference('instant');
  });

  /** 60 个类目的类目轴。 */
  const categoryOption = (overrides: Partial<ChartOption> = {}): ChartOption =>
    ({
      xAxis: { type: 'category' },
      animation: { enabled: false },
      series: [{ id: 'a', type: 'line', data: Array.from({ length: 60 }, (_, i) => i % 7) }],
      interaction: { zoom: { enabled: true, wheel: true, axes: 'x' }, pan: false },
      ...overrides,
    }) as ChartOption;

  /** 在绘图区中心滚一次轮（`deltaY < 0` = 放大）。 */
  const wheelOnce = async (c: ICEChart, deltaY: number) => {
    const plot = c.layout.plot;
    c.controller.handleWheel(plot.x + plot.width / 2, plot.y + plot.height / 2, deltaY);
    await c.render();
  };

  const visibleCount = (c: ICEChart) => (c.getDomain('x') || []).length;

  it('缩到底最多到 minBarSpacing（默认 0.5px/根），不会糊成色带', async () => {
    const c = await mount(categoryOption());
    const all = c.fullDomain('x');
    // 先放到全量（60 根 / 589px ≈ 9.8px/根），再猛缩 40 下
    c.setDomain('x', [all[0], all[60 - 1]]);
    await c.render();
    for (let i = 0; i < 40; i++) await wheelOnce(c, 120);

    const width = c.layout.plot.width;
    const count = visibleCount(c);
    const spacing = width / count;
    // 0.5px/根 是下限（浮点允许一点点出入）
    expect(spacing).toBeGreaterThanOrEqual(0.5 - 1e-6);
    // 而且确实是被限制卡住的，不是「数据不够」：60 根全在视窗里
    expect(count).toBeLessThanOrEqual(Math.floor(width / 0.5));
    expect(count).toBe(60);
  });

  it('放到头最多半幅宽一根（一屏最少两根）', async () => {
    const c = await mount(categoryOption());
    for (let i = 0; i < 40; i++) await wheelOnce(c, -120);
    const width = c.layout.plot.width;
    const count = visibleCount(c);
    expect(count).toBeGreaterThanOrEqual(2);
    expect(width / count).toBeLessThanOrEqual(width / 2 + 1e-6);
  });

  it('minBarSpacing / maxBarSpacing 可以覆盖', async () => {
    const c = await mount(
      categoryOption({
        interaction: {
          zoom: { enabled: true, wheel: true, axes: 'x', minBarSpacing: 4, maxBarSpacing: 20 },
          pan: false,
        },
      } as Partial<ChartOption>)
    );
    const all = c.fullDomain('x');
    c.setDomain('x', [all[0], all[59]]);
    await c.render();
    for (let i = 0; i < 30; i++) await wheelOnce(c, 120);
    const width = c.layout.plot.width;
    // 最密 4px/根 → 可见根数 ≤ width / 4
    expect(visibleCount(c)).toBeLessThanOrEqual(Math.floor(width / 4));
    for (let i = 0; i < 30; i++) await wheelOnce(c, -120);
    // 最粗 20px/根 → 可见根数 ≥ width / 20
    expect(visibleCount(c)).toBeGreaterThanOrEqual(Math.ceil(width / 20));
    expect(width / visibleCount(c)).toBeLessThanOrEqual(20 + 1e-6);
  });

  it('框选缩放到区间也走限制（不是只有滚轮受限）', async () => {
    const c = await mount(categoryOption({ interaction: { zoom: { enabled: true, wheel: true, axes: 'x' }, pan: false } } as Partial<ChartOption>));
    const all = c.fullDomain('x');
    c.setDomain('x', [all[0], all[59]]);
    await c.render();
    // 直接按 'brush' 塞一个只有 2 根的窗口：应当被抬到限制内的根数
    c.setDomain('x', [all[10], all[11]], 'brush');
    await c.render();
    const width = c.layout.plot.width;
    const count = visibleCount(c);
    expect(count).toBeGreaterThanOrEqual(Math.ceil(width / (width / 2)));
    expect(width / count).toBeLessThanOrEqual(width / 2 + 1e-6);
  });

  it('程序化窗口（api / 联动）不受限：应用要指哪打哪', async () => {
    const c = await mount(categoryOption());
    const all = c.fullDomain('x');
    // 「回到最新」这类窗口是应用自己钉的，哪怕比 maxBarSpacing 粗也必须原样生效
    c.setDomain('x', [all[3], all[4]], 'api');
    await c.render();
    expect(visibleCount(c)).toBe(2);
  });
});
