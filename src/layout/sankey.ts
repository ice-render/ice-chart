import { CHART_PALETTE } from '../theme/chartTheme';
import type { Rect } from '../internal';
import type { SankeyLinkOption, SankeyNodeOption, SankeyOption } from '../types';

export interface SankeyNodeLayout {
  id: number;
  name: string;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 节点总流量（入/出取大者）。 */
  value: number;
  color: string;
}

export interface SankeyLinkLayout {
  id: number;
  source: number;
  target: number;
  value: number;
  /** 连线在源/目标处的厚度。 */
  width: number;
  /** 源端上沿 y。 */
  sy: number;
  /** 目标端上沿 y。 */
  ty: number;
  color: string;
}

export interface SankeyLayoutResult {
  nodes: SankeyNodeLayout[];
  links: SankeyLinkLayout[];
}

/**
 * 桑基图布局（分层 + 纵向松弛）。
 *
 * 这里是 ice-chart 唯一一个「不是坐标系、而是图布局」的模块，因此刻意做成**纯函数**：
 * 输入节点/连线与可用矩形，输出每个节点的矩形与每条连线的厚度/端点，
 * 渲染与命中判定都消费同一份结果（和饼图扇形几何的处理方式一致）。
 *
 * 算法（简化版 d3-sankey）：
 * 1. 按最长路径给节点分层（有环时用 Kahn 拓扑，环上的节点退化为同层）；
 * 2. 每层先均匀铺开，再按邻居位置做几轮加权松弛，最后按顺序打包，保证不重叠；
 * 3. 连线厚度 = 流量 × 端点节点「流量→像素」比例（取两端较小值），
 *    并依次堆叠在节点的出入侧，保证同侧连线不重叠。
 *
 * **列内顺序可以由调用方钉住**（`options.nodeOrder`，用户在图上拖过节点之后由图表写回）：
 * 表里列到的节点按表内位置排在前，没列到的排在后面并保持各自的 y 序 —— 于是「只钉一列」
 * （拖过的那一列）也能表达，其余列照旧跟着松弛结果走。表缺席时逐值等于以前的行为。
 */
