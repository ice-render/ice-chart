import { ICE, ICEGroup, ICE_EVENT_NAME_CONSTS } from 'ice-render';
import type {
  AnnotationDiagnostic,
  ChartMarkData,
  ChartMarkHandle,
  ChartMarkSpec,
  ChartOption,
  DataItem,
  LegendToggleParams,
} from './types';
import type { ChartLayout, InternalSeries, NormalizedOption, Rect } from './internal';
import { normalizeOption, toSerializableOption } from './option/normalize';
import { applyChartThemeToEngine } from './theme/chartEngineBridge';
import { computeLayout } from './layout/layout';
import { createScale, formatTick, type Scale } from './scale';
import { GridLines } from './components/GridLines';
import { Annotation } from './components/Annotation';
import { PlotArea } from './components/PlotArea';
import { Axis } from './components/Axis';
import { Legend } from './components/Legend';
import { Title } from './components/Title';
import { Tooltip } from './components/Tooltip';
import { Crosshair } from './components/Crosshair';
import { Highlight } from './components/Highlight';
import { Brush } from './components/Brush';
import { RadarGrid } from './components/RadarGrid';
import { PolarGrid } from './components/PolarGrid';
import { DataZoomSlider } from './components/DataZoomSlider';
import { createSeriesComponent } from './components/series/createSeries';
import type { SeriesBase } from './components/series/SeriesBase';
import { InteractionController } from './interaction/InteractionController';
import { Emitter } from './util/emitter';
import { clamp } from './util/math';
import { clampBarCount } from './util/zoomLimit';
import { A11yMirror, buildDataNodes, buildDataTable, chartTitle, type A11yTreeOptions, type DataTable } from './a11y';
import { layoutSankey } from './layout/sankey';
import { layoutTreemap } from './layout/treemap';
import { forceLayout } from './layout/force';
import { shouldAnimate } from './animation/motion';

const Z = {
  plotArea: 10,
  grid: 20,
  series: 100,
  /** 数据坐标图元（注释 / 阈值线 / 预测带）：压在系列之上、坐标轴与覆盖层之下 */
  mark: 300,
  /** 标注图层（目标线 / 异常点 / 目标区间）：在数据图元之上、坐标轴与覆盖层之下 */
  annotation: 310,
  axis: 400,
  title: 450,
  legend: 500,
  crosshair: 600,
  highlight: 620,
  brush: 640,
  tooltip: 700,
};

/** 快照格式版本：结构变化时递增，还原时校验。 */
export const SNAPSHOT_VERSION = 1;

export { setMotionPreference, getMotionPreference, shouldAnimate } from './animation/motion';
export type { MotionPreference } from './animation/motion';

export interface SnapshotRestoreOptions {
  /**
   * 还原时叠加的非序列化配置补丁（formatter、函数型回调等）。
   * series 按 id 或下标逐项合并，不会覆盖快照里的数据。
   */
  optionPatch?: Partial<ChartOption> & { series?: any[] };
}

export interface ChartSnapshot {
  version: number;
  option: ChartOption;
  view: { x: [any, any] | null; y: [any, any] | null; yAxes: Array<[any, any] | null> };
  hidden: Record<string, boolean>;
  hiddenSlices: Record<string, boolean>;
}

/** 判断一个对象是不是 ice-chart 快照（用于 createChart 的入参分派）。 */
export function isChartSnapshot(value: any): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !!value.option &&
    ('version' in value || 'view' in value || 'hidden' in value)
  );
}

/** 把补丁合进快照里的 option：series 按 id/下标逐项合并，其余字段浅覆盖。 */
export function mergeOptionPatch(base: any, patch: any): any {
  const out: any = { ...base, ...patch };
  if (Array.isArray(patch && patch.series) && Array.isArray(base && base.series)) {
    out.series = base.series.map((series: any, index: number) => {
      const byId = patch.series.find((p: any) => p && p.id && series && series.id && p.id === series.id);
      const positional = patch.series[index];
      // 带 id 的补丁只按 id 合并；按下标的补丁必须自己没有 id。
      // 否则「补丁里的第 0 条是 B」会被误合并到快照里的第 0 条 A 上（把 A 变成 B）。
      const match = byId || (positional && !positional.id ? positional : undefined);
      return match ? { ...series, ...match } : series;
    });
  }
  return out;
}

export interface ICEChartOptions {
  renderMode?: 'dirty-rect' | 'full';
  dpr?: number;
  /** 监听容器尺寸变化并自动重排（需要 ResizeObserver）。 */
  autoResize?: boolean;
}

export interface ApplyOptionOptions {
  /** true = 播「更新」动画；'enter' = 播「入场」动画；false = 不播。 */
  animate?: boolean | 'enter' | 'update';
  /** 保留当前缩放窗口（图例切换、数据更新时用）。 */
  preserveView?: boolean;
}

/**
 * ICEChart：把一份声明式 option 编译成 ice-render 组件树，并挂上交互层。
 *
 * 分工：
 * - 归一化（数据 → 数据域 / 堆叠）由 option/normalize 负责，纯函数、可单测；
 * - 布局（标题 / 图例 / 坐标轴 / 绘图区）由 layout 负责，纯函数、可单测；
 * - 渲染由 ice-render 组件负责（脏矩形局部重绘、离屏缓存、HiDPI 全部由引擎兜底）；
 * - 交互由 InteractionController 负责，对外只抛语义事件。
 */
export class ICEChart {
  public ice: ICE;
  public option: ChartOption;
  public norm!: NormalizedOption;
  public layout!: ChartLayout;
  public root: ICEGroup;
  public plotArea: PlotArea;
  public grid: GridLines;
  public annotation: Annotation;
  public radarGrid: RadarGrid;
  /** 极坐标网格（r(θ) 曲线用；画在直角坐标场景里，配合 aspect:'equal'）。 */
  public polarGrid: PolarGrid;
  public axisX: Axis;
  /** y 轴组件，与 norm.yAxes 一一对应（axisYList[0] 是主 y 轴）。 */
  public axisYList: Axis[] = [];
  public legend: Legend | null = null;
  public titleComponent: Title | null = null;
  public tooltip: Tooltip | null = null;
  public crosshair: Crosshair | null = null;
  public highlight: Highlight | null = null;
  public brushComponent: Brush | null = null;
  public dataZoomSlider: DataZoomSlider | null = null;
  public seriesComponents: SeriesBase[] = [];
  public controller: InteractionController;
  /** 数据坐标图元的容器（注释 / 阈值线 / 预测带）。 */
  public markLayer: ICEGroup | null = null;
  private marks: Array<{ id: string; spec: ChartMarkSpec; component: any; dragging: boolean }> = [];
  private markSeq = 0;
  /** 摆位期间（chart 自己移动图元）不要当成用户拖拽。 */
  private syncingMarks = false;

  /** 交互层使用的别名（与 InteractionHost 接口约定一致）。 */
  public get brush(): Brush | null {
    return this.brushComponent;
  }

  /** 未经缩放/筛选的完整数据域（缩放约束与跨图联动用）。 */
  public fullXDomain: any[] = [];
  public fullYDomain: any[] = [];
  /** 每个 y 轴的完整数据域（未缩放）。 */
  public fullYDomains: any[][] = [];

  private emitter = new Emitter();
  private canvasEl: any;
  private chartOptions: ICEChartOptions;
  private viewState: {
    x: [any, any] | null;
    y: [any, any] | null;
    /** 非主轴 y 轴的窗口（多轴叠加时各自独立缩放）。 */
    yAxes: Array<[any, any] | null>;
  } = { x: null, y: null, yAxes: [] };
  /** 存在 function 系列时为真：y 轴数据域每次重建都按可视 x 区间重算（自动贴合）。 */
  private autoYCurve = false;
  private hiddenIds: Record<string, boolean> = {};
  private hiddenSlices: Record<string, boolean> = {};
  private seriesSignature = '';
  private axisSignature = '';
  private resizeObserver: any = null;
  private destroyed = false;
  /** 抑制对外事件的重入深度（跨图联动时避免 A→B→A 的回环）。 */
  private silenceDepth = 0;
  /** 上一次推给引擎的图表主题指纹（避免重复推：推一次会让引擎整棵树标脏）。 */
  private __appliedEngineThemeKey: string | null = null;
  /**
   * 引擎主题变更的退订函数（`theme:'auto'` 被动跟随，见 `onThemeChange`）。
   *
   * 以前 `auto` 只在**建图 / setOption 那一刻采样一次**引擎明暗：宿主之后调
   * `ice.setTheme('dark')`，图表的轴 / 系列 / 图例全是亮色纹丝不动。引擎 2.6 起会广播主题变更，
   * 这里订阅、重新归一化（明暗重新判定）并重绘。
   */
  private __offThemeFollow: (() => void) | null = null;
  private a11yMirror = new A11yMirror(this);
  /**
   * 更新动画期间的坐标轴数据域过渡。
   *
   * 数据更新时 y 轴数据域常常会变（例如最大值从 50 掉到 40），如果域瞬跳，
   * 柱子会在动画**开始的那一帧**整体位移一下，值插值反而看不见。
   * 所以域要和系列的值一起插值：每帧按同一进度重算域与坐标，动画结束时再回到常规路径。
   */
  private domainTransition: { from: number[]; to: number[] } | null = null;
  private domainFrameHandler: any = null;

