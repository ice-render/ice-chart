# Changelog

## 0.8.0

新增力导向关系图（无底图）。

### 新增

- **`type: 'graph'`**：节点 + 连线 + 力学布局，不依赖任何底图。
  - 布局是纯函数 `forceLayout`：斥力（∝1/d²）+ 弹力（沿连线）+ 向心力，带冷却与阻尼；
    迭代结束后按包围盒**等比铺满绘图区**（否则力布局常挤在中间一小块）。
  - 初始位置用**环形均匀铺开而不是随机** —— 结果可复现、可写断言，同一份数据每次渲染一致。
  - 节点按权重定大小（面积映射，避免大权重夸张）、按分类/颜色配色；连线按流量定粗细，可选曲线。
  - **节点可拖拽重排**：按住节点跟手移动，松手后跑少量迭代让邻居跟随（被拖的节点保持固定）。
  - 命中返回节点下标或 `节点数 + 连线下标`（与桑基图同一约定）；提示框给权重/连接数、连线给两端与流量。
  - `layout: 'circular' | 'none'` 也支持：环形布局，或直接用给定坐标（不动力学）。

### 示例与门禁

- 新增 `graph.html`（微服务依赖图，15 节点 / 20 连线，可拖拽重排）；
  交互审计扩展到 18 页 / 198 步（当前 0 问题），23 个测试套件 / 217 个用例全绿。

## 0.7.0

补齐「构成类」图表：矩形树图。

### 新增

- **矩形树图**（`type: 'treemap'`）：层级数据（`{ name, value, children }`）用嵌套矩形表达构成。
  布局是纯函数 `layoutTreemap`，采用 **squarified** 算法（每行尽量接近正方形，避免细长切片）；
  父节点自动留出标题带，标签画在左上角而不是压在子矩形上；子节点颜色在父色基础上按层级淡化。
  命中判定返回**最深的那个节点**（点在大类目里的小类目上命中的是小类目），提示框给名称 / 数值 / 占根总量比例。

### 示例与门禁

- 新增 `treemap.html` 示例；交互审计扩展到 17 页（当前 0 问题），22 个测试套件 / 206 个用例全绿。

## 0.6.0

继续补齐常见图表类型：横向柱状图、气泡图、漏斗图、仪表盘、箱线图、瀑布图。

### 新增

- **横向柱状图**：`yAxis` 声明为类目轴（`type: 'category'` 或 `data: [...]`）、`xAxis` 为数值轴即自动转置，
  与 ECharts 写法一致。支持轴声明类目（按下标回填数据点）与对象数据的 `name`；
  横向图默认 `tooltip.trigger: 'item'` 并收起十字准星，提示框标题用类目、数值走 x 轴格式化。
  同时兼容 `type: 'value'` 这个 ECharts 数值轴别名。
- **气泡图**：`scatter` 的第三维 `[x, y, size]` 经 `symbolSizeRange`（默认 `[8, 40]`）映射成直径；
  `symbolSize` 也支持函数形式。尺寸解析统一收敛到 `SeriesBase.symbolSizeAt()`。
- **漏斗图**：阶段按数值排序、相邻阶段画梯形（`trapezoid: false` 退化为矩形）、
  `minSize` 保证最小阶段仍可见可点；图例项是「阶段」，复用扇区显隐机制。
- **仪表盘**：角度沿用 ECharts 习惯（0° = 3 点、逆时针为正、90° = 12 点），默认 225° → -45° 扫 270°；
  轴线按阈值分段配色、刻度与刻度值、指针（可配宽度/长度）、数值文本与名称。
- **箱线图**：`[min, Q1, median, Q3, max]`，或给原始观测值自动算五数概括（`computeBoxplotSummary`）；
  须的末端进 y 轴数据域，命中判定覆盖整条须。
- **瀑布图**：`base/top` 由累计值推导，合计项（`total: true`）从 0 画到累计值且不改变累计；
  增 / 减 / 合计三色可配，柱子之间画连接虚线。

### 变更

- `hiddenSlices` / `setHiddenSlices` 上提到 `SeriesBase`（饼图与漏斗图共用）。
- 柱形的像素锚点统一为「柱心」，并新增 `barColorAt()` / `highlightRectAt()` 两个扩展点。
- 新增 `data:change` 事件（`setData` 后触发），示例页的 JSON 面板会跟随刷新。

### 修复

- 横向柱状图的槽位偏移没有跟随 y 轴 range 方向，导致最下方那根柱子越过绘图区底边（像素探针定位）。
- 柱形按数据下标定位类目、`BandScale` 的数值兜底把数值类目当下标（缩放后柱子锚错位置）。

### 示例与门禁

- 新增 `horizontal-bubble.html`、`funnel-gauge.html`、`boxplot-waterfall.html` 三个示例页；
  交互审计扩展到 16 页 / 176 步，当前 0 问题；21 个测试套件 / 197 个用例全绿。

## 0.5.0

每个示例页新增「序列化 JSON」面板，实时显示图表的真实快照。

### 新增

