import type {
  AxisOption,
  ChartOption,
  FunnelOption,
  GaugeOption,
  LiquidOption,
  GraphOption,
  LegendOption,
  RadarOption,
  SankeyOption,
  SeriesOption,
  SeriesType,
  TreemapOption,
  ChartTheme,
  WaterfallOption,
} from './types';
import type { Scale } from './scale';
import type { ChartLabels } from './types';

/** 归一化后的数据点（数据域，不含像素）。 */
export interface DataPoint {
  /** 系列内下标。 */
  index: number;
  /** x 原始值：类目轴为类目，数值轴为数字，时间轴为时间戳。 */
  xValue: any;
  /** y 数值；null 表示断点。 */
  y: number | null;
  /** 原始数据项。 */
  raw: any;
  /** 堆叠基线（未堆叠时为 0）。 */
  base: number;
  /** 堆叠顶端（未堆叠时等于 y）。 */
  top: number;
  /** 类目名 / 扇区名（饼图、类目轴对象数据的 name 字段）。 */
  name?: string;
  /** 该数据点自身的颜色（饼图的每个扇区各有一色）。 */
  color?: string;
  /** 第三维数值（气泡图的尺寸）。 */
  size?: number;
  /** 箱线图的 [min, Q1, median, Q3, max]。 */
  boxplot?: [number, number, number, number, number];
}

/** 极坐标布局：圆心与半径（图表坐标系）。 */
export interface PolarLayout {
  cx: number;
  cy: number;
  radius: number;
}

/**
 * 虚拟（列存）系列的数据列。
 *
 * 只有「点本身」值得常驻：x / y（NaN 表示断点）与可选的 size 第三维。
 * 数据域、单调性、尺寸范围都在归一化的**同一趟扫描**里算好，
 * 之后渲染与命中都不再遍历全量数据（见 ScatterSeries 的虚拟路径）。
 */
export interface SeriesColumns {
  x: ArrayLike<number>;
  /** NaN = 断点（对外仍然读成 `y: null`）。 */
  y: Float64Array;
  size: Float64Array | null;
  /** 归一化时算好的 x 数据域（虚拟系列只支持数值轴）。 */
  xDomain: [number, number];
  /** 归一化时算好的 y 数据域（忽略断点）；全是断点时为 null。 */
  yDomain: [number, number] | null;
  /** x 是否单调不减 —— 渲染与命中的二分前提。 */
  xMonotonic: boolean;
  /** 尺寸列的范围（气泡映射用）；没有尺寸列时为 null。 */
  sizeExtent: [number, number] | null;
}

export interface InternalSeries {
  id: string;
  index: number;
  type: SeriesType;
  name: string;
  color: string;
  option: SeriesOption;
  points: DataPoint[];
  /**
   * 是否列存（虚拟）系列 —— 这类系列的 `points` 是空的，数据只在 `columns` 里。
   * 读点/读数量一律走 `pointAt` / `pointCount`，逐点热循环走标量访问器。
   */
  virtual: boolean;
  /** 列存（虚拟）系列的数据列；普通系列为 null。 */
  columns?: SeriesColumns | null;
  /**
   * 数据点个数 —— **读点数量的唯一入口**。
   *
   * 列存（虚拟）系列的 `points` 是空的，`points.length` 会得到 0
   * （那会让整条系列被当成「没有数据」）。
   */
  pointCount: number;
  /**
   * 按下标取数据点 —— **读数据点的唯一入口**。
   *
   * 普通系列就是 `points[index]`（同一个对象，逐字不变，越界同样返回 undefined）；
   * 列存（虚拟）系列把 `points` 留空，由这里现场合成一个 `DataPoint`，
   * 于是调用方不必知道数据是以数组还是以列存形式存着的。
   *
   * 新增读点的地方一律走这里，不要直接下标 `points`。
   */
  pointAt(index: number): DataPoint;
  /**
   * 热路径取值入口 —— **逐点绘制 / 逐点插值的循环一律走这几个方法**。
   *
   * 它们只取一个标量：列存（虚拟）系列直接读 TypedArray 列，不合成 `DataPoint`
   * （`pointAt` 每次都会 new 一个对象，100 万点的重建循环里那就是每帧 100 万个短命对象）。
   * 字段含义与 `DataPoint` 上一一对应。
   */
  xValueAt(index: number): any;
  /** 第 i 个点的 y 值（`null` = 断点，渲染与命中都要跳过）。 */
  yValueAt(index: number): number | null;
  baseAt(index: number): number;
  topAt(index: number): number;
  sizeAt(index: number): number | undefined;
  /** 数据里是否显式提供了 x（决定类目轴的类目来源）。 */
  hasExplicitX: boolean;
  /** 该系列是否被图例隐藏。 */
  hidden: boolean;
  /** 绑定的 y 轴下标。 */
  axisIndex: number;
  /**
   * 归一化后的瀑布图配置（系列级优先，其次顶层 `option.waterfall`）。
   *
   * 顶层与系列级「两者等价」是 types 里的承诺；把解析结果落在内部系列上，
   * 绘制侧就不用再去够顶层 option（那需要给每个系列组件塞一份 chart 反引用）。
   */
  waterfallOption?: WaterfallOption;
  /**
   * 数据域采样值（函数绘图用）。
   *
   * 函数图的 y 轴不该被 1/x 的尖峰拉到 ±2500，这里直接给出**稳健范围**，
   * 由 buildYDomain 采纳；给了它就不再逐点取 y（点的 y 仍然是真值，供提示框使用）。
   */
  domainValues?: number[];
  /**
   * x 轴的取值集合（参数曲线用）。
   *
   * 参数曲线的 `xValue` 是参数 t，不是横坐标 —— x 轴数据域必须来自 `x(t)`，
   * 否则坐标轴会按 t 的范围来画（李萨如曲线会整条错位）。
   */
  domainXValues?: number[];
  /** 表达式编译失败时的原因（图表不崩，但要把错误暴露给表单 / 调用方）。 */
  expressionError?: string;
  /** 表达式诊断（语法 / 未定义变量 / 整段画不出来 / 输出恒定），交给表单去标红与提示。 */
  expressionDiagnostics?: Array<{
    code: string;
    severity: 'error' | 'warning';
    message: string;
    position?: number;
  }>;
}

