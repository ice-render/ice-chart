/**
 * 示例页排版审计：**画布有没有溢出它所在的卡片**。
 *
 * 起因（2026-09-25）：`.row .card` 早先写的是 `flex: 1 1 420px; min-width: 380px`，1280 视口下
 * 卡片被压到 598px，而画布是固定内建宽 620px —— 画布溢出卡片 47px、被窗口右缘切掉。
 * 图表本身没错，错在**页面排版**，所以门禁量的是三个数：画布右缘 vs 卡片内边 vs 视口。
 *
 * 判据：
 *   - **失败**：画布右缘超出卡片内容区（内容被裁 / 压到隔壁卡片上）；
 *   - **只提示**：画布/页面比视口宽（graph 1560、animation 1260、大屏 1572 都是有意为之 ——
 *     设计宽就是设计宽，宁可横向滚动也不缩图，缩了命中检测会整体偏移）。
 *
 * 用法：
 *   npm run build && npm run examples:prepare
 *   node scripts/serve-examples.cjs &
 *   node scripts/audit-pages.mjs          # 默认 1280（常见笔记本视口）
 *   WIDTH=1024 node scripts/audit-pages.mjs
 */
import { chromium } from 'playwright';
import fs from 'fs';

const width = Number(process.env.WIDTH || 1280);
const baseUrl = process.env.BASE_URL || 'http://localhost:5177/examples';
/** 页面清单只有一个来源：交互审计那份（新页加进去，这里自动跟上）。 */
const source = fs.readFileSync(new URL('./audit-interactions.mjs', import.meta.url), 'utf8');
const pages = source
  .match(/const pages = \[([\s\S]*?)\];/)[1]
  .match(/'([^']+)'/g)
  .map((s) => s.slice(1, -1));

const browser = await chromium.launch();
const rows = [];
for (const name of pages) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${baseUrl}/${name}.html`, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  const measured = await page.evaluate(() => {
    const canvases = [];
    for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
      const rect = canvas.getBoundingClientRect();
      const card = canvas.closest('.card') || canvas.parentElement;
      const style = getComputedStyle(card);
      const innerRight = card.getBoundingClientRect().right - parseFloat(style.paddingRight || '0');
      canvases.push({
        canvasRight: +rect.right.toFixed(1),
        cardInnerRight: +innerRight.toFixed(1),
        overflow: +(rect.right - innerRight).toFixed(1),
        viewportOverflow: +(rect.right - window.innerWidth).toFixed(1),
      });
    }
    return { canvases, docWidth: document.documentElement.scrollWidth, viewport: window.innerWidth };
  });
  const worst = measured.canvases.length ? Math.max(...measured.canvases.map((c) => c.overflow)) : 0;
  const worstViewport = measured.canvases.length ? Math.max(...measured.canvases.map((c) => c.viewportOverflow)) : 0;
  rows.push({ page: name, canvases: measured.canvases.length, worst, worstViewport, docWidth: measured.docWidth });
  await page.close();
}
await browser.close();

const failures = rows.filter((r) => r.worst > 1);
const scrolls = rows.filter((r) => r.worst <= 1 && r.worstViewport > 0);
console.log(`视口 ${width}px · 示例页 ${rows.length} 页 · 画布 ${rows.reduce((n, r) => n + r.canvases, 0)} 张`);
for (const r of rows) {
  const flag = r.worst > 1 ? '✗' : ' ';
  if (r.worst > 1) console.log(`  ${flag} ${r.page.padEnd(26)} 画布溢出卡片 ${r.worst}px`);
}
if (scrolls.length) {
  console.log(`  · 设计宽于视口、页面横向滚动（有意）：${scrolls.map((r) => `${r.page}(${r.docWidth})`).join(', ')}`);
}
console.log(
  failures.length
    ? `失败 ${failures.length} 页：${failures.map((r) => `${r.page}(+${r.worst}px)`).join(', ')}`
    : `失败 0 页 —— 没有画布溢出卡片`
);
process.exit(failures.length ? 1 : 0);
