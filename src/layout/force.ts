import { CHART_PALETTE } from '../theme/chartTheme';
import type { Rect } from '../internal';
import type { GraphLinkOption, GraphNodeOption, GraphOption } from '../types';

export interface ForceNodeLayout {
  id: number;
  name: string;
  x: number;
  y: number;
  /** 力布局开始前的位置（环形铺开）——入场动画从它收敛到最终位置。 */
  initialX: number;
  initialY: number;
  /** 由权重映射出的直径。 */
  size: number;
  value: number;
  /** 度数（连了几条边），提示框与调试都用得上。 */
  degree: number;
  color: string;
  category: string | number | undefined;
  fixed: boolean;
}

export interface ForceLinkLayout {
  id: number;
  source: number;
  target: number;
  value: number;
  width: number;
  color: string;
}

export interface ForceLayoutResult {
  nodes: ForceNodeLayout[];
  links: ForceLinkLayout[];
}

/**
 * 力导向布局（纯函数）。
 *
 * 与 sankey / treemap 一样，布局独立于渲染：输入节点与连线，输出坐标，
 * 绘制与命中判定消费同一份结果。
 *
 * 三个力：
 * - **斥力**（所有节点两两之间，∝ 1/d²）把节点推开；
 * - **弹力**（沿连线，∝ d − edgeLength）把有关系的节点拉到理想距离；
 * - **向心力**（∝ 中心 − 位置）防止孤立子图飘走。
 *
 * 初始位置用**环形均匀铺开**而不是随机：结果可复现，测试才能断言，
 * 用户每次刷新看到的图也一致（随机初始位置会让同一份数据每次长得都不一样）。
 */
