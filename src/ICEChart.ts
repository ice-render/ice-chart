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
import { createSeriesComponent } from './components/series/createSeries';
import type { SeriesBase } from './components/series/SeriesBase';
import { InteractionController } from './interaction/InteractionController';
import { Emitter } from './util/emitter';
import { clamp } from './util/math';

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

export interface ICEChartOptions {
  renderMode?: 'dirty-rect' | 'full';
  dpr?: number;
  /** 监听容器尺寸变化并自动重排（需要 ResizeObserver）。 */
  autoResize?: boolean;
}

export interface ApplyOptionOptions {
  animate?: boolean;
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
  public axisX: Axis;
  /** y 轴组件，与 norm.yAxes 一一对应（axisYList[0] 是主 y 轴）。 */
  public axisYList: Axis[] = [];
  public legend: Legend | null = null;
  public titleComponent: Title | null = null;
  public tooltip: Tooltip | null = null;
  public crosshair: Crosshair | null = null;
  public highlight: Highlight | null = null;
  public brushComponent: Brush | null = null;
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
  private hiddenIds: Record<string, boolean> = {};
  private seriesSignature = '';
  private axisSignature = '';
  private resizeObserver: any = null;
  private destroyed = false;
  /** 抑制对外事件的重入深度（跨图联动时避免 A→B→A 的回环）。 */
  private silenceDepth = 0;

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
    this.axisX = new Axis({ orientation: 'x', width: canvas.width, height: canvas.height, zIndex: Z.axis });
    this.axisYList = [
      new Axis({ orientation: 'y', width: canvas.width, height: canvas.height, zIndex: Z.axis, axisIndex: 0, position: 'left' }),
    ];
    this.legend = new Legend({ width: canvas.width, height: canvas.height, zIndex: Z.legend });
    this.titleComponent = new Title({ width: canvas.width, height: canvas.height, zIndex: Z.title });
    this.crosshair = new Crosshair({ width: canvas.width, height: canvas.height, zIndex: Z.crosshair });
    this.highlight = new Highlight({ width: canvas.width, height: canvas.height, zIndex: Z.highlight });
    this.brushComponent = new Brush({ width: canvas.width, height: canvas.height, zIndex: Z.brush });
    this.tooltip = new Tooltip({ width: canvas.width, height: canvas.height, zIndex: Z.tooltip });

    this.root.addChildren([
      this.plotArea,
      this.grid,
      this.axisX,
      ...this.axisYList,
      this.titleComponent,
      this.legend,
      this.crosshair,
      this.highlight,
      this.brushComponent,
      this.tooltip,
    ]);

    this.controller = new InteractionController(this);
    this.applyOption(option, { animate: false, preserveView: false });
    this.controller.bind();

