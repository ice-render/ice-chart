import { CHART_PALETTE } from '../theme/chartTheme';
import type { Rect } from '../internal';
import type { TreemapOption } from '../types';

export interface TreemapInputNode {
  name: string;
  value?: number;
  children?: TreemapInputNode[];
  color?: string;
}

export interface TreemapNodeLayout {
  /** 在扁平列表中的下标（命中判定返回它）。 */
  id: number;
  name: string;
  depth: number;
  parent: number;
  /** 自身数值（有子节点时是子节点之和）。 */
  value: number;
  /** 占根总量比例（0~1）。 */
  ratio: number;
  rect: Rect;
  /** 为「父节点标题带」预留的高度（0 表示没有标题带）。 */
  header: number;
  color: string;
  hasChildren: boolean;
}

/**
 * 矩形树图布局（squarified treemap）。
 *
 * 与 sankey 一样，这是「布局」而不是「坐标系」，因此做成纯函数：
 * 输入层级数据与可用矩形，输出每个节点的矩形、颜色与层级；
 * 绘制与命中判定消费同一份结果。
 *
 * squarified 的核心是「每一行都尽量接近正方形」：按数值降序贪心成行，
 * 一旦加入下一个节点会让长宽比变差就换行，长宽比由此保持在可读范围内。
 */
export function layoutTreemap(
  data: TreemapInputNode[],
  rect: Rect,
  options: TreemapOption = {},
  palette: string[] = CHART_PALETTE
): TreemapNodeLayout[] {
  const out: TreemapNodeLayout[] = [];
  const gap = Math.max(0, Number(options.gap) || 2);
  const headerHeight = 16;
  const depthFade = options.depthFade === undefined ? 0.18 : Math.max(0, Math.min(1, Number(options.depthFade)));
  if (!Array.isArray(data) || !data.length) return out;

  const totalValue = sumValues(data);
  if (!(totalValue > 0)) return out;

  let nextId = 0;

  const visit = (nodes: TreemapInputNode[], bounds: Rect, depth: number, parentId: number, baseColor: string): void => {
    if (bounds.width <= 1 || bounds.height <= 1) return;
    const values = nodes.map((node) => ({ node, value: nodeValue(node) })).filter((item) => item.value > 0);
    if (!values.length) return;
    values.sort((a, b) => b.value - a.value);
    const total = values.reduce((sum, item) => sum + item.value, 0);
    const boxes = squarify(values, bounds, total);

    for (let i = 0; i < boxes.length; i++) {
      const { item, box } = boxes[i];
      const color = item.node.color || shade(baseColor, depth * depthFade);
      const children = Array.isArray(item.node.children) ? item.node.children : [];
      const hasChildren = children.length > 0;
      const id = nextId++;
      const header = hasChildren && box.height > headerHeight * 2 ? headerHeight : 0;
      out.push({
        id,
        name: item.node.name,
        depth,
        parent: parentId,
        value: item.value,
        ratio: item.value / totalValue,
        rect: box,
        header,
        color,
        hasChildren,
      });
      if (hasChildren) {
        const inner: Rect = {
          x: box.x + gap,
          y: box.y + gap + header,
          width: Math.max(0, box.width - gap * 2),
          height: Math.max(0, box.height - gap * 2 - header),
        };
        visit(children, inner, depth + 1, id, color);
      }
    }
  };

  visit(data, rect, 0, -1, palette[0]);
  // 顶层节点按色板分配颜色（子节点在各自父色上做淡化）
  const roots = out.filter((node) => node.depth === 0);
  roots.forEach((node, index) => {
    const color = palette[index % palette.length];
    node.color = color;
    recolor(out, node.id, color, palette, depthFade);
  });
  return out;
}

/** 顶层换色后，把子节点按各自父色重新淡化一遍。 */
function recolor(
  nodes: TreemapNodeLayout[],
  parentId: number,
  parentColor: string,
  palette: string[],
  depthFade: number
): void {
  for (const node of nodes) {
    if (node.parent !== parentId) continue;
    node.color = shade(parentColor, node.depth * depthFade);
    recolor(nodes, node.id, node.color, palette, depthFade);
  }
}

