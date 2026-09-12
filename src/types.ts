/**
 * ice-chart 的公开类型定义。
 *
 * 设计约束：`ChartOption` 必须是**纯 JSON 可序列化**的（函数字段除外，例如 formatter），
 * 这样图表配置才能存盘、进 DSL、走 undo/redo。运行时派生的一切（比例尺、像素坐标、
 * 命中索引）都不放在这里。
 */

/** 单条数据项：数字、[x, y] 元组、或对象。 */
export type DataItem = number | null | [any, number | null] | Record<string, any>;

export type ScaleType = 'linear' | 'category' | 'time' | 'log';

export type SeriesType = 'line' | 'bar' | 'area' | 'scatter';

export interface AxisOption {
  type?: ScaleType;
  /** 轴名称，绘制在轴线外侧。 */
  name?: string;
  /** 数据域下限；'dataMin' 表示跟随数据。 */
  min?: number | 'dataMin';
  /** 数据域上限；'dataMax' 表示跟随数据。 */
  max?: number | 'dataMax';
  /** 是否把数据域扩展到「整齐」的刻度上，默认 true。 */
  nice?: boolean;
  /** 期望的刻度数量，默认 5。 */
  tickCount?: number;
  /** 刻度文本格式化。 */
  formatter?: (value: any, index: number) => string;
  show?: boolean;
  showGrid?: boolean;
  showAxisLine?: boolean;
  showTick?: boolean;
  /** 轴标签旋转角度（度），仅在水平轴上有实际意义。 */
  labelRotate?: number;
  inverse?: boolean;
  /** log 轴的底数，默认 10。 */
  logBase?: number;
}

export interface SeriesOption {
  id?: string;
  type: SeriesType;
  name?: string;
  data?: DataItem[];
  /** 对象型数据项的取值字段。 */
  xField?: string;
  yField?: string;
  color?: string;
  show?: boolean;
  /** 折线/面积图：线宽（设备像素）。 */
  lineWidth?: number;
  /** 折线虚线样式（设备像素）。 */
  lineDash?: number[];
  /** 折线：是否平滑，true 等价于 0.3。 */
  smooth?: boolean | number;
  /** 折线/散点：数据点标记形状。 */
  symbol?: 'circle' | 'rect' | 'none';
  /** 标记大小（直径，设备像素）。 */
  symbolSize?: number;
  /** 标记填充色，默认跟随系列色。 */
  symbolFill?: string;
  /** 标记描边色，默认白色。 */
  symbolStroke?: string;
  /** 是否始终显示标记（默认：折线只在悬停时显示，散点始终显示）。 */
  showSymbol?: boolean;
  /** 面积图填充不透明度。 */
  areaOpacity?: number;
  /** 柱宽：数字为像素，0~1 的小数为 band 占比。 */
  barWidth?: number;
  /** 同 band 内多柱的间距占比，默认 0.2。 */
  barGap?: number;
  /** 堆叠分组名：同名系列在同一根柱上堆叠。 */
  stack?: string;
  /** 柱形圆角半径（像素）。 */
  barRadius?: number;
  /** 系列整体不透明度。 */
  opacity?: number;
  /** 命中判定的额外容差（设备像素）。 */
  hitRadius?: number;
}

export interface TitleOption {
  text?: string;
  subtext?: string;
  left?: number | 'left' | 'center' | 'right';
  top?: number;
  textStyle?: { color?: string; fontSize?: number; fontWeight?: string | number };
  subtextStyle?: { color?: string; fontSize?: number };
}

export interface LegendOption {
  show?: boolean;
  position?: 'top' | 'bottom' | 'left' | 'right';
  /** 每项前面的色块尺寸。 */
  itemWidth?: number;
  itemHeight?: number;
  itemGap?: number;
  /** 初始选中状态：false 表示默认隐藏该系列。 */
  selected?: Record<string, boolean>;
  /** 点击图例是否可切换；false 表示纯展示。 */
  selectable?: boolean;
}

export interface TooltipOption {
  show?: boolean;
  /** axis：跟随最近的数据列；item：只在命中数据标记时出现。 */
  trigger?: 'axis' | 'item';
  formatter?: (params: TooltipParams) => string | string[];
  backgroundColor?: string;
  borderColor?: string;
  textColor?: string;
  fontSize?: number;
  /** 相对指针的偏移（设备像素）。 */
  offset?: [number, number];
}

export interface CrosshairOption {
  show?: boolean;
  /** line：十字准星线；none：不画辅助线。 */
  type?: 'line' | 'none';
  axis?: 'x' | 'y' | 'xy';
  lineColor?: string;
  /** 在坐标轴上同步显示当前值。 */
  showAxisLabel?: boolean;
}

export interface GridOption {
  show?: boolean;
  x?: boolean;
  y?: boolean;
  color?: string;
  lineWidth?: number;
  lineDash?: number[];
}

export interface DataZoomOption {
  /** 初始视窗，0~100，代表占数据域的比例。 */
  start?: number;
  end?: number;
  /** 缩放的最小/最大跨度（占数据域比例），默认 0.02 / 1。 */
  minSpan?: number;
  maxSpan?: number;
}

