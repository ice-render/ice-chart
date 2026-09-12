import { SeriesBase } from './SeriesBase';
import type { SeriesType, TreemapOption } from '../../types';
import type { Rect } from '../../internal';
import type { TreemapNodeLayout } from '../../layout/treemap';
import { measureTextWidth } from '../../util/text';

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
  /** 更新动画的起点布局（按「层级:名称」索引，跨数据更新仍能对上同一个节点）。 */
  private morphFrom: Record<string, Rect> = {};
  private morphing = false;

  /**
   * 数据更新时记下当前布局，下一次渲染按进度在「旧矩形 → 新矩形」之间插值。
   * 这是 treemap 最值钱的动画：布局一变，矩形是「长大/挪过去」而不是瞬间跳。
   */
  public updateSeries(series: any, animate: boolean, preserveAnimation = false): this {
    if (animate && this.treemap) {
      const from: Record<string, Rect> = {};
      for (const node of this.treemap.layout) from[`${node.depth}:${node.name}`] = { ...node.rect };
      this.morphFrom = from;
      this.morphing = true;
    }
    return super.updateSeries(series, animate, preserveAnimation);
  }

  /** 节点的当前矩形：更新动画期间在旧布局与新布局之间插值。 */
  private rectCache: Map<number, Rect> = new Map();

  /**
   * 节点当前矩形。
   *
   * 关键点：**子节点在父节点的插值结果内部按相对位置缩放**，而不是各自独立插值。
   * 独立插值会让兄弟矩形在中途拼不满父矩形（露出父色形成缺口/错位），
   * 这是树图布局过渡最容易被忽略的视觉缺陷。
   */
  private rectOf(node: TreemapNodeLayout, cache: Map<number, Rect> = this.rectCache): Rect {
    const t = this.progress();
    if (!this.morphing) return node.rect;
    if (t >= 1) {
      this.morphing = false;
      return node.rect;
    }
    const cached = cache.get(node.id);
    if (cached) return cached;
    const layout = this.treemap ? this.treemap.layout : [];
    const from = this.morphFrom[`${node.depth}:${node.name}`];
    let result: Rect;
    const parent = node.parent >= 0 ? layout[node.parent] : null;
    const fromParent = parent ? this.morphFrom[`${parent.depth}:${parent.name}`] : null;
    if (parent && from && fromParent && fromParent.width > 1 && fromParent.height > 1) {
      // 相对父矩形的比例（旧布局）→ 套到父矩形的新（插值后）位置上
      const parentRect = this.rectOf(parent, cache);
      const u = (from.x - fromParent.x) / fromParent.width;
      const v = (from.y - fromParent.y) / fromParent.height;
      const w = from.width / fromParent.width;
      const h = from.height / fromParent.height;
      result = {
        x: parentRect.x + u * parentRect.width,
        y: parentRect.y + v * parentRect.height,
        width: w * parentRect.width,
        height: h * parentRect.height,
      };
    } else if (from) {
      result = {
        x: from.x + (node.rect.x - from.x) * t,
        y: from.y + (node.rect.y - from.y) * t,
        width: from.width + (node.rect.width - from.width) * t,
        height: from.height + (node.rect.height - from.height) * t,
      };
    } else {
      result = node.rect;
    }
    cache.set(node.id, result);
    return result;
  }

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
    const rect = this.rectOf(node);
    return {
      x: rect.x - coord.plot.x,
      y: rect.y - coord.plot.y,
      width: rect.width,
      height: rect.height,
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
    const key = this.buildSeriesKey([nodes.length, coord.plot.width, coord.plot.height]);
    if (key === this.treemapKey && this.pixels.length === nodes.length * 2) return;
    this.treemapKey = key;
    this.pixels = new Float64Array(nodes.length * 2);
    for (const node of nodes) {
      const rect = this.rectOf(node);
      this.pixels[node.id * 2] = rect.x - coord.plot.x + rect.width / 2;
      this.pixels[node.id * 2 + 1] = rect.y - coord.plot.y + rect.height / 2;
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
      const rect = this.rectOf(node);
      const x = rect.x - coord.plot.x;
      const y = rect.y - coord.plot.y;
      if (localX < x || localX > x + rect.width || localY < y || localY > y + rect.height) continue;
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
    this.rectCache = new Map();
    this.beginDraw();

    for (const node of coord.layout) {
      const rect = this.rectOf(node);
      const x = rect.x - plot.x;
      const y = rect.y - plot.y;
      ctx.beginPath();
      ctx.rect(x, y, rect.width, rect.height);
      ctx.fillStyle = node.color;
      ctx.fill();
      if (node.depth === 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5 * unit;
        ctx.stroke();
      }
    }

    // 悬停：叠一层提亮 + 描边。父节点只提亮标题带（整块提亮会盖住子节点的颜色），
    // 而且只叠加不改矩形 —— 树图的矩形是拼满的，动一个就会和邻居重叠。
    if (this.hoverIndex !== null) {
      const node = coord.layout[this.hoverIndex];
      if (node) {
        const rect = this.rectOf(node);
        const box = {
          x: rect.x - plot.x,
          y: rect.y - plot.y,
          width: rect.width,
          height: node.hasChildren && node.header > 0 ? node.header : rect.height,
        };
        this.drawHoverOverlay(this.hoverIndex, box, { radius: 0, fill: 'rgba(255,255,255,0.18)' });
      }
    }

    // 标签：只画**放得下**的（含数值占比）。
    //
    // 两个坑都是大屏实测出来的：
    // 1. 父节点标签是左对齐的（画在标题带里），改完 `textAlign` 没有还原 ——
    //    后面的叶子标签就变成「从矩形中心往右排」，等于整体右移半个文本宽；
    //    宽块看不出来，窄块（占比小的那一档，40~70px）直接把字顶出画布。
    // 2. 「放得下」以前只按矩形尺寸判断（< 44px 宽不画），而树图的占比每轮都在变，
    //    44~70px 之间浮动时 4 个汉字的名字照样会横着压到隔壁块上。
    //    现在按**真实文本宽度**判断：先按主题字号试，放不下逐级缩到 9px，仍放不下才不画。
    const minFontSize = 9;
    /**
     * 先按主题字号试，放不下逐级缩到 9px；返回能放下这些行的字号（返回 9 表示仍可能放不下，由调用方再判一次）。
     * 量宽用 `measureTextWidth`（不区分字重），所以阈值里留了 8px 的左右余量给粗体。
     */
    const fitFontSize = (lines: string[], limit: number): number => {
      let size = theme.fontSize;
      while (size > minFontSize) {
        if (lines.every((line) => measureTextWidth(ctx, line, size, theme.fontFamily) <= limit)) break;
        size -= 1;
      }
      return size;
    };
    this.setFont(theme.fontSize, theme.fontFamily);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const node of coord.layout) {
      if (node.ratio < minLabelRatio) continue;
      const rect = this.rectOf(node);
      const ratioText = `${(node.ratio * 100).toFixed(1)}%`;
      // 父节点：标签画在标题带里（左上角），不压住子矩形
      if (node.hasChildren && node.header > 0) {
        ctx.textAlign = 'left';
        ctx.fillStyle = node.depth === 0 ? '#ffffff' : theme.textColor;
        const label = `${node.name} ${ratioText}`;
        const size = fitFontSize([label], rect.width - 16 * unit);
        if (size > minFontSize || measureTextWidth(ctx, label, size, theme.fontFamily) <= rect.width - 16 * unit) {
          this.setFont(size, theme.fontFamily, 'bold');
          ctx.fillText(label, rect.x - plot.x + 8 * unit, rect.y - plot.y + node.header / 2);
        }
        continue;
      }
      if (rect.width < 44 || rect.height < 26) continue;
      const text = rect.height >= 40 ? `${node.name}\n${ratioText}` : `${node.name} ${ratioText}`;
      const lines = text.split('\n');
      const size = fitFontSize(lines, rect.width - 8 * unit);
      const maxLineWidth = Math.max(...lines.map((line) => measureTextWidth(ctx, line, size, theme.fontFamily)));
      if (maxLineWidth > rect.width - 8 * unit) continue; // 缩到最小字号还放不下：宁可不画，也不压到邻居
      this.setFont(size, theme.fontFamily);
      ctx.textAlign = 'center'; // 父节点标签是左对齐的，叶子必须显式改回来
      const color = node.depth === 0 ? '#ffffff' : theme.textColor;
      ctx.fillStyle = color;
      const lineHeight = size * 1.35;
      const startY = rect.y - plot.y + rect.height / 2 - ((lines.length - 1) * lineHeight) / 2;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], rect.x - plot.x + rect.width / 2, startY + i * lineHeight);
      }
    }
    this.endDraw();
  }
}
