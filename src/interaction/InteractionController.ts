import type { ActiveColumn, ActiveItem } from '../internal';
import type { BrushRange, DataPointParams, TooltipParams } from '../types';
import type { Crosshair } from '../components/Crosshair';
import type { Highlight, HighlightItem } from '../components/Highlight';
import type { Brush } from '../components/Brush';
import type { DataZoomSlider, SliderPart } from '../components/DataZoomSlider';
import type { Legend } from '../components/Legend';
import type { PlotArea } from '../components/PlotArea';
import type { Tooltip } from '../components/Tooltip';
import { HitResolver, valueDistance, type HitHost, type TargetInfo } from './HitResolver';
import { clamp } from '../util/math';
import { clampBarCount } from '../util/zoomLimit';

/** 交互层需要的图表宿主能力，由 ICEChart 实现。 */
export interface InteractionHost extends HitHost {
  tooltip: Tooltip | null;
  crosshair: Crosshair | null;
  highlight: Highlight | null;
  brush: Brush | null;
  legend: Legend | null;
  plotArea: PlotArea;
  emit(event: string, payload?: any): void;
  setDomain(axis: 'x' | 'y', domain: any[], source?: string): void;
  toggleSeries(seriesId: string, forceSelected?: boolean): void;
  /** 切换饼图扇区显隐（极坐标图例）。 */
  toggleSlice(seriesId: string, dataIndex: number, forceSelected?: boolean): void;
  /** dataZoom 滑块（未启用时为 null）。 */
  dataZoomSlider: DataZoomSlider | null;
  /** y 方向的竖直滑块（没配 `dataZoom.sliderY` 时为 null）。 */
  dataZoomSliderY: DataZoomSlider | null;
  /** 由滑块的 0~1 比例窗口反推数据域。 */
  setDomainFromFractions(start: number, end: number, source?: string, guard?: boolean): void;
  /** y 滑块的对应入口（口径见 `ICEChart.setDomainYFromFractions`）。 */
  setDomainYFromFractions(start: number, end: number, source?: string, axisIndex?: number): void;
  formatAxisValue(axis: 'x' | 'y', value: any): string;
  /** 未经缩放的完整数据域（缩放约束用）。 */
  fullDomain(axis: 'x' | 'y'): any[];
  /** 这个组件是不是图表管理的「数据坐标图元」（注释 / 阈值线 / 预测带）。 */
  isMarkComponent?(component: any): boolean;
  /** 拖拽收尾：抛 mark:dragend。 */
  finishMarkDrag?(): void;
}

type DragState =
  | null
  | { mode: 'brush'; startX: number; startY: number; moved: boolean }
  | {
      mode: 'pan';
      startX: number;
      startY: number;
      domainX: [any, any] | null;
      domainY: [any, any] | null;
      /**
       * 起手时的画布视图（`pan.mode: 'viewport'` 用）。
       *
       * ⚠️ 必须**记下起点**、每帧从它算绝对位移。往「当前的 tx」上再加一次累计位移
       * 会把位移累积成平方增长 —— 实测一次拖 80px、画面跑了 360px（用户反馈「比鼠标快好几倍」）。
       * 数据域那条路一开始就是这么写的（`domainX` 记起手窗口 + 每帧按累计位移推），
       * 平移视图要照抄这个口径。
       */
      viewport: { scale: number; tx: number; ty: number };
      /** 起手时指针所在面板的像素尺寸（面板矩阵下按它把位移换算成数据位移）。 */
      panelWidth: number;
      panelHeight: number;
      moved: boolean;
    }
  | {
      mode: 'slider';
      /** 拖的是哪条滑块：横向那条（x 窗口）还是竖直那条（y 窗口）。 */
      axis: 'x' | 'y';
      part: SliderPart;
      startX: number;
      startY: number;
      originStart: number;
      originEnd: number;
      anchorFraction: number;
      moved: boolean;
    }
  | {
      mode: 'graph-node';
      component: any;
      nodeIndex: number;
      startX: number;
      startY: number;
      moved: boolean;
    }
  | {
      mode: 'sankey-node';
      component: any;
      nodeIndex: number;
      /** 按下时「节点中心 − 指针」的纵向偏移（保住手感，别让节点跳到指针中心）。 */
      grabOffsetY: number;
      /** 按下时那一列的顺序：松手后一样就什么都不做。 */
      orderBefore: string[];
      startX: number;
      startY: number;
      moved: boolean;
    };

/**
 * 当前持有键盘焦点的控制器。
 *
 * 一个页面上可能有多张图，而引擎的原生事件监听挂在 window 上 —— **每张图都会收到
 * 全页面的事件**。因此必须显式区分「指针是否落在本画布内」与「键盘该由谁响应」，
 * 否则会出现「在 A 图上移动鼠标，B 图把刚镜像过来的悬停清掉」「按一下方向键，所有图一起动」
 * 这类跨图串扰。
 */
let activeController: InteractionController | null = null;

/**
 * 交互控制器：ice-chart 所有指针 / 键盘行为**唯一**的入口。
 *
 * 三条设计约束：
 * 1. 悬停命中不复用引擎移动事件的 component 缓存（移动事件为了性能不做命中检测），
 *    而是显式调用 `ice.hitTest()` —— 保证「画出来的样子」与「点得到的位置」严格一致；
 * 2. 数据项命中交给引擎：`ice.hitTest()` 返回命中的组件，控制器只把本地坐标翻译成数据下标；
 * 3. 对外只抛语义事件（item:hover / select:change / brush:end / zoom:change ...），
 *    业务层不需要理解像素、比例尺与坐标系。
 *
 * 所有公开的 handleXxx 方法都接受**画布 CSS 像素**坐标，因此可以在不合成 DOM 事件的情况下直接单测。
 */
export class InteractionController {
  public host: InteractionHost;
  public hover: { kind: 'item'; item: ActiveItem } | { kind: 'axis'; column: ActiveColumn } | null = null;
  /**
   * 当前悬停是不是**外部**放上来的（`showHoverAtValue`：多图联动回显 / 编程式驱动）。
   *
   * 为什么要区分：没接住指针的图在 `handlePointerMove` 里会清掉悬停，但那个动作的语义是
   * 「我这儿没有指针悬停了」，而不是「把别人给的状态删掉」。外部按 x 值放上来的悬停
   * 该由放它的那一方（联动）收回 —— 否则被回显的图会在**同一次 mousemove** 里立刻自清。
   * 三块 pane 的 K 线图实测：竖线永远只在指针所在的那一块出现，跨 pane 的十字准星做不出来。
   */
  public externalHover = false;
  public selection: Array<{ seriesId: string; dataIndex: number }> = [];
  public resolver: HitResolver;
  private drag: DragState = null;
  private bound = false;
  private lastDimmed: string | null = null;
  private keyboardIndex = 0;

  constructor(host: InteractionHost) {
    this.host = host;
    this.resolver = new HitResolver(host);
  }

  // ------------------------------------------------------------- 引擎事件接线

  public bind(): this {
    if (this.bound) return this;
    const bus = this.host.ice && this.host.ice.evtBus;
    if (!bus) return this;
    this.bound = true;
    bus.on('mousemove', this.onBusMove, this);
    bus.on('mousedown', this.onBusDown, this);
    bus.on('mouseup', this.onBusUp, this);
    bus.on('click', this.onBusClick, this);
    bus.on('dblclick', this.onBusDoubleClick, this);
    bus.on('wheel', this.onBusWheel, this);
    bus.on('keydown', this.onBusKeyDown, this);
    return this;
  }

  public unbind(): void {
    if (!this.bound) return;
    this.bound = false;
    const bus = this.host.ice && this.host.ice.evtBus;
    if (!bus) return;
    bus.off('mousemove', this.onBusMove, this);
    bus.off('mousedown', this.onBusDown, this);
    bus.off('mouseup', this.onBusUp, this);
    bus.off('click', this.onBusClick, this);
    bus.off('dblclick', this.onBusDoubleClick, this);
    bus.off('wheel', this.onBusWheel, this);
    bus.off('keydown', this.onBusKeyDown, this);
  }

  private pointOf(evt: any): [number, number] | null {
    if (!evt) return null;
    const x = typeof evt.offsetX === 'number' ? evt.offsetX : evt.x;
    const y = typeof evt.offsetY === 'number' ? evt.offsetY : evt.y;
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    return [x, y];
  }

