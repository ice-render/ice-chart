/**
 * ice-chart 的公开类型定义。
 *
 * 设计约束：`ChartOption` 必须是**纯 JSON 可序列化**的（函数字段除外，例如 formatter），
 * 这样图表配置才能存盘、进 DSL、走 undo/redo。运行时派生的一切（比例尺、像素坐标、
 * 命中索引）都不放在这里。
 */

/** 单条数据项：数字、[x, y]、[x, y, size]（气泡图）、或对象。 */
export type DataItem = number | null | [any, number | null] | [any, number | null, number] | Record<string, any>;

export type ScaleType = 'linear' | 'category' | 'time' | 'log';

export type SeriesType =
  | 'line'
  | 'bar'
  | 'area'
  | 'scatter'
  | 'pie'
  | 'radar'
  | 'candlestick'
  | 'heatmap'
  | 'sankey'
  | 'funnel'
  | 'gauge'
  | 'boxplot'
  | 'waterfall'
  | 'treemap'
  | 'graph';

/** 力导向关系图的节点。 */
export interface GraphNodeOption {
  id?: string;
  name: string;
  /** 权重：影响节点大小与连线粗细。 */
  value?: number;
  /** 分类名（对应 `graph.categories`），用于配色。 */
  category?: string | number;
  color?: string;
  /** 初始坐标（给了就用它，否则按 circular 均匀铺开）。 */
  x?: number;
  y?: number;
  /** 固定不动（不参与力学迭代，但可以被拖拽）。 */
  fixed?: boolean;
}

/** 关系图的连线。source / target 可以是节点 id、name 或下标。 */
export interface GraphLinkOption {
  source: string | number;
  target: string | number;
  value?: number;
  color?: string;
}

export interface GraphOption {
  nodes: GraphNodeOption[];
  links: GraphLinkOption[];
  /** 布局方式：force（默认，力导向）| circular（环形）| none（只用给定坐标）。 */
  layout?: 'force' | 'circular' | 'none';
  /** 节点之间的斥力，默认 6000。 */
  repulsion?: number;
  /** 连线的理想长度（像素），默认 70。 */
  edgeLength?: number;
  /** 向中心的向心力，默认 0.06。 */
  gravity?: number;
  /** 速度阻尼（0~1），默认 0.85。 */
  damping?: number;
  /** 迭代次数，默认 240。 */
  iterations?: number;
  /** 节点直径区间，默认 [12, 48]。 */
  symbolSizeRange?: [number, number];
  /** 连线是否画成曲线（默认 true）。 */
  curve?: boolean;
  /** 分类配色表：`categories: [{ name: '前端', color: '#0d6efd' }]`。 */
  categories?: Array<{ name: string; color?: string }>;
  /** 是否可以拖动节点，默认 true。 */
  draggable?: boolean;
  /** 拖完松手后是否再跑几轮力迭代让邻居跟随，默认 true。 */
  settleOnDrop?: boolean;
}

/** 矩形树图配置。 */
export interface TreemapOption {
  /** 同级节点之间的间距（像素），默认 2。 */
  gap?: number;
  /** 只显示面积占比大于该值的标签，默认 0.02。 */
  minLabelRatio?: number;
  /** 子节点颜色与白色混合的比例（按 depth 递增），默认 0.18。 */
  depthFade?: number;
}

/** 瀑布图配置。 */
export interface WaterfallOption {
  increaseColor?: string;
  decreaseColor?: string;
  totalColor?: string;
  /** 是否画相邻柱子之间的连接虚线，默认 true。 */
  connector?: boolean;
}

/** 漏斗图配置。 */
export interface FunnelOption {
  /** 阶段之间的间距（像素），默认 2。 */
  gap?: number;
  /** 排序：descending（默认，上大下小）| ascending | none。 */
  sort?: 'descending' | 'ascending' | 'none';
  /** 最小阶段宽度占最大值的比例（0~1），默认 0.12 —— 保证最小的阶段仍然可见可点。 */
  minSize?: number;
  /** 标签位置：inside（默认，居中）| right（右侧外置）。 */
  labelPosition?: 'inside' | 'right';
  /** 顶部扇形是否收窄成三角形（默认 true，ECharts 的 funnel 形态）。 */
  trapezoid?: boolean;
}

