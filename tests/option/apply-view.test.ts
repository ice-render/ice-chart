/**
 * 视窗套用（`applyViewToNormalized`）与「带视窗重跑一遍归一化」的等价性契约。
 *
 * 背景：一次数据更新原来要跑**两遍**归一化 —— `applyOption` 一遍拿全域、
 * `rebuild` 一遍拿视窗域。第二遍的全部作用只是「把视窗套上去」：
 * 视窗在归一化里只影响三件事（x 域裁剪、y 轴显式域、表达式系列的采样区间），
 * 所以「全域结果 + 套视窗」可以取代第二遍。
 *
 * 这组用例就是那条等价性的门禁：漏掉任何一处依赖视窗的字段，
 * 都会以「与参照实现逐项不一致」在这里暴露（参照 = 现有的带 context 归一化）。
 */
import { applyViewToNormalized, canApplyView, normalizeOption } from '../../src/option/normalize';
import type { ChartOption } from '../../src/types';

const CATEGORIES = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'];

/** 类目轴 + 单系列（K 线那种：x 是字符串类目）。 */
function categoryOption(): ChartOption {
  return {
    animation: { enabled: false },
    legend: { show: false },
    xAxis: { type: 'category' },
    series: [{ id: 'a', type: 'line', data: CATEGORIES.map((x, i) => ({ x, y: i })) }],
  };
}

/** 数值轴 + 单系列。 */
function numericOption(): ChartOption {
  return {
    animation: { enabled: false },
    legend: { show: false },
    series: [{ id: 'a', type: 'line', data: Array.from({ length: 100 }, (_v, i) => ({ x: i, y: i % 17 })) }],
  };
}

/** 多 y 轴：套视窗时只有被指定的那根动。 */
function multiAxisOption(): ChartOption {
  return {
    animation: { enabled: false },
    legend: { show: false },
    yAxis: [{}, {}],
    series: [
      { id: 'a', type: 'line', data: Array.from({ length: 20 }, (_v, i) => ({ x: i, y: i })) },
      { id: 'b', type: 'line', yAxisIndex: 1, data: Array.from({ length: 20 }, (_v, i) => ({ x: i, y: 100 + i })) },
    ],
  };
}

/** 横向柱状图：类目在 y 轴上，值在 x 轴上。 */
function horizontalOption(): ChartOption {
  return {
    animation: { enabled: false },
    legend: { show: false },
    xAxis: { type: 'value' },
    yAxis: { type: 'category', data: ['华东', '华北', '华南', '西南', '西北'] },
    series: [{ id: 'sales', type: 'bar', data: [320, 302, 301, 334, 390] }],
  };
}

/** 热力图：y 轴是行类目。 */
function heatmapOption(): ChartOption {
  return {
    animation: { enabled: false },
    legend: { show: false },
    xAxis: { type: 'category' },
    yAxis: { type: 'category' },
    series: [
      {
        id: 'heat',
        type: 'heatmap',
        data: [
          ['周一', '上午', 10],
          ['周一', '下午', 30],
          ['周二', '上午', 50],
          ['周二', '下午', 90],
        ],
      },
    ],
  };
}

describe('视窗套用：域的口径与带视窗归一化一致', () => {
  test('类目轴：视窗裁成一段，域是那一段、偏移是起点下标', () => {
    const norm = applyViewToNormalized(normalizeOption(categoryOption()), { xDomain: ['C3', 'C6'] });
    expect(norm.xAxis.domain).toEqual(['C3', 'C4', 'C5', 'C6']);
    expect(norm.xAxis.categoryOffset).toBe(3);
  });

  test('类目轴：视窗端点不在类目里时退回全域（与参照实现同一条退化路径）', () => {
    const full = normalizeOption(categoryOption());
    const norm = applyViewToNormalized(full, { xDomain: ['C3', 'NOPE'] });
    expect(norm.xAxis.domain).toEqual(full.xAxis.domain);
    expect(norm.xAxis.categoryOffset).toBe(0);
  });

  test('数值轴：视窗就是那两个端点', () => {
    const norm = applyViewToNormalized(normalizeOption(numericOption()), { xDomain: [20, 40] });
    expect(norm.xAxis.domain).toEqual([20, 40]);
  });

  test('只给 x 视窗：y 轴域保持全域不动', () => {
    const full = normalizeOption(numericOption());
    const norm = applyViewToNormalized(full, { xDomain: [20, 40] });
    expect(norm.yAxis.domain).toEqual(full.yAxis.domain);
  });

  test('只给 y 视窗：x 轴域保持全域不动', () => {
    const full = normalizeOption(numericOption());
    const norm = applyViewToNormalized(full, { yDomains: [[0, 10]] });
    expect(norm.yAxis.domain).toEqual([0, 10]);
    expect(norm.xAxis.domain).toEqual(full.xAxis.domain);
  });

  test('多 y 轴：只改被指定的那一根', () => {
    const full = normalizeOption(multiAxisOption());
    const norm = applyViewToNormalized(full, { yDomains: [[0, 5], null] });
    expect(norm.yAxes[0].domain).toEqual([0, 5]);
    expect(norm.yAxes[1].domain).toEqual(full.yAxes[1].domain);
  });

  /**
   * 类目 y 轴（横向图 / 热力图的行）不吃 y 视窗 —— 这条规则是集成用例先抓出来的：
   * 套上去会让类目域变成视窗里的数值，横向柱子的类目带与热力图的行整块塌掉
   * （`tests/chart/horizontal.test.ts` / `tests/chart/heatmap.test.ts` 曾直接红）。
   */
  test('横向图 / 热力图：类目 y 轴不被 y 视窗覆盖', () => {
    const ranking = applyViewToNormalized(normalizeOption(horizontalOption()), { yDomains: [[0, 3]] });
    expect(ranking.yAxes[0].domain).toEqual(['华东', '华北', '华南', '西南', '西北']);

    const heat = applyViewToNormalized(normalizeOption(heatmapOption()), { yDomains: [[0, 1]] });
    expect(heat.yAxes[0].domain).toEqual(['上午', '下午']);
  });

  test('视窗为空：与全域逐项一致（这条路径不许改动任何域）', () => {
    const full = normalizeOption(categoryOption());
    const norm = applyViewToNormalized(full, { xDomain: null, yDomain: null });
    expect(norm.xAxis.domain).toEqual(full.xAxis.domain);
    expect(norm.yAxis.domain).toEqual(full.yAxis.domain);
  });
});

