/**
 * 交互外观审计：对每个示例页跑一遍真实交互（悬停 / 缩放 / 平移 / 框选 / 图例 / 键盘 / 滑块），
 * 每步都做两件事：
 *   1. 截图（人工复核外观有没有异常、交叠）；
 *   2. 页内几何断言（提示框是否越界、是否压住坐标轴标签/图例，高亮是否落在绘图区内）。
 *
 * 用法：
 *   npm run build && npm run examples:prepare
 *   node scripts/serve-examples.cjs &
 *   node scripts/audit-interactions.mjs [输出目录] [起始URL]
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const outDir = process.argv[2] || path.resolve(process.cwd(), '.audit');
const baseUrl = process.argv[3] || 'http://localhost:5177/examples';
const pages = [
  'basic-line',
  'bar-stack',
  'multi-axis',
  'pie',
  'radar',
  'finance',
  'sankey',
  'interactions',
  'time-series',
  'large-data',
  'a11y',
  'linked-charts',
];

fs.mkdirSync(outDir, { recursive: true });

/** 注入到页面里：收集每张图的几何信息，用于「有没有交叠/越界」的自动判断。 */
function collectGeometry() {
  const charts = [];
  const push = (c) => {
    if (c && c.norm && c.layout) charts.push(c);
  };
  push(window.__chart);
  const many = window.__charts;
  if (many && typeof many === 'object') for (const key of Object.keys(many)) push(many[key]);
  const link = window.__link;
  if (link && Array.isArray(link.charts)) for (const c of link.charts) push(c);
  return charts.map((c) => {
    const canvas = c.layout.canvas;
    const plot = c.layout.plot;
    const legendItems = (c.layout.legend ? c.layout.legend.items : []).map(it => ({
      x: it.x,
      y: it.y,
      width: it.width,
      height: it.height,
    }));
    const tooltip = c.tooltip && c.tooltip.lastRect ? c.tooltip.lastRect : null;
    const chips = c.crosshair && c.crosshair.lastChipRects ? c.crosshair.lastChipRects : [];
    // 高亮标记的 x/y 一律是中心；贴边的数据点允许半个标记探出绘图区
    const marks =
      c.highlight && c.highlight.hoverItems
        ? c.highlight.hoverItems.map((m) => ({
            x: m.x,
            y: m.y,
            half: Math.max(m.size || 0, m.width || 0, m.height || 0) / 2,
          }))
        : [];
    return { canvas, plot, legendItems, tooltip, chips, marks, kind: c.norm.kind, slider: c.layout.slider };
  });
}

function overlaps(a, b) {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

function inside(inner, outer, tol = 0.5) {
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    inner.x + inner.width <= outer.x + outer.width + tol &&
    inner.y + inner.height <= outer.y + outer.height + tol
  );
}

const browser = await chromium.launch();
const report = [];

for (const name of pages) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  await page.goto(`${baseUrl}/${name}.html`, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  /** 一次「交互 + 断言 + 截图」。 */
  const step = async (label, action) => {
    if (action) await action();
    await page.waitForTimeout(220);
    const geometry = await page.evaluate(collectGeometry);
    const issues = [];
    for (const g of geometry) {
      if (g.tooltip) {
        if (!inside(g.tooltip, g.canvas)) issues.push('tooltip-out-of-canvas');
        for (const chip of g.chips) if (overlaps(g.tooltip, chip)) issues.push('tooltip-over-axis-label');
        for (const item of g.legendItems) if (overlaps(g.tooltip, item)) issues.push('tooltip-over-legend');
      }
      for (const mark of g.marks) {
        const box = { x: mark.x - mark.half, y: mark.y - mark.half, width: mark.half * 2, height: mark.half * 2 };
        if (!inside(box, g.plot, mark.half + 1)) issues.push('highlight-out-of-plot');
      }
    }
    await page.screenshot({ path: path.join(outDir, `${name}-${label}.png`) });
    report.push({ page: name, step: label, charts: geometry.length, issues });
  };

  const firstCanvas = await page.$('canvas');
  const box = firstCanvas ? await firstCanvas.boundingBox() : null;
  const target = async (fx, fy) => {
    if (!box) return [10, 10];
    return [box.x + box.width * fx, box.y + box.height * fy];
  };

  await step('01-baseline');
  await step('02-hover-mid', async () => {
    const [x, y] = await target(0.45, 0.45);
    await page.mouse.move(x, y, { steps: 4 });
  });
  await step('03-hover-bottom', async () => {
    const [x, y] = await target(0.2, 0.82);
    await page.mouse.move(x, y, { steps: 4 });
  });
  await step('04-hover-edge', async () => {
    const [x, y] = await target(0.97, 0.3);
    await page.mouse.move(x, y, { steps: 4 });
  });
  await step('05-wheel-zoom', async () => {
    const [x, y] = await target(0.5, 0.5);
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(150);
    await page.mouse.wheel(0, 200);
  });
  await step('06-drag-pan', async () => {
    const [x, y] = await target(0.5, 0.5);
    await page.mouse.move(x, y);
    await page.mouse.down();
    const [x2, y2] = await target(0.3, 0.5);
    await page.mouse.move(x2, y2, { steps: 8 });
    await page.mouse.up();
  });
  await step('07-brush', async () => {
    const [x, y] = await target(0.25, 0.35);
    const [x2, y2] = await target(0.6, 0.7);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 10 });
    await page.mouse.up();
  });
  await step('08-keyboard', async () => {
    const [x, y] = await target(0.4, 0.5);
    await page.mouse.click(x, y);
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(60);
    }
  });
  await step('09-legend-toggle', async () => {
    await page.evaluate(() => {
      const charts = [];
      if (window.__chart) charts.push(window.__chart);
      const many = window.__charts;
      if (many) for (const k of Object.keys(many)) charts.push(many[k]);
      const link = window.__link;
      if (link && link.charts) charts.push(...link.charts);
      const chart = charts.find((c) => c && c.layout && c.layout.legend && c.layout.legend.items.length);
      if (chart) {
        const item = chart.layout.legend.items[0];
        chart.controller.handleClick(item.x + item.width / 2, item.y + item.height / 2);
      }
    });
  });
  await step('10-after-toggle-hover', async () => {
    const [x, y] = await target(0.5, 0.5);
    await page.mouse.move(x, y, { steps: 3 });
  });

  report.push({ page: name, consoleErrors: errors });
  await page.close();
}

await browser.close();

const problems = report.filter((r) => (r.issues && r.issues.length) || (r.consoleErrors && r.consoleErrors.length));
console.log(JSON.stringify({ steps: report.length, problems }, null, 2));
console.log(`screenshots: ${outDir}`);
process.exit(problems.length ? 1 : 0);
