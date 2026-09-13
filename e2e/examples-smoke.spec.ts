/**
 * examples 冒烟回归（永久）。
 *
 * 遍历 `examples/` 下所有页面，逐页校验：
 *  1) 无 pageerror、无 console error；
 *  2) 页面上至少有一张 canvas，且画布上确实有像素输出（不是空白页）。
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

      const painted = await page.evaluate(() => {
        const canvases = Array.from(document.querySelectorAll('canvas'));
        if (!canvases.length) return false;
        return canvases.some((c) => {
          const ctx = c.getContext('2d');
          if (!ctx || !c.width || !c.height) return false;
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          // 不需要逐像素比对：采样到任意一个不透明像素即视为"画上了"
          for (let i = 3; i < data.length; i += 4 * 97) {
            if (data[i] > 0) return true;
          }
          return false;
        });
      });

      expect(painted, `${rel}：画布没有像素输出（空白页 / 脚本没跑起来）`).toBe(true);
      expect(errs, `${rel}：页面报错`).toEqual([]);
    });
  }
});
