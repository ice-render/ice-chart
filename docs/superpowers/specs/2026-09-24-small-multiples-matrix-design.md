# 小倍数：面板矩阵（`matrix`）

- 日期：2026-09-24
- 状态：设计已批准，未开工（实现计划见 `docs/superpowers/plans/`，写完补链接）
- 分支：`feat/small-multiples`（待建）
- 上游：[`plans/chart-type-candidates.md`](../../../plans/chart-type-candidates.md) §4.1

## 1. 背景与目标

**目标**：一张画布上放 N 个同构面板，共享数据域；悬停 / 框选 / 缩放 / 平移 / 键盘在「指针所在
那个面板」里解析；轴只画外圈（每行最左列画 y 轴、每列最底行画 x 轴），网格每个面板都画。

**为什么在 core 做**：主流实现里一个实例一个坐标系，做 N 个面板要 N 个实例，再手工同步悬停、
缩放、框选；提示框若是 HTML 浮层，跨面板定位会飘。本库的提示框本来画在画布内，命中又已经是
「按组件盒」的，把面板矩阵做进 core 之后这些能力**天然**对每个面板成立。

**非目标（v1 明确不做）**

| 不做 | 为什么 |
|---|---|
| 面板各自的 y 数据域（`shareY: false`） | 共享域是小倍数的定义性特征；独立域要连带改轴刻度布局、联动语义与图例选中 |
| 面板级独立缩放 / 独立窗口 | 同上；共享窗口是本库既有语义（`ChartLink` 也按数据值对齐） |
| 面板拖拽重排、面板级折叠 | 属交互壳层，等有真实需求再说 |
| **数据驱动分面**（`facet: { by: '渠道' }`，一张表拆 N 个面板） | 属「意图级翻译」，归 `ice-chart-dsl`（它本来就是「一张表 + encoding → option」那一层）。放进 core 会让一个系列变成 N 份，图例 / 选中 / 快照 / 提示框的语义全要跟着改 |

## 2. 现状证据（为什么这是架构级改动）

| 事实 | 位置 |
|---|---|
| 全图只有**一个**绘图区矩形：`computeLayout` 返回 `ChartLayout.plot` | `src/layout/layout.ts`；`ChartLayout` 定义在 `src/internal.ts` |
| `layout.plot` 被 18 处引用、跨 5 个文件 | `ICEChart.ts` / `InteractionController.ts` / `Tooltip.ts` / `Axis.ts` / `a11y.ts` |
| 比例尺按**绘图区尺寸**建，range 写死成 `[0, plot.width]` / `[plot.height, 0]` | `src/ICEChart.ts` 的 `createScale(...)` 两处 |
| 命中已经是「问引擎 + 问组件」，**不依赖单一绘图区** —— 面板化白拿 | `src/interaction/HitResolver.ts` 的 `resolveTarget` |
| 但「指针在不在绘图区里」是单一矩形判断，悬停 / 框选 / 缩放 / 键盘共 8 处调用 | `HitResolver.isInsidePlot`，调用点集中在 `InteractionController` |
| `GridLines` 自带 `plot` 字段（可被外部指定），`Axis` 却直接读 `this.layout.plot` | `src/components/GridLines.ts` vs `src/components/Axis.ts` |
| 数据坐标图元（`addMark`）按单一绘图区换算 | `ICEChart.markBox` / `markDataAt` |
| `norm.xAxis.scale` / `norm.yAxis.scale` 被内部与**测试**广泛引用 | `ICEChart` 多处 + `tests/chart/*` |

## 3. 选型

| 方案 | 做法 | 结论 |
|---|---|---|
| **A（采用）** | 布局产出 `panels: Rect[]`；每个面板建自己的比例尺实例（域共享、range 不同）；系列 / 网格 / 轴按面板实例化 | 贴合现有组件模型（组件盒 = 某块绘图区），命中白拿，改动集中在布局 + 实例化 |
| B | 新做一个「面板容器」组件，内部统管 N 个矩形的轴与网格 | 要复制一套轴 / 网格绘制逻辑，或先重构 `Axis` / `GridLines`；为省几个实例付这个代价不划算 |
| C | 用引擎的 group 做面板容器，靠 transform 定位 | 引擎的 `hitTest` / `screenToWorld` / 脏矩形都是绝对坐标，组件的本地坐标语义会被 group transform 搅浑，收益不明显 |

## 4. 数据模型

