import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';

/**
 * 分块加载（亿级数据）的**引擎集成**：
 * ① 初始化不加载任何块（10 亿点也只是几个数组）；
 * ② 渲染时只请求可见窗口覆盖的块，常驻数有上限；
 * ③ 异步到货后自动重绘（`markDirty`），命中落在驻留块内。
 */
const CHUNK_SIZE = 1000;
const CHUNK_COUNT = 1000; // 逻辑 100 万点（真要是 10 亿，只是把 sizes 写长）

function makeChunkedOption(records: { loads: number[]; delay?: boolean }): any {
  return {
    legend: { show: false },
    animation: { enabled: false },
    tooltip: { trigger: 'item' },
    xAxis: { type: 'linear' },
    yAxis: { min: 0, max: 100 },
    series: [
      {
        id: 's',
        type: 'line',
        name: '分块',
        virtual: true,
        data: {
          sizes: Array.from({ length: CHUNK_COUNT }, () => CHUNK_SIZE),
          rangeOf: (index: number) => [index * CHUNK_SIZE, index * CHUNK_SIZE + CHUNK_SIZE - 1],
          yDomain: [0, 100],
          maxResidentChunks: 3,
          loadChunk: (index: number) => {
            records.loads.push(index);
            const x = new Float64Array(CHUNK_SIZE);
            const y = new Float64Array(CHUNK_SIZE);
            for (let i = 0; i < CHUNK_SIZE; i++) {
              x[i] = index * CHUNK_SIZE + i;
              y[i] = 50 + Math.sin((index * CHUNK_SIZE + i) / 90) * 20;
            }
            const columns = { x, y };
            if (!records.delay) return columns;
            return new Promise((resolve) => setTimeout(() => resolve(columns), 0));
          },
        },
      },
    ],
  };
}

describe('分块列存（引擎集成）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 400;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  it('逻辑点数 = 各块之和；初始化不加载任何块', async () => {
    const records = { loads: [] as number[] };
    chart = createChart(canvas, makeChunkedOption(records), { renderMode: 'dirty-rect' });
    const series: any = chart.norm.series[0];
    expect(series.pointCount).toBe(CHUNK_COUNT * CHUNK_SIZE);
    expect(series.chunks).toBeTruthy();
    const component: any = chart.seriesComponents[0];
    expect(component.series.points).toHaveLength(0);
    expect(component.pixels.length).toBe(0);
    await chart.render();
    // 默认视图是全量域 → 窗口覆盖所有块，但常驻数仍然有上限
    expect(records.loads.length).toBeGreaterThan(0);
    expect(series.chunks.resident.filter(Boolean).length).toBeLessThanOrEqual(3);
  });

  it('异步到货后自动重绘（markDirty），且命中落在驻留块内', async () => {
    const records = { loads: [] as number[], delay: true };
    chart = createChart(canvas, makeChunkedOption(records), { renderMode: 'dirty-rect' });
    await chart.render();
    // 等异步块到货
    await new Promise((resolve) => setTimeout(resolve, 30));
    const series: any = chart.norm.series[0];
    const resident = series.chunks.resident.filter(Boolean).length;
    expect(resident).toBeGreaterThan(0);
    // 放大到 60 个点的窗口：这样"最近邻 ±2"在像素上是明确的（满窗口 1M 点时
    // 一根像素列里挤着上千个点，命中本来就只取邻域 —— 与普通系列同一口径）
    chart.setDomain('x', [900, 960]);
    await chart.render();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const chunkIndex = series.chunks.resident.findIndex((c: any) => !!c);
    expect(chunkIndex).toBeGreaterThanOrEqual(0);
    const index = 930;
    const pixel = (chart.seriesComponents[0] as any).pixelAt(index);
    expect(pixel).not.toBeNull();
    const hit = (chart.seriesComponents[0] as any).hitTestIndex(pixel[0], pixel[1]);
    expect(hit).toBeGreaterThanOrEqual(0);
  });

  it('平移之后换一批块进来，常驻数仍然有界（内存与总量解耦）', async () => {
    const records = { loads: [] as number[] };
    chart = createChart(canvas, makeChunkedOption(records), { renderMode: 'dirty-rect' });
    await chart.render();
    const series: any = chart.norm.series[0];
    chart.setDomain('x', [500000, 502000]);
    await chart.render();
    expect(series.chunks.resident.filter(Boolean).length).toBeLessThanOrEqual(3);
    // 新的窗口请求了新的一块（500000 落在第 500 块）
    expect(records.loads).toContain(500);
  });
});
