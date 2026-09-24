/**
 * 流水线资源契约：一次数据更新只跑**一遍**归一化。
 *
 * 原来一次 `setData` / `setOption` / `appendData` 会跑两遍 `normalizeOption`：
 * `applyOption` 一遍拿全域，`rebuild` 一遍拿视窗域 —— 而第二遍的全部作用只是
 * 「把视窗套到全域上」（视窗在归一化里只影响 x 域裁剪、y 轴显式域、表达式系列采样）。
 * 10 万点普通系列上这一遍约 3ms（实测见 `plans/incremental-pipeline.md`）。
 *
 * 这里锁的是这条**资源契约**（少跑一趟流水线就是这次改动的可观测产出本身），
 * 语义等价由 `tests/option/apply-view.test.ts` 与全套回归用例保证。
 */
import * as normalizeModule from '../../src/option/normalize';
import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

function option(): ChartOption {
  return {
    animation: { enabled: false },
    legend: { show: false },
    xAxis: { type: 'category' },
    series: [
      {
        id: 'a',
        type: 'line',
        data: Array.from({ length: 40 }, (_v, i) => ({ x: `D${i}`, y: 100 + Math.sin(i / 4) * 20 })),
      },
    ],
  };
}

describe('一次更新只跑一遍归一化', () => {
  let canvas: any;
  let chart: ICEChart | null = null;
  let spy: jest.SpyInstance;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    document.body.appendChild(canvas);
    spy = jest.spyOn(normalizeModule, 'normalizeOption');
  });

  afterEach(() => {
    spy.mockRestore();
    if (chart) chart.destroy();
    chart = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  test('setData：1 遍', () => {
    chart = createChart(canvas, option());
    spy.mockClear();
    chart.setData(
      'a',
      Array.from({ length: 40 }, (_v, i) => ({ x: `D${i}`, y: i }))
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('setOption：1 遍', () => {
    chart = createChart(canvas, option());
    spy.mockClear();
    chart.setOption(option());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('appendData（普通系列）：1 遍', () => {
    chart = createChart(canvas, option());
    spy.mockClear();
    chart.appendData('a', [{ x: 'D40', y: 120 }]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('setDomain（纯视窗变化）：1 遍', () => {
    chart = createChart(canvas, option());
    spy.mockClear();
    chart.setDomain('x', ['D10', 'D30'], 'api');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('缩放后再追加数据，视窗仍然生效（快路径不许丢掉窗口）', () => {
    chart = createChart(canvas, option());
    chart.setDomain('x', ['D10', 'D30'], 'api');
    spy.mockClear();
    chart.appendData('a', [{ x: 'D40', y: 120 }]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(chart.norm.xAxis.domain).toEqual([
      'D10',
      'D11',
      'D12',
      'D13',
      'D14',
      'D15',
      'D16',
      'D17',
      'D18',
      'D19',
      'D20',
      'D21',
      'D22',
      'D23',
      'D24',
      'D25',
      'D26',
      'D27',
      'D28',
      'D29',
      'D30',
    ]);
  });
});
