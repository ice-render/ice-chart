import type { Rect } from '../internal';

/**
 * 多轴分类流（alluvial / 平行集）：N 个类目轴 + 相邻轴之间的流量带。
 *
 * 与桑基的分工：桑基是**图的拓扑**（谁流向谁、可任意跳级），alluvial 是**表的分面** ——
 * 一行记录在每个轴上取一个类目，流量就是「同时满足这些类目的记录数（或值之和）」。
 * 所以这里的输入是一张表 + 轴列名，而不是 nodes/links。
 *
 * 纯函数：堆叠、聚合、排序、几何全在这里，组件只负责画。
 */

export interface AlluvialAxis {
  name: string;
  /** 节点条左边缘的 x（图表坐标）。 */
  x: number;
  width: number;
  /** 该轴的类目，从上到下。 */
  categories: Array<{ name: string; index: number; y: number; height: number; total: number }>;
}

export interface AlluvialFlow {
  /** 这条带子连接第几个轴与下一个轴。 */
  axis: number;
  fromName: string;
  toName: string;
  value: number;
  /** 起点侧的纵向区间 [y0, y1]（y0 < y1）。 */
  source: [number, number];
  /** 终点侧的纵向区间。 */
  target: [number, number];
}

export interface AlluvialLayout {
  axes: AlluvialAxis[];
  flows: AlluvialFlow[];
  /** 最大的节点流量（配色 / 线宽归一用）。 */
  maxTotal: number;
}

export interface AlluvialConfig {
  /** 每个轴的列名（按顺序）。 */
  axes: string[];
  /** 取值字段名（默认 `value`）。 */
  valueField?: string;
}

export interface AlluvialOptions {
  /** 轴心之间的总跨度占绘图区宽度的比例，默认 0.62（两端留白）。 */
  spread?: number;
  /** 节点条宽度（像素），默认 12。 */
  nodeWidth?: number;
  /** 节点之间的垂直间隙（像素），默认 6。 */
  gap?: number;
  /** 排序：`total`（按流量降序，默认）| `name`（按类目名）。 */
  sort?: 'total' | 'name';
}

/**
 * 一次布局。
 *
 * 排序是 alluvial 可读性的关键：第一个轴按流量降序，之后的轴按「上一轴位置的重心」排 ——
 * 不做这一步，相邻轴之间会冒出大量交叉，带子糊成一团。重心法一趟就够。
 */