/**
 * 数组式访问器组：普通系列（`points` 齐备）用，与 `points[index].xxx` 逐字等价。
 *
 * 放在这里是为了让「读点」这件事只有一处实现：归一化建点、组件读点都走它，
 * 列存系列只需要在建系列时换一套访问器。
 *
 * 注意：闭包捕获的是**建系列时的那一个数组**。建好之后要改点就**就地改**
 * （`points[i].xValue = ...`，堆叠基线与轴类目回填就是这么做的），
 * 不要给 `series.points` 重新赋值 —— 那会让访问器与 `points` 分叉。
 */
export function arrayAccessors(
  points: DataPoint[]
): Pick<InternalSeries, 'pointAt' | 'xValueAt' | 'yValueAt' | 'baseAt' | 'topAt' | 'sizeAt'> {
  return {
    pointAt: (index: number): DataPoint => points[index],
    xValueAt: (index: number): any => points[index].xValue,
    yValueAt: (index: number): number | null => points[index].y,
    baseAt: (index: number): number => points[index].base,
    topAt: (index: number): number => points[index].top,
    sizeAt: (index: number): number | undefined => points[index].size,
  };
}

/**
 * 列存（虚拟）系列的访问器：**按需合成**一个数据点，不常驻任何 DataPoint 对象。
 *
 * 只允许在这里 `new DataPoint`（外加归一化建列时那一处）—— 别处一旦「先物化一份数组」
 * 就等于把省下来的内存又还回去了。
 */
export function columnAccessors(
  columns: SeriesColumns
): Pick<InternalSeries, 'pointAt' | 'xValueAt' | 'yValueAt' | 'baseAt' | 'topAt' | 'sizeAt'> {
  const { x, y, size } = columns;
  const yAt = (index: number): number | null => {
    const value = y[index];
    return isNaNNumber(value) ? null : value;
  };
  return {
    pointAt: (index: number): DataPoint => {
      const value = yAt(index);
      const sizeValue = size ? size[index] : NaN;
      return {
        index,
        xValue: x[index],
        y: value,
        raw: undefined,
        base: 0,
        top: value === null ? 0 : value,
        name: undefined,
        size: isNaNNumber(sizeValue) ? undefined : sizeValue,
      };
    },
    xValueAt: (index: number): any => x[index],
    yValueAt: yAt,
    baseAt: (): number => 0,
    topAt: (index: number): number => {
      const value = yAt(index);
      return value === null ? 0 : value;
    },
    sizeAt: (index: number): number | undefined => {
      if (!size) return undefined;
      const value = size[index];
      return isNaNNumber(value) ? undefined : value;
    },
  };
}

/** `NaN` 判定（列存里 NaN 是「没有值」的记号，不是数值）。 */
function isNaNNumber(value: number): boolean {
  return typeof value !== 'number' || Number.isNaN(value);
}

export interface InternalAxis {
  option: AxisOption;
  type: 'linear' | 'category' | 'time' | 'log';
  domain: any[];
  scale: Scale | null;
  /** 轴下标：x 轴恒为 0；y 轴对应 option.yAxis 数组下标。 */
  index: number;
  /** y 轴位置（x 轴为 left，不使用）。 */
  position: 'left' | 'right';
}

