import babel from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import nodeResolve from '@rollup/plugin-node-resolve';
import strip from '@rollup/plugin-strip';
import terser from '@rollup/plugin-terser';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import license from 'rollup-plugin-license';
import { visualizer } from 'rollup-plugin-visualizer';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pkg = require('./package.json');
const env = process.env.NODE_ENV;
const extensions = ['.js', '.jsx', '.ts', '.tsx'];

/**
 * ice-render 是 peer 依赖：产物里保持 `import ... from 'ice-render'`，由宿主提供。
 * 这样同一个页面上多个图表实例共享同一个引擎实例池，跨图联动才有共同的事件总线语义。
 */
const external = ['ice-render'];
const globals = { 'ice-render': 'ICE' };

const CommonPlugins = [
  json(),
  nodeResolve({ extensions }),
  commonjs(),
  babel({
    extensions,
    babelHelpers: 'bundled',
    include: ['src/**/*'],
  }),
  env === 'production' &&
    strip({
      include: ['src/**/*.(mjs|js|jsx|ts|tsx)'],
      debugger: false,
      labels: ['console'],
    }),
  env === 'production' &&
    terser({
      keep_classnames: true,
      keep_fnames: true,
    }),
  license({
    sourcemap: true,
    banner: {
      commentStyle: 'regular',
      content: {
        file: path.join(__dirname, 'LICENSE'),
        encoding: 'utf-8',
      },
    },
  }),
  // 体积分析图是开发产物，别放进 dist —— dist 是要发到 npm 的（files 只收 dist，多一个文件就多一份噪音）
  env === 'production' && visualizer({ filename: '.stats/bundle.html' }),
].filter(Boolean);

/** @type {import('rollup').RollupOptions[]} */
const configs = [
  {
    input: 'src/index.ts',
    external,
    output: { file: pkg.module, format: 'esm', globals },
    plugins: CommonPlugins,
  },
  {
    input: 'src/index.ts',
    external,
    output: { file: pkg.main, format: 'cjs', globals },
    plugins: CommonPlugins,
  },
  {
    input: 'src/index.ts',
    external,
    output: { name: 'ICEChart', file: pkg.browser, format: 'umd', globals },
    plugins: CommonPlugins,
  },
];

export default configs;
