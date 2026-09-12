import { SeriesBase } from './SeriesBase';
import type { GraphOption, SeriesType } from '../../types';
import type { Rect } from '../../internal';
import { forceLayout, sampleGraphLink, type ForceLayoutResult } from '../../layout/force';
import { distanceToSegment } from './LineSeries';

export interface GraphSeriesCoord {
  plot: Rect;
  canvas: Rect;
  layout: ForceLayoutResult;
  options: GraphOption;
}

/**
 * 力导向关系图：节点 + 连线。
 *
 * - 布局是纯函数（`forceLayout`），组件只负责绘制与命中；
 * - 命中返回节点下标（0..n-1）或 `节点数 + 连线下标`，与桑基图约定一致；
 * - 节点可拖拽：拖动时直接改坐标并重绘，松手后跑少量迭代让邻居跟随（`settle()`）。
 */
export class GraphSeries extends SeriesBase {
  public seriesType: SeriesType = 'graph';
  public graph: GraphSeriesCoord | null = null;
  protected clipToBox = false;
  private graphKey = '';

  public setCoord(coord: any): this {
    this.graph = (coord || null) as GraphSeriesCoord | null;
    this.graphKey = '';
    return this.markDirty();
  }

  protected paintPad(): number {
    return 28;
  }

  public get nodeCount(): number {
    return (this.graph && this.graph.layout.nodes.length) || 0;
  }

  /** 拖动节点：入参是组件本地坐标。 */
  public moveNode(index: number, localX: number, localY: number): boolean {
    const coord = this.graph;
    if (!coord) return false;
    const node = coord.layout.nodes[index];
    if (!node) return false;
    const plot = coord.plot;
    const half = node.size / 2;
    node.x = Math.max(plot.x + half, Math.min(plot.x + plot.width - half, localX + plot.x));
    node.y = Math.max(plot.y + half, Math.min(plot.y + plot.height - half, localY + plot.y));
    node.fixed = true;
    this.graphKey = '';
    this.markDirty();
    return true;
  }

  /**
   * 松手后让邻居跟随：以当前坐标为起点跑少量迭代（被拖的节点保持固定）。
   * 迭代次数刻意小（默认 40），保证松手是「即时」的。
   */
  public settle(iterations = 40): void {
    const coord = this.graph;
    if (!coord) return;
    const options = coord.options || {};
    // 用**当前坐标**作为下一次迭代的起点（连 fixed 状态一起带上），
    // 否则会从初始环形位置重来一遍，刚拖好的节点会被打回原处。
    const currentNodeInputs: any[] = coord.layout.nodes.map((node: any, i: number) => ({
      ...((options.nodes && options.nodes[i]) || { name: node.name }),
      x: node.x,
      y: node.y,
      fixed: node.fixed,
    }));
    const rebuilt = forceLayout(currentNodeInputs, options.links || [], coord.plot, {
      ...options,
      layout: 'force',
      iterations,
    }, this.chartTheme ? this.chartTheme.colorPalette : undefined);
    coord.layout = rebuilt;
    this.graphKey = '';
    this.markDirty();
  }

  /** 像素缓存：节点中心 + 连线中点（与 sankey 相同的约定）。 */
  protected rebuildPixels(): void {
    const coord = this.graph;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const { nodes, links } = coord.layout;
    const total = nodes.length + links.length;
    const key = this.buildSeriesKey([total, coord.plot.width, coord.plot.height, nodes.length, links.length]);
    if (key === this.graphKey && this.pixels.length === total * 2) return;
    this.graphKey = key;
    if (this.pixels.length !== total * 2) this.pixels = new Float64Array(total * 2);
    for (const node of nodes) {
      this.pixels[node.id * 2] = node.x - coord.plot.x;
      this.pixels[node.id * 2 + 1] = node.y - coord.plot.y;
    }
    for (const link of links) {
      const points = sampleGraphLink(link, nodes, coord.options.curve !== false, 4);
      const mid = points[Math.floor(points.length / 2)] || [0, 0];
      const index = nodes.length + link.id;
      this.pixels[index * 2] = mid[0] - coord.plot.x;
      this.pixels[index * 2 + 1] = mid[1] - coord.plot.y;
    }
    this.xMonotonic = false;
    this.renderIndices = null;
  }

  public hitTestIndex(localX: number, localY: number): number {
    const coord = this.graph;
    if (!coord) return -1;
    const { nodes, links } = coord.layout;
    const plot = coord.plot;
    // 节点优先：半径判定
    for (const node of nodes) {
      const dx = localX - (node.x - plot.x);
      const dy = localY - (node.y - plot.y);
      if (dx * dx + dy * dy <= ((node.size / 2 + 3) * (node.size / 2 + 3))) return node.id;
    }
    // 再判连线
    const tolerance = 6;
    const curve = coord.options.curve !== false;
    for (const link of links) {
      const points = sampleGraphLink(link, nodes, curve, 12);
      for (let i = 1; i < points.length; i++) {
        const d = distanceToSegment(
          localX,
          localY,
          points[i - 1][0] - plot.x,
          points[i - 1][1] - plot.y,
          points[i][0] - plot.x,
          points[i][1] - plot.y
        );
        if (d <= tolerance) return nodes.length + link.id;
      }
    }
    return -1;
  }

  protected doRender(): void {
    const coord = this.graph;
    if (!coord || !this.chartTheme) return;
    this.rebuildPixels();
    const ctx = this.ctx;
    const theme = this.chartTheme;
    const plot = coord.plot;
    const unit = this.unit();
    const { nodes, links } = coord.layout;
    const curve = coord.options.curve !== false;
    // 入场：节点从「环形铺开」的初始位置收敛到力布局结果（把迭代过程演出来）
    const entering = this.isEntering();
    const t = entering ? Math.max(0, Math.min(1, this.progress())) : 1;
    const positionOf = (node: any): [number, number] =>
      entering ? [node.initialX + (node.x - node.initialX) * t, node.initialY + (node.y - node.initialY) * t] : [node.x, node.y];
    const layoutNodes = nodes.map((node: any) => {
      const [x, y] = positionOf(node);
      return { ...node, x, y };
    });
    this.beginDraw();

    // 连线
    ctx.globalAlpha = 0.55;
    for (const link of links) {
      const points = sampleGraphLink(link, layoutNodes, curve, 16);
      if (points.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(points[0][0] - plot.x, points[0][1] - plot.y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0] - plot.x, points[i][1] - plot.y);
      ctx.strokeStyle = link.color;
      ctx.lineWidth = Math.max(unit, link.width * unit);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 节点
    for (const node of nodes) {
      const [nx, ny] = positionOf(node);
      const x = nx - plot.x;
      const y = ny - plot.y;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(2, node.size / 2), 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = unit;
      ctx.stroke();
    }

    // 标签：只画节点旁边的名字（关系图靠名字读，值得一直显示）
    this.setFont(theme.fontSize, theme.fontFamily);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.textColor;
    for (const node of nodes) {
      const [nx, ny] = positionOf(node);
      const x = nx - plot.x;
      const y = ny - plot.y + node.size / 2 + 9 * unit;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 3 * unit;
      ctx.strokeText(node.name, x, y);
      ctx.fillText(node.name, x, y);
    }
    this.endDraw();
  }

  /** 高亮节点时用圆环（基类的默认形态），这里给出节点直径。 */
  public nodeSizeAt(index: number): number {
    const coord = this.graph;
    const node = coord && coord.layout.nodes[index];
    return node ? node.size : 10;
  }
}
