/**
 * ice-chart —— 构建在 ice-render 之上的交互式图表库。
 *
 * 与「把数据画成图」的图表库不同，ice-chart 把 ice-render 的事件系统、命中测试、
 * 嵌套坐标系与脏矩形局部重绘当作一等能力：悬停、点击下钻、框选、缩放平移、
 * 图例联动、跨图联动、键盘导航都是内建能力。
 */

// 图表主类
export { ICEChart, createChart, computeBarSlots } from './ICEChart';
export type { ICEChartOptions, ApplyOptionOptions } from './ICEChart';

// 类型
export type {
  ChartOption,
  ChartEventName,
  ChartEventHandler,
  ChartEventPayloads,
  ChartTheme,
  ChartLinkOption,
  AxisOption,
  SeriesOption,
  SeriesType,
  ScaleType,
  LegendOption,
  TooltipOption,
  TooltipParams,
  CrosshairOption,
  GridOption,
  DataZoomOption,
  InteractionOption,
  AnimationOption,
  DataPointParams,
  BrushRange,
  ZoomRange,
  LegendToggleParams,
  DataItem,
} from './types';

// 主题
export { LIGHT_CHART_THEME, DARK_CHART_THEME, resolveChartTheme } from './theme/chartTheme';

// 比例尺
export { createScale, formatTick, formatNumberTick, LinearScale, BandScale, TimeScale, LogScale } from './scale';
export type { Scale, CreateScaleOptions } from './scale';

// 归一化 / 布局（纯函数，便于在应用层复用或做 DSL 编译）
export { normalizeOption, toSerializableOption } from './option/normalize';
export type { NormalizeContext } from './option/normalize';
export { computeLayout } from './layout/layout';
export type { DataPoint, InternalSeries, InternalAxis, NormalizedOption, ChartLayout, Rect, LegendItemLayout } from './internal';

// 组件（高级用法：自定义系列 / 自定义覆盖层）
export { ChartComponent } from './components/ChartComponent';
export { PlotArea } from './components/PlotArea';
export { GridLines } from './components/GridLines';
export { Axis } from './components/Axis';
export { Legend, roundRect } from './components/Legend';
export { Title } from './components/Title';
export { Tooltip } from './components/Tooltip';
export { Crosshair } from './components/Crosshair';
export { Highlight } from './components/Highlight';
export { Brush } from './components/Brush';
export { SeriesBase } from './components/series/SeriesBase';
export type { SeriesCoord, BarSlot } from './components/series/SeriesBase';
export { LineSeries } from './components/series/LineSeries';
export { AreaSeries } from './components/series/AreaSeries';
export { BarSeries } from './components/series/BarSeries';
export { ScatterSeries } from './components/series/ScatterSeries';
export { PieSeries } from './components/series/PieSeries';
export type { PolarSeriesCoord } from './components/series/PieSeries';
export { RadarSeries } from './components/series/RadarSeries';
export type { RadarSeriesCoord } from './components/series/RadarSeries';
export { CandlestickSeries } from './components/series/CandlestickSeries';
export { HeatmapSeries, mixColors } from './components/series/HeatmapSeries';
export { SankeySeries } from './components/series/SankeySeries';
export type { SankeySeriesCoord } from './components/series/SankeySeries';
export { layoutSankey, sampleLinkPath } from './layout/sankey';
export type { SankeyNodeLayout, SankeyLinkLayout, SankeyLayoutResult } from './layout/sankey';
export { RadarGrid } from './components/RadarGrid';
export type { RadarGridCoord } from './components/RadarGrid';
export { createSeriesComponent } from './components/series/createSeries';

// 交互
export { InteractionController } from './interaction/InteractionController';
export type { InteractionHost } from './interaction/InteractionController';
export { HitResolver } from './interaction/HitResolver';
export { linkCharts } from './interaction/ChartLink';
export type { ChartLinkHandle } from './interaction/ChartLink';

// 工具
export { Emitter } from './util/emitter';

// 无障碍
export { A11yMirror, buildDataTable, buildDataNodes, chartTitle, VISUALLY_HIDDEN_STYLE, SERIES_ROLE_HINT } from './a11y';
export type { DataTable, A11yDataNode, A11yTreeOptions, A11yChartLike } from './a11y';
