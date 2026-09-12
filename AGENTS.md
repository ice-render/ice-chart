# AGENTS.md — ice-chart

## 项目定位

ice-chart 是构建在 **ice-render** Canvas 引擎之上的交互式图表库（MIT）。
引擎负责渲染 / 命中测试 / 事件派发 / 坐标系 / 脏矩形局部重绘，chart 层只做三件事：
**数据 ↔ 像素 ↔ 语义事件**。

读者请先读 `../ice-render/AGENTS.md`（引擎铁律），本文件只记录 chart 层的约定与踩过的坑。

## 架构分层（修改前必读）

- `option/normalize.ts`：纯函数。把用户 option 归一化成数据点 / 数据域 / 堆叠基线。
  不依赖 DOM / ctx / 引擎，必须可单测。
- `layout/layout.ts`：纯函数。用临时比例尺量刻度 → 排标题与图例 → 推出绘图区矩形。
- `scale/`：linear / category / time / log。`fractionOf / valueAtFraction` 是跨图联动的对齐基础。
- `components/`：渲染层。`SeriesBase` 的 `containsLocalPoint` **就是数据命中判定**，
  由引擎的 `ice.hitTest()` 直接调用。
- `interaction/`：`HitResolver`（像素 → 组件 → 数据下标）+ `InteractionController`
  （悬停 / 选中 / 框选 / 缩放 / 平移 / 键盘）+ `ChartLink`（跨图联动）。
- `ICEChart.ts`：编译管线（归一化 → 布局 → 比例尺 → 组件同步）与生命周期。

### 铁律

1. **命中判定必须写在组件的 `containsLocalPoint` 里**，不要在图表层另写一套「坐标反查数据」。
   遮挡关系、zIndex、`display:false`、`interactive:false` 全部由引擎统一保证；重写一套必然与渲染漂移。
2. **像素缓存唯一**：`rebuildPixels()` 是点集像素的唯一来源，渲染与命中都消费它。
   任何「渲染时另算一遍坐标」的写法都会让「看得见的点」与「点得到的点」分叉。
3. **组件的 `doRender()` 必须自己 `ctx.beginPath()`**。引擎的脏矩形局部重绘会在 ctx 上留下
   `clip` 用的 rect 路径，直接 `ctx.stroke()` 会把那条残留路径一起描出来 ——
   表现为画布边缘莫名多出一圈与最后绘制的系列同色的线。`ICEPath` 系组件因为有独立 Path2D 才不需要担心。
4. **禁止直接调用 `ICEEvent.preventDefault()`**：引擎的 `ICEEvent` 只是接口模拟（调用会抛异常），
   某些路径下事件对象上的 `preventDefault` 还是未绑定的原生方法（抛 `Illegal invocation`）。
   统一走 `InteractionController.preventDefault()`（取 `originalEvent` + try/catch）。
5. **引擎的原生事件监听挂在 window 上**：同一页面上的每张图都会收到**全页面**的事件。
   一切指针入口都必须先过 `isOverCanvas()`，否则会出现「在 A 图移动鼠标，B 图清掉刚镜像的悬停」。
6. **键盘只由最后激活的图响应**（模块级 `activeController`，`destroy()` 时释放）。
   不要在 `keydown` 里对所有图生效。
7. **联动回显必须 `silent()`**：`linkCharts` 把事件转发给其它图时必须包在 `chart.silent()` 里，
   否则 A→B→A 会无限递归（已踩过：RangeError: Maximum call stack size exceeded）。
8. **交互反馈用独立覆盖层，不要重绘系列**：鼠标移动只让 `Highlight / Crosshair / Tooltip` 变脏；
   压暗其他系列只在「悬停系列变化」时写一次 state。每次 mousemove 写系列 state 会让脏矩形失效。
9. **组件 props/state 只放可序列化的配置**；比例尺、像素缓存、命中索引等运行时状态放普通字段，
   不要进 state/props（序列化与内存都受影响）。
10. **纯函数层不许引入引擎依赖**：`normalizeOption` / `computeLayout` / `scale` 必须能在没有 DOM、
    没有 canvas 的环境下运行与测试。

## 坐标与原点约定

- 所有图表组件 `origin: 'top-left'`，本地坐标系就是「左上角为原点」的像素坐标；
  引擎默认的 `localCenter` 会让 `containsLocalPoint` 的默认实现（±width/2）与图表直觉不符。
- **系列组件**的盒 = 绘图区矩形，本地坐标 = 绘图区内的像素（0..plotWidth / 0..plotHeight）。
- **其它组件**（坐标轴 / 图例 / 标题 / 覆盖层）的盒 = 整块画布，绘制时直接用图表坐标系，
  这样轴标签、提示框可以自然画到绘图区之外，不必扩展包围盒。
- `chart.layout.*` 与 `series.pixelAt()` 返回的都是**图表坐标系（画布左上角为原点）**，
  对外事件里的 `screen` 才经过 `ice.worldToScreen()`。

## 测试约定