- `examples/assets/snapshot-panel.js`（`mountSnapshotPanel()`）：把 `chart.toJSON()` 的真实内容
  渲染成带语法高亮的 JSON 面板，含版本 / 体积 / 系列数 / 更新时间与 刷新 / 复制 / 下载。
  订阅 `zoom:change` / `pan:change` / `legend:toggle` 自动刷新（150ms 防抖）；
  多图页面（柱形堆叠、饼图、雷达、K 线+热力图、联动、序列化）提供图表切换 tab。
- 大负载保护：5 万点的完整快照 3.7 MB / 11 MB（美化），面板改为
  「截断长数组的预览 + 完整内容供复制下载」，并标明两者体积。
- 交互审计新增面板检查：每个示例页必须存在可解析且带 `version` / `option` 的快照。

## 0.4.0

把「图表可序列化 / 可反序列化」做成显式契约，并给出可复现的证据。

### 新增

- `chart.toJSON()` 增加 `version`；新增 `ChartSnapshot` / `SnapshotRestoreOptions` 类型。
- `ICEChart.restore(target, snapshot, options)`；`createChart(target, snapshotOrJson)`
  现在能直接吃快照（自动识别并走还原路径）。
- `fromJSONObject(snapshot, { optionPatch })`：还原时补回无法进 JSON 的函数字段（formatter 等），
  series 按 id 或下标逐项合并，不覆盖快照里的数据。
- `chart.toDataURL()` / `chart.toBlob()`：透传引擎的图片导出能力。
- 导出 `isChartSnapshot` / `mergeOptionPatch` / `SNAPSHOT_VERSION`。
- `examples/serialize.html`：导出 → 还原 → **逐像素比对**，并显示快照体积与摘要。

### 证据

- 7 种场景（直角坐标 / 多 y 轴 / 饼图 / 雷达 / K 线 / 热力图 / 桑基）导出再还原后语义一致，
  且再导出的 JSON 与原文逐字节相同（幂等）。
- 浏览器实测：缩放窗口 `[8,20]` + 隐藏系列后还原，两张画布 `toDataURL()` **完全一致**。
- 明确记录设计边界：`ice.toJSONString()` 的组件树**不是**图表持久化格式
  （实测还原后 `unknownTypes` 列出全部 chart 组件、只落地一个根节点）。

### 修复

- `mergeOptionPatch` 里「带 id 的补丁在下标不匹配时退化按下标合并」会把快照的 A 系列
  改名成 B（已补回归用例）。

## 0.3.0

### 修复：图形越出坐标轴（用户实测反馈）

- **系列绘制未裁剪到绘图区**：数值轴/时间轴缩放后，窗口外的数据点会被线性外推到画布之外，
  墨迹一路盖住 y 轴刻度、图例与坐标轴。现在所有直角坐标系列在 `beginDraw()` 里裁剪到自身盒
  （= 绘图区）。实测大数据页：缩放后 y 轴标签区的彩色墨点由 **2554 → 0**。
- **柱形按「数据下标」定位类目**：类目轴缩放后可见窗口是类目的子集，用下标会被当成窗口内位置，
  把窗口外的柱子（及其高亮框）画到坐标轴上。改为按类目值定位。
- **`BandScale` 的「数值兜底」**：把数值类目当成下标，数值类目轴缩放后柱子会锚到错误类目上。
  该兜底本就被字符串比较覆盖，已删除。

### 审计脚本自身的盲区

- 缩放审计步骤用的是 `wheel(0, 200)`（缩小），在满窗口时是空操作，因此从没真正测到缩放后的画面。
  现改为放大 4 档，并新增**像素级越界检查**：统计左右轴标签带与坐标轴标签带里的「饱和色墨迹」，
  任何一条超过阈值即判失败（图例色块与 dataZoom 滑块分别在绘图区上方/下方，已被排除）。

视觉改为 Bootstrap 风格，并把「交互过程中的外观」变成可自动断言的门禁。

### 变更

- **默认主题换成 Bootstrap 5**：系列色序取 primary / success / danger / info / indigo /
  warning / orange / teal / pink / secondary，坐标轴与网格用 gray-100~900，
  字体用 Bootstrap 的 `--bs-body-font-family`，提示框圆角用 `--bs-border-radius`。
  新增 `BOOTSTRAP_CHART_THEME` / `BOOTSTRAP_DARK_CHART_THEME` / `BOOTSTRAP_TOKENS` 导出，
  旧的 `LIGHT_CHART_THEME` / `DARK_CHART_THEME` 保留为别名。
- 示例页样式对齐 Bootstrap 变量（字体、边框色、卡片圆角与阴影、链接色）。

### 修复（全部由「交互外观审计」发现）

