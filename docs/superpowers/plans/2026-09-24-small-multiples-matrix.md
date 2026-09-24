# 小倍数（面板矩阵 matrix）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一张画布放下 N 个同构面板（共享数据域、悬停/框选/缩放/键盘按面板解析、轴只画外圈），且不给 `matrix` 时现有行为逐像素不变。

**Architecture:** 布局产出 `panels: Rect[]`（`plot` = 并集）；每个面板建自己的比例尺实例（域共享、range 不同）；系列 / 网格 / 轴按面板实例化；`HitResolver.isInsidePlot` 换成 `panelAt()`，交互到处按面板解析。

**Tech Stack:** TypeScript + jest（jsdom + `tests/setup/canvas-env.ts` 的 Canvas 2D 桩）+ 真实引擎（不 mock）。

**Spec:** [`docs/superpowers/specs/2026-09-24-small-multiples-matrix-design.md`](../specs/2026-09-24-small-multiples-matrix-design.md)

## Global Constraints

- 仓库纪律：不写第三方 / 竞品项目名（源码、文档、示例、提交信息全算）。
- 铁律：命中判定必须在组件的 `containsLocalPoint`；像素缓存唯一（`rebuildPixels()`）；组件盒 = 某块绘图区的本地坐标；直角坐标系列 `clipToBox = true`。
- `matrix` 缺席时：`panels = [plot]`、所有面板逻辑短路 —— 现有 578 条测试必须全绿且**逐像素不变**。
- `norm.xAxis.scale` / `norm.yAxis.scale` 的语义保持「面板 0 的比例尺」（测试与内部多处依赖）。
- 每个任务结束都要 `npx jest <相关文件>` 绿 + 提交；提交信息用 `type(scope): 中文描述`。

## Review Focus

1. **不传 `matrix` 的老图**：任何视觉或命中上的变化都是回归（先用现有 578 条钉住）。
2. **`series[].panel` 越界 / 负数 / 非整数**：期望「夹到合法范围后照常画」，不抛异常、不整张图空白。
3. **面板很窄（列数多、画布小）**：期望「不出现负尺寸 / NaN」，允许被裁。
4. **坐标归属**：同一份数据在两个面板里像素位置不同，但**数据下标与数据值一致**（悬停提示框给的值不能串面板）。
5. **轴触发提示框**：只列**指针所在面板**的系列，不能把别的面板的系列混进同一个提示框。

---

### Task 1: 面板几何纯函数

**Files:**
- Create: `src/layout/panels.ts`
- Test: `tests/layout/panels.test.ts`

**Interfaces:**
- Produces:
  - `interface ResolvedMatrix { rows: number[]; columns: number[]; gap: number; panelCount: number }`
  - `resolveMatrix(option: MatrixOption | undefined | null): ResolvedMatrix | null`
  - `computePanelRects(area: Rect, matrix: ResolvedMatrix): Rect[]`
  - `panelIndexAt(panels: Rect[], x: number, y: number): number`（-1 = 不在任何面板内）

- [ ] **Step 1: 写失败测试**（`tests/layout/panels.test.ts`）