- `npm test` 跑 jest（jsdom + `tests/setup/canvas-env.ts` 提供的 Canvas 2D 桩）。
  **不要 mock 引擎**：集成测试走真实渲染 → 真实命中测试 → 真实事件派发，
  这样才能抓到「渲染与命中不一致」「多图串扰」这类只在真实链路上暴露的问题。
- jsdom 环境需要补 `crypto.randomUUID`（引擎用它生成组件 id），已放在 setup 里。
- 交互测试直接调 `controller.handlePointerMove/Down/Up/Click/Wheel/KeyDown`（入参是画布 CSS 像素），
  不需要合成 DOM 事件；需要真实浏览器行为时用 `examples/` + Playwright 手工验证。
- 新增能力时同步补三类用例：纯函数（scale/normalize/layout）、组件命中（series）、端到端交互（chart）。

## 提交前自检

```bash
npm run verify   # lint → types:check → build → jest
```

改动渲染或交互后，建议再手工跑一次 `npm run examples:serve`，用浏览器确认视觉与交互。
视觉 / 交互改动更严格的做法是跑审计脚本：

```bash
npm run build && npm run examples:prepare && node scripts/serve-examples.cjs &
npm run audit:interactions -- ./.audit
```

它会对 12 个示例页跑 10 步真实交互并逐步断言几何关系（提示框不越界、不压坐标轴标签/图例，
高亮在绘图区内）。新增交互能力时请同步补一步，否则这个门禁覆盖不到新路径。

## 视觉基调

- 默认主题 = **Bootstrap 5**（`src/theme/chartTheme.ts` 的 `BOOTSTRAP_TOKENS`）。
  新增组件取色一律从主题里取，不要写死色值；示例页 CSS 也用 Bootstrap 变量。
- 提示框 / 准星标签的摆放有硬性约束（见上一条审计）：**不许越出画布、不许压住坐标轴标签与图例**。
  改 `Tooltip.doRender` 的定位逻辑时务必重跑审计。
- 标签防重叠的既定策略：内部标签按相邻角度逐级外推半径，弧长放不下就不画（交给图例 + 提示框）；
  桑基节点名用白色描边保证压在连线上也可读。

## 已实现 / 未实现

已实现：直角坐标 / 极坐标（饼图、玫瑰图）/ 雷达图 / 桑基图；多 y 轴；dataZoom 滑块；
LTTB 降采样；无障碍数据表镜像；K 线、热力图。

仍未实现（改动前先确认是否要做）：

- 桑基节点拖拽重排与折叠；
- 数据 append 的增量绘制（现在是全量重建像素缓存）；
- y 方向的 dataZoom 滑块（`setAxisDomain` 可用，缺 UI）；
- 地图 / 力导向关系图（属于另一类布局）。

## 坐标系与场景约定（多场景后新增，改动坐标系前必读）

- `norm.kind` 是场景判据：`cartesian` / `polar`（饼图）/ `radar` / `sankey`。
  新增图形类型时先确定它属于哪个场景，再决定布局分支（`computeLayout`）。
- **组件盒的坐标系故意不统一**：
  - 系列组件（含饼图 / 雷达）的盒 = 该场景的绘图区（极坐标是圆的外接正方形），
    本地坐标 = 图表坐标 − `plot.x/plot.y`；
  - 覆盖层与网格类组件（Axis / RadarGrid / Legend / Tooltip / DataZoomSlider）的盒 = 整块画布，
    本地坐标**就是**图表坐标，**不要**再减 `plot`。
  这条踩过坑：RadarGrid 多减了一次 `plot`，整张网格偏移到左上角。
- **类目轴的缩放窗口必须切成类目区间**（数组 slice），不能赋成 `[起始类目, 结束类目]` 两个值 ——
  否则 N 个类目的轴会塌缩成 2 个类目（K 线蜡烛突然变宽就是它暴露的）。
- 屏幕坐标向下的轴（y 轴 range = `[height, 0]`）里画 band 类矩形时，
  band 是**从起点向上**延伸的：`y = bandStart - bandHeight`。热力图曾因此整块落到绘图区之外。
- 非直角坐标场景不画坐标轴，`computeLayout` 也不为它们预留空间（否则饼图圆会小一圈）。
- **直角坐标系列必须 `clipToBox = true`**：数值/时间轴缩放后，窗口外的点会被线性外推到画布之外，
  不裁剪就会盖住坐标轴与图例（用户实测反馈）。折线要的是「被绘图区边缘裁掉」，
  而不是「在边界处断开」，所以只能裁剪、不能过滤点。
- **类目轴的定位一律用类目值，不要用数据下标**：可见窗口是类目的子集，下标语义会错位
  （柱子/高亮会画到坐标轴上）。`BandScale.indexOf` 里也**不允许**再退回「把数值当类目下标」。
- 审计脚本的缩放步骤必须用**放大**（`deltaY < 0`）：满窗口时缩小是空操作，
  会让人误以为「缩放没问题」——这个盲区真实存在过。
