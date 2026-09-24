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
import type { SeriesRing } from './util/ring';
import type { SeriesChunks } from './util/chunks';
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
  kind: 'columns';
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

/**
 * 列存系列的**域提示**：连续列（`SeriesColumns`）与环形缓冲（`SeriesRing`）
 * 只是同一件事的两种物理布局，上层要的只有「数据域 / 单调性 / 尺寸范围」这几项。
 */
export function storeDomainOf(
  series: InternalSeries
): { xDomain: [number, number]; yDomain: [number, number] | null; xMonotonic: boolean; sizeExtent: [number, number] | null } | null {
  const store = series.columns || series.ring || series.chunks || series.raw;
  if (!store) return null;
  return {
    xDomain: store.xDomain,
    yDomain: store.yDomain,
    xMonotonic: store.xMonotonic,
    sizeExtent: store.sizeExtent,
  };
}

/**
 * 虚拟（列存）**稠密矩阵**：热力图用。
 *
 * 热力图的数据是「列类目 × 行类目 → 值」，天然是矩阵而不是点集：
 * 行列由类目定死，值按行优先排在一个 `Float64Array` 里（NaN = 没有该格）。
 * 于是 100 万格只占 8MB，而且**命中是 O(1)**（类目 → 下标两张表 + 一次下标运算），
 * 不再像普通热力图那样每个命中去线性扫全部单元格。
 */
export interface SeriesGrid {
  /** 列类目（x 轴），顺序即绘制顺序。 */
  xCategories: any[];
  /** 行类目（y 轴），顺序即绘制顺序。 */
  yCategories: any[];
  /** 行优先（`row * cols + col`）的数值；NaN = 没有该格。 */
  values: Float64Array;
  /** 类目 → 下标（命中 / 提示框按类目反查，避免线性扫）。 */
  xIndex: Map<any, number>;
  yIndex: Map<any, number>;
  /** 值域（忽略 NaN）；全是空格时为 null。 */
  valueDomain: [number, number] | null;
}

/**
 * 虚拟（列存）的**惰性原始点**存储：给「数值列 / 矩阵之外」的类型（自定义系列）用。
 *
 * 为什么需要它：`scatter / line / area` 的数据是 (x, y) 数值对，列存能把原始数据也省掉；
 * 但自定义系列（K 线那种 `[x, o, c, l, h, v]` 元组）的原始数据**本身就是要保留的** ——
 * 组件要靠它解析自己的字段，提示框要用 `point.raw`。
 * 所以这里的取舍是：**原始数据按引用保留，省掉的是「每点一个 `DataPoint` 对象」**，
 * 点按需合成，字段规则与 normalize 里那条通用分支逐字一致（同一个 `readGenericPoint`）。
 *
 * 两种形态：
 * - 普通：`capacity === 0`，逻辑点就是 `data` 本身（`start` 恒为 0）；
 * - 环形（`appendData(..., { maxPoints })` 之后）：`data` 是一片**定长原始环**，
 *   逻辑第 i 个点在 `(start + i) % capacity` 上 —— 滚动窗口的追加因此是 O(1)，
 *   不用 `shift()` 搬 10 万个元素。
 */
export interface SeriesRawPoints {
  kind: 'raw';
  /** 原始数据（引用保留；环形态下是定长数组）。 */
  data: any[];
  /** 逻辑起点（环形态下才有意义）。 */
  start: number;
  /** 逻辑点数。 */
  length: number;
  /** 0 = 用 `data` 本身；> 0 = 环容量。 */
  capacity: number;
  /** 取点规则（建存储时定下来）。 */
  type?: string;
  xField?: string;
  yField?: string;
  xDomain: [number, number];
  yDomain: [number, number] | null;
  xMonotonic: boolean;
  sizeExtent: [number, number] | null;
  /**
   * **去重后的 x 类目**（按首次出现顺序）与它们的出现次数 —— 增量维护。
   *
   * 为什么要有它：类目轴每次归一化都要这张表（`buildCategoryValues` / `buildXDomain`），
   * 而滚动窗口的追加只动**两头**。不增量维护的话，10 万根的窗口每 tick 要重扫两趟 O(n)
   * （实测：K 线环形追加 4.8ms/tick，其中 ~3ms 就是这两趟）。
   * 追加 / 淘汰时各 O(1) 更新：新 key 追加到尾部，计数归零的 key 从表里摘掉。
   */
  categories: any[];
  categoryCounts: Map<string, number>;
  /**
   * **类目 → 绝对序号**（首次出现在当前窗口里时分配的单调递增号）—— 增量维护。
   *
   * 为什么不把「下标」当值：滚动窗口每 tick 从头部淘汰一项，所有下标都要减一，
   * 那样的表每帧都得整体重写（O(n)）。存**绝对序号**之后，淘汰只删一个 key，
   * 「下标」由一个基准量相减得到（见 `rawCategoryIndex`）。
   */
  categorySeq: Map<string, number>;
  /** 下一个要分配的绝对序号。不变式：`首项序号 + 类目数`。 */
  categoryNext: number;
}