```ts
import { computePanelRects, panelIndexAt, resolveMatrix } from '../../src/layout/panels';

const AREA = { x: 40, y: 20, width: 600, height: 300 };

describe('resolveMatrix', () => {
  it('没有 matrix 时返回 null（单面板基线）', () => {
    expect(resolveMatrix(undefined)).toBeNull();
    expect(resolveMatrix(null)).toBeNull();
  });
  it('数字 = 等分权重', () => {
    expect(resolveMatrix({ rows: 2, columns: 3 })!.rows).toEqual([1, 1]);
    expect(resolveMatrix({ rows: 2, columns: 3 })!.columns).toEqual([1, 1, 1]);
    expect(resolveMatrix({ rows: 2, columns: 3 })!.panelCount).toBe(6);
  });
  it('数组 = 权重（[4,1] 给主图 + 窄条）', () => {
    const m = resolveMatrix({ rows: [3, 1], columns: [4, 1] })!;
    expect(m.rows).toEqual([3, 1]);
    expect(m.columns).toEqual([4, 1]);
    expect(m.panelCount).toBe(4);
  });
  it('零 / 负 / 非有限 → 退化成 1；权重 ≤ 0 按 1 处理', () => {
    expect(resolveMatrix({ rows: 0, columns: -2 })!.panelCount).toBe(1);
    expect(resolveMatrix({ rows: [0, 2], columns: 2 })!.rows).toEqual([1, 2]);
    expect(resolveMatrix({ rows: NaN as any, columns: 1 })!.rows).toEqual([1]);
  });
  it('gap 默认 8，负数归 0', () => {
    expect(resolveMatrix({ rows: 1, columns: 1 })!.gap).toBe(8);
    expect(resolveMatrix({ rows: 1, columns: 1, gap: -3 })!.gap).toBe(0);
  });
});

describe('computePanelRects', () => {
  it('等分 2×3：行优先，且扣掉 gap', () => {
    const m = resolveMatrix({ rows: 2, columns: 3, gap: 10 })!;
    const panels = computePanelRects(AREA, m);
    expect(panels).toHaveLength(6);
    const colWidth = (600 - 20) / 3;
    const rowHeight = (300 - 10) / 2;
    expect(panels[0]).toEqual({ x: 40, y: 20, width: colWidth, height: rowHeight });
    expect(panels[2].x).toBeCloseTo(40 + colWidth * 2 + 20);
    expect(panels[3].y).toBeCloseTo(20 + rowHeight + 10);
    expect(panelIndexAt(panels, panels[4].x + 1, panels[4].y + 1)).toBe(4);
  });
  it('权重 4:1 的列宽比例正确', () => {
    const panels = computePanelRects(AREA, resolveMatrix({ rows: 1, columns: [4, 1], gap: 0 })!);
    expect(panels[1].width).toBeCloseTo(120);
    expect(panels[0].width).toBeCloseTo(480);
  });
  it('面板太小按 1px 兜底，不出负尺寸', () => {
    const panels = computePanelRects({ x: 0, y: 0, width: 9, height: 9 }, resolveMatrix({ rows: 5, columns: 5, gap: 8 })!);
    for (const p of panels) {
      expect(p.width).toBeGreaterThanOrEqual(1);
      expect(p.height).toBeGreaterThanOrEqual(1);
    }
  });
  it('panelIndexAt 落在缝隙里返回 -1', () => {
    const panels = computePanelRects(AREA, resolveMatrix({ rows: 1, columns: 2, gap: 20 })!);
    const gapX = panels[0].x + panels[0].width + 10;
    expect(panelIndexAt(panels, gapX, AREA.y + 5)).toBe(-1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：`npx jest tests/layout/panels.test.ts`（模块不存在）
- [ ] **Step 3: 最小实现**（`src/layout/panels.ts`，纯函数，不依赖 DOM / 引擎；`weaveRects` 里 `Math.max(1, …)` 兜底）
- [ ] **Step 4: 跑测试确认通过**：`npx jest tests/layout/panels.test.ts`
- [ ] **Step 5: 提交**：`feat(matrix): 面板几何纯函数（权重切分 + 命中归属）`

---

### Task 2: 归一化接入（`option.matrix` → `norm.matrix`，`series[].panel`）

**Files:**
- Modify: `src/types.ts`（`MatrixOption`、`SeriesOption.panel`、`ChartOption.matrix`）
- Modify: `src/internal.ts`（`NormalizedOption.matrix`、`InternalSeries.panel`）
- Modify: `src/option/normalize.ts`（调 `resolveMatrix`，逐系列夹取 `panel`）
- Test: `tests/option/matrix-normalize.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveMatrix`
- Produces: `norm.matrix: ResolvedMatrix | null`；`series.panel: number`（已夹到 `[0, panelCount-1]`）

- [ ] **Step 1: 写失败测试**

```ts
it('把 option.matrix 归一化到 norm.matrix，并把越界 panel 夹回合法范围', () => {
  const norm = normalizeOption({
    matrix: { rows: 2, columns: 2 },
    series: [
      { type: 'line', data: [1, 2, 3], panel: 3 },
      { type: 'line', data: [3, 2, 1], panel: -5 },
      { type: 'line', data: [2, 2, 2] },
    ],
  });
  expect(norm.matrix!.panelCount).toBe(4);
  expect(norm.series.map((s) => s.panel)).toEqual([3, 0, 0]);
});
it('不给 matrix 时 norm.matrix 为 null，series.panel 恒为 0', () => {
  const norm = normalizeOption({ series: [{ type: 'line', data: [1, 2, 3], panel: 2 }] });
  expect(norm.matrix).toBeNull();
  expect(norm.series[0].panel).toBe(0);
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（`resolveMatrix` 结果挂到 norm；`panel = matrix ? clamp(...) : 0`）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**：`feat(matrix): option.matrix 与 series[].panel 的归一化`

---

### Task 3: 布局产出面板矩形（`ChartLayout.panels`）

**Files:**
- Modify: `src/internal.ts`（`ChartLayout.panels: Rect[]`）
- Modify: `src/layout/layout.ts`（算完 `plot` 之后按 matrix 切分）
- Test: `tests/layout/layout.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `computePanelRects`、Task 2 的 `norm.matrix`
- Produces: `layout.panels: Rect[]`；`layout.plot` = 面板并集（无 matrix 时 `panels = [plot]`）

- [ ] **Step 1: 写失败测试**（关键断言：**无 matrix 时逐像素一致**）

```ts
it('没有 matrix 时 panels 就是旧的 plot（逐像素一致）', () => {
  const { layout } = layoutOf({ series: [{ type: 'line', data: [1, 5, 3] }] });
  expect(layout.panels).toEqual([layout.plot]);
});
it('2×2 面板：并集 = plot，各面板不重叠', () => {
  const { layout } = layoutOf({
    matrix: { rows: 2, columns: 2, gap: 6 },
    series: [
      { type: 'line', data: [1, 5, 3], panel: 0 },
      { type: 'line', data: [3, 1, 2], panel: 3 },
    ],
  });
  expect(layout.panels).toHaveLength(4);
  expect(layout.panels[1].x).toBeGreaterThanOrEqual(layout.panels[0].x + layout.panels[0].width);
  expect(layout.panels[2].y).toBeGreaterThanOrEqual(layout.panels[0].y + layout.panels[0].height);
  // 并集覆盖最后一块面板的右下角
  const last = layout.panels[3];
  expect(layout.plot.x + layout.plot.width).toBeCloseTo(last.x + last.width);
  expect(layout.plot.y + layout.plot.height).toBeCloseTo(last.y + last.height);
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（`const panels = matrix ? computePanelRects(plotArea, matrix) : [plotArea]`；`plot` 取并集）
- [ ] **Step 4: 跑测试确认通过 + 全仓回归**：`npx jest tests/layout` 再 `npx jest`
- [ ] **Step 5: 提交**：`feat(matrix): 布局产出面板矩形（plot 保持为并集）`

---

### Task 4: `Axis` 接受 per-instance `plot`

**Files:**
- Modify: `src/components/Axis.ts`（新增 `public plot: Rect | null = null`，绘制时 `this.plot || this.layout.plot`）
- Test: `tests/components/axis-labels.test.ts`（追加一条：指定 plot 后刻度落点随之平移）

**Interfaces:**
- Produces: `Axis.plot: Rect | null`（不设 = 现有行为，**默认路径不变**）

- [ ] **Step 1: 写失败测试**（同一份刻度，`plot.y` 平移 100 后刻度像素 y 也平移 100）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（把 `this.layout.plot` 的 3 处读取改成 `this.plot || this.layout.plot`；`edgeX()` 同理）
- [ ] **Step 4: 跑测试确认通过**：`npx jest tests/components`
- [ ] **Step 5: 提交**：`feat(matrix): Axis 支持 per-instance plot`

---

### Task 5: Chart 接入（每面板比例尺 / 组件实例化）

**Files:**
- Modify: `src/ICEChart.ts`（创建与同步：面板比例尺、系列盒与 coord、`grids`、外圈轴）
- Test: `tests/chart/matrix.test.ts`

**Interfaces:**
- Consumes: Task 1~4 全部
- Produces: 面板化渲染（每个 `(series, 面板)` 一个组件；每面板一份网格；每行一份 y 轴；每列一份 x 轴）

**实现要点**
- 比例尺：`panelScales[i] = { x: createScale(..., [0, panel.width]), ys: yAxes.map(a => createScale(..., [panel.height, 0])) }`；
  `norm.xAxis.scale` / `norm.yAxis.scale` 仍指向**面板 0**。
- 系列组件：盒 = 该系列 `panel` 对应的矩形；`coord.plot` = 同一矩形。
- 网格：`this.grids: GridLines[]`（长度 = 面板数，无 matrix 时长度 1）。
- 轴：每行一份 y 轴（用该行最左列面板的矩形与比例尺）、每列一份 x 轴（用最底行该列面板的矩形与比例尺）。
- `matrix` 缺席时走现有单实例分支，**不新建任何数组实例**（保证默认路径零风险）。

- [ ] **Step 1: 写失败测试**

```ts
it('2×3 面板：每个面板的系列组件盒 = 该面板矩形，且比例尺 range 跟着面板走', async () => {
  const c = await mount(MATRIX_6);
  const panels = c.layout.panels;
  expect(panels).toHaveLength(6);
  const component: any = c.seriesComponents[5]; // panel: 5
  expect(component.state.left).toBe(panels[5].x);
  expect(component.state.width).toBe(panels[5].width);
  // 同一数据值在不同面板里的像素 x 不同（range 不同），但数据下标一致
  const other: any = c.seriesComponents[0];
  const a = other.pixelAt(1)!;
  const b = component.pixelAt(1)!;
  expect(a[0]).not.toBeCloseTo(b[0], 3);
  expect(other.series.pointAt(1).xValue).toEqual(component.series.pointAt(1).xValue);
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（按上面「实现要点」改 `ICEChart`）
- [ ] **Step 4: 跑测试确认通过 + 全仓回归**
- [ ] **Step 5: 提交**：`feat(matrix): 每面板比例尺与组件实例化（轴只画外圈）`

---

### Task 6: 交互按面板解析

**Files:**
- Modify: `src/interaction/HitResolver.ts`（`isInsidePlot` → `panelIndexAt`；`panelAt`）
- Modify: `src/interaction/InteractionController.ts`（轴触发列、十字线、框选、缩放锚点、键盘）
- Test: `tests/chart/matrix.test.ts`（追加）

**实现要点**
1. `HitResolver.panelAt(x, y): number`（用 Task 1 的 `panelIndexAt(layout.panels, ...)`）；`isInsidePlot` 改为 `panelAt(...) >= 0`（保留方法名，调用点不用全改）。
2. 轴触发：`buildColumn()` 只收 `series.panel === hoverPanel` 的系列；`ActiveColumn` 增加 `panel`。
3. 十字线：按 `hoverPanel` 的矩形画。
4. 框选：x 夹到 `layout.plot`（并集），y 夹到指针所在面板。
5. 缩放 / 平移锚点：用指针所在面板的 `xScale` 换算（`norm.xAxis.scale` 只用于面板 0）。
6. 键盘：在当前系列所属面板内移动。

- [ ] **Step 1: 写失败测试**

```ts
it('悬停第 6 个面板时，轴触发提示框只列该面板的系列', async () => {
  const c = await mount(MATRIX_6_AXIS_TOOLTIP);
  const panel = c.layout.panels[5];
  const series: any = c.seriesComponents[5];
  const pixel = series.pixelAt(1)!;
  c.controller.handlePointerMove(panel.x + pixel[0], panel.y + pixel[1]);
  const content = c.tooltip!.content!;
  expect(content.rows).toHaveLength(1);
  expect(content.rows[0].name).toBe('面板 6');
});
it('框选跨面板时，所有面板的 x 窗口一致（y 只影响指针所在面板）', async () => {
  // 在 panel 0 拖出一段 x → 检查 norm.xAxis.domain 变化，且其它面板的组件按同一域重算
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试确认通过 + 全仓回归**（`tests/interaction` 与 `tests/chart` 全绿）
- [ ] **Step 5: 提交**：`feat(matrix): 悬停/框选/缩放/键盘按面板解析`

---

### Task 7: 数据坐标图元按面板定位

**Files:**
- Modify: `src/types.ts`（`ChartMarkSpec.panel?: number`）
- Modify: `src/ICEChart.ts`（`markBox` / `markDataAt` 走面板）
- Test: `tests/chart/marks.test.ts`（追加）

**实现要点**：`panel` 默认 0；越界夹回；图元的 `xLine` / `yBand` 长度取该面板矩形。

- [ ] **Step 1: 写失败测试**（同一个 `yLine` 图元，`panel: 3` 时 `left` 落在第 4 个面板内）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**：`feat(matrix): addMark 图元支持 panel`

---

### Task 8: 示例页与交互审计

**Files:**
- Create: `examples/matrix.html`
- Modify: `examples/index.html`、`scripts/audit-interactions.mjs`、`scripts/audit-space.mjs`、`scripts/hover-sweep.mjs`

- [ ] **Step 1: 写示例页**（2×3 面板：六个渠道各一条折线 + 一个「主图 + 窄条」的权重示例；事件日志挂 `item:hover`）
- [ ] **Step 2: 加进三个脚本的 `pages`**
- [ ] **Step 3: 构建 + 单页审计**：`npm run build && npm run examples:prepare`，起服务后 `PAGES=matrix node scripts/audit-interactions.mjs ./.audit-matrix`，**problems 必须为空**
- [ ] **Step 4: 提交**：`feat(matrix): 面板矩阵示例页 + 审计接入`

---

### Task 9: 文档回写与全量门禁

**Files:**
- Modify: `docs/06-chart-types.md`（新增「面板矩阵」小节）
- Modify: `README.md`（能力清单 + 示例清单）
- Modify: `AGENTS.md`（新增「面板矩阵」纪律：面板只有 range 不同、域共享；新组件必须接受 per-panel plot）
- Modify: `CHANGELOG.md`（Unreleased 新特性）
- Modify: `plans/chart-type-candidates.md`（§4.1 标记已落地）
- Modify: `docs/superpowers/plans/2026-09-24-small-multiples-matrix.md`（回填各任务提交号）

- [ ] **Step 1: 回写文档**
- [ ] **Step 2: 跑全量门禁**：`npm run verify`（lint → types → build → jest 全绿）
- [ ] **Step 3: 提交**：`docs(matrix): 面板矩阵文档回写 + 全量门禁`
