/**
 * ice-chart 的公开类型定义。
 *
 * 设计约束：`ChartOption` 必须是**纯 JSON 可序列化**的（函数字段除外，例如 formatter），
 * 这样图表配置才能存盘、进 DSL、走 undo/redo。运行时派生的一切（比例尺、像素坐标、
 * 命中索引）都不放在这里。
 */

/** 单条数据项：数字、[x, y]、[x, y, size]（气泡图）、或对象。 */
export type DataItem = number | null | [any, number | null] | [any, number | null, number] | Record<string, any>;

/**
 * 列式输入：与 `[x, y]` 数组等价，但不产生「每点一个小数组」。
 *
 * 100 万个 `[x, y]` 元组本身就要 40~70MB（每个都是独立对象）。
 * 大数据量请直接给 `Float64Array`（图表会**直接采用**，不再复制一份）。
 */
export interface SeriesColumnData {
  x: ArrayLike<number>;
  /** `null` / `NaN` 表示断点。 */
  y: ArrayLike<number | null>;
  /** 可选第三维（气泡尺寸）。 */
  size?: ArrayLike<number>;
}

/**
 * **分块列存**：数据按块取（可以异步），图表只让「可见窗口覆盖的块」驻留。
 *
 * 用途是**数据总量远大于内存**的场景（亿级点）：内存 ≈ 驻留块数 × 块大小，
 * 与总量无关；缩放 / 平移换了区域就换一批块进来（LRU 淘汰 + 到货自动重绘）。
 *
 * ```js
 * series: [{
 *   type: 'line', virtual: true,
 *   data: {
 *     sizes: [1_000_000, 1_000_000, ...],          // 每块长度
 *     rangeOf: (i) => [i * 1e6, (i + 1) * 1e6],    // 块 i 的 x 范围（给了才能免加载定位）
 *     loadChunk: async (i) => ({ x, y }),          // 取第 i 块；返回 Promise 也行
 *     maxResidentChunks: 4,                        // 常驻上限（LRU）
 *   },
 * }]
 * ```
 */
export interface SeriesChunkedData {
  /** 每块的长度（逻辑点数 = 各块之和）。 */
  sizes: number[];
  /** 取第 i 块的列；返回 Promise 时，到货后图表自动重绘。 */
  loadChunk: (index: number) =>
    | { x: ArrayLike<number>; y: ArrayLike<number | null> }
    | PromiseLike<{ x: ArrayLike<number>; y: ArrayLike<number | null> }>;
  /**
   * 第 i 块的 x 范围。**必需**：块按 x 递增排列，窗口定位靠它（不必加载就能算出该取哪些块）。
   * 缺了它就只能靠已加载的块推，坐标轴会随平移漂移 —— 所以直接要求调用方声明。
   */
  rangeOf: (index: number) => [number, number];
  /**
   * y 值域。**必需**：亿级数据不可能为了自动缩放把块全load一遍，
   * 而「只看已加载块算域」会让 y 轴随平移跳动 —— 值域由调用方声明（或用 `setDomain('y', …)` 自己控）。
   */
  yDomain: [number, number];
  /** 常驻块数上限（LRU 淘汰），默认 4。 */
  maxResidentChunks?: number;
}

/**
 * 稠密矩阵输入（热力图专用）：行 / 列类目 + 行优先的值矩阵。
 *
 * 与 `[[x类目, y类目, 值], ...]` 等价，但**不产生每格一个小数组**
 * （1000 × 1000 的矩阵，元组写法自己要占几十 MB）。
 * `values` 是 `Float64Array` 时会被**直接采用**（不再复制）；NaN 表示该格没有值。
 */
export interface SeriesGridData {
  /** 列类目（x 轴），顺序即绘制顺序。 */
  xCategories: any[];
  /** 行类目（y 轴），顺序即绘制顺序。 */
  yCategories: any[];
  /** 行优先（`row * xCategories.length + col`）的数值；NaN = 没有该格。 */
  values: ArrayLike<number>;
}

export type ScaleType = 'linear' | 'category' | 'time' | 'log';