  /**
   * 指针是否落在本图 canvas 的内容盒内（CSS 像素语义）。
   *
   * **尺寸测不出来时一律判 false**（早先这里返回 true）。理由：引擎的原生监听挂在
   * window 上，本图会收到**整页**的指针事件，而这个判断是唯一的"这事件不属于我"闸门。
   * `display:none` 的画布（切页之后被藏起来的那些）宽度/高度是 0，旧实现"尺寸未知就当
   * 指针在上面"，于是隐藏中的图会把全页的移动都吃下来，在**错误的坐标**上锁住一个悬停；
   * 等它被显示出来，`refreshHover()` 会把这个陈旧悬停重新解析一遍，画面上就出现一个
   * 没人悬停却擦不掉的提示框 + 十字准星（切页时必现）。
   *
   * 真实事件到达前引擎已经量过尺寸（`updateCanvasBoundingRect`），所以"量不到"就等于
   * "这张图现在根本不在画面上"，判 false 不会误伤可见画布。
   */
  public isOverCanvas(screenX: number, screenY: number): boolean {
    const ice: any = this.host && this.host.ice;
    if (!ice) return false;
    const dpr = ice.dpr || 1;
    const width = (ice.canvasWidth || 0) / dpr;
    const height = (ice.canvasHeight || 0) / dpr;
    if (!(width > 0) || !(height > 0)) return false;
    return screenX >= 0 && screenY >= 0 && screenX <= width && screenY <= height;
  }

  /**
   * 阻止默认行为。
   *
   * `ice-render@2.18` 起 `ICEEvent.preventDefault()` 是**真实现**：`cancelable` 时置 `defaultPrevented`
   * 并**转给原始 DOM 事件**；原生 DOM 事件自然也是直接生效。所以这里不再需要区分来源，
   * 只留一层容错 —— 某些运行时里事件上的 `preventDefault` 是未绑定的原生方法（"Illegal invocation"）、
   * 被动监听器里调用也会被浏览器拒绝，这两种情况忽略即可，不影响交互语义。
   *
   * （历史：2.17 及以前 `ICEEvent.preventDefault()` 是 `throw new Error('Method not implemented.')` 的桩，
   * 那时只能对 `evt.originalEvent` 调；peer 下限抬到 `^2.18.0` 之后这层绕过就删掉了。）
   */
  private preventDefault(evt: any): void {
    if (!evt) return;
    // ① 首选事件自身的方法：`ICEEvent`（2.18+）会自己转给原始 DOM 事件，原生事件直接生效
    if (typeof evt.preventDefault === 'function') {
      try {
        evt.preventDefault();
        return;
      } catch (err) {
        // 落到 ② 再试一次：被动监听器 / 原生方法未绑定（"Illegal invocation"）
      }
    }
    // ② 兜底：事件桩（只有 originalEvent）或上面抛了的情况，直接对原始事件调
    const raw = evt.originalEvent;
    if (!raw || typeof raw.preventDefault !== 'function') return;
    try {
      raw.preventDefault();
    } catch (err) {
      // 被动监听器 / 已过期事件：忽略，不影响交互语义
    }
  }

  private onBusMove(evt: any): void {
    const p = this.pointOf(evt);
    if (p) this.handlePointerMove(p[0], p[1], evt);
  }

  private onBusDown(evt: any): void {
    const p = this.pointOf(evt);
    if (p) this.handlePointerDown(p[0], p[1], evt);
  }

  private onBusUp(evt: any): void {
    const p = this.pointOf(evt);
    if (p) this.handlePointerUp(p[0], p[1], evt);
  }

  private onBusClick(evt: any): void {
    const p = this.pointOf(evt);
    if (p) this.handleClick(p[0], p[1], evt);
  }

  private onBusDoubleClick(evt: any): void {
    const p = this.pointOf(evt);
    if (p) this.handleDoubleClick(p[0], p[1], evt);
  }

  private onBusWheel(evt: any): void {
    const p = this.pointOf(evt);
    if (p) this.handleWheel(p[0], p[1], Number(evt.deltaY) || 0, evt);
  }

  private onBusKeyDown(evt: any): void {
    this.handleKeyDown(evt && evt.key, evt);
  }

  // ------------------------------------------------------------- 悬停

  /**
   * 数据域变化（缩放 / 平移 / 滑块 / 数据更新 / 图例切换）后重新定位悬停。
   *
   * 为什么必须做：悬停状态里存的是**像素**（十字准星位置、高亮环、提示框锚点），
   * 而缩放/平移后同一份数据的像素已经变了。不重新定位就会出现
   * 「准星停在原地、和曲线脱开」这种一眼可见的错位。
   */
  public refreshHover(): void {
    const current = this.hover;
    if (!current) return;
    const norm = this.host.norm;
    if (current.kind === 'item') {
      // 必须换成**当前这一轮** norm 里的系列对象：buildActiveItem 按对象身份找组件，
      // 用上一轮的对象会找不到（悬停被清掉），而且提示框里会显示旧数据。
      const series =
        norm.series.find((s) => s.id === current.item.series.id) || current.item.series;
      const index = current.item.point.index;
      const sliceHidden = (series.type === 'pie' || series.type === 'funnel') && norm.hiddenSlices[`${series.id}#${index}`];
      // 系列/扇区被隐藏，或数据被替换导致下标越界 → 直接清理，不要悄悄跳到别的系列
      if (series.hidden || sliceHidden || !series.pointAt(index)) {
        this.setHover(null);
        return;
      }
      const item = this.resolver.buildActiveItem(series, index);
      // 数据点已经不在可见窗口内（缩放 / 平移之后）→ 清理，不要在绘图区外画准星
      if (!item || !this.resolver.isInsidePlot(item.pixel[0], item.pixel[1])) {
        this.setHover(null);
        return;
      }
      this.setHover({ kind: 'item', item }, this.externalHover);
      return;
    }
    const item = this.resolver.nearestByXValue(current.column.xValue);
    const column = item ? this.resolver.pickColumn(item.pixel[0], item.pixel[1]) : null;
    // 非直角坐标场景（雷达 / 饼图）也可能出现 axis 悬停 —— 它们的「列」不是一条竖线，
    // 但同一列（同一个指标 / 同一个切片下标）的语义仍然成立，照旧重新解析即可。
    // 以前这里对非直角坐标直接清空，于是**每次数据更新都会把悬停踢掉**
    // （大屏上的雷达/玫瑰每 0.5s 更新一次，悬停反馈永远起不来，实测 highlightT 卡在 0.01）。
    if (!column) {
      this.setHover(null);
      return;
    }
    if (norm.kind === 'cartesian' && !this.resolver.isInsidePlot(column.pixelX, column.items[0].pixel[1])) {
      this.setHover(null);
      return;
    }
    this.setHover({ kind: 'axis', column }, this.externalHover);
  }

  public resolveTarget(screenX: number, screenY: number): TargetInfo {
    return this.resolver.resolveTarget(screenX, screenY);
  }

  public handlePointerMove(screenX: number, screenY: number, evt?: any): void {
    if (this.drag) {
      this.updateDrag(screenX, screenY, evt);
      return;
    }
    // 页面上的其它图表也会收到这次移动（引擎监听在 window 上），必须忽略。
    // 但"忽略"不等于"什么都不做"：指针已经离开本图时，本图残留的悬停（准星 + 提示框 +
    // 高亮环）必须主动收起 —— 否则鼠标划出去之后提示框会一直挂在画面上，用户没有任何
    // 办法把它弄掉（画布外不再产生让本图重新取悬停的坐标）。
    if (!this.isOverCanvas(screenX, screenY)) {
      // 只收自己放上去的悬停。外部（联动）按 x 值放上来的由放它的那一方收回，
      // 这里清掉的话，被回显的图会在同一次 mousemove 里立刻把回显删掉。
      if (this.hover && !this.externalHover) this.setHover(null);
      return;
    }
    this.updateHover(screenX, screenY);
  }

  public updateHover(screenX: number, screenY: number): void {
    const interaction = this.host.norm.option.interaction;
    if (interaction && interaction.hover && interaction.hover.enabled === false) return;
    const target = this.resolveTarget(screenX, screenY);

    if (target.kind === 'legend') {
      const legend = this.host.legend;
      if (legend && legend.hoverIndex !== target.index) {
        legend.hoverIndex = target.index;
        legend.markDirty();
      }
      // 只收起数据层的视觉，不能顺手重置图例自身的悬停高亮
      this.clearDataVisuals();
      this.setHoverState(null);
      return;
    }
    this.resetLegendHover();

    const trigger = (this.host.norm.option.tooltip && this.host.norm.option.tooltip.trigger) || 'axis';
    const inside = this.resolver.isInsidePlot(target.chart[0], target.chart[1]);

    // axis 触发器优先：即使指针正好落在某条折线上，也展示整列的多个系列值
    //（与主流 axis tooltip 语义一致）。item 触发器才只认命中的那一个数据点。
    if (inside && trigger === 'axis') {
      const column = this.resolver.pickColumn(target.chart[0], target.chart[1]);
      if (column) {
        this.setHover({ kind: 'axis', column });
        return;
      }
    }
    if (target.kind === 'series' && target.index >= 0) {
      const series = this.resolver.seriesOfComponent(target.component);
      const item = series ? this.resolver.buildActiveItem(series, target.index) : null;
      if (item) {
        this.setHover({ kind: 'item', item });
        return;
      }
    }
    this.setHover(null);
  }

  private resetLegendHover(): void {
    const legend = this.host.legend;
    if (legend && legend.hoverIndex !== -1) {
      legend.hoverIndex = -1;
      legend.markDirty();
    }
  }

