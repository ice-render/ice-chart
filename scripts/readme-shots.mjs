/**
 * README 截图：跑在示例服务之上，产出 `docs/screenshots/*.png`。
 *
 * 用法：
 *   npm run build && npm run examples:prepare
 *   node scripts/serve-examples.cjs &
 *   node scripts/readme-shots.mjs            # 可选参数：输出目录
 *
 * 和审计脚本一样，视觉 / 主题 / 示例改动之后重跑一遍，README 里的图才不会和实际效果脱节。
 * 截图不进 npm 包（`files` 只收 dist），只在仓库里给 README 与 GitHub 页面用。
 */
import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';

const outDir = process.argv[2] || path.resolve(process.cwd(), 'docs/screenshots');
const baseUrl = process.argv[3] || 'http://localhost:5177/examples';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ice-chart-shots-'));
fs.mkdirSync(outDir, { recursive: true });

/** 五个大屏的顺序与强调色（对比图的图例点用）。 */
const DASHBOARDS = [
  ['运营监控', 'dashboard.html', '#00e5ff'],
  ['设备监控', 'dashboard-iot.html', '#2ee6c5'],
  ['能源调度', 'dashboard-energy.html', '#7c8cff'],
  ['物流调度', 'dashboard-logistics.html', '#ff7a45'],
  ['函数实验', 'dashboard-lab.html', '#a78bfa'],
];

const browser = await chromium.launch();

async function shot(file, url, { width = 1600, height = 1000, dsf = 1, wait = 1600, before, el } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dsf });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${baseUrl}/${url}`, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
  if (before) await before(page);
  if (el) {
    const handle = await page.$(el);
    await handle.screenshot({ path: `${outDir}/${file}` });
  } else {
    await page.screenshot({ path: `${outDir}/${file}` });
  }
  await page.close();
  console.log(`${file}${errors.length ? ` —— console 有 ${errors.length} 条错误：${errors[0]}` : ''}`);
  return errors;
}

/** 画布矩形（探针用画布而不是绘图区：贴边悬停更稳）。 */
const canvasBox = (page) =>
  page.evaluate(() => {
    const cv = document.querySelector('canvas');
    const rect = cv.getBoundingClientRect();
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  });

// 头图：运营监控大屏（顶栏 + KPI + 前两行面板）。dsf 0.875 让 1600 的设计宽落成 1400 的文件宽。
await shot('hero.png', 'dashboard.html', { width: 1600, height: 820, dsf: 0.875, wait: 2200 });

// 五个大屏各拍一张（临时目录），再拼成一张对比图
for (const [index, [, file]] of DASHBOARDS.entries()) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/${file}`, { waitUntil: 'load' });
  await page.waitForTimeout(2200);
  await page.screenshot({ path: path.join(tmpDir, `dash-${index}.png`) });
  await page.close();
}
const sheetHtml = `<!DOCTYPE html><html><head><meta charset="utf-8" /><style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px; background: #030711; font-family: system-ui, "PingFang SC", sans-serif; }
  main { display: grid; grid-template-columns: repeat(3, 520px); gap: 12px; }
  figure { margin: 0; position: relative; width: 520px; height: 325px; overflow: hidden;
    border: 1px solid rgba(255,255,255,0.14); border-radius: 4px; background: #000; }
  figure img { display: block; width: 520px; height: 325px; object-fit: cover; object-position: top center; }
  figcaption { position: absolute; left: 0; bottom: 0; right: 0; display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; font-size: 15px; color: #fff; letter-spacing: 1px;
    background: linear-gradient(180deg, transparent, rgba(0,0,0,0.82) 45%); }
  figcaption i { width: 9px; height: 9px; border-radius: 50%; box-shadow: 0 0 10px currentColor; }
  </style></head><body><main>${DASHBOARDS.map(
    ([title, , color], index) =>
      `<figure><img src="${path.join(tmpDir, `dash-${index}.png`)}" alt="${title}" />` +
      `<figcaption><i style="background:${color}"></i>${title}</figcaption></figure>`
  ).join('')}</main></body></html>`;
fs.writeFileSync(path.join(tmpDir, 'sheet.html'), sheetHtml);
{
  const page = await browser.newPage({ viewport: { width: 1600, height: 720 }, deviceScaleFactor: 0.875 });
  await page.goto(`file://${path.join(tmpDir, 'sheet.html')}`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  const main = await page.$('main');
  await main.screenshot({ path: `${outDir}/dashboards.png` });
  await page.close();
  console.log('dashboards.png');
}

// 默认浅色主题 + 悬停提示框
await shot('charts-light.png', 'basic-line.html', {
  width: 1280,
  height: 900,
  before: async (page) => {
    const box = await canvasBox(page);
    await page.mouse.move(box.x + box.w * 0.62, box.y + box.h * 0.42, { steps: 8 });
    await page.waitForTimeout(600);
  },
});

// 交互：框选 + 十字准星 + 提示框 + 事件日志
await shot('interaction.png', 'interactions.html', {
  width: 1400,
  height: 1050,
  before: async (page) => {
    const box = await canvasBox(page);
    await page.mouse.move(box.x + box.w * 0.25, box.y + box.h * 0.35);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * 0.6, box.y + box.h * 0.7, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    await page.mouse.move(box.x + box.w * 0.55, box.y + box.h * 0.72, { steps: 5 });
    await page.waitForTimeout(600);
  },
});

// 函数绘图（迷你 MATLAB）
await shot('mini-matlab.png', 'mini-matlab.html', { width: 1400, height: 980 });

// 序列化 JSON 面板
await shot('snapshot.png', 'dashboard.html', {
  width: 1600,
  height: 1000,
  wait: 1900,
  before: async (page) => {
    await page.evaluate(() => document.getElementById('snapshot-panel').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(700);
  },
  el: '#snapshot-panel',
});

await browser.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`截图已写入 ${outDir}`);
