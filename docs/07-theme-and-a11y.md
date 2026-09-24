# 主题与无障碍

> 主题怎么推给引擎、取色有哪些硬纪律；以及把画布「翻译」成可读内容的镜像层。

## 目录

1. [主题模型](#1-主题模型)
2. [默认主题与 token](#2-默认主题与-token)
3. [取色纪律](#3-取色纪律)
4. [大屏配色](#4-大屏配色)
5. [无障碍：数据表镜像](#5-无障碍数据表镜像)
6. [无障碍：节点树与播报](#6-无障碍节点树与播报)

## 1. 主题模型

1. **图表主题走引擎的「补丁层」**：`ice.setThemePatch('ice-chart', patch)`
   （由 `chartThemeToEnginePatch` / `applyChartThemeToEngine` 转换后调用）。
   - **不要**再调 `ice.setTheme()`：那写的是「基座」（UI 主题的地盘），两边都写基座就是「后写的赢」——
     应用切 UI 主题会把图表主题抹掉，图表推主题会把 UI 主题抹掉。补丁层让两层互不覆盖、调用顺序无关。
   - 主题没变**不推**：推一次会让引擎整棵树标脏。图表实例里缓存了上次推过的主题指纹。
2. **`theme: 'auto'` 是「跟随引擎」**：不推补丁，明暗由引擎主题的背景色亮度判定
   （`normalizeOption` 的 `preferDark` 由 `ICEChart` 按 `ice.getTheme()` 算出来传入 —— 归一化层自己不碰引擎实例）。
3. 主题解析在归一化里完成：`resolveChartTheme(option.theme, { preferDark })`，
   产物是 `NormalizedOption.theme`，组件取色一律从它拿。

## 2. 默认主题与 token

- 默认主题是 **Bootstrap 5 风格的明暗两套**：`BOOTSTRAP_CHART_THEME` / `BOOTSTRAP_DARK_CHART_THEME`，
  原始 token 在 `BOOTSTRAP_TOKENS`（`src/theme/chartTheme.ts`）。
- 另有 `LIGHT_CHART_THEME` / `DARK_CHART_THEME`（内置基线）与 `resolveChartTheme`（解析入口）。
- token 覆盖面：背景 / 文本 / 次级文本 / 轴线与轴文字 / 分隔线 / 网格 / 色板 / 提示框 /
  准星 / 框选 / 高亮 / 图例（含未选中色）/ `labelHaloColor`。

## 3. 取色纪律

1. **新增组件一律从主题取色**，不许写死色值。
2. **压在图形上的文字描边走 `theme.labelHaloColor`**（浅色 = 白、深色 = 深色）——
   写死白色会在深色大屏里糊成一团（桑基节点名实测完全不可读）。
   注意区分「文字描边」与「图形描边」：节点边框、扇形分隔线是图形的一部分，保持白色。
3. **坐标轴文字与轴名称都必须是近灰**（`axisLabelColor` **和** `subTextColor`）：
   审计脚本用「通道极差 > 45 视为饱和墨迹」判断「图形画到坐标轴上」，
   把轴文字调成偏蓝的 `#7d93b5`（极差 56）会被误判成 9 处越界。
4. **准星标签用深底 + 亮字**，不要用亮色底。
5. 色板预算由 `tests/theme/color-budget.test.ts` 守着（配色不是随手加一个 `#ff00ff` 就能过的）。

## 4. 大屏配色

大屏（`examples/dashboard*.html`）的视觉基调在这里固化，新增大屏照做：

1. **近黑蓝底 + 单一强调色 + 卡片化面板**（半透明深蓝渐变 + 1px 描边 + 四角 L 形亮角）
   + 一条整宽的 KPI 分隔条 + 水位球这类标志性图形。
2. **底色跟着主色走**（青 / 青绿 / 琥珀 / 蓝紫 / 橙红 / 紫），面板与描边都从主色派生；
   底色与主色不一致（青底配橙主色）会立刻显得廉价。
3. 公共部分一律走 `DashKit`（注入 CSS / 按栅格出面板 / 主循环 / 包主题），
   页面里只留三样：配色变量、面板清单、`tick` 里的数据怎么动。
4. **固定 12 列栅格，不做响应式缩放**：canvas 被 CSS 缩放后引擎按
   `clientX - rect.left` 算坐标，命中检测会整体偏移。设计宽 1572 = 12 × 120 + 11 × 12；
   画布宽 = 面板宽 − 16 − 2。

## 5. 无障碍：数据表镜像

画布对读屏软件是黑盒，所以提供**镜像层**（`src/a11y.ts`）：

```ts
chart.getDataTable({ maxTableRows: 200 });   // 结构化表格：caption / columns / rows
chart.attachA11yMirror();                    // 把一张视觉上隐藏的表挂到画布旁边
chart.detachA11yMirror();
chart.a11yMirrorAttached;                    // 当前是否挂着
```

1. **默认封顶 200 行**（`A11yTreeOptions.maxTableRows`）：超限时按等步长抽样，
   并在 caption 里写明 —— **少给内容必须说出来**，不能静默截断。
2. 表格与图表同源（都从 `norm` 生成），图表更新后镜像跟着刷新（`rebuild()` 末尾）。
3. `VISUALLY_HIDDEN_STYLE` 是「看得见给读屏、看不见给人」的样式约定；
   键盘 Tab 到镜像里的链接时它必须**真的可见**（有 e2e 用例盯着）。

## 6. 无障碍：节点树与播报

1. `chart.getA11yTree()` 给出节点树（含 `SERIES_ROLE_HINT` 的类型角色提示，
   例如折线读成「趋势」、柱形读成「对比」）。
2. `chart.announceA11y(text)` 用于主动播报（数据更新、联动到位这类事件）。
3. 图表标题由 `chartTitle(norm)` 生成并挂到根容器的 `ariaLabel` 上。
4. 无障碍是**产品能力**，与动效偏好（`setMotionPreference`）同级 ——
   新增图表类型时同步补 `SERIES_ROLE_HINT`，否则读屏里会出现「未知图表类型」。
