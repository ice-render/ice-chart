import { normalizeOption } from '../../src/option/normalize';
import { computeLayout } from '../../src/layout/layout';
import type { ChartOption } from '../../src/types';

const canvas = { x: 0, y: 0, width: 600, height: 400 };

function layoutOf(option: ChartOption) {
  const norm = normalizeOption(option);
  return { norm, layout: computeLayout(norm, null, canvas) };
}

describe('computeLayout', () => {
  it('keeps the plot inside the canvas', () => {
    const { layout } = layoutOf({ series: [{ type: 'line', data: [1, 5, 3] }] });
    expect(layout.plot.x).toBeGreaterThanOrEqual(0);
    expect(layout.plot.y).toBeGreaterThanOrEqual(0);
    expect(layout.plot.x + layout.plot.width).toBeLessThanOrEqual(canvas.width);
    expect(layout.plot.y + layout.plot.height).toBeLessThanOrEqual(canvas.height);
  });

  it('reserves more space when a y axis name is present', () => {
    const without = layoutOf({ series: [{ type: 'line', data: [1, 5, 3] }] }).layout;
    const withName = layoutOf({ yAxis: { name: '销售额（万元）' }, series: [{ type: 'line', data: [1, 5, 3] }] }).layout;
    expect(withName.plot.x).toBeGreaterThan(without.plot.x);
  });

  it('reserves space for a top legend and lays items out horizontally', () => {
    const { layout } = layoutOf({
      legend: { show: true, position: 'top' },
      series: [
        { type: 'line', name: 'A', data: [1, 2] },
        { type: 'line', name: 'B', data: [2, 1] },
      ],
    });
    expect(layout.legend).not.toBeNull();
    const items = layout.legend!.items;
    expect(items).toHaveLength(2);
    expect(items[0].y).toBe(items[1].y);
    expect(items[1].x).toBeGreaterThan(items[0].x);
  });

  it('places a right legend vertically', () => {
    const { layout } = layoutOf({
      legend: { show: true, position: 'right' },
      series: [
        { type: 'line', name: 'A', data: [1, 2] },
        { type: 'line', name: 'B', data: [2, 1] },
      ],
    });
    const items = layout.legend!.items;
    expect(items[1].y).toBeGreaterThan(items[0].y);
    expect(items[0].x).toBe(items[1].x);
  });

  it('does not squeeze the plot when the legend sits on the right', () => {
    const { layout } = layoutOf({
      legend: { show: true, position: 'right' },
      series: [
        { type: 'line', name: 'A', data: [1, 2, 3] },
        { type: 'line', name: 'B', data: [2, 1, 3] },
      ],
    });
    // 右图例只应占几十像素；绘图区必须保留大部分宽度（曾因 Math.min 种子为 0 被挤成 20px）
    expect(layout.plot.width).toBeGreaterThan(canvas.width * 0.5);
    expect(layout.legendRect!.width).toBeLessThan(canvas.width * 0.3);
  });

  it('keeps a usable circle for polar scenes with a right legend', () => {
    const { layout } = layoutOf({
      legend: { show: true, position: 'right' },
      series: [
        {
          type: 'pie',
          name: '份额',
          data: [
            { name: 'A', value: 60 },
            { name: 'B', value: 40 },
          ],
        },
      ],
    });
    expect(layout.polar!.radius).toBeGreaterThan(canvas.height * 0.25);
    expect(layout.polar!.cx).toBeGreaterThan(canvas.width * 0.3);
  });

  it('reserves space for the title', () => {
    const without = layoutOf({ series: [{ type: 'line', data: [1, 2] }] }).layout;
    const withTitle = layoutOf({ title: { text: '销售趋势' }, series: [{ type: 'line', data: [1, 2] }] }).layout;
    expect(withTitle.plot.y).toBeGreaterThan(without.plot.y);
  });

  it('hides axis space when the axis is off', () => {
    const withAxis = layoutOf({ series: [{ type: 'line', data: [1, 2] }] }).layout;
    const withoutAxis = layoutOf({ xAxis: { show: false }, yAxis: { show: false }, series: [{ type: 'line', data: [1, 2] }] }).layout;
    expect(withoutAxis.plot.width).toBeGreaterThan(withAxis.plot.width);
  });

  it('类目密到亚像素级时，x 轴标签按「标签宽度 + 间隔」稀释（不会糊成一条色带）', () => {
    // 回归：缩放到 3565 根时（约 0.24px/根），Axis 组件以前会**自己再算一遍**抽稀步长，
    // 而且给间距兜了 1px 的下限（`Math.max(1, slot)`）—— 步长从 380 根变成 88 根，
    // 79.5px 宽的标签按 20.7px 的间隔画出去，末端糊成一条色带。
    // 现在抽稀只有一处（这里），下面同时盯住「间距」和「数量」。
    const data = Array.from({ length: 4000 }, (_, i) => i % 5);
    const { layout } = layoutOf({ xAxis: { type: 'category' }, series: [{ type: 'line', data }] });
    const ticks = layout.xAxisLayout.ticks;
    const labels = layout.xAxisLayout.labels;
    expect(ticks.length).toBe(4000);

    const kept = labels.map((text, i) => ({ text, i })).filter((row) => row.text);
    expect(kept.length).toBeGreaterThan(2);
    // 数量：一屏最多 plotWidth / 64 个（经验间隔）
    expect(kept.length).toBeLessThanOrEqual(Math.ceil(layout.plot.width / 64) + 1);

    // 间距：相邻保留标签的像素距离 ≥ 64（两端也不许挤）
    const spacing = layout.plot.width / (ticks.length - 1);
    for (let k = 1; k < kept.length; k++) {
      expect((kept[k].i - kept[k - 1].i) * spacing).toBeGreaterThanOrEqual(64 - 1e-6);
    }
    // 末尾那根必须也在保留名单里（时间轴右边要能读出「现在」）
    expect(kept[kept.length - 1].i).toBe(ticks.length - 1);
  });
});
