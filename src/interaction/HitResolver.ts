import type { ActiveColumn, ActiveItem, ChartLayout, InternalSeries, NormalizedOption, Rect } from '../internal';
import type { DataPointParams } from '../types';
import type { SeriesBase } from '../components/series/SeriesBase';
import { panelIndexAt } from '../layout/panels';

export interface HitHost {
  ice: any;
  norm: NormalizedOption;
  layout: ChartLayout;
  plotArea: any;
  legend: any;
  seriesComponents: SeriesBase[];
}

export interface TargetInfo {
  kind: 'none' | 'plot' | 'series' | 'legend' | 'other';
  component: any;
  index: number;
  /** 组件本地坐标。 */
  local: [number, number];
  /** 图表坐标系（画布左上角为原点）坐标。 */
  chart: [number, number];
}

/**
 * 命中解析：把「屏幕像素」翻译成「哪个组件的哪个数据项」。
 *
 * 关键点是**复用引擎的命中测试**（`ice.hitTest`）而不是自己遍历数据：
 * 遮挡关系、zIndex、display:false、interactive:false 等语义全部由引擎统一保证，
 * ice-chart 只负责把组件本地坐标进一步翻译成数据下标。
 */
export class HitResolver {
  private host: HitHost;

  constructor(host: HitHost) {
    this.host = host;
  }

  public resolveTarget(screenX: number, screenY: number): TargetInfo {
    const ice = this.host.ice;
    const empty: TargetInfo = { kind: 'none', component: null, index: -1, local: [0, 0], chart: [0, 0] };
    if (!ice || typeof ice.hitTest !== 'function') return empty;
    const [worldX, worldY] = ice.screenToWorld(screenX, screenY);
    const chart: [number, number] = [worldX, worldY];
    const component: any = ice.hitTest(screenX, screenY);
    if (!component) return { ...empty, chart };
    const local: [number, number] = component.globalToLocal ? component.globalToLocal(worldX, worldY) : [0, 0];
    if (component === this.host.plotArea) {
      return { kind: 'plot', component, index: -1, local, chart };
    }
    if (component === this.host.legend) {
      const index = this.host.legend && typeof this.host.legend.hitItem === 'function' ? this.host.legend.hitItem(local[0], local[1]) : -1;
      return { kind: 'legend', component, index, local, chart };
    }
    if (typeof component.hitTestIndex === 'function') {
      const index = component.hitTestIndex(local[0], local[1]);
      return { kind: index >= 0 ? 'series' : 'other', component, index, local, chart };
    }
    return { kind: 'other', component, index: -1, local, chart };
  }

  public isInsidePlot(chartX: number, chartY: number): boolean {
    return this.panelAt(chartX, chartY) >= 0;
  }

  /**
   * 指针落在第几个面板里（-1 = 不在任何面板内）。
   *
   * 面板矩阵下这是交互的总入口：悬停、框选、缩放、键盘都要先问「在哪块面板」。
   * 没有 `matrix` 时 `layout.panels` 只有一个矩形，等价于从前的 `isInsidePlot`。
   */
  public panelAt(chartX: number, chartY: number): number {
    return panelIndexAt(this.host.layout.panels, chartX, chartY);
  }

  /** 第几个面板的矩形（越界退回绘图区）。 */
  public panelRect(index: number): Rect {
    return this.host.layout.panels[index] || this.host.layout.plot;
  }

  public seriesComponentOf(series: InternalSeries): SeriesBase | null {
    if (!series) return null;
    for (const component of this.host.seriesComponents) {
      if (component.series === series) return component;
    }
    // 数据 / 配置更新会重建 norm（系列对象是新的），而悬停状态里还留着上一轮的系列对象。
    // 按 id 兜底匹配，否则「更新数据时悬停被清掉」——实时刷新（仪表盘、监控）最明显。
    const id = (series as any).id;
    if (id !== undefined && id !== null) {
      for (const component of this.host.seriesComponents) {
        if (component.series && (component.series as any).id === id) return component;
      }
    }
    return null;
  }

  public seriesOfComponent(component: any): InternalSeries | null {
    for (const series of this.host.norm.series) {
      if (this.seriesComponentOf(series) === component) return series;
    }
    return null;
  }

