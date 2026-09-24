# 图表类型与场景坐标

> 有哪些类型、各属于哪个场景、每类的关键约束，以及「新增一种类型」的固定动作。

## 目录

1. [类型与场景总览](#1-类型与场景总览)
2. [直角坐标系列](#2-直角坐标系列)
3. [圆形与方形类](#3-圆形与方形类)
4. [层次与关系](#4-层次与关系)
5. [表达式绘图](#5-表达式绘图)
6. [标注](#6-标注)
7. [多 y 轴与 dataZoom](#7-多-y-轴与-datazoom)
8. [新增一种图表类型的固定动作](#8-新增一种图表类型的固定动作)

## 1. 类型与场景总览

`norm.kind` 是**场景判据**，布局、轴、网格都按它分支：

| 场景 `kind` | 类型 | 特点 |
|---|---|---|
| `cartesian` | `line` / `area` / `bar` / `scatter` / `bubble` / `heatmap` / `boxplot` / `waterfall` / `function` / `parametric` | 有 x / y 两个坐标轴；支持堆叠、抽样、`virtual` |
| `polar` | `pie` / `rose` | 无坐标轴；扇区按角度排布 |
| `radar` | `radar` | 有自己的网格（`RadarGrid`），按指标排布 |
| `sankey` | `sankey` | 节点 + 连线，两趟布局（`layout/sankey.ts`） |
| `graph` | `graph` | 力导向关系图（**无底图**），节点可拖拽 |
| —— | `treemap` / `funnel` / `gauge` / `liquid` | 各自的布局与绘制，不参与直角坐标系 |

**非直角坐标场景不画坐标轴**，`computeLayout` 也不为它们预留轴空间（否则饼图的圆会小一圈）。

## 2. 直角坐标系列

共通的四件事：

1. **`clipToBox = true`**：缩放后窗口外的点会被外推到画布之外，必须裁到绘图区。
2. **数据域顺序**：自动域 → `niceDomain` 取整 → **之后**才做留白（`padDomain`）。
   先留白会把最大值 40 抬到 42、再取整变成 50，白多一整格，还会多触发一次域过渡。
   留白只加在「数据自己说了算」的那一侧：显式 `min` / `max` 不动、柱形 / 面积的 0 基线不动、log 轴不做。
3. **堆叠**（`option.stack`）与**瀑布**（`base` / `top` 累计）在归一化里算好，组件只读。
4. **抽样**：折线 / 面积默认 LTTB（`sampling: 'none'` 可关）；散点按像素列抽稀；
   柱子在「类目轴 + 每像素 > 2 根」时走稠密聚合。

| 类型 | 关键点 |
|---|---|
| `line` | 断点用 `null`（抬笔）而不是 0；`smooth` 走平滑路径；虚拟形态按像素列保留首 / 极值 / 末 |
| `area` | 基线恒为 0；`fillArea` 是独立开关 |
| `bar` | 类目轴走 band（`BandScale`），数值轴走等距槽（`computeBarSlots`）；分组 / 堆叠由 `stack` 与系列顺序决定 |
| `scatter` / `bubble` | `symbolSize` 支持逐点解析；密度抽稀按 stride 跳点，**命中仍读全量** |
| `heatmap` | 数据项是 `[x类目, y类目, 值]`；y 轴按行类目聚合；虚拟形态是矩阵 |
| `boxplot` | 五数概括 `[min, Q1, 中位, Q3, max]`；给原始观测值会自动算分位数（长度恰好为 5 才当成五数概括） |
| `waterfall` | 每根柱子从 `base` 长到 `top`，两端都要进 y 数据域 |

## 3. 圆形与方形类

1. **半径只按「形状」算**：`gauge` / `liquid` 的文字在图形内部（刻度贴弧、数值在圆心 / 球心），
   套用「引导线标签预留」会让半径只剩一半（实测 420×300 的画布里只画了 92px 直径）。
   只有**标签画在图形外**的类型（带标签的饼图）才该预留外圈。
2. **放进过宽的卡片必然留死区**：圆受较短边限制，`aspect: 'equal'` 的绘图区被压成正方形居中；
   排版要么让卡片接近方形，要么把两张并排。
3. **标签防重叠**：内部标签按相邻角度逐级外推半径，弧长放不下就不画（交给图例 + 提示框）；
   桑基节点名用白色描边保证压在连线上也可读。
4. **按图元尺寸缩放的装饰要有像素上限**：桑基连线宽 40~60px 时 `width * 0.28` 的虚线会变成一串白珠子；
   装饰线宽一律 `Math.min(上限, 比例 * 尺寸)`。

## 4. 层次与关系

1. **矩形树图**（`layout/treemap.ts`）：占比每轮都在变，窄块（40~70px）里 4 个汉字照样溢出到隔壁块
   —— 「放得下才画」必须用 `measureTextWidth` 量真实文本宽度，逐级缩到 9px，仍放不下才不画。
2. **桑基**（`layout/sankey.ts`）：节点拖拽重排与折叠**未实现**；连线按宽度着色。
3. **力导向关系图**（`layout/force.ts`）：**无底图**（地图明确不做）；节点可拖拽，
   模拟的参数由页面控制。

## 5. 表达式绘图

`function` / `parametric`（含极坐标简写 `polarExpression`）的要点：

1. **几何来自表达式，不是数据点**：`CurveSeriesBase.rebuildPixels` 现场求值；
   `series.points` 仍存在（提示框 / 高亮 / 键盘导航的锚点），锚点像素也由表达式算出，
   所以「画出来的曲线」与「点得到的点」不会分叉。
2. **采样按可视区间做**：缩放后重新采样（否则放大会看到折线被拉大）；自适应细分要有上限
   （极点附近会无限细分）；断点写成 `NaN`，渲染按 `NaN` 分段。
3. **缓存键必须带参数值**（`paramKey()`）：参数扫动是每帧重新求值，键不带参数会让曲线冻在第一帧；
   编译结果本身也带缓存（`compileExpression` / `compileSampler`），不在采样循环里新建对象。
4. **`aspect: 'equal'` 才画圆**：两件事必须一起做 —— normalize 把两个轴的跨度拉齐
   （`applyEqualAspect`）+ 布局把绘图区收缩成正方形；只做一件都不成立（实测 x / y 单位长度差 2.86 倍）。
5. **极坐标是参数曲线的简写**：不要为它新建场景或第二套采样 / 命中链路；
   网格（`PolarGrid`）画在直角坐标场景里，只在等比时显示。
6. **诊断分三层并抑制级联**（`expr/diagnostics.ts`）：语法 → 静态（未定义变量 / 参数没用上）
   → 运行（整段画不出来 / 输出恒定）。静态层已报错时不再跑运行层
   （否则「b 没定义」会连带报「整段画不出来」，用户看到的是症状而不是根因）。
   **诊断只挂数据，永远不让图表抛异常**（`chart.expressionErrors()` / `expressionDiagnostics()`）。

## 6. 标注

`option.annotation` 是**声明式图层**，不是新系列类型：目标线 / 阈值线 / 异常点 / 目标区间。
设计细节见 [`annotation-design.md`](./annotation-design.md)；两条纪律：

1. 解析（`resolveAnnotation`）在归一化里完成，标注与数据同源；
2. 坏标注**不让图表崩**，也不影响其它标注 —— 错误经 `chart.annotationErrors()` 暴露（表单据此标红）。

## 7. 多 y 轴与 dataZoom

1. **多 y 轴**：`yAxis` 给数组 + 系列 `yAxisIndex`；轴域各算各的，布局为左右轴分别留位。
2. **dataZoom 滑块**（`DataZoomSlider`）：`start` / `end` 只决定**初始窗口**；
   运行期的窗口变化走 `setDomain` / `setDomainFromFractions`。
   **y 方向的滑块未实现**（`setAxisDomain` 可用，缺 UI）。

## 8. 新增一种图表类型的固定动作

照这个清单走，别漏（每一步都有历史教训）：

1. `types.ts`：加 `SeriesType`，写该类型需要的 `XxxOption`（配色、尺寸、角度等）。
2. `internal.ts`：如果它引入新的**场景**（不是直角坐标），加进 `kind`，并在 `NormalizedOption` 上挂配置字段。
3. `option/normalize.ts`：数据点归一化（`buildPoints` 加分支）、场景判定、数据域。
   纯几何能算的（五数概括、累计 base / top）也放这里，保证可单测。
4. 组件 `src/components/series/XxxSeries.ts`：
   - `seriesType`；
   - 覆盖 `paintPad()`（脏矩形留白）；
   - `rebuildPixels()` 填 `this.pixels`（**绘制与命中共用同一份几何**），缓存键走 `this.buildSeriesKey([...])`；
   - `hitTestIndex(lx, ly)`（本地坐标 → 数据下标）；
   - `doRender()`（本地坐标绘制；直角坐标记得 `clipToBox = true`）；
   - 需要矩形高亮就实现 `highlightRectAt(index)`；
   - 悬停反馈：几何能安全变形的用 `hoverBoost()`（**命中判定要同步放大**），
     图元紧挨着的用 `drawHoverOverlay()`（只叠加不改几何）。
5. `createSeriesComponent` 加 case；`components/series/index.ts` 与 `src/index.ts` 导出。
6. `ICEChart.syncSeries` 里给该类型分派 coord；非直角场景要在 `syncComponents` 里隐藏坐标轴 / 网格。
7. `InteractionController.buildTooltipContent` 加该类型的提示框分支（别让它退化成默认格式）。
8. 测试三类：纯函数（归一化 / 几何）、组件命中、引擎集成（真实 `hitTest` + 事件）。
9. 加一个示例页，并把页面名加进 `scripts/audit-interactions.mjs` 的 `pages` 列表。
