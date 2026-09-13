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
  'treemap',
  'graph',
  'mini-matlab',
  'dsl-vs-option',
  'animation',
  'finance',
  'sankey',
  'serialize',
  'interactions',
  'time-series',
  'live-stream',
  'dashboard',
  'dashboard-iot',
  'dashboard-market',
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
        const data = ctx.getImageData(0, 0, W, H).data;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (data[(y * W + x) * 4 + 3] <= 8) continue;
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }
        const opt = c.norm.option || {};
        return {
          key,
          kind: c.norm.kind,
          aspect: opt.aspect || 'auto',
          rigidCircle: false,
          series: c.norm.series.map((s) => ({ type: s.type, roseType: s.option && s.option.roseType })),
          canvas: [c.layout.canvas.width, c.layout.canvas.height],
          ink: right < 0 ? null : { left: left / dpr, right: right / dpr, width: (right - left) / dpr },
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
    if (item.kind === 'cartesian' && item.aspect !== 'equal' && inkRatio < 0.85) {
      checks.push(`横向利用率 ${(inkRatio * 100).toFixed(0)}% < 85%`);
    }
    if (rigid && fillRatio !== null && fillRatio < 0.9) {
      checks.push(`图形只吃满可用直径的 ${(fillRatio * 100).toFixed(0)}%（应 ≥ 90%）`);
    }
    if (item.kind === 'cartesian' && item.aspect === 'equal' && inkRatio < 0.45) {
      checks.push(`等比坐标横向利用率 ${(inkRatio * 100).toFixed(0)}% < 45%`);
    }
    // 面板形状提醒（不算失败）：圆形的图放进明显过宽的卡片，两侧必然大片空
    const advisory =
      CIRCULAR.has(item.kind) && cw / ch > 2.6 && inkRatio < 0.4
        ? `卡片 ${cw}×${ch}（宽高比 ${(cw / ch).toFixed(1)}）对圆形图偏宽：圆只占 ${(inkRatio * 100).toFixed(0)}% 宽`
        : null;
    rows.push({ page: name, ...item, cw, ch, inkRatio, fillRatio, rigid, checks, advisory });
  }
  await page.close();
}

await browser.close();

const failures = rows.filter((r) => r.checks.length);
const advisories = rows.filter((r) => r.advisory);
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
console.log(`\n失败 ${failures.length} 项，提醒 ${advisories.length} 项`);
fs.writeFileSync(outFile, JSON.stringify({ rows, failures: failures.map((r) => `${r.page}·${r.key}`) }, null, 1));
console.log(`明细：${outFile}`);
process.exit(failures.length ? 1 : 0);
