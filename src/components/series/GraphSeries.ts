import { SeriesBase } from './SeriesBase';
import type { GraphOption, SeriesType } from '../../types';
import type { Rect } from '../../internal';
import {
  forceLayout,
  placeGraphLabels,
  sampleGraphLink,
  shouldLabelGraphNode,
  type ForceLayoutResult,
} from '../../layout/force';
import { measureTextWidth } from '../../util/text';
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
  /**
   * 最近一帧画出去的标签盒（本地坐标）。给审计与调试用 —— 「画了哪些标签、摆在哪」是渲染态的事实，
   * 画布桩是空实现、单测里断不了文字，只能读这个（与 `Axis.lastTicks` 同一个用途）。
   */
  public lastLabelBoxes: Array<{ name: string; x0: number; x1: number; y0: number; y1: number }> = [];

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
      // 命中半径跟着悬停放大 —— 否则指针停在放大后的边缘上会判定为「离开」，
      // 节点一缩一涨就会闪。放大后的节点只会更容易命中，不会丢悬停。
      const radius = (node.size / 2) * this.hoverBoost(node.id, 0.28) + 3;
      if (dx * dx + dy * dy <= radius * radius) return node.id;
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
      // 悬停：节点鼓起来一点（命中半径同样放大，边缘不会抖）
      const radius = Math.max(2, (node.size / 2) * this.hoverBoost(node.id, 0.28));
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.fill();
      // 节点描边保持白色：它是图形的一部分，不是文字底衬（大屏深色主题下也要留白边）
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = unit * (this.hoverBoost(node.id, 0.28) > 1 ? 2 : 1);
      ctx.stroke();
    }

    /**
     * 标签：默认画在节点下方（关系图靠名字读），**撞了就换边**（见 `placeGraphLabels`）。
     *
     * 两条纪律都写在这里，别回退：
     * 1. **落点要算**（`placeGraphLabels`）：先试下方、贴底翻上方，都与已放置的标签相撞时改放
     *    左右，最后才选撞得最少的 —— 直接按固定偏移画，节点靠近下沿会把文字画到画布外（被裁），
     *    而密集图（一百多号人全标名字）会把标签糊成一片；
     * 2. 密集图（几十上百个节点）全标会糊成一片，用 `graph.label.minSize` 只标主要节点。
     */
    this.setFont(theme.fontSize, theme.fontFamily);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.textColor;
    const labelled = nodes.filter((node) => shouldLabelGraphNode(node.size, coord.options.label));
    if (labelled.length) {
      const placements = placeGraphLabels(
        labelled.map((node) => {
          const [nx, ny] = positionOf(node);
          return { name: node.name, x: nx - plot.x, y: ny - plot.y, size: node.size };
        }),
        {
          box: { width: this.state.width || 0, height: this.state.height || 0 },
          // 用真实文字宽度量（CJK 与拉丁字母差很多，按字数估会误判）
          measure: (text) => measureTextWidth(ctx, text, theme.fontSize, theme.fontFamily),
          lineHeight: theme.fontSize * 1.4,
          gap: 9 * unit,
        }
      );
      ctx.strokeStyle = theme.labelHaloColor;
      ctx.lineWidth = 3 * unit;
      this.lastLabelBoxes = [];
      for (let i = 0; i < labelled.length; i++) {
        const name = labelled[i].name;
        const { x, y } = placements[i];
        ctx.strokeText(name, x, y);
        ctx.fillText(name, x, y);
        const w = measureTextWidth(ctx, name, theme.fontSize, theme.fontFamily);
        const h = theme.fontSize * 1.4;
        this.lastLabelBoxes.push({ name, x0: x - w / 2, x1: x + w / 2, y0: y - h / 2, y1: y + h / 2 });
      }
    } else {
      this.lastLabelBoxes = [];
    }
    this.endDraw();
  }

  /** 高亮节点时用圆环（基类的默认形态），这里给出节点直径。 */
  public nodeSizeAt(index: number): number {
    const coord = this.graph;
    const node = coord && coord.layout.nodes[index];
    // 高亮环跟着悬停放大一起长，否则环会「陷」在放大的节点里
    return node ? node.size * this.hoverBoost(index, 0.28) : 10;
  }
}
