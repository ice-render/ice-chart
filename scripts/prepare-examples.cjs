/**
 * 准备示例运行环境：把 ice-render 的 UMD 产物复制到 examples/vendor。
 *
 * 示例页面刻意不依赖打包器、也不做裸模块导入 —— 直接用两个 <script> 标签
 * （引擎 UMD + ice-chart UMD）打开就能跑，方便手工验证交互。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const vendorDir = path.join(root, 'examples', 'vendor');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

const iceRenderPkg = require.resolve('ice-render/package.json');
const iceRenderDir = path.dirname(iceRenderPkg);
const iceRenderUmd = path.join(iceRenderDir, 'dist', 'index.umd.js');
if (!fs.existsSync(iceRenderUmd)) {
  console.error('[prepare-examples] 找不到 ice-render 的 UMD 产物：' + iceRenderUmd);
  console.error('                  请先在 ice-render 仓库执行 npm run build。');
  process.exit(1);
}
copy(iceRenderUmd, path.join(vendorDir, 'ice-render.umd.js'));

const chartUmd = path.join(root, 'dist', 'index.umd.js');
if (fs.existsSync(chartUmd)) {
  copy(chartUmd, path.join(vendorDir, 'ice-chart.umd.js'));
} else {
  console.warn('[prepare-examples] 尚未构建 ice-chart（dist/index.umd.js 不存在），示例将加载失败：npm run build');
}

// 同族的 DSL 包（`examples/dsl-vs-option.html` 用）：可选依赖，没装也只是少一个示例页
try {
  const dslDir = path.dirname(require.resolve('@damoqiongqiu/ice-chart-dsl/package.json'));
  const dslUmd = path.join(dslDir, 'dist', 'index.umd.js');
  if (fs.existsSync(dslUmd)) {
    copy(dslUmd, path.join(vendorDir, 'ice-chart-dsl.umd.js'));
  } else {
    console.warn('[prepare-examples] ice-chart-dsl 还没构建（dist/index.umd.js 不存在），dsl-vs-option 示例会加载失败');
  }
} catch (err) {
  console.warn('[prepare-examples] 未安装 @damoqiongqiu/ice-chart-dsl，跳过 DSL 示例的 vendor');
}

console.log('[prepare-examples] vendor 目录已就绪：' + path.relative(root, vendorDir));