  constructor(target: any, option: ChartOption, chartOptions: ICEChartOptions = {}) {
    if (!target) throw new Error('[ice-chart] 初始化失败：缺少 canvas 元素或其 id。');
    this.chartOptions = chartOptions;
    this.option = option;
    this.ice = new ICE();
    this.ice.init(target, { renderMode: chartOptions.renderMode || 'dirty-rect', dpr: chartOptions.dpr });
    this.canvasEl = this.ice.canvasEl || target;
    this.registerTypes();

    const canvas = this.canvasRect();
    this.root = new ICEGroup({
      left: 0,
      top: 0,
      width: canvas.width,
      height: canvas.height,
      origin: 'top-left',
      fill: false,
      stroke: false,
      interactive: false,
      draggable: false,
      transformable: false,
      linkable: false,
      clipChildren: true,
      zIndex: 0,
    });
    this.ice.addChild(this.root);

    this.plotArea = new PlotArea({ left: 0, top: 0, width: 1, height: 1, zIndex: Z.plotArea });
    this.grid = new GridLines({ width: canvas.width, height: canvas.height, zIndex: Z.grid });
    this.annotation = new Annotation({ width: canvas.width, height: canvas.height, zIndex: Z.annotation });
    this.radarGrid = new RadarGrid({ width: canvas.width, height: canvas.height, zIndex: Z.grid + 5 });
    this.polarGrid = new PolarGrid({ width: canvas.width, height: canvas.height, zIndex: Z.grid + 6 });
    this.axisX = new Axis({ orientation: 'x', width: canvas.width, height: canvas.height, zIndex: Z.axis });
    this.axisYList = [
      new Axis({ orientation: 'y', width: canvas.width, height: canvas.height, zIndex: Z.axis, axisIndex: 0, position: 'left' }),
    ];
    this.legend = new Legend({ width: canvas.width, height: canvas.height, zIndex: Z.legend });
    this.titleComponent = new Title({ width: canvas.width, height: canvas.height, zIndex: Z.title });
    this.crosshair = new Crosshair({ width: canvas.width, height: canvas.height, zIndex: Z.crosshair });
    this.highlight = new Highlight({ width: canvas.width, height: canvas.height, zIndex: Z.highlight });
    this.brushComponent = new Brush({ width: canvas.width, height: canvas.height, zIndex: Z.brush });
    this.dataZoomSlider = new DataZoomSlider({ left: 0, top: 0, width: canvas.width, height: 26, zIndex: Z.brush + 5 });
    this.tooltip = new Tooltip({ width: canvas.width, height: canvas.height, zIndex: Z.tooltip });

    this.root.addChildren([
      this.plotArea,
      this.grid,
      this.annotation,
      this.radarGrid,
      this.polarGrid,
      this.axisX,
      ...this.axisYList,
      this.titleComponent,
      this.legend,
      this.crosshair,
      this.highlight,
      this.brushComponent,
      this.dataZoomSlider,
      this.tooltip,
    ]);

    this.controller = new InteractionController(this);
    // 首次渲染也要播「入场」动画（历史 bug：构造时传 animate:false，导致进场是硬切）
    this.applyOption(option, { animate: 'enter', preserveView: false });
    this.controller.bind();

    // `theme:'auto'` 的"跟随引擎"要覆盖**引擎之后的变化**，不只是建图那一刻。
    // 主题是可随时 setOption 改的（auto → 显式），所以订阅一次、在回调里判"当前是不是 auto"。
    this.__offThemeFollow = this.ice.onThemeChange(({ kind }) => {
      // 只有交互外壳变了不影响图表配色；auto 的明暗由引擎主题的背景亮度决定，只看 'theme'。
      if (kind !== 'theme' || this.destroyed) return;
      if (!this.option || this.option.theme !== 'auto') return;
      this.rebuild(false);
    });

    if (chartOptions.autoResize) this.observeResize();
  }

  // ------------------------------------------------------------- 对外 API

  /** 更新配置。默认保留当前缩放窗口，可用 resetZoom 恢复。 */
  public setOption(option: ChartOption, options: ApplyOptionOptions = {}): this {
    this.applyOption(option, { animate: options.animate === undefined ? true : options.animate, preserveView: options.preserveView !== false });
    return this;
  }

  /** 取当前配置（函数字段保留；持久化请用 toJSON）。 */
  public getOption(): ChartOption {
    return this.option;
  }

  /**
   * 函数绘图 / 参数曲线的表达式诊断（**回答「用户是不是写错了公式」**）。
   *
   * 三类都覆盖：
   * - `error`：语法错误（带位置）、未定义的变量、在当前区间内没有任何可绘制的值；
   * - `warning`：参数定义了没用上、输出恒定（画出来是一条水平线）。
   *
   * 表达式来自用户输入，写错**不会**让图表崩掉（那会让表单很难用），
   * 但错误必须能被拿到：表单据此标红 / 提示，控制台不必猜。
   */
  public expressionDiagnostics(): Array<{ seriesId: string; diagnostics: NonNullable<InternalSeries['expressionDiagnostics']> }> {
    const out: Array<{ seriesId: string; diagnostics: NonNullable<InternalSeries['expressionDiagnostics']> }> = [];
    for (const series of this.norm.series) {
      if (series.expressionDiagnostics && series.expressionDiagnostics.length) {
        out.push({ seriesId: series.id, diagnostics: series.expressionDiagnostics });
      }
    }
    return out;
  }

  /** 只取错误（标红用）。需要警告（提示用）请用 `expressionDiagnostics()`。 */
  public expressionErrors(): Array<{ seriesId: string; message: string }> {
    const out: Array<{ seriesId: string; message: string }> = [];
    for (const series of this.norm.series) {
      if (!series.expressionDiagnostics) continue;
      for (const diagnosis of series.expressionDiagnostics) {
        if (diagnosis.severity === 'error') out.push({ seriesId: series.id, message: diagnosis.message });
      }
    }
    return out;
  }

  /**
   * 标注诊断（**回答「我写的目标线为什么没出来」**）。
   *
   * `error` 表示**这条标注写错了**（值缺失 / 不是合法数值 / 类目不存在 / 日期解析不出来）——
   * 表单该标红；`warning` 表示写对了但当前画不出来，两种来源：值在可视域外（缩放或数据更新
   * 之后它可能又会出现）、当前场景没有直角坐标系（饼图 / 雷达 / 桑基 / 树图）。
   *
   * 与表达式诊断同款：坏标注**不让图表崩**，也不影响其它标注。
   */
  public annotationDiagnostics(): AnnotationDiagnostic[] {
    return this.annotation ? this.annotation.diagnostics.slice() : [];
  }

  /** 只取标注错误（表单标红用）。需要提示（越界等）请用 `annotationDiagnostics()`。 */
  public annotationErrors(): AnnotationDiagnostic[] {
    return this.annotationDiagnostics().filter((item) => item.severity === 'error');
  }

  /** 更新单个系列的数据。 */
  public setData(seriesIdOrIndex: string | number, data: DataItem[]): this {
    const series = (this.option.series || []).map((item, index) => ({ item, index }));
    const target = series.find((s) => (typeof seriesIdOrIndex === 'number' ? s.index === seriesIdOrIndex : s.item.id === seriesIdOrIndex || s.item.name === seriesIdOrIndex));
    if (!target) throw new Error(`[ice-chart] 找不到系列：${seriesIdOrIndex}`);
    target.item.data = data;
    this.applyOption(this.option, { animate: true, preserveView: true });
    this.emit('data:change', { seriesId: target.item.id, seriesIndex: target.index });
    return this;
  }

  /**
   * **追加**数据（实时数据流专用）：把新点接到系列末尾，超出 `maxPoints` 时从头裁掉，
   * 形成滑动窗口。相对 `setData` 的两点差别：
   *
   * 1. **不做值插值**（`animate` 默认 false）：窗口滑动会让下标整体前移，
   *    插值会把「这一点」插向「下一点的值」，看起来像被拖住。
   *    流畅度由推送频率决定（60Hz 推送就是 60fps 的平滑滚动）；
   * 2. 只重算被追加的系列所在的那条链路（走 `applyOption` 的常规更新路径，`preserveView` 保持缩放窗口）。
   *
   * ```ts
   * chart.appendData('cpu', [[t, value]], { maxPoints: 180 });
   * ```
   */
  public appendData(
    seriesIdOrIndex: string | number,
    items: DataItem[],
    options: { maxPoints?: number; animate?: boolean } = {}
  ): this {
    // 传 undefined 会「碰巧」命中第一个没有 id 的系列（真踩过），直接拦掉
    if (seriesIdOrIndex === undefined || seriesIdOrIndex === null) {
      throw new Error('[ice-chart] appendData 需要系列 id / name / 下标。');
    }
    const list = (this.option.series || []).map((item, index) => ({ item, index }));
    const target = list.find((s) =>
      typeof seriesIdOrIndex === 'number' ? s.index === seriesIdOrIndex : s.item.id === seriesIdOrIndex || s.item.name === seriesIdOrIndex
    );
    if (!target) throw new Error(`[ice-chart] 找不到系列：${seriesIdOrIndex}`);
    const appended = Array.isArray(items) ? items : [];
    if (!appended.length) return this;
    const next = (target.item.data || []).concat(appended);
    const maxPoints = Number(options.maxPoints);
    target.item.data =
      isFinite(maxPoints) && maxPoints > 0 && next.length > maxPoints ? next.slice(next.length - maxPoints) : next;
    this.applyOption(this.option, { animate: options.animate === true, preserveView: true });
    this.emit('data:change', { seriesId: target.item.id, seriesIndex: target.index });
    return this;
  }

  /** 设置数据域（缩放 / 联动入口）。 */
  public setDomain(axis: 'x' | 'y', domain: any[], source = 'api'): this {
    if (this.destroyed) return this;
    // 用户手势（滚轮 / 滑块 / 框选）产生的窗口要过一遍「至少盖住 2 个数据点」的兜底：
    // 否则窗口可能只剩一个点，曲线退化成一个小圆点 —— 看起来就是「缩成一团」。
    // 程序化调用（api）与联动（link）保持精确：联动要的是两张图窗口严格一致。
    const guarded =
      axis === 'x' && (source === 'zoom' || source === 'brush')
        ? this.guardInteractiveXWindow(domain)
        : domain;
    const clamped = this.clampDomain(axis, guarded, source);
    if (!clamped) return this;
    if (axis === 'x') this.viewState.x = clamped as [any, any];
    else this.viewState.y = clamped as [any, any];
    this.rebuild(false);
    const range = this.currentRange();
    this.emit(source === 'pan' ? 'pan:change' : 'zoom:change', range);
    return this;
  }

  /** 数值轴的数据点 x 值（升序去重），给「窗口至少盖住 2 个点」的兜底用。 */
  private numericXValues(): number[] {
    const set = new Set<number>();
    for (const series of this.norm.series) {
      for (let i = 0; i < series.pointCount; i++) {
        const point = series.pointAt(i);
        const value = Number(point.xValue);
        if (isFinite(value)) set.add(value);
      }
    }
    return [...set].sort((a, b) => a - b);
  }

  /**
   * 交互产生的新窗口兜底。
   *
   * - 类目轴：窗口至少要包含 **2 个类目**（一个类目画不出线段，柱子会占满整个绘图区）；
   * - 数值 / 时间轴：窗口至少要盖住 **2 个数据点**，不够就朝最近的一侧扩。
   *
   * 起因是实测：dataZoom 滑块拖到最右（窗口 [0.98, 1]）时，30 天逐日的数据只剩一个点，
   * 整条曲线变成一个小圆点（墨迹 0×0）。滚轮缩放有 `minSpan` 兜着，滑块这条路径当时没有。
   */
  private guardInteractiveXWindow(domain: any[]): any[] {
    if (this.norm.xAxis.type === 'category') {
      const full = this.fullXDomain as any[];
      if (full.length < 2) return domain;
      let from = full.indexOf(domain[0]);
      let to = full.indexOf(domain[1]);
      if (from < 0 && to < 0) return domain;
      if (from < 0) from = 0;
      if (to < 0) to = full.length - 1;
      if (to - from >= 1) return domain;
      // 只剩一个类目：优先往「还有类目」的一侧扩一格
      if (from > 0) from -= 1;
      else if (to < full.length - 1) to += 1;
      return [full[from], full[to]];
    }
    const xs = this.numericXValues();
    if (xs.length < 2) return domain;
    // 数据只有两个点时，"至少 2 个点"等于禁止缩放（本来就画不出线段），放宽到 1 个点
    const need = xs.length >= 3 ? 2 : 1;
    let lo = Number(domain[0]);
    let hi = Number(domain[1]);
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return domain;
    let inside = xs.filter((v) => v >= lo && v <= hi).length;
    let guard = 0;
    while (inside < need && guard < 4) {
      guard += 1;
      const left = [...xs].reverse().find((v) => v < lo);
      const right = xs.find((v) => v > hi);
      if (left === undefined && right === undefined) break;
      const dLeft = left === undefined ? Infinity : lo - left;
      const dRight = right === undefined ? Infinity : right - hi;
      if (dLeft <= dRight) {
        lo = left as number;
      } else {
        hi = right as number;
      }
      inside = xs.filter((v) => v >= lo && v <= hi).length;
    }
    return inside >= need ? [lo, hi] : domain;
  }