/** 内置系列类型。 */
export type BuiltinSeriesType =
  | 'line'
  | 'bar'
  | 'area'
  | 'scatter'
  | 'pie'
  | 'radar'
  | 'heatmap'
  | 'sankey'
  | 'funnel'
  | 'gauge'
  | 'boxplot'
  | 'waterfall'
  | 'treemap'
  | 'graph'
  | 'function'
  | 'parametric'
  | 'liquid';

/**
 * 系列类型。**允许自定义字符串**：用 `registerSeriesType('sparkline', factory)` 注册后，
 * `series[].type` 就能写这个类型（`(string & {})` 既保留内置类型的自动补全，又不封死扩展）。
 */
export type SeriesType = BuiltinSeriesType | (string & Record<never, never>);

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

/**
 * 面板矩阵配置（小倍数）：把绘图区切成 N 个同构面板。
 *
 * 面板彼此**共享数据域**（只是 range 不同），所以「一张图看六个渠道」时六个面板的刻度一致、
 * 可以横向比较。不给 `matrix` 时是现在的单绘图区行为（逐像素不变）。
 */
export interface MatrixOption {
  /** 行数（等分）或每行的高度权重（数组，按顺序）。 */
  rows: number | number[];
  /** 每列的宽度权重或列数；`[4, 1]` 即「主图 + 右侧窄条」。 */
  columns: number | number[];
  /** 面板之间的间距（设备像素），默认 8。 */
  gap?: number;
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
  /** 顶部扇形是否收窄成三角形（默认 true，漏斗形态）。 */
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
  /** 连线填充不透明度，默认 0.42（深色底上可以调高一点，否则连线发闷）。 */
  linkOpacity?: number;
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
   * 类目轴直接声明类目。
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
  /**
   * 数据域的**留白**（CSS padding 的意思）：把数据范围按比例外扩，曲线就不会贴着绘图区边缘。
   * 默认 `0.05`（上下各留 5%），`0` 表示不留。显式写了 `min` / `max` 的那一侧不受影响，
   * 柱形 / 面积被强制包含 0 的那一侧也不受影响（基线要贴在轴上）。
   */
  padding?: number;
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

/** 参数扫动：让某个参数在 [from, to] 之间来回，曲线连续变形（迷你 MATLAB 的「跑起来」）。 */
export interface SweepOption {
  /** 参数名（表达式里出现的自由变量）。 */
  name: string;
  from: number;
  to: number;
  /** 一个来回的时长（毫秒），默认 3000。 */
  duration?: number;
  /** loop：锯齿波（到头重置）；pingpong（默认）：来回。 */
  mode?: 'loop' | 'pingpong';
}

/** 极坐标网格（画 `r(θ)` 时的同心圆 + 辐条底图）。 */
export interface PolarGridOption {
  show?: boolean;
  /** 同心圆数量，默认 4。 */
  splitNumber?: number;
  /** 辐条数量（角度刻度），默认 12（每 30°）。 */
  spokeCount?: number;
  /** 0° 的方向（度），默认 0 = 3 点方向。 */
  startAngle?: number;
  /** 是否画半径刻度，默认 true。 */
  showLabels?: boolean;
}

/**
 * 水位图 / 液位球：一个圆里装水，水位随数值升降、水面持续起伏。
 * 数据大屏的常客（`type: 'liquid'`，`data: [{ name, value }]`）。
 */
export interface LiquidOption {
  min?: number;
  max?: number;
  /** 水位颜色（缺省取系列色）。 */
  color?: string;
  /** 外圈颜色，缺省是水位色的半透明版。 */
  borderColor?: string;
  /** 外圈宽度（设备像素），默认 3。 */
  borderWidth?: number;
  /** 波高（占半径比例），默认 0.06。 */
  waveHeight?: number;
  /** 波长（半径的倍数），默认 1.2。 */
  waveLength?: number;
  /** 波速（相位/秒），默认 1.6。 */
  waveSpeed?: number;
  /** 数值单位后缀，默认 '%'；传 '' 表示不拼单位。 */
  unit?: string;
  /** 中心数值颜色，缺省用主题文本色。 */
  textColor?: string;
  /** 是否在球心显示系列名，默认显示（没有 name 时不画）。 */
  title?: boolean;
  /** 中心数值：字体大小与格式化。 */
  detail?: { show?: boolean; fontSize?: number; formatter?: (value: number) => string };
}

export interface SeriesOption {
  id?: string;
  type: SeriesType;
  /**
   * 所属面板下标（**行优先**：`row · cols + col`）。不给时为 0。
   *
   * 只有配了 `option.matrix` 才有意义；越界 / 负数会被夹到合法范围（不抛异常）。
   */
  panel?: number;
  /** 绑定的 y 轴下标，默认 0（对应 option.yAxis 数组下标）。 */
  yAxisIndex?: number;
  name?: string;
  data?: DataItem[] | SeriesColumnData | SeriesGridData | SeriesChunkedData;
  /**
   * **列存（虚拟）系列**：不建「每点一个对象」的数据点数组，数据只以列的形态常驻。
   *
   * 三类形态（按 `type` 与数据形态自动选）：
   * - `scatter` / `line` / `area`：x / y（/ size）几条数值列；
   * - `heatmap`：**稠密矩阵**（`data: { xCategories, yCategories, values }`，
   *   值矩阵行优先、NaN 表示空格）。热力图只有稠密场景值得开 —— 稀疏数据请用普通路径
   *   （归一化会按密度校验并报错）；
   * - **其它类型（含 `registerSeriesType` 注册的自定义系列）**：**惰性原始点** ——
   *   原始数据按引用保留（组件按自己的字段解析、提示框照旧给 `params.data`），
   *   省掉的是「每点一个 `DataPoint`」；像素缓存**照旧**（自定义系列的 `doRender` 通常直接读
   *   `this.pixels`，不建缓存会让它静默不画）。追加时：不给窗口就原地 push，
   *   给了 `maxPoints` 就转成**原始环**（滚动窗口 O(1)/次）。
   *   收列式输入（`{ x, y }` / `{ xCategories, ... }` / `{ sizes, loadChunk }`）只对前两类生效。
   *
   * 代价（都是有意的取舍，别当成 bug）：
   * - `tooltip` 的 `params.data` 为空、`symbolSize` 函数拿不到 `data`（`xValue` / `y` / `index` 照常）；
   * - **数值列 / 矩阵 / 分块 / 环**：`data` 在归一化之后**会被释放**（图表不再持有原始数组），
   *   因此这类虚拟系列**不进 option 快照** —— `toJSON()` 之后再用 `restore()` 会显式报错，
   *   而不是还你一张空图。**惰性原始点例外**：数据还在 option 里，快照照旧可用
   *   （只有转成原始环之后才不再进快照）；
   * - 数值列（scatter / line / area）只支持数值型 x（堆叠、函数绘图请继续用普通系列）；
   *   折线 / 面积在大窗口下按**像素列**压缩成「首 / 最低 / 最高 / 末」四点，
   *   尖峰不会被采样吃掉，但与普通系列的 LTTB 抽稀不是同一套图形（虚拟是另一条渲染路径）。
   *   矩阵列（heatmap）要求 x / y 都是类目轴，且单元格密度要够高。
   */
  virtual?: boolean;
  /**
   * **这条系列的 x 与另一条系列逐项相同**（写那条系列的 `id`）。
   *
   * 给谁用：由主系列**派生**出来的那些线 / 柱（均线、MACD 的 DIF/DEA、成交量……）——
   * 它们的 x 本来就是从主系列抄过来的，逐项同序同长。
   *
   * 引擎拿它做什么：类目轴的域是「所有系列类目表的并集」，一张张扫过去在百万点规模下
   * 是每帧最大的一笔（1M × N 次 `String()` + 哈希）。声明了 `xFrom` 的系列**不参与合并**
   * —— 它没有自己的类目，轴直接用被引用那条的。长度对不上时自动忽略这条声明（退回合并），
   * 所以「应用抄错了」只会慢、不会错。
   */
  xFrom?: string;
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
  /** 热力图配色（默认从浅到深）。 */
  heatmap?: { minColor?: string; maxColor?: string };
  /** 瀑布图配色与连接线（也可写在 option.waterfall 上，两者等价，series 优先）。 */
  waterfall?: WaterfallOption;
  /** 饼图标签。 */
  label?: { show?: boolean; position?: 'outside' | 'inside'; formatter?: (params: PieLabelParams) => string };
  /**
   * 函数绘图（`type: 'function'`）：`y = expression`。
   * 支持 `+ - * / % ^`、`sin/cos/exp/log/sqrt/...`、常量 `pi/e`、隐式乘法（`2x`、`3sin(x)`）。
   */
  expression?: string;
  /** 参数曲线（`type: 'parametric'`）：`x = xExpression, y = yExpression`（自变量是 `t`）。 */
  xExpression?: string;
  yExpression?: string;
  /**
   * 极坐标函数简写：`r = polarExpression`（自变量 θ 用 `t` 表示）。
   * 组件按 `x = r·cosθ, y = r·sinθ` 展开成参数曲线 —— 玫瑰线 `1+cos(3*t)` 直接能用。
   * 配 `aspect: 'equal'`（圆才是圆）与 `polarGrid: true`（极坐标底图）就是 MATLAB 的 polarplot。
   */
  polarExpression?: string;
  /** 参数范围：function 是 x 的取值范围（默认 [-10,10]），parametric 是 t 的范围（默认 [0, 2π]）。 */
  domain?: [number, number];
  /** 基础采样点数（默认 240 / 360），自适应细分在此之上加点。 */
  samples?: number;
  /** 是否自适应细分，默认 true。关掉后按 `samples` 均匀采样（快，但峰顶/极点会失真）。 */
  adaptive?: boolean;
  /** 自适应阈值（相对可视跨度），越小越精细。默认 function 0.0025 / parametric 0.0015。 */
  samplingTolerance?: number;
  /** 表达式里的自定义参数（纯数字，会进 JSON 快照）。 */
  params?: Record<string, number>;
  /** 参数扫动动画：曲线随时间连续变形（动效偏好为 instant 时停在 from）。 */
  sweep?: SweepOption;
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
  /**
   * 准星从当前列滑到目标列的**最大**时长（毫秒），0 = 立即跟随（默认 90）。
   * 实际时长按距离缩放：相邻列这种小位移当帧就到，只有大跨度跳转才有一段可见的滑动。
   */
  followDuration?: number;
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
  /**
   * **缩放的上下限**（类目轴 / 时间轴），单位是「每根占多少像素」——
   * 这就是主流看盘软件的口径：`minBarSpacing` 管「最多能缩到多密」，
   * `maxBarSpacing` 管「最多能放到多粗」。
   *
   * 默认 `minBarSpacing = 0.5`（再密就一根都占不到一个像素，整片糊成色带）、
   * `maxBarSpacing = 0`（= 自动，取绘图区宽度的一半，也就是「一屏最少两根」）。
   * 0.5 / 半幅这两个默认值跟主流轻量图表库的默认口径一致。
   *
   * 只约束**手势缩放**（滚轮 / 双指 / 框选缩放到区间）；程序化 `setDomain` 与联动回显
   * 不受限 —— 那是应用自己的窗口（比如「回到最新」钉最后 240 根），必须指哪打哪。
   */
  minBarSpacing?: number;
  maxBarSpacing?: number;
  /**
   * **连续轴**（数值轴）的缩放下限 / 上限，占完整数据域的比例，默认 0.05 / 1。
   *
   * 类目轴不看这两个 —— 它按上面的 px/根 管（`minBarSpacing` / `maxBarSpacing`）。
   */
  minSpan?: number;
  maxSpan?: number;
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
  hover?: {
    enabled?: boolean;
    mode?: 'nearest-x' | 'item';
    dimOthers?: boolean;
    /**
     * 悬停时是否在数据点上画标记（圆环 / 柱形描边），默认 `true`。
     *
     * 关掉它适用于「照着主流看盘软件做十字准星」的场景：标记是一圈**半透明白**填充 +
     * 彩色描边，落在蜡烛上会遮住正要看的那一根；而且 `mode: 'nearest-x'` 时同一列里
     * 每个系列各画一个，比准星本身还抢眼。此时「读到哪一根」由准星 + 抬头承担。
     */
    mark?: boolean;
  };
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

/**
 * 图表内置文案（全部可选）。默认值是中文；应用层按自己的语言传入即可，
 * 不需要图表包内置任何 i18n 运行时（契约见 ice-render `docs/architecture/17-i18n-boundary.md`）。
 */
export interface ChartLabels {
  /** 无障碍标题的兜底文案（`option.title.text` 优先）。默认 `图表`。 */
  chart?: string;
  /** 饼图数据表的「扇区」列。默认 `扇区`。 */
  sector?: string;
  /** 数据表的「数值」列。默认 `数值`。 */
  value?: string;
  /** 数据表的「占比」列。默认 `占比`。 */
  ratio?: string;
  /** 雷达图的「指标」列。默认 `指标`。 */
  indicator?: string;
  /** 函数绘图 tooltip 里的「坐标」。默认 `坐标`。 */
  coordinate?: string;
  /** 水位图 tooltip 里的「水位」。默认 `水位`。 */
  liquid?: string;
  /** 饼图扇区的兜底名字前缀（`切片 N`）。默认 `切片`。 */
  slice?: string;
}

/** 标注的定位轴：`'y'` 画水平线（值是 y 值），`'x'` 画垂直线。 */
export type AnnotationAxis = 'x' | 'y';

/** 标注线 / 区间的文字沿线位置。 */
export type AnnotationTextPosition = 'start' | 'center' | 'end';

/** 标注点的文字位置。 */
export type AnnotationPointTextPosition = 'top' | 'bottom' | 'left' | 'right';

/**
 * 标注线：目标线 / 阈值线 / 告警线。
 *
 * **定位走坐标轴的比例尺**，所以它随缩放、平移、跨图联动一起动；值落在当前可视域之外
 * **不画**（诊断里给出提示，见 `chart.annotationDiagnostics()`），而不是被裁成半条。
 */
export interface AnnotationLineOption {
  /** 定位轴：`'y'`（默认）画水平线，`'x'` 画垂直线。 */
  axis?: AnnotationAxis;
  /** 定位值：数值轴写数值；类目轴写类目名或下标；时间轴写时间戳 / 日期串。 */
  value?: number | string | Date;
  /** 线旁边的说明文字（不传则不画字）。 */
  text?: string;
  /** 线色，默认取主题的正文色。 */
  color?: string;
  /** 线宽（CSS 像素），默认 1。 */
  lineWidth?: number;
  /** 是否虚线（默认 true —— 标注是「说明」，实线会跟数据线抢视线）。 */
  dashed?: boolean;
  /** 自定义虚线间隔（像素）；给了就以它为准，`[]` 表示实线。 */
  lineDash?: number[];
  /** 文字沿线的位置，默认 `'end'`。 */
  textPosition?: AnnotationTextPosition;
  /** 文字颜色，默认取线色。 */
  textColor?: string;
  /** 文字字号，默认取主题字号。 */
  fontSize?: number;
  /** 多 y 轴时贴哪根轴定位，默认 0（主轴）。 */
  axisIndex?: number;
}

/** 标注点：异常点 / 事件点 —— 在坐标系里定位一个点并配文字。 */
export interface AnnotationPointOption {
  /** x 值（类目轴写类目名或下标；时间轴写时间戳 / 日期串）。 */
  x?: number | string | Date;
  /** y 值。 */
  y?: number;
  text?: string;
  color?: string;
  /** 标记形状，默认 `'circle'`。 */
  symbol?: 'circle' | 'rect' | 'diamond' | 'triangle';
  /** 标记直径（像素），默认 8。 */
  symbolSize?: number;
  /** 文字相对点的位置，默认 `'top'`。 */
  textPosition?: AnnotationPointTextPosition;
  textColor?: string;
  fontSize?: number;
  axisIndex?: number;
}

/**
 * 标注区间：达标区 / 维护窗口 —— 沿某个轴的一段。
 *
 * 与标注线不同，**区间允许有一端越界**：只画落在可视域里的那一段（这是图上「看到一半的区间」
 * 的正常语义）；整段都在可视域外才不画，并给出诊断。
 */
export interface AnnotationAreaOption {
  /** 沿哪根轴划分：`'y'`（默认）是横向的带，`'x'` 是纵向的带。 */
  axis?: AnnotationAxis;
  /** 区间起点（含）。 */
  from?: number | string | Date;
  /** 区间终点（含）。 */
  to?: number | string | Date;
  /** 填充色，默认取主题正文色的低透明度。 */
  color?: string;
  /** 区间内的说明文字。 */
  text?: string;
  /** 文字在区间上的位置，默认 `'center'`。 */
  textPosition?: AnnotationTextPosition;
  textColor?: string;
  fontSize?: number;
  axisIndex?: number;
}

/**
 * 标注图层。
 *
 * 它是**坐标系上的一个图层**（与网格线 / 准星同族），不是新的系列类型：数据来自 option、
 * 几何来自比例尺，因此不参与图例、堆叠与数据下标，也不会污染提示框的数据行。
 * 默认不参与命中测试（点标注不该抢走下面数据点的点击）。
 */
export interface AnnotationOption {
  lines?: AnnotationLineOption[];
  points?: AnnotationPointOption[];
  areas?: AnnotationAreaOption[];
}

/** 标注诊断的机器可读编码。 */
export type AnnotationDiagnosticCode =
  /** 值缺失 / 不是合法数值 / 日期解析不出来 —— 这条标注一定画不出来。 */
  | 'annotation:invalid-value'
  /** 值不在当前可视数据域内（缩放后会重新判定）。 */
  | 'annotation:out-of-range'
  /** 类目轴上没有这个类目。 */
  | 'annotation:unknown-category'
  /** 当前场景没有直角坐标系（饼图 / 雷达 / 桑基等），标注无处可画。 */
  | 'annotation:unsupported-scene';

/**
 * 标注诊断（与表达式诊断同款：不让图表崩，但必须能被表单拿到）。
 *
 * `severity: 'error'` 表示**这条标注写错了**（标红），`'warning'` 表示写对了但当前画不出来
 * （提示即可 —— 缩放 / 数据更新后它可能又出现了）。
 */
export interface AnnotationDiagnostic {
  code: AnnotationDiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  /** 出问题的标注种类与它在数组里的下标（表单据此定位到具体那一行）。 */
  kind: 'line' | 'point' | 'area';
  index: number;
}

export interface ChartOption {
  /** 'light' | 'dark' | 'auto'（跟随 ice-render 实例主题）| 自定义主题片段。 */
  theme?: 'light' | 'dark' | 'auto' | Partial<ChartTheme>;
  /**
   * 内置文案（**组件层文案可配**，见 ice-render `docs/architecture/17-i18n-boundary.md`）。
   *
   * 只影响那几处「图表包自己吐出来的字」：无障碍数据表的表头/标题、默认 tooltip 里
   * 「坐标 / 水位」这类标签。不传时是中文字面量；**应用层应当按自己的语言传入**，
   * 或者用 `tooltip.formatter` 完全接管提示框（那样这些标签就不会出现）。
   */
  labels?: ChartLabels;
  title?: TitleOption;
  xAxis?: AxisOption;
  /** 单个 y 轴，或 y 轴数组（多轴叠加：双轴对比、双量纲并列之类）。 */
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
  /** 水位图配置（存在 liquid 系列时生效）。 */
  liquid?: LiquidOption;
  /** 瀑布图配置。 */
  waterfall?: WaterfallOption;
  /** 矩形树图配置。 */
  treemap?: TreemapOption;
  /** 力导向关系图配置。 */
  graph?: GraphOption;
  /** 极坐标网格（画 `r(θ)` 时的同心圆 + 辐条底图）。 */
  polarGrid?: boolean | PolarGridOption;
  /**
   * 面板矩阵（小倍数）：把绘图区切成 N 个同构面板，`series[].panel` 指定归属。
   * 不给就是单绘图区（现有行为，逐像素不变）。
   */
  matrix?: MatrixOption;
  /** 标注图层：目标线 / 阈值线、异常点、目标区间（见 `AnnotationOption`）。 */
  annotation?: AnnotationOption;
  /**
   * 坐标轴比例：`'equal'` = x/y 一个数据单位在屏幕上等长（MATLAB 的 `axis equal`）。
   * 画圆 / 参数曲线 / 几何图形时必须开，否则圆会被拉成椭圆（绘图区本身也会收缩成正方形）。
   */
  aspect?: 'auto' | 'equal';
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
  /**
   * 压在图形上的文字（桑基节点名 / 关系图节点名）的描边色。
   *
   * 浅色主题用白色描边、深色主题必须换成深色 —— 写死白色会在深色大屏里
   * 变成一层白糊（实测桑基节点名完全不可读）。
   */
  labelHaloColor: string;
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

/**
 * 数据坐标图元（mark）的形状。
 *
 * - `point`：锚在一个数据点上（注释卡片 / 标记 / 徽标）
 * - `xLine` / `yLine`：贴着某个数据值的整条线（阈值线 / 目标线）
 * - `xBand` / `yBand`：一段数据区间（预测带 / 高亮区间 / 参考区间）
 */
export type ChartMarkKind = 'point' | 'xLine' | 'yLine' | 'xBand' | 'yBand';

/** 图元被拖动后回传的数据坐标。 */
export interface ChartMarkData {
  id: string;
  /** 横轴数据值（类目轴就是类目名）。 */
  xValue?: any;
  /** 纵轴数据值（point 才有；线 / 带是 undefined）。 */
  yValue?: number;
  /** 当前像素位置（图表坐标系）。 */
  pixel: [number, number];
}

/**
 * 数据坐标图元：把**任意引擎图元**挂到数据坐标上，并跟着缩放 / 平移 / 数据更新走。
 *
 * 组件由调用方创建（所以它天然参与引擎的命中测试、事件、动画与序列化），
 * chart 只负责「摆位置 / 定尺寸 / 越界隐藏 / 拖拽回传」。
 *
 * ```ts
 * chart.addMark({
 *   type: 'point',
 *   x: '3月', y: 168,
 *   component: new ICEStar({ radius: 10, fill: '#dc3545' }),
 * });
 * ```
 */
export interface ChartMarkSpec {
  /** 不传自动生成。 */
  id?: string;
  type?: ChartMarkKind;
  /** point：数据坐标（x 可为类目名 / 数值 / 时间戳）。 */
  x?: any;
  y?: any;
  /** xBand：区间端点；yBand 同理由 y0 / y1 给出。 */
  x0?: any;
  x1?: any;
  y0?: any;
  y1?: any;
  /** 多 y 轴时指定用哪个系列的轴（默认主轴）。 */
  seriesId?: string;
  /** 像素微调（point 用；线 / 带也会叠加）。 */
  dx?: number;
  dy?: number;
  /** 引擎图元实例。 */
  component: any;
  /** 拖动后自动把新的数据坐标写回 spec，并抛出 `mark:drag`。 */
  draggable?: boolean;
  /** 数据点跑到可视区之外时自动隐藏（默认 true）。 */
  hideWhenOutOfView?: boolean;
  /** 拖动回调（与 `chart.on('mark:drag')` 二选一或一起用）。 */
  onDrag?: (data: ChartMarkData) => void;
}

/** `addMark` 返回的句柄。 */
export interface ChartMarkHandle {
  id: string;
  spec: ChartMarkSpec;
  component: any;
  /** 局部更新（重新摆位、改数据锚点）。 */
  update(patch: Partial<ChartMarkSpec>): ChartMarkHandle;
  /** 当前锚点的数据坐标。 */
  toData(): ChartMarkData;
  remove(): void;
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
  | 'mark:drag'
  | 'mark:dragend'
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
  /**
   * 数据坐标图元被拖动（拖动过程中每次移动抛一次）。
   *
   * 这两个名字**一直是运行时事实**（`ICEChart.addMark` 的拖拽通道与
   * `finishMarkDrag()` 早就 emit 了它们，README 的事件表也一直列着），
   * 只是漏在 `ChartEventName` 联合类型之外 —— 于是 `chart.on()` 的宽签名
   * 让调用处能过、而任何拿 `ChartEventName` 做穷举或建类型安全事件表的代码
   * 都会**静默漏掉**这两个事件（不报错，只是收不到）。这里补齐。
   */
  'mark:drag': ChartMarkData;
  /** 图元拖动结束（此时锚点已写回数据坐标）。 */
  'mark:dragend': ChartMarkData;
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