/** 仪表盘配置。 */
export interface GaugeOption {
  min?: number;
  max?: number;
  /** 起始 / 结束角度（度）：90 = 12 点方向，默认 225 → -45（顺时针扫 270°）。 */
  startAngle?: number;
  endAngle?: number;
  /** 刻度分段数，默认 5。 */
  splitNumber?: number;
  /** 轴线宽度（像素），默认 14。 */
  lineWidth?: number;
  /** 阈值配色：`[[0.4, '#198754'], [0.8, '#ffc107'], [1, '#dc3545']]`。 */
  axisLineColor?: Array<[number, string]> | null;
  /** 指针。 */
  pointer?: { show?: boolean; width?: number; length?: number };
  /** 数值文本。 */
  detail?: { show?: boolean; formatter?: (value: number) => string; fontSize?: number };
  /** 名称（取数据项的 name）。 */
  title?: { show?: boolean; fontSize?: number };
}

/** 桑基图节点。 */
export interface SankeyNodeOption {
  name: string;
  color?: string;
  /** 强制指定层级（不传则按最长路径自动分层）。 */
  depth?: number;
}

/** 桑基图连线。source/target 可以是节点下标或节点名。 */
export interface SankeyLinkOption {
  source: string | number;
  target: string | number;
  value: number;
  color?: string;
}

export interface SankeyOption {
  nodes: SankeyNodeOption[];
  links: SankeyLinkOption[];
  /** 节点宽度（像素），默认 16。 */
  nodeWidth?: number;
  /** 同列节点间距（像素），默认 10。 */
  nodePadding?: number;
  /** 纵向松弛迭代次数，默认 6。 */
  iterations?: number;
  label?: { show?: boolean };
  /** 连线是否显示「流动」效果（虚线相位持续推进），默认 false。 */
  flow?: boolean;
  /** 流动速度（像素/秒），默认 40。 */
  flowSpeed?: number;
}

/** 雷达图的指标轴。 */
export interface RadarIndicator {
  name: string;
  min?: number;
  max?: number;
}

export interface RadarOption {
  indicators: RadarIndicator[];
  /** 网格形状：多边形（默认）或圆环。 */
  shape?: 'polygon' | 'circle';
  /** 网格环数，默认 4。 */
  splitNumber?: number;
  /** 半径占可用半径的比例，默认 0.72。 */
  radius?: number;
  /** 指标名称标签。 */
  label?: { show?: boolean };
}