export function layoutAlluvial(
  rows: Array<Record<string, any>>,
  config: AlluvialConfig,
  area: Rect,
  options: AlluvialOptions = {}
): AlluvialLayout {
  const axisNames = Array.isArray(config.axes) ? config.axes.filter((name) => !!name) : [];
  const valueField = config.valueField || 'value';
  const nodeWidth = Math.max(2, Number(options.nodeWidth) || 12);
  const gap = Math.max(0, Number(options.gap) || 6);
  const spread = Math.min(0.98, Math.max(0.2, Number(options.spread) || 0.62));
  const sortMode = options.sort === 'name' ? 'name' : 'total';
  if (!axisNames.length || !rows || !rows.length) {
    return { axes: [], flows: [], maxTotal: 0 };
  }

  const axisCount = axisNames.length;
  const usable = Math.max(nodeWidth, area.width - nodeWidth);
  const left = area.x + usable * ((1 - spread) / 2);
  const step = axisCount > 1 ? (usable * spread) / (axisCount - 1) : 0;
  const axisX = axisNames.map((_, index) => left + step * index);

  // 每个轴上的类目总量（决定节点高度）
  const totals: Array<Map<string, number>> = axisNames.map(() => new Map());
  const appearances: string[][] = axisNames.map(() => []);
  for (const row of rows) {
    const value = Number(row[valueField]);
    if (!isFinite(value) || value === 0) continue;
    for (let a = 0; a < axisCount; a++) {
      const raw = row[axisNames[a]];
      if (raw === undefined || raw === null || raw === '') continue;
      const key = String(raw);
      if (!totals[a].has(key)) appearances[a].push(key);
      totals[a].set(key, (totals[a].get(key) || 0) + Math.abs(value));
    }
  }

  // 排序 + 堆叠：所有轴共用同一把「流量 → 像素」的尺子，轴与轴之间才可比
  const axes: AlluvialAxis[] = [];
  const orders: Array<Map<string, number>> = axisNames.map(() => new Map());
  let maxTotal = 0;
  const globalTotal = axisNames.reduce((sum, _name, index) => {
    return Math.max(
      sum,
      appearances[index].reduce((sub, key) => sub + (totals[index].get(key) as number), 0)
    );
  }, 0) || 1;

  for (let a = 0; a < axisCount; a++) {
    const names = appearances[a].slice();
    if (sortMode === 'total') {
      names.sort((x, y) => (totals[a].get(y) as number) - (totals[a].get(x) as number) || x.localeCompare(y));
    } else {
      names.sort((x, y) => x.localeCompare(y));
    }
    const gapTotal = gap * Math.max(0, names.length - 1);
    const usableHeight = Math.max(1, area.height - gapTotal);
    const axisTotal = names.reduce((sum, key) => sum + (totals[a].get(key) as number), 0) || 1;
    // 用「各轴总量里最大的那个」当基准：所有轴的节点高度用同一比例尺
    const ratio = usableHeight / Math.max(axisTotal, globalTotal);
    let y = area.y;
    const categories = names.map((name, index) => {
      const total = totals[a].get(name) as number;
      const height = Math.max(2, total * ratio);
      const category = { name, index, y, height, total };
      orders[a].set(name, index);
      if (total > maxTotal) maxTotal = total;
      y += height + gap;
      return category;
    });
    axes.push({ name: axisNames[a], x: axisX[a], width: nodeWidth, categories });
  }

  // 相邻轴的流量：按 (from, to) 聚合
  const flows: AlluvialFlow[] = [];
  for (let a = 0; a < axisCount - 1; a++) {
    const pair = new Map<string, { from: string; to: string; value: number }>();
    for (const row of rows) {
      const value = Number(row[valueField]);
      if (!isFinite(value) || value === 0) continue;
      const from = row[axisNames[a]];
      const to = row[axisNames[a + 1]];
      if (from === undefined || from === null || from === '' || to === undefined || to === null || to === '') continue;
      const key = `${from}\u0000${to}`;
      const existing = pair.get(key);
      if (existing) existing.value += Math.abs(value);
      else pair.set(key, { from: String(from), to: String(to), value: Math.abs(value) });
    }
    const list = [...pair.values()];
    // 两端各自有序：先按源节点顺序，再按目标节点顺序
    list.sort(
      (x, y) =>
        (orders[a].get(x.from) as number) - (orders[a].get(y.from) as number) ||
        (orders[a + 1].get(x.to) as number) - (orders[a + 1].get(y.to) as number)
    );
    const sourceCursor = new Map<string, number>();
    const targetCursor = new Map<string, number>();
    for (const item of list) {
      const fromCategory = axes[a].categories[orders[a].get(item.from) as number];
      const toCategory = axes[a + 1].categories[orders[a + 1].get(item.to) as number];
      if (!fromCategory || !toCategory) continue;
      const sourceStart = sourceCursor.get(item.from) ?? fromCategory.y;
      const targetStart = targetCursor.get(item.to) ?? toCategory.y;
      const sourceHeight = flowsHeight(item.value, fromCategory.total, fromCategory.height);
      const targetHeight = flowsHeight(item.value, toCategory.total, toCategory.height);
      flows.push({
        axis: a,
        fromName: item.from,
        toName: item.to,
        value: item.value,
        source: [sourceStart, sourceStart + sourceHeight],
        target: [targetStart, targetStart + targetHeight],
      });
      sourceCursor.set(item.from, sourceStart + sourceHeight);
      targetCursor.set(item.to, targetStart + targetHeight);
    }
  }

  return { axes, flows, maxTotal };
}

/** 某条流量在节点里占多高：按它在节点总量里的占比分配节点高度。 */
function flowsHeight(value: number, total: number, height: number): number {
  if (!(total > 0)) return 0;
  return (value / total) * height;
}

/**
 * 命中：节点优先，其次是流量带。
 *
 * 带子判定用「两侧区间 + 横向线性插值」：带子是贝塞尔曲线，严格求交要解三次方程；
 * 而它在人眼看来就是两端区间之间的过渡，按插值判定与看到的形状一致。
 */
export function alluvialTargetAt(
  x: number,
  y: number,
  layout: AlluvialLayout,
  tolerance = 2
): { kind: 'node'; axis: number; index: number } | { kind: 'flow'; index: number } | null {
  for (let a = 0; a < layout.axes.length; a++) {
    const axis = layout.axes[a];
    if (x < axis.x - tolerance || x > axis.x + axis.width + tolerance) continue;
    for (const category of axis.categories) {
      if (y >= category.y - tolerance && y <= category.y + category.height + tolerance) {
        return { kind: 'node', axis: a, index: category.index };
      }
    }
  }
  for (let i = 0; i < layout.flows.length; i++) {
    const flow = layout.flows[i];
    const from = layout.axes[flow.axis];
    const to = layout.axes[flow.axis + 1];
    if (!from || !to) continue;
    const leftEdge = from.x + from.width;
    const rightEdge = to.x;
    if (x < leftEdge || x > rightEdge) continue;
    const t = rightEdge > leftEdge ? (x - leftEdge) / (rightEdge - leftEdge) : 0;
    const y0 = flow.source[0] + (flow.target[0] - flow.source[0]) * t;
    const y1 = flow.source[1] + (flow.target[1] - flow.source[1]) * t;
    if (y >= y0 - tolerance && y <= y1 + tolerance) return { kind: 'flow', index: i };
  }
  return null;
}
