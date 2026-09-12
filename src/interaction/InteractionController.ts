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
  /** 由滑块的 0~1 比例窗口反推数据域。 */
  setDomainFromFractions(start: number, end: number, source?: string): void;
  formatAxisValue(axis: 'x' | 'y', value: any): string;
  /** 未经缩放的完整数据域（缩放约束用）。 */
  fullDomain(axis: 'x' | 'y'): any[];
}

type DragState =
  | null
  | { mode: 'brush'; startX: number; startY: number; moved: boolean }
  | { mode: 'pan'; startX: number; startY: number; domainX: [any, any] | null; domainY: [any, any] | null; moved: boolean }
  | {
      mode: 'slider';
      part: SliderPart;
      startX: number;
      startY: number;
      originStart: number;
      originEnd: number;
      anchorFraction: number;
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

  /** 指针是否落在本图 canvas 的内容盒内（CSS 像素语义）。 */
  public isOverCanvas(screenX: number, screenY: number): boolean {
    const ice: any = this.host && this.host.ice;
    if (!ice) return false;
    const dpr = ice.dpr || 1;
    const width = (ice.canvasWidth || 0) / dpr;
    const height = (ice.canvasHeight || 0) / dpr;
    if (!(width > 0) || !(height > 0)) return true;
    return screenX >= 0 && screenY >= 0 && screenX <= width && screenY <= height;
  }

  /**
   * 阻止默认行为。
   *
   * 只对**原始 DOM 事件**调用：ice-render 的 ICEEvent 只是接口模拟（它的 preventDefault
   * 会抛异常），而某些路径下事件对象上的 preventDefault 是未绑定的原生方法，
   * 直接调用会抛 "Illegal invocation"。同样要容错 —— 被动监听器里调用会被浏览器拒绝。
   */
  private preventDefault(evt: any): void {
    const raw = evt && evt.originalEvent ? evt.originalEvent : evt;
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
      const series = current.item.series;
      const index = current.item.point.index;
      const sliceHidden = series.type === 'pie' && norm.hiddenSlices[`${series.id}#${index}`];
      // 系列/扇区被隐藏，或数据被替换导致下标越界 → 直接清理，不要悄悄跳到别的系列
      if (series.hidden || sliceHidden || !series.points[index]) {
        this.setHover(null);
        return;
      }
      const item = this.resolver.buildActiveItem(series, index);
      // 数据点已经不在可见窗口内（缩放 / 平移之后）→ 清理，不要在绘图区外画准星
      if (!item || !this.resolver.isInsidePlot(item.pixel[0], item.pixel[1])) {
        this.setHover(null);
        return;
      }
      this.setHover({ kind: 'item', item });
      return;
    }
    if (norm.kind !== 'cartesian') {
      this.setHover(null);
      return;
    }
    const item = this.resolver.nearestByXValue(current.column.xValue);
    const column = item ? this.resolver.pickColumn(item.pixel[0]) : null;
    if (!column || !this.resolver.isInsidePlot(column.pixelX, column.items[0].pixel[1])) {
      this.setHover(null);
      return;
    }
    this.setHover({ kind: 'axis', column });
  }

  public resolveTarget(screenX: number, screenY: number): TargetInfo {
    return this.resolver.resolveTarget(screenX, screenY);
  }

  public handlePointerMove(screenX: number, screenY: number, evt?: any): void {
    if (this.drag) {
      this.updateDrag(screenX, screenY, evt);
      return;
    }
    // 页面上的其它图表也会收到这次移动（引擎监听在 window 上），必须忽略
    if (!this.isOverCanvas(screenX, screenY)) return;
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
    //（与 ECharts 的 axis tooltip 语义一致）。item 触发器才只认命中的那一个数据点。
    if (inside && trigger === 'axis') {
      const column = this.resolver.pickColumn(target.chart[0]);
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

  public setHover(next: { kind: 'item'; item: ActiveItem } | { kind: 'axis'; column: ActiveColumn } | null): void {
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
    const highlight = this.host.highlight;
    if (highlight) {
      highlight.setHover(
        items.map((item) => this.markFor(item))
      );
    }
    const crosshair = this.host.crosshair;
    if (crosshair) {
      if (this.host.norm.kind !== 'cartesian' || this.host.norm.orientation === 'horizontal') {
        // 极坐标没有直角准星的概念，直接收起
        // 横向柱状图的类目在 y 轴、数值在 x 轴，十字准星同样没有意义（默认 item 触发器）
        crosshair.hide();
      } else {
        const axisMode = (this.host.norm.option.crosshair && this.host.norm.option.crosshair.axis) || 'x';
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
      for (const p of series.points) {
        if (this.host.norm.hiddenSlices[`${series.id}#${p.index}`]) continue;
        total += p.y || 0;
      }
      const value = point.y || 0;
      const percent = total > 0 ? (value / total) * 100 : 0;
      return {
        title: series.name,
        rows: [
          {
            name: point.name || `切片 ${point.index + 1}`,
            value: `${percent.toFixed(1)}%`,
            color: point.color || series.color,
          },
        ],
      };
    }
    if (anchorItem && anchorItem.series.type === 'radar') {
      const series = anchorItem.series;
      return {
        title: series.name,
        rows: series.points.map((point) => ({
          name: point.name || `${point.index + 1}`,
          value: point.y === null ? '-' : String(point.y),
          color: point.index === anchorItem.point.index ? series.color : this.host.norm.theme.subTextColor,
        })),
      };
    }
    if (anchorItem && anchorItem.series.type === 'candlestick') {
      const point: any = anchorItem.point;
      const ohlc = point.ohlc || [0, 0, 0, 0];
      return {
        title: this.host.formatAxisValue('x', point.xValue),
        rows: [
          { name: '开盘', value: String(ohlc[0]), color: anchorItem.series.color },
          { name: '收盘', value: String(ohlc[1]), color: anchorItem.series.color },
          { name: '最低', value: String(ohlc[2]), color: anchorItem.series.color },
          { name: '最高', value: String(ohlc[3]), color: anchorItem.series.color },
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
    if (this.host.highlight) this.host.highlight.setHover([]);
    if (this.host.crosshair) this.host.crosshair.hide();
    if (this.host.tooltip) this.host.tooltip.hide();
  }

  /** 生成高亮标记：数据点用圆环，柱形用矩形描边。 */
  private markFor(item: ActiveItem): HighlightItem {
    const component = this.resolver.seriesComponentOf(item.series);
    const plot = this.host.layout.plot;
    if (component && item.series.type === 'bar' && typeof (component as any).barRectAt === 'function') {
      const rect = (component as any).barRectAt(item.point.index);
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

  public handlePointerDown(screenX: number, screenY: number, evt?: any): boolean {
    if (!this.isOverCanvas(screenX, screenY)) return false;
    // 有意把 this 注册到模块级「当前键盘焦点」，不是词法作用域的 this 别名：
    // 一个页面上多张图都会收到 window 上的键盘事件，必须知道该由谁响应。
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    activeController = this;
    const target = this.resolveTarget(screenX, screenY);
    if (target.kind === 'legend') return true;
    const slider = this.host.dataZoomSlider;
    if (slider && target.component === slider) {
      const part = slider.hitPart(target.local[0], target.local[1]);
      if (part) {
        this.preventDefault(evt);
        // 拖滑块时指针已经不在绘图区上，收起悬停视觉
        this.setHover(null);
        const fraction = slider.fractionAt(target.local[0]);
        this.drag = {
          mode: 'slider',
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
          this.host.setDomainFromFractions(start, start + span, 'slider');
          slider.setActive('window');
          this.drag.part = 'window';
          this.drag.originStart = start;
          this.drag.originEnd = start + span;
        }
        return true;
      }
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
      this.drag = {
        mode: 'pan',
        startX: screenX,
        startY: screenY,
        domainX: this.host.norm.xAxis.domain.length === 2 ? [this.host.norm.xAxis.domain[0], this.host.norm.xAxis.domain[1]] : null,
        domainY: [this.host.norm.yAxis.domain[0], this.host.norm.yAxis.domain[1]],
        moved: false,
      };
      return true;
    }
    return false;
  }

  public handlePointerUp(screenX: number, screenY: number, _evt?: any): void {
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
      const slider = this.host.dataZoomSlider;
      if (slider) slider.setActive(null);
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
      const x0 = clamp(startWorldX, plot.x, plot.x + plot.width);
      const y0 = clamp(startWorldY, plot.y, plot.y + plot.height);
      const x1 = clamp(worldX, plot.x, plot.x + plot.width);
      const y1 = clamp(worldY, plot.y, plot.y + plot.height);
      if (this.host.brush) {
        this.host.brush.setRect({ x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) });
      }
      const range = this.brushRange();
      if (range) this.host.emit('brush:change', range);
      return;
    }

    if (drag.mode === 'slider') {
      const slider = this.host.dataZoomSlider;
      if (!slider) return;
      drag.moved = true;
      const [worldX, worldY] = this.host.ice.screenToWorld(screenX, screenY);
      const localX = slider.globalToLocal(worldX, worldY)[0];
      const fraction = slider.fractionAt(localX);
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
      this.host.setDomainFromFractions(start, end, 'slider');
      return;
    }

    const panOption: any = this.host.norm.option.interaction && this.host.norm.option.interaction.pan;
    const axes = (panOption && panOption.axes) || 'xy';
    if ((axes === 'x' || axes === 'xy') && drag.domainX) {
      const next = this.shiftDomain('x', drag.domainX, dx);
      if (next) this.host.setDomain('x', next, 'pan');
    }
    if ((axes === 'y' || axes === 'xy') && drag.domainY) {
      const next = this.shiftDomain('y', drag.domainY, dy);
      if (next) this.host.setDomain('y', next, 'pan');
    }
  }

  private shiftDomain(axis: 'x' | 'y', domain: [any, any], deltaPixels: number): [any, any] | null {
    const internal = this.host.norm[axis === 'x' ? 'xAxis' : 'yAxis'];
    const scale = internal.scale;
    if (!scale) return null;
    const size = axis === 'x' ? this.host.layout.plot.width : this.host.layout.plot.height;
    if (scale.isBand()) {
      const all = internal.domain;
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
    const shift = (-deltaPixels / Math.max(1, size)) * span;
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
    const factor = deltaY > 0 ? zoomFactor : 1 / zoomFactor;
    if (zoomOption.mode === 'viewport') {
      this.host.ice.zoomAt(screenX, screenY, factor);
      return true;
    }
    const axes = zoomOption.axes || 'x';
    const plot = this.host.layout.plot;
    if (axes === 'x' || axes === 'xy') {
      const next = this.zoomDomain('x', target.chart[0] - plot.x, factor);
      if (next) this.host.setDomain('x', next, 'zoom');
    }
    if (axes === 'y' || axes === 'xy') {
      const next = this.zoomDomain('y', target.chart[1] - plot.y, factor);
      if (next) this.host.setDomain('y', next, 'zoom');
    }
    return true;
  }

  private zoomDomain(axis: 'x' | 'y', anchorPixel: number, factor: number): [any, any] | null {
    const internal = this.host.norm[axis === 'x' ? 'xAxis' : 'yAxis'];
    const scale = internal.scale;
    if (!scale) return null;
    const zoomOption: any = this.host.norm.option.interaction && this.host.norm.option.interaction.zoom;
    const minSpan = Number(zoomOption && zoomOption.minSpan) || 0.05;
    const maxSpan = Number(zoomOption && zoomOption.maxSpan) || 1;
    const full = this.host.fullDomain(axis);
    const size = axis === 'x' ? this.host.layout.plot.width : this.host.layout.plot.height;

    if (scale.isBand()) {
      const all = full;
      const n = all.length;
      if (n <= 2) return null;
      const current = internal.domain;
      const from = Math.max(0, all.indexOf(current[0]));
      const to = all.indexOf(current[current.length - 1]);
      const currentCount = Math.max(2, to - from + 1);
      const anchorRatio = clamp(anchorPixel / Math.max(1, size), 0, 1);
      let nextCount = Math.round(clamp(currentCount * factor, Math.max(2, Math.ceil(n * minSpan)), Math.floor(n * maxSpan)));
      nextCount = Math.min(nextCount, n);
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
        if (!series.points.length) break;
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
        if (!series.points.length) break;
        const index = clamp(this.keyboardIndex, 0, series.points.length - 1);
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
    if (item) this.setHover({ kind: 'item', item });
  }

  public clearHover(): void {
    this.setHover(null);
  }

  /** 沿指定方向找到下一个「落在绘图区内」的数据下标；找不到返回 -1。 */
  private stepVisibleIndex(series: any, direction: number): number {
    const total = series.points.length;
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
