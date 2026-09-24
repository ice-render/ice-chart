# 数据形态与大数据

> 同一份数据可以按五种形态喂进来，代价与能力各不相同。选错了不会报错，只会慢或占内存。

## 目录

1. [五种存储形态](#1-五种存储形态)
2. [普通系列](#2-普通系列)
3. [数值列（Float64Array）](#3-数值列float64array)
4. [惰性原始点](#4-惰性原始点)
5. [环形缓冲](#5-环形缓冲)
6. [分块按需加载](#6-分块按需加载)
7. [稠密矩阵（虚拟热力图）](#7-稠密矩阵虚拟热力图)
8. [引擎虚拟子源](#8-引擎虚拟子源)
9. [代价与边界](#9-代价与边界)
10. [快照契约](#10-快照契约)

## 1. 五种存储形态

`series[i].virtual: true` 是「不建每点一个 `DataPoint`」的总开关，具体走哪一种由 `data` 的形状决定：

| 形态 | 触发条件 | 支持的类型 | 关键收益 |
|---|---|---|---|
| **普通** | 默认 | 全部 | 语义最简单、能进快照 |
| **数值列** | `virtual: true` + `data: { x, y }`（`Float64Array` 直接采用） | `scatter` / `line` / `area` | 百万点不建对象、不建按点像素缓存 |
| **惰性原始点** | `virtual: true` + 其它任何 `data`（含自定义类型） | 任意（含 `registerSeriesType`） | 省「每点一个 `DataPoint`」，原始数据按引用保留 |
| **环形缓冲** | `virtual: true` + `appendData(..., { maxPoints })` | 数值列 / 惰性原始点 | 滑动窗口追加 O(1)（10 万点 0.4ms/次） |
| **分块按需** | `virtual: true` + `data: { sizes, rangeOf, yDomain, loadChunk }` | `line` / `scatter` 等 | 十亿级数据只驻留可见块 |
| **稠密矩阵** | `virtual: true` + 热力图 | `heatmap` | 命中 O(1)，亚像素按像素块聚合 |

## 2. 普通系列

每个数据点物化一个 `DataPoint`（`index` / `xValue` / `y` / `raw` / `base` / `top` / `name`）。

- **优点**：一切能力都在（提示框的 `params.data`、快照、动画起点数组 `effective`、像素缓存）。
- **代价**：百万点 ≈ 40~70MB 的原始数据 + 每点一个对象；滑动窗口每 tick 都要重建。
- **已做的优化**：同一份数据数组 + 同一解析规则时**复用点集**（见 `pipeline.md` §2.4），
  平移 / 缩放不再重建（10 万点 3.4 → 1.0ms/tick）。

## 3. 数值列（Float64Array）

```ts
series: [{ type: 'line', virtual: true, data: { x: xs, y: ys } }]   // xs / ys 都是 Float64Array
```

- **列直接采用（不复制）**：`Float64Array` 省掉一份 8MB/百万点的复制；普通数组会被转成 `Float64Array`。
- **只有数值型 x**：类目轴 + 字符串 x 会被拒绝（别把 100 万个数值聚合成 100 万个类目）。
- **不物化按点像素缓存**：`pixels` / `effective` / `itemProgress` 光缓存就是 40MB，
  所以虚拟系列的渲染与命中都从「列 + 同一份比例尺」现算（共用内核在 `SeriesBase`：
  `syncVirtualMeta` / `virtualVisibleWindow` / `virtualPixelAt` / `virtualNearestIndexAtX`）。
- **原始 `data` 会被释放**：归一化建完列就把 `option.series[i]` 换成不含 `data` 的副本；
  列存缓存在 `chart.virtualColumns`（下一次归一化靠它复用）。

## 4. 惰性原始点

自定义系列（K 线那种 `{ x, o, c, l, h, v }` 元组）的原始数据**本身就要保留** ——
组件按自己的字段解析、提示框要用 `params.data`。所以这条形态省的是「每点一个 `DataPoint`」，
原始数据按引用保留。

1. **取点规则与普通系列逐字一致**（共用 `readGenericPoint`）：`xValue` / `y` / `name` / `size`
   两边必须同源，否则提示框与命中会分叉。
2. **像素缓存照旧建**：自定义系列的 `doRender()` 通常直接读 `this.pixels`，不建缓存会**静默不画**。
3. **追加**：不给窗口就原地 push（调用方那个数组也跟着长）；给了 `maxPoints` 就转成**原始环**
   （`capacity` / `start`，滚动窗口 O(1)）。
4. **类目表增量维护在存储里**（见 `pipeline.md` §2.3）。

## 5. 环形缓冲

`appendData(id, items, { maxPoints: 窗口 })`：容量就是滑动窗口大小，满了覆盖最老的；
每次追加只写一个槽位 + 挪一次起点 —— 不 concat、不重建数据点对象、不重建像素。

| 窗口 | 环形（数值列 / 原始点） | 普通路径（`setData` 重建） |
|---|---|---|
| 1 500 | **0.10ms/次** | 0.30ms |
| 2 万 | **0.20ms** | 0.80ms |
| 10 万 | **0.40ms** | 5.80ms（p95 15.1ms） |

三条纪律：

1. 只有**数值列 / 惰性原始点**能流式；热力图是矩阵，追加没有「下一格」语义，会报错。
2. **物理下标 ≠ 逻辑下标**：一律走 `xValueAt` / `pointAt` 读，不许直读 `ring.x[i]`。
3. 环形形态下**原始数据归存储所有**，`option` 里被摘掉 —— 快照因此不再含它，`restore()` 会显式报错。

## 6. 分块按需加载

```ts
series: [{
  type: 'line', virtual: true,
  data: { sizes, rangeOf, yDomain, loadChunk, maxResidentChunks }
}]
```

1. `rangeOf(i)` / `yDomain` **必须声明式**：前者让窗口定位不必先加载块，后者让坐标轴不随加载漂移。
2. 窗口覆盖的块远多于驻留预算时**按预算均匀取样**，不能对窗口内每块都发请求
   （10 亿点全量视图覆盖 1 万块，全请求 = 1 万次加载 / 初始化 22 秒；取样后 3 次 / 3ms）。
3. 分块系列的**最近邻不能在全量下标上二分**（未驻留区间的 `xValueAt` 是 `undefined`，
   会一路走到头、命中判空）：先用 x 值定位到块，再在驻留块内二分。

## 7. 稠密矩阵（虚拟热力图）

热力图的收益有一半来自「**承认它是矩阵**」：行列类目 + 行优先值矩阵（`NaN` = 空格）。

- 命中退化成**类目查表 + 下标运算（O(1)）**，不再是逐格比矩形；
- 亚像素时按**屏幕像素块**聚合（块内取最大值，热点不被抹平），聚合结果按几何键缓存；
- 稀疏数据别开 virtual（归一化按密度报错）。

## 8. 引擎虚拟子源

`chart.createVirtualSource(seriesId)` 把列**不复制**地交给引擎的虚拟层
（`ICEVirtualLayer` 摆在绘图区上即可，坐标是组件本地 = 绘图区像素）：

```ts
const layer = new ICEVirtualLayer({
  left: chart.layout.plot.x, top: chart.layout.plot.y,
  width: chart.layout.plot.width, height: chart.layout.plot.height,
  childSource: chart.createVirtualSource('big'),
});
```

白拿引擎侧能力：**命中即物化**（点一下就变成真图元，可拖、可挂控制面板）、SVG 导出、
对齐参考线。两点注意：

1. `forEachInBox` 是 O(窗口项数)（100 万项全窗约 30ms）—— 按需调用，别每帧全窗扫。
2. `materialize` 只造组件，**挂树由调用方做**（引擎定的口径）。

## 9. 代价与边界

**代价要一直显式，不许静默降级**：

| 情形 | 行为 |
|---|---|
| 快照里没有数据（列存 / 环形） | `restore()` **直接报错**，不猜 |
| 对虚拟系列调 `appendData` 但热力图 | 报错（矩阵没有「下一格」） |
| 数值列系列遇到类目轴 / 堆叠 / 非数值 x | 报错或退回惰性原始点（见 §3、§4） |
| 虚拟热力图太稀疏 | 报错（按密度判断，别开 virtual） |
| 对列式 `data` 调 `appendData` | 报错，提示改用 `setData` |

**支持矩阵**（摘要）：

| 能力 | 普通 | 数值列 | 惰性原始点 | 环形 | 分块 | 矩阵 |
|---|---|---|---|---|---|---|
| 进快照 | ✅ | ❌ | 环形态 ❌ | ❌ | ❌ | ❌ |
| 提示框 `params.data` | ✅ | ❌（列存没有原始对象） | ✅ | ✅ | 驻留块内 ✅ | 单元格值 ✅ |
| `appendData` | ✅（重建） | ✅ | ✅ | ✅ | ❌ | ❌ |
| 命中复杂度 | 二分 / 邻域 | 二分 / 邻域 | 二分 / 邻域 | 二分 / 邻域 | 块内二分 | O(1) |

## 10. 快照契约

1. **唯一事实来源是 option 快照**：`{ version, option, view, hidden, hiddenSlices }`。
   引擎组件树（`ice.toJSONString()`）**不是**持久化格式：它只有几何与样式，
   没有比例尺 / 数据点 / 命中缓存，反序列化回来是空壳。
2. 往返必须同时满足：**幂等**（还原后再导出与原文字节一致）与**像素一致**（两张画布 `toDataURL()` 相同）。
   测试见 `tests/chart/serialization.test.ts`，浏览器现场比对见 `examples/serialize.html`。
3. **函数字段（formatter 等）不进 JSON**，靠 `optionPatch` 在还原时补；
   `mergeOptionPatch` 里「带 id 的补丁只按 id 合并」这条规则不能回退
   （否则补丁第 N 条会被误合并到快照第 N 条上，曾把 A 系列改名成 B）。
4. 快照带 `version`（`SNAPSHOT_VERSION`）；加载更高版本必须显式报错，不要静默降级。