export function layoutSankey(
  nodes: SankeyNodeOption[],
  links: SankeyLinkOption[],
  rect: Rect,
  options: SankeyOption = { nodes: [], links: [] },
  palette: string[] = CHART_PALETTE
): SankeyLayoutResult {
  const count = nodes.length;
  if (!count) return { nodes: [], links: [] };
  const nodeWidth = Math.max(2, Number(options.nodeWidth) || 16);
  const nodePadding = Math.max(0, Number(options.nodePadding) || 10);
  const iterations = Math.max(0, Number(options.iterations) === undefined ? 6 : Number(options.iterations));

  const indexOf = (ref: string | number): number => {
    if (typeof ref === 'number') return ref >= 0 && ref < count ? ref : -1;
    return nodes.findIndex((node) => node.name === ref);
  };
  /**
   * 列内排序：钉住的节点按 `nodeOrder` 里的位置，未钉住的排在其后、彼此按当前 y 稳定排序。
   * 空表时两级比较键都退化成「y 序」，与从前逐值相同。
   */
  const pinnedRank = new Map<number, number>();
  if (Array.isArray(options.nodeOrder)) {
    options.nodeOrder.forEach((ref, position) => {
      const id = indexOf(ref);
      if (id >= 0 && !pinnedRank.has(id)) pinnedRank.set(id, position);
    });
  }
  const sortColumn = (column: number[]): void => {
    column.sort((a, b) => {
      const rankA = pinnedRank.has(a) ? (pinnedRank.get(a) as number) : Number.POSITIVE_INFINITY;
      const rankB = pinnedRank.has(b) ? (pinnedRank.get(b) as number) : Number.POSITIVE_INFINITY;
      if (rankA !== rankB) return rankA - rankB;
      return layout[a].y - layout[b].y;
    });
  };

  const resolved = links
    .map((link, id) => ({
      id,
      source: indexOf(link.source),
      target: indexOf(link.target),
      value: Math.max(0, Number(link.value) || 0),
      color: link.color,
    }))
    .filter((link) => link.source >= 0 && link.target >= 0 && link.value > 0);

  // 1) 分层：Kahn 拓扑求最长路径
  const out: number[][] = nodes.map(() => []);
  const incoming: number[][] = nodes.map(() => []);
  const indegree = new Array(count).fill(0);
  for (const link of resolved) {
    out[link.source].push(link.target);
    incoming[link.target].push(link.source);
    indegree[link.target]++;
  }
  const depth = new Array(count).fill(0);
  const queue: number[] = [];
  for (let i = 0; i < count; i++) if (indegree[i] === 0) queue.push(i);
  let processed = 0;
  while (queue.length) {
    const current = queue.shift() as number;
    processed++;
    for (const next of out[current]) {
      depth[next] = Math.max(depth[next], depth[current] + 1);
      if (--indegree[next] === 0) queue.push(next);
    }
  }
  // 有环：环上节点沿用当前深度（退化处理，不阻塞渲染）
  void processed;
  for (let i = 0; i < count; i++) {
    if (nodes[i].depth !== undefined) depth[i] = Math.max(0, Number(nodes[i].depth) || 0);
  }

  const maxDepth = Math.max(1, ...depth);
  const columnX = (d: number) => rect.x + (d * (rect.width - nodeWidth)) / maxDepth;

  // 2) 节点流量与初始高度
  // 节点流量取「入/出」较大者：两者相加会把中间节点算成双倍
  const inValue = new Array(count).fill(0);
  const outValue = new Array(count).fill(0);
  for (const link of resolved) {
    outValue[link.source] += link.value;
    inValue[link.target] += link.value;
  }
  const value = new Array(count).fill(0).map((_, i) => Math.max(inValue[i], outValue[i]));
  const maxColumnValue: number[] = new Array(maxDepth + 1).fill(0);
  for (let i = 0; i < count; i++) {
    const d = depth[i];
    maxColumnValue[d] += value[i];
  }
  const columnCount: number[] = new Array(maxDepth + 1).fill(0);
  for (let i = 0; i < count; i++) columnCount[depth[i]]++;

  const scale: number[] = maxColumnValue.map((sum, d) => {
    const usable = rect.height - nodePadding * Math.max(0, columnCount[d] - 1);
    return sum > 0 ? Math.max(1, usable) / sum : 1;
  });

  const layout: SankeyNodeLayout[] = nodes.map((node, i) => {
    const height = Math.max(2, value[i] * scale[depth[i]]);
    return {
      id: i,
      name: node.name,
      depth: depth[i],
      x: columnX(depth[i]),
      y: rect.y,
      width: nodeWidth,
      height,
      value: value[i],
      color: node.color || palette[i % palette.length],
    };
  });

  // 初始：按列均匀铺开
  const columns: number[][] = new Array(maxDepth + 1).fill(0).map(() => []);
  for (const node of layout) columns[node.depth].push(node.id);
  for (const column of columns) {
    sortColumn(column);
    let y = rect.y;
    for (const id of column) {
      layout[id].y = y;
      y += layout[id].height + nodePadding;
    }
  }

  // 3) 纵向松弛：朝邻居重心靠拢，再重新打包
  for (let iter = 0; iter < iterations; iter++) {
    for (const node of layout) {
      const neighbors: Array<{ id: number; weight: number }> = [];
      for (const link of resolved) {
        if (link.source === node.id) neighbors.push({ id: link.target, weight: link.value });
        else if (link.target === node.id) neighbors.push({ id: link.source, weight: link.value });
      }
      if (!neighbors.length) continue;
      let sum = 0;
      let weighted = 0;
      for (const neighbor of neighbors) {
        const other = layout[neighbor.id];
        weighted += (other.y + other.height / 2) * neighbor.weight;
        sum += neighbor.weight;
      }
      const center = sum > 0 ? weighted / sum : node.y + node.height / 2;
      node.y = center - node.height / 2;
    }
    for (const column of columns) {
      sortColumn(column);
      let y = rect.y;
      for (const id of column) {
        layout[id].y = y;
        y += layout[id].height + nodePadding;
      }
    }
  }
  // 最后一轮包住底部溢出
  for (const column of columns) {
    const overflow = column.length
      ? layout[column[column.length - 1]].y + layout[column[column.length - 1]].height - (rect.y + rect.height)
      : 0;
    if (overflow > 0) {
      for (const id of column) layout[id].y = Math.max(rect.y, layout[id].y - overflow);
    }
  }

  // 4) 连线堆叠：按目标顺序排源的出边，按源顺序排目标入边
  const sourceOffsets = new Array(count).fill(0);
  const targetOffsets = new Array(count).fill(0);
  const sortedLinks = resolved.slice().sort((a, b) => a.source - b.source || a.target - b.target);
  const linkLayout: SankeyLinkLayout[] = [];
  for (const link of sortedLinks) {
    const source = layout[link.source];
    const target = layout[link.target];
    const sourceScale = source.value > 0 ? source.height / source.value : 0;
    const targetScale = target.value > 0 ? target.height / target.value : 0;
    const width = Math.max(1, link.value * Math.min(sourceScale, targetScale));
    const sy = source.y + sourceOffsets[link.source];
    const ty = target.y + targetOffsets[link.target];
    sourceOffsets[link.source] += width;
    targetOffsets[link.target] += width;
    linkLayout.push({
      id: link.id,
      source: link.source,
      target: link.target,
      value: link.value,
      width,
      sy,
      ty,
      color: link.color || source.color,
    });
  }

  return { nodes: layout, links: linkLayout };
}

/** 连线中心线的采样点（命中判定与绘制共用）。 */
export function sampleLinkPath(
  link: SankeyLinkLayout,
  sourceX: number,
  targetX: number,
  yOffset = 0,
  samples = 16
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const sy = link.sy + link.width / 2 - yOffset;
  const ty = link.ty + link.width / 2 - yOffset;
  const c0 = sourceX + (targetX - sourceX) * 0.5;
  const c1 = targetX - (targetX - sourceX) * 0.5;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    const x = mt * mt * mt * sourceX + 3 * mt * mt * t * c0 + 3 * mt * t * t * c1 + t * t * t * targetX;
    const y = mt * mt * mt * sy + 3 * mt * mt * t * sy + 3 * mt * t * t * ty + t * t * t * ty;
    points.push([x, y]);
  }
  return points;
}