- 缩放 / 平移 / 滑块拖动后，十字准星与高亮环停在旧像素位置、和曲线脱开 → 数据域变化后重新定位悬停。
- 键盘导航会走到**可见窗口之外**的数据点，准星被画到绘图区外、压住 y 轴刻度 → 只在窗口内移动，越界即清理。
- 提示框会压住十字准星的轴数值标签，贴底时还会压住坐标轴 → 纵向让开标签带、横向优先留在绘图区内。
- 隐藏正在悬停的系列后，提示框跳到别的系列（或留下残影）→ 立即清理。
- 框选 / 拖滑块期间提示框与准星跟着抖动 → 手势期间收起，松手后按指针位置恢复。
- 悬停图例项没有任何视觉反馈（高亮被自己的清理逻辑抹掉）。
- 高亮标记的锚点语义不一致（圆环是中心、柱形是左上角）→ 统一为中心。
- 玫瑰图小扇区的内部标签互相叠压 → 按相邻角度逐级外推，放不下就不画（交给图例与提示框）。
- 桑基节点名压在连线上不可读 → 加白色描边光晕。

### 新增

- `scripts/audit-interactions.mjs`（`npm run audit:interactions`）：对 12 个示例页跑 10 步真实交互
  （悬停 / 贴底悬停 / 边缘悬停 / 滚轮缩放 / 拖拽平移 / 框选 / 键盘 / 图例切换 / 切换后再悬停），
  每步截图并断言「提示框不越界、不压坐标轴标签、不压图例、高亮在绘图区内」。
- `tests/interaction/appearance.test.ts`：把同样的断言固化成 7 个 jsdom 用例。

## 0.2.0

把工具箱补齐到覆盖绝大多数业务图表，并补上大数据与无障碍。

### 新增

- **多 y 轴**：`yAxis` 支持数组，系列用 `yAxisIndex` 绑定；每个轴独立数据域与刻度，同侧多层外移；`setAxisDomain()` 按轴控制窗口。
- **极坐标与饼图**：`type: 'pie'`，支持环形（`innerRadius`）与玫瑰图（`roseType`）；扇形命中、引导线标签、按扇区的图例联动与百分比重算。
- **雷达图**：`radar.indicators` + `type: 'radar'`，支持多边形 / 圆形网格；顶点命中，提示框一次列出全部指标。
- **dataZoom 滑块**：轨道 / 窗口 / 双手柄，支持拖窗口、拖手柄、点轨道；比例窗口 ↔ 数据域的换算留在图表层。
- **大数据降采样**：折线 / 面积按 LTTB 抽稀（保留首尾与尖峰），命中判定用二分查找。
- **无障碍**：`getDataTable()` / `getA11yTree()` / `attachA11yMirror()`，视觉隐藏数据表 + `aria-describedby` + `aria-live` 播报。
- **K 线**：`type: 'candlestick'`，`[open, close, low, high]`，影线进入数据域，提示框给 OHLC。
- **热力图**：`type: 'heatmap'`，`[x类目, y类目, 数值]`，y 轴自动变类目轴，颜色线性插值。
- **桑基图**：`type: 'sankey'`，纯函数分层 + 纵向松弛布局，节点/连线分别命中。

### 修复

- 类目轴缩放会把坐标轴塌缩成两个类目（K 线蜡烛异常变宽即由此暴露）。
- 左右两侧图例的尺寸计算把 `0` 当作初始最小值，导致绘图区被挤成 20px。
- 同一页面上多张图的事件串扰：非本画布的指针事件会清掉镜像过来的悬停。
- `ICEEvent.preventDefault()` 在部分路径下抛 `Illegal invocation`。
- 自定义组件的 `doRender()` 未 `beginPath()`，把引擎脏矩形裁剪残留路径一起描了出来。
- `BandScale` 在倒置 range（y 轴）下带宽为负，热力图整块落到绘图区外。
- 雷达网格组件误减 `plot` 偏移导致整体错位。

## 0.1.0

首个版本：把 ice-render 的事件系统与交互能力带进图表场景。

### 新增

- `createChart` / `ICEChart`：把声明式 option 编译成 ice-render 组件树。
- 比例尺：linear / category（band）/ time / log，含 nice 刻度与自适应时间粒度。
- 系列：line / area / bar（分组 + 堆叠）/ scatter，支持平滑曲线、断点、虚线、渐变填充。
- 组件：PlotArea / GridLines / Axis / Title / Legend / Tooltip / Crosshair / Highlight / Brush。
- 交互：悬停（axis / item 触发器）、十字准星、压暗高亮、单选 / 多选、框选（select / zoom）、
  滚轮缩放（以指针为锚点）、拖拽平移（约束在完整数据域内）、键盘导航。
- 跨图联动 `linkCharts`：悬停 / 缩放 / 平移 / 框选按数据值对齐，并用 `silent()` 打断回环。
- 图例点击切换系列显隐并重算数据域；`toJSON` / `fromJSONString` 序列化。
- 主题：light / dark / 自定义片段，色板取自 ice-render 设计 token。
- 工具链：Rollup（ESM + CJS + UMD + .d.ts/.d.mts）、jest（jsdom + Canvas 2D 桩）、eslint、prettier。
- 示例：基础折线 / 面积、分组与堆叠柱形、交互总览、时间轴 + dataZoom、跨图联动。
