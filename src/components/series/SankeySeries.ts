import { SeriesBase } from './SeriesBase';
import type { SeriesType } from '../../types';
import type { Rect } from '../../internal';
import { layoutSankey, sampleLinkPath, type SankeyLayoutResult } from '../../layout/sankey';
import { distanceToSegment } from './LineSeries';
import type { SankeyOption } from '../../types';

export interface SankeySeriesCoord {
  plot: Rect;
  canvas: Rect;
  /** 图表坐标系下的布局结果。 */
  layout: SankeyLayoutResult;
  options: SankeyOption;
}

/**
 * 桑基图：节点 + 连线（按流量定宽）。
 *
 * 布局由纯函数 `layoutSankey` 产出，本组件只负责绘制与命中：
 * - 命中节点 → 节点下标；
 * - 命中连线 → 节点数 + 连线下标（与 `series.points` 的排列一致）。
 */
export class SankeySeries extends SeriesBase {
  public seriesType: SeriesType = 'sankey';
  public sankey: SankeySeriesCoord | null = null;
  protected supportsSampling = false;
  private sankeyCacheKey = '';

  public setCoord(coord: any): this {
    this.sankey = (coord || null) as SankeySeriesCoord | null;
    this.sankeyCacheKey = '';
    return this.markDirty();
  }

  protected paintPad(): number {
    return 24;
  }

  /** 节点中心 / 连线中点的像素（组件本地坐标）。 */
  protected rebuildPixels(): void {
    const coord = this.sankey;
    if (!coord) {
      this.pixels = new Float64Array(0);
      return;
    }
    const { nodes, links } = coord.layout;
    const total = nodes.length + links.length;
    const [plotX, plotY] = [coord.plot.x, coord.plot.y];
    const key = this.buildSeriesKey([total, plotX, plotY, coord.plot.width, coord.plot.height, nodes.length, links.length]);
    if (key === this.sankeyCacheKey && this.pixels.length === total * 2) return;
    this.sankeyCacheKey = key;
    this.pixels = new Float64Array(total * 2);
    for (const node of nodes) {
      this.pixels[node.id * 2] = node.x - plotX + node.width / 2;
      this.pixels[node.id * 2 + 1] = node.y - plotY + node.height / 2;
    }
    for (const link of links) {
      const source = nodes[link.source];
      const target = nodes[link.target];
      if (!source || !target) continue;
      const index = nodes.length + link.id;
      this.pixels[index * 2] = (source.x + source.width + target.x) / 2 - plotX;
      this.pixels[index * 2 + 1] = (link.sy + link.ty) / 2 + link.width / 2 - plotY;
    }
    this.xMonotonic = false;
    this.renderIndices = null;
  }

