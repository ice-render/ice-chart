# 大数据量散点的虚拟化（Phase 1 / Phase 2 都已落地）

> 施工图与验收标准。**Phase 1 / Phase 2 都已落地**（结论、实测与取舍都在下面），
> 新会话请从这里开始读，不要重新调研。
>
> 还没做的：虚拟系列目前只覆盖 `scatter`（line / area 的列存没有需求驱动，先不做）；
> `appendData` 的增量绘制仍未实现（虚拟系列干脆报错，让调用方走 `setData`）。

## 背景与目标

1M 散点在默认视图下**全部可见**（1M 点挤 960px），2026-09-21 实测：

- 修复前：平移 **472.7 ms/帧（≈2fps）**、62 个长任务累计 **29.3s**、堆 **150.9MB**、命中 **4.2ms**
- 探针证据：平移期间**系列组件 / `series` / `points[0]` 的对象身份都没变**（没有重建）
  → 瓶颈是"每点一次 `drawSymbol()`（各自 beginPath/arc/fill）"，不是重建、不是归一化

## Phase 1（✅ 已完成，`main 80ec32c`）

改动两个文件，`verify:full` 全绿（45 套 / 407 条单测 + 36 条 e2e）：

- `src/components/series/ScatterSeries.ts`：x 单调时**二分定位可见下标区间**（放大后逐点绘制）；
  可见点数 > 4096 时**按 stride 密度抽稀**（≈2 点/像素列）
- `src/components/series/SeriesBase.ts`：**纯平移快路径** —— x 跨度与 y 域都没变时只给 x 像素加常数，
  跳过 `map()/computeEffective()/computeSizeExtent()/buildRenderIndices()`

实测（同一把尺子，1M 散点）：平移 p50 **476.8 → 8.4ms（120Hz）**、p95 486 → 22.7ms、
长任务 **62 → 0**；堆 150.9MB（Phase 2 处理）、命中 4.2ms（精度不变，`hitTestIndex` 仍读全量 `pixels`）。

复现脚本：`/tmp/scatter-1m-v2.cjs`（真机 Chrome + CDP，页内实建 1M 散点）。

## Phase 2（✅ 已完成，`main` 之上的 4 个提交：适配层 → 批次 A → 批次 B/C → 列存）

分四步走（每步都停在「全绿」），提交见本仓 `feat/scatter-column-store` 分支：

1. `refactor(series)`: 加 `InternalSeries.pointAt` 适配层 + 契约测试（零行为变化）。
2. `refactor(series)`: 批次 A 热路径 18 处（InteractionController / HitResolver / ICEChart）走向适配层，
   并补 `pointCount` —— 列存系列的 `points` 是空的，`points.length` 会把整条系列当成「没有数据」。
3. `refactor(series)`: 批次 B/C 的 82 处直读清零（组件 / a11y / layout / normalize），
   同时补**标量访问器** `xValueAt / yValueAt / baseAt / topAt / sizeAt`：
   逐点绘制与插值的循环只取标量，否则缩放时每帧要为 100 万点各 new 一个 `DataPoint`。
4. `feat(scatter)`: 真正不建 `points` —— `virtual: true` 的散点建列存、释放原始 data、
   不物化像素与动画缓存，渲染与命中都从列现算。

**实测（同一把尺子，100 万点，真机 Chromium；`/tmp/ice-virtual-measure.mjs`）**

| 口径 | 普通（元组 + DataPoint） | 虚拟（列存） |
|---|---|---|
| 堆（CDP `Runtime.getHeapUsage`，GC 后） | 125.2 MB | **2.2 MB** |
| `points.length` / `pointCount` | 1,000,000 / 1,000,000 | **0** / 1,000,000 |
| `pixels.length` | 2,000,000 | **0** |
| 命中 p50 / p95 | 0.8 ms / 1.1 ms | **0.00 ms / 0.00 ms** |
| 平移 p50 / p95（60 帧拖拽） | 16.7 ms / 17.5 ms | 16.7 ms / 17.4 ms（都在 60fps 上限） |
| 构建 | 752 ms | 640 ms |

**交付的用法**（大数据推荐直接给列，图表直接采用、不复制）：

```js
series: [{ type: 'scatter', virtual: true, data: { x: Float64Array, y: Float64Array } }]
```

**取舍（都做成显式报错，不静默降级）**：数据不进 option 快照（`restore()` 报错）、
提示框 `params.data` 为空、`appendData` 报错（改 `setData`）、只支持数值型 x 的 scatter。
示例页 `examples/large-data-scatter-virtual.html`；铁律层面的说明见 `AGENTS.md`
「虚拟（列存）系列」一节。

**门禁**：`verify:full`（47 套 423 条单测 + 37 条 e2e）、`audit:interactions`（322 步 0 问题）、
`audit:hover`（396 项 0 失败、像素缓存新鲜、无 console 报错）。

## 相关参考

- 引擎侧虚拟子源原型（同一思路的"整份文档交给引擎"版本）：`examples/large-data-virtual.html`
  （50 万 × 3 系列：堆 1.7MB + typed 15.3MB、120fps、命中 <0.1ms；`main 362a3b4`）
- 引擎 4.3.0 的 `renderSubtreeTo` / `Path2DRecorder` 默认原生：`ice-render/CHANGELOG.md`
