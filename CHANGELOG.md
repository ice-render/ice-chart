# Changelog

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