export interface NormalizedOption {
  /** 场景类型：直角坐标 / 极坐标（饼图）/ 雷达图 / 桑基图。 */
  kind: 'cartesian' | 'polar' | 'radar' | 'sankey' | 'funnel' | 'gauge' | 'liquid' | 'treemap' | 'graph';
  /**
   * 直角坐标的排布方向。
   * vertical：类目在 x 轴（普通柱状/折线）；horizontal：类目在 y 轴（横向柱状，排行榜场景）。
   */
  orientation: 'vertical' | 'horizontal';
  /**
   * 内置文案（已合并默认值）：无障碍数据表表头、默认 tooltip 标签。
   * 应用层通过 `option.labels` 覆盖，图表包本身不做 i18n 运行时。
   */
  labels: Required<ChartLabels>;
  /** 雷达图配置（存在雷达系列时非空）。 */
  radar: RadarOption | null;
  /** 桑基图配置（存在桑基系列时非空）。 */
  sankey: SankeyOption | null;
  /** 漏斗图配置。 */
  funnel: FunnelOption | null;
  /** 仪表盘配置。 */
  gauge: GaugeOption | null;
  /** 水位图配置（kind === 'liquid' 时非空）。 */
  liquid: LiquidOption | null;
  /** 矩形树图配置。 */
  treemap: TreemapOption | null;
  /** 关系图配置。 */
  graph: GraphOption | null;
  /** 每个雷达指标轴的数据域。 */
  radarDomains: Array<[number, number]>;
  /** 合并默认值之后的原始 option（函数字段保留）。 */
  option: ChartOption & { legend: LegendOption; margin: { top: number; right: number; bottom: number; left: number } };
  theme: ChartTheme;
  series: InternalSeries[];
  xAxis: InternalAxis;
  /** 全部 y 轴（yAxes[0] 是主 y 轴）。 */
  yAxes: InternalAxis[];
  /** 主 y 轴别名，等价于 yAxes[0]。 */
  yAxis: InternalAxis;
  /** 类目轴的类目列表（数值轴为空数组）。 */
  categories: any[];
  /** 参与渲染的系列（未被图例隐藏）。 */
  visibleSeries: InternalSeries[];
  hiddenIds: Record<string, boolean>;
  /** 被隐藏的扇区，key 为 `seriesId#dataIndex`。 */
  hiddenSlices: Record<string, boolean>;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AxisLayout {
  /** 刻度值。 */
  ticks: any[];
  /** 刻度标签文本。 */
  labels: string[];
  /** 该轴相对绘图区边缘外扩的像素距离（多轴时同侧的轴逐层外移）。 */
  offset: number;
  /** 刻度标签的最大宽度 / 高度（像素）。 */
  labelWidth: number;
  labelHeight: number;
  /** 轴名称文本宽度 / 高度。 */
  nameWidth: number;
  nameHeight: number;
}

export interface ChartLayout {
  canvas: Rect;
  plot: Rect;
  titleRect: Rect | null;
  legendRect: Rect | null;
  legend: LegendLayout | null;
  title: TitleLayout | null;
  /** 极坐标圆心与半径；直角坐标场景为 null。 */
  polar: PolarLayout | null;
  /** dataZoom 滑块占用的矩形；未启用时为 null。 */
  slider: Rect | null;
  xAxisLayout: AxisLayout;
  /** 每个 y 轴的刻度布局，与 norm.yAxes 一一对应。 */
  yAxes: AxisLayout[];
  /** 主 y 轴的刻度布局（yAxes[0] 的别名）。 */
  yAxisLayout: AxisLayout;
  margin: { top: number; right: number; bottom: number; left: number };
}

export interface LegendItemLayout {
  seriesId: string;
  seriesIndex: number;
  name: string;
  color: string;
  hidden: boolean;
  /** 饼图图例项对应的数据下标（直角坐标场景为 undefined）。 */
  dataIndex?: number;
  /** 可点击区域。 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LegendLayout {
  position: 'top' | 'bottom' | 'left' | 'right';
  items: LegendItemLayout[];
}

export interface TitleLayout {
  text: string;
  subtext: string;
  /** 文本锚点。 */
  x: number;
  y: number;
  align: 'left' | 'center' | 'right';
  textStyle: { color: string; fontSize: number; fontWeight: string | number };
  subtextStyle: { color: string; fontSize: number };
}

/** 活动数据项（悬停 / 选中 / 键盘导航的共用描述）。 */
export interface ActiveItem {
  series: InternalSeries;
  point: DataPoint;
  /** 画布坐标（CSS 像素）。 */
  screen: [number, number];
  /** 图表坐标系内的像素位置（相对画布左上角）。 */
  pixel: [number, number];
}

/** axis 触发器的悬停列：同一 x 上的所有系列数据点。 */
export interface ActiveColumn {
  dataIndex: number;
  xValue: any;
  /** 图表坐标系内的 x 像素。 */
  pixelX: number;
  items: ActiveItem[];
}

export type HoverState = { kind: 'item'; item: ActiveItem } | { kind: 'axis'; column: ActiveColumn } | null;
