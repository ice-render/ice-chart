import { createChart } from '../../src/index';
import { normalizeOption } from '../../src/option/normalize';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/** 两团点：左下 40 个、右上 10 个 —— 分箱后应当只有两个明显的格子。 */
function clusteredData(): number[][] {
  const rows: number[][] = [];
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let i = 0; i < 40; i++) rows.push([20 + next() * 4, 30 + next() * 4]);
  for (let i = 0; i < 10; i++) rows.push([80 + next() * 4, 90 + next() * 4]);
  return rows;
}

const HEXBIN: ChartOption = {
  legend: { show: false },
  xAxis: { type: 'value' },
  yAxis: { name: 'y' },
  animation: { enabled: false },
  series: [{ id: 'density', type: 'hexbin', name: '密度', data: clusteredData() as any }],
};

describe('六边形分箱（集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 460;
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

  it('归一化只做透传：点还是那些点，域覆盖全部数据', () => {
    const norm = normalizeOption(HEXBIN);
    expect(norm.series[0].pointCount).toBe(50);
    expect(norm.xAxis.type).toBe('linear');
    expect(norm.yAxes[0].domain[0]).toBeLessThanOrEqual(20);
    expect(norm.yAxes[0].domain[1]).toBeGreaterThanOrEqual(80);
  });

  it('分箱后每格一个像素锚点，且格内任意点命中同一格', async () => {
    const c = await mount(HEXBIN);
    const hexbin: any = c.seriesComponents[0];
    expect(hexbin.binCount()).toBeGreaterThan(1);
    // 采样几个格心：命中的必须是它自己
    for (let index = 0; index < hexbin.binCount(); index++) {
      const center = hexbin.pixelAt(index)!;
      expect(hexbin.hitTestIndex(center[0], center[1])).toBe(index);
      expect(hexbin.hitTestIndex(center[0] + 2, center[1] - 2)).toBe(index);
    }
  });

  it('提示框给「格子 + 计数」，不是某个原始点', async () => {
    const c = await mount({ ...HEXBIN, tooltip: { trigger: 'item' } });
    const hexbin: any = c.seriesComponents[0];
    // 找点数最多的那个格（那团 40 个点）
    let best = 0;
    for (let index = 1; index < hexbin.binCount(); index++) {
      if (hexbin.binAt(index).count > hexbin.binAt(best).count) best = index;
    }
    const center = hexbin.pixelAt(best)!;
    c.controller.handlePointerMove(c.layout.plot.x + center[0], c.layout.plot.y + center[1]);
    const content = c.tooltip!.content!;
    const names = content.rows.map((row) => row.name);
    expect(names).toContain('点数');
    const count = content.rows.find((row) => row.name === '点数')!;
    expect(Number(count.value)).toBe(hexbin.binAt(best).count);
    expect(content.title).toContain('格');
  });

  it('缩放后重新分格（格半径是像素口径），命中仍然自洽', async () => {
    const c = await mount(HEXBIN);
    const hexbin: any = c.seriesComponents[0];
    const before = hexbin.binCount();
    c.setDomain('x', [10, 40], 'zoom');
    await c.render();
    // 放大后同一批点落在更多格子里
    expect(hexbin.binCount()).toBeGreaterThanOrEqual(before);
    const center = hexbin.pixelAt(0)!;
    expect(hexbin.hitTestIndex(center[0], center[1])).toBe(0);
  });
});