  // ------------------------------------------------------- 数据坐标图元（mark）

  /**
   * 把一个**引擎图元**挂到数据坐标上：注释卡片 / 阈值线 / 目标线 / 预测带。
   *
   * 组件由调用方创建（`new ICEStar(...)` / `new ICERect(...)` / 自定义组件），
   * chart 负责：
   * - 按数据坐标摆位（缩放 / 平移 / 数据更新后自动跟随，不脱锚）；
   * - 线 / 带按绘图区尺寸定尺寸；
   * - 数据点移出可视区时自动隐藏（`hideWhenOutOfView`，默认 true）；
   * - 可拖拽时把拖完的位置反解成数据坐标写回，并抛 `mark:drag` / `mark:dragend`。
   *
   * 因为组件是引擎的一等公民，它同时拥有命中测试、事件、关键帧动画与序列化能力。
   */
  public addMark(spec: ChartMarkSpec): ChartMarkHandle {
    const id = spec.id || `mark-${++this.markSeq}`;
    if (this.marks.some((m) => m.id === id)) {
      throw new Error(`[ice-chart] addMark：id「${id}」已经存在`);
    }
    if (!spec || !spec.component) {
      throw new Error('[ice-chart] addMark：必须提供 component（一个引擎图元实例）');
    }
    const kind = spec.type || 'point';
    if (kind !== 'point' && kind !== 'xLine' && kind !== 'yLine' && kind !== 'xBand' && kind !== 'yBand') {
      throw new Error(`[ice-chart] addMark：不支持的 type「${String(kind)}」`);
    }
    const mark = { id, spec: { ...spec, id }, component: spec.component, dragging: false };
    this.marks.push(mark);
    this.ensureMarkLayer().addChild(spec.component);
    // 用户拖动图元 → 反解成数据坐标回写（用 AFTER_MOVE：拖拽过程与程序化移动都会触发，
    // 所以摆位期间用 syncingMarks 兜住，避免「自己摆一下也算用户拖了」）
    if (typeof spec.component.on === 'function') {
      spec.component.on(ICE_EVENT_NAME_CONSTS.AFTER_MOVE, (evt: any) => {
        if (this.syncingMarks) return;
        // 用事件载荷里的 left/top：引擎在 BEFORE_MOVE → 改 state → AFTER_MOVE 之间更新状态，
        // 直接读 state 有可能会拿到旧值（实测差 3.4 个数据单位）。
        const at =
          evt && isFinite(evt.left) && isFinite(evt.top)
            ? { left: Number(evt.left), top: Number(evt.top) }
            : undefined;
        const data = this.markDataAt(mark, at);
        if (kind === 'point') {
          mark.spec.x = data.xValue;
          mark.spec.y = data.yValue;
        } else if (kind === 'xLine' || kind === 'xBand') {
          if (kind === 'xLine') mark.spec.x = data.xValue;
          else mark.spec.x0 = data.xValue;
        } else {
          if (kind === 'yLine') mark.spec.y = data.yValue;
          else mark.spec.y0 = data.yValue;
        }
        mark.dragging = true;
        // spec 是唯一事实来源：拖完立刻按 spec 重摆一次 —— 该锚定的轴弹回原位，
        // 只保留真正被编辑的那个方向（否则「拖阈值线」会把它横向拖出绘图区）。
        this.syncMarks();
        this.emit('mark:drag', data);
        if (typeof mark.spec.onDrag === 'function') mark.spec.onDrag(data);
      });
    }
    this.syncMarks();
    return this.markHandle(mark);
  }

  /** 取一个图元句柄。 */
  public getMark(id: string): ChartMarkHandle | null {
    const mark = this.marks.find((m) => m.id === id);
    return mark ? this.markHandle(mark) : null;
  }

  public getMarks(): ChartMarkHandle[] {
    return this.marks.map((m) => this.markHandle(m));
  }

  /** 移除一个图元（只从图表里摘掉，不销毁组件 —— 组件归调用方所有）。 */
  public removeMark(id: string): boolean {
    const index = this.marks.findIndex((m) => m.id === id);
    if (index < 0) return false;
    const [mark] = this.marks.splice(index, 1);
    if (this.markLayer && mark.component) this.markLayer.removeChild(mark.component);
    return true;
  }

  public clearMarks(): void {
    for (const mark of this.marks) {
      if (this.markLayer && mark.component) this.markLayer.removeChild(mark.component);
    }
    this.marks = [];
  }

  /** 这个组件是不是图表管理的图元（交互层据此让路：按在注释上不该触发框选 / 平移）。 */
  public isMarkComponent(component: any): boolean {
    return !!component && this.marks.some((m) => m.component === component);
  }

  /** 拖拽结束：抛 `mark:dragend`（拖拽过程中抛的是 `mark:drag`）。 */
  public finishMarkDrag(): void {
    for (const mark of this.marks) {
      if (!mark.dragging) continue;
      mark.dragging = false;
      this.emit('mark:dragend', this.markDataAt(mark));
    }
  }

  private ensureMarkLayer(): ICEGroup {
    if (this.markLayer) return this.markLayer;
    const canvas = this.layout ? this.layout.canvas : this.canvasRect();
    const layer = new ICEGroup({
      left: 0,
      top: 0,
      width: canvas.width,
      height: canvas.height,
      origin: 'top-left',
      fill: false,
      stroke: false,
      interactive: false,
      draggable: false,
      transformable: false,
      linkable: false,
      zIndex: Z.mark,
    });
    this.root.addChild(layer);
    this.markLayer = layer;
    return layer;
  }

  private markHandle(mark: { id: string; spec: ChartMarkSpec; component: any }): ChartMarkHandle {
    const handle: ChartMarkHandle = {
      id: mark.id,
      spec: mark.spec,
      component: mark.component,
      update: (patch: Partial<ChartMarkSpec>) => {
        Object.assign(mark.spec, patch);
        this.syncMarks();
        return handle;
      },
      toData: () => this.markDataAt(mark),
      remove: () => {
        this.removeMark(mark.id);
      },
    };
    return handle;
  }

  /** 取某个图元用的 y 轴（多轴叠加时可按 seriesId 指定）。 */
  private markAxis(spec: ChartMarkSpec) {
    if (spec.seriesId) {
      const series = this.norm.series.find((s) => s.id === spec.seriesId || s.name === spec.seriesId);
      if (series) return this.norm.yAxes[series.axisIndex] || this.norm.yAxis;
    }
    return this.norm.yAxes[0] || this.norm.yAxis;
  }

  /** 数据坐标 → 像素（图表坐标系），并算出该图元的盒子。 */
  private markBox(spec: ChartMarkSpec, size: { width: number; height: number }) {
    const kind: string = spec.type || 'point';
    const plot = this.layout.plot;
    const xScale: any = this.norm.xAxis.scale;
    const yAxis: any = this.markAxis(spec);
    const yScale: any = yAxis && yAxis.scale;
    const dx = Number(spec.dx) || 0;
    const dy = Number(spec.dy) || 0;
    const px = (value: any) => plot.x + Number(xScale.map(value)) + dx;
    const py = (value: any) => plot.y + Number(yScale.map(value)) + dy;
    const w = size.width || 1;
    const h = size.height || 1;
    if (kind === 'xLine') {
      return { left: px(spec.x) - w / 2, top: plot.y + dy, width: w, height: plot.height };
    }
    if (kind === 'yLine') {
      return { left: plot.x + dx, top: py(spec.y) - h / 2, width: plot.width, height: h };
    }
    if (kind === 'xBand') {
      const a = px(spec.x0);
      const b = px(spec.x1);
      return { left: Math.min(a, b), top: plot.y + dy, width: Math.abs(b - a), height: plot.height };
    }
    if (kind === 'yBand') {
      const a = py(spec.y0);
      const b = py(spec.y1);
      return { left: plot.x + dx, top: Math.min(a, b), width: plot.width, height: Math.abs(b - a) };
    }
    const cx = px(spec.x);
    const cy = py(spec.y);
    return { left: cx - w / 2, top: cy - h / 2, width: w, height: h, anchor: [cx, cy] as [number, number] };
  }

  /** 图元当前锚点对应的数据坐标（拖拽回传 / `toData()` 用）。 */
  private markDataAt(mark: { id: string; spec: ChartMarkSpec; component: any }, at?: { left: number; top: number }): ChartMarkData {
    const spec = mark.spec;
    const kind: string = spec.type || 'point';
    const plot = this.layout.plot;
    const xScale: any = this.norm.xAxis.scale;
    const yAxis: any = this.markAxis(spec);
    const yScale: any = yAxis && yAxis.scale;
    const state = mark.component.state || {};
    const w = state.width || 0;
    const h = state.height || 0;
    const left = at ? at.left : state.left;
    const top = at ? at.top : state.top;
    let localX: number;
    let localY: number;
    if (kind === 'point') {
      localX = left + w / 2;
      localY = top + h / 2;
    } else if (kind === 'xLine' || kind === 'xBand') {
      localX = left + w / 2;
      localY = plot.y + plot.height / 2;
    } else {
      localX = plot.x + plot.width / 2;
      localY = top + h / 2;
    }
    const xValue = xScale && typeof xScale.invert === 'function' ? xScale.invert(localX - plot.x) : null;
    const yValue = yScale && typeof yScale.invert === 'function' ? Number(yScale.invert(localY - plot.y)) : NaN;
    const isXY = kind === 'point';
    return {
      id: mark.id,
      xValue,
      yValue: kind === 'xLine' || kind === 'xBand' || !isFinite(yValue) ? undefined : yValue,
      pixel: [localX, localY],
    };
  }