describe('视窗套用：只有「视窗不影响系列」时才允许走快路径', () => {
  test('普通直角坐标系列可以走快路径', () => {
    expect(canApplyView(normalizeOption(numericOption()))).toBe(true);
  });

  test('表达式系列不行（采样区间由视窗决定）', () => {
    const norm = normalizeOption({
      animation: { enabled: false },
      series: [{ id: 'f', type: 'function', expression: 'sin(x)' }],
    });
    expect(canApplyView(norm)).toBe(false);
  });

  test('参数曲线不行（同一个采样区间口径）', () => {
    const norm = normalizeOption({
      animation: { enabled: false },
      series: [{ id: 'p', type: 'parametric', xExpression: 'cos(t)', yExpression: 'sin(t)' }],
    });
    expect(canApplyView(norm)).toBe(false);
  });

  test('等比坐标不行（两个轴的跨度会被重新拉齐）', () => {
    expect(canApplyView(normalizeOption({ ...numericOption(), aspect: 'equal' }))).toBe(false);
  });
});

describe('视窗套用：与「带视窗重跑一遍归一化」逐项一致', () => {
  const cases: Array<{ name: string; option: () => ChartOption; view: Parameters<typeof applyViewToNormalized>[1] }> = [
    { name: '类目轴 · 窗口在中间', option: categoryOption, view: { xDomain: ['C2', 'C7'] } },
    { name: '类目轴 · 窗口到端点', option: categoryOption, view: { xDomain: ['C0', 'C9'] } },
    { name: '类目轴 · 端点不存在', option: categoryOption, view: { xDomain: ['C1', 'X'] } },
    { name: '数值轴 · x 窗口', option: numericOption, view: { xDomain: [10, 30] } },
    { name: '数值轴 · x + y 窗口', option: numericOption, view: { xDomain: [10, 30], yDomains: [[0, 3]] } },
    { name: '数值轴 · 只 y 窗口', option: numericOption, view: { yDomains: [[0, 2]] } },
    {
      name: '多 y 轴 · 两个窗口',
      option: multiAxisOption,
      view: {
        xDomain: [5, 15],
        yDomains: [
          [5, 15],
          [105, 115],
        ],
      },
    },
    {
      name: '多 y 轴 · 只改第二根',
      option: multiAxisOption,
      view: {
        yDomains: [
          [0, 19],
          [105, 115],
        ],
      },
    },
    { name: '横向柱状图 · y 视窗对类目轴无效', option: horizontalOption, view: { yDomains: [[0, 3]] } },
    { name: '横向柱状图 · x（值轴）视窗', option: horizontalOption, view: { xDomain: [300, 340] } },
    { name: '热力图 · y 视窗对行类目无效', option: heatmapOption, view: { yDomains: [[0, 1]] } },
    { name: '热力图 · x 类目视窗', option: heatmapOption, view: { xDomain: ['周一', '周二'] } },
  ];

  for (const item of cases) {
    test(item.name, () => {
      const option = item.option();
      const view = item.view;
      // 参照实现：老路子 —— 带视窗把归一化整条重跑一遍
      const reference = normalizeOption(option, view);
      const fast = applyViewToNormalized(normalizeOption(item.option()), view);

      expect(fast.xAxis.domain).toEqual(reference.xAxis.domain);
      expect(fast.xAxis.type).toBe(reference.xAxis.type);
      expect(fast.xAxis.categoryOffset).toBe(reference.xAxis.categoryOffset);
      expect(fast.yAxes.map((axis) => axis.domain)).toEqual(reference.yAxes.map((axis) => axis.domain));
      expect(fast.yAxis.domain).toEqual(reference.yAxis.domain);
      expect(fast.categories).toEqual(reference.categories);
      expect(fast.series.map((s) => [s.id, s.type, s.pointCount])).toEqual(
        reference.series.map((s) => [s.id, s.type, s.pointCount])
      );
      expect(fast.visibleSeries.map((s) => s.id)).toEqual(reference.visibleSeries.map((s) => s.id));
    });
  }
});