  /**
   * 设定悬停。`external` 标记这次悬停是不是外部（联动 / 编程式）放上来的，
   * 见 `externalHover`：指针自己产生的悬停可以被指针收回，外部的不能。
   */
  public setHover(
    next: { kind: 'item'; item: ActiveItem } | { kind: 'axis'; column: ActiveColumn } | null,
    external = false
  ): void {
    this.externalHover = next ? external : false;
    const had = !!this.hover;
    this.hover = next;
    if (!next) {
      this.clearHoverVisuals();
      this.dimOthers(null);
      if (had) this.host.emit('item:leave', undefined);
      return;
    }
    this.applyHoverVisuals(next);
    if (next.kind === 'item') {
      this.keyboardIndex = next.item.point.index;
      this.dimOthers(next.item.series.id);
      this.host.emit('item:hover', this.resolver.toParams(next.item));
    } else {
      this.dimOthers(null);
      if (next.column.items[0]) this.host.emit('item:hover', this.resolver.toParams(next.column.items[0]));
    }
  }

  private setHoverState(next: { kind: 'item'; item: ActiveItem } | { kind: 'axis'; column: ActiveColumn } | null): void {
    this.hover = next;
  }

  private applyHoverVisuals(state: { kind: 'item'; item: ActiveItem } | { kind: 'axis'; column: ActiveColumn }): void {
    const items = state.kind === 'item' ? [state.item] : state.column.items;
    const anchor = items[0];
    this.syncSeriesHover(items);
    const highlight = this.host.highlight;
    if (highlight) {
      highlight.setHover(this.hoverMarkEnabled() ? items.map((item) => this.markFor(item)) : []);
    }
    const crosshair = this.host.crosshair;
    if (crosshair) {
      if (this.host.norm.kind !== 'cartesian' || this.host.norm.orientation === 'horizontal') {
        // 极坐标没有直角准星的概念，直接收起
        // 横向柱状图的类目在 y 轴、数值在 x 轴，十字准星同样没有意义（默认 item 触发器）
        crosshair.hide();
      } else {
        const axisMode = (this.host.norm.option.crosshair && this.host.norm.option.crosshair.axis) || 'x';
        // 面板矩阵：准星只画在**指针所在那块面板**里（横穿所有面板的线指代不清）
        const panel = this.resolver.panelAt(anchor.pixel[0], anchor.pixel[1]);
        crosshair.plot = panel >= 0 ? this.resolver.panelRect(panel) : null;
        crosshair.show(
          axisMode === 'y' ? null : anchor.pixel[0],
          axisMode === 'x' ? null : anchor.pixel[1],
          this.host.formatAxisValue('x', anchor.point.xValue),
          anchor.point.y === null ? '' : this.host.formatAxisValue('y', anchor.point.y)
        );
      }
    }
    const tooltip = this.host.tooltip;
    if (tooltip) {
      if (this.host.norm.option.tooltip && this.host.norm.option.tooltip.show === false) {
        tooltip.hide();
      } else {
        const content = this.buildTooltipContent(state);
        const anchorPixel: [number, number] =
          state.kind === 'axis' ? [state.column.pixelX, anchor.pixel[1]] : [anchor.pixel[0], anchor.pixel[1]];
        // 面板矩阵：避让边界取**指针所在的那块面板**（否则第一行面板的提示框会压住自己的准星标签）
        const panel = this.resolver.panelAt(anchorPixel[0], anchorPixel[1]);
        tooltip.plot = panel >= 0 ? this.resolver.panelRect(panel) : null;
        tooltip.show(content, anchorPixel);
      }
    }
  }