  /** 把每个图元摆到它该在的位置（rebuild 之后调用：缩放 / 平移 / 数据更新都不会脱锚）。 */
  private syncMarks(): void {
    if (!this.marks.length || !this.norm || !this.layout) return;
    const plot = this.layout.plot;
    this.syncingMarks = true;
    let moved = false;
    try {
      for (const mark of this.marks) {
        const state = mark.component.state || {};
        const box = this.markBox(mark.spec, { width: state.width || 0, height: state.height || 0 });
        // 锚点算不出有限值（类目被平移 / 缩放出当前域）时**只隐藏，不写坐标**：
        // 把 NaN 写进 state，引擎会当成 0 画到画布左上角 —— 表现为一整块墨迹糊在坐标轴上（实测 2159 像素）。
        if (![box.left, box.top, box.width, box.height].every((v) => isFinite(v))) {
          mark.component.setState({ display: false });
          continue;
        }
        const hideOut = mark.spec.hideWhenOutOfView !== false;
        const anchor = (box as any).anchor || [box.left + box.width / 2, box.top + box.height / 2];
        // 锚点算不出有限值（例如类目不在当前缩放窗口里）同样按「看不到」处理
        const finiteAnchor = isFinite(anchor[0]) && isFinite(anchor[1]);
        const outOfView =
          !finiteAnchor ||
          anchor[0] < plot.x - box.width || anchor[0] > plot.x + plot.width + box.width ||
          anchor[1] < plot.y - box.height || anchor[1] > plot.y + plot.height + box.height;
        // 注意：引擎图元的 `origin` 只影响**变换枢轴**，不影响绘制起点 ——
        // `left/top` 永远等于绘制盒的左上角（引擎内部用 localOrigin 在矩阵里补掉了）。
        // 所以这里直接写左上角，不要自己再按 origin 做中心换算（实测那样会把整块带状图元推出绘图区）。
        const left = Math.round(box.left);
        const top = Math.round(box.top);
        const width = Math.max(1, Math.round(box.width));
        const height = Math.max(1, Math.round(box.height));
        if (state.left !== left || state.top !== top) {
          // 位置用引擎的 setPosition：它会把**旧位置**也标脏
          mark.component.setPosition(left, top);
          moved = true;
        }
        if (state.width !== width || state.height !== height) {
          mark.component.setState({ width, height });
          moved = true;
        }
        mark.component.setState({ display: hideOut ? !outOfView : true });
      }
    } finally {
      this.syncingMarks = false;
    }
    if (this.markLayer) {
      this.markLayer.setState({ width: this.layout.canvas.width, height: this.layout.canvas.height });
    }
    // 已知问题（见 scripts/audit-interactions.mjs 的 KNOWN_ISSUES）：绘图区几何变化后，
    // 标记层的旧位置可能残留 ~9px 的暗红线段。图元位置用 setPosition 已经能覆盖绝大多数情况，
    // 但「布局变化 + 局部重绘」这条组合还需要一条正规的整帧重绘路径。
    void moved;
  }

  /** 恢复完整数据域。 */
  public resetZoom(): this {
    this.viewState = { x: null, y: null, yAxes: [] };
    this.rebuild(true);
    this.emit('zoom:change', this.currentRange());
    return this;
  }

  /** 切换系列显隐（图例点击、程序化控制都走这里）。 */
  public toggleSeries(seriesId: string, forceSelected?: boolean): this {
    const series = this.norm.series.find((s) => s.id === seriesId);
    if (!series) return this;
    const currentlyHidden = !!this.hiddenIds[seriesId];
    const nextHidden = forceSelected === undefined ? !currentlyHidden : !forceSelected;
    this.hiddenIds[seriesId] = nextHidden;
    // 动画更新：数值域跟着过渡（隐藏最大值那一条时，其它系列平滑缩放而不是瞬跳）
    this.applyOption(this.option, { animate: true, preserveView: true });
    this.emit('legend:toggle', {
      seriesId,
      seriesName: series.name,
      seriesIndex: series.index,
      selected: !nextHidden,
    } as LegendToggleParams);
    return this;
  }

  public isSeriesSelected(seriesId: string): boolean {
    return !this.hiddenIds[seriesId];
  }

  /**
   * 切换饼图扇区显隐（极坐标图例点击走这里）。
   * 扇区键是 `seriesId#dataIndex`，与系列显隐彼此独立。
   */
  public toggleSlice(seriesId: string, dataIndex: number, forceSelected?: boolean): this {
    const series = this.norm.series.find((s) => s.id === seriesId);
    // 饼图的「扇区」与漏斗图的「阶段」共用这套显隐机制
    if (!series || (series.type !== 'pie' && series.type !== 'funnel')) return this;
    const key = `${seriesId}#${dataIndex}`;
    const currentlyHidden = !!this.hiddenSlices[key];
    const nextHidden = forceSelected === undefined ? !currentlyHidden : !forceSelected;
    this.hiddenSlices[key] = nextHidden;
    const point = series.pointAt(dataIndex);
    // 动画更新：其余扇区/阶段平滑挪位（被隐藏的那个收拢到 0 再消失）
    this.applyOption(this.option, { animate: true, preserveView: true });
    this.emit('legend:toggle', {
      seriesId,
      seriesName: (point && point.name) || `${series.name} ${dataIndex + 1}`,
      seriesIndex: series.index,
      selected: !nextHidden,
      dataIndex,
    } as LegendToggleParams);
    return this;
  }

  /** 键盘 / 程序化焦点：把悬停定位到某个数据点。 */
  public showHoverAt(seriesId: string, dataIndex: number): this {
    const series = this.norm.series.find((s) => s.id === seriesId);
    if (!series) return this;
    const item = this.controller.resolver.buildActiveItem(series, dataIndex);
    if (item) this.controller.setHover({ kind: 'item', item });
    return this;
  }

  /** 跨图联动：按 x 数据值显示悬停。 */
  public showHoverAtValue(xValue: any): this {
    this.controller.showHoverAtValue(xValue);
    return this;
  }

  public clearHover(): this {
    this.controller.clearHover();
    return this;
  }

  public getSelection(): any[] {
    return this.controller.getSelectedParams();
  }

  public clearSelection(): this {
    this.controller.clearSelection();
    return this;
  }

  /** 当前数据域。 */
  public getDomain(axis: 'x' | 'y'): any[] {
    return axis === 'x' ? this.norm.xAxis.domain.slice() : this.norm.yAxis.domain.slice();
  }

  /** 指定 y 轴的数据域（多轴叠加时按 index 区分）。 */
  public getAxisDomain(index: number): any[] {
    const axis = this.norm.yAxes[index];
    return axis ? axis.domain.slice() : this.norm.yAxis.domain.slice();
  }

  /** 设置指定 y 轴的数据域（多轴叠加时的程序化控制）。 */
  public setAxisDomain(index: number, domain: any[], source = 'api'): this {
    if (index === 0) return this.setDomain('y', domain, source);
    if (this.destroyed) return this;
    const clamped = this.clampAxisDomain(index, domain, source);
    if (!clamped) return this;
    this.viewState.yAxes[index] = clamped as [any, any];
    this.rebuild(false);
    this.emit(source === 'pan' ? 'pan:change' : 'zoom:change', this.currentRange());
    return this;
  }

  /** 完整数据域（未缩放）。 */
  public fullDomain(axis: 'x' | 'y'): any[] {
    return (axis === 'x' ? this.fullXDomain : this.fullYDomain).slice();
  }

  // ------------------------------------------------------------- 事件

  /** canvas 元素（无障碍镜像等 DOM 相关能力需要）。 */
  public get canvasElement(): any {
    return this.canvasEl;
  }

  // ------------------------------------------------------------- 无障碍

  /** 数据表：屏幕阅读器可直接读取的「图表等价文本」。 */
  public getDataTable(): DataTable {
    return buildDataTable(this as any);
  }

  /**
   * 无障碍节点树：引擎的组件树 + 逐数据点的虚拟节点。
   * 应用层可据此构建自己的 DOM 镜像（焦点环、行内提示等）。
   */
  public getA11yTree(options: A11yTreeOptions = {}): any[] {
    const componentNodes = typeof this.ice.getAccessibilityTree === 'function' ? this.ice.getAccessibilityTree() : [];
    return [...componentNodes, ...buildDataNodes(this as any, options)];
  }

  /**
   * 在 canvas 旁挂载视觉隐藏的数据表 + aria-live 播报区，
   * 让屏幕阅读器既能读到整张数据表，也能听到当前悬停/键盘导航到的数据点。
   */
  public attachA11yMirror(): boolean {
    return this.a11yMirror.attach();
  }

  public detachA11yMirror(): void {
    this.a11yMirror.detach();
  }

  public get a11yMirrorAttached(): boolean {
    return this.a11yMirror.attached;
  }

  /** 手动播报一段无障碍文本（自定义交互时用）。 */
  public announceA11y(text: string): void {
    this.a11yMirror.announce(text);
  }

  public on(event: string, fn: (payload: any) => void, scope?: any): this {
    this.emitter.on(event, fn, scope);
    return this;
  }

  public once(event: string, fn: (payload: any) => void, scope?: any): this {
    this.emitter.once(event, fn, scope);
    return this;
  }

  public off(event: string, fn?: (payload: any) => void, scope?: any): this {
    this.emitter.off(event, fn, scope);
    return this;
  }

  public emit(event: string, payload?: any): boolean {
    if (this.silenceDepth > 0) return false;
    return this.emitter.emit(event, payload);
  }

  /**
   * 在「静默」状态下执行一段操作：期间抛出的事件不会对外广播。
   * 跨图联动用它打断 A→B→A 的事件回环，同时保留内部的视觉更新。
   */
  public silent<T>(fn: () => T): T {
    this.silenceDepth++;
    try {
      return fn();
    } finally {
      this.silenceDepth--;
    }
  }

  // ------------------------------------------------------------- 尺寸 / 生命周期

