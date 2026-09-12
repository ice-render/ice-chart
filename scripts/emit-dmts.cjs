/**
 * 由 dist/types/**.d.ts 生成 ESM 版声明 *.d.mts（内容相同，只把相对导入说明符补上 .mjs）。
 *
 * 为什么需要：本包同时发布 CJS 与 ESM 产物，单一套 .d.ts 在 type:commonjs 的包内会被
 * 判定为 CJS 声明，Node ESM + TS 消费者会按 CJS 互操作解读（publint / attw 都会报警）。
 *
 * 用法：node scripts/emit-dmts.cjs（由 npm run build:types 调用，需先跑 tsc --emitDeclarationOnly）
 */
const fs = require('fs');
const path = require('path');

const TYPES_DIR = path.resolve(__dirname, '..', 'dist', 'types');

function rewriteSpecifier(spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return spec;
  if (/\.(mjs|cjs|js|json)$/.test(spec)) return spec;
  return spec + '.mjs';
}

function rewrite(content) {
  return content
    .replace(/(\bfrom\s*['"])([^'"]+)(['"])/g, (m, a, spec, b) => a + rewriteSpecifier(spec) + b)
    .replace(/(\bimport\(\s*['"])([^'"]+)(['"]\s*\))/g, (m, a, spec, b) => a + rewriteSpecifier(spec) + b);
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

if (!fs.existsSync(TYPES_DIR)) {
  console.error('[emit-dmts] 找不到 ' + TYPES_DIR + '，请先运行 tsc --emitDeclarationOnly');
  process.exit(1);
}

let count = 0;
for (const file of walk(TYPES_DIR)) {
  const target = file.replace(/\.d\.ts$/, '.d.mts');
  fs.writeFileSync(target, rewrite(fs.readFileSync(file, 'utf8')));
  count++;
}
console.log('[emit-dmts] 生成 ' + count + ' 个 .d.mts（ESM 声明）');