  private buildTooltipContent(state: { kind: 'item'; item: ActiveItem } | { kind: 'axis'; column: ActiveColumn }) {
    const items = state.kind === 'item' ? [state.item] : state.column.items;
    const anchorItem = items[0];
    // 横向排布：标题是类目（y 轴），数值走 x 轴格式化
    if (anchorItem && this.host.norm.orientation === 'horizontal') {
      return {
        title: this.host.formatAxisValue('y', anchorItem.point.xValue),
        rows: items.map((item) => ({
          name: item.series.name,
          value: item.point.y === null ? '-' : this.host.formatAxisValue('x', item.point.y),
          color: item.series.color,
        })),
      };
    }
    // 饼图 / 玫瑰图：一张图一个系列，提示内容按扇区组织
    if (anchorItem && anchorItem.series.type === 'pie') {
      const series = anchorItem.series;
      const point = anchorItem.point;
      let total = 0;
      for (let i = 0; i < series.pointCount; i++) {
        const p = series.pointAt(i);
        if (this.host.norm.hiddenSlices[`${series.id}#${p.index}`]) continue;
        total += p.y || 0;
      }
      const value = point.y || 0;
      const percent = total > 0 ? (value / total) * 100 : 0;
      return {
        title: series.name,
        rows: [
          {
            name: point.name || `${this.host.norm.labels.slice} ${point.index + 1}`,
            value: `${percent.toFixed(1)}%`,
            color: point.color || series.color,
          },
        ],
      };
    }
    // 漏斗图：标题是阶段名，数值带上占可见总量的百分比
    if (anchorItem && anchorItem.series.type === 'funnel') {
      const series = anchorItem.series;
      const point = anchorItem.point;
      let total = 0;
      for (let i = 0; i < series.pointCount; i++) {
        const p = series.pointAt(i);
        if (this.host.norm.hiddenSlices[`${series.id}#${p.index}`]) continue;
        total += p.y || 0;
      }
      const percent = total > 0 ? ((point.y || 0) / total) * 100 : 0;
      return {
        title: point.name || this.host.formatAxisValue('x', point.xValue),
        rows: [
          {
            name: series.name,
            value: `${point.y === null ? '-' : point.y}（${percent.toFixed(1)}%）`,
            color: point.color || series.color,
          },
        ],
      };
    }
    // 仪表盘：只有一个数值
    if (anchorItem && anchorItem.series.type === 'gauge') {
      const series = anchorItem.series;
      const point = anchorItem.point;
      return {
        title: point.name || series.name,
        rows: [{ name: series.name, value: point.y === null ? '-' : String(point.y), color: series.color }],
      };
    }
    // 水位图：一个数值 + 水位比例
    if (anchorItem && anchorItem.series.type === 'liquid') {
      const series = anchorItem.series;
      const point = anchorItem.point;
      const option: any = (series.option as any).liquid || {};
      const min = isFinite(Number(option.min)) ? Number(option.min) : 0;
      const max = isFinite(Number(option.max)) ? Number(option.max) : 100;
      const value = point.y === null ? min : Number(point.y);
      const ratio = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
      return {
        title: point.name || series.name,
        rows: [
          { name: series.name, value: `${value}${option.unit === undefined ? '%' : option.unit}`, color: series.color },
          { name: this.host.norm.labels.liquid, value: `${(ratio * 100).toFixed(1)}%`, color: this.host.norm.theme.subTextColor },
        ],
      };
    }
    // 函数绘图 / 参数曲线：把「自变量 → 坐标」讲清楚（数学图的提示框就是这个信息）
    if (anchorItem && (anchorItem.series.type === 'function' || anchorItem.series.type === 'parametric')) {
      const series = anchorItem.series;
      const raw: any = anchorItem.point.raw || {};
      const isFunction = series.type === 'function';
      const variable = isFunction ? 'x' : 't';
      const parameter = isFunction ? Number(raw.x ?? anchorItem.point.xValue) : Number(raw.t ?? anchorItem.point.xValue);
      const x = Number(raw.x);
      const y = Number(raw.y);
      const fmt = (value: number): string => {
        if (!isFinite(value)) return '—';
        // 数学图看的是「形状」，4 位有效数字足够，又不至于出现 0.30000000000000004
        return String(Number(value.toPrecision(4)));
      };
      return {
        title: `${variable} = ${fmt(parameter)}`,
        rows: isFunction
          ? [
              { name: series.name, value: fmt(y), color: series.color },
              { name: this.host.norm.labels.coordinate, value: `(${fmt(x)}, ${fmt(y)})`, color: this.host.norm.theme.subTextColor },
            ]
          : [
              { name: this.host.norm.labels.coordinate, value: `(${fmt(x)}, ${fmt(y)})`, color: series.color },
              { name: 'y', value: fmt(y), color: this.host.norm.theme.subTextColor },
            ],
      };
    }
    if (anchorItem && anchorItem.series.type === 'radar') {
      const series = anchorItem.series;
      const rows: Array<{ name: string; value: string; color: string }> = [];
      for (let i = 0; i < series.pointCount; i++) {
        const point = series.pointAt(i);
        rows.push({
          name: point.name || `${point.index + 1}`,
          value: point.y === null ? '-' : String(point.y),
          color: point.index === anchorItem.point.index ? series.color : this.host.norm.theme.subTextColor,
        });
      }
      return {
        title: series.name,
        rows,
      };
    }
    // 箱线图：五数概括
    if (anchorItem && anchorItem.series.type === 'boxplot') {
      const point: any = anchorItem.point;
      const summary = point.boxplot;
      if (summary) {
        const labels = ['最小值', '下四分位', '中位数', '上四分位', '最大值'];
        return {
          title: point.name || this.host.formatAxisValue('x', point.xValue),
          rows: summary.map((value: number, i: number) => ({
            name: labels[i],
            value: String(value),
            color: anchorItem.series.color,
          })),
        };
      }
    }
    // 多轴分类流：节点给总量，带子给「从谁到谁 + 流量」
    if (anchorItem && anchorItem.series.type === 'alluvial') {
      const point: any = anchorItem.point;
      const raw: any = point.raw || {};
      if (raw.__alluvialNode) {
        return {
          title: `${raw.axis}：${raw.name}`,
          rows: [
            {
              name: '总量',
              value: String(Number(Number(raw.total).toPrecision(4))),
              color: anchorItem.series.color,
            },
          ],
        };
      }
      if (raw.__alluvialFlow) {
        return {
          title: `${raw.from} → ${raw.to}`,
          rows: [
            {
              name: '流量',
              value: String(Number(Number(raw.value).toPrecision(4))),
              color: anchorItem.series.color,
            },
          ],
        };
      }
    }
    // 日历热力：一天一个格子 —— 标题是日期，值就是那天的数值
    if (anchorItem && anchorItem.series.type === 'calendar') {
      const point: any = anchorItem.point;
      const date = point.calendar ? point.calendar.date : point.name;
      if (date) {
        return {
          title: String(date),
          rows: [
            {
              name: anchorItem.series.name || this.host.norm.labels.value || '数值',
              value: point.y === null ? '-' : String(point.y),
              color: anchorItem.series.color,
            },
          ],
        };
      }
    }
    /**
     * 六边形分箱：交互单位是**格子**（不是某个原始点）—— 提示框给格子的聚合值与点数。
     *
     * 格子是像素空间的产物（缩放会重新分格），不在 `series.points` 里，所以这里
     * 从组件拿（`binAt(hitIndex)`）；命中的 `point.index` 就是格子下标。
     */
    if (anchorItem && anchorItem.series.type === 'hexbin') {
      const component: any = this.resolver.seriesComponentOf(anchorItem.series);
      const bin = component && typeof component.binAt === 'function' ? component.binAt(anchorItem.point.index) : null;
      if (bin) {
        const option: any = anchorItem.series.option.hexbin || {};
        const label = option.aggregate === 'sum' ? '合计' : option.aggregate === 'mean' ? '均值' : option.aggregate === 'max' ? '最大' : '点数';
        return {
          title: `格 (${bin.q}, ${bin.r})`,
          rows: [
            { name: label, value: String(Number(bin.value.toPrecision(4))), color: anchorItem.series.color },
            { name: '点数', value: String(bin.count), color: this.host.norm.theme.subTextColor },
          ],
        };
      }
    }
    // 小提琴图：组名 + 观测数与五数概括（读的是归一化算好的密度轮廓，不重算）
    if (anchorItem && anchorItem.series.type === 'violin') {
      const point: any = anchorItem.point;
      const profile = point.violin;
      if (profile) {
        let peak = 0;
        for (const density of profile.density) if (density > peak) peak = density;
        const summaryLabels = ['最小值', '下四分位', '中位数', '上四分位', '最大值'];
        return {
          title: point.name || this.host.formatAxisValue('x', point.xValue),
          rows: [
            {
              name: '观测数',
              value: String(profile.values.length),
              color: anchorItem.series.color,
            },
            ...profile.summary.map((value: number, i: number) => ({
              name: summaryLabels[i],
              value: this.host.formatAxisValue('y', value),
              color: anchorItem.series.color,
            })),
            {
              name: '峰值密度',
              value: peak > 0 ? String(Number(peak.toPrecision(3))) : '—',
              color: this.host.norm.theme.subTextColor,
            },
          ],
        };
      }
    }
    // 蜂群图：一个观测一个点，提示框给「哪一组 + 多少」
    if (anchorItem && anchorItem.series.type === 'beeswarm') {
      const point: any = anchorItem.point;
      if (point.y !== null) {
        return {
          title: this.host.formatAxisValue('x', point.xValue),
          rows: [
            {
              name: anchorItem.series.name || this.host.norm.labels.value || '数值',
              value: this.host.formatAxisValue('y', point.y),
              color: anchorItem.series.color,
            },
          ],
        };
      }
    }
    // 瀑布图：变化量 + 累计
    if (anchorItem && anchorItem.series.type === 'waterfall') {
      const point = anchorItem.point;
      const delta = point.y || 0;
      return {
        title: point.name || this.host.formatAxisValue('x', point.xValue),
        rows: [
          {
            name: delta >= 0 ? '增加' : '减少',
            value: `${delta >= 0 ? '+' : ''}${delta}`,
            color: anchorItem.series.color,
          },
          { name: '累计', value: String(point.top), color: this.host.norm.theme.subTextColor },
        ],
      };
    }
    // 矩形树图：名称 + 数值 + 占根总量比例
    if (anchorItem && anchorItem.series.type === 'treemap') {
      const series = anchorItem.series;
      const point = anchorItem.point;
      const root = series.pointAt(0);
      const rootTotal = root && root.index === 0 ? root.y || 0 : 0;
      void rootTotal;
      const value = point.y || 0;
      // 占比用「同类目下的总量」不好界定，这里统一按根节点总量算
      let total = 0;
      for (let i = 0; i < series.pointCount; i++) {
        const p = series.pointAt(i);
        const raw: any = p.raw;
        if (raw && Array.isArray(raw.children) && raw.children.length) continue;
        total += p.y || 0;
      }
      const percent = total > 0 ? (value / total) * 100 : 0;
      return {
        title: point.name || String(point.xValue),
        rows: [
          { name: series.name, value: `${value}（${percent.toFixed(1)}%）`, color: anchorItem.series.color },
        ],
      };
    }
    // 关系图：节点给权重与度数，连线给两端与流量
    if (anchorItem && anchorItem.series.type === 'graph') {
      const component: any = this.resolver.seriesComponentOf(anchorItem.series);
      const point: any = anchorItem.point;
      const nodeCount = (component && component.nodeCount) || 0;
      const isLink = point.index >= nodeCount;
      if (isLink) {
        const link = component && component.graph ? component.graph.layout.links[point.index - nodeCount] : null;
        const nodes = component && component.graph ? component.graph.layout.nodes : [];
        return {
          title: point.name,
          rows: [
            {
              name: '流量',
              value: link ? String(link.value) : String(point.y),
              color: link ? link.color : anchorItem.series.color,
            },
            ...(link && nodes[link.source] && nodes[link.target]
              ? [{ name: '度数', value: String(nodes[link.source].degree + nodes[link.target].degree), color: this.host.norm.theme.subTextColor }]
              : []),
          ],
        };
      }
      return {
        title: point.name,
        rows: [
          { name: '权重', value: point.y === null ? '-' : String(point.y), color: anchorItem.series.color },
          {
            name: '连接数',
            value: String(component && component.graph && component.graph.layout.nodes[point.index] ? component.graph.layout.nodes[point.index].degree : 0),
            color: this.host.norm.theme.subTextColor,
          },
        ],
      };
    }
    if (anchorItem && anchorItem.series.type === 'heatmap') {
      const point = anchorItem.point;
      return {
        title: point.name || this.host.formatAxisValue('x', point.xValue),
        rows: [
          {
            name: this.host.formatAxisValue('x', point.xValue),
            value: point.y === null ? '-' : this.host.formatAxisValue('y', point.y),
            color: point.color || anchorItem.series.color,
          },
        ],
      };
    }
    if (anchorItem && anchorItem.series.type === 'sankey') {
      const point: any = anchorItem.point;
      const isLink = !!(point.raw && point.raw.__sankeyLink);
      return {
        title: isLink ? point.name : '节点',
        rows: [
          {
            name: isLink ? '流量' : point.name,
            value: point.y === null ? '-' : String(point.y),
            color: anchorItem.series.color,
          },
        ],
      };
    }
    const xValue = state.kind === 'item' ? state.item.point.xValue : state.column.xValue;
    const title = this.host.formatAxisValue('x', xValue);
    const rows = items.map((item) => ({
      name: item.series.name,
      value: item.point.y === null ? '-' : this.host.formatAxisValue('y', item.point.y),
      color: item.series.color,
    }));
    const formatter = this.host.norm.option.tooltip && this.host.norm.option.tooltip.formatter;
    if (typeof formatter === 'function') {
      const params: TooltipParams = {
        items: items.map((item) => this.resolver.toParams(item)),
        dataIndex: state.kind === 'item' ? state.item.point.index : state.column.dataIndex,
        xValue,
      };
      const out: any = formatter(params);
      if (Array.isArray(out)) {
        return {
          title: out[0] === undefined ? title : String(out[0]),
          rows: out.slice(1).map((line: any, i: number) => ({
            name: String(line),
            value: '',
            color: items[i] ? items[i].series.color : '#999999',
          })),
        };
      }
      if (typeof out === 'string') return { title: out, rows: [] };
      if (out && typeof out === 'object' && (out.title !== undefined || out.rows !== undefined)) {
        return { title: out.title || title, rows: out.rows || rows };
      }
    }
    return { title, rows };
  }