  protected doRender(): void {
    const coord = this.sankey;
    if (!coord) return;
    const { nodes, links } = coord.layout;
    const ctx = this.ctx;
    const plot = coord.plot;
    const unit = this.unit();
    this.beginDraw();

    // 「流动」效果：给连线再描一层流动的虚线中心线（保持每帧重绘，靠时间算相位）
    const flow = coord.options.flow;
    if (flow) this.keepAnimating();
    else this.stopAnimating();

    // 连线
    ctx.globalAlpha = 0.42;
    for (const link of links) {
      const source = nodes[link.source];
      const target = nodes[link.target];
      if (!source || !target) continue;
      const x0 = source.x - plot.x + source.width;
      const x1 = target.x - plot.x;
      const y0 = link.sy - plot.y;
      const y1 = link.ty - plot.y;
      const c0 = x0 + (x1 - x0) * 0.5;
      const c1 = x1 - (x1 - x0) * 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(c0, y0, c1, y1, x1, y1);
      ctx.lineTo(x1, y1 + link.width);
      ctx.bezierCurveTo(c1, y1 + link.width, c0, y0 + link.width, x0, y0 + link.width);
      ctx.closePath();
      ctx.fillStyle = link.color;
      ctx.fill();

      if (flow) {
        const speed = Number(coord.options.flowSpeed) || 40;
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.moveTo(x0, (y0 + y1) / 2);
        ctx.bezierCurveTo(c0, (y0 + y1) / 2, c1, (y0 + y1) / 2, x1, (y0 + y1) / 2);
        ctx.strokeStyle = '#ffffff';
        // 上限 5 个设备像素：连线很粗时（大屏里动辄 40~60px）按比例放大会变成一串白珠子，
        // 反而盖住节点名与连线本身
        ctx.lineWidth = Math.max(unit, Math.min(5 * unit, link.width * 0.28));
        if (typeof ctx.setLineDash === 'function') {
          const dash = [6 * unit, 10 * unit];
          ctx.setLineDash(dash);
          if (typeof ctx.lineDashOffset === 'number') {
            ctx.lineDashOffset = -((Date.now() / 1000) * speed) % (dash[0] + dash[1]);
          }
        }
        ctx.stroke();
        if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;

    // 节点
    for (const node of nodes) {
      ctx.beginPath();
      const x = node.x - plot.x;
      const y = node.y - plot.y;
      const radius = Math.min(3, node.width / 2);
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + node.width - radius, y);
      ctx.arcTo(x + node.width, y, x + node.width, y + radius, radius);
      ctx.lineTo(x + node.width, y + node.height - radius);
      ctx.arcTo(x + node.width, y + node.height, x + node.width - radius, y + node.height, radius);
      ctx.lineTo(x + radius, y + node.height);
      ctx.arcTo(x, y + node.height, x, y + node.height - radius, radius);
      ctx.lineTo(x, y + radius);
      ctx.arcTo(x, y, x + radius, y, radius);
      ctx.closePath();
      ctx.fillStyle = node.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = unit;
      ctx.stroke();
    }

    // 节点名
    if (!coord.options.label || coord.options.label.show !== false) {
      const theme = this.chartTheme;
      if (theme) {
        this.setFont(theme.fontSize, theme.fontFamily);
        ctx.fillStyle = theme.textColor;
        ctx.textBaseline = 'middle';
        const maxDepth = Math.max(...nodes.map((n) => n.depth), 0);
        for (const node of nodes) {
          const x = node.x - plot.x;
          const y = node.y - plot.y + node.height / 2;
          // 节点名常常压在连线上：先描一圈底色再填字，保证可读
          if (node.depth >= maxDepth) {
            ctx.textAlign = 'right';
            this.fillLabelWithHalo(node.name, x - 6 * unit, y);
          } else {
            ctx.textAlign = 'left';
            this.fillLabelWithHalo(node.name, x + node.width + 6 * unit, y);
          }
        }
      }
    }
    this.endDraw();
  }

  /** 带白色描边的文字：保证节点名压在连线上时依然清晰。 */
  private fillLabelWithHalo(text: string, x: number, y: number): void {
    const ctx = this.ctx;
    const theme = this.chartTheme;
    ctx.lineWidth = 3 * this.unit();
    ctx.strokeStyle = (theme && theme.labelHaloColor) || 'rgba(255,255,255,0.85)';
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = (theme && theme.textColor) || '#212529';
    ctx.fillText(text, x, y);
  }

  public hitTestIndex(localX: number, localY: number): number {
    const coord = this.sankey;
    if (!coord) return -1;
    const { nodes, links } = coord.layout;
    const plot = coord.plot;
    // 节点优先
    for (const node of nodes) {
      const x = node.x - plot.x;
      const y = node.y - plot.y;
      if (localX >= x - 2 && localX <= x + node.width + 2 && localY >= y - 2 && localY <= y + node.height + 2) {
        return node.id;
      }
    }
    // 连线：按中心线采样做距离判定
    const tolerance = 6;
    for (const link of links) {
      const source = nodes[link.source];
      const target = nodes[link.target];
      if (!source || !target) continue;
      const points = sampleLinkPath(
        link,
        source.x - plot.x + source.width,
        target.x - plot.x,
        plot.y,
        12
      );
      for (let i = 1; i < points.length; i++) {
        const d = distanceToSegment(localX, localY, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
        if (d <= tolerance) return nodes.length + link.id;
      }
    }
    return -1;
  }
}

export { layoutSankey };