/**
 * 类目在**当前** `categories` 里的下标 —— O(1)，给类目轴的 `BandScale.indexOf` 当查表口。
 *
 * 依据：绝对序号按「首次出现顺序」分配，而 `categories` 正是按首次出现顺序排的，
 * 所以存活类目的序号是**连续的一段**（头部淘汰只让这段整体后移；万一出现空洞，
 * `removeCategory` 会就地压紧）。于是「下标 = 自己的序号 − 首项序号」。
 * 调用方负责把类目 `String` 化（与 `BandScale` 的查表契约一致）。
 */
export function rawCategoryIndex(store: SeriesRawPoints, key: string): number {
  const pos = store.categorySeq.get(key);
  if (pos === undefined) return -1;
  const first = store.categories[0];
  if (first === undefined) return 0;
  const base = store.categorySeq.get(String(first));
  return pos - (base === undefined ? 0 : base);
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
   * 列存（虚拟）实时流的**环形缓冲**（`appendData` 之后才有）。
   *
   * 与 `columns` 是同一件事的两种物理布局（连续 vs 环形），上层只借它读
   * `xDomain` / `yDomain` / `xMonotonic` / `sizeExtent` 这几个**域提示**；
   * 真正的取点一律走访问器（环形下标 ≠ 逻辑下标）。
   */
  ring?: SeriesRing | null;
  /**
   * 列存（虚拟）的**分块存储**（亿级数据按需加载）。
   *
   * 与连续列 / 环形缓冲同一套读点契约，区别是「未驻留的点读出来是没有值」——
   * 可见窗口覆盖的块会被请求驻留，到货后重绘。
   */
  chunks?: SeriesChunks | null;
  /** 列存（虚拟）热力图的稠密矩阵；其它系列为 null。 */
  grid?: SeriesGrid | null;
  /** 列存（虚拟）的惰性原始点（自定义系列用）；其它系列为 null。 */
  raw?: SeriesRawPoints | null;
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

/** 取数值：`null` / 空串 / 非数字都算「没有值」（不是 0）。 */
export function toNumber(value: any): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return isFinite(n) ? n : null;
}

/**
 * 通用数据项的取点规则（**唯一一处**）：数组 / 数值 / 对象三种形态都认。
 *
 * 放在这里是因为有**两个消费方**：普通系列的 `buildPoints`，与虚拟（列存）系列的
 * 「惰性原始点」存储（`rawAccessors`）。两边必须是同一份规则 —— 否则「普通系列」与
 * 「virtual 系列」合成出来的 `xValue / y / name / size` 会分叉，提示框和命中跟着漂。
 */
