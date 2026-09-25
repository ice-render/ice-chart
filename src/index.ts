/**
 * ice-chart —— 构建在 ice-render 之上的交互式图表库。
 *
 * 与「把数据画成图」的图表库不同，ice-chart 把 ice-render 的事件系统、命中测试、
 * 嵌套坐标系与脏矩形局部重绘当作一等能力：悬停、点击下钻、框选、缩放平移、
 * 图例联动、跨图联动、键盘导航都是内建能力。
 */

// 图表主类
export {
  ICEChart,
  createChart,
  computeBarSlots,
  isChartSnapshot,
  mergeOptionPatch,
  SNAPSHOT_VERSION,
  setMotionPreference,
  getMotionPreference,
  shouldAnimate,
} from './ICEChart';
export type {
  ICEChartOptions,
  ApplyOptionOptions,
  ChartSnapshot,
  SnapshotRestoreOptions,
  MotionPreference,
} from './ICEChart';

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
  AnnotationOption,
  AnnotationLineOption,
  AnnotationPointOption,
  AnnotationAreaOption,
  AnnotationAxis,
  AnnotationTextPosition,
  AnnotationPointTextPosition,
  AnnotationDiagnostic,
  AnnotationDiagnosticCode,
  GridOption,
  DataZoomOption,
  InteractionOption,
  AnimationOption,
  AnimationStageOption,
  DataPointParams,
  BrushRange,
  ZoomRange,
  LegendToggleParams,
  DataItem,
  SweepOption,
  LiquidOption,
  PolarGridOption,
} from './types';

// 主题
export {
  LIGHT_CHART_THEME,
  DARK_CHART_THEME,
  BOOTSTRAP_CHART_THEME,
  BOOTSTRAP_DARK_CHART_THEME,
  BOOTSTRAP_TOKENS,
  resolveChartTheme,
} from './theme/chartTheme';
// 图表主题 → 引擎主题（引擎 2.4 起）：图表实例里引擎自己画的那层跟着图表主题走
export { chartThemeToEnginePatch, applyChartThemeToEngine } from './theme/chartEngineBridge';

// 比例尺
export { createScale, formatTick, formatNumberTick, LinearScale, BandScale, TimeScale, LogScale } from './scale';
export type { Scale, CreateScaleOptions } from './scale';

// 归一化 / 布局（纯函数，便于在应用层复用或做 DSL 编译）
export {
  normalizeOption,
  toSerializableOption,
  normalizeAnimation,
  normalizeAnnotation,
  DEFAULT_ANIMATION_STAGES,
} from './option/normalize';
export type { NormalizeContext } from './option/normalize';
export { computeLayout } from './layout/layout';
export type { DataPoint, InternalSeries, InternalAxis, NormalizedOption, ChartLayout, Rect, LegendItemLayout } from './internal';

// 组件（高级用法：自定义系列 / 自定义覆盖层）
export { ChartComponent } from './components/ChartComponent';
export { PlotArea } from './components/PlotArea';
export { GridLines } from './components/GridLines';
export { Annotation } from './components/Annotation';
export type { AnnotationInk } from './components/Annotation';
export { resolveAnnotation } from './annotation/resolve';
export type { ResolvedAnnotation, ResolvedLine, ResolvedPoint, ResolvedArea, AnnotationContext } from './annotation/resolve';
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
export { HeatmapSeries, mixColors } from './components/series/HeatmapSeries';
export { HexbinSeries } from './components/series/HexbinSeries';
export { CalendarSeries } from './components/series/CalendarSeries';
export { AlluvialSeries } from './components/series/AlluvialSeries';
export { SankeySeries } from './components/series/SankeySeries';
export type { SankeySeriesCoord } from './components/series/SankeySeries';
export { FunnelSeries } from './components/series/FunnelSeries';
export type { FunnelSeriesCoord } from './components/series/FunnelSeries';
export { GaugeSeries } from './components/series/GaugeSeries';
export type { GaugeSeriesCoord } from './components/series/GaugeSeries';
export { BoxplotSeries } from './components/series/BoxplotSeries';
export { ViolinSeries } from './components/series/ViolinSeries';
export { BeeswarmSeries } from './components/series/BeeswarmSeries';
export { WaterfallSeries } from './components/series/WaterfallSeries';
export { TreemapSeries } from './components/series/TreemapSeries';
export type { TreemapSeriesCoord } from './components/series/TreemapSeries';
export { layoutTreemap } from './layout/treemap';
export type { TreemapNodeLayout, TreemapInputNode } from './layout/treemap';
export { GraphSeries } from './components/series/GraphSeries';
export type { GraphSeriesCoord } from './components/series/GraphSeries';
export { CurveSeriesBase } from './components/series/CurveSeriesBase';
export { FunctionSeries } from './components/series/FunctionSeries';
export { ParametricSeries } from './components/series/ParametricSeries';
export { LiquidSeries } from './components/series/LiquidSeries';
export type { LiquidSeriesCoord } from './components/series/LiquidSeries';
// 表达式引擎（纯函数，可单独使用：表单校验、DSL 编译、参数扫描都靠它）
export { compileExpression, compileSampler, evaluateExpression, ExpressionError } from './expr/expr';
export type { CompiledExpression, CompiledSampler, ExpressionErrorCode } from './expr/expr';
export { diagnoseExpression, errorsOf, warningsOf } from './expr/diagnostics';
export type { ExpressionDiagnostic, ExpressionDiagnosticCode, DiagnoseExpressionOptions } from './expr/diagnostics';
export { sampleFunctionCurve, sampleParametricCurve, robustRange } from './expr/sample';
export type { CurvePoint, SampleOptions } from './expr/sample';
export { forceLayout, sampleGraphLink } from './layout/force';
export type { ForceNodeLayout, ForceLinkLayout, ForceLayoutResult } from './layout/force';
export { computeBoxplotSummary } from './option/normalize';
export { layoutSankey, sampleLinkPath } from './layout/sankey';
export type { SankeyNodeLayout, SankeyLinkLayout, SankeyLayoutResult } from './layout/sankey';
export { RadarGrid } from './components/RadarGrid';
export type { RadarGridCoord } from './components/RadarGrid';
// 系列类型注册表：图表不是封闭渲染器，任何 SeriesBase 子类都能作为一等系列接进来
export {
  createSeriesComponent,
  registerSeriesType,
  unregisterSeriesType,
  getSeriesTypeFactory,
  listSeriesTypes,
  isBuiltinSeriesType,
  clearCustomSeriesTypes,
} from './components/series/createSeries';
export type { SeriesFactory, SeriesComponentProps } from './components/series/createSeries';

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
