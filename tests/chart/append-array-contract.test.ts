/**
 * `appendData`（普通路径）**不碰调用方那个数组** —— 这是被一次失败的优化试出来的契约。
 *
 * 曾经怀疑滑动窗口的 `concat` + `slice` 是大头，写成原地 push/splice；
 * 实测两趟拷贝只有 **0.055ms/10 万点**（原地 0.005ms），真正的 3.5ms 是**类目域重建**
 * （见 `plans/incremental-pipeline.md`）。也就是说：原地改**买不到性能**，
 * 却会把调用方留着引用的数组改掉。所以退回来了，并把这条契约钉死 ——
 * 窗口语义不变（`option.series[i].data` 换成新数组），调用方的数组原样不动。
 */
import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

function option(rows: Array<{ x: string; y: number }>): ChartOption {
  return {
    animation: { enabled: false },
    legend: { show: false },
    xAxis: { type: 'category' },
    series: [{ id: 's', type: 'line', data: rows }],
  };
}

describe('appendData 不修改调用方传入的数组', () => {
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

  test('追加后调用方的数组原样不动，图表换成新数组', () => {
    const rows = [
      { x: 'D0', y: 1 },
      { x: 'D1', y: 2 },
    ];
    chart = createChart(canvas, option(rows));
    chart.appendData('s', [{ x: 'D2', y: 3 }]);
    expect(rows.map((row) => row.x)).toEqual(['D0', 'D1']);
    const data = chart.getOption().series![0].data as Array<{ x: string }>;
    expect(data).not.toBe(rows);
    expect(data.map((row) => row.x)).toEqual(['D0', 'D1', 'D2']);
  });

  test('超过 maxPoints 时，调用方的数组保持原长（窗口只裁图表侧那份）', () => {
    const rows = [
      { x: 'D0', y: 1 },
      { x: 'D1', y: 2 },
      { x: 'D2', y: 3 },
    ];
    chart = createChart(canvas, option(rows));
    chart.appendData('s', [{ x: 'D3', y: 4 }], { maxPoints: 3 });
    expect(rows.map((row) => row.x)).toEqual(['D0', 'D1', 'D2']);
    const data = chart.getOption().series![0].data as Array<{ x: string }>;
    expect(data.map((row) => row.x)).toEqual(['D1', 'D2', 'D3']);
    expect(chart.norm.series[0].pointCount).toBe(3);
  });
});