  /** 手动重排（响应式容器变化时调用）。不传尺寸则读取 canvas 的内容盒尺寸。 */
  public resize(cssWidth?: number, cssHeight?: number): this {
    if (this.destroyed) return this;
    // 尺寸对齐交给引擎：backing store × dpr、CSS 尺寸、canvasWidth/Height，
    // 以及命中矩形 / 内容盒的同步都在它里面，一份实现。
    //
    // 这里以前是自己算的，用的是 getBoundingClientRect() 的 **border-box** 尺寸 ——
    // 画布带边框时会整体偏大（引擎注释里警告过："直接用 border-box 会被边框撑大，
    // 示例页画布带 1px 边框"）。上面那句"内容盒"一直是意图、不是实现；现在才是。
    this.ice.fitCanvasToDisplaySize(cssWidth, cssHeight);
    // 拿不到有效尺寸就不重排：算出来的布局没有意义（沿用既有保护）
    if (!(this.ice.canvasWidth > 0) || !(this.ice.canvasHeight > 0)) return this;
    this.rebuild(false);
    return this;
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // 先退订主题跟随：销毁后引擎再换主题不该回头画这张图
    if (this.__offThemeFollow) {
      this.__offThemeFollow();
      this.__offThemeFollow = null;
    }
    this.stopDomainTransition();
    // 无障碍镜像是挂在 canvas 旁边的 DOM，必须在销毁时一并摘掉（否则页面会残留隐藏表格）
    this.a11yMirror.detach();
    this.controller.destroy();
    if (this.resizeObserver && typeof this.resizeObserver.disconnect === 'function') {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.emitter.clear();
    this.ice.destroy();
  }

  /** 等待下一帧渲染完成（测试与截图场景很有用）。 */
  public nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      const bus: any = this.ice.evtBus;
      if (!bus) {
        resolve();
        return;
      }
      const handler = () => {
        bus.off(ICE_EVENT_NAME_CONSTS.ROUND_FINISH, handler, null);
        resolve();
      };
      bus.on(ICE_EVENT_NAME_CONSTS.ROUND_FINISH, handler, null);
      this.ice.dirty = true;
    });
  }

  /** 便捷方法：立即标脏并等待一帧（等价于 requestRender + nextFrame）。 */
  public render(): Promise<void> {
    this.ice.dirty = true;
    return this.nextFrame();
  }

  /** 文本格式化（坐标轴 / 提示框共用）。 */
  public formatAxisValue(axis: 'x' | 'y', value: any): string {
    const internal = axis === 'x' ? this.norm.xAxis : this.norm.yAxis;
    const scale = internal.scale;
    if (!scale) return String(value);
    const index = internal.domain.indexOf(value);
    return formatTick(value, scale, index < 0 ? 0 : index, internal.option.formatter);
  }

  /** 导出成图片（透传引擎的 canvas 能力）：常用于「保存为 PNG」。 */
  public toDataURL(type?: string, quality?: any): string {
    if (!this.ice || typeof this.ice.toDataURL !== 'function') return '';
    return this.ice.toDataURL(type, quality);
  }

  /** 导出成 Blob（浏览器环境）。 */
  public toBlob(callback: (blob: any) => void, type?: string, quality?: any): void {
    if (this.ice && typeof this.ice.toBlob === 'function') this.ice.toBlob(callback, type, quality);
    else callback(null);
  }

  // ------------------------------------------------------------- 序列化

  /**
   * 从快照还原一个图表（静态工厂，等价于先 new 再 fromJSONObject）。
   *
   * ```ts
   * const json = chart.toJSONString();
   * const restored = ICEChart.restore('canvas-2', json);
   * ```
   */
  public static restore(
    target: any,
    snapshot: ChartSnapshot | string,
    options: SnapshotRestoreOptions & { chartOptions?: ICEChartOptions; initialOption?: ChartOption } = {}
  ): ICEChart {
    // 先建一张空图（normalizeOption 要求 series 是数组），再立刻用快照替换
    const chart = new ICEChart(target, options.initialOption || ({ series: [] } as ChartOption), options.chartOptions);
    chart.fromJSONObject(snapshot, options);
    return chart;
  }

  /**
   * 导出图表快照（可 JSON 化）。
   *
   * 序列化的**唯一事实来源是 option**（声明式规格），不是引擎的组件树：
   * 组件树只是 option 的渲染投影，里面没有数据语义（比例尺、数据点、命中缓存），
   * 反序列化一棵组件树只会得到一个空壳。所以这里存的是
   * 「option + 视图窗口 + 图例/扇区显隐」，这三样足以完整重建图形。
   *
   * 注意：函数字段（formatter 等）无法进 JSON，导出时会被丢弃；
   * 还原时用 `restore(target, snapshot, { optionPatch })` 或 `fromJSONObject(snapshot, { patch })` 补回来。
   */
  public toJSON(): {
    version: number;
    option: ChartOption;
    view: { x: [any, any] | null; y: [any, any] | null; yAxes: Array<[any, any] | null> };
    hidden: Record<string, boolean>;
    hiddenSlices: Record<string, boolean>;
  } {
    return {
      version: SNAPSHOT_VERSION,
      option: toSerializableOption(this.option),
      view: { x: this.viewState.x, y: this.viewState.y, yAxes: this.viewState.yAxes },
      hidden: { ...this.hiddenIds },
      hiddenSlices: { ...this.hiddenSlices },
    };
  }

  public toJSONString(): string {
    return JSON.stringify(this.toJSON());
  }

  public fromJSONString(json: string, options: SnapshotRestoreOptions = {}): this {
    const parsed = JSON.parse(json);
    this.loadSnapshot(parsed, options);
    return this;
  }

  public fromJSONObject(snapshot: any, options: SnapshotRestoreOptions = {}): this {
    this.loadSnapshot(snapshot, options);
    return this;
  }

  private loadSnapshot(snapshot: any, options: SnapshotRestoreOptions = {}): void {
    if (!snapshot) return;
    const parsed = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    // 兼容两种输入：完整快照（{ version, option, view, hidden }）或裸 option
    const rawOption = parsed.option || parsed;
    if (typeof parsed.version === 'number' && parsed.version > SNAPSHOT_VERSION) {
      throw new Error(
        `[ice-chart] 快照版本 ${parsed.version} 高于当前实现支持的 ${SNAPSHOT_VERSION}，请升级 ice-chart 后再还原。`
      );
    }
    const option = options.optionPatch ? mergeOptionPatch(rawOption, options.optionPatch) : rawOption;
    this.hiddenIds = parsed.hidden || {};
    this.hiddenSlices = parsed.hiddenSlices || {};
    const view = parsed.view || {};
    this.viewState = { x: view.x || null, y: view.y || null, yAxes: view.yAxes || [] };
    this.applyOption(option, { animate: false, preserveView: true });
  }

  // ------------------------------------------------------------- 编译管线

  private applyOption(option: ChartOption, options: ApplyOptionOptions): void {
    this.option = option;
    // 记录更新前的 y 数据域：更新动画需要把「域的变化」也一起插值，否则会瞬跳
    const previousYDomain = this.norm ? this.norm.yAxis.domain.slice() : null;
    const normalized = normalizeOption(option, {
      hiddenIds: this.hiddenIds,
      hiddenSlices: this.hiddenSlices,
      // theme:'auto' = 跟随引擎实例主题：明暗由引擎主题的背景色亮度判定（归一化层保持纯函数）
      preferDark: isEngineThemeDark(this.ice),
    });
    // 图表主题 → 引擎主题：图表实例里那些**引擎自己画的东西**（默认样式 / 交互外壳 /
    // 应用后加的自定义图元）跟着图表的主题走，避免"图表是暗的、外壳还是亮的"。
    // 两条约束：
    //   ① `theme:'auto'` 时**不推** —— auto 是"跟随引擎"，再推回去就成了自己跟自己的回喂；
    //   ② 主题没变不推 —— 推一次会让引擎整棵树标脏（下标 / 重建路径会频繁走到这里）。
    if (option.theme !== 'auto') {
      const themeKey = JSON.stringify(normalized.theme);
      if (themeKey !== this.__appliedEngineThemeKey) {
        applyChartThemeToEngine(this.ice, normalized.theme);
        this.__appliedEngineThemeKey = themeKey;
      }
    }
    this.fullXDomain = normalized.xAxis.domain.slice();
    this.fullYDomain = normalized.yAxis.domain.slice();
    this.fullYDomains = normalized.yAxes.map((axis) => axis.domain.slice());
    // 函数绘图的 y 轴默认「自动贴合可视区间」（像 fplot）：数据域不锁死，
    // 每次 rebuild 按当前 x 窗口重新算；用户显式给了 yAxis.min/max 或缩放过 y 就以它为准。
    this.autoYCurve = (option.series || []).some((s) => !!s && s.type === 'function');

    if (!options.preserveView) {
      this.viewState = { x: null, y: null, yAxes: [] };
      const initial = this.initialWindow(normalized);
      if (initial) {
        this.viewState.x = initial;
      }
    }
    this.hiddenIds = normalized.hiddenIds;
    this.hiddenSlices = normalized.hiddenSlices;
    this.rebuild(options.animate === 'enter' ? 'enter' : options.animate === false ? false : 'update');
    const trigger = options.animate === 'enter' ? 'enter' : options.animate === false ? false : 'update';
    // 只有直角坐标才需要 y 域过渡：极坐标 / 雷达 / 仪表盘 / 水位 / 树图这些场景不按 y 轴排布，
    // 数据一更新就启动过渡只会让它们每帧跑一次全量重建（而且永远不会结束 ——
    // 每次 setData 都会把系列进度重置，过渡永远到不了终点）。实测大屏里 5 张图因此常驻重建循环。
    if (
      trigger === 'update' &&
      shouldAnimate() &&
      previousYDomain &&
      this.norm &&
      this.norm.kind === 'cartesian' &&
      this.norm.yAxis.domain.length === 2
    ) {
      const next = this.norm.yAxis.domain;
      const changed = Math.abs(Number(previousYDomain[0]) - Number(next[0])) > 1e-9 || Math.abs(Number(previousYDomain[1]) - Number(next[1])) > 1e-9;
      if (changed) this.startDomainTransition([Number(previousYDomain[0]), Number(previousYDomain[1])], [Number(next[0]), Number(next[1])]);
    }
  }

  /** dataZoom 的 start/end 只影响初始窗口。 */
  private initialWindow(normalized: NormalizedOption): [any, any] | null {
    const zoom = normalized.option.dataZoom;
    if (!zoom || (zoom.start === undefined && zoom.end === undefined)) return null;
    const start = clamp(Number(zoom.start === undefined ? 0 : zoom.start) / 100, 0, 1);
    const end = clamp(Number(zoom.end === undefined ? 100 : zoom.end) / 100, 0, 1);
    if (start <= 0 && end >= 1) return null;
    const domain = normalized.xAxis.domain;
    if (normalized.xAxis.type === 'category') {
      const n = domain.length;
      const from = clamp(Math.floor(start * n), 0, Math.max(0, n - 2));
      const to = clamp(Math.ceil(end * n) - 1, from + 1, n - 1);
      return [domain[from], domain[to]];
    }
    const d0 = Number(domain[0]);
    const d1 = Number(domain[1]);
    const span = d1 - d0;
    return [d0 + span * start, d0 + span * end];
  }

  /** 用当前 viewState 重新归一化 → 布局 → 同步组件。 */
  /** 启动数据域过渡：每帧按系列动画进度插值 y 轴数据域。 */
  private startDomainTransition(from: number[], to: number[]): void {
    this.domainTransition = { from, to };
    if (this.domainFrameHandler) return;
    const bus: any = this.ice.evtBus;
    if (!bus) return;
    this.domainFrameHandler = () => this.stepDomainTransition();
    bus.on(ICE_EVENT_NAME_CONSTS.ICE_FRAME_EVENT, this.domainFrameHandler, this);
  }

  private stepDomainTransition(): void {
    const transition = this.domainTransition;
    if (!transition || this.destroyed) {
      this.stopDomainTransition();
      return;
    }
    // 用系列自己的进度当时间轴：两者必须是同一条时间线
    let t = 0;
    for (const component of this.seriesComponents) {
      const value = Number(component.state.progress);
      if (isFinite(value) && value > t) t = value;
    }
    if (t >= 1) {
      this.domainTransition = null;
      this.stopDomainTransition();
      this.rebuild(false);
      return;
    }
    const domain = transition.to.map((value, index) => {
      const start = transition.from[index];
      return isFinite(start) ? start + (value - start) * t : value;
    });
    this.rebuild(false, domain);
  }

  private stopDomainTransition(): void {
    if (!this.domainFrameHandler) return;
    const bus: any = this.ice && this.ice.evtBus;
    if (bus) bus.off(ICE_EVENT_NAME_CONSTS.ICE_FRAME_EVENT, this.domainFrameHandler, this);
    this.domainFrameHandler = null;
  }

  private rebuild(animate: boolean | 'enter' | 'update', domainOverride?: number[] | null): void {
    if (this.destroyed) return;
    const canvas = this.canvasRect();
    const effectiveX = this.viewState.x || this.fullXDomain;
    const effectiveYs = this.fullYDomains.map((full, index) => {
      const view = index === 0 ? this.viewState.y : this.viewState.yAxes[index];
      return view && view.length === 2 ? view : full;
    });
    const norm = normalizeOption(this.option, {
      hiddenIds: this.hiddenIds,
      hiddenSlices: this.hiddenSlices,
      // this.norm 来自这一遍归一化 —— `theme:'auto'` 的明暗判定必须在这里也给到
      preferDark: isEngineThemeDark(this.ice),
      xDomain: effectiveX && effectiveX.length === 2 ? [effectiveX[0], effectiveX[1]] : null,
      yDomain:
        this.autoYCurve && !this.viewState.y && !(domainOverride && domainOverride.length === 2)
          ? null
          : domainOverride && domainOverride.length === 2
          ? [Number(domainOverride[0]), Number(domainOverride[1])]
          : effectiveYs[0] && effectiveYs[0].length === 2
            ? [Number(effectiveYs[0][0]), Number(effectiveYs[0][1])]
            : null,
      yDomains: effectiveYs.map((domain) =>
        this.autoYCurve && !this.viewState.y && !(domainOverride && domainOverride.length === 2)
          ? null
          : domain && domain.length === 2
            ? [Number(domain[0]), Number(domain[1])]
            : null
      ),
    });
    // 第二次归一化后，y 轴可能因为堆叠 / 可见性变化而需要重算：保持用户窗口优先
    this.norm = norm;
    if (this.autoYCurve) {
      // 自动贴合后同步 fullYDomains：currentRange() / y 轴缩放的夹取都以它为准
      this.fullYDomain = norm.yAxis.domain.slice();
      this.fullYDomains = norm.yAxes.map((axis) => axis.domain.slice());
    }
    this.layout = computeLayout(norm, this.ice.ctx, canvas);
    this.buildScales(norm);
    this.root.state.ariaLabel = chartTitle(norm);
    // 域过渡期间不要重跑「数据 → 系列」那条链路：数据没变，
    // 重跑会清掉系列的动画起点（fromEffective），值插值就断了。
    this.syncComponents(domainOverride ? false : animate);
    // 数据坐标图元：布局 / 比例尺 / 数据都可能刚变过，重新摆一遍（缩放平移后不脱锚）
    this.syncMarks();
    this.ice.dirty = true;
    // 缩放 / 平移 / 数据更新后，悬停视觉（准星、高亮环、提示框）必须跟着数据重新定位
    if (this.controller) this.controller.refreshHover();
    if (this.a11yMirror.attached) this.a11yMirror.refresh();
  }

  private buildScales(norm: NormalizedOption): void {
    const { plot } = this.layout;
    norm.xAxis.scale = createScale(norm.xAxis.type, norm.xAxis.domain, [0, Math.max(1, plot.width)], {
      logBase: norm.xAxis.option.logBase,
    });
    for (const axis of norm.yAxes) {
      axis.scale = createScale(axis.type, axis.domain, [Math.max(1, plot.height), 0], {
        logBase: axis.option.logBase,
      });
    }
  }

  private syncComponents(animate: boolean | 'enter' | 'update'): void {
    const norm = this.norm;
    const layout = this.layout;
    const canvas = layout.canvas;
    const plot = layout.plot;
    const theme = norm.theme;

    // 只在尺寸真正变化时写根容器：ICEGroup.setState 会递归把全部后代置脏，
    // 而 wheel / pan 会每帧 rebuild，无差别重绘会让脏矩形局部重绘完全失效。
    if (this.root.state.width !== canvas.width || this.root.state.height !== canvas.height) {
      this.root.setState({ width: canvas.width, height: canvas.height });
    }

    const polar = layout.polar;
    const isPolar = norm.kind !== 'cartesian';
    this.plotArea.setState({ left: plot.x, top: plot.y, width: plot.width, height: plot.height });
    this.plotArea.setBackground(theme.backgroundColor === 'transparent' ? null : theme.backgroundColor);

    this.grid.setState({ width: canvas.width, height: canvas.height });
    this.grid.setState({ display: !isPolar });
    this.grid.xScale = norm.xAxis.scale;
    this.grid.yScale = norm.yAxis.scale;
    // 垂直网格线跟 x 轴标签是**同一批位置**：抽稀表里 `labels[i] === ''` 的就是不画的那几颗。
    // 轴藏起来（`show: false`）的 pane 也有这张表（见 `buildAxisLayout`），网格因此能对齐。
    const xLayout = layout.xAxisLayout;
    this.grid.xTicks = xLayout.ticks.filter((_tick, index) => !xLayout.labels || xLayout.labels[index] !== '');
    // 默认只有主轴画水平网格线；其它轴需要显式 showGrid: true
    this.grid.horizontal = norm.yAxes
      .map((axis, index) => ({ axis, axisLayout: layout.yAxes[index], index }))
      .filter((item) => (item.axis.option.showGrid === undefined ? item.index === 0 : item.axis.option.showGrid !== false))
      .map((item) => ({ scale: item.axis.scale as Scale, ticks: item.axisLayout.ticks, index: item.index }));
    this.grid.plot = plot;
    this.grid.grid = norm.option.grid || {};
    this.grid.theme = theme;
    this.grid.markDirty();

    this.radarGrid.setState({ width: canvas.width, height: canvas.height, display: norm.kind === 'radar' });
    this.radarGrid.theme = theme;
    this.radarGrid.coord =
      norm.kind === 'radar' && polar && norm.radar
        ? {
            polar,
            plot,
            indicators: norm.radar.indicators.map((indicator, index) => ({
              name: indicator.name,
              max: norm.radarDomains[index] ? norm.radarDomains[index][1] : 1,
            })),
            shape: norm.radar.shape || 'polygon',
            splitNumber: Math.max(1, Number(norm.radar.splitNumber) || 4),
          }
        : null;
    this.radarGrid.markDirty();

    // 极坐标网格：直角坐标场景 + aspect:'equal' 时才是「圆」，所以只在这种组合下显示
    const polarGridOption = norm.option.polarGrid;
    const showPolarGrid = norm.kind === 'cartesian' && !!polarGridOption && norm.option.aspect === 'equal';
    this.polarGrid.setState({ width: canvas.width, height: canvas.height, display: showPolarGrid });
    this.polarGrid.theme = theme;
    this.polarGrid.layout = layout;
    this.polarGrid.coord = showPolarGrid
      ? {
          plot,
          xScale: norm.xAxis.scale as any,
          yScale: norm.yAxis.scale as any,
          options: polarGridOption === true ? {} : (polarGridOption as any),
        }
      : null;
    this.polarGrid.markDirty();

    this.syncAxisComponents();
    for (let i = 0; i < this.axisYList.length; i++) {
      const axisComponent = this.axisYList[i];
      axisComponent.setState({ width: canvas.width, height: canvas.height, display: !isPolar });
      axisComponent.layout = layout;
      axisComponent.theme = theme;
      axisComponent.axis = norm.yAxes[i] || norm.yAxis;
      axisComponent.axisIndex = i;
      axisComponent.position = (norm.yAxes[i] && norm.yAxes[i].position) || 'left';
      // 刻度变了就滑过去（缩放 / 平移 / 数据更新 / resize 都走这一条）
      axisComponent.syncTicks();
      axisComponent.markDirty();
    }
    {
      const axis = this.axisX;
      axis.setState({ width: canvas.width, height: canvas.height, display: !isPolar });
      axis.layout = layout;
      axis.theme = theme;
      axis.axis = norm.xAxis;
      axis.syncTicks();
      axis.markDirty();
    }
    // 网格线要和刻度用同一条时间线：位置从坐标轴读，重绘由自己的补间驱动
    this.grid.axisX = this.axisX;
    this.grid.axisYList = this.axisYList;
    this.grid.syncTicks();

    // 标注：定位与越界判定在 resolveAnnotation()（纯函数），这里只把坐标系喂给它。
    // 非直角场景没有 x/y 坐标系，组件会给出结构化诊断而不是静默（见 annotationDiagnostics()）。
    this.annotation.setState({ width: canvas.width, height: canvas.height, display: true });
    this.annotation.plot = plot;
    this.annotation.xAxis = norm.xAxis;
    this.annotation.yAxes = norm.yAxes;
    this.annotation.sync(norm.option.annotation, {
      kind: norm.kind,
      plot,
      xAxis: norm.xAxis,
      yAxes: norm.yAxes,
      theme,
    });

    if (this.legend) {
      this.legend.setState({ width: canvas.width, height: canvas.height });
      this.legend.layout = layout;
      this.legend.theme = theme;
      this.legend.selectable = norm.option.legend.selectable !== false;
      this.legend.markDirty();
    }
    if (this.titleComponent) {
      this.titleComponent.setState({ width: canvas.width, height: canvas.height });
      this.titleComponent.layout = layout;
      this.titleComponent.theme = theme;
      this.titleComponent.markDirty();
    }
    for (const overlay of [this.crosshair, this.highlight, this.brushComponent, this.tooltip]) {
      if (!overlay) continue;
      overlay.setState({ width: canvas.width, height: canvas.height });
      overlay.theme = theme;
      overlay.markDirty();
    }
    if (this.tooltip) this.tooltip.layout = layout;
    if (this.crosshair) {
      this.crosshair.layout = layout;
      this.crosshair.option = norm.option.crosshair || {};
      // 准星跟随的时长是它自己的事，**不能**跟着 animation.update.duration 走 ——
      // 那是「数据变化时图形怎么变」，默认 420ms。准星要跟指针，420ms 的补间就是「线追不上鼠标」，
      // 数据流页面每帧 refreshHover 还会把补间反复重置，实测永不收敛。
      // 默认 90ms 上限 + 按距离缩放（见 Crosshair.crosshairGlideDuration）。
      const followRaw = Number((this.crosshair.option as any).followDuration);
      this.crosshair.followDuration = isFinite(followRaw) && followRaw >= 0 ? Math.min(400, followRaw) : 90;
    }
    if (this.crosshair) this.crosshair.setState({ display: !isPolar });
    if (this.brushComponent) {
      const brushOption: any = norm.option.interaction && norm.option.interaction.brush;
      this.brushComponent.color =
        brushOption && brushOption !== false && brushOption.color
          ? { fill: toAlpha(brushOption.color, 0.16), stroke: brushOption.color }
          : null;
    }

    if (this.dataZoomSlider) {
      const sliderRect = layout.slider;
      if (sliderRect) {
        this.dataZoomSlider.setState({
          left: sliderRect.x,
          top: sliderRect.y,
          width: sliderRect.width,
          height: sliderRect.height,
          display: true,
        });
        const [startFraction, endFraction] = this.domainFractions();
        this.dataZoomSlider.setWindow(startFraction, endFraction);
      } else {
        this.dataZoomSlider.setState({ display: false });
      }
      this.dataZoomSlider.theme = theme;
      this.dataZoomSlider.markDirty();
    }

    this.syncSeries(animate);
  }

  /** 当前 x 数据域在完整数据域中的比例窗口（0~1），供 dataZoom 滑块显示。 */
  public domainFractions(): [number, number] {
    const full = this.fullXDomain;
    const domain = this.norm.xAxis.domain;
    if (!full || full.length < 2 || !domain || domain.length < 2) return [0, 1];
    if (this.norm.xAxis.type === 'category') {
      const n = full.length;
      if (n <= 1) return [0, 1];
      const from = Math.max(0, full.indexOf(domain[0]));
      const to = full.indexOf(domain[domain.length - 1]);
      // 类目轴的窗口比例按「类目数」计：窗口 [from..to] 对应 [from/n, (to+1)/n]，
      // 与 dataZoom.start/end 的语义（占类目总数的百分比）保持一致。
      return [from / n, ((to < 0 ? n - 1 : to) + 1) / n];
    }
    const f0 = Number(full[0]);
    const f1 = Number(full[1]);
    const span = f1 - f0 || 1;
    return [(Number(domain[0]) - f0) / span, (Number(domain[1]) - f0) / span];
  }

  /**
   * 由 dataZoom 滑块的比例窗口反推数据域。
   *
   * `guard = true` 时套用「窗口至少盖住 2 个数据点」的兜底（滑块的交互路径走这个）；
   * 默认 false 表示**纯映射** —— 比例窗口 → 数据域是确定性的，程序化调用不受影响。
   */
  public setDomainFromFractions(start: number, end: number, source = 'slider', guard = false): this {
    if (this.norm.kind !== 'cartesian') return this;
    const [currentStart, currentEnd] = this.domainFractions();
    if (Math.abs(currentStart - start) < 1e-4 && Math.abs(currentEnd - end) < 1e-4) return this;
    const full = this.fullXDomain;
    if (this.norm.xAxis.type === 'category') {
      const n = full.length;
      if (n < 2) return this;
      let from = Math.round(start * n);
      let to = Math.round(end * n) - 1;
      from = Math.max(0, Math.min(n - 1, from));
      to = Math.max(0, Math.min(n - 1, to));
      if (to <= from) to = Math.min(n - 1, from + 1);
      const range = [full[from], full[to]];
      return this.setDomain('x', guard ? this.guardInteractiveXWindow(range) : range, source);
    }
    const f0 = Number(full[0]);
    const f1 = Number(full[1]);
    const span = f1 - f0;
    const range = [f0 + span * start, f0 + span * end];
    return this.setDomain('x', guard ? this.guardInteractiveXWindow(range) : range, source);
  }

  /** 让 y 轴组件数量 / 位置与 norm.yAxes 保持一致（轴数量变化时增删组件）。 */
  private syncAxisComponents(): void {
    const axes = this.norm.yAxes;
    const count = axes.length;
    const signature = axes.map((axis) => axis.position).join('|');
    if (this.axisSignature !== signature) {
      for (const component of this.axisYList) {
        this.root.removeChild(component);
      }
      const canvas = this.layout.canvas;
      this.axisYList = axes.map(
        (axis, index) =>
          new Axis({
            orientation: 'y',
            width: canvas.width,
            height: canvas.height,
            zIndex: Z.axis + index,
            axisIndex: index,
            position: axis.position,
          })
      );
      this.root.addChildren(this.axisYList);
      this.axisSignature = signature;
    }
    while (this.axisYList.length > count) {
      const extra = this.axisYList.pop() as Axis;
      this.root.removeChild(extra);
    }
  }

  private syncSeries(animate: boolean | 'enter' | 'update'): void {
    const norm = this.norm;
    const plot = this.layout.plot;
    const signature = norm.series.map((s) => `${s.id}:${s.type}`).join('|');
    const slots = computeBarSlots(norm.series);

    if (signature !== this.seriesSignature) {
      for (const component of this.seriesComponents) {
        this.root.removeChild(component);
      }
      this.seriesComponents = norm.series.map((series, index) =>
        createSeriesComponent(series, {
          left: plot.x,
          top: plot.y,
          width: plot.width,
          height: plot.height,
          zIndex: Z.series + index,
        })
      );
      this.root.addChildren(this.seriesComponents);
      this.seriesSignature = signature;
    }

    for (let i = 0; i < this.seriesComponents.length; i++) {
      const component = this.seriesComponents[i];
      const series = norm.series[i];
      const visible = !series.hidden;
      const axis = norm.yAxes[series.axisIndex] || norm.yAxis;
      const polarLayout = this.layout.polar;
      const coord =
        series.type === 'pie'
          ? { polar: polarLayout, plot, canvas: this.layout.canvas }
          : series.type === 'radar'
            ? { polar: polarLayout, plot, canvas: this.layout.canvas, domains: norm.radarDomains }
            : series.type === 'funnel'
              ? { plot, canvas: this.layout.canvas, options: norm.funnel || {} }
              : series.type === 'gauge'
                ? { polar: polarLayout, plot, canvas: this.layout.canvas, options: norm.gauge || {} }
                : series.type === 'liquid'
                  ? { polar: polarLayout, plot, canvas: this.layout.canvas, options: norm.liquid || {} }
                : series.type === 'treemap'
                  ? {
                      plot,
                      canvas: this.layout.canvas,
                      layout: layoutTreemap(
                        (series.option.data || []) as any,
                        plot,
                        norm.treemap || {},
                        norm.theme.colorPalette
                      ),
                      options: norm.treemap || {},
                    }
                  : series.type === 'graph' && norm.graph
                    ? {
                        plot,
                        canvas: this.layout.canvas,
                        layout: forceLayout(norm.graph.nodes || [], norm.graph.links || [], plot, norm.graph, norm.theme.colorPalette),
                        options: norm.graph,
                      }
            : series.type === 'sankey' && norm.sankey
              ? {
                  plot,
                  canvas: this.layout.canvas,
                  layout: layoutSankey(
                    norm.sankey.nodes || [],
                    norm.sankey.links || [],
                    plot,
                    norm.sankey,
                    norm.theme.colorPalette
                  ),
                  options: norm.sankey,
                }
            : {
              plot,
              canvas: this.layout.canvas,
              xScale: norm.xAxis.scale as Scale,
              yScale: axis.scale as Scale,
              yAxisIndex: series.axisIndex,
              theme: norm.theme,
            };
      component.setState({
        left: plot.x,
        top: plot.y,
        width: plot.width,
        height: plot.height,
        display: visible,
        zIndex: Z.series + i,
        interactive: visible,
      });
      component.barSlot = slots[series.id] || { index: 0, count: 1 };
      component.chartTheme = norm.theme;
      component.state.ariaLabel = `${series.name} 系列，共 ${series.pointCount} 个数据点`;
      component.updateSeries(series, !!animate && !this.viewState.x, !!this.domainTransition);
      if (series.type === 'pie' || series.type === 'funnel') {
        component.setHiddenSlices(hiddenSliceIndexes(norm, series.id));
      }
      component.setCoord(coord as any);
      component.markDirty();
      if (animate && visible) {
        const animation: any = norm.option.animation;
        if (animation && animation.enabled !== false) {
          const stage = animation[animate === 'enter' ? 'enter' : 'update'];
          if (stage) this.playStage(component, { ...stage, kind: animate === 'enter' ? 'enter' : 'update' });
        }
      }
    }
  }

  /**
   * 让引擎的 AnimationManager 把 progress 从 0 推到 1。
   *
   * 实测（`hitTest` 逐帧采样）：引擎在补间期间把 `interactive` 置 false 只发生在
   * 同一帧的同步块内（保存→置 false→补间→恢复），事件处理与命中检测看不到，
   * 所以动画期间交互照常可用 —— 不需要额外的「驱动组件」绕开它。
   */
  public playStage(
    seriesComponent: SeriesBase,
    stage: { duration?: number; delay?: number; easing?: string; stagger?: number; kind?: 'enter' | 'update' }
  ): void {
    if (!shouldAnimate()) {
      // 无障碍 / 测试的瞬时模式：直接落到终态，不占用帧循环
      seriesComponent.setAnimationStage(stage);
      seriesComponent.setState({ progress: 1 });
      seriesComponent.markDirty();
      return;
    }
    seriesComponent.setAnimationStage(stage);
    // 必须**合并**而不是整体替换：组件上可能还跑着别的补间
    // （悬停反馈 highlightT、扫动的 __tick）。整体替换会把它们悄悄冲掉 ——
    // 数据流场景最明显：每帧 setData/appendData 都会重播 update 阶段，
    // 悬停反馈被反复清空，highlightT 永远到不了 1（实测卡在 0.16）。
    const animations: any = { ...((seriesComponent.props as any).animations || {}) };
    animations.progress = {
      from: 0,
      to: 1,
      duration: Math.max(1, Number(stage.duration) || 480),
      delay: Number(stage.delay) || 0,
      easing: stage.easing || 'easeOutCubic',
      startTime: undefined,
      finished: false,
    };
    (seriesComponent.props as any).animations = animations;
    seriesComponent.setState({ progress: 0 });
    if (this.ice.animationManager) this.ice.animationManager.add(seriesComponent);
  }

  /** 兼容旧 API：按「入场」阶段播放。 */
  public playEnter(seriesComponent: SeriesBase, duration: number, easing: string): void {
    this.playStage(seriesComponent, { duration, easing, stagger: 0 });
  }

  /** 把当前所有未完成的动画一次性推到终态（截图 / 测试 / 无障碍瞬时模式用）。 */
  public finishAnimations(): this {
    this.domainTransition = null;
    this.stopDomainTransition();
    // 系列之外还有坐标轴刻度过渡 / 提示框 / 准星这些独立补间，一并收尾，
    // 否则截图和「瞬时模式」下还会看到它们在半路上。
    const animated: any[] = [...this.seriesComponents, this.axisX, ...this.axisYList, this.grid, this.tooltip, this.crosshair];
    for (const component of animated) {
      if (!component) continue;
      // 必须同时取消引擎里的补间：只把 progress 置 1 的话，下一帧引擎又会把它写回去
      const animations: any = (component.props as any).animations;
      if (animations) {
        for (const key in animations) {
          // `__` 前缀是「持续重绘」的循环补间（蚂蚁线 / 桑基流动 / 水位波浪）：
          // 它们没有终态，收尾会把动效永久冻住（而且 keepAnimating 的 loopRegistered
          // 还是 true，再也不会重新注册）。只收尾一次性补间。
          if (key.indexOf('__') === 0) continue;
          if (animations[key]) animations[key].finished = true;
        }
      }
      const hasLoop = !!animations && Object.keys(animations).some((key) => key.indexOf('__') === 0);
      if (this.ice.animationManager && !hasLoop) this.ice.animationManager.remove(component);
      if (component.props && component.props.animations && component.props.animations.axisMorph) {
        component.setState({ axisMorph: 1 });
      }
      if (Number(component.state.progress) < 1) component.setState({ progress: 1 });
      component.markDirty();
    }
    this.ice.dirty = true;
    return this;
  }

  // ------------------------------------------------------------- 内部工具

  private currentRange(): { x?: [any, any]; y?: [number, number] } {
    return {
      x: [this.norm.xAxis.domain[0], this.norm.xAxis.domain[this.norm.xAxis.domain.length - 1]],
      y: [Number(this.norm.yAxis.domain[0]), Number(this.norm.yAxis.domain[1])],
    };
  }

  private clampDomain(axis: 'x' | 'y', domain: any[], source?: string): any[] | null {
    if (axis === 'y') return this.clampAxisDomain(0, domain, source);
    return this.clampAxisDomain(-1, domain, source);
  }

  /** index = -1 表示 x 轴，>=0 表示对应的 y 轴。 */
  private clampAxisDomain(index: number, domain: any[], source?: string): any[] | null {
    const full = index < 0 ? this.fullXDomain : this.fullYDomains[index];
    if (!full || full.length < 2 || !domain || domain.length < 2) return null;
    const internal = index < 0 ? this.norm.xAxis : this.norm.yAxes[index];
    if (!internal) return null;
    if (internal.type === 'category') {
      const all = full;
      let from = all.indexOf(domain[0]);
      let to = all.indexOf(domain[1]);
      // 两端都不在这份数据里：这个窗口表达不出来，**保持原窗口**。
      // 早先这里退化成了「整段数据」（`from = 0` / `to = length-1`），
      // 于是一份类目比别人短的系列会把联动过来的窗口整幅放大（实测：量图被拉成整幅）。
      if (from < 0 && to < 0) return null;
      if (from < 0 || to < 0) {
        // 只有一端越出了这份数据：让整窗**贴着数据的边缘滑动，跨度不变**。
        // 以前直接把越界的那端拽成 `0` / `length-1`，等于把窗口拉成「整段数据」。
        const span = Math.max(1, internal.domain.length - 1);
        if (to < 0) {
          to = all.length - 1;
          from = Math.max(0, to - span);
        } else {
          from = 0;
          to = Math.min(all.length - 1, span);
        }
      }
      if (from > to) {
        const t = from;
        from = to;
        to = t;
      }
      if (to - from < 1) return null;
      if (source === 'zoom' || source === 'brush') {
        // **手势缩放要过缩放比例限制**（px/根，见 util/zoomLimit）。
        // 滚轮那条路径自己算的时候就夹过了，这里兜住别的入口（框选缩放到区间、外部直接
        // 调 `setDomain('x', […], 'zoom')`）—— 否则「限制」只对滚轮生效，换个入口就能
        // 缩到 0.24px/根。夹的时候**保住窗口中心**，再贴一次数据边缘。
        const count = to - from + 1;
        const zoomOpt: any = this.norm.option.interaction && this.norm.option.interaction.zoom;
        const limit = clampBarCount(count, this.layout.plot.width, zoomOpt && zoomOpt !== false ? zoomOpt : undefined);
        if (limit !== count) {
          const center = (from + to) / 2;
          let nextFrom = Math.round(center - (limit - 1) / 2);
          nextFrom = Math.max(0, Math.min(nextFrom, all.length - limit));
          from = Math.max(0, nextFrom);
          to = Math.min(all.length - 1, from + limit - 1);
          if (to - from < 1) return null;
        }
      }
      return [all[from], all[to]];
    }
    const f0 = Number(full[0]);
    const f1 = Number(full[1]);
    const raw0 = Number(domain[0]);
    const raw1 = Number(domain[1]);
    if (!isFinite(raw0) || !isFinite(raw1) || raw1 <= raw0) return null;
    const fullSpan = f1 - f0;
    const minSpan = fullSpan * 0.001;
    if (raw1 - raw0 < minSpan) return null;
    if (source === 'pan') {
      // **平移要保住窗口跨度**，不能像下面那样与数据范围求交 ——
      // 求交会把「平移」悄悄退化成「缩放」：窗口贴住数据边界时一端被夹住、另一端继续走。
      // 实测（K 线页纵向拖 120px）：量程从 [41100,41700] 变成 [41100,41449]，
      // 顶端不动、底端上移 —— 看着既不是「移」、方向还是反的。
      // 这里只要求窗口和数据范围**至少交叠 1/4 个窗口**，免得一拖就把画面拖空。
      const span = raw1 - raw0;
      const need = span * 0.25;
      let d0 = raw0;
      let d1 = raw1;
      if (d1 < f0 + need) {
        d0 += f0 + need - d1;
        d1 = f0 + need;
      }
      if (d0 > f1 - need) {
        d1 -= d0 - (f1 - need);
        d0 = f1 - need;
      }
      return [d0, d1];
    }
    const d0 = Math.max(f0, raw0);
    const d1 = Math.min(f1, raw1);
    if (d1 <= d0 || d1 - d0 < minSpan) return null;
    return [d0, d1];
  }

  private canvasRect(): Rect {
    const dpr = (this.ice && this.ice.dpr) || 1;
    const width = (this.ice && this.ice.canvasWidth ? this.ice.canvasWidth : this.canvasEl ? this.canvasEl.width : 0) / dpr;
    const height = (this.ice && this.ice.canvasHeight ? this.ice.canvasHeight : this.canvasEl ? this.canvasEl.height : 0) / dpr;
    return { x: 0, y: 0, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }

  private observeResize(): void {
    const RO: any = typeof window !== 'undefined' ? (window as any).ResizeObserver : null;
    if (!RO || !this.canvasEl) return;
    const target = this.canvasEl.parentNode || this.canvasEl;
    this.resizeObserver = new RO(() => {
      this.resize();
    });
    this.resizeObserver.observe(target);
  }

  private registerTypes(): void {
    const types: Array<[string, any]> = [
      ['ice-chart:PlotArea', PlotArea],
      ['ice-chart:GridLines', GridLines],
      ['ice-chart:Annotation', Annotation],
      ['ice-chart:Axis', Axis],
      ['ice-chart:Legend', Legend],
      ['ice-chart:Title', Title],
      ['ice-chart:Tooltip', Tooltip],
      ['ice-chart:Crosshair', Crosshair],
      ['ice-chart:Highlight', Highlight],
      ['ice-chart:Brush', Brush],
    ];
    for (const [typeId, ctor] of types) {
      this.ice.registerType(typeId, ctor);
    }
  }
}