  private clearHoverVisuals(): void {
    this.clearDataVisuals();
    this.resetLegendHover();
  }

  /** 只清理数据层（高亮环 / 准星 / 提示框），不动图例悬停。 */
  private clearDataVisuals(): void {
    this.syncSeriesHover([]);
    if (this.host.highlight) this.host.highlight.setHover([]);
    if (this.host.crosshair) this.host.crosshair.hide();
    if (this.host.tooltip) this.host.tooltip.hide();
  }

  /**
   * 悬停时是否在数据点上画标记，由 `interaction.hover.mark` 控制（默认开）。
   *
   * 标记环是一圈**半透明白**填充 + 彩色描边：落在蜡烛上会遮住正要看的那一根，
   * 而且 `mode: 'nearest-x'` 时同一列里每个系列各画一个，比准星本身还抢眼。
   * 只做十字准星（主流看盘软件的做法）时可以关掉。
   */
  private hoverMarkEnabled(): boolean {
    const interaction = this.host.norm.option.interaction;
    return !(interaction && interaction.hover && interaction.hover.mark === false);
  }

  /** 把「当前悬停的数据项」下发给系列：图元自己会做放大/外移等反馈动画。 */
  private syncSeriesHover(items: ActiveItem[]): void {
    const hovered = new Map<string, number>();
    for (const item of items) {
      if (!hovered.has(item.series.id)) hovered.set(item.series.id, item.point.index);
    }
    for (const component of this.host.seriesComponents) {
      const index = hovered.get(component.series.id);
      component.setHoverIndex(index === undefined ? null : index);
    }
  }

  /** 生成高亮标记：数据点用圆环，柱形用矩形描边。 */
  private markFor(item: ActiveItem): HighlightItem {
    const component = this.resolver.seriesComponentOf(item.series);
    const plot = this.host.layout.plot;
    if (component && item.series.type === 'bar' && typeof (component as any).barRectAt === 'function') {
      // 用 t=1 的**终态**绘制矩形：悬停时柱子会沿值方向长一点，
      // 描边必须贴着长完之后的轮廓（用基础矩形会看到描边横在柱子中间）。
      // 再与绘图区求交：越界部分被 clip 掉了，描边也不该画到坐标轴上。
      const drawn = typeof (component as any).barDrawRectAt === 'function' ? (component as any).barDrawRectAt(item.point.index, 1) : null;
      const raw = drawn || (component as any).barRectAt(item.point.index);
      const rect = raw
        ? {
            x: Math.max(raw.x, 0),
            y: Math.max(raw.y, 0),
            width: Math.max(0, Math.min(raw.x + raw.width, plot.width) - Math.max(raw.x, 0)),
            height: Math.max(0, Math.min(raw.y + raw.height, plot.height) - Math.max(raw.y, 0)),
          }
        : null;
      if (rect && rect.width > 0 && rect.height > 0) {
        return {
          // 统一约定：x/y 一律是标记中心（圆环是圆心，柱形是矩形中心）
          x: plot.x + rect.x + rect.width / 2,
          y: plot.y + rect.y + rect.height / 2,
          width: rect.width,
          height: rect.height,
          color: item.series.color,
          size: 0,
          shape: 'rect',
        };
      }
    }
    return { x: item.pixel[0], y: item.pixel[1], color: item.series.color, size: symbolSizeOf(item.series), shape: 'circle' };
  }

  /**
   * 未命中高亮时压低其他系列的不透明度。
   * 只在「悬停系列发生变化」时写 state —— 每次 mousemove 都写会让所有系列每帧变脏，
   * 脏矩形局部重绘的优势就没了。
   */
  private dimOthers(seriesId: string | null): void {
    const interaction = this.host.norm.option.interaction;
    const enabled = !!(interaction && interaction.hover && interaction.hover.dimOthers);
    const next = enabled ? seriesId : null;
    if (next === this.lastDimmed) return;
    this.lastDimmed = next;
    const dimOpacity = this.host.norm.theme.selection.dimOpacity;
    for (const component of this.host.seriesComponents) {
      const shouldDim = enabled && next !== null && component.series.id !== next;
      component.setState({ opacity: shouldDim ? dimOpacity : 1 });
    }
  }

  // ------------------------------------------------------------- 指针

  /**
   * 按在滑块上：进入拖动（手柄改跨度 / 窗口平移 / 点轨道居中）。
   *
   * `axis` 决定把比例窗口喂给谁 —— x 走 `setDomainFromFractions`（带「至少盖住 2 个点」的兜底），
   * y 走 `setDomainYFromFractions`（兜底在 `clampAxisDomain` 里，见那边的注释）。
   * 比例一律走 `slider.fractionAt`，由组件按自己的方向解释（纵向是 `1 - y/height`）。
   */
  private beginSliderDrag(
    axis: 'x' | 'y',
    slider: DataZoomSlider,
    target: { local: [number, number] },
    screenX: number,
    screenY: number,
    evt?: any
  ): boolean {
    const part = slider.hitPart(target.local[0], target.local[1]);
    if (!part) return false;
    this.preventDefault(evt);
    // 拖滑块时指针已经不在绘图区上，收起悬停视觉
    this.setHover(null);
    const fraction = slider.fractionAt(target.local[0], target.local[1]);
    this.drag = {
      mode: 'slider',
      axis,
      part,
      startX: screenX,
      startY: screenY,
      originStart: slider.start,
      originEnd: slider.end,
      anchorFraction: fraction,
      moved: false,
    };
    slider.setActive(part);
    if (part === 'track') {
      // 点击轨道：把窗口平移到点击处
      const span = slider.end - slider.start;
      const start = clamp(fraction - span / 2, 0, 1 - span);
      this.applySliderWindow(axis, start, start + span, slider.axisIndex);
      slider.setActive('window');
      this.drag.part = 'window';
      this.drag.originStart = start;
      this.drag.originEnd = start + span;
    }
    return true;
  }

  /** 把滑块的 0~1 窗口喂给对应轴（唯一的出口，拖动与点轨道都走它）；`axisIndex` 只对纵向有意义。 */
  private applySliderWindow(axis: 'x' | 'y', start: number, end: number, axisIndex = 0): void {
    if (axis === 'y') this.host.setDomainYFromFractions(start, end, 'slider', axisIndex);
    else this.host.setDomainFromFractions(start, end, 'slider', true);
  }

  public handlePointerDown(screenX: number, screenY: number, evt?: any): boolean {
    if (!this.isOverCanvas(screenX, screenY)) return false;
    // 有意把 this 注册到模块级「当前键盘焦点」，不是词法作用域的 this 别名：
    // 一个页面上多张图都会收到 window 上的键盘事件，必须知道该由谁响应。
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    activeController = this;
    const target = this.resolveTarget(screenX, screenY);
    if (target.kind === 'legend') return true;
    // 两条滑块走同一段逻辑（横向那条管 x 窗口，竖直那条管 y 窗口）
    for (const [axis, slider] of [
      ['x', this.host.dataZoomSlider],
      ['y', this.host.dataZoomSliderY],
    ] as Array<['x' | 'y', DataZoomSlider | null]>) {
      if (slider && target.component === slider) {
        if (this.beginSliderDrag(axis, slider, target, screenX, screenY, evt)) return true;
      }
    }
    // 关系图：按下节点即可拖动（这是力导向图最常用的交互）
    if (
      target.kind === 'series' &&
      target.index >= 0 &&
      target.component &&
      target.component.seriesType === 'graph' &&
      typeof target.component.moveNode === 'function' &&
      target.index < (target.component.nodeCount || 0) &&
      (!target.component.graph || target.component.graph.options.draggable !== false)
    ) {
      this.preventDefault(evt);
      this.setHover(null);
      this.drag = {
        mode: 'graph-node',
        component: target.component,
        nodeIndex: target.index,
        startX: screenX,
        startY: screenY,
        moved: false,
      };
      return true;
    }
    // 桑基图：按下节点即可**在自己的列里**拖着重排（列由分层决定，横向没有意义）
    if (
      target.kind === 'series' &&
      target.index >= 0 &&
      target.component &&
      target.component.seriesType === 'sankey' &&
      target.component.sankey &&
      typeof target.component.moveNode === 'function' &&
      target.index < (target.component.nodeCount || 0) &&
      (!target.component.sankey.options || target.component.sankey.options.draggable !== false)
    ) {
      this.preventDefault(evt);
      this.setHover(null);
      const [worldX, worldY] = this.host.ice.screenToWorld(screenX, screenY);
      const local = target.component.globalToLocal(worldX, worldY);
      const node = target.component.sankey.layout.nodes[target.index];
      const sankeyPlot = target.component.sankey.plot;
      this.drag = {
        mode: 'sankey-node',
        component: target.component,
        nodeIndex: target.index,
        // 注意两套坐标：节点几何在**图表坐标**里，指针换算出来的是**组件本地坐标**
        grabOffsetY: node ? node.y - sankeyPlot.y + node.height / 2 - local[1] : 0,
        orderBefore: target.component.columnOrderOf(target.index),
        startX: screenX,
        startY: screenY,
        moved: false,
      };
      return true;
    }
    // 数据坐标图元（注释卡片 / 阈值线 / 预测带）：按在它上面时交给组件自己处理拖拽，
    // 图表层不要抢着开始框选 / 平移 —— 否则「拖注释」会变成「拖画布」。
    if (target.component && typeof this.host.isMarkComponent === 'function' && this.host.isMarkComponent(target.component)) {
      this.setHover(null);
      return false;
    }
    if (!this.resolver.isInsidePlot(target.chart[0], target.chart[1])) return false;

    const interaction = this.host.norm.option.interaction || {};
    const brushOption: any = interaction.brush;
    const panOption: any = interaction.pan;
    const brushEnabled = !!(brushOption && brushOption !== false && brushOption.enabled !== false);
    const panEnabled = !!(panOption && panOption !== false && panOption.enabled);
    this.preventDefault(evt);
    if (brushEnabled) {
      // 框选期间收起悬停视觉，避免准星/提示框和选框一起跳动
      this.setHover(null);
      this.drag = { mode: 'brush', startX: screenX, startY: screenY, moved: false };
      if (this.host.brush) this.host.brush.setRect({ x: target.chart[0], y: target.chart[1], width: 0, height: 0 });
      return true;
    }
    if (panEnabled) {
      this.setHover(null);
      const panelRect = this.resolver.panelRect(this.resolver.panelAt(target.chart[0], target.chart[1]));
      const vp: any = this.host.ice.viewport || { scale: 1, tx: 0, ty: 0 };
      this.drag = {
        mode: 'pan',
        startX: screenX,
        startY: screenY,
        domainX: this.currentXWindow(),
        domainY: [this.host.norm.yAxis.domain[0], this.host.norm.yAxis.domain[1]],
        viewport: { scale: Number(vp.scale) || 1, tx: Number(vp.tx) || 0, ty: Number(vp.ty) || 0 },
        panelWidth: panelRect.width,
        panelHeight: panelRect.height,
        moved: false,
      };
      return true;
    }
    return false;
  }