function sumValues(nodes: TreemapInputNode[]): number {
  let total = 0;
  for (const node of nodes) total += nodeValue(node);
  return total;
}

function nodeValue(node: TreemapInputNode): number {
  if (Array.isArray(node.children) && node.children.length) {
    return sumValues(node.children);
  }
  const value = Number(node.value);
  return isFinite(value) && value > 0 ? value : 0;
}

interface RowItem {
  node: TreemapInputNode;
  value: number;
}

/** squarified：把一组（已按值降序的）节点切成尽量接近正方形的矩形。 */
function squarify(items: RowItem[], rect: Rect, total: number): Array<{ item: RowItem; box: Rect }> {
  const out: Array<{ item: RowItem; box: Rect }> = [];
  let remaining = { ...rect };
  const rest = items.slice();
  const scale = (rect.width * rect.height) / total;
  if (!(scale > 0)) return out;

  while (rest.length) {
    const shorter = Math.min(remaining.width, remaining.height);
    if (!(shorter > 0)) break;
    const row: RowItem[] = [];
    let rowArea = 0;
    while (rest.length) {
      const candidate = rest[0];
      const nextArea = rowArea + candidate.value * scale;
      const currentWorst = row.length ? worstRatio(row, rowArea, shorter) : Infinity;
      const nextWorst = worstRatio([...row, candidate], nextArea, shorter);
      if (row.length && nextWorst > currentWorst) break;
      row.push(rest.shift() as RowItem);
      rowArea = nextArea;
    }
    const horizontal = remaining.width >= remaining.height;
    const thickness = rowArea / shorter;
    let offset = 0;
    for (const item of row) {
      const length = (item.value * scale) / thickness;
      const box: Rect = horizontal
        ? { x: remaining.x, y: remaining.y + offset, width: thickness, height: length }
        : { x: remaining.x + offset, y: remaining.y, width: length, height: thickness };
      out.push({ item, box });
      offset += length;
    }
    remaining = horizontal
      ? {
          x: remaining.x + thickness,
          y: remaining.y,
          width: Math.max(0, remaining.width - thickness),
          height: remaining.height,
        }
      : {
          x: remaining.x,
          y: remaining.y + thickness,
          width: remaining.width,
          height: Math.max(0, remaining.height - thickness),
        };
  }
  return out;
}

/** 该行的最差长宽比（越小越方）。 */
function worstRatio(row: RowItem[], rowArea: number, shorter: number): number {
  if (!(rowArea > 0) || !(shorter > 0)) return Infinity;
  let max = 0;
  let min = Infinity;
  for (const item of row) {
    if (item.value > max) max = item.value;
    if (item.value < min) min = item.value;
  }
  if (!(min > 0)) return Infinity;
  const area = rowArea;
  const side = shorter;
  return Math.max((side * side * max) / (area * area), (area * area) / (side * side * min));
}

/** 颜色与白色混合（depth 越深越浅）。 */
function shade(color: string, ratio: number): string {
  const rgb = parseHex(color);
  if (!rgb) return color;
  const t = Math.max(0, Math.min(1, ratio));
  const r = Math.round(rgb[0] + (255 - rgb[0]) * t);
  const g = Math.round(rgb[1] + (255 - rgb[1]) * t);
  const b = Math.round(rgb[2] + (255 - rgb[2]) * t);
  return `rgb(${r},${g},${b})`;
}

function parseHex(color: string): [number, number, number] | null {
  if (typeof color !== 'string') return null;
  let hex = color.trim();
  if (hex.indexOf('#') === 0) {
    hex = hex.slice(1);
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length !== 6) return null;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const match = hex.match(/rgba?\(([^)]+)\)/);
  if (match) {
    const parts = match[1].split(',').map((v) => parseFloat(v));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }
  return null;
}
