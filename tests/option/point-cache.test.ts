/**
 * 点物化的复用：**同一份数据数组**不该每帧重新建一遍 `DataPoint`。
 *
 * 起因：`buildPoints` 每个普通系列每趟归一化都要物化一遍点对象（10 万点约 1.5~2ms + 一堆垃圾）。
 * 而平移 / 缩放 / 重复归一化时**数据根本没变** —— 重建只是白烧 CPU 与 GC。
 *
 * 判据与类目域那套同源：**数组身份 + 长度 + 解析规则**都没变才复用；
 * 换了数组、换了长度、换了 `xField`/`yField` 一律重建（宁可多算一次，不给错的数据）。
 */
import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

function option(rows: Array<{ x: string; y: number }>): ChartOption {
  return {
    animation: { enabled: false },
    legend: { show: false },
    xAxis: { type: 'category' },
    yAxis: {},
    series: [{ id: 's', type: 'line', data: rows }],
  };
}

const rows = (prefix: string, offset = 0) =>
  Array.from({ length: 40 }, (_v, i) => ({ x: `${prefix}${i}`, y: offset + i }));

describe('点集复用（同一份数据数组）', () => {
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

  test('平移 / 缩放（只看视窗）不重建点集：连点对象都是同一批', () => {
    chart = createChart(canvas, option(rows('D')));
    const before = chart.norm.series[0].points;
    chart.setDomain('x', ['D10', 'D30'], 'api');
    expect(chart.norm.series[0].points).toBe(before);
    expect(chart.norm.xAxis.domain).toEqual(rows('D').slice(10, 31).map((row) => row.x));
  });

  test('同一份数组再 setData 一次：仍然复用那一批点', () => {
    const data = rows('D');
    chart = createChart(canvas, option(data));
    const before = chart.norm.series[0].points;
    chart.setData('s', data);
    expect(chart.norm.series[0].points).toBe(before);
  });

  test('换了数据数组：必须重建（不能拿旧点糊弄）', () => {
    chart = createChart(canvas, option(rows('D')));
    const before = chart.norm.series[0].points;
    chart.setData('s', rows('N', 1000));
    expect(chart.norm.series[0].points).not.toBe(before);
    expect(chart.norm.series[0].points.map((p) => p.xValue)).toEqual(rows('N').map((row) => row.x));
    expect(chart.norm.series[0].points[0].y).toBe(1000);
  });

  test('换个 series 对象（同 id、同数据）也不能串味：解析规则变了就重建', () => {
    const data = rows('D');
    chart = createChart(canvas, {
      animation: { enabled: false },
      legend: { show: false },
      xAxis: { type: 'category' },
      yAxis: {},
      series: [{ id: 's', type: 'line', yField: 'value', data: data as any }],
    });
    const before = chart.norm.series[0].points;
    chart.setData('s', data as any);
    // yField 没变 → 复用
    expect(chart.norm.series[0].points).toBe(before);
    // 换掉 yField：同一份数组也算换规则 → 重建
    const opt = chart.getOption() as any;
    opt.series[0].yField = 'y';
    chart.setOption(opt, { animate: false, preserveView: true });
    expect(chart.norm.series[0].points).not.toBe(before);
  });
});
