import { SeriesBase } from './SeriesBase';
import type { SeriesType, TreemapOption } from '../../types';
import type { Rect } from '../../internal';
import type { TreemapNodeLayout } from '../../layout/treemap';

export interface TreemapSeriesCoord {
  plot: Rect;
  canvas: Rect;
  /** 布局结果（图表坐标系）。 */
  layout: TreemapNodeLayout[];
  options: TreemapOption;
}

/**
 * 矩形树图：用嵌套矩形表达层级数据的构成。
 *
 * 布局是纯函数（`layoutTreemap`），这里只负责绘制与命中。
 * 命中返回**最深的那个节点**（点在大类目里的小类目上，命中的是小类目）。
 */
export class TreemapSeries extends SeriesBase {
  public seriesType: SeriesType = 'treemap';
  public treemap: TreemapSeriesCoord | null = null;
  protected clipToBox = true;
  private treemapKey = '';

  public setCoord(coord: any): this {
    this.treemap = (coord || null) as TreemapSeriesCoord | null;
    this.treemapKey = '';
    return this.markDirty();
  }

  protected paintPad(): number {
    return 6;
  }

  public highlightRectAt(index: number): Rect | null {
    const coord = this.treemap;
    if (!coord) return null;
    const node = coord.layout[index];
    if (!node) return null;
    return {
      x: node.rect.x - coord.plot.x,
      y: node.rect.y - coord.plot.y,
      width: node.rect.width,
      height: node.rect.height,
    };
  }

  /** 像素缓存 = 每个节点的矩形中心。 */
  protected rebuildPixels(): void {
    const coord = this.treemap;
    const nodes = (coord && coord.layout) || [];
    if (!coord || !nodes.length) {
      this.pixels = new Float64Array(0);
      return;
    }
    const key = [nodes.length, coord.plot.width, coord.plot.height].join('|');
    if (key === this.treemapKey && this.pixels.length === nodes.length * 2) return;
    this.treemapKey = key;
    this.pixels = new Float64Array(nodes.length * 2);
    for (const node of nodes) {
      this.pixels[node.id * 2] = node.rect.x - coord.plot.x + node.rect.width / 2;
      this.pixels[node.id * 2 + 1] = node.rect.y - coord.plot.y + node.rect.height / 2;
    }
    // 命中走自己的矩形判定，这里只是给高亮/提示框提供锚点
    this.xMonotonic = false;
    this.renderIndices = null;
  }

  public hitTestIndex(localX: number, localY: number): number {
    const coord = this.treemap;
    if (!coord) return -1;
    let best = -1;
    let bestDepth = -1;
    for (const node of coord.layout) {
      const x = node.rect.x - coord.plot.x;
      const y = node.rect.y - coord.plot.y;
      if (localX < x || localX > x + node.rect.width || localY < y || localY > y + node.rect.height) continue;
      // 取最深的节点：小类目优先于它所在的大类目
      if (node.depth > bestDepth) {
        bestDepth = node.depth;
        best = node.id;
      }
    }
    return best;
  }

  protected doRender(): void {
    const coord = this.treemap;
    if (!coord || !this.chartTheme) return;
    this.rebuildPixels();
    const ctx = this.ctx;
    const theme = this.chartTheme;
    const unit = this.unit();
    const plot = coord.plot;
    const options = coord.options || {};
    const minLabelRatio = options.minLabelRatio === undefined ? 0.02 : Number(options.minLabelRatio);
    this.beginDraw();

    for (const node of coord.layout) {
      const x = node.rect.x - plot.x;
      const y = node.rect.y - plot.y;
      ctx.beginPath();
      ctx.rect(x, y, node.rect.width, node.rect.height);
      ctx.fillStyle = node.color;
      ctx.fill();
      if (node.depth === 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5 * unit;
        ctx.stroke();
      }
    }

    // 标签：只画放得下的（含数值占比）
    this.setFont(theme.fontSize, theme.fontFamily);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const node of coord.layout) {
      if (node.ratio < minLabelRatio) continue;
      const x = node.rect.x - plot.x;
      const y = node.rect.y - plot.y;
      const ratioText = `${(node.ratio * 100).toFixed(1)}%`;
      // 父节点：标签画在标题带里（左上角），不压住子矩形
      if (node.hasChildren && node.header > 0) {
        ctx.textAlign = 'left';
        ctx.fillStyle = node.depth === 0 ? '#ffffff' : theme.textColor;
        this.setFont(theme.fontSize, theme.fontFamily, 'bold');
        ctx.fillText(`${node.name} ${ratioText}`, x + 8 * unit, y + node.header / 2);
        continue;
      }
      if (node.rect.width < 44 || node.rect.height < 26) continue;
      this.setFont(theme.fontSize, theme.fontFamily);
      const text = node.rect.height >= 40 ? `${node.name}\n${ratioText}` : `${node.name} ${ratioText}`;
      const lines = text.split('\n');
      const color = node.depth === 0 ? '#ffffff' : theme.textColor;
      ctx.fillStyle = color;
      const lineHeight = theme.fontSize * 1.35;
      const startY = y + node.rect.height / 2 - ((lines.length - 1) * lineHeight) / 2;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], x + node.rect.width / 2, startY + i * lineHeight);
      }
    }
    this.endDraw();
  }
}