  public buildActiveItem(series: InternalSeries, dataIndex: number): ActiveItem | null {
    const component = this.seriesComponentOf(series);
    if (!component) return null;
    const pixel = component.pixelAt(dataIndex);
    const point = series.pointAt(dataIndex);
    if (!pixel || !point) return null;
    // 组件的像素是**面板本地坐标**，换算到图表坐标要加它所在那块面板的左上角
    const rect = this.panelRect(this.seriesPanelOf(series));
    return { series, point, pixel: [rect.x + pixel[0], rect.y + pixel[1]], screen: [0, 0] };
  }

  public toParams(item: ActiveItem): DataPointParams {
    const ice = this.host.ice;
    const screen = ice && typeof ice.worldToScreen === 'function' ? ice.worldToScreen(item.pixel[0], item.pixel[1]) : item.pixel;
    return {
      seriesId: item.series.id,
      seriesName: item.series.name,
      seriesIndex: item.series.index,
      seriesType: item.series.type,
      color: item.series.color,
      dataIndex: item.point.index,
      data: item.point.raw,
      xValue: item.point.xValue,
      value: item.point.y,
      screen: [screen[0], screen[1]],
    };
  }

  /** 图表坐标系 x 像素 → 数据列（每个系列各取 x 最近的点）。 */
  /**
   * 「同一列」的活动项：轴触发提示框 / 十字准星都按它取数。
   *
   * 面板矩阵下**只收指针所在面板的系列**：否则在第 6 块面板上悬停，提示框会把另外五块的
   * 数据一起列出来（它们 x 值相同但根本不是同一张图）。
   */
  public pickColumn(chartX: number, chartY: number): ActiveColumn | null {
    const panel = this.panelAt(chartX, chartY);
    const rect = this.panelRect(panel);
    const localX = chartX - rect.x;
    const matrix = this.host.norm.matrix;
    const visible = this.host.norm.series.filter(
      (s) => !s.hidden && (!matrix || this.seriesPanelOf(s) === panel)
    );
    if (!visible.length) return null;
    const items: ActiveItem[] = [];
    let anchorX: any = null;
    for (const series of visible) {
      const component = this.seriesComponentOf(series);
      if (!component) continue;
      const index = this.nearestIndexByX(component, localX);
      if (index < 0) continue;
      const item = this.buildActiveItem(series, index);
      if (!item) continue;
      items.push(item);
      if (anchorX === null) anchorX = series.pointAt(index).xValue;
    }
    if (!items.length) return null;
    return { dataIndex: items[0].point.index, xValue: anchorX, pixelX: items[0].pixel[0], panel, items };
  }

  /** 系列所属面板（越界退回 0）。 */
  public seriesPanelOf(series: InternalSeries): number {
    if (!this.host.norm.matrix) return 0;
    const raw = Math.floor(Number(series.panel));
    const max = this.host.layout.panels.length - 1;
    return isFinite(raw) ? Math.max(0, Math.min(max, raw)) : 0;
  }

  public nearestIndexByX(component: SeriesBase, localX: number): number {
    // 系列内部会按 x 单调性选择二分或线性扫描（大点数下每次 mousemove 都是 O(n) 会掉帧）
    return component.nearestIndexAtX(localX);
  }

  /** 按数据值找最近的点（跨图联动用）。 */
  public nearestByXValue(xValue: any): ActiveItem | null {
    const visible = this.host.norm.series.filter((s) => !s.hidden);
    const hiddenSlices = this.host.norm.hiddenSlices || {};
    let best: { series: InternalSeries; index: number; dist: number } | null = null;
    for (const series of visible) {
      for (let i = 0; i < series.pointCount; i++) {
        if ((series.type === 'pie' || series.type === 'funnel') && hiddenSlices[`${series.id}#${i}`]) continue;
        const dist = valueDistance(xValue, series.pointAt(i).xValue);
        if (dist === null) continue;
        if (!best || dist < best.dist) best = { series, index: i, dist };
      }
    }
    return best ? this.buildActiveItem(best.series, best.index) : null;
  }
}

/** 两个 x 数据值的距离；不可比时返回 null。 */
export function valueDistance(a: any, b: any): number | null {
  const na = a instanceof Date ? a.getTime() : Number(a);
  const nb = b instanceof Date ? b.getTime() : Number(b);
  if (isFinite(na) && isFinite(nb)) return Math.abs(na - nb);
  if (String(a) === String(b)) return 0;
  return null;
}
