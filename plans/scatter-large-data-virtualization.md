# 大数据量散点的虚拟化（Phase 1 已落地 / Phase 2 待做）

> 施工图与验收标准。**新会话请从这里开始读**，不要重新调研。

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

## Phase 2（待做：把 `points` 换成列存）

**读取点分布（实测，`grep -rc '\.points' src`）**

| 批次 | 文件（读取点数量） |
|---|---|
| A · 热路径 | `interaction/InteractionController.ts`(10)、`interaction/HitResolver.ts`(4)、`ICEChart.ts`(4) |
| B · 建模与渲染 | `option/normalize.ts`(14，含 `buildPoints`)、`components/series/SeriesBase.ts`(10) |
| C · 其余 | `Boxplot`(7)/`Pie`(6)/`Heatmap`(6)/`Bar`(6)/`Liquid`(5)/`Funnel`(5)/`Gauge`(4)/`Waterfall`(3)、`a11y.ts`(5) |

**三步走（每步都能停在"全绿"）**

1. **加适配层**（不改任何调用点）：`InternalSeries.pointAt(i)` —— 普通系列 `return points[i]`（逐字不变），
   列存系列按需合成 `{ xValue, yValue, raw }`（与 `buildPoints` 现在产出的字段逐一对齐）。
   验证：`npm test`（407 条）全绿 = "适配层零行为变化"。
2. **批次 A 迁移**：18 处 `series.points[...]` → `series.pointAt(...)`。仍是纯重构（功能/内存都不变），跑 `npm test` 全绿。
3. **真正不建 `points`**：`normalize` 在 `series.virtual === true` 时流式建 `Float64Array` 列 + 算域，
   `points` 留空。最后跑 `verify:full` + 1M 对照 + 普通系列逐像素对照，一次性提交。

**纪律**：只有 `normalize`（建列存）与 `pointAt`（合成）两处允许 `new DataPoint`；其余读取一律走 `pointAt`。
半迁移状态（`points` 已空但仍有站点直读）会造成**静默少画/提示框空**，禁止提交。

**验收**：1M 散点堆 **150.9MB → ≤30MB**、命中 **4.2ms → ≤1ms**、平移保持 8.4ms；
普通（非 virtual）系列逐像素不变；407 单测 + 36 e2e 全绿。

## 相关参考

- 引擎侧虚拟子源原型（同一思路的"整份文档交给引擎"版本）：`examples/large-data-virtual.html`
  （50 万 × 3 系列：堆 1.7MB + typed 15.3MB、120fps、命中 <0.1ms；`main 362a3b4`）
- 引擎 4.3.0 的 `renderSubtreeTo` / `Path2DRecorder` 默认原生：`ice-render/CHANGELOG.md`
