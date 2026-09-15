import { defineConfig } from '@playwright/test';

/**
 * 示例页端到端配置（examples 冒烟回归）。
 *
 * 前置：`npm run examples:prepare`（把引擎 UMD 与本仓 UMD 复制到 `examples/vendor`，
 * 该目录在 .gitignore 里，属构建产物）—— 所以 `npm run test:e2e` 会先把 build + prepare 跑掉。
 *
 * 与内核仓（ice-render，8090）、ice-entity-designer（8091）端口错开，三仓可同时跑。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  reporter: [['list']],
  webServer: {
    command: 'node scripts/serve-examples.cjs',
    port: 5177,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: {
    baseURL: 'http://localhost:5177',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  },
});