export function readGenericPointInto(
  item: any,
  index: number,
  option: { type?: string; xField?: string; yField?: string },
  out: { xValue: any; y: number | null; size?: number; name?: string; explicitX: boolean }
): typeof out {
  out.xValue = index;
  out.y = null;
  out.size = undefined;
  out.name = undefined;
  out.explicitX = false;
  const item0 = item;
  if (Array.isArray(item)) {
    out.xValue = item[0];
    out.y = toNumber(item[1]);
    // 气泡图：第三维是尺寸
    if (item.length > 2) {
      const parsed = toNumber(item[2]);
      out.size = parsed === null ? undefined : parsed;
    }
    out.explicitX = true;
  } else if (typeof item === 'number' || item === null) {
    out.y = toNumber(item);
  } else if (item && typeof item === 'object') {
    const xField = option.xField || 'x';
    const yField = option.yField || 'y';
    if (item[xField] !== undefined) {
      out.xValue = item[xField];
      out.explicitX = true;
    } else if (item.x !== undefined) {
      out.xValue = item.x;
      out.explicitX = true;
    } else if (item.name !== undefined && option.type === 'bar') {
      out.xValue = item.name;
      out.explicitX = true;
    }
    if (item[yField] !== undefined) out.y = toNumber(item[yField]);
    else if (item.y !== undefined) out.y = toNumber(item.y);
    else if (item.value !== undefined) out.y = toNumber(item.value);
    if (item.size !== undefined) {
      const parsed = toNumber(item.size);
      out.size = parsed === null ? undefined : parsed;
    }
  }
  if (item0 && typeof item0 === 'object' && !Array.isArray(item0) && item0.name !== undefined) {
    out.name = String(item0.name);
  } else if (option.type === 'pie' && Array.isArray(item0) && typeof item0[0] === 'string') {
    out.name = item0[0];
  }
  return out;
}

/**
 * 取点（分配版）：普通系列与列存的 `pointAt` 用。
 *
 * **热循环请用 `readGenericPointInto` + 复用同一个 scratch**：这个版本每次调用都会
 * new 一个对象，10 万项的域重算就是每 tick 10 万个短命对象（实测过，GC 直接顶上来）。
 */
export function readGenericPoint(
  item: any,
  index: number,
  option: { type?: string; xField?: string; yField?: string }
): { xValue: any; y: number | null; size?: number; name?: string; explicitX: boolean } {
  return readGenericPointInto(item, index, option, { xValue: index, y: null, explicitX: false });
}

/** 惰性原始点存储的逻辑第 i 个原始项（环形态按 `(start + i) % capacity` 取）。 */
export function rawItemAt(store: SeriesRawPoints, index: number): any {
  if (index < 0 || index >= store.length) return undefined;
  if (store.capacity <= 0) return store.data[index];
  return store.data[(store.start + index) % store.capacity];
}

/** 按逻辑顺序重算惰性原始点的数据域 / 单调性 / 尺寸范围（追加之后调用）。 */
export function refreshRawDomains(store: SeriesRawPoints): void {
  const rule = { type: store.type, xField: store.xField, yField: store.yField };
  // 复用一个 scratch：热循环里**不分配**（见 readGenericPointInto 的说明）
  const scratch = { xValue: 0 as any, y: null as number | null, size: undefined as number | undefined, name: undefined as string | undefined, explicitX: false };
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let sMin = Infinity;
  let sMax = -Infinity;
  let monotonic = true;
  let prevX = -Infinity;
  let hasSize = false;
  for (let i = 0; i < store.length; i++) {
    const parsed = readGenericPointInto(rawItemAt(store, i), i, rule, scratch);
    const x = Number(parsed.xValue);
    if (isFinite(x)) {
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (x < prevX) monotonic = false;
      prevX = x;
    } else {
      monotonic = false;
    }
    if (parsed.y !== null) {
      if (parsed.y < yMin) yMin = parsed.y;
      if (parsed.y > yMax) yMax = parsed.y;
    }
    if (typeof parsed.size === 'number' && isFinite(parsed.size)) {
      hasSize = true;
      if (parsed.size < sMin) sMin = parsed.size;
      if (parsed.size > sMax) sMax = parsed.size;
    }
  }
  store.xDomain = isFinite(xMin) ? [xMin, xMax] : [0, Math.max(0, store.length - 1)];
  store.yDomain = isFinite(yMin) ? [yMin, yMax] : null;
  store.xMonotonic = monotonic;
  store.sizeExtent = hasSize ? (sMin === sMax ? [sMin, sMin + 1] : [sMin, sMax]) : null;
}

