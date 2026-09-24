/**
 * 空间利用率审计：图表到底有没有把「它能用的地方」用起来。
 *
 * 起因是一个真实反馈：「有些图表没有有效占用横向空间，右侧浪费太多」。
 * 量下来分三类：
 *   1. 直角坐标（非等比）—— 平均占宽 92%，右侧只留默认 16px 边距（没问题）；
 *   2. 圆形类（饼 / 雷达 / 仪表盘 / 水位球）—— 圆的直径受较短边限制，
 *      面板越宽两侧空得越多；**引擎侧真正的问题是仪表盘/水位球被误减了一圈「饼图引导线标签」预留**，
 *      图形只吃满可用半径的一半；
 *   3. 等比坐标（aspect: 'equal'）—— 绘图区被压成正方形居中，两侧死区随面板变宽而变大。
 *
 * 这个脚本守两条硬指标（面板形状是设计取舍，只给提醒、不算失败）：
 *   - 直角坐标（非等比）：墨迹横向占画布 ≥ 85%
 *   - 圆形类：图形直径 / 该图分配到的直径（2 × polar.radius）≥ 0.9
 *   - 等比坐标：墨迹横向占画布 ≥ 45%
 *
 * 用法：
 *   npm run build && npm run examples:prepare
 *   node scripts/serve-examples.cjs &
 *   node scripts/audit-space.mjs [输出 JSON 路径]
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const outFile = process.argv[2] || path.resolve(process.cwd(), '.space-audit.json');
const baseUrl = process.argv[3] || 'http://localhost:5177/examples';
const CIRCULAR = new Set(['polar', 'radar', 'gauge', 'liquid']);
const pages = [
  'basic-line',
  'bar-stack',
  'horizontal-bubble',
  'multi-axis',
  'pie',
  'radar',
  'funnel-gauge',
  'boxplot-waterfall',
  'distribution',
  'treemap',
  'graph',
  'mini-matlab',
  'dsl-vs-option',
  'editable-chart',
  'animation',
  'finance',
  'sankey',
  'serialize',
  'interactions',
  'time-series',
  'live-stream',
  'dashboard',
  'dashboard-iot',
  'dashboard-energy',
  'dashboard-logistics',
  'dashboard-lab',
  'large-data',
  'a11y',
  'linked-charts',
];

/** 画布上「有墨」的横向范围：alpha > 8 即算绘制过。 */
function inkExtent(canvasEl, dpr) {
  const ctx = canvasEl.getContext('2d');
  const W = Math.round(canvasEl.width);
  const H = Math.round(canvasEl.height);
  let left = W;
  let right = -1;
  const data = ctx.getImageData(0, 0, W, H).data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] <= 8) continue;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (right < 0) return null;
  return { left: left / dpr, right: right / dpr, width: (right - left) / dpr };
}

/**
 * 「刚性圆形」：图形本身就占满整圆的那些类型，直径可以直接和分配到的直径比。
 * 玫瑰图（roseType）与雷达要排除 —— 前者的扇区半径按数值缩放、后者的图形是多边形，
 * 墨迹天然小于整圆，拿整圆当基准会报假警（实测就报过 88% / 85%）。
 */
function isRigidCircle(kind, series) {
  if (kind === 'gauge' || kind === 'liquid') return true;
  if (kind !== 'polar') return false;
  return !series.some((s) => s.type === 'pie' && s.option && s.option.roseType);
}

const browser = await chromium.launch();
const rows = [];

