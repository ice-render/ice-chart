# 架构与分层

> 面向改代码的人。用法见根 `README.md`；每一条「为什么」背后都对应根 `AGENTS.md` 的一条纪律。

## 目录

1. [定位与边界](#1-定位与边界)
2. [分层](#2-分层)
3. [模块地图](#3-模块地图)
4. [一次数据更新的完整链路](#4-一次数据更新的完整链路)
5. [关键数据结构](#5-关键数据结构)
6. [全仓铁律](#6-全仓铁律)
7. [坐标系与「盒」的约定](#7-坐标系与盒的约定)
8. [状态、缓存与生命周期](#8-状态缓存与生命周期)

## 1. 定位与边界

ice-chart 是建在 **ice-render**（Canvas 引擎，peer 依赖）之上的**交互式图表库**。
分工只有一句话：

> 引擎负责**渲染 / 命中测试 / 事件派发 / 坐标系 / 脏矩形局部重绘**；
> 图表层只负责 **数据 ↔ 像素 ↔ 语义事件** 三件事。

由此推出两条边界：

1. **不重写引擎已经保证的东西**。遮挡关系、`zIndex`、`display:false`、`interactive:false`、
   局部重绘、坐标变换全归引擎；图表层只在组件的 `containsLocalPoint()` 里回答
   「这个本地坐标命中了我的哪个数据点」。
2. **渲染与命中必须同源**。同一份几何既要画出来、又要被点得到，所以图表层把
   「点集合 → 像素」这一步固化成**唯一一份**缓存（见 `rendering.md` §2）。

不支持的能力也写在这里：**地图明确不做**（体量、定位都不合适），关系数据一律用力导向关系图表达。

## 2. 分层

自下而上五层，**下面四层不许依赖引擎**（纯函数 / 纯数据），只有组件层与门面层碰 `ctx` 与引擎实例：

| 层 | 目录 | 是否纯函数 | 职责 |
|---|---|---|---|
| ① 归一化 | `src/option/` | **是** | 用户 option → 内部结构：数据点、数据域、类目表、堆叠基线、主题解析 |
| ② 布局 | `src/layout/` | **是** | 量刻度 → 排标题 / 图例 → 推出绘图区矩形（另有 treemap / sankey / force 三种专用布局） |
| ③ 比例尺 | `src/scale/` | **是** | linear / category / time / log；`fractionOf` / `valueAtFraction` 是跨图联动的对齐基础 |
| ④ 组件 | `src/components/` | 否（碰 ctx） | 渲染 + 命中；系列组件与覆盖层组件两族 |
| ⑤ 门面 | `src/ICEChart.ts` | 否 | 编译管线（归一化 → 布局 → 比例尺 → 同步组件）、生命周期、公开 API |

纯函数这条线不是洁癖：`normalizeOption` / `computeLayout` / `scale` 必须能在**没有 DOM、没有 canvas**
的环境里跑（Node + jsdom 单测、DSL 编译、服务端预排版都靠它）。

## 3. 模块地图

| 目录 / 文件 | 关键导出 | 一句话 |
|---|---|---|
| `option/normalize.ts` | `normalizeOption` / `applyViewToNormalized` / `canApplyView` / `toSerializableOption` | 归一化（最大的一块，纯函数，含类目域的增量维护与点集复用缓存） |
| `layout/layout.ts` | `computeLayout` | 直角坐标 / 极坐标 / 雷达 / 桑基的几何排版 |
| `layout/{treemap,sankey,force}.ts` | —— | 三种专用布局算法（矩形树图 / 桑基 / 力导向） |
| `scale/*` | `createScale` / `LinearScale` / `BandScale` / `TimeScale` / `LogScale` | 值 ↔ 比例（`0..1`）↔ 像素；查表口（`categoryLookup`）在这里被消费 |
| `components/series/*` | `SeriesBase` + 17 个类型 | 系列渲染与命中 |
| `components/*` | `Axis` / `GridLines` / `Legend` / `Title` / `Tooltip` / `Crosshair` / `Highlight` / `Brush` / `Annotation` / `DataZoomSlider` / `PlotArea` | 覆盖层与装饰 |
| `interaction/HitResolver.ts` | `resolveTarget` / `pickColumn` / `nearestByXValue` | 像素 → 组件 → 数据下标 |
| `interaction/InteractionController.ts` | 指针 / 滚轮 / 键盘 / 框选 / 缩放平移 | 交互状态机（每张图一个） |
| `interaction/ChartLink.ts` | `linkCharts` | 跨图联动（同一 x 窗口 / 同一悬停列） |
| `expr/*` | `compileExpression` / `compileSampler` / 诊断 | 表达式绘图（**禁用 `eval` / `new Function`**，自己写词法 / 语法 / 求值） |
| `a11y.ts` | `buildDataTable` / `buildDataNodes` / `chartTitle` | 无障碍：数据表镜像与节点树 |
| `annotation/resolve.ts` | `resolveAnnotation` | 标注（目标线 / 阈值 / 区间 / 异常点）的解析 |
| `ICEChart.ts` | `createChart` / `ICEChart` | 门面：公开 API、管线、缓存宿主、事件 |

## 4. 一次数据更新的完整链路

以 `chart.setData('k', rows)` 为例（`ICEChart.ts`）：

```
setData(id, rows)
  └─ option.series[i].data = rows            // 就地改 option（唯一事实来源）
     └─ afterDataChange()                    // 批里只记账；批外立即：
        └─ applyOption(option, {animate, preserveView:true})
           ① normalizeOption(option, ctx)    // 全域名归化：点集 / 类目表 / 域 / 主题
           ② 主题补丁 + fullXDomain/fullYDomains + hiddenIds
           ③ rebuild(animate, null, ①的结果)
              ├─ applyViewToNormalized(...)  // 视窗只套「域」，不重跑整条（见 pipeline.md §3）
              ├─ computeLayout(norm, ctx, canvas)
              ├─ buildScales(norm)           // 比例尺（查表口在这里交出去）
              ├─ syncComponents(animate)     // 组件：updateSeries / setCoord / markDirty
              ├─ syncMarks()                 // 数据坐标图元跟着摆手
              └─ controller.refreshHover()   // 悬停视觉跟数据重新定位
          ④ 需要时启动 y 域过渡（domainTransition）
```

要点：

1. **一次更新只跑一遍归一化**（`applyViewToNormalized`），表达式系列与等比坐标例外（见 `pipeline.md` §3）。
2. **视窗（缩放 / 平移）不是数据**：`viewState` 只影响域，不影响点集。
3. **脏矩形靠组件自己标**：`markDirty()` 是唯一的脏来源，图表层不整幅重绘。
4. **悬停 / 准星 / 提示框是独立覆盖层**，数据更新只让它们重新定位（`refreshHover`），不重绘系列。

## 5. 关键数据结构

| 结构 | 位置 | 说明 |
|---|---|---|
| `NormalizedOption`（`norm`） | `src/internal.ts` | 一次归一化的全部产物：`series` / `xAxis` / `yAxes` / `categories` / `kind` / `theme` / `option`（合并后的） |
| `InternalSeries` | 同上 | 系列的统一视图：`pointCount` / `pointAt(i)` / `xValueAt(i)` / `yValueAt(i)` …**读点一律走访问器**，不直读 `points[]` |
| `ChartLayout` | 同上 | `canvas` / `plot` / `title` / `legend` / 各轴占位 / `polar`；**坐标一律是画布坐标系** |
| `SeriesCoord` | `components/series/SeriesBase.ts` | 系列私有坐标系：`plot` 矩形 + `xScale` / `yScale` |
| `CategoryDomainCache` | `option/normalize.ts` | 类目域的一次性缓存 + **增量类目表**（绝对序号口径） |
| `PointCacheEntry` | 同上 | 点物化的复用缓存（数据数组身份 + 长度 + 解析规则） |
| `virtualColumns` | `ICEChart.ts` | 列存 / 环形 / 分块 / 矩阵 / 惰性原始点这些**存储**（按系列 id） |

## 6. 全仓铁律

逐条全文在根 `AGENTS.md`，这里只列索引（改代码前请读原文）：

| # | 铁律 | 一句话 |
|---|---|---|
| 1 | 命中判定写在组件里 | `containsLocalPoint()` 就是数据命中判定，不许在图表层另写一套反查 |
| 2 | 像素缓存唯一 | `rebuildPixels()` 是点集像素的唯一来源（惰性原始点例外） |
| 3 | `doRender()` 自己 `beginPath()` | 否则会把脏矩形留下的 clip 路径一起描出来 |
| 4 | 禁止直接调用 `ICEEvent.preventDefault()` | 统一走 `InteractionController.preventDefault()` |
| 5 | 指针入口先过 `isOverCanvas()` | 引擎监听挂在 window 上，每张图都会收到整页事件 |
| 6 | 键盘只由最后激活的图响应 | 模块级 `activeController` |
| 7 | 联动回显必须包 `silent()` | 否则 A→B→A 无限递归 |
| 8 | 交互反馈用独立覆盖层 | 不重绘系列，否则脏矩形失效 |
| 9 | 组件 props/state 只放可序列化配置 | 运行时状态放普通字段 |
| 10 | 纯函数层不引入引擎依赖 | 见 §2 |
| 11 | 表达式一律走 `src/expr` | 禁 `eval` / `new Function`，且不能让图表崩 |
| 12 | 视窗只影响「域」 | 一次更新一遍归一化 + `applyViewToNormalized`；新增依赖视窗的字段必须改 `canApplyView` |

## 7. 坐标系与「盒」的约定

1. **所有组件 `origin: 'top-left'`**，本地坐标系就是左上角原点；引擎图元的 `left/top`
   就是**绘制盒的左上角**，`origin` 只影响变换枢轴（不要按它做中心换算）。
2. **系列组件的盒 = 绘图区矩形**（极坐标是圆的外接正方形），本地坐标 = 绘图区内的像素。
3. **覆盖层组件（轴 / 网格 / 图例 / 标题 / 提示框 / 准星 / 滑块）的盒 = 整块画布**，
   本地坐标即画布坐标 —— 这样轴标签、提示框可以自然画到绘图区之外。
4. **比例尺的 `map()` 返回绘图区本地坐标**（`0..plot.width`），覆盖层用它要先加 `plot.x/plot.y`。
5. 非直角坐标场景（饼 / 雷达 / 桑基 / 树图 / 仪表 …）**不画坐标轴**，布局也不为它们预留空间。
6. 屏幕坐标向下的 y 轴（range = `[height, 0]`）里画 band 矩形是**从起点向上**：`y = bandStart - bandHeight`。

## 8. 状态、缓存与生命周期

| 状态 | 归属 | 何时失效 |
|---|---|---|
| `option` | 用户 | 唯一事实来源；`setOption` / `setData` / `appendData` 就地改它 |
| `norm` / `layout` | 图表实例 | 每次 `rebuild()` 重建 |
| `viewState`（x/y/yAxes 窗口） | 图表实例 | 用户手势 / `setDomain` / 联动；`preserveView:false` 时重置 |
| `hiddenIds` / `hiddenSlices` | 图表实例 | 图例 / 扇区切换 |
| `virtualColumns` | 图表实例 | 存储不再对应任何虚拟系列时清掉 |
| `__categoryCache` / `__pointCache` | 图表实例 | 「输入指纹变了」时自动失效；详见 `pipeline.md` §4 |
| `seriesComponents[].pixels/effective/itemProgress` | 组件 | 由 `buildSeriesKey()`（含坐标系指纹 + 动画进度）失效 |
| `domainTransition` / 动画补间 | 图表 / 组件 | `finishAnimations()` 收尾；`__` 前缀的循环补间**不收** |

**销毁**：`chart.destroy()` 释放引擎实例、模块级 `activeController`、事件监听与补间。
多图页面里这是唯一的清理入口 —— 不销毁的图会继续吃 window 上的指针事件（见铁律 5）。
