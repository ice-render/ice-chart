import { normalizeOption } from '../../src/option/normalize';
import { computeLayout } from '../../src/layout/layout';
import type { ChartOption } from '../../src/types';
import { measureTextWidth } from '../../src/util/text';

const canvas = { x: 0, y: 0, width: 600, height: 400 };

/** 首末 x 标签距画布边缘的最小留白（`xAxis.edgeLabelPadding` 的默认值）。 */
const EDGE_PADDING = 12;

function layoutOf(option: ChartOption) {
  const norm = normalizeOption(option);
  return { norm, layout: computeLayout(norm, null, canvas) };
}

describe('computeLayout', () => {
  describe('首末 x 标签的留白（edgeLabelPadding）', () => {
    /** 末标签很宽：居中画在刻度上时，有一半会探到绘图区外面。 */
    const wideLabel = 'WWWWWWWWWW';
    const wideOption: ChartOption = {
      xAxis: { type: 'value', min: 0, max: 100, formatter: () => wideLabel },
      series: [{ type: 'line', data: [[0, 1], [100, 2]] }],
    };

    it('末标签的右缘与画布边缘之间留出最小留白', () => {
      const { layout, norm } = layoutOf(wideOption);
      const half = measureTextWidth(null, wideLabel, norm.theme.fontSize, norm.theme.fontFamily) / 2;
      const plotRight = layout.plot.x + layout.plot.width;
      // 末刻度就是数据域上限 100，落在绘图区右沿上 —— 标签以它为中心，右缘还要再探出半宽
      expect(layout.canvas.width - (plotRight + half)).toBeGreaterThanOrEqual(EDGE_PADDING);
    });

    it('edgeLabelPadding: 0 关掉这条约束（回到旧行为）', () => {
      const { layout, norm } = layoutOf({
        ...wideOption,
        xAxis: { type: 'value', min: 0, max: 100, formatter: () => wideLabel, edgeLabelPadding: 0 },
      });
      const half = measureTextWidth(null, wideLabel, norm.theme.fontSize, norm.theme.fontFamily) / 2;
      const plotRight = layout.plot.x + layout.plot.width;
      expect(layout.canvas.width - (plotRight + half)).toBeLessThan(EDGE_PADDING);
    });

    it('标签本来就放得下时不动布局（不给既有图凭空收窄绘图区）', () => {
      const narrow: ChartOption = {
        xAxis: { type: 'value', min: 0, max: 9, formatter: () => '1' },
        series: [{ type: 'line', data: [[0, 1], [9, 2]] }],
      };
      const withDefault = layoutOf(narrow).layout;
      const off = layoutOf({ ...narrow, xAxis: { ...narrow.xAxis, edgeLabelPadding: 0 } }).layout;
      expect(withDefault.plot.width).toBe(off.plot.width);
      expect(withDefault.plot.x).toBe(off.plot.x);
    });

    it('类目轴：末标签画在最后一个带中心、本来就离边缘够远，不缩窄绘图区', () => {
      const category: ChartOption = {
        xAxis: { type: 'category', data: ['华东', '华北', '华南', '西南'] },
        series: [{ type: 'bar', data: [3, 5, 2, 4] }],
      };
      const withDefault = layoutOf(category).layout;
      const off = layoutOf({ ...category, xAxis: { ...category.xAxis, edgeLabelPadding: 0 } }).layout;
      expect(withDefault.plot.width).toBe(off.plot.width);
    });
  });

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

describe('面板矩阵（layout.panels）', () => {
  it('没有 matrix 时 panels 就是旧的 plot（逐像素一致）', () => {
    const { layout } = layoutOf({ series: [{ type: 'line', data: [1, 5, 3] }] });
    expect(layout.panels).toHaveLength(1);
    expect(layout.panels[0]).toEqual(layout.plot);
  });

  it('2×2 面板：四个矩形互不重叠，plot 是它们的并集', () => {
    const { layout } = layoutOf({
      matrix: { rows: 2, columns: 2, gap: 6 },
      series: [
        { type: 'line', data: [1, 5, 3], panel: 0 },
        { type: 'line', data: [3, 1, 2], panel: 3 },
      ],
    });
    expect(layout.panels).toHaveLength(4);
    // 列方向：右边那块从第一块的右边缘之后才开始（gap 真的留出来了）
    expect(layout.panels[1].x).toBeGreaterThanOrEqual(layout.panels[0].x + layout.panels[0].width);
    // 行方向同理
    expect(layout.panels[2].y).toBeGreaterThanOrEqual(layout.panels[0].y + layout.panels[0].height);
    // 并集贴着最后一块的右下角
    const last = layout.panels[3];
    expect(layout.plot.x + layout.plot.width).toBeCloseTo(last.x + last.width);
    expect(layout.plot.y + layout.plot.height).toBeCloseTo(last.y + last.height);
    expect(layout.plot.x).toBeCloseTo(layout.panels[0].x);
    expect(layout.plot.y).toBeCloseTo(layout.panels[0].y);
  });

  it('权重矩阵：列宽 4:1', () => {
    const { layout } = layoutOf({
      matrix: { rows: 1, columns: [4, 1], gap: 10 },
      series: [
        { type: 'line', data: [1, 5, 3], panel: 0 },
        { type: 'bar', data: [1, 2, 3], panel: 1 },
      ],
    });
    expect(layout.panels[0].width / layout.panels[1].width).toBeCloseTo(4);
    expect(layout.panels[1].x).toBeCloseTo(layout.panels[0].x + layout.panels[0].width + 10);
  });

  it('非直角坐标场景不吃 matrix（面板只在直角坐标生效）', () => {
    const { layout } = layoutOf({
      matrix: { rows: 2, columns: 2 },
      series: [{ type: 'pie', data: [{ name: 'A', value: 1 }] }],
    });
    expect(layout.panels).toHaveLength(1);
    expect(layout.panels[0]).toEqual(layout.plot);
  });
});
