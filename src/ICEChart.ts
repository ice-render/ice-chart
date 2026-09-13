import { ICE, ICEGroup } from 'ice-render';
import type { ChartOption, DataItem, LegendToggleParams } from './types';
import type { ChartLayout, InternalSeries, NormalizedOption, Rect } from './internal';
import { normalizeOption, toSerializableOption } from './option/normalize';
import { computeLayout } from './layout/layout';
import { createScale, formatTick, type Scale } from './scale';
import { GridLines } from './components/GridLines';
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
import { A11yMirror, buildDataNodes, buildDataTable, chartTitle, type A11yTreeOptions, type DataTable } from './a11y';
import { layoutSankey } from './layout/sankey';
import { layoutTreemap } from './layout/treemap';
import { forceLayout } from './layout/force';
import { shouldAnimate } from './animation/motion';

const Z = {
  plotArea: 10,
  grid: 20,
  series: 100,
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
    const clamped = this.clampDomain(axis, domain);
    if (!clamped) return this;
    if (axis === 'x') this.viewState.x = clamped as [any, any];
    else this.viewState.y = clamped as [any, any];
    this.rebuild(false);
    const range = this.currentRange();
    this.emit(source === 'pan' ? 'pan:change' : 'zoom:change', range);
    return this;
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
    const point = series.points[dataIndex];
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
    const clamped = this.clampAxisDomain(index, domain);
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
    const dpr = this.ice.dpr || 1;
    const el = this.canvasEl;
    let width = cssWidth;
    let height = cssHeight;
    if (width === undefined || height === undefined) {
      const rect = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      width = (rect && rect.width) || el.width / dpr;
      height = (rect && rect.height) || el.height / dpr;
    }
    const nextWidth = Number(width);
    const nextHeight = Number(height);
    if (!(nextWidth > 0) || !(nextHeight > 0)) return this;
    el.width = Math.round(nextWidth * dpr);
    el.height = Math.round(nextHeight * dpr);
    if (el.style) {
      el.style.width = `${nextWidth}px`;
      el.style.height = `${nextHeight}px`;
    }
    this.ice.canvasWidth = el.width;
    this.ice.canvasHeight = el.height;
    if (typeof this.ice.updateCanvasBoundingRect === 'function') this.ice.updateCanvasBoundingRect();
    this.rebuild(false);
    return this;
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
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
        bus.off('ROUND_FINISH', handler, null);
        resolve();
      };
      bus.on('ROUND_FINISH', handler, null);
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
    const normalized = normalizeOption(option, { hiddenIds: this.hiddenIds, hiddenSlices: this.hiddenSlices });
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
    bus.on('ICE_FRAME_EVENT', this.domainFrameHandler, this);
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
    if (bus) bus.off('ICE_FRAME_EVENT', this.domainFrameHandler, this);
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

  /** 由 dataZoom 滑块的比例窗口反推数据域。 */
  public setDomainFromFractions(start: number, end: number, source = 'slider'): this {
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
      return this.setDomain('x', [full[from], full[to]], source);
    }
    const f0 = Number(full[0]);
    const f1 = Number(full[1]);
    const span = f1 - f0;
    return this.setDomain('x', [f0 + span * start, f0 + span * end], source);
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
      component.state.ariaLabel = `${series.name} 系列，共 ${series.points.length} 个数据点`;
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

  private clampDomain(axis: 'x' | 'y', domain: any[]): any[] | null {
    if (axis === 'y') return this.clampAxisDomain(0, domain);
    return this.clampAxisDomain(-1, domain);
  }

  /** index = -1 表示 x 轴，>=0 表示对应的 y 轴。 */
  private clampAxisDomain(index: number, domain: any[]): any[] | null {
    const full = index < 0 ? this.fullXDomain : this.fullYDomains[index];
    if (!full || full.length < 2 || !domain || domain.length < 2) return null;
    const internal = index < 0 ? this.norm.xAxis : this.norm.yAxes[index];
    if (!internal) return null;
    if (internal.type === 'category') {
      const all = full;
      let from = all.indexOf(domain[0]);
      let to = all.indexOf(domain[1]);
      if (from < 0) from = 0;
      if (to < 0) to = all.length - 1;
      if (from > to) {
        const t = from;
        from = to;
        to = t;
      }
      if (to - from < 1) return null;
      return [all[from], all[to]];
    }
    const f0 = Number(full[0]);
    const f1 = Number(full[1]);
    const d0 = Math.max(f0, Number(domain[0]));
    const d1 = Math.min(f1, Number(domain[1]));
    if (!isFinite(d0) || !isFinite(d1) || d1 <= d0) return null;
    const fullSpan = f1 - f0;
    const minSpan = fullSpan * 0.001;
    if (d1 - d0 < minSpan) return null;
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
  for (const point of series.points) {
    if (norm.hiddenSlices[`${seriesId}#${point.index}`]) out.push(point.index);
  }
  return out;
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
