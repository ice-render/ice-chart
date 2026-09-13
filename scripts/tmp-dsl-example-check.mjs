/** 临时：起静态服务 + 真浏览器跑一遍示例页（截图 + 控制台错误）。 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const root = '/Users/felix/Windows-E-workspace/felix/ice-render/ice-chart-dsl';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(root, path.normalize(url));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('404');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(5199, resolve));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});
await page.goto('http://localhost:5199/examples/chart-dsl.html', { waitUntil: 'load' });
await page.waitForTimeout(1200);
console.log('errors:', errors.length, errors.slice(0, 3).join(' | '));
for (const preset of ['line', 'bar', 'pie', 'scatter', 'function', 'radar', 'heatmap', 'candlestick', 'waterfall', 'sankey', 'bad-column']) {
  await page.click(`[data-preset="${preset}"]`);
  await page.waitForTimeout(700);
  const state = await page.evaluate(() => ({
    diagnostics: document.getElementById('diagnostics').textContent.trim().slice(0, 120),
    meta: document.getElementById('meta').textContent,
    series: window.chart && window.chart.norm ? window.chart.norm.series.length : null,
  }));
  console.log(`${preset.padEnd(11)} series=${state.series} | ${state.meta} | ${state.diagnostics}`);
  await page.screenshot({ path: `/tmp/ice-chart-dsl-${preset}.png`, clip: { x: 0, y: 0, width: 1500, height: 760 } });
}
console.log('页面错误总数：', errors.length);
await browser.close();
server.close();
