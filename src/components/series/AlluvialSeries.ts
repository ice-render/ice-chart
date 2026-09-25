import { SeriesBase } from './SeriesBase';
import { withAlpha } from '../../util/color';
import type { SeriesType } from '../../types';
import { alluvialTargetAt, layoutAlluvial, type AlluvialLayout } from '../../layout/alluvial';

/**
 * 多轴分类流：N 个类目轴 + 相邻轴之间的流量带。
 *
 * 几何全在纯函数 `layout/alluvial.ts` 里（堆叠 / 聚合 / 排序），组件只负责：
 * 1. 把布局结果映射成像素锚点（节点中心、带子中点）——`pixels` 是绘制与命中共用的那一份；
 * 2. 画节点条与贝塞尔带子；
 * 3. 命中：节点优先，其次带子（`alluvialTargetAt`）。
 */
export class AlluvialSeries extends SeriesBase {
  public seriesType: SeriesType = 'alluvial';
  protected supportsSampling = false;
  private layoutCache: AlluvialLayout | null = null;
  private layoutKey = '';
  private nodeCount = 0;

  private config(): { axes: string[]; rows: Array<Record<string, any>>; valueField: string } | null {
    const option: any = this.series.alluvialOption || this.series.option.alluvial;
    if (!option || !Array.isArray(option.axes) || !Array.isArray(option.rows)) return null;
    return { axes: option.axes, rows: option.rows, valueField: option.valueField || 'value' };
  }

  /** 节点 + 带的坐标（本地像素）。`pixels` 与它同源，命中不再另算一套。 */
  protected rebuildPixels(): void {
    const config = this.config();
    const coord = this.coord;
    if (!config || !coord) {
      this.layoutCache = null;
      this.pixels = new Float64Array(0);
      return;
    }
    const width = this.state.width || 0;
    const height = this.state.height || 0;
    const option: any = this.series.option.alluvial || {};
    const key = this.buildSeriesKey([config.axes.join('|'), config.rows.length, width, height, option.nodeWidth, option.gap, option.spread]);
    if (key === this.layoutKey && this.layoutCache) return;
    this.layoutKey = key;

    const layout = layoutAlluvial(
      config.rows,
      { axes: config.axes, valueField: config.valueField },
      { x: 0, y: 0, width, height },
      { nodeWidth: option.nodeWidth, gap: option.gap, spread: option.spread, sort: option.sort }
    );
    this.layoutCache = layout;
    const nodes = layout.axes.reduce((sum, axis) => sum + axis.categories.length, 0);
    this.nodeCount = nodes;
    const total = nodes + layout.flows.length;
    if (this.pixels.length !== total * 2) this.pixels = new Float64Array(total * 2);
    let index = 0;
    for (const axis of layout.axes) {
      for (const category of axis.categories) {
        this.pixels[index * 2] = axis.x + axis.width / 2;
        this.pixels[index * 2 + 1] = category.y + category.height / 2;
        index += 1;
      }
    }
    for (const flow of layout.flows) {
      const from = layout.axes[flow.axis];
      const to = layout.axes[flow.axis + 1];
      this.pixels[index * 2] = (from.x + from.width + to.x) / 2;
      this.pixels[index * 2 + 1] = (flow.source[0] + flow.source[1] + flow.target[0] + flow.target[1]) / 4;
      index += 1;
    }
    this.xMonotonic = false;
    this.renderIndices = null;
  }

  /** 第几个点是节点（而不是带子）。 */
  public isNodeIndex(index: number): boolean {
    this.rebuildPixels();
    return index >= 0 && index < this.nodeCount;
  }

  public hitTestIndex(localX: number, localY: number): number {
    this.rebuildPixels();
    const layout = this.layoutCache;
    if (!layout) return -1;
    const hit = alluvialTargetAt(localX, localY, layout);
    if (!hit) return -1;
    if (hit.kind === 'node') {
      // 节点在 points 里的顺序 = 各轴依次拉平的顺序，与布局一致
      let index = 0;
      for (let a = 0; a < hit.axis; a++) index += layout.axes[a].categories.length;
      return index + hit.index;
    }
    return this.nodeCount + hit.index;
  }

  protected doRender(): void {
    this.rebuildPixels();
    const layout = this.layoutCache;
    if (!layout || !this.chartTheme) return;
    const ctx = this.ctx;
    const unit = this.unit();
    const theme = this.chartTheme;
    const option: any = this.series.option.alluvial || {};
    const opacity = isFinite(Number(option.ribbonOpacity)) ? Number(option.ribbonOpacity) : 0.35;
    const palette = theme.colorPalette.length ? theme.colorPalette : [this.series.color];
    const entering = this.isEntering();
    const progress = entering ? this.progress() : 1;
    this.beginDraw();

    // 带子：颜色跟随源节点（同一条来路的流量一眼分得清）
    const colorOfNode = new Map<string, string>();
    for (let a = 0; a < layout.axes.length; a++) {
      for (const category of layout.axes[a].categories) {
        colorOfNode.set(`${a}\u0000${category.name}`, palette[category.index % palette.length]);
      }
    }
    for (const flow of layout.flows) {
      const from = layout.axes[flow.axis];
      const to = layout.axes[flow.axis + 1];
      if (!from || !to) continue;
      const color = colorOfNode.get(`${flow.axis}\u0000${flow.fromName}`) || this.series.color;
      const leftEdge = from.x + from.width;
      const rightEdge = to.x;
      const bend = (rightEdge - leftEdge) * 0.4;
      const y0 = flow.source[0] + (flow.target[0] - flow.source[0]) * (1 - progress);
      const y1 = flow.source[1] + (flow.target[1] - flow.source[1]) * (1 - progress);
      ctx.beginPath();
      ctx.moveTo(leftEdge, y0);
      ctx.bezierCurveTo(leftEdge + bend, y0, rightEdge - bend, flow.target[0], rightEdge, flow.target[0]);
      ctx.lineTo(rightEdge, flow.target[1]);
      ctx.bezierCurveTo(rightEdge - bend, flow.target[1], leftEdge + bend, y1, leftEdge, y1);
      ctx.closePath();
      ctx.fillStyle = withAlpha(color, opacity);
      ctx.fill();
    }

    // 节点条
    const nodeIndexById = new Map<string, number>();
    let nodeIndex = 0;
    for (const axis of layout.axes) {
      for (const category of axis.categories) {
        nodeIndexById.set(`${axis.name}\u0000${category.name}`, nodeIndex);
        const color = colorOfNode.get(`${layout.axes.indexOf(axis)}\u0000${category.name}`) || this.series.color;
        ctx.beginPath();
        ctx.rect(axis.x, category.y, axis.width, Math.max(1, category.height));
        ctx.fillStyle = color;
        ctx.fill();
        // 悬停：同一份几何叠一层描边
        if (nodeIndex === this.hoverIndex && this.hoverAlpha(nodeIndex) > 0.01) {
          ctx.save();
          ctx.globalAlpha = this.hoverAlpha(nodeIndex);
          ctx.strokeStyle = 'rgba(255,255,255,0.95)';
          ctx.lineWidth = Math.max(unit, 2 * unit);
          ctx.stroke();
          ctx.restore();
        }
        nodeIndex += 1;
      }
      // 轴名放在顶端
      ctx.fillStyle = theme.subTextColor;
      this.setFont(theme.fontSize - 2, theme.fontFamily);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(axis.name, axis.x + axis.width / 2, Math.max(theme.fontSize, 12));
    }
    this.endDraw();
  }
}