  /**
   * 当前 x 窗口的两个**端点值**（拖动平移的起点）。
   *
   * 为什么不能直接拿 `norm.xAxis.domain` 当窗口：**类目轴的 `domain` 是窗口内的整串类目**
   * （窗口里有 120 根就是 120 项），只有连续轴才是 `[min, max]` 两项。早先这里判
   * `domain.length === 2`，于是类目轴的横向平移**整条分支被跳过** —— 因为纵向照常工作，
   * 表现就是「只能上下拖、左右拖不动」这种怪现象（K 线图正是类目轴）。
   */
  private currentXWindow(): [any, any] | null {
    const axis = this.host.norm.xAxis;
    const domain = axis && axis.domain;
    if (!domain || domain.length < 2) return null;
    return axis.type === 'category' ? [domain[0], domain[domain.length - 1]] : [domain[0], domain[1]];
  }

  public handlePointerUp(screenX: number, screenY: number, _evt?: any): void {
    // 图元拖拽由引擎的组件拖动处理，图表层没有自己的 drag 状态 —— 这里统一收尾
    if (typeof this.host.finishMarkDrag === 'function') this.host.finishMarkDrag();
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (drag.mode === 'brush') {
      if (!drag.moved) {
        if (this.host.brush) this.host.brush.setRect(null);
        this.updateHover(screenX, screenY);
        return;
      }
      const range = this.brushRange();
      const brushOption: any = this.host.norm.option.interaction && this.host.norm.option.interaction.brush;
      if (brushOption && brushOption.mode === 'zoom' && range) {
        this.applyRange(range);
        if (this.host.brush) this.host.brush.setRect(null);
      }
      this.host.emit('brush:end', range);
      // 松手后按指针位置重新取悬停，避免「选框还在、提示框没了」
      this.updateHover(screenX, screenY);
      return;
    }
    if (drag.mode === 'slider') {
      const slider = drag.axis === 'x' ? this.host.dataZoomSlider : this.host.dataZoomSliderY;
      if (slider) slider.setActive(null);
      this.updateHover(screenX, screenY);
      return;
    }
    if (drag.mode === 'graph-node') {
      // 松手后跑少量迭代让邻居跟随（被拖的节点保持固定）
      const component = drag.component;
      if (drag.moved && component && typeof component.settle === 'function' && component.graph && component.graph.options.settleOnDrop !== false) {
        component.settle();
      }
      this.updateHover(screenX, screenY);
      return;
    }
    if (drag.mode === 'sankey-node') {
      // 松手才重排：拖动过程里只让节点跟手，松手时按落点算这一列的新顺序
      const component = drag.component;
      if (drag.moved && component && typeof component.commitOrder === 'function') {
        const info = component.commitOrder(drag.nodeIndex, drag.orderBefore);
        if (info) {
          const series = this.resolver.seriesOfComponent(component);
          this.host.emit('sankey:reorder', {
            seriesId: series ? series.id : undefined,
            seriesIndex: series ? series.index : undefined,
            ...info,
          });
        }
      }
      this.updateHover(screenX, screenY);
      return;
    }
    if (drag.mode === 'pan') {
      this.updateHover(screenX, screenY);
    }
  }

  private updateDrag(screenX: number, screenY: number, _evt?: any): void {
    const drag = this.drag;
    if (!drag) return;
    const dx = screenX - drag.startX;
    const dy = screenY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    const { plot } = this.host.layout;
    const [startWorldX, startWorldY] = this.host.ice.screenToWorld(drag.startX, drag.startY);
    const [worldX, worldY] = this.host.ice.screenToWorld(screenX, screenY);

    if (drag.mode === 'brush') {
      /**
       * 框选的范围口径（面板矩阵）：
       * - **x 夹到所有面板的并集** —— 小倍数的直觉是「刷一段 x，所有面板一起看」；
       * - **y 夹到起手时指针所在的那块面板** —— 纵向各面板的语义不同（数据/量纲都可能不一样），
       *   跨面板拉一条 y 区间没有意义。
       */
      const brushY = this.resolver.panelRect(this.resolver.panelAt(startWorldX, startWorldY));
      const x0 = clamp(startWorldX, plot.x, plot.x + plot.width);
      const y0 = clamp(startWorldY, brushY.y, brushY.y + brushY.height);
      const x1 = clamp(worldX, plot.x, plot.x + plot.width);
      const y1 = clamp(worldY, brushY.y, brushY.y + brushY.height);
      if (this.host.brush) {
        this.host.brush.setRect({ x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) });
      }
      const range = this.brushRange();
      if (range) this.host.emit('brush:change', range);
      return;
    }

    if (drag.mode === 'slider') {
      const slider = drag.axis === 'x' ? this.host.dataZoomSlider : this.host.dataZoomSliderY;
      if (!slider) return;
      drag.moved = true;
      const [worldX, worldY] = this.host.ice.screenToWorld(screenX, screenY);
      const [localX, localY] = slider.globalToLocal(worldX, worldY);
      const fraction = slider.fractionAt(localX, localY);
      const span = drag.originEnd - drag.originStart;
      let start = drag.originStart;
      let end = drag.originEnd;
      if (drag.part === 'start') {
        start = clamp(fraction, 0, drag.originEnd - 0.02);
      } else if (drag.part === 'end') {
        end = clamp(fraction, drag.originStart + 0.02, 1);
      } else {
        const shift = fraction - drag.anchorFraction;
        start = clamp(drag.originStart + shift, 0, 1 - span);
        end = start + span;
      }
      this.applySliderWindow(drag.axis, start, end, slider.axisIndex);
      return;
    }

    if (drag.mode === 'graph-node') {
      drag.moved = true;
      const component = drag.component;
      const [worldX, worldY] = this.host.ice.screenToWorld(screenX, screenY);
      const local = component.globalToLocal(worldX, worldY);
      component.moveNode(drag.nodeIndex, local[0], local[1]);
      // 拖动时同步更新提示框锚点，手感更连贯
      const series = this.resolver.seriesOfComponent(component);
      if (series) {
        const item = this.resolver.buildActiveItem(series, drag.nodeIndex);
        if (item) this.setHover({ kind: 'item', item });
      }
      return;
    }

    if (drag.mode === 'sankey-node') {
      drag.moved = true;
      const local = drag.component.globalToLocal(worldX, worldY);
      drag.component.moveNode(drag.nodeIndex, local[1], drag.grabOffsetY);
      return;
    }

