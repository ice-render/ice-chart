import type { ChartLayout, InternalSeries, NormalizedOption } from './internal';
import type { SeriesType } from './types';

/** 可访问数据表：屏幕阅读器可以直接读的一张表。 */
export interface DataTable {
  caption: string;
  columns: string[];
  rows: string[][];
}

/** 虚拟数据节点：把「一个数据点」暴露成可聚焦节点所需的全部信息。 */
export interface A11yDataNode {
  id: string;
  role: 'graphic';
  label: string;
  seriesId: string;
  seriesName: string;
  dataIndex: number;
  value: number | null;
  /** 屏幕坐标盒（CSS 像素），应用层可直接做 DOM 镜像定位。 */
  box: { x: number; y: number; width: number; height: number };
  focusable: boolean;
}

/** a11y 构建只依赖图表的这几项能力（避免与 ICEChart 循环依赖）。 */
export interface A11yChartLike {
  ice: any;
  norm: NormalizedOption;
  layout: ChartLayout;
  controller: any;
  formatAxisValue(axis: 'x' | 'y', value: any): string;
}

export interface A11yTreeOptions {
  /** 每个系列最多展开多少个数据节点，默认 200（避免把几万个点塞进无障碍树）。 */
  maxDataNodesPerSeries?: number;
}

/** 图表标题（无障碍名也用它）。 */
export function chartTitle(norm: NormalizedOption): string {
  const title = norm.option.title && norm.option.title.text;
  return title ? String(title) : '图表';
}

/**
 * 生成数据表。
 *
 * - 直角坐标：每行一个 x 位置，每列一个系列；
 * - 饼图：每行一个扇区（名称 / 数值 / 占比）；
 * - 雷达图：每行一个指标，每列一个系列。
 *
 * 只统计**可见**系列与扇区，与画面严格一致 —— 图例隐藏的系列不该被读出来。
 */
export function buildDataTable(chart: A11yChartLike): DataTable {
  const norm = chart.norm;
  const caption = chartTitle(norm);
  const series = norm.series.filter((s) => !s.hidden && s.type !== 'pie');

  if (norm.kind === 'polar') {
    const pie = norm.series.find((s) => s.type === 'pie');
    if (!pie) return { caption, columns: ['扇区', '数值', '占比'], rows: [] };
    const visible = pie.points.filter((p) => !norm.hiddenSlices[`${pie.id}#${p.index}`]);
    const total = visible.reduce((sum, p) => sum + (p.y || 0), 0);
    return {
      caption,
      columns: ['扇区', '数值', '占比'],
      rows: visible.map((point) => [
        point.name || `${pie.name} ${point.index + 1}`,
        point.y === null ? '' : String(point.y),
        total > 0 ? `${(((point.y || 0) / total) * 100).toFixed(1)}%` : '0%',
      ]),
    };
  }

  if (norm.kind === 'radar') {
    const indicators = (norm.radar && norm.radar.indicators) || [];
    return {
      caption,
      columns: ['指标', ...series.map((s) => s.name)],
      rows: indicators.map((indicator, index) => [
        indicator.name,
        ...series.map((s) => {
          const point = s.points[index];
          return point && point.y !== null ? String(point.y) : '';
        }),
      ]),
    };
  }

  const xName = (norm.xAxis.option && norm.xAxis.option.name) || '类目';
  const columns = [xName, ...series.map((s) => s.name)];
  const order: string[] = [];
  const rowMap: Record<string, { x: any; cells: Record<string, string> }> = {};
  for (const s of series) {
    for (const point of s.points) {
      const key = String(point.xValue);
      if (!rowMap[key]) {
        rowMap[key] = { x: point.xValue, cells: {} };
        order.push(key);
      }
      rowMap[key].cells[s.id] = point.y === null ? '' : chart.formatAxisValue('y', point.y);
    }
  }
  const rows = order.map((key) => {
    const entry = rowMap[key];
    return [chart.formatAxisValue('x', entry.x), ...series.map((s) => entry.cells[s.id] || '')];
  });
  return { caption, columns, rows };
}

/**
 * 生成虚拟数据节点：让应用层可以做「逐数据点」的 DOM 镜像与焦点环。
 *
 * 默认每个系列最多 200 个节点（整体数据表已经能表达全部数据，逐点节点是为了
 * 键盘在数据点之间移动），可用 maxDataNodesPerSeries 调整。
 */
export function buildDataNodes(chart: A11yChartLike, options: A11yTreeOptions = {}): A11yDataNode[] {
  const maxPerSeries = Math.max(0, options.maxDataNodesPerSeries === undefined ? 200 : options.maxDataNodesPerSeries);
  const out: A11yDataNode[] = [];
  for (const series of chart.norm.series) {
    if (series.hidden) continue;
    const component = chart.controller && chart.controller.resolver ? chart.controller.resolver.seriesComponentOf(series) : null;
    if (!component) continue;
    const count = Math.min(series.points.length, maxPerSeries);
    for (let i = 0; i < count; i++) {
      const point = series.points[i];
      const pixel = component.pixelAt(i);
      if (!pixel) continue;
      const world = [chart.layout.plot.x + pixel[0], chart.layout.plot.y + pixel[1]];
      const screen = chart.ice && typeof chart.ice.worldToScreen === 'function' ? chart.ice.worldToScreen(world[0], world[1]) : world;
      const size = seriesSymbolSize(series);
      out.push({
        id: `${series.id}#${i}`,
        role: 'graphic',
        label: `${series.name}，${chart.formatAxisValue('x', point.xValue)}，${point.y === null ? '无数据' : chart.formatAxisValue('y', point.y)}`,
        seriesId: series.id,
        seriesName: series.name,
        dataIndex: i,
        value: point.y,
        box: { x: screen[0] - size / 2, y: screen[1] - size / 2, width: size, height: size },
        focusable: true,
      });
    }
  }
  return out;
}