/** 计算分组柱形的槽位：同 stack 的系列共用一个槽，其余各自一槽。 */
export function computeBarSlots(series: InternalSeries[]): Record<string, { index: number; count: number }> {
  const groups: Array<{ key: string; members: InternalSeries[] }> = [];
  const map: Record<string, { index: number; count: number }> = {};
  for (const s of series) {
    if (s.type !== 'bar' || s.hidden) continue;
    const key = s.option.stack ? `stack:${s.option.stack}` : `single:${s.id}`;
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, members: [] };
      groups.push(group);
    }
    group.members.push(s);
  }
  for (let i = 0; i < groups.length; i++) {
    for (const s of groups[i].members) {
      map[s.id] = { index: i, count: groups.length };
    }
  }
  return map;
}

/** 某个饼图系列里被隐藏的扇区下标。 */
export function hiddenSliceIndexes(norm: NormalizedOption, seriesId: string): number[] {
  const out: number[] = [];
  const series = norm.series.find((s) => s.id === seriesId);
  if (!series) return out;
  for (let i = 0; i < series.pointCount; i++) {
    const point = series.pointAt(i);
    if (norm.hiddenSlices[`${seriesId}#${point.index}`]) out.push(point.index);
  }
  return out;
}

/**
 * 引擎实例主题是不是暗色 —— 用 `semantic.background` 的相对亮度判定（WCAG 公式的简化版）。
 *
 * 只用于 `option.theme: 'auto'`：图表要跟着**引擎那一层**的明暗走，而不是跟着页面 / 系统。
 */