/**
 * 往惰性原始点里追加（`appendData` 的落地）。
 *
 * - `capacity <= 0`：**就地** push 进原来的数组（`data` 还是同一个引用，调用方仍然持有）；
 * - `capacity > 0`：转成**原始环** —— 第一次转换时按容量重新装一遍（只留最后 capacity 项），
 *   之后每次追加都是「写一个槽位 + 挪一次起点」，不用 `shift()` 搬 10 万个元素。
 *
 * 返回（可能换了 data 的）存储；域每次都重算一趟（窗口几千项约 0.02ms，
 * 与数值环同一个取舍：真要做百万级滚动窗口该上分块 + 增量域，而不是在这里加复杂度）。
 */
export function appendRawItems(store: SeriesRawPoints, items: any[], capacity: number): SeriesRawPoints {
  const rule = { type: store.type, xField: store.xField, yField: store.yField };
  // 热循环里复用同一个 scratch（见 readGenericPointInto 的说明）
  const scratch = {
    xValue: 0 as any,
    y: null as number | null,
    size: undefined as number | undefined,
    name: undefined as string | undefined,
    explicitX: false,
  };
  const parsedOf = (item: any): { xValue: any; y: number | null; size?: number; name?: string; explicitX: boolean } =>
    readGenericPointInto(item, 0, rule, scratch);
  /** 逻辑最后一个点的 x：判断单调性要跟它比。 */
  const lastXBefore = store.length ? Number(parsedOf(rawItemAt(store, store.length - 1)).xValue) : -Infinity;
  let prevX = lastXBefore;
  let evictedExtreme = false;
  const noteAdded = (item: any): void => {
    const parsed = parsedOf(item);
    const x = Number(parsed.xValue);
    if (isFinite(x)) {
      if (x < store.xDomain[0]) store.xDomain[0] = x;
      if (x > store.xDomain[1]) store.xDomain[1] = x;
      if (x < prevX) store.xMonotonic = false;
      prevX = x;
    } else {
      store.xMonotonic = false;
    }
    if (parsed.y !== null) {
      if (!store.yDomain) store.yDomain = [parsed.y, parsed.y];
      else {
        if (parsed.y < store.yDomain[0]) store.yDomain[0] = parsed.y;
        if (parsed.y > store.yDomain[1]) store.yDomain[1] = parsed.y;
      }
    }
  };
  /** 淘汰掉的那一项如果正好是当前极值，就不能只增量更新了（要重扫）。 */
  const noteEvicted = (item: any): void => {
    if (item === undefined) return;
    const parsed = parsedOf(item);
    const x = Number(parsed.xValue);
    if (isFinite(x) && (x === store.xDomain[0] || x === store.xDomain[1])) evictedExtreme = true;
    const y = parsed.y;
    if (y !== null && store.yDomain && (y === store.yDomain[0] || y === store.yDomain[1])) evictedExtreme = true;
  };
  if (capacity > 0 && store.capacity !== capacity) {
    // 转成原始环（或换容量）：按逻辑顺序重装，只留最后 capacity 项
    const keep = Math.min(store.length, capacity);
    const buffer = new Array(capacity);
    for (let i = 0; i < keep; i++) {
      buffer[i] = rawItemAt(store, store.length - keep + i);
    }
    store.data = buffer;
    store.capacity = capacity;
    store.start = 0;
    store.length = keep;
    // 类目表跟着**重装**：上面这一步可能丢掉了窗口前面的项，而 categories / categoryCounts /
    // categorySeq 还是按「老的全量」维护的。不重置的话类目轴会把已经不在窗口里的类目也画出来。
    store.categories = [];
    store.categoryCounts = new Map();
    store.categorySeq = new Map();
    store.categoryNext = 0;
    for (let i = 0; i < keep; i++) {
      const parsed = readGenericPointInto(rawItemAt(store, i), 0, rule, scratch);
      const key = String(parsed.xValue);
      const count = store.categoryCounts.get(key) ?? 0;
      if (count === 0) {
        store.categories.push(parsed.xValue);
        store.categorySeq.set(key, store.categoryNext++);
      }
      store.categoryCounts.set(key, count + 1);
    }
  }
  /** 逻辑下标 → 它当前对应的原始项（环形态下就是被覆盖/淘汰的那个）。 */
  const addCategory = (item: any): void => {
    const parsed = readGenericPoint(item, 0, { type: store.type, xField: store.xField, yField: store.yField });
    const key = String(parsed.xValue);
    const count = store.categoryCounts.get(key) ?? 0;
    if (count === 0) {
      store.categories.push(parsed.xValue);
      store.categorySeq.set(key, store.categoryNext++);
    }
    store.categoryCounts.set(key, count + 1);
  };
  const removeCategory = (item: any): void => {
    if (item === undefined) return;
    const parsed = readGenericPoint(item, 0, { type: store.type, xField: store.xField, yField: store.yField });
    const key = String(parsed.xValue);
    const count = store.categoryCounts.get(key) ?? 0;
    if (count <= 1) {
      store.categoryCounts.delete(key);
      const at = store.categories.findIndex((value) => String(value) === key);
      const base = store.categories.length ? store.categorySeq.get(String(store.categories[0])) : undefined;
      const removed = store.categorySeq.get(key);
      store.categorySeq.delete(key);
      if (at >= 0) {
        store.categories.splice(at, 1);
        // 摘掉的**不是首项**时会留下「序号空洞」（序号是单调分配的，被摘的那一号没人补），
        // 空洞会让「序号 − 首项序号」不再等于下标 —— 就地压紧一次（这条路上 splice 本来就是
        // O(n)，而且它只在「同一个类目在窗口里还出现第二次、且最后一次被淘汰时前面还有别的类目」
        // 这种形态才走到；单调滚动的 K 线窗口永远走不到）。
        if (removed !== undefined && removed !== base) {
          for (let i = 0; i < store.categories.length; i++) {
            store.categorySeq.set(String(store.categories[i]), i);
          }
          store.categoryNext = store.categories.length;
        }
      }
      return;
    }
    store.categoryCounts.set(key, count - 1);
  };
  if (store.capacity > 0) {
    for (const item of items) {
      let slot: number;
      let evicted: any;
      if (store.length >= store.capacity) {
        slot = store.start;
        evicted = store.data[slot];
        store.start = (store.start + 1) % store.capacity;
      } else {
        slot = (store.start + store.length) % store.capacity;
        store.length += 1;
      }
      if (evicted !== undefined) removeCategory(evicted);
      store.data[slot] = item;
      addCategory(item);
      noteEvicted(evicted);
      noteAdded(item);
    }
  } else {
    for (const item of items) {
      store.data.push(item);
      addCategory(item);
      noteAdded(item);
    }
    store.length = store.data.length;
  }
  /**
   * 域走**增量**：追加只影响新来的这一根，淘汰只在「淘汰掉当前极值」时才需要重扫。
   *
   * 之前这里每 tick 无条件重扫全量：10 万根的滚动窗口实测比「全量 setData」还慢
   * （2.5ms vs 1.4ms）—— 因为重扫要给每一项重新取一次字段（`readGenericPointInto`），
   * 而 setData 那条路读的是已经物化好的点。增量之后环形写入只剩 O(1)。
   */
  if (evictedExtreme) refreshRawDomains(store);
  return store;
}

