# Changelog

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
