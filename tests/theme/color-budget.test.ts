/**
 * **取色预算棘轮**（2026-09-17 立）：本仓的写死色值**只许减，不许增**。
 *
 * 为什么库也要有这道门禁：家族的应用仓（smart-water / ice-game / agent-console）都有取色棘轮，
 * 而**库**这一层没有 —— 于是"顺手写个 `'#0d6efd'`"不会有人拦。本仓的写死色值里，
 * 一部分是**领域色板**（图表系列 / 图形配色），那是内容不是界面外观，合理且有明确归属；
 * 另一部分是**从主题派生的界面外壳**（选中框 / 手柄 / 引导线），那些必须走 `theme`。
 *
 * 口径与家族其它仓一致：**按文件记预算，只减不增**；预算虚高（文件里已没有写死色值）也要报错，
 * 逼着改的人把数字降下来，避免棘轮慢慢失效。注释里的色值不计（文档常引用色值讲历史）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(__dirname, '..', '..', 'src');

/** 每个文件的写死色值预算（**当前实测值**，只能下调）。 */
const BUDGET: Record<string, number> = {
  'theme/chartTheme.ts': 26,
  'theme/chartEngineBridge.ts': 6,
  'components/series/PieSeries.ts': 2,
  'components/series/SankeySeries.ts': 2,
  'components/series/TreemapSeries.ts': 2,
  'components/DataZoomSlider.ts': 1,
  'components/PolarGrid.ts': 1,
  'components/series/FunnelSeries.ts': 1,
  'components/series/GaugeSeries.ts': 1,
  'components/series/HeatmapSeries.ts': 1,
  'components/series/LineSeries.ts': 1,
  'components/series/RadarSeries.ts': 1,
  'components/series/ScatterSeries.ts': 1,
  'components/series/WaterfallSeries.ts': 1,
  'interaction/InteractionController.ts': 1,
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
};

/** 去掉注释后再数 `'#rrggbb'` 字面量（注释里引用色值讲历史不算）。 */
function usages(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const source = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const n = (source.match(/'#[0-9a-fA-F]{3,8}'/g) || []).length;
    if (n) found[path.relative(SRC, file).split(path.sep).join('/')] = n;
  }
  return found;
}

describe('取色预算棘轮（写死色值只许减）', () => {
  it('没有文件超出预算', () => {
    const current = usages();
    const over = Object.entries(current)
      .filter(([file, n]) => n > (BUDGET[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} > 预算 ${BUDGET[file] ?? 0}`);
    expect(over).toEqual([]);
  });

  it('预算没有虚高（降下来的要在表里登记）', () => {
    const current = usages();
    const stale = Object.entries(BUDGET)
      .filter(([file, budget]) => (current[file] ?? 0) !== budget)
      .map(([file, budget]) => `${file}: 预算 ${budget}，实测 ${current[file] ?? 0}`);
    expect(stale).toEqual([]);
  });
});