/**
 * 惰性原始点的访问器：**按需合成** `DataPoint`（`raw` 仍然给得出来，这是它与数值列的区别）。
 * 字段规则与 `buildPoints` 的通用分支共用 `readGenericPoint`。
 */
export function rawAccessors(
  store: SeriesRawPoints
): Pick<InternalSeries, 'pointAt' | 'xValueAt' | 'yValueAt' | 'baseAt' | 'topAt' | 'sizeAt'> {
  const option = { type: store.type, xField: store.xField, yField: store.yField };
  const readAt = (index: number): ReturnType<typeof readGenericPoint> | null => {
    const item = rawItemAt(store, index);
    if (item === undefined && (index < 0 || index >= store.length)) return null;
    return readGenericPoint(item, index, option);
  };
  return {
    pointAt: (index: number): DataPoint => {
      const parsed = readAt(index);
      if (!parsed) return undefined as unknown as DataPoint;
      return {
        index,
        xValue: parsed.xValue,
        y: parsed.y,
        raw: rawItemAt(store, index),
        base: 0,
        top: parsed.y === null ? 0 : parsed.y,
        name: parsed.name,
        size: parsed.size,
      };
    },
    xValueAt: (index: number): any => {
      const parsed = readAt(index);
      return parsed ? parsed.xValue : undefined;
    },
    yValueAt: (index: number): number | null => {
      const parsed = readAt(index);
      return parsed ? parsed.y : null;
    },
    baseAt: (): number => 0,
    topAt: (index: number): number => {
      const parsed = readAt(index);
      return parsed && parsed.y !== null ? parsed.y : 0;
    },
    sizeAt: (index: number): number | undefined => {
      const parsed = readAt(index);
      return parsed ? parsed.size : undefined;
    },
  };
}

