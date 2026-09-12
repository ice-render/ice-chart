# ICEChart · 交互式图表库

构建在 [ice-render](https://gitee.com/ice-render/ice-render) Canvas 引擎之上的**交互式图表库**。

它不是「把数据画成图」的又一个图表库 —— 命中测试、事件派发、嵌套坐标系、脏矩形局部重绘
全部交给 ice-render 引擎，图表层只负责把「数据 ↔ 像素 ↔ 语义事件」这三件事打通。
于是悬停、点击下钻、框选、缩放平移、图例联动、跨图联动、键盘导航都是**内建能力**，
而不是事后打补丁的插件。

```ts
import { createChart } from 'ice-chart';

const chart = createChart('canvas-id', {
  title: { text: '近 30 天流量' },
  tooltip: { trigger: 'axis' },
  interaction: {
    hover: { enabled: true, dimOthers: true },
    select: { enabled: true, mode: 'multiple' },
    brush: { enabled: true, axes: 'x', mode: 'zoom' },
    zoom: { enabled: true, axes: 'x', wheel: true },
    pan: { enabled: true, axes: 'x' },
    keyboard: true,
  },
  xAxis: { type: 'category' },
  yAxis: { name: '访问量' },
  series: [
    { id: 'pv', type: 'line', name: '访问量', data: [820, 932, 901, 1290] },
    { id: 'uv', type: 'area', name: '独立访客', data: [320, 402, 391, 520] },
  ],
});

chart.on('item:click', (params) => {
  console.log(params.seriesName, params.xValue, params.value, params.data);
});
```

## 设计原则

**0. 视觉基调是 Bootstrap**

默认主题直接取 Bootstrap 5 的调色板与设计变量（primary / success / danger / warning / info、
gray-100~900、`--bs-border-radius`、`--bs-body-font-family`），图表放进 Bootstrap 页面里
与按钮、卡片、表格是同一套视觉语言。需要换品牌色时用 `theme: { colorPalette: [...] }` 覆盖即可，
或直接改 `BOOTSTRAP_TOKENS` 派生自己的主题。

**1. 交互是一等公民，命中判定写进组件**

每个系列组件都实现 `containsLocalPoint`：把组件本地坐标翻译成数据语义（离折线多近、落在哪根柱子里），
于是引擎的 `ice.hitTest()` / 事件派发**天然就认识数据点**，不需要在图表外面再写一套坐标反查。
代价是 0 —— 这套判定本来就写在同一个类里，还顺带复用了「画出来是什么样」的像素缓存。

**2. 像素缓存是渲染与命中的唯一事实来源**

`rebuildPixels()` 在数据 / 比例尺 / 尺寸变化时重算一次点集，`render()` 与 `hitTestIndex()` 消费同一份缓存。
「看得见的点」与「点得到的点」因此不可能漂移。

**3. 交互的视觉反馈是独立小组件**

鼠标在数据点上移动时，只有 `Highlight` / `Crosshair` / `Tooltip` 这三个覆盖层变脏，
脏矩形就是标记环那一小块像素 —— 折线与柱形完全不动。压暗其他系列只在「悬停系列变了」时
写一次 state，不会每帧把所有系列置脏。

**4. 声明式 spec 可序列化**

`ChartOption` 是纯 JSON（函数字段仅限 formatter），`chart.toJSON()` / `fromJSONString()` 可存盘、可进 DSL。
归一化（`normalizeOption`）与布局（`computeLayout`）都是**纯函数**，不依赖 DOM / ctx，可被完整单测。

**5. 跨图联动按数据值而不是像素**

`linkCharts()` 只用公开语义事件，并通过 `fractionOf / valueAtFraction` 这类**数据域比例**对齐，
不同尺寸、不同数据范围的图表也能联动。

## 能力清单

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 系列类型 | line / area / bar（含横向）/ scatter（含气泡）/ pie（含环形、玫瑰）/ radar / candlestick / heatmap / sankey / funnel / gauge / boxplot / waterfall / treemap / graph | 见下方「图表类型与写法」 |
| 比例尺 | linear / category / time / log | time 轴按跨度自动切换毫秒~年粒度 |
| 坐标系 | 直角坐标 / 极坐标（饼图） / 雷达 / 桑基图 | 按系列类型自动切换场景 |
| 坐标轴 | x + **多 y 轴**（左右可配） | 刻度、网格、轴名、标签旋转与自动抽稀、自定义 formatter |
| 图例 | top / bottom / left / right | **可点击切换系列 / 扇区显隐**并重算数据域 |
| 提示框 | axis / item 触发器 | 画在画布内（小程序同样可用）；K 线给 OHLC、桑基给流量 |
| 十字准星 | x / y / xy | 带坐标轴数值标签 |
| 悬停高亮 | 圆环 / 柱形描边 | 可配置 `dimOthers` 压暗其他系列 |
| 选中 | single / multiple | 点击或键盘 Enter，抛出 `select:change` |
| 框选 | x / y / xy，select / zoom 两种模式 | 拖拽出选区，实时抛 `brush:change` |
| 缩放 | 滚轮（data / viewport 两种模式） | 以指针位置为锚点，可配置 `minSpan / maxSpan` |
| 平移 | 拖拽 | 自动约束在完整数据域内 |
| 键盘导航 | ←/→ 移动数据点，↑/↓ 切换系列 | Enter 选中，Esc 清空；只由最后激活的图表响应 |
| 跨图联动 | hover / zoom / brush | `linkCharts([a, b])`，按 x 数据值对齐 |
| 动画 | 进入与数据更新 | 走引擎的 `AnimationManager`（`state.progress` 驱动） |
| 主题 | light / dark / 自定义片段 | 默认色板取自 ice-render 的设计 token |
| 大数据 | LTTB 降采样 + 二分命中 | 5 万点 × 3 系列构建 35ms，每条曲线只绘制约 2 点/像素 |
| 无障碍 | 数据表镜像 + aria-live 播报 | `attachA11yMirror()` / `getDataTable()` / `getA11yTree()` |
| 序列化 | `toJSON` / `fromJSONString` | 配置 + 缩放窗口 + 图例显隐状态 |

## 安装

```bash
npm install ice-chart ice-render
```

`ice-render` 是 peer 依赖：一个页面上多张图共用同一个引擎实例池，跨图联动才有统一的事件语义。

浏览器直接引入（UMD）：

```html
<canvas id="chart" width="960" height="420"></canvas>
<script src="./ice-render.umd.js"></script>
<script src="./ice-chart.umd.js"></script>
<script>
  const chart = ICEChart.createChart('chart', { series: [{ type: 'line', data: [1, 3, 2] }] });
</script>
```

## 事件

所有事件都通过 `chart.on(name, handler)` 订阅：

| 事件 | 载荷 | 触发时机 |
| --- | --- | --- |
| `item:hover` | `DataPointParams` | 悬停数据点 / 数据列（axis 触发器取该列第一个点） |
| `item:leave` | — | 离开数据 |
| `item:click` | `DataPointParams` | 点击数据点（下钻的入口） |
| `item:dblclick` | `DataPointParams` | 双击数据点 |
| `plot:click` | `{ screen, xValue, yValue }` | 点击绘图区空白处 |
| `chart:click` | `{ screen }` | 点击画布（绘图区之外） |
| `select:change` | `DataPointParams[]` | 选中集合变化 |
| `brush:change` | `BrushRange \| null` | 框选拖动中（实时） |
| `brush:end` | `BrushRange \| null` | 框选结束 |
| `zoom:change` | `ZoomRange` | 缩放 / 框选缩放的窗口变化 |
| `pan:change` | `ZoomRange` | 拖拽平移 |
| `legend:toggle` | `LegendToggleParams` | 图例切换系列 |

`DataPointParams` 同时携带 `dataIndex / xValue / value / data`（原始数据项）与 `screen` 像素坐标，
业务层做下钻、联动、埋点都不需要再碰比例尺。

## 图表类型与写法

每种类型都是「声明式 option + 相同的交互语义」，切换类型只需要改 `series[].type`。

| 类型 | 关键写法 | 说明 |
| --- | --- | --- |
| `line` / `area` | `data: [1, 2, 3]` 或 `[[x, y]]` | 平滑曲线 `smooth`、断点（`null` 断开）、面积 `areaOpacity` |
| `bar` | 类目在 x（默认） | 分组（多系列）与堆叠（同 `stack` 名） |
| `bar`（横向） | `yAxis: { type: 'category', data: [...] }` + `xAxis: { type: 'value' }` | 排行榜；类目也可写在数据项的 `name` 上 |
| `scatter` | `data: [[x, y, size]]` + `symbolSizeRange` | 第三维映射成直径即气泡图；`symbolSize` 也可传函数 |
| `pie` | `data: [{ name, value }]` | `innerRadius` 出环形，`roseType` 出玫瑰图；扇区可点图例隐藏 |
| `radar` | `radar.indicators` + `data: [数值...]` | 一个系列一个多边形，顶点命中 |
| `candlestick` | `data: [[open, close, low, high]]` | 影线进数据域，提示框给 OHLC |
| `boxplot` | `data: [[min, Q1, median, Q3, max]]` 或一串原始观测值 | 后者自动算五数概括；命中覆盖整条须 |
| `heatmap` | `data: [[x类目, y类目, 数值]]` | y 轴自动变类目轴，颜色线性插值 |
| `waterfall` | `data: [{ name, value }]`，合计项标 `total: true` | 增/减/合计三色 + 连接虚线 |
| `funnel` | `data: [{ name, value }]` | 阶段梯形、`minSize` 保护最小阶段、图例按阶段显隐 |
| `gauge` | `gauge: { min, max, axisLineColor }` + `data: [{ name, value }]` | 指针随数值转动，轴线按阈值分段配色 |
| `sankey` | `sankey: { nodes, links }` | 分层 + 纵向松弛布局，节点/连线分别命中 |
| `treemap` | `data: [{ name, value, children }]` | squarified 布局，父节点留标题带；命中返回最深节点 |
| `graph` | `graph: { nodes, links }` | 力导向布局（无底图），节点可拖拽重排；按分类配色、按权重定大小 |

## 动画

默认播**入场动画**（首次渲染就会播，不是只有更新才播）。`animation` 分三段，每段可单独配置或用 `false` 关掉：

```ts
animation: {
  enter:     { duration: 900, easing: 'easeOutCubic', stagger: 0.45 },  // 首次渲染 / 新增系列
  update:    { duration: 700, easing: 'easeOutCubic' },                 // setData / setOption
  highlight: { duration: 260, easing: 'springSnappy' },                 // 悬停反馈（预留）
}
```

- **错峰 `stagger`**：把入场拆成波浪（队列靠前的数据项先动），所有项仍在同一时刻结束。
- **缓动**直接用引擎的曲线名：`linear`、`easeIn*/easeOut*/easeInOut*`（Quad / Cubic / Quart）以及三条**解析弹簧**
  `spring` / `springSoft` / `springSnappy` —— 仪表盘指针、气泡弹出、交互反馈用它们最自然。
- 兼容扁平写法：`animation: { duration, easing, stagger }` 等价于配置 `enter`。
- **动效偏好**（无障碍）：`ICEChart.setMotionPreference('instant')` 让所有动画瞬时到位；
  `'auto'`（默认）跟随系统的 `prefers-reduced-motion`；`'full'` 始终播动画。
  `chart.finishAnimations()` 可把当前动画一次性推到终态（截图 / 测试用）。

各类型的入场形态：柱形从基线错峰长出、折线/面积从左到右画出来、气泡依次弹出、
饼图/玫瑰图扇形依次扫开、雷达从中心展开、K 线从开盘价上下展开、箱线图从中位线展开、
热力图沿对角线逐格浮现、漏斗从等宽收拢成漏斗、仪表盘指针扫到目标值（可配弹簧回弹）、
桑基连线从源流向目标、矩形树图逐层展开、关系图从环形铺开**收敛到力布局结果**。

数据更新时，系列的值会从旧值插值到新值，**坐标轴数据域也跟着一起过渡**（否则域瞬跳会让图形先蹦一下再动）。

## 主要 API

```ts
const chart = createChart(canvasOrId, option, { renderMode: 'dirty-rect', dpr: 2, autoResize: true });

chart.setOption(nextOption);              // 保留当前缩放窗口
chart.setData('series-id', nextData);     // 只更新一个系列的数据（原地更新，不重建组件）
chart.setDomain('x', [100, 300]);         // 设置数据域（缩放 / 联动）
chart.resetZoom();                        // 恢复完整数据域
chart.toggleSeries('series-id', true);    // 显隐系列
chart.showHoverAt('series-id', 12);       // 程序化高亮某个数据点
chart.showHoverAtValue(xValue);           // 按 x 数据值高亮（跨图联动入口）
chart.resize(960, 420);                   // 手动重排
chart.toJSON() / fromJSONString(json);    // 序列化
await chart.render();                     // 等待下一帧渲染完成（截图 / 测试用）
chart.destroy();
```

## 架构

### 序列化：持久化的单位是 option 快照，不是组件树

- `chart.toJSON()` 产出 `{ version, option, view, hidden, hiddenSlices }`：
  option 是声明式规格（**唯一事实来源**），view 是缩放窗口，hidden / hiddenSlices 是图例与扇区显隐。
- `chart.fromJSONObject(snapshot)` / `fromJSONString(json)` 原地重建；
  `ICEChart.restore(canvas, snapshot)`、或 `createChart(canvas, snapshot)`（识别到快照自动走还原）
  用于在新画布上重建。
- 往返**无损且幂等**：还原后再导出，JSON 与原文逐字节一致；浏览器里两张画布
  `toDataURL()` 也完全一致（`examples/serialize.html` 现场做这个比对）。
- 函数字段（`formatter` 等）进不了 JSON，导出时被丢弃，还原时用 `optionPatch` 补回来：

```ts
const chart = ICEChart.restore('canvas-2', json, {
  optionPatch: {
    tooltip: { formatter: (p) => `${p.xValue} → ${p.items[0].value}` },
    series: [{ id: 'visits', label: { formatter: (p) => `${p.name} ${p.percent}%` } }],
  },
});
```

**为什么不用引擎的组件树？** `ice.toJSONString()` 确实能存下组件树（几何 + 样式），
但组件树是 option 的**渲染投影**：没有比例尺、数据点、命中缓存这些语义，
反序列化回来只是一棵空壳（未注册类型会被整段跳过）。所以 ice-chart 刻意让
「规格 → 组件树」保持单向编译，持久化只认规格。

```ts
const json = chart.toJSONString();               // 导出：纯数据，KB 级别
const restored = createChart('canvas-2', json);  // 还原：语义 / 窗口 / 显隐全部一致
```

```
            ChartOption（纯 JSON）
                    │  normalizeOption()   纯函数：数据点 / 数据域 / 堆叠
                    ▼
            NormalizedOption
                    │  computeLayout()     纯函数：标题 / 图例 / 坐标轴 / 绘图区
                    ▼
              ChartLayout
                    │  ICEChart 编译成 ice-render 组件树
                    ▼
  ┌──────────────────────────────────────────────────────┐
  │ ICEGroup(root)                                       │
  │  ├ PlotArea      绘图区背景 + 空白处交互面            │
  │  ├ GridLines     网格线                              │
  │  ├ LineSeries / BarSeries / PieSeries / RadarSeries / CandlestickSeries / ...  ← containsLocalPoint 即数据命中判定
  │  ├ Axis × N      坐标轴（多 y 轴）                   │
  │  ├ RadarGrid     雷达网格（仅雷达场景）              │
  │  ├ Title / Legend                                    │
  │  ├ Crosshair / Highlight / Brush / Tooltip  覆盖层     │
  │  └ DataZoomSlider  缩放滑块                          │
  └──────────────────────────────────────────────────────┘
                    │  ice.hitTest() → 组件 → 数据下标
                    ▼
            InteractionController  → 语义事件（item:hover / brush:end / ...）
```

## 示例

```bash
npm run build && npm run examples:prepare
npm run examples:serve      # http://localhost:5177
```

示例页面覆盖：基础折线 / 面积、分组与堆叠柱形、多 y 轴叠加、饼图 / 环形图 / 玫瑰图、雷达图、
K 线与热力图、桑基图、交互总览（框选 + 多选 + 键盘 + 事件日志）、时间轴 + dataZoom 滑块、
大数据量（5 万点降采样）、无障碍、跨图联动。

每个示例页在图表下方都有两块面板：

- **序列化 JSON**（`examples/assets/snapshot-panel.js`）：实时显示 `chart.toJSON()` 的**真实内容**，
  带语法高亮、版本 / 体积 / 系列数 / 更新时间，以及 刷新 / 复制 / 下载 按钮。
  缩放、平移、图例切换后自动刷新（150ms 防抖）。多图页面提供图表切换 tab；
  超大快照（如 5 万点的 3.7 MB）只美化显示截断后的预览，复制 / 下载仍是完整内容。
- **事件日志**：把 `item:hover` / `brush:end` / `zoom:change` 等语义事件打出来。

## 开发

```bash
npm test              # jest（纯函数单测 + 真实引擎集成的 jsdom 测试）
npm run types:check   # tsc --noEmit
npm run build         # ESM + CJS + UMD + .d.ts/.d.mts
npm run verify        # lint → types:check → build → test
```

交互外观审计（需要浏览器）：

```bash
npm run build && npm run examples:prepare
node scripts/serve-examples.cjs &
npm run audit:interactions -- ./.audit      # 12 页 × 10 步交互，逐步截图 + 几何断言
```

审计会检查每一步之后：提示框是否越出画布、是否压住坐标轴数值标签或图例、
高亮标记是否落在绘图区内；任何一条不满足就以非 0 退出码结束，可用于 CI。

测试用例覆盖的关键路径：比例尺换算、数据归一化与堆叠、布局量测、系列命中判定，
以及「引擎命中测试 → 数据下标 → 语义事件」这条端到端链路（含多图隔离与联动回归）。

## 路线图

已落地：极坐标（饼图 / 玫瑰图）、雷达图、多 y 轴、dataZoom 滑块、LTTB 降采样与二分命中、
无障碍（数据表镜像 + 播报）、K 线、热力图、桑基图。

后续候选：

- 桑基节点拖拽重排与折叠（布局已与渲染解耦，扩展成本低）
- 数据 append 的增量绘制（当前是全量重建像素缓存）
- y 轴方向的 dataZoom 滑块（`setAxisDomain` 已可用，缺 UI）
- 地图 / 力导向关系图（属于另一类布局族）

## License

MIT
