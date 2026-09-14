import type { InternalSeries } from '../../internal';
import { BarSeries } from './BarSeries';
import { AreaSeries } from './AreaSeries';
import { LineSeries } from './LineSeries';
import { ScatterSeries } from './ScatterSeries';
import { PieSeries } from './PieSeries';
import { RadarSeries } from './RadarSeries';
import { CandlestickSeries } from './CandlestickSeries';
import { HeatmapSeries } from './HeatmapSeries';
import { SankeySeries } from './SankeySeries';
import { FunnelSeries } from './FunnelSeries';
import { GaugeSeries } from './GaugeSeries';
import { BoxplotSeries } from './BoxplotSeries';
import { WaterfallSeries } from './WaterfallSeries';
import { TreemapSeries } from './TreemapSeries';
import { GraphSeries } from './GraphSeries';
import { FunctionSeries } from './FunctionSeries';
import { ParametricSeries } from './ParametricSeries';
import { LiquidSeries } from './LiquidSeries';
import { SeriesBase } from './SeriesBase';

export interface SeriesComponentProps {
  left: number;
  top: number;
  width: number;
  height: number;
  zIndex?: number;
}

/** 系列工厂：拿到归一化后的内部系列 + 组件盒，返回一个渲染组件。 */
export type SeriesFactory = (series: InternalSeries, props: SeriesComponentProps) => SeriesBase;

/**
 * 内置类型。这些**不允许被覆盖**：覆盖会让同一份 option 在不同环境画出不同的图，
 * 而 option 是要存盘、要跨端复现的。
 */
const BUILTIN: Record<string, SeriesFactory> = {
  bar: (series, props) => new BarSeries(series, props),
  area: (series, props) => new AreaSeries(series, props),
  line: (series, props) => new LineSeries(series, props),
  scatter: (series, props) => new ScatterSeries(series, props),
  pie: (series, props) => new PieSeries(series, props),
  radar: (series, props) => new RadarSeries(series, props),
  candlestick: (series, props) => new CandlestickSeries(series, props),
  heatmap: (series, props) => new HeatmapSeries(series, props),
  sankey: (series, props) => new SankeySeries(series, props),
  funnel: (series, props) => new FunnelSeries(series, props),
  gauge: (series, props) => new GaugeSeries(series, props),
  boxplot: (series, props) => new BoxplotSeries(series, props),
  waterfall: (series, props) => new WaterfallSeries(series, props),
  treemap: (series, props) => new TreemapSeries(series, props),
  graph: (series, props) => new GraphSeries(series, props),
  function: (series, props) => new FunctionSeries(series, props),
  parametric: (series, props) => new ParametricSeries(series, props),
  liquid: (series, props) => new LiquidSeries(series, props),
};

/** 自定义类型注册表。 */
const CUSTOM: Record<string, SeriesFactory> = {};

const TYPE_NAME = /^[a-zA-Z][\w-]*$/;

/**
 * 注册一个自定义系列类型。
 *
 * 图表不是封闭渲染器：任何继承 `SeriesBase` 的组件都能作为一等系列接进来 ——
 * 它拿到归一化后的数据点（`series.points`）与直角坐标比例尺（`coord.xScale` / `yScale`），
 * 于是命中判定、悬停高亮、提示框、图例、序列化全部自动生效。
 *
 * ```ts
 * class SparkSeries extends SeriesBase {
 *   public seriesType = 'sparkline';
 *   protected doRender() { this.rebuildPixels(); ... }   // 用 this.pixels 画
 *   public hitTestIndex(x, y) { ... }                    // 返回点下标或 -1
 * }
 * registerSeriesType('sparkline', (series, props) => new SparkSeries(series, props));
 * ```
 */
export function registerSeriesType(type: string, factory: SeriesFactory): void {
  if (typeof type !== 'string' || !TYPE_NAME.test(type)) {
    throw new Error(
      `[ice-chart] registerSeriesType：类型名必须是非空字符串（字母开头，可含数字 / 下划线 / 连字符），收到「${String(type)}」`
    );
  }
  if (typeof factory !== 'function') {
    throw new Error('[ice-chart] registerSeriesType：factory 必须是函数');
  }
  if (Object.prototype.hasOwnProperty.call(BUILTIN, type)) {
    throw new Error(`[ice-chart] registerSeriesType：「${type}」是内置类型，不能覆盖（会破坏 option 的跨端可复现性）`);
  }
  const existing = CUSTOM[type];
  if (existing && existing !== factory) {
    throw new Error(`[ice-chart] registerSeriesType：「${type}」已经注册过另一个工厂，先 unregisterSeriesType 再注册`);
  }
  CUSTOM[type] = factory;
}

/** 注销自定义类型；返回它之前是否存在。 */
export function unregisterSeriesType(type: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(CUSTOM, type)) return false;
  delete CUSTOM[type];
  return true;
}

/** 取某个类型的工厂（内置优先，其次自定义）；没有则返回 null。 */
export function getSeriesTypeFactory(type: string): SeriesFactory | null {
  if (Object.prototype.hasOwnProperty.call(BUILTIN, type)) return BUILTIN[type];
  return CUSTOM[type] || null;
}

/** 当前可用的全部类型名（内置 + 已注册的自定义）。 */
export function listSeriesTypes(): string[] {
  return [...Object.keys(BUILTIN), ...Object.keys(CUSTOM)];
}

export function isBuiltinSeriesType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN, type);
}

/**
 * 按系列类型创建对应的渲染组件。
 *
 * 查找顺序：内置 → 自定义 → 兜底 `line`。未注册的类型当成折线画，
 * 这样「用了某个环境才注册的自定义类型」的 option 在别的环境里至少还能画出数据，
 * 而不是整张图空白。
 */
export function createSeriesComponent(series: InternalSeries, props: SeriesComponentProps): SeriesBase {
  const factory = getSeriesTypeFactory(String(series.type)) || BUILTIN.line;
  return factory(series, props);
}

/** 仅供测试使用：清空自定义注册表。 */
export function clearCustomSeriesTypes(): void {
  for (const key of Object.keys(CUSTOM)) delete CUSTOM[key];
}