/**
 * 稠密矩阵（热力图）的访问器：下标 → 行列 → 类目 + 值，**按需合成**一个数据点。
 *
 * 命中 / 提示框要的 `xValue`（列类目）与 `name`（行类目）都与普通热力图的
 * `DataPoint` 语义逐字对齐，所以上层的提示框、图例、无障碍不需要知道存储形态。
 */
export function gridAccessors(
  grid: SeriesGrid
): Pick<InternalSeries, 'pointAt' | 'xValueAt' | 'yValueAt' | 'baseAt' | 'topAt' | 'sizeAt'> {
  const cols = grid.xCategories.length;
  const valueAt = (index: number): number | null => {
    const raw = grid.values[index];
    return isNaNNumber(raw) ? null : raw;
  };
  return {
    pointAt: (index: number): DataPoint => {
      const col = cols > 0 ? index % cols : index;
      const row = cols > 0 ? (index - col) / cols : 0;
      const value = valueAt(index);
      const name = grid.yCategories[row];
      return {
        index,
        xValue: grid.xCategories[col],
        y: value,
        raw: undefined,
        base: 0,
        top: value === null ? 0 : value,
        name: name === undefined ? undefined : String(name),
      };
    },
    xValueAt: (index: number): any => (cols > 0 ? grid.xCategories[index % cols] : grid.xCategories[index]),
    yValueAt: valueAt,
    baseAt: (): number => 0,
    topAt: (index: number): number => {
      const value = valueAt(index);
      return value === null ? 0 : value;
    },
    sizeAt: (): number | undefined => undefined,
  };
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
  /**
   * 类目轴的**现成查表口**（可选）：`类目 key → 下标`，O(1)。
   *
   * 域来自某个增量维护的类目表时给得出来（见 `buildXDomain`），**包括被视窗裁成一段**的
   * 情况（那时查表口给整张表的下标，配上 `categoryOffset` 换算成窗口内下标）。
   * 给了它等于告诉 `BandScale`：不必自己重建索引表 —— 10 万类目的滚动窗口每帧重建一次
   * 那张 Map，曾是整条流水线最大的一笔。
   */
  categoryLookup?: (key: string) => number;
  /**
   * 域起点在**整张类目表**里的下标（域就是整张表时为 0）。
   *
   * 与 `categoryLookup` 成对使用：查表口按整张表编号，域被视窗裁成一段之后，
   * 「窗口内下标 = 全表下标 − 这个偏移」。
   */
  categoryOffset?: number;
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
  /**
   * **惰性格式化**：`labels[i] === ''` 且给了这个函数时，第 i 颗的文本要现算（可选）。
   *
   * 类目轴一个数据点一个刻度，而真正画得出来的只有抽稀后那几百颗 —— 稠密轴（> 512 颗）
   * 因此只在布局那一趟格式化**量宽度用的样本**，其余留空，抽稀定稿后由
   * `thinXAxisLabels` 按留下来的下标现算。数值 / 时间轴刻度本来就少，走全量那条路。
   */
  formatLabel?: (index: number) => string;
  /** 布局那一趟按样本量到的最大标签宽度（惰性格式化时 `labels` 里只有样本，不能再抽样）。 */
  sampledLabelWidth?: number;
  /**
   * **抽稀之后仍然要画的那些刻度的原下标**（升序）。
   *
   * `undefined` = 没有抽稀（整张 `ticks` 都要画）。给定之后，热路径只该按这张表走：
   * `Axis` 不再遍历整条 `ticks`（10 万类目里只有十几颗要画），`GridLines` 的竖线
   * 也直接按它取位置。`ticks` / `labels` 的长度与下标对齐关系**保持不变** ——
   * 它们仍然是「整条轴」的事实来源，只是没人再逐项扫一遍了。
   */
  visible?: number[];
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