    if (chartOptions.autoResize) this.observeResize();
  }

  // ------------------------------------------------------------- 对外 API

  /** 更新配置。默认保留当前缩放窗口，可用 resetZoom 恢复。 */
  public setOption(option: ChartOption, options: ApplyOptionOptions = {}): this {
    this.applyOption(option, { animate: options.animate !== false, preserveView: options.preserveView !== false });
    return this;
  }

  /** 取当前配置（函数字段保留；持久化请用 toJSON）。 */
  public getOption(): ChartOption {
    return this.option;
  }

  /** 更新单个系列的数据。 */
  public setData(seriesIdOrIndex: string | number, data: DataItem[]): this {
    const series = (this.option.series || []).map((item, index) => ({ item, index }));
    const target = series.find((s) => (typeof seriesIdOrIndex === 'number' ? s.index === seriesIdOrIndex : s.item.id === seriesIdOrIndex || s.item.name === seriesIdOrIndex));
    if (!target) throw new Error(`[ice-chart] 找不到系列：${seriesIdOrIndex}`);
    target.item.data = data;
    this.applyOption(this.option, { animate: true, preserveView: true });
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
    this.applyOption(this.option, { animate: false, preserveView: true });
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

  // ------------------------------------------------------------- 序列化

  public toJSON(): {
    option: ChartOption;
    view: { x: [any, any] | null; y: [any, any] | null; yAxes: Array<[any, any] | null> };
    hidden: Record<string, boolean>;
  } {
    return {
      option: toSerializableOption(this.option),
      view: { x: this.viewState.x, y: this.viewState.y, yAxes: this.viewState.yAxes },
      hidden: { ...this.hiddenIds },
    };
  }

  public toJSONString(): string {
    return JSON.stringify(this.toJSON());
  }

  public fromJSONString(json: string): this {
    const parsed = JSON.parse(json);
    this.loadSnapshot(parsed);
    return this;
  }

  public fromJSONObject(snapshot: any): this {
    this.loadSnapshot(snapshot);
    return this;
  }

  private loadSnapshot(snapshot: any): void {
    if (!snapshot) return;
    const option = snapshot.option || snapshot;
    this.hiddenIds = snapshot.hidden || {};
    const view = snapshot.view || {};
    this.viewState = { x: view.x || null, y: view.y || null, yAxes: view.yAxes || [] };
    this.option = option;
    this.rebuild(false);
  }

  // ------------------------------------------------------------- 编译管线

  private applyOption(option: ChartOption, options: ApplyOptionOptions): void {
    this.option = option;
    const normalized = normalizeOption(option, { hiddenIds: this.hiddenIds });
    this.fullXDomain = normalized.xAxis.domain.slice();
    this.fullYDomain = normalized.yAxis.domain.slice();
    this.fullYDomains = normalized.yAxes.map((axis) => axis.domain.slice());

    if (!options.preserveView) {
      this.viewState = { x: null, y: null, yAxes: [] };
      const initial = this.initialWindow(normalized);
      if (initial) {
        this.viewState.x = initial;
      }
    }
    this.hiddenIds = normalized.hiddenIds;
    this.rebuild(options.animate !== false);
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
  private rebuild(animate: boolean): void {
    if (this.destroyed) return;
    const canvas = this.canvasRect();
    const effectiveX = this.viewState.x || this.fullXDomain;
    const effectiveYs = this.fullYDomains.map((full, index) => {
      const view = index === 0 ? this.viewState.y : this.viewState.yAxes[index];
      return view && view.length === 2 ? view : full;
    });
    const norm = normalizeOption(this.option, {
      hiddenIds: this.hiddenIds,
      xDomain: effectiveX && effectiveX.length === 2 ? [effectiveX[0], effectiveX[1]] : null,
      yDomain:
        effectiveYs[0] && effectiveYs[0].length === 2
          ? [Number(effectiveYs[0][0]), Number(effectiveYs[0][1])]
          : null,
      yDomains: effectiveYs.map((domain) =>
        domain && domain.length === 2 ? [Number(domain[0]), Number(domain[1])] : null
      ),
    });
    // 第二次归一化后，y 轴可能因为堆叠 / 可见性变化而需要重算：保持用户窗口优先
    this.norm = norm;
    this.layout = computeLayout(norm, this.ice.ctx, canvas);
    this.buildScales(norm);
    this.syncComponents(animate);
    this.ice.dirty = true;
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

  private syncComponents(animate: boolean): void {
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

    this.plotArea.setState({ left: plot.x, top: plot.y, width: plot.width, height: plot.height });
    this.plotArea.setBackground(theme.backgroundColor === 'transparent' ? null : theme.backgroundColor);

    this.grid.setState({ width: canvas.width, height: canvas.height });
    this.grid.xScale = norm.xAxis.scale;
    this.grid.yScale = norm.yAxis.scale;
    // 默认只有主轴画水平网格线；其它轴需要显式 showGrid: true
    this.grid.horizontal = norm.yAxes
      .map((axis, index) => ({ axis, axisLayout: layout.yAxes[index], index }))
      .filter((item) => (item.axis.option.showGrid === undefined ? item.index === 0 : item.axis.option.showGrid !== false))
      .map((item) => ({ scale: item.axis.scale as Scale, ticks: item.axisLayout.ticks }));
    this.grid.plot = plot;
    this.grid.grid = norm.option.grid || {};
    this.grid.theme = theme;
    this.grid.markDirty();

    this.syncAxisComponents();
    for (let i = 0; i < this.axisYList.length; i++) {
      const axisComponent = this.axisYList[i];
      axisComponent.setState({ width: canvas.width, height: canvas.height });
      axisComponent.layout = layout;
      axisComponent.theme = theme;
      axisComponent.axis = norm.yAxes[i] || norm.yAxis;
      axisComponent.axisIndex = i;
      axisComponent.position = (norm.yAxes[i] && norm.yAxes[i].position) || 'left';
      axisComponent.markDirty();
    }
    {
      const axis = this.axisX;
      axis.setState({ width: canvas.width, height: canvas.height });
      axis.layout = layout;
      axis.theme = theme;
      axis.axis = norm.xAxis;
      axis.markDirty();
    }

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
    }
    if (this.brushComponent) {
      const brushOption: any = norm.option.interaction && norm.option.interaction.brush;
      this.brushComponent.color =
        brushOption && brushOption !== false && brushOption.color
          ? { fill: toAlpha(brushOption.color, 0.16), stroke: brushOption.color }
          : null;
    }

    this.syncSeries(animate);
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

  private syncSeries(animate: boolean): void {
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
      const coord = {
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
      component.updateSeries(series, animate && !this.viewState.x);
      component.setCoord(coord);
      component.markDirty();
      if (animate && visible) {
        const animation = norm.option.animation;
        if (!animation || animation.enabled !== false) {
          this.playEnter(
            component,
            (animation && animation.duration) || 480,
            (animation && animation.easing) || 'cubicOut'
          );
        }
      }
    }
  }

  /** 让引擎的 AnimationManager 把 progress 从 0 推到 1。 */
  public playEnter(seriesComponent: SeriesBase, duration: number, easing: string): void {
    const animations: any = {
      progress: { from: 0, to: 1, duration, easing, startTime: undefined, finished: false },
    };
    (seriesComponent.props as any).animations = animations;
    seriesComponent.setState({ progress: 0 });
    if (this.ice.animationManager) this.ice.animationManager.add(seriesComponent);
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
      ['ice-plot-area', PlotArea],
      ['ice-grid-lines', GridLines],
      ['ice-axis', Axis],
      ['ice-legend', Legend],
      ['ice-title', Title],
      ['ice-tooltip', Tooltip],
      ['ice-crosshair', Crosshair],
      ['ice-highlight', Highlight],
      ['ice-brush', Brush],
    ];
    for (const [name, ctor] of types) {
      try {
        this.ice.registerType(name, ctor);
      } catch (err) {
        // 重复注册同名类型不影响使用
      }
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

/** 工厂函数：与 `new ICEChart(...)` 等价，风格更贴近函数式调用。 */
export function createChart(target: any, option: ChartOption, chartOptions?: ICEChartOptions): ICEChart {
  return new ICEChart(target, option, chartOptions);
}