    const panOption: any = this.host.norm.option.interaction && this.host.norm.option.interaction.pan;
    /**
     * 视图平移：拖的是**画布视图**（`ice.viewport` 的 tx / ty），不是数据域。
     *
     * 没有坐标轴的场景（力导向图 / 关系图）走这条 —— 那边没有数据域可改，按老路径拖了没反应，
     * 于是「能滚轮放大、不能拖」放大之后卡在正中间。方向与「抓住内容拖」一致：
     * `screenToWorld` 是 `(screen - tx) / scale`，tx 加多少内容就往右移多少。
     * 与滚轮缩放同一套像素量纲（都是 CSS 像素），所以缩放之后手感不变。
     */
    if (panOption && panOption.mode === 'viewport') {
      // 从**起手**的视图算绝对位移（`dx`/`dy` 本身就是相对起手点的累计量）
      const from = drag.viewport;
      this.host.ice.setViewport(from.scale, from.tx + dx, from.ty + dy);
      return;
    }
    const axes = (panOption && panOption.axes) || 'xy';
    if ((axes === 'x' || axes === 'xy') && drag.domainX) {
      const next = this.shiftDomain('x', drag.domainX, dx, drag.panelWidth);
      if (next) this.host.setDomain('x', next, 'pan');
    }
    if ((axes === 'y' || axes === 'xy') && drag.domainY) {
      const next = this.shiftDomain('y', drag.domainY, dy, drag.panelHeight);
      if (next) this.host.setDomain('y', next, 'pan');
    }
  }

  private shiftDomain(
    axis: 'x' | 'y',
    domain: [any, any],
    deltaPixels: number,
    panelSize?: number
  ): [any, any] | null {
    const internal = this.host.norm[axis === 'x' ? 'xAxis' : 'yAxis'];
    const scale = internal.scale;
    if (!scale) return null;
    const plot = this.host.layout.plot;
    const size = panelSize && isFinite(panelSize) ? panelSize : axis === 'x' ? plot.width : plot.height;
    if (scale.isBand()) {
      // 全集的来源是 `fullDomain`（**全部**类目），不是 `internal.domain` ——
      // 后者是**当前窗口内**的类目串，拿它当全集算出来的位移恒为 0（窗口在窗口里挪不动）。
      const full = this.host.fullDomain('x');
      const all = full && full.length ? full : internal.domain;
      const from = all.indexOf(domain[0]);
      const to = all.indexOf(domain[1]);
      if (from < 0 || to < 0 || all.length <= 1) return null;
      const step = scale.step() || size / Math.max(1, all.length);
      const shift = Math.round(-deltaPixels / step);
      const count = to - from;
      const nextFrom = clamp(from + shift, 0, Math.max(0, all.length - 1 - count));
      return [all[nextFrom], all[nextFrom + count]];
    }
    const span = Number(domain[1]) - Number(domain[0]);
    // 屏幕方向 → 数据方向的符号：内容要**跟着手走**。
    // x 轴「值越大越靠右」与屏幕同向；y 轴「值越大越靠上」与屏幕**反向** ——
    // 用同一个符号会让纵向拖动的方向整个反过来（实测用户一眼就看出「Y 轴方向反了」）。
    // 类目轴不走这里：band 的像素方向对两个轴都是「下标越大越靠下/右」，所以那边不用翻。
    const forward = axis === 'x' ? -1 : 1;
    const shift = ((forward * deltaPixels) / Math.max(1, size)) * span;
    return [Number(domain[0]) + shift, Number(domain[1]) + shift];
  }

  public handleClick(screenX: number, screenY: number, _evt?: any): void {
    if (!this.isOverCanvas(screenX, screenY)) return;
    const target = this.resolveTarget(screenX, screenY);
    const interaction = this.host.norm.option.interaction;
    if (target.kind === 'legend') {
      const legend = this.host.legend;
      if (legend && target.index >= 0) {
        const item = legend.items[target.index];
        if (item.dataIndex !== undefined) this.host.toggleSlice(item.seriesId, item.dataIndex);
        else this.host.toggleSeries(item.seriesId);
      }
      return;
    }
    if (target.kind === 'series' && target.index >= 0) {
      const series = this.resolver.seriesOfComponent(target.component);
      const item = series ? this.resolver.buildActiveItem(series, target.index) : null;
      if (item) {
        const params = this.resolver.toParams(item);
        this.host.emit('item:click', params);
        const selectOption: any = interaction && interaction.select;
        if (selectOption && selectOption.enabled) {
          this.toggleSelection(item.series.id, item.point.index, selectOption.mode || 'single', selectOption.toggle !== false);
        }
        return;
      }
    }
    if (this.resolver.isInsidePlot(target.chart[0], target.chart[1])) {
      const plot = this.host.layout.plot;
      this.host.emit('plot:click', {
        screen: [screenX, screenY],
        xValue: this.host.norm.xAxis.scale ? this.host.norm.xAxis.scale.invert(target.chart[0] - plot.x) : undefined,
        yValue: this.host.norm.yAxis.scale ? this.host.norm.yAxis.scale.invert(target.chart[1] - plot.y) : undefined,
      });
      return;
    }
    this.host.emit('chart:click', { screen: [screenX, screenY] });
  }

  public handleDoubleClick(screenX: number, screenY: number, _evt?: any): void {
    if (!this.isOverCanvas(screenX, screenY)) return;
    const target = this.resolveTarget(screenX, screenY);
    if (target.kind !== 'series' || target.index < 0) return;
    const series = this.resolver.seriesOfComponent(target.component);
    const item = series ? this.resolver.buildActiveItem(series, target.index) : null;
    if (item) this.host.emit('item:dblclick', this.resolver.toParams(item));
  }

  // ------------------------------------------------------------- 选中

  public toggleSelection(seriesId: string, dataIndex: number, mode: 'single' | 'multiple', toggle: boolean): void {
    const index = this.selection.findIndex((s) => s.seriesId === seriesId && s.dataIndex === dataIndex);
    if (mode === 'single') {
      this.selection = index >= 0 && toggle ? [] : [{ seriesId, dataIndex }];
    } else if (index >= 0) {
      this.selection.splice(index, 1);
    } else {
      this.selection.push({ seriesId, dataIndex });
    }
    this.refreshSelectionVisuals();
    this.host.emit('select:change', this.getSelectedParams());
  }

  public clearSelection(): void {
    if (!this.selection.length) return;
    this.selection = [];
    this.refreshSelectionVisuals();
    this.host.emit('select:change', []);
  }

  private refreshSelectionVisuals(): void {
    const highlight = this.host.highlight;
    if (!highlight) return;
    const marks: HighlightItem[] = [];
    for (const ref of this.selection) {
      const series = this.host.norm.series.find((s) => s.id === ref.seriesId);
      if (!series) continue;
      const item = this.resolver.buildActiveItem(series, ref.dataIndex);
      if (item) marks.push(this.markFor(item));
    }
    highlight.setSelection(marks);
  }

  public getSelectedParams(): DataPointParams[] {
    const out: DataPointParams[] = [];
    for (const ref of this.selection) {
      const series = this.host.norm.series.find((s) => s.id === ref.seriesId);
      if (!series) continue;
      const item = this.resolver.buildActiveItem(series, ref.dataIndex);
      if (item) out.push(this.resolver.toParams(item));
    }
    return out;
  }

  // ------------------------------------------------------------- 刷选 / 缩放 / 平移

  public get brushRect() {
    return this.host.brush ? this.host.brush.rect : null;
  }

  private brushRange(): BrushRange | null {
    const rect = this.brushRect;
    const { plot } = this.host.layout;
    if (!rect || (rect.width < 2 && rect.height < 2)) return null;
    const brushOption: any = this.host.norm.option.interaction && this.host.norm.option.interaction.brush;
    const axes = (brushOption && brushOption.axes) || 'x';
    const range: BrushRange = {};
    if (axes === 'x' || axes === 'xy') {
      const a = this.valueAtPixel('x', rect.x - plot.x);
      const b = this.valueAtPixel('x', rect.x + rect.width - plot.x);
      const ordered = this.orderValues('x', a, b);
      if (ordered) range.x = ordered;
    }
    if (axes === 'y' || axes === 'xy') {
      const a = this.valueAtPixel('y', rect.y - plot.y);
      const b = this.valueAtPixel('y', rect.y + rect.height - plot.y);
      const ordered = this.orderValues('y', a, b);
      if (ordered) range.y = ordered as [number, number];
    }
    return range.x || range.y ? range : null;
  }

  /** 像素 → 数据值；类目轴取命中带（或最近类目），数值轴取精确反算。 */
  private valueAtPixel(axis: 'x' | 'y', localPixel: number): any {
    const internal = this.host.norm[axis === 'x' ? 'xAxis' : 'yAxis'];
    const scale = internal.scale;
    if (!scale) return undefined;
    if (scale.isBand()) {
      const hit = scale.indexAt(localPixel);
      const index = hit >= 0 ? hit : (scale as any).nearestIndex ? (scale as any).nearestIndex(localPixel) : 0;
      return internal.domain[clamp(index, 0, internal.domain.length - 1)];
    }
    return scale.invert(localPixel);
  }

  private orderValues(axis: 'x' | 'y', a: any, b: any): [any, any] | null {
    if (a === undefined || b === undefined) return null;
    const scale = this.host.norm[axis === 'x' ? 'xAxis' : 'yAxis'].scale;
    if (scale && scale.isBand()) {
      const all = this.host.norm[axis === 'x' ? 'xAxis' : 'yAxis'].domain;
      const ia = all.indexOf(a);
      const ib = all.indexOf(b);
      return ia <= ib ? [a, b] : [b, a];
    }
    return Number(a) <= Number(b) ? [a, b] : [b, a];
  }

  private applyRange(range: BrushRange): void {
    if (range.x) this.host.setDomain('x', range.x, 'brush');
    if (range.y) this.host.setDomain('y', range.y, 'brush');
  }

  public handleWheel(screenX: number, screenY: number, deltaY: number, evt?: any): boolean {
    const zoomOption: any = this.host.norm.option.interaction && this.host.norm.option.interaction.zoom;
    if (!zoomOption || zoomOption === false || zoomOption.enabled === false || zoomOption.wheel === false) return false;
    const target = this.resolveTarget(screenX, screenY);
    if (!this.resolver.isInsidePlot(target.chart[0], target.chart[1])) return false;
    this.preventDefault(evt);
    const zoomFactor = Number(zoomOption.wheelFactor) || 1.2;
    // 约定：滚轮向上（deltaY < 0）= 放大，factor > 1 表示放大。
    // 曾经把 factor 定义成「缩小时 > 1」，结果类目轴（用除法）方向对、
    // 数值轴与视口缩放（用乘法）方向反 —— 同一次滚轮在不同轴上行为相反。
    const factor = deltaY < 0 ? zoomFactor : 1 / zoomFactor;
    if (zoomOption.mode === 'viewport') {
      this.host.ice.zoomAt(screenX, screenY, factor);
      return true;
    }
    const axes = zoomOption.axes || 'x';
    // 面板矩阵：锚点按**指针所在那块面板**换算（比例尺是每面板一套，矩形也不同）
    const plot = this.resolver.panelRect(this.resolver.panelAt(target.chart[0], target.chart[1]));
    if (axes === 'x' || axes === 'xy') {
      const next = this.zoomDomain('x', target.chart[0] - plot.x, factor, plot.width);
      if (next) this.host.setDomain('x', next, 'zoom');
    }
    if (axes === 'y' || axes === 'xy') {
      const next = this.zoomDomain('y', target.chart[1] - plot.y, factor, plot.height);
      if (next) this.host.setDomain('y', next, 'zoom');
    }
    return true;
  }

  /**
   * 一次手势缩放后的新窗口。
   *
   * 两套限制口径**按轴分开**：
   * - **类目轴**（K 线 / 时间轴）按「每根多少像素」夹（`minBarSpacing` / `maxBarSpacing`，
   *   见 `util/zoomLimit`）—— 这才是主流看盘软件的口径，而且不随「图上载入了多少根」
   *   漂移（早先按「数据域的 5%~100%」算：缩到底能到 0.24px/根，一根都占不到一个像素）。
   * - **连续轴**（价格轴这类）仍按「占完整数据域的比例」（`minSpan` / `maxSpan`）。
   */
  private zoomDomain(
    axis: 'x' | 'y',
    anchorPixel: number,
    factor: number,
    panelSize?: number
  ): [any, any] | null {
    const internal = this.host.norm[axis === 'x' ? 'xAxis' : 'yAxis'];
    const scale = internal.scale;
    if (!scale) return null;
    const zoomOption: any = this.host.norm.option.interaction && this.host.norm.option.interaction.zoom;
    const minSpan = Number(zoomOption && zoomOption.minSpan) || 0.05;
    const maxSpan = Number(zoomOption && zoomOption.maxSpan) || 1;
    const full = this.host.fullDomain(axis);
    const plot = this.host.layout.plot;
    const size = panelSize && isFinite(panelSize) && panelSize > 0 ? panelSize : axis === 'x' ? plot.width : plot.height;

    if (scale.isBand()) {
      const all = full;
      const n = all.length;
      if (n <= 2) return null;
      const current = internal.domain;
      const from = Math.max(0, all.indexOf(current[0]));
      const to = all.indexOf(current[current.length - 1]);
      const currentCount = Math.max(2, to - from + 1);
      const anchorRatio = clamp(anchorPixel / Math.max(1, size), 0, 1);
      // 缩放比例限制：一屏最多放到 minBarSpacing 那么密、最少留 maxBarSpacing 那么粗
      const nextCount = Math.min(n, clampBarCount(Math.round(currentCount / factor), size, zoomOption));
      const anchorIndex = from + anchorRatio * (currentCount - 1);
      let nextFrom = Math.round(anchorIndex - anchorRatio * (nextCount - 1));
      nextFrom = clamp(nextFrom, 0, Math.max(0, n - nextCount));
      return [all[nextFrom], all[nextFrom + nextCount - 1]];
    }

    const d0 = Number(internal.domain[0]);
    const d1 = Number(internal.domain[1]);
    const span = d1 - d0;
    const fullSpan = Number(full[1]) - Number(full[0]);
    const nextSpan = clamp(span / factor, fullSpan * minSpan, fullSpan * maxSpan);
    const anchorValue = scale.invert(anchorPixel);
    const ratio = span === 0 ? 0.5 : (anchorValue - d0) / span;
    const nextStart = anchorValue - ratio * nextSpan;
    return [nextStart, nextStart + nextSpan];
  }

  private currentRange(): { x?: [any, any]; y?: [number, number] } {
    return {
      x: [this.host.norm.xAxis.domain[0], this.host.norm.xAxis.domain[1]],
      y: [Number(this.host.norm.yAxis.domain[0]), Number(this.host.norm.yAxis.domain[1])],
    };
  }

  // ------------------------------------------------------------- 键盘

  public handleKeyDown(key: string, evt?: any): boolean {
    const interaction = this.host.norm.option.interaction;
    if (interaction && interaction.keyboard === false) return false;
    if (!key) return false;
    // 键盘只由「最后按下的那张图」响应（已销毁的图表不再持有焦点）
    if (activeController && activeController !== this && activeController.host) return false;
    if (evt && evt.target && /^(INPUT|TEXTAREA|SELECT)$/.test(evt.target.tagName || '')) return false;
    const visible = this.host.norm.series.filter((s) => !s.hidden);
    if (!visible.length) return false;
    let seriesIndex = 0;
    if (this.hover) {
      const activeId = this.hover.kind === 'item' ? this.hover.item.series.id : this.hover.column.items[0].series.id;
      const found = visible.findIndex((s) => s.id === activeId);
      if (found >= 0) seriesIndex = found;
    }
    let handled = false;
    switch (key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        const series = visible[seriesIndex];
        if (!series.pointCount) break;
        // 只在「当前可见窗口内」的数据点之间移动：缩放之后不该跳到窗外去
        const nextIndex = this.stepVisibleIndex(series, key === 'ArrowRight' ? 1 : -1);
        if (nextIndex >= 0) {
          this.keyboardIndex = nextIndex;
          const item = this.resolver.buildActiveItem(series, nextIndex);
          if (item) this.setHover({ kind: 'item', item });
        }
        handled = nextIndex >= 0;
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const nextIndex = clamp(seriesIndex + (key === 'ArrowDown' ? 1 : -1), 0, visible.length - 1);
        const series = visible[nextIndex];
        if (!series.pointCount) break;
        const index = clamp(this.keyboardIndex, 0, series.pointCount - 1);
        const item = this.resolver.buildActiveItem(series, index);
        if (item) this.setHover({ kind: 'item', item });
        handled = true;
        break;
      }
      case 'Escape':
        this.setHover(null);
        this.clearSelection();
        if (this.host.brush) this.host.brush.setRect(null);
        handled = true;
        break;
      case 'Enter':
      case ' ': {
        if (this.hover && this.hover.kind === 'item') {
          const item = this.hover.item;
          const selectOption: any = interaction && interaction.select;
          this.toggleSelection(item.series.id, item.point.index, (selectOption && selectOption.mode) || 'single', true);
          this.host.emit('item:click', this.resolver.toParams(item));
          handled = true;
        }
        break;
      }
      default:
        break;
    }
    if (handled) this.preventDefault(evt);
    return handled;
  }

  // ------------------------------------------------------------- 跨图联动

  /** 外部（联动）驱动：在指定 x 数据值上显示悬停。 */
  public showHoverAtValue(xValue: any): void {
    const item = this.resolver.nearestByXValue(xValue);
    if (item) this.setHover({ kind: 'item', item }, true);
  }

  public clearHover(): void {
    this.setHover(null);
  }

  /** 沿指定方向找到下一个「落在绘图区内」的数据下标；找不到返回 -1。 */
  private stepVisibleIndex(series: any, direction: number): number {
    const total = series.pointCount;
    if (!total) return -1;
    let index = clamp(this.keyboardIndex, 0, total - 1);
    for (let guard = 0; guard < total; guard++) {
      const candidate = index + direction;
      if (candidate < 0 || candidate >= total) return -1;
      index = candidate;
      const item = this.resolver.buildActiveItem(series, index);
      if (item && this.resolver.isInsidePlot(item.pixel[0], item.pixel[1])) return index;
    }
    return -1;
  }

  public destroy(): void {
    this.unbind();
    if (activeController === this) activeController = null;
    this.host = null as any;
  }
}

function symbolSizeOf(series: any): number {
  const size = series.option && series.option.symbolSize;
  return isFinite(size) ? Number(size) : series.type === 'bar' ? 10 : 8;
}

export { valueDistance };