export interface AxisOption {
  type?: ScaleType;
  /**
   * 类目轴直接声明类目（ECharts 兼容）。
   * 横向柱状图就靠它：`yAxis: { type: 'category', data: ['华东', '华北'] }` + `xAxis: { type: 'value' }`。
   */
  data?: any[];
  /** y 轴位置：left / right。默认第一个 y 轴在左，其余在右。 */
  position?: 'left' | 'right';
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
  /** 绑定的 y 轴下标，默认 0（对应 option.yAxis 数组下标）。 */
  yAxisIndex?: number;
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
  symbolSize?: number | ((value: any, params: { dataIndex: number; data: any; seriesName: string }) => number);
  /** 气泡图：数据项第三维映射到直径时的区间，默认 [8, 40]。 */
  symbolSizeRange?: [number, number];
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
  /**
   * 大数据降采样策略。
   * 'lttb'（默认）：点数超过「绘图区宽度 × 3」时用 LTTB 抽稀，保留极值与首尾点；
   * 'none'：始终画全部点。
   */
  sampling?: 'lttb' | 'none';
  /** 饼图半径：0~1 的小数视为「可用半径占比」，>1 视为像素。 */
  radius?: number;
  /** 饼图内半径（环形图）。 */
  innerRadius?: number;
  /** 扇形起始角度（度）：90 = 12 点方向。 */
  startAngle?: number;
  /** 是否顺时针排布扇形，默认 true。 */
  clockwise?: boolean;
  /** 玫瑰图：radius（半径随数值）| area（面积随数值）。 */
  roseType?: 'radius' | 'area' | false;
  /** K 线配色（默认红涨绿跌）。 */
  candle?: { upColor?: string; downColor?: string; borderWidth?: number };
  /** 热力图配色（默认从浅到深）。 */
  heatmap?: { minColor?: string; maxColor?: string };
  /** 瀑布图配色与连接线（也可写在 option.waterfall 上，两者等价，series 优先）。 */
  waterfall?: WaterfallOption;
  /** 饼图标签。 */
  label?: { show?: boolean; position?: 'outside' | 'inside'; formatter?: (params: PieLabelParams) => string };
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
  /** 底部滑块组件。不配置时，只要声明了 dataZoom 就默认显示。 */
  slider?: {
    show?: boolean;
    /** 轨道高度（像素），默认 26。 */
    height?: number;
    /** 选中窗口颜色。 */
    color?: string;
    /** 是否在两端显示当前区间文本。 */
    showDetail?: boolean;
  };
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

/** 一段动画的配置。 */
export interface AnimationStageOption {
  duration?: number;
  /** 整体延迟（毫秒）。 */
  delay?: number;
  easing?: string;
  /**
   * 错峰比例（0~1）：把入场拆成「依次发生」的波浪。
   * 0.4 表示最后一个数据项比第一个晚 0.4 段，所有项仍会在同一时刻结束。
   */
  stagger?: number;
}

export interface AnimationOption {
  enabled?: boolean;
  /** 入场动画（首次渲染与系列新增）。 */
  enter?: AnimationStageOption | false;
  /** 数据更新动画（setData / setOption 之后）。 */
  update?: AnimationStageOption | false;
  /** 交互反馈动画（悬停放大等）。 */
  highlight?: AnimationStageOption | false;
  /** 兼容扁平写法：等价于 enter.duration / enter.easing / enter.stagger。 */
  duration?: number;
  easing?: string;
  stagger?: number;
}

export interface ChartOption {
  /** 'light' | 'dark' | 'auto'（跟随 ice-render 实例主题）| 自定义主题片段。 */
  theme?: 'light' | 'dark' | 'auto' | Partial<ChartTheme>;
  title?: TitleOption;
  xAxis?: AxisOption;
  /** 单个 y 轴，或 y 轴数组（多轴叠加：涨跌幅用右轴、成交量用左轴之类）。 */
  yAxis?: AxisOption | AxisOption[];
  grid?: GridOption;
  legend?: LegendOption;
  tooltip?: TooltipOption;
  crosshair?: CrosshairOption;
  dataZoom?: DataZoomOption;
  /** 雷达图配置（存在雷达系列时必填）。 */
  radar?: RadarOption;
  /** 桑基图配置（存在桑基系列时必填）。 */
  sankey?: SankeyOption;
  /** 漏斗图配置。 */
  funnel?: FunnelOption;
  /** 仪表盘配置。 */
  gauge?: GaugeOption;
  /** 瀑布图配置。 */
  waterfall?: WaterfallOption;
  /** 矩形树图配置。 */
  treemap?: TreemapOption;
  /** 力导向关系图配置。 */
  graph?: GraphOption;
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

/** 饼图 / 玫瑰图标签回调参数。 */
export interface PieLabelParams {
  name: string;
  value: number | null;
  /** 占可见扇区之和的百分比（0~100）。 */
  percent: number;
  dataIndex: number;
  seriesId: string;
  seriesName: string;
  color: string;
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
  /** 饼图扇区被切换时带上数据下标。 */
  dataIndex?: number;
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
  | 'data:change'
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
  /** 通过 setData / setOption 更新数据后触发。 */
  'data:change': { seriesId?: string; seriesIndex?: number };
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
