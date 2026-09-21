/**
 * examples 冒烟回归（永久）。
 *
 * 遍历 `examples/` 下所有页面，逐页校验：
 *  1) 无 pageerror、无 console error；
 *  2) 引擎与图表库的 UMD 确实执行了（`window.ICE` / `window.ICEChart` 都在）——
 *     这能第一时间区分"脚本 404"和"页面渲染出错"；
 *  3) 每张 canvas 的**内容像素占比**（与画面主色差异 > 阈值的像素比例）达标，而不只是
 *     "有任意不透明像素"——只刷一层背景色的画布同样能让旧判据通过，但用户看到的是一片空白。
 *
 * 设计上的例外只有 `examples/index.html`：它是纯导航页（只有一列链接，没有画布），
 * 因此不纳入冒烟范围 —— 而它"链接是否齐全"由 `npm run examples:prepare` 与人工复核保证。
 *
 * 前置：`npm run build && npm run examples:prepare`
 *   （示例页加载的是 `examples/vendor/ice-render.umd.js` + `vendor/ice-chart.umd.js`，
 *    `examples/vendor` 是 .gitignore 的构建产物 —— 少了它整页都会像"坏掉"，故先断言它在。）
 * 运行：`npm run test:e2e`（内部会自己 build + prepare）
 *
 * 这类页面的失败模式是"示例被改动破坏"（脚本路径写错、示例忘了同步 API 变更……），
 * 所以断言故意做得粗（不比对像素），只求**快速指认是哪一页坏了**。
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

/** 收集 examples 下的页面（跳过 assets/vendor 等非示例目录与导航页 index.html）。 */
function collectPages(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === 'assets' || name === 'vendor' || name === 'node_modules') continue;
      out.push(...collectPages(full, rel ? `${rel}/${name}` : name));
    } else if (name.endsWith('.html') && name !== 'index.html') {
      out.push(rel ? `${rel}/${name}` : name);
    }
  }
  return out;
}

const pages = collectPages(path.join(ROOT, 'examples'));

/**
 * **刻意不加载图表库**的页面（引擎级原型）。
 *
 * `large-data-virtual.html` 是「大数据量」那条路的对照实验：同样形状的数据，但文档放在
 * `Float64Array` 列存里、交给引擎的虚拟子源（窗口批量落墨 + 命中即物化），
 * 它**不经过 ice-chart**，所以 `window.ICEChart` 缺失是设计如此 —— 仍然要校验引擎 UMD 加载、
 * 画布有输出、零报错。
 */
const ENGINE_ONLY_PAGES = new Set(['large-data-virtual.html']);

test.beforeAll(() => {
  const vendor = path.join(ROOT, 'examples', 'vendor', 'ice-chart.umd.js');
  expect(fs.existsSync(vendor), '缺少 examples/vendor —— 先跑 `npm run examples:prepare`').toBe(true);
});

test.describe('examples 冒烟', () => {
  for (const rel of pages) {
    test(`${rel}：无页面错误且画布有输出`, async ({ page }) => {
      const errs: string[] = [];
      page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`.slice(0, 300)));
      page.on('console', (m) => {
        if (m.type() === 'error') errs.push(`console: ${m.text()}`.slice(0, 300));
      });

      await page.goto(`/examples/${rel}`, { waitUntil: 'load' });
      // 等首帧上屏（含字体测量与入场动画）
      await page.waitForTimeout(1200);

      const stats = await page.evaluate(() => {
        const hasEngine = typeof (window as any).ICE !== 'undefined';
        const hasLib = typeof (window as any).ICEChart !== 'undefined';
        const canvases = Array.from(document.querySelectorAll('canvas'));
        let worst = 1;
        for (const c of canvases) {
          const ctx = c.getContext('2d');
          if (!ctx || !c.width || !c.height) {
            worst = 0;
            continue;
          }
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          // 采样（约 1/16 像素）：先找主色（画布底色），再数"与主色明显不同"的像素
          const total = c.width * c.height;
          const stride = 4 * Math.max(1, Math.round(Math.sqrt(total / 4096)));
          const colors: string[] = [];
          const counts = new Map<string, number>();
          for (let i = 0; i < data.length; i += stride) {
            const key = `${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`;
            colors.push(key);
            counts.set(key, (counts.get(key) || 0) + 1);
          }
          let modal = '0,0,0,0';
          let modalCount = 0;
          for (const [k, v] of counts) {
            if (v > modalCount) {
              modalCount = v;
              modal = k;
            }
          }
          const [mr, mg, mb, ma] = modal.split(',').map(Number);
          let content = 0;
          for (const key of colors) {
            const [r, g, b, a] = key.split(',').map(Number);
            if (Math.abs(r - mr) + Math.abs(g - mg) + Math.abs(b - mb) + Math.abs(a - ma) > 24) content++;
          }
          worst = Math.min(worst, content / colors.length);
        }
        return { hasEngine, hasLib, canvases: canvases.length, worst };
      });

      expect(stats.hasEngine, `${rel}：引擎 UMD 没加载（window.ICE 缺失）`).toBe(true);
      if (!ENGINE_ONLY_PAGES.has(rel)) {
        expect(stats.hasLib, `${rel}：图表库 UMD 没加载（window.ICEChart 缺失）`).toBe(true);
      }
      expect(stats.canvases, `${rel}：页面上没有 canvas`).toBeGreaterThan(0);
      expect(
        stats.worst,
        `${rel}：画布几乎是空的（内容像素占比 ${(stats.worst * 100).toFixed(2)}%）`
      ).toBeGreaterThan(0.005);
      expect(errs, `${rel}：页面报错`).toEqual([]);
    });
  }
});