```ts
/** 面板矩阵。不给就是现在的单绘图区行为（`panels = [plot]`）。 */
export interface MatrixOption {
  /** 行数（等分）或每行的高度权重（数组，按顺序）。 */
  rows: number | number[];
  /** 列数（等分）或每列的宽度权重（数组，按顺序）。`[4, 1]` 即「主图 + 右侧窄条」。 */
  columns: number | number[];
  /** 面板之间的间距（设备像素），默认 8。 */
  gap?: number;
}

export interface SeriesOption {
  /** 所属面板下标（行优先）。不给时为 0。 */
  panel?: number;
}
```

- 顶层 `option.matrix`；**不叫 `grid`** —— 那个名字已被分隔线样式占用（`option.grid`）。
- 归一化后：`NormalizedOption.matrix: { rows: number[]; columns: number[]; gap: number } | null`
  （权重已归一、默认值已合并）；`InternalSeries.panel: number`（已夹到合法范围）。
- `ChartLayout` 新增 `panels: Rect[]`；**`plot` 保留**，语义 = 面板的并集
  （没有 `matrix` 时 `panels = [plot]`，与现在逐像素一致 —— 这是回归基线）。

## 5. 布局算法

新增纯函数（`src/layout/panels.ts`，与 `layout.ts` 同规格：不依赖 DOM / 引擎，可单测）：

```ts
export function computePanelRects(
  area: Rect,          // 可分配区域（已扣掉标题 / 图例 / 轴占位 / dataZoom 滑块）
  rows: number[],
  columns: number[],
  gap: number
): Rect[];
```

1. 可用宽 `W = area.width - gap · (cols - 1)`，高同理；每列宽 `= W · w_i / Σw`。
2. 面板下标**行优先**：`panel = row · cols + col`。
3. 亚像素保护：任何边 < 1px 时按 1px 处理（面板太多时允许溢出被裁，而不是画出负尺寸）。
4. 轴占位沿用现有的一次测量（共享域 → 刻度宽度只有一份）：y 轴占位留在 `area` 左侧、
   x 轴占位留在下方；`computeLayout` 的顺序（先量轴 → 再排标题图例 → 再推绘图区）不变。

## 6. 比例尺与坐标系

- 每个面板建**自己的** `xScale` / `yScale` 实例：域相同（共享），range 按各自面板矩形
  （`[0, panel.width]` / `[panel.height, 0]`）。
- `norm.xAxis.scale` / `norm.yAxis.scale` **保留**，指向**面板 0** 的比例尺 ——
  内部既有调用点与测试（`tests/chart/*`）都按这个语义读，改语义会连带改一堆测试。
- 系列组件的 `coord` 用**它所在面板**的比例尺与矩形，其余字段不变。

## 7. 组件实例化与绘制顺序

| 组件 | 实例数 | 说明 |
|---|---|---|
| 系列 | 每个 `(series, 面板)` 一份 | 盒 = 该面板矩形；`coord.plot` = 该面板矩形 |
| `GridLines` | 每个面板一份 | 它自带 `plot` 字段，直接给面板矩形 |
| `Axis`（y） | 每行一份 | 画在**该行最左列**面板的左侧；同域 → 刻度与标签完全相同 |
| `Axis`（x） | 每列一份 | 画在**该列最底行**面板的下方 |

**唯一需要动的组件是 `Axis`**：它现在直接读 `this.layout.plot`，要像 `GridLines` 一样接受
一个 per-instance 的 `plot`（外加「画哪一侧」的位置参数，供每行 / 每列的外圈轴复用）。

zIndex 保持现有分层（网格 < 轴 < 系列 < 高亮 / 十字线 < 提示框）；同一面板内的系列仍按
系列下标排序，跨面板不改变相对顺序。

## 8. 交互

1. **悬停 / 命中**：`HitResolver.resolveTarget` 不变（引擎按组件盒命中）—— 指针落在哪个面板，
   命中的就是那个面板的组件。`isInsidePlot` 换成 `panelAt(chartX, chartY): Rect | null`，
   调用点（悬停清空、框选、缩放、键盘等 8 处）改为「必须在某个面板里」。
2. **轴触发提示框**（`tooltip.trigger: 'axis'`）：列只取**指针所在面板**的系列；
   `ActiveColumn` 带上 `panel` 下标。
3. **十字准星**：限制在指针所在面板内画（现在按整块 `plot` 画满高 / 满宽）。
4. **框选**：x 方向夹到**所有面板的并集**（小倍数的直觉是「刷一段 x，所有面板一起看」），
   y 方向夹到**指针所在面板**；抛出的 `brush:change` 语义不变（仍是数据值区间）。