export interface ZoomInteractionOption {
  enabled?: boolean;
  /** 参与缩放的轴。 */
  axes?: 'x' | 'y' | 'xy';
  /** 滚轮是否缩放。 */
  wheel?: boolean;
  /** 滚轮缩放的倍率，默认 1.2。 */
  wheelFactor?: number;
  /** data：直接改数据域；viewport：调用 ice.setViewport 做视图缩放。 */
  mode?: 'data' | 'viewport';
}

export interface PanInteractionOption {
  enabled?: boolean;
  axes?: 'x' | 'y' | 'xy';
}

export interface BrushInteractionOption {
  enabled?: boolean;
  axes?: 'x' | 'y' | 'xy';
  /** select：只发事件 + 保留刷选框；zoom：松手后把刷选范围应用为数据域。 */
  mode?: 'select' | 'zoom';
  /** 画笔颜色。 */
  color?: string;
}

export interface InteractionOption {
  hover?: { enabled?: boolean; mode?: 'nearest-x' | 'item'; dimOthers?: boolean };
  select?: { enabled?: boolean; mode?: 'single' | 'multiple'; toggle?: boolean };
  brush?: BrushInteractionOption | false;
  zoom?: ZoomInteractionOption | false;
  pan?: PanInteractionOption | false;
  /** 键盘导航（←/→ 移动活动点，Esc 取消选择）。 */
  keyboard?: boolean;
}

export interface AnimationOption {
  enabled?: boolean;
  duration?: number;
  easing?: string;
}

export interface ChartOption {
  /** 'light' | 'dark' | 'auto'（跟随 ice-render 实例主题）| 自定义主题片段。 */
  theme?: 'light' | 'dark' | 'auto' | Partial<ChartTheme>;
  title?: TitleOption;
  xAxis?: AxisOption;
  yAxis?: AxisOption;
  grid?: GridOption;
  legend?: LegendOption;
  tooltip?: TooltipOption;
  crosshair?: CrosshairOption;
  dataZoom?: DataZoomOption;
  interaction?: InteractionOption;
  animation?: AnimationOption;
  margin?: Partial<Margin>;
  series: SeriesOption[];
}

export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ChartTheme {
  backgroundColor: string;
  colorPalette: string[];
  textColor: string;
  subTextColor: string;
  axisLineColor: string;
  axisLabelColor: string;
  splitLineColor: string;
  fontFamily: string;
  fontSize: number;
  legend: { textColor: string; inactiveColor: string };
  tooltip: {
    background: string;
    borderColor: string;
    textColor: string;
    shadowColor: string;
    fontSize: number;
    padding: number;
    radius: number;
  };
  crosshair: { lineColor: string; labelBackground: string; labelColor: string };
  brush: { fill: string; stroke: string };
  selection: { stroke: string; dimOpacity: number };
}

/** 悬停/点击时对外抛出的数据项描述。 */
export interface DataPointParams {
  seriesId: string;
  seriesName: string;
  seriesIndex: number;
  seriesType: SeriesType;
  color: string;
  /** 系列内部的数据下标。 */
  dataIndex: number;
  /** 原始数据项。 */
  data: any;
  /** x 原始值（category 轴为类目，value/time 轴为数值/时间戳）。 */
  xValue: any;
  /** y 数值。 */
  value: number | null;
  /** 该点在画布上的像素坐标（CSS 像素）。 */
  screen: [number, number];
}

export interface TooltipParams {
  /** item 触发器时长度为 1；axis 触发器时是所有可见系列在该列上的点。 */
  items: DataPointParams[];
  dataIndex: number;
  xValue: any;
}

export interface BrushRange {
  x?: [any, any];
  y?: [number, number];
}

export interface ZoomRange {
  x?: [any, any];
  y?: [number, number];
}

export interface LegendToggleParams {
  seriesId: string;
  seriesName: string;
  seriesIndex: number;
  selected: boolean;
}

export type ChartEventName =
  | 'item:hover'
  | 'item:leave'
  | 'item:click'
  | 'item:dblclick'
  | 'plot:click'
  | 'chart:click'
  | 'select:change'
  | 'brush:change'
  | 'brush:end'
  | 'zoom:change'
  | 'pan:change'
  | 'legend:toggle'
  | 'render';

export interface ChartEventPayloads {
  'item:hover': DataPointParams;
  'item:leave': undefined;
  'item:click': DataPointParams;
  'item:dblclick': DataPointParams;
  'plot:click': { screen: [number, number]; xValue?: any; yValue?: number };
  'chart:click': { screen: [number, number] };
  'select:change': DataPointParams[];
  'brush:change': BrushRange | null;
  'brush:end': BrushRange | null;
  'zoom:change': ZoomRange;
  'pan:change': ZoomRange;
  'legend:toggle': LegendToggleParams;
  render: undefined;
}

export type ChartEventHandler<K extends ChartEventName> = (payload: ChartEventPayloads[K]) => void;

export interface ChartLinkOption {
  /** 联动哪个轴的数据域，默认 'x'。 */
  axis?: 'x' | 'y' | 'xy';
  /** 悬停联动：显示同 x 位置的十字准星/提示。 */
  hover?: boolean;
  /** 缩放联动。 */
  zoom?: boolean;
  /** 刷选联动。 */
  brush?: boolean;
}