function isEngineThemeDark(ice: any): boolean {
  try {
    const background = ice && ice.getTheme && ice.getTheme().semantic.background;
    const rgb = parseHexColor(background);
    if (!rgb) return false;
    const [r, g, b] = rgb.map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance < 0.35;
  } catch (err) {
    return false;
  }
}

/** `#rgb` / `#rrggbb` → `[r,g,b]`；其它写法（含 transparent / rgba）返回 null。 */
function parseHexColor(color: any): [number, number, number] | null {
  if (typeof color !== 'string') return null;
  const value = color.trim();
  if (value.charAt(0) !== '#') return null;
  let hex = value.slice(1);
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (hex.length !== 6) return null;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function toAlpha(color: string, alpha: number): string {
  if (typeof color !== 'string') return `rgba(0,0,0,${alpha})`;
  if (color.indexOf('#') === 0) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length !== 6) return color;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (color.indexOf('rgb(') === 0) return color.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  return color;
}

/**
 * 工厂函数：第二个参数既可以是声明式 option，也可以是 `toJSON()` 产出的快照。
 *
 * ```ts
 * const chart = createChart('canvas-1', option);
 * const snapshot = chart.toJSONString();
 * const restored = createChart('canvas-2', snapshot);   // 直接吃快照
 * ```
 */
export function createChart(
  target: any,
  optionOrSnapshot: ChartOption | ChartSnapshot | string,
  chartOptions?: ICEChartOptions
): ICEChart {
  if (typeof optionOrSnapshot === 'string' || isChartSnapshot(optionOrSnapshot)) {
    return ICEChart.restore(target, optionOrSnapshot as ChartSnapshot | string, { chartOptions });
  }
  return new ICEChart(target, optionOrSnapshot as ChartOption, chartOptions);
}
