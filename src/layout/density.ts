/**
 * 核密度估计（KDE）：把一组观测值变成一条密度曲线。
 *
 * 纯函数、不依赖 DOM / 画布，所以「画出来的轮廓」与「算出来的分位数」
 * 可以在这里被单测钉住；组件只负责把曲线映射成像素（见 `ViolinSeries`）。
 *
 * 口径：
 * - 核函数是高斯核，带宽默认走 Silverman 经验法则 `0.9 · min(σ, IQR/1.34) · n^(-1/5)`；
 * - 网格取 `[min - 3h, max + 3h]`，两端尾巴已经可以忽略（实测积分与 1 的偏差 < 1%）；
 * - 输出的是**真密度**（单位 1/y，曲线下面积 = 1），不是归一化到 0~1 的「形状」——
 *   归一化在组件里做，这样提示框还能报真实的峰值密度。
 */

export interface KdeProfile {
  /** 实际使用的带宽（显式传入时就是它）。 */
  bandwidth: number;
  /** 自变量的评估网格，升序。 */
  grid: number[];
  /** 与 `grid` 一一对应的密度值，均非负。 */
  density: number[];
}

export interface KdeOptions {
  /** 显式带宽；`'auto'` 或不传 = Silverman。 */
  bandwidth?: number | 'auto';
  /** 评估网格的点数，默认 64。 */
  samples?: number;
}

const DEFAULT_SAMPLES = 64;
/** 网格相对样本极值向外延伸的带宽倍数。 */
const TAIL_BANDWIDTHS = 3;
const GAUSSIAN_NORM = 1 / Math.sqrt(2 * Math.PI);

function sortedCopy(values: number[]): number[] {
  return values.slice().sort((a, b) => a - b);
}

/** 线性插值分位数（与 `computeBoxplotSummary` 同一口径，避免两处定义打架）。 */
function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  if (n === 1) return sorted[0];
  const position = (n - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.min(n - 1, lower + 1);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function standardDeviation(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (const value of values) sum += (value - mean) ** 2;
  return Math.sqrt(sum / values.length);
}

/**
 * Silverman 经验法则。
 *
 * 样本没有离散度时（全是同一个值）σ 与 IQR 都是 0，公式会给出 0 带宽 ——
 * 那会让密度变成一条无穷高的尖刺，画出来是 NaN / Infinity。
 * 这里退回一个「相对量级极小」的带宽，密度仍是一条**有限高**的尖峰。
 */
export function silvermanBandwidth(values: number[]): number {
  const n = values.length;
  if (!n) return 0;
  const sorted = sortedCopy(values);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sigma = standardDeviation(values, mean);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  const estimate = 0.9 * Math.min(sigma, iqr / 1.34) * Math.pow(n, -0.2);
  if (estimate > 0) return estimate;
  // 离散度为 0：用量级兜底（不要用绝对值 1，否则 1e-9 量级的数据会被抹平）
  return Math.max(Math.abs(mean), 1e-9) * 1e-3;
}

/**
 * 在评估网格上算出高斯核密度。
 *
 * 空样本返回空 profile（**不抛异常**）：坏数据不该让整张图崩掉，
 * 与表达式诊断、标注诊断同一条纪律。
 */
export function computeKdeProfile(values: number[], options: KdeOptions = {}): KdeProfile {
  const n = values.length;
  if (!n) return { bandwidth: 0, grid: [], density: [] };

  const requested = options.bandwidth;
  const bandwidth =
    typeof requested === 'number' && isFinite(requested) && requested > 0
      ? requested
      : silvermanBandwidth(values);

  const samples = Math.max(2, Math.floor(Number(options.samples) || DEFAULT_SAMPLES));
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const lo = min - TAIL_BANDWIDTHS * bandwidth;
  const hi = max + TAIL_BANDWIDTHS * bandwidth;
  const step = (hi - lo) / (samples - 1);

  const grid = new Array<number>(samples);
  const density = new Array<number>(samples);
  for (let i = 0; i < samples; i++) {
    const x = i === samples - 1 ? hi : lo + step * i;
    grid[i] = x;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const z = (x - values[k]) / bandwidth;
      sum += GAUSSIAN_NORM * Math.exp(-0.5 * z * z);
    }
    density[i] = sum / (n * bandwidth);
  }
  return { bandwidth, grid, density };
}

export interface BeeswarmOptions {
  /**
   * 把观测值映射成**像素 y**（组件传 `yScale.map`）。
   * 避让发生在像素空间 —— 它算的是「这两个圆会不会压在一起」，
   * 所以这个函数必须在调用时传入，纯函数本身不依赖比例尺。
   */
  yOf: (value: number, index: number) => number;
  /** 标记半径（设备像素）。 */
  radius: number;
  /** 允许的单侧最大水平偏移（设备像素），通常取 band 宽度的一半。 */
  maxOffset: number;
}

/**
 * 蜂群排布：同一高度上挤在一起的观测点，向两侧依次错开一个直径。
 *
 * 复杂度 O(n · k)，k 是纵向 2r 邻域内已放置的点数（容量封顶，不会退化）。
 * 排不下时（点比槽位多）**不继续外扩**，改用确定性的伪随机偏移 ——
 * 宽度必须封顶，否则一个上万点的组会把条带撑满整张图；
 * 确定性保证同一份数据每次画出来一模一样（不要引入随机源）。
 */
export function computeBeeswarmOffsets(values: number[], options: BeeswarmOptions): number[] {
  const n = values.length;
  const offsets = new Array<number>(n).fill(0);
  const radius = Math.max(0, Number(options.radius) || 0);
  const maxOffset = Math.max(0, Number(options.maxOffset) || 0);
  if (!n || radius <= 0 || maxOffset <= 0) return offsets;

  const diameter = radius * 2;
  const ys = new Array<number>(n);
  for (let i = 0; i < n; i++) ys[i] = options.yOf(values[i], i);

  // 按 y 升序放置；同高度保持原始下标顺序（结果与数据顺序绑定，可复现）
  const order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b] || a - b);
  const placed: Array<{ x: number; y: number }> = [];
  const maxSlots = Math.floor(maxOffset / diameter);

  for (const i of order) {
    const y = ys[i];
    if (!isFinite(y)) continue;
    // 已放置的点按 y 升序，回溯到「纵向还在 2r 之内」的第一个即可
    let start = placed.length;
    while (start > 0 && placed[start - 1].y >= y - diameter) start--;

    let chosen = 0;
    let found = false;
    for (let k = 0; k <= maxSlots && !found; k++) {
      const candidates = k === 0 ? [0] : [k * diameter, -k * diameter];
      for (const dx of candidates) {
        if (Math.abs(dx) > maxOffset) continue;
        let collides = false;
        for (let p = start; p < placed.length; p++) {
          const ddx = placed[p].x - dx;
          const ddy = placed[p].y - y;
          if (ddx * ddx + ddy * ddy < diameter * diameter) {
            collides = true;
            break;
          }
        }
        if (!collides) {
          chosen = dx;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      const hash = Math.sin(i * 12.9898 + y * 78.233) * 43758.5453;
      chosen = (hash - Math.floor(hash)) * 2 * maxOffset - maxOffset;
    }
    offsets[i] = chosen;
    placed.push({ x: chosen, y });
  }
  return offsets;
}
