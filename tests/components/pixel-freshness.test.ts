import { createChart, setMotionPreference } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

/**
 * 像素缓存新鲜度。
 *
 * `pixels` 是渲染与命中共用的几何。缓存键一旦漏掉某个几何输入（最典型的是**比例尺数据域**），
 * 缩放 / 平移 / 数据域过渡之后 `pixels` 就停在旧位置 —— 视觉上「看得见的点」与
 * 「点得到的点」分叉，表现为悬停高亮画在别处、命中判空。这类 bug 在浏览器里
 * 看起来像交互问题，实际是缓存问题，所以单独立一道门禁。
 *
 * 断言方式：清掉组件自己的缓存键字段后重算一遍，两次像素必须一致。
 */

const CASES: Array<{ name: string; option: ChartOption; change: (chart: ICEChart) => void }> = [
  {
    name: '折线',
    change: (chart) => chart.setDomain('y', [15, 50]),
    option: {
      legend: { show: false },
      xAxis: { type: 'category' },
      yAxis: {},
      series: [{ id: 'l', type: 'line', name: 'L', data: [10, 40, 25, 60, 35] }],
    },
  },
  {
    name: '柱形',
    change: (chart) => chart.setDomain('y', [15, 50]),
    option: {
      legend: { show: false },
      xAxis: { type: 'category' },
      yAxis: {},
      series: [{ id: 'b', type: 'bar', name: 'B', data: [10, 40, 25, 60, 35] }],
    },
  },
  {
    name: '箱线图',
    change: (chart) => chart.setDomain('y', [200, 400]),
    option: {
      legend: { show: false },
      xAxis: { type: 'category' },
      yAxis: {},
      series: [
        {
          id: 'x',
          type: 'boxplot',
          name: 'X',
          data: [
            [120, 200, 260, 340, 520],
            [90, 150, 210, 280, 610],
            [140, 230, 300, 380, 480],
          ],
        },
      ],
    },
  },
  {
    name: '热力图',
    // 类目轴的 setDomain 会被 clamp 回完整窗口，这里用「轴类目变少」造数据域变化
    change: (chart) =>
      chart.setOption({
        legend: { show: false },
        xAxis: { type: 'category', data: ['周一', '周二'] },
        yAxis: { type: 'category', data: ['早', '中', '晚'] },
        series: [{ id: 'h', type: 'heatmap', name: 'H', data: [1, 2, 3, 4, 5, 6, 7, 8, 9] }],
      }),
    option: {
      legend: { show: false },
      xAxis: { type: 'category', data: ['周一', '周二', '周三'] },
      yAxis: { type: 'category', data: ['早', '中', '晚'] },
      series: [
        {
          id: 'h',
          type: 'heatmap',
          name: 'H',
          data: [1, 2, 3, 4, 5, 6, 7, 8, 9],
        },
      ],
    },
  },
];

describe('像素缓存新鲜度（缓存键必须覆盖比例尺数据域）', () => {
  let canvas: any;
  let chart: ICEChart | null = null;

  beforeEach(() => {
    setMotionPreference('instant');
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

  /** 清掉组件自己的缓存键字段，强制用当前比例尺重算一遍像素。 */
  function recomputePixels(component: any): number[] {
    for (const key of Object.keys(component)) {
      if (/key$/i.test(key) && typeof component[key] === 'string') component[key] = '';
    }
    component.rebuildPixels();
    return Array.from(component.pixels);
  }

  for (const testCase of CASES) {
    it(`${testCase.name}：改变数据域之后像素必须重算`, async () => {
      chart = createChart(canvas, testCase.option);
      await chart.render();
      const component: any = chart.seriesComponents[0];
      // 先强制建一次基线（部分类型是懒加载像素的）
      const before = recomputePixels(component);
      expect(before.length).toBeGreaterThan(0);

      // 取数据域的真子区间（clampDomain 会拒绝超出数据范围的值）
      testCase.change(chart);
      await chart.render();

      // 走一次按需重建（命中 / 高亮锚点走的就是这条路径）
      component.pixelAt(0);
      const after = Array.from(component.pixels);
      const fresh = recomputePixels(component);
      // 1) 缓存确实失效了（像素变了）
      expect(after).not.toEqual(before);
      // 2) 而且和「清空缓存重算」的结果一致（没有残留旧几何）
      expect(after).toEqual(fresh);
    });
  }

  it('缩放 x 轴之后像素同样必须重算（类目轴窗口切片）', async () => {
    chart = createChart(canvas, CASES[0].option);
    await chart.render();
    const component: any = chart.seriesComponents[0];
    chart.setDomain('x', [1, 3]);
    await chart.render();
    expect(Array.from(component.pixels)).toEqual(recomputePixels(component));
  });
});
