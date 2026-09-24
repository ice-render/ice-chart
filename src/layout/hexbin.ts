/**
 * 六边形分箱（hexbin）：把「太密看不出分布」的点云，聚成蜂窝格上的计数 / 聚合值。
 *
 * 三个约定：
 * 1. **在像素空间分格**（组件把数据点映射成本地像素之后调这里）——
 *    按数据空间分格的话，x / y 比例尺的单位长度不同，画出来是一堆被拉长的菱形而不是蜂窝；
 *    代价是缩放会重新分格，这正是「密度视图」该有的行为（与热力图的亚像素聚合同一条口径）。
 * 2. **尖顶六边形（pointy-top）+ 轴向坐标（q, r）**：格心 `x = √3·R·(q + r/2)`、`y = 1.5·R·r`，
 *    相邻格心距离恒为 `√3·R`，天然无缝。
 * 3. **命中是 O(1)**：像素 → 轴向坐标是闭式解 + 立方体取整（`pixelToHex`），
 *    不需要遍历格子 —— 十万点也照样是常数时间。
 */

export interface HexbinBin {
  /** 轴向坐标。 */
  q: number;
  r: number;
  /** 格心（与入参同一坐标系：组件传本地像素，这里就是本地像素）。 */
  cx: number;
  cy: number;
  /** 聚合值（`count` 时等于点数）。 */
  value: number;
  /** 落进这个格的点数。 */
  count: number;
}

export interface HexbinOptions {
  /** 六边形外接圆半径（像素）。 */
  radius: number;
  /** 聚合口径：计数 / 求和 / 平均 / 最大（后三者取数据项的第三个值）。 */
  aggregate?: 'count' | 'sum' | 'mean' | 'max';
}

const SQRT3 = Math.sqrt(3);

/** 轴向坐标 → 格心。 */
export function hexToPixel(q: number, r: number, radius: number): { x: number; y: number } {
  return { x: SQRT3 * radius * (q + r / 2), y: 1.5 * radius * r };
}

/** 像素 → 轴向坐标（立方体取整，保证落在最近的格心里）。 */
export function pixelToHex(x: number, y: number, radius: number): { q: number; r: number } {
  const rf = y / (1.5 * radius);
  const qf = x / (SQRT3 * radius) - rf / 2;
  // 立方体坐标：x + y + z = 0，谁的取整误差最大就用另外两个反推它
  const xf = qf;
  const zf = rf;
  const yf = -xf - zf;
  let rx = Math.round(xf);
  let ry = Math.round(yf);
  let rz = Math.round(zf);
  const dx = Math.abs(rx - xf);
  const dy = Math.abs(ry - yf);
  const dz = Math.abs(rz - zf);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}

/**
 * 分箱。
 *
 * 点的形状与散点一致：`[x, y]`（计数）或 `[x, y, value]`（加权）。
 * `count` 口径忽略第三个值；其余口径下**缺失 / 非有限的第三个数按 1 算** ——
 * 一个点至少代表一次观测，写成 0 会让「忘了给值」的行悄悄消失。
 */
export function computeHexBins(
  points: Array<[number, number] | [number, number, number]>,
  options: HexbinOptions
): HexbinBin[] {
  const radius = Math.max(0.5, Number(options.radius) || 12);
  const aggregate = options.aggregate || 'count';
  const order: Array<{ q: number; r: number; cx: number; cy: number; value: number; count: number }> = [];
  const index = new Map<string, number>();
  // 加权口径的累加器（与 `order` 同下标）：单趟累加，收尾再算最终值 ——
  // `mean` 若按「每个格子回头扫一遍全量点」实现就是 O(格数 × 点数)，十万点上直接卡死。
  const sums: number[] = [];
  const weightedCounts: number[] = [];

  for (const point of points) {
    if (!point) continue;
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (!isFinite(x) || !isFinite(y)) continue;
    const { q, r } = pixelToHex(x, y, radius);
    const key = `${q},${r}`;
    let at = index.get(key);
    if (at === undefined) {
      const center = hexToPixel(q, r, radius);
      at = order.length;
      index.set(key, at);
      order.push({ q, r, cx: center.x, cy: center.y, value: 0, count: 0 });
    }
    const bin = order[at];
    bin.count += 1;
    const raw = Number((point as any)[2]);
    const weight = isFinite(raw) ? raw : 1;
    if (aggregate === 'count') {
      bin.value = bin.count;
      continue;
    }
    sums[at] = (sums[at] || 0) + weight;
    weightedCounts[at] = (weightedCounts[at] || 0) + 1;
    if (aggregate === 'max') bin.value = Math.max(bin.value, weight);
  }

  if (aggregate === 'sum') {
    order.forEach((bin, at) => {
      bin.value = sums[at] || 0;
    });
  } else if (aggregate === 'mean') {
    order.forEach((bin, at) => {
      bin.value = weightedCounts[at] ? (sums[at] || 0) / weightedCounts[at] : 0;
    });
  }

  return order;
}
