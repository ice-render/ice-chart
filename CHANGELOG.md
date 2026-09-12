# Changelog

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
