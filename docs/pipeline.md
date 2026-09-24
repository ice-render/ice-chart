# 更新流水线

> 数据一变，从 option 到像素要走哪几步；哪些步骤已经是增量的、判据是什么、实测多少。

## 目录

1. [流水线的四步](#1-流水线的四步)
2. [第一步：归一化](#2-第一步归一化)
3. [视窗：只在「域」上落笔](#3-视窗只在域上落笔)
4. [增量维护的现状](#4-增量维护的现状)
5. [第二步：布局](#5-第二步布局)
6. [第三步：比例尺](#6-第三步比例尺)
7. [第四步：组件同步与脏矩形](#7-第四步组件同步与脏矩形)
8. [尺子与当前账](#8-尺子与当前账)

## 1. 流水线的四步

```
option ──①normalizeOption──▶ norm ──②computeLayout──▶ layout ──③buildScales──▶ coord ──④syncComponents──▶ 组件
```

1. **归一化**（`option/normalize.ts`，纯函数）：数据点 / 数据域 / 类目表 / 堆叠基线 / 主题解析。
2. **布局**（`layout/layout.ts`，纯函数）：量轴标签宽度 → 排标题与图例 → 推出绘图区矩形。
3. **比例尺**（`scale/*`）：值 → 比例 → 像素；类目轴在这里拿到「查表口」。
4. **组件同步**（`ICEChart.syncComponents`）：逐组件 `updateSeries` / `setCoord` / `markDirty`，
   然后 `syncMarks()` 摆数据坐标图元、`controller.refreshHover()` 重新定位悬停视觉。

**脏矩形只在第 4 步产生**：图表层不做整幅重绘；谁变了谁 `markDirty()`。
数据更新时 `ice.dirty = true` 只作为「布局/域可能变了」的兜底。

## 2. 第一步：归一化

### 2.1 输入与输出

- 输入：`option`（用户对象，**唯一事实来源**）+ `NormalizeContext`
  （`hiddenIds` / `hiddenSlices` / `preferDark` / 视窗 `xDomain`·`yDomain`·`yDomains`
  / 几个**图表实例级缓存**：`virtualColumns` / `categoryCache` / `pointCache`）。
- 输出：`NormalizedOption`（`series` / `xAxis` / `yAxes` / `categories` / `kind` / `theme` / 合并后的 `option`）。

### 2.2 纪律

1. **纯函数**：不碰 DOM / ctx / 引擎实例；同样的输入必须给同样的输出。
   因此「增量」只能是「**输入指纹 + 复用上一次结果**」，不许把可变状态塞进归一化。
2. **读点走访问器**：`pointCount` / `pointAt(i)` / `xValueAt(i)` / `yValueAt(i)`；
   虚拟系列没有 `points[]`，直读会静默少画。
3. **代价要显式**：算不出来就抛错（列存系列要数值型 x、虚拟热力图要求类目轴且密度够），
   不许静默降级成另一种语义。

### 2.3 类目域（category 轴）的三种来源

类目轴的域 = 「各来源的类目按首次出现顺序去重合并」，按来源分三条路：

| 来源形态 | 做法 | 判据 |
|---|---|---|
| **惰性原始点 / 环形** | 存储**自己维护**一张增量类目表（`categories` + `categoryCounts` + **绝对序号** `categorySeq`），域直接复用 | 存储指纹（长度 / `categoryNext` / 计数表大小 / 首末键） |
| **单来源普通系列** | 图表实例维护同一套口径的增量表（`OrdinaryCategoryIncremental`） | **逐项验过**才认（上一次的 x 序列 vs 这一次），对不上 / 出现重复类目就退回全量 |
| **多来源但 x 逐项相同** | 先算第一条的增量表，再验其余来源与它**逐项同一**，同一就不用合并 | `sourcesMatchDomain()` |

「下标 = 绝对序号 − 首项序号」这套口径是这张表成立的全部依据：淘汰只删一个 key，
不需要把整张表重写一遍。**序号必须保持连续** —— 尾部被裁掉时要把 `next` 压回去，
否则后面追加的类目下标会整体偏大，`BandScale` 一看越界就判「不在域里」，那些柱子 / 点**直接不画**。

多来源**各自不同表**时仍是每帧全量合并（工作量大一档，见 `plans/incremental-pipeline.md`）。

### 2.4 点集的复用

`buildPoints` 给每个普通系列物化 `DataPoint`。当**数据数组身份 + 长度 + 解析规则**
（`type|xField|yField`）都没变时整批复用（`PointCacheEntry`）—— 平移 / 缩放 / 重复归一化
不重建 10 万个对象。换数组（含滑动窗口）、换长度、换字段一律重建。

## 3. 视窗：只在「域」上落笔

视窗（`viewState` / `setDomain` / 联动）在归一化里**只落在三处**：

1. x 域裁剪（`resolveXDomain`：类目轴切成一段并带上 `categoryOffset`；连续轴取 `[w0, w1]`）；
2. y 轴显式域；
3. **表达式系列的采样区间**（`function` / `parametric` 的采样点按可视窗口现算）。

前两处可以**事后套用**（`applyViewToNormalized`），于是「一次更新只跑一遍全域名归化」——
这是 0.30.11 的一刀。判断能不能走快路径的是 `canApplyView()`：

| 情形 | 能不能事后套 | 为什么 |
|---|---|---|
| 普通直角坐标系列 | ✅ | 视窗只改域 |
| 类目 y 轴（横向图 / 热力图的行） | ✅（**跳过** y 视窗） | 这两根轴的域由数据类目推出来，不吃 y 视窗 |
| 表达式系列（`function` / `parametric`） | ❌ 整条重跑 | 采样区间由视窗决定 |
| 等比坐标（`aspect: 'equal'`） | ❌ 整条重跑 | 按两个轴**跨度**重新拉齐，跨度随视窗变 |

**新增任何依赖视窗的字段，必须同步改 `canApplyView()`**（拿不准就返回 `false`），
否则 `tests/option/apply-view.test.ts` 的等价性用例（对着「带视窗重跑一遍」逐项比）会红。

## 4. 增量维护的现状

| 机制 | 位置 | 判据 | 实测（10 万点普通系列） |
|---|---|---|---|
| 一次更新一遍归一化 | `applyViewToNormalized` | `canApplyView` | `setData` 6.2 → **3.6ms** |
| 类目域增量（单来源） | `tryIncrementalCategoryDomain` | 上一次的 x 序列逐项验过 | 真滑窗 7.8 → **4.2ms/tick** |
| 类目域复用（多来源 x 相同） | `sourcesMatchDomain` | 逐项同一 | 3 系列同帧批 16.5 → **11.4ms/tick** |
| 点集复用 | `PointCacheEntry` | 数组身份 + 长度 + 解析规则 | 只换视窗 3.4 → **1.0ms/tick** |
| 同帧批合并 | `chart.batch(fn)` | 批内只记账，出批跑一次 | 3 系列逐系列 `setData` 45.4 → **10.4ms/tick** |

### 4.1 `chart.batch()` 的三条语义

1. **同步**：`batch()` 返回时图表已经是新状态（不是「下一帧才生效」）。
2. **事件出批补发**：批内不发布 `data:change`，出批后按调用顺序补发 —— 监听者读到的图永远自洽。
3. **异常也 flush**：批内抛错不会让图表停在半路，异常照常外抛。

动画标志取**与**：批内只要有一次不要动画（滑动窗口的 `appendData` 默认就是），整批都不插值。
批内的 `setOption` / `setDomain` 照旧立即生效（批合并只作用于数据更新）。

## 5. 第二步：布局

`computeLayout(norm, ctx, canvas)` 的顺序是有原因的：

1. **先量轴标签**（用临时比例尺 + `measureText`）：轴占位先定下来，绘图区才能算准。
2. **再排标题与图例**：它们的位置会影响绘图区上下边界。
3. **最后推绘图区**：`plot` 的 x / y / width / height 是全库的公共坐标基础。

两条踩过的坑：

- **x 轴标签抽稀只能在绘图区算完之后做**，且要按**绘图区宽度**（不是画布宽度）算间距 ——
  早先按画布宽度算，可用宽度多出 7%~11%，两个标签刚好贴住；给间距加 `Math.max(1, …)` 之类的地板
  更糟：0.24px 的真实间距按 1px 算，步长从 380 根一跳变成 88 根一跳，末端糊成一条色带。
- **`show:false` 的 x 轴也要出抽稀表**（只是不占位、不绘制）：多 pane 里上面几块常藏掉 x 轴，
  网格却要和下面那块对齐成方格。

## 6. 第三步：比例尺

- `createScale(type, domain, range, options)` 每趟重建；类目轴会把**查表口**交给 `BandScale`
  （`categoryLookup` + `categoryOffset`），这样它不必自己再建一张同规模的表。
- **查表口按整张类目表编号**；域是其中一段时用 `categoryOffset` 换算窗口内下标（见 §2.3）。
- `fractionOf(value)` / `valueAtFraction(fraction)` 是跨图联动的公共口径：
  A 图把视窗换算成两个比例，B 图按比例取回自己的窗口 —— 轴类型不同也能对齐。

## 7. 第四步：组件同步与脏矩形

1. `updateSeries(series, animate, preserveAnimation)`：换数据引用、按需记动画起点、清缓存键、`markDirty()`。
2. `setCoord(coord)`：把绘图区矩形与两个比例尺交给系列组件。
3. **只在尺寸真的变了才写根容器**：`ICEGroup.setState` 会递归把全部后代置脏，无差别重绘会让脏矩形局部重绘失效。
4. `syncMarks()` / `refreshHover()`：数据坐标图元与悬停视觉跟着数据重新定位。

## 8. 尺子与当前账

**尺子**：`scripts/measure-pipeline.mjs`
（默认打本仓示例页；`--points` 选规模，`--url` 可指向宿主页）。它逐 tick 追加并计时，
给出「每 tick p50」与「其中 `applyOption`（流水线）」两列。

| 口径（真机 Chromium，本机） | 每 tick |
|---|---|
| 惰性原始点 + 环形（10 万点） | 0.5ms |
| 惰性原始点 + 环形 + 视窗（10 万点） | **0.3ms** |
| 普通系列真滑窗（10 万点） | **4.2ms** |
| 普通系列逐系列 `setData`（3 系列，包 `batch()`） | **10.4ms** |

**读数纪律**：

1. **帧 ≠ 流水线**。10 万点普通折线的**帧**是 61~70ms，其中 `setData` 只有 7.5ms —— 帧由
   **canvas 光栅**主导（把 `doRender` 置空立刻回到 60fps）。别拿流水线的数字去解释帧。
2. **同一份数据、同一张画布，虚拟（列存）折线是 16.7ms/帧**（普通折线 61ms）——
   大数据优先开 `virtual: true`。
3. **三种取点策略已实测**（见 `plans/incremental-pipeline.md`）：LTTB 61ms / 按列聚合 124ms /
   只画极值 149ms —— **LTTB 已经是最快的**，不要再在本层折腾取点策略。
4. 1M 级宿主（交易看盘）的账：帧 50ms 里脚本约 1.5s/3s、**canvas 光栅 1.45s/3s**，
   样式与布局都是 0 —— 那一档再往下是**引擎的重绘策略**，不在本仓射程内。