export function forceLayout(
  nodes: GraphNodeOption[],
  links: GraphLinkOption[],
  rect: Rect,
  options: GraphOption = { nodes: [], links: [] },
  palette: string[] = CHART_PALETTE
): ForceLayoutResult {
  const count = nodes.length;
  if (!count) return { nodes: [], links: [] };
  const mode = options.layout || 'force';
  const [minSize, maxSize] = Array.isArray(options.symbolSizeRange) ? options.symbolSizeRange : [12, 48];

  const indexOf = (ref: string | number): number => {
    if (typeof ref === 'number') return ref >= 0 && ref < count ? ref : -1;
    for (let i = 0; i < count; i++) {
      const node: any = nodes[i];
      if (node.id === ref || node.name === ref) return i;
    }
    return -1;
  };
  const resolved = links
    .map((link, id) => ({
      id,
      source: indexOf(link.source),
      target: indexOf(link.target),
      value: Number(link.value) || 1,
      color: link.color,
    }))
    .filter((link) => link.source >= 0 && link.target >= 0 && link.source !== link.target);

  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const maxRadius = Math.max(10, Math.min(rect.width, rect.height) / 2 - maxSize / 2 - 4);

  // 1) 初始位置：给了坐标就用，否则环形铺开
  const positions = nodes.map((node, i) => {
    if (isFinite(Number(node.x)) && isFinite(Number(node.y))) {
      return {
        x: clamp(Number(node.x), rect.x + 2, rect.x + rect.width - 2),
        y: clamp(Number(node.y), rect.y + 2, rect.y + rect.height - 2),
      };
    }
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    return { x: cx + Math.cos(angle) * maxRadius * 0.8, y: cy + Math.sin(angle) * maxRadius * 0.8 };
  });
  const velocity = positions.map(() => ({ x: 0, y: 0 }));
  /** 入场动画的起点：迭代**之前**的位置（环形铺开），不是迭代后的结果。 */
  const initialPositions = positions.map((p) => ({ x: p.x, y: p.y }));

  const degree = new Array(count).fill(0);
  const weight = new Array(count).fill(0);
  for (const link of resolved) {
    degree[link.source]++;
    degree[link.target]++;
    weight[link.source] += link.value;
    weight[link.target] += link.value;
  }
  const maxWeight = Math.max(1, ...weight);

  const sizeOf = (index: number): number => {
    const explicit = Number(nodes[index].value);
    if (!isFinite(explicit) || explicit <= 0) return minSize;
    // 权重 → 面积（直径开方映射），否则大权重会显得夸张
    const t = Math.sqrt(Math.max(0, Math.min(1, weight[index] / maxWeight)));
    return minSize + (maxSize - minSize) * t;
  };

  if (mode === 'force') {
    const repulsion = numberOr(options.repulsion, 6000);
    const edgeLength = numberOr(options.edgeLength, 70);
    const gravity = numberOr(options.gravity, 0.06);
    const damping = Math.max(0.1, Math.min(0.98, numberOr(options.damping, 0.85)));
    const iterations = Math.max(1, Math.floor(numberOr(options.iterations, 240)));
    const minDistance = Math.max(8, (minSize + maxSize) / 6);
    const springStrength = 0.06;

    for (let step = 0; step < iterations; step++) {
      const cooling = 1 - step / iterations;
      // 斥力
      for (let i = 0; i < count; i++) {
        if (nodes[i].fixed) continue;
        for (let j = i + 1; j < count; j++) {
          let dx = positions[j].x - positions[i].x;
          let dy = positions[j].y - positions[i].y;
          let distance = Math.hypot(dx, dy);
          if (distance < minDistance) {
            // 完全重合时给一个确定性的微小偏移，避免除零
            dx = dx || (i % 2 === 0 ? 0.5 : -0.5);
            dy = dy || (j % 2 === 0 ? 0.5 : -0.5);
            distance = Math.hypot(dx, dy);
          }
          const force = (repulsion / (distance * distance)) * cooling;
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          velocity[i].x -= fx;
          velocity[i].y -= fy;
          if (!nodes[j].fixed) {
            velocity[j].x += fx;
            velocity[j].y += fy;
          }
        }
      }
      // 弹力
      for (const link of resolved) {
        const a = positions[link.source];
        const b = positions[link.target];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(0.01, Math.hypot(dx, dy));
        const target = edgeLength + (link.value > 1 ? Math.min(40, link.value) : 0);
        const force = (distance - target) * springStrength * cooling;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        if (!nodes[link.source].fixed) {
          velocity[link.source].x += fx;
          velocity[link.source].y += fy;
        }
        if (!nodes[link.target].fixed) {
          velocity[link.target].x -= fx;
          velocity[link.target].y -= fy;
        }
      }
      // 向心力 + 积分
      for (let i = 0; i < count; i++) {
        if (nodes[i].fixed) continue;
        velocity[i].x += (cx - positions[i].x) * gravity * cooling;
        velocity[i].y += (cy - positions[i].y) * gravity * cooling;
        velocity[i].x *= damping;
        velocity[i].y *= damping;
        positions[i].x += velocity[i].x;
        positions[i].y += velocity[i].y;
      }
    }
  }

  // 2) 等比铺满绘图区：力布局收敛后往往挤在中间一小块，
  //    统一做一次「按包围盒缩放 + 居中」，保证填满可用空间（这是力导向图的常规收尾）。
  if (mode === 'force' && count > 1) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const half = sizeOf(i) / 2;
      minX = Math.min(minX, positions[i].x - half);
      maxX = Math.max(maxX, positions[i].x + half);
      minY = Math.min(minY, positions[i].y - half);
      maxY = Math.max(maxY, positions[i].y + half);
    }
    const padding = 8;
    const boxWidth = Math.max(1, maxX - minX);
    const boxHeight = Math.max(1, maxY - minY);
    const scale = Math.min(3, Math.min((rect.width - padding * 2) / boxWidth, (rect.height - padding * 2) / boxHeight));
    if (isFinite(scale) && scale > 0) {
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      for (let i = 0; i < count; i++) {
        positions[i].x = cx + (positions[i].x - centerX) * scale;
        positions[i].y = cy + (positions[i].y - centerY) * scale;
      }
    }
  }

  // 3) 收敛到可用区域内（力布局可能把节点推到边界外）
  const layout: ForceNodeLayout[] = nodes.map((node, i) => {
    const half = sizeOf(i) / 2;
    const x = clamp(positions[i].x, rect.x + half, rect.x + rect.width - half);
    const y = clamp(positions[i].y, rect.y + half, rect.y + rect.height - half);
    return {
      id: i,
      name: node.name,
      x,
      y,
      initialX: initialPositions[i].x,
      initialY: initialPositions[i].y,
      size: sizeOf(i),
      value: weight[i],
      degree: degree[i],
      color: node.color || colorOf(node, options, palette, i),
      category: node.category,
      fixed: !!node.fixed,
    };
  });

  const maxLinkValue = Math.max(1, ...resolved.map((link) => link.value));
  const linkLayout: ForceLinkLayout[] = resolved.map((link) => ({
    id: link.id,
    source: link.source,
    target: link.target,
    value: link.value,
    width: 1 + 3 * Math.sqrt(link.value / maxLinkValue),
    color: link.color || layout[link.source].color,
  }));

  return { nodes: layout, links: linkLayout };
}

function colorOf(node: GraphNodeOption, options: GraphOption, palette: string[], index: number): string {
  if (node.category !== undefined && Array.isArray(options.categories)) {
    const found = options.categories.find((category) => category.name === node.category);
    if (found && found.color) return found.color;
    const position = options.categories.findIndex((category) => category.name === node.category);
    if (position >= 0) return palette[position % palette.length];
  }
  return palette[index % palette.length];
}

function numberOr(value: any, fallback: number): number {
  const n = Number(value);
  return isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 顶点/连线的曲线控制点（绘制与命中判定共用）。 */
export function sampleGraphLink(
  link: ForceLinkLayout,
  nodes: ForceNodeLayout[],
  curve: boolean,
  samples = 14
): Array<[number, number]> {
  const a = nodes[link.source];
  const b = nodes[link.target];
  const points: Array<[number, number]> = [];
  if (!a || !b) return points;
  if (!curve) {
    points.push([a.x, a.y], [b.x, b.y]);
    return points;
  }
  // 轻微弧线：控制点在两点连线的中垂线上偏移，避免多条边叠在一起
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const bend = Math.min(30, length * 0.18);
  const cx = mx - (dy / length) * bend;
  const cy = my + (dx / length) * bend;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    points.push([mt * mt * a.x + 2 * mt * t * cx + t * t * b.x, mt * mt * a.y + 2 * mt * t * cy + t * t * b.y]);
  }
  return points;
}