5. **缩放 / 平移**：锚点用指针所在面板的 range 换算（比例尺换成了面板实例，锚点必须跟着换）；
   数据域仍是全图共享的一份。
6. **键盘导航**：在当前高亮系列所在的面板内移动；↑ / ↓ 切系列时若跨面板，则把「当前面板」
   一并切过去。
7. **图例 / 标题 / dataZoom 滑块**：全局一份，行为不变（滑块本来按全图 x 窗口工作）。

## 9. 数据坐标图元与标注

- `addMark()` 的图元加一个可选 `panel`（默认 0）：几何按该面板的矩形 + 比例尺换算；
  `markBox` / `markDataAt` 改为走面板。
- `option.annotation` 的解析（`resolveAnnotation`）按**轴**定位，与面板无关；但**画在哪个面板**
  需要一个归属 —— v1 规则：标注画在**面板 0**，本节写明这条限制（真需求出现再加 `panel`）。

## 10. 序列化与无障碍

- 快照天然覆盖（`matrix` 与 `series[].panel` 都是纯 JSON）→ 新增往返测试：幂等 + 像素一致。
- 无障碍：数据表镜像按**面板**分段（每个面板一张表，标题带面板名），`SERIES_ROLE_HINT` 不变。

## 11. 边界与容错

| 输入 | 行为 |
|---|---|
| `rows` / `columns` 为 0、负数、非有限 | 退化成 1（不抛异常） |
| 给的是权重数组 | 面板数 = `rows.length × columns.length`（数组长度**决定**面板数，不存在「长度对不上」）；某项权重 ≤ 0 或非有限 → 按 1 处理 |
| `series[].panel` 越界 / 负数 | 夹到 `[0, 面板数-1]`，不抛异常（坏配置画歪比整张图崩掉好） |
| 面板数 1 | 与不给 `matrix` 完全等价（回归基线） |
| 面板太小（边 < 1px） | 按 1px 处理 |

## 12. 测试矩阵

| 层 | 用例 |
|---|---|
| 纯函数（`tests/layout/panels.test.ts`） | 等分切分、权重切分、gap 扣减、行优先下标、极端权重、面板数 1、负 / 零输入退化 |
| 组件命中（`tests/components/`） | 各面板的系列组件盒正确；同一数据点在两个面板里落点不同、但数据下标一致 |
| 集成（`tests/chart/matrix.test.ts`） | 2×3 面板：`panelAt` 正确；悬停各面板拿到正确的 tooltip；框选后**所有面板** x 窗口一致；缩放锚点落在指针面板；键盘在面板内移动；`addMark` 落到指定面板 |
| 回归 | 现有 578 条全绿（无 `matrix` 时逐像素不变）；序列化往返（幂等 + 像素一致） |
| 视觉 / 交互审计 | 新页 `examples/matrix.html` 加进三个脚本的 `pages`；审计步骤含「每个面板各悬停一次 + 跨面板框选一次」 |

## 13. 文档回写

- `docs/06-chart-types.md`：新增「面板矩阵（`matrix`）」小节（场景归属、轴只画外圈的约定）。
- `README.md`：能力清单加一行「面板矩阵 / 小倍数」。
- `AGENTS.md`：新增纪律「面板不许各自造坐标 —— 面板只有 range 不同，域是全图共享的一份；
  新增组件必须接受 per-panel 的 `plot`」。

## 14. 风险与回滚

- **最大风险**是 `layout.plot` 的语义变化（18 处引用）。对策：`matrix` 缺席时 `panels = [plot]`、
  所有新逻辑短路，用现有 578 条测试当回归基线；面板相关计算全部收在 `layout/panels.ts` 与
  `panelAt()` 两处，出问题可以单独回滚。
- 第二风险是**轴实例化**（`Axis` 要接受 per-instance `plot`）：先只改「读 plot」这一处，
  保持默认路径（不传 plot 时读 `this.layout.plot`）不变，避免影响现有页面。

## 15. 紧随其后（不在本版实现）

**边际分布（joint plot）**：几何由 `columns: [4, 1]` 已经给到，还差两件事 ——
面板级轴可见性（边缘面板不画轴）与边缘面板绑第二个 y 轴（计数域，用现有的多 y 轴即可）。
这两件事都在本版的机制之上加开关，不需要新的布局模型。