function seriesSymbolSize(series: InternalSeries): number {
  const option = series.option;
  const size = option.symbolSize;
  if (typeof size === 'number' && isFinite(size)) return Math.max(8, size);
  return series.type === 'bar' ? 12 : 10;
}

/** 视觉隐藏但可被屏幕阅读器读取的样式。 */
export const VISUALLY_HIDDEN_STYLE = [
  'position:absolute',
  'width:1px',
  'height:1px',
  'margin:-1px',
  'padding:0',
  'overflow:hidden',
  'clip:rect(0 0 0 0)',
  'clip-path:inset(50%)',
  'white-space:nowrap',
  'border:0',
].join(';');

/**
 * 无障碍镜像：在 canvas 旁挂一张视觉隐藏的数据表 + 一个 aria-live 播报区。
 *
 * 为什么必须做：canvas 内容对屏幕阅读器完全不可见（引擎的 a11y 原语也只产出快照，
 * 由应用层决定 DOM 结构）。ice-chart 选择把「数据表 + 当前悬停点播报」这一层直接做掉，
 * 因为它对图表是通用语义；更细的交互镜像仍可由应用层基于 getA11yTree() 自行构建。
 */
export class A11yMirror {
  private chart: any;
  private wrapper: any = null;
  private live: any = null;
  private tableEl: any = null;
  private hoverHandler: any = null;
  private static seq = 0;

  constructor(chart: any) {
    this.chart = chart;
  }

  public get attached(): boolean {
    return !!this.wrapper;
  }

  public get element(): any {
    return this.wrapper;
  }

  public attach(): boolean {
    const ice = this.chart.ice;
    const canvas = this.chart.canvasElement;
    const doc = ice && ice.root && ice.root.document;
    if (!doc || !canvas || typeof doc.createElement !== 'function' || !canvas.parentNode) return false;
    this.detach();

    const wrapper = doc.createElement('div');
    wrapper.id = `ice-chart-a11y-mirror-${++A11yMirror.seq}`;
    wrapper.setAttribute('style', VISUALLY_HIDDEN_STYLE);
    wrapper.setAttribute('data-ice-chart-a11y', 'mirror');

    this.tableEl = doc.createElement('table');
    const live = doc.createElement('div');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    wrapper.appendChild(this.tableEl);
    wrapper.appendChild(live);
    canvas.parentNode.appendChild(wrapper);

    canvas.setAttribute('aria-describedby', wrapper.id);
    if (!canvas.getAttribute('aria-label')) {
      canvas.setAttribute('aria-label', chartTitle(this.chart.norm));
    }

    this.wrapper = wrapper;
    this.live = live;
    this.refresh();

    this.hoverHandler = (params: any) => {
      if (!params) return;
      this.announce(
        `${params.seriesName}，${this.chart.formatAxisValue('x', params.xValue)}，${
          params.value === null ? '无数据' : this.chart.formatAxisValue('y', params.value)
        }`
      );
    };
    this.chart.on('item:hover', this.hoverHandler);
    return true;
  }

  public detach(): void {
    if (this.hoverHandler) {
      this.chart.off('item:hover', this.hoverHandler);
      this.hoverHandler = null;
    }
    const canvas = this.chart.canvasElement;
    if (this.wrapper && this.wrapper.parentNode) {
      this.wrapper.parentNode.removeChild(this.wrapper);
    }
    if (canvas && typeof canvas.removeAttribute === 'function') {
      canvas.removeAttribute('aria-describedby');
    }
    this.wrapper = null;
    this.live = null;
    this.tableEl = null;
  }

  /** 用当前数据重建表格（数据或图例变化后调用）。 */
  public refresh(): void {
    const doc = this.chart.ice && this.chart.ice.root && this.chart.ice.root.document;
    if (!this.wrapper || !this.tableEl || !doc) return;
    const table = buildDataTable(this.chart);
    while (this.tableEl.firstChild) this.tableEl.removeChild(this.tableEl.firstChild);

    const caption = doc.createElement('caption');
    caption.textContent = table.caption;
    this.tableEl.appendChild(caption);
    const thead = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    for (const column of table.columns) {
      const th = doc.createElement('th');
      th.setAttribute('scope', 'col');
      th.textContent = column;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    this.tableEl.appendChild(thead);
    const tbody = doc.createElement('tbody');
    for (const row of table.rows) {
      const tr = doc.createElement('tr');
      for (let i = 0; i < row.length; i++) {
        const cell = doc.createElement(i === 0 ? 'th' : 'td');
        if (i === 0) cell.setAttribute('scope', 'row');
        cell.textContent = row[i];
        tr.appendChild(cell);
      }
      tbody.appendChild(tr);
    }
    this.tableEl.appendChild(tbody);
  }

  /** 播报一段文本（悬停 / 键盘导航时用）。 */
  public announce(text: string): void {
    if (this.live) this.live.textContent = text;
  }
}

/** 系列类型 → 无障碍角色建议（供应用层构建镜像时参考）。 */
export const SERIES_ROLE_HINT: Record<SeriesType, string> = {
  line: '趋势线',
  area: '面积趋势',
  bar: '柱形',
  scatter: '散点',
  pie: '扇形',
  radar: '雷达多边形',
};
