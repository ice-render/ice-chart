/**
 * **墨迹越界审计**（2026-09-25 立）：内容不许贴到画布边 —— 贴边就意味着被裁。
 *
 * 为什么单独一个脚本：这一类和现有两把尺子都擦肩而过。
 *   - `audit-space.mjs` 量的是「空间利用率」，统计墨迹时**主动只扫绘图区 ±8px 以内**，
 *     超过 8px 就出了它的视野；
 *   - `audit-interactions.mjs` 的越界探针只查**左右轴带里的饱和墨迹**，而文字是灰阶
 *     （通道极差 ≤ 45 判为非饱和）→ 看不见。
 * 于是「节点标签画到画布外、被裁掉半行」这种事两家都不报（实测：`dashboard-energy` 的力导向图
 * 底部只剩 1px 余量，标签被裁）。
 *
 * 判据**只有一条**：整幅墨迹（含文字，alpha > 8）离画布四边都要有余量。
 * 不判「墨迹不许出绘图区」—— 饼图的引导线标签、桑基的节点名、多轴分类流的轴名本来就该画在
 * 绘图区外，只要求它们别被画布裁掉；那条要白名单，等这条稳了再说。
 *
 * 用法：
 *   npm run build && npm run examples:prepare
 *   node scripts/serve-examples.cjs &
 *   node scripts/audit-bleed.mjs [输出 JSON 路径]
 *
 * 输出里带**最小余量排行榜**：阈值怎么定要看实测分布，别拍脑袋（本仓惯例）。
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const outFile = process.argv[2] || path.resolve(process.cwd(), '.bleed-audit.json');
const baseUrl = process.argv[3] || 'http://localhost:5177/examples';
/** 离画布边至少留这么多像素；贴到就等于被裁（默认 2，按实测分布调）。 */
const MIN_CLEARANCE = Number(process.env.MIN_CLEARANCE || 2);

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
  'matrix',
  'hexbin',
  'joint-plot',
  'calendar',
  'alluvial',
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

const browser = await chromium.launch();
const rows = [];

for (const name of pages) {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(`${baseUrl}/${name}.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
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
        const data = ctx.getImageData(0, 0, W, H).data;
        let l = W;
        let r = -1;
        let t = H;
        let b = -1;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (data[(y * W + x) * 4 + 3] <= 8) continue;
            if (x < l) l = x;
            if (x > r) r = x;
            if (y < t) t = y;
            if (y > b) b = y;
          }
        }
        if (r < 0) return null;
        const px = (v) => Math.round((v / dpr) * 10) / 10;
        return {
          key,
          kind: c.norm.kind,
          seriesTypes: [...new Set(c.norm.series.map((s) => s.type))],
          canvas: [Math.round(W / dpr), Math.round(H / dpr)],
          // 各边余量（CSS px）：0 = 已经贴到画布边
          clearance: { left: px(l), top: px(t), right: px(W - 1 - r), bottom: px(H - 1 - b) },
        };
      })
      .filter(Boolean);
  });
  for (const row of measured) rows.push({ page: name, ...row });
  if (errors.length) rows.push({ page: name, pageErrors: errors });
  await page.close();
}
await browser.close();

const withClearance = rows
  .filter((row) => row.clearance)
  .map((row) => ({ ...row, min: Math.min(...Object.values(row.clearance)) }))
  .sort((a, b) => a.min - b.min);
const failures = withClearance.filter((row) => row.min <= MIN_CLEARANCE);

console.log(`\n审计 ${withClearance.length} 张图（阈值：四边余量 > ${MIN_CLEARANCE}px）`);
console.log('\n最小余量排行榜（前 12）：');
for (const row of withClearance.slice(0, 12)) {
  console.log(
    `  ${String(row.min).padStart(7)}px  ${row.page}/${row.key} [${row.kind}] ${row.seriesTypes.join(',')}  ${JSON.stringify(row.clearance)}`
  );
}
if (failures.length) {
  console.log(`\n贴边（会被裁）：${failures.length} 张`);
  for (const row of failures) console.log(`  ${row.page}/${row.key} [${row.kind}] ${JSON.stringify(row.clearance)}`);
}
fs.writeFileSync(outFile, JSON.stringify({ threshold: MIN_CLEARANCE, rows: withClearance }, null, 1));
console.log(`\n失败 ${failures.length} 张；明细：${outFile}`);
process.exit(failures.length ? 1 : 0);
