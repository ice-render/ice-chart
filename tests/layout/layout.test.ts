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
});
