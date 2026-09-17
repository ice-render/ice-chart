import type { ChartTheme } from '../types';

/**
 * 图表主题 → 引擎主题（engine 2.4 起）。
 *
 * 为什么需要这条桥：本库有自己的 Bootstrap 主题（`chartTheme.ts`），它管的是**图表画出来的东西**
 * （系列、轴、图例、提示框…）；但一个图表实例里还可能有**引擎自己画的东西** ——
 * 引擎的默认样式、交互外壳（选中框 / 手柄 / 插槽 / 引导线 / 连线标签）、以及应用往
 * `chart.ice` 里塞的自定义图元。两套主题不打通，就会出现「图表是暗的、引擎那层还是亮的」
 * 这种一眼可见的不一致。
 *
 * 这里**只用图表主题里已有的 token** 做映射，不新造颜色；映射原则是「同名语义」：
 *
 * | 引擎主题 | 图表主题 |
 * | --- | --- |
 * | `palette` | `colorPalette` |
 * | `chrome.selection.stroke` | `selection.stroke` |
 * | `chrome.linkLabel.background` / `.fill` | `tooltip.background` / `tooltip.textColor` |
 * | `chrome.textSelection.color` | `brush.fill` |
 * | `chrome.shadow.*` | `tooltip.shadowColor` |
 * | `base.fontFamily.base` / `base.fontSize.md` | `fontFamily` / `fontSize` |
 *
 * ⚠️ **刻意不写宿主的语义色**（`primary` / `success` / `warning` / `danger` / `info` /
 * `text` / `muted` / `hint` / `border` / `background`）：
 *
 * - 图表**自己画**轴 / 系列 / 图例 / 背景（`ICEChart` 里 `plotArea.setBackground(...)`），
 *   这些槽位对图表没有用；
 * - 它们属于**宿主**（UI 主题）。引擎 2.14 起领域库写的是**叠在基座之上的命名补丁**，
 *   补丁会一直压着基座 —— 早期版本在这里顺手写 `background` / `text`，表现就是
 *   "宿主切了深色主题，图表那块画布的 `semantic.background` 还是图表推的 `transparent`"
 *   （真机用例 `theme-bridge.test.ts` 的「也不反过来覆盖宿主刚设的主题」抓到过）。
 * - 图表**派生的外壳**（选中框 / 手柄 / 插槽 / 引导线 / 连线标签 / 选区 / 阴影）仍然写，
 *   因为那是图表画布上的交互外观，本来就该跟图表走。
 *
 * 图表里那些「压在饱和色块上的白字 / 白描边」（桑基节点边框、树图顶层标签、标记的外圈）
 * **不进这张表** —— 它们是对比色而不是主题色，换主题也不该变（见 docs 的说明）。
 */
export function chartThemeToEnginePatch(theme: ChartTheme): any {
  const palette: string[] = Array.isArray(theme.colorPalette) && theme.colorPalette.length ? theme.colorPalette : ['#0D6EFD'];
  const pick = (index: number, fallback: string) => palette[index] || palette[0] || fallback;
  return {
    // ⚠️ 刻意不写宿主的语义色（primary / success / warning / … / text / border / background）——
    // 图表补丁叠在基座之上、会一直压着它，见文件头的说明。图表要的颜色都在下面 chrome 里显式给了。
    palette,
    chrome: {
      selection: { stroke: theme.selection.stroke },
      handle: { fill: pick(0, '#0D6EFD') },
      linkHook: { fill: pick(1, '#198754') },
      slot: { fill: pick(1, '#198754'), hoverFill: pick(2, '#FFC107') },
      guide: { color: pick(0, '#0D6EFD') },
      linkLabel: { background: theme.tooltip.background, fill: theme.tooltip.textColor },
      textSelection: { color: theme.brush.fill },
      // 图表主题只有一个阴影色（提示框用），三档都用它 —— 深浅底上都是"这个主题的阴影"
      shadow: { sm: theme.tooltip.shadowColor, md: theme.tooltip.shadowColor, lg: theme.tooltip.shadowColor },
    },
    base: {
      fontFamily: { base: theme.fontFamily },
      fontSize: { md: theme.fontSize },
    },
  };
}

/**
 * 把图表主题应用到引擎实例（语义色 + 交互外壳一次对齐）。
 *
 * 幂等：重复调用只是再合并一次同样的补丁；引擎会标脏，下一帧按新色重绘。
 *
 * ⚠️ **走命名补丁，不走 `setTheme`**（引擎 2.14 起的主题写入契约）：
 * `setTheme` 写的是**基座**（UI 主题的地盘），图表主题若也写基座，两边就变成"后写的赢" ——
 * 应用切 UI 主题会把图表主题抹掉、图表推主题会把 UI 主题抹掉。
 * 用 `setThemePatch('ice-chart', …)` 之后两层互不覆盖、调用顺序无关。
 */
export function applyChartThemeToEngine(ice: any, theme: ChartTheme): any {
  if (!ice || typeof ice.setTheme !== 'function') {
    throw new Error('applyChartThemeToEngine(ice, theme) 需要一个 ICE 实例');
  }
  const patch = chartThemeToEnginePatch(theme);
  if (typeof ice.setThemePatch === 'function') {
    // 引擎 ≥ 2.14：命名补丁层（基座换掉时会自动重放）
    ice.setThemePatch('ice-chart', patch);
  } else {
    // 老引擎兜底：没有补丁层，只能直接叠在实例主题上（语义与 2.14 之前一致）
    ice.setTheme(patch);
  }
  return ice;
}