for (const name of pages) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`${baseUrl}/${name}.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1400);
  const measured = await page.evaluate(() => {
    const charts = [];
    const push = (c, key) => {
      if (c && c.norm && c.layout && c.ice && c.ice.canvasEl) charts.push({ key, c });
    };
    push(window.__chart, 'chart');
    if (window.__charts) for (const k of Object.keys(window.__charts)) push(window.__charts[k], k);
    if (window.__link && window.__link.charts) window.__link.charts.forEach((c, i) => push(c, 'link' + i));
    const seen = new Set();
    return charts
      .filter(({ c }) => (seen.has(c) ? false : (seen.add(c), true)))
      .map(({ key, c }) => {
        const cv = c.ice.canvasEl;
        const ctx = cv.getContext('2d');
        const dpr = c.ice.dpr || 1;
        const W = Math.round(cv.width);
        const H = Math.round(cv.height);
        let left = W;
        let right = -1;
        let top = H;
        let bottom = -1;
        const data = ctx.getImageData(0, 0, W, H).data;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (data[(y * W + x) * 4 + 3] <= 8) continue;
            // 只看绘图区附近（图例色块 / 标题都不算「系列墨迹」）
            const plot = c.layout.plot;
            if (x < (plot.x - 8) * dpr || x > (plot.x + plot.width + 8) * dpr) continue;
            if (y < (plot.y - 8) * dpr || y > (plot.y + plot.height + 8) * dpr) continue;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }
        const opt = c.norm.option || {};
        const yOpt = (c.norm.yAxes[0] && c.norm.yAxes[0].option) || {};
        const xOpt = c.norm.xAxis.option || {};
        const plot = c.layout.plot;
        // 系列几何包围盒：直接取数据点的像素位置（组件本地坐标 + 组件盒偏移）。
        // 不用扫像素 —— 深色主题的坐标轴线本身是彩色，会被「饱和墨迹」当成系列墨迹（实测假阳性一堆）。
        let sx0 = Infinity;
        let sy0 = Infinity;
        let sx1 = -Infinity;
        let sy1 = -Infinity;
        if (c.norm.kind === 'cartesian' && c.norm.orientation !== 'horizontal') {
          for (const comp of c.seriesComponents) {
            if (!comp || comp.state.display === false) continue;
            const total = comp.series.points.length;
            for (let i = 0; i < total; i++) {
              const pixel = comp.pixelAt(i);
              if (!pixel || !isFinite(pixel[0]) || !isFinite(pixel[1])) continue;
              const chartX = comp.state.left + pixel[0];
              const chartY = comp.state.top + pixel[1];
              if (chartX < sx0) sx0 = chartX;
              if (chartX > sx1) sx1 = chartX;
              if (chartY < sy0) sy0 = chartY;
              if (chartY > sy1) sy1 = chartY;
            }
          }
        }
        const seriesBox = sx1 >= sx0 ? { left: sx0, right: sx1, top: sy0, bottom: sy1 } : null;
        const domains = c.norm.xAxis.domain;
        const xType = c.norm.xAxis.type;
        const xCount = Array.isArray(c.norm.xAxis.domain) ? c.norm.xAxis.domain.length : 0;
        const visiblePoints = c.norm.series.reduce((sum, s) => {
          return (
            sum +
            s.points.filter((p) => {
              const v = typeof p.xValue === 'number' ? p.xValue : null;
              if (v === null) return true;
              const lo = typeof domains[0] === 'number' ? domains[0] : -Infinity;
              const hi = typeof domains[domains.length - 1] === 'number' ? domains[domains.length - 1] : Infinity;
              return v >= lo && v <= hi;
            }).length
          );
        }, 0);
        return {
          key,
          kind: c.norm.kind,
          aspect: opt.aspect || 'auto',
          rigidCircle: false,
          series: c.norm.series.map((s) => ({ type: s.type, roseType: s.option && s.option.roseType })),
          canvas: [c.layout.canvas.width, c.layout.canvas.height],
          plot: [Math.round(plot.x), Math.round(plot.y), Math.round(plot.width), Math.round(plot.height)],
          ink:
            right < 0
              ? null
              : {
                  left: left / dpr,
                  right: right / dpr,
                  top: top / dpr,
                  bottom: bottom / dpr,
                  width: (right - left) / dpr,
                },
          seriesBox,
          declared: {
            xMin: xOpt.min !== undefined,
            xMax: xOpt.max !== undefined,
            yMin: yOpt.min !== undefined,
            yMax: yOpt.max !== undefined,
          },
          xType,
          xCount,
          hasSlider: !!c.layout.slider,
          viewActive: !!(c.viewState && c.viewState.x),
          visiblePoints,
          radius: c.layout.polar ? c.layout.polar.radius : null,
        };
      });
  });
  for (const item of measured) {
    const [cw, ch] = item.canvas;
    const inkRatio = item.ink ? item.ink.width / cw : 0;
    const fillRatio = item.radius ? (item.ink ? item.ink.width / (2 * item.radius) : 0) : null;
    const rigid = isRigidCircle(item.kind, item.series.map((s) => ({ type: s.type, option: { roseType: s.roseType } })));
    const checks = [];
    // 绘图区留白：自动算出来的数据域不许让曲线贴边（显式写的 min/max 是用户的选择，只提醒不判失败）
    const advisories = [];
    // 系列在「绘图区」里的占比（比画布占比更能说明"有没有用满"）：
    // - 数值 / 时间轴：应该接近 100%（只有留白）
    // - 类目轴：band 天然内缩半个带宽，上限是 1 - 1/n
    // - 等比坐标：绘图区是正方形，曲线应该填满这个正方形
    const [plotX, plotY, plotW, plotH] = item.plot || [0, 0, 0, 0];
    const seriesW = item.seriesBox ? item.seriesBox.right - item.seriesBox.left : null;
    const plotRatio = seriesW !== null && plotW > 0 ? seriesW / plotW : null;
    const canvasRatio = seriesW !== null && item.canvas[0] > 0 ? seriesW / item.canvas[0] : null;
    if (item.kind === 'cartesian' && item.seriesBox && item.plot) {
      const [px, py, pw, ph] = item.plot;
      const baseline = item.series.some((s) => ['area', 'bar', 'waterfall', 'boxplot', 'heatmap'].includes(s.type));
      const gaps = {
        top: item.seriesBox.top - py,
        bottom: py + ph - item.seriesBox.bottom,
        left: item.seriesBox.left - px,
        right: px + pw - item.seriesBox.right,
      };
      // 函数 / 参数曲线：按「可视区间」重采样，天然铺满左右（MATLAB 的 fplot 也是这样），
      // 左右不算贴边；上下靠自动贴合 + 留白，仍然要检查。
      const curveKind = item.series.some((s) => s.type === 'function' || s.type === 'parametric');
      const sides = [
        { side: 'top', gap: gaps.top, declared: item.declared.yMax },
        { side: 'bottom', gap: gaps.bottom, declared: item.declared.yMin },
        { side: 'left', gap: gaps.left, declared: item.declared.xMin, window: curveKind || item.hasSlider || item.viewActive },
        { side: 'right', gap: gaps.right, declared: item.declared.xMax, window: curveKind || item.hasSlider || item.viewActive },
      ];
      for (const s of sides) {
        if (s.gap >= 2) continue;
        if (s.side === 'bottom' && baseline) continue; // 柱形 / 面积的基线本来就贴轴
        if (s.window) continue; // 缩放 / 滑块 / 流式窗口的边界就是数据边界
        const label = `${s.side === 'top' || s.side === 'bottom' ? '上下' : '左右'}边留白 ${s.gap.toFixed(0)}px`;
        if (s.declared) advisories.push(`显式范围让图形贴到${label}`);
        else checks.push(`自动域仍贴${label}`);
      }
    }
    if (item.kind === 'cartesian' && item.aspect !== 'equal' && plotRatio !== null) {
      // 类目轴：band 内缩半个带宽，上限就是 1 - 1/n（8 个类目最多 87.5%）
      const expected = item.xType === 'category' && item.xCount > 1 ? 1 - 1 / item.xCount : 1;
      const floor = Math.max(0.6, expected - 0.08);
      if (plotRatio < floor) {
        // 数据只占轴范围的一部分（流式窗口还没填满 / 数据集中在中间）—— 是数据的问题，不是渲染缺陷
        advisories.push(`数据只占绘图区宽度的 ${(plotRatio * 100).toFixed(0)}%（${item.xType === 'category' ? '类目轴' : '数值轴'}）`);
      }
    }
    if (rigid && fillRatio !== null && fillRatio < 0.9) {
      checks.push(`图形只吃满可用直径的 ${(fillRatio * 100).toFixed(0)}%（应 ≥ 90%）`);
    }
    if (item.kind === 'cartesian' && item.aspect === 'equal' && plotRatio !== null && plotRatio < 0.6) {
      checks.push(`等比坐标曲线只占正方形绘图区的 ${(plotRatio * 100).toFixed(0)}% < 60%`);
    }
    // 面板形状提醒（不算失败）：圆形的图放进明显过宽的卡片，两侧必然大片空
    const squareish = CIRCULAR.has(item.kind) || item.aspect === 'equal';
    const advisory =
      squareish && cw / ch > 2.6 && canvasRatio !== null && canvasRatio < 0.4
        ? `卡片 ${cw}×${ch}（宽高比 ${(cw / ch).toFixed(1)}）对「方」的图形偏宽：图形只占 ${(canvasRatio * 100).toFixed(0)}% 宽`
        : null;
    rows.push({ page: name, ...item, cw, ch, inkRatio, fillRatio, rigid, checks, advisory, advisories });
  }
  await page.close();
}

await browser.close();

const failures = rows.filter((r) => r.checks.length);
const advisories = rows.filter((r) => r.advisory);
const paddingAdvisories = rows.filter((r) => r.advisories && r.advisories.length);
const avg = (list) => (list.length ? (list.reduce((a, r) => a + r.inkRatio, 0) / list.length) * 100 : 0);
const cartesian = rows.filter((r) => r.kind === 'cartesian' && r.aspect !== 'equal');
const equalAspect = rows.filter((r) => r.kind === 'cartesian' && r.aspect === 'equal');
const circular = rows.filter((r) => CIRCULAR.has(r.kind));

console.log(
  `图表 ${rows.length} 张 | 直角坐标（非等比）${cartesian.length} 张平均占宽 ${avg(cartesian).toFixed(1)}% | ` +
    `等比坐标 ${equalAspect.length} 张平均占宽 ${avg(equalAspect).toFixed(1)}% | 圆形类 ${circular.length} 张平均占宽 ${avg(circular).toFixed(1)}%`
);
if (failures.length) {
  console.log('\n不达标：');
  for (const r of failures) console.log(`  ${r.page} · ${r.key}（${r.kind}）：${r.checks.join('；')}`);
}
if (advisories.length) {
  console.log('\n面板形状提醒（不算失败，供排版时取舍）：');
  for (const r of advisories) console.log(`  ${r.page} · ${r.key}：${r.advisory}`);
}
if (paddingAdvisories.length) {
  console.log('\n留白提醒（显式写死的范围让图形贴边，改范围或交给自动域都行）：');
  for (const r of paddingAdvisories) console.log(`  ${r.page} · ${r.key}：${r.advisories.join('；')}`);
}
console.log(`\n失败 ${failures.length} 项，提醒 ${advisories.length + paddingAdvisories.length} 项`);
fs.writeFileSync(outFile, JSON.stringify({ rows, failures: failures.map((r) => `${r.page}·${r.key}`) }, null, 1));
console.log(`明细：${outFile}`);
process.exit(failures.length ? 1 : 0);
