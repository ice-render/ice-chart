import type { Rect } from '../internal';
import type { MatrixOption } from '../types';

/**
 * 面板矩阵的几何：把可分配区域切成 N 个同构面板。
 *
 * 纯函数、不依赖 DOM / 引擎 —— 面板太多、权重写错这类问题必须能在单测里钉死，
 * 而不是到浏览器里看「怎么画歪了」。面板下标**行优先**（`row · cols + col`）。
 */

export interface ResolvedMatrix {
  /** 每行的高度权重（至少一项）。 */
  rows: number[];
  /** 每列的宽度权重（至少一项）。 */
  columns: number[];
  /** 面板之间的间距（设备像素）。 */
  gap: number;
  /** 面板总数 = `rows.length × columns.length`。 */
  panelCount: number;
}

/** 面板间距默认值：够把相邻面板的边框分开，又不至于吃掉太多绘图区。 */
const DEFAULT_GAP = 8;

/**
 * 把用户的 `matrix` 归一成权重数组。
 *
 * 容错口径（与 spec §11 一致）：数字 = 等分；数组 = 逐项权重；0 / 负 / 非有限一律按 1 处理。
 * 坏配置画成「等分」比整张图空白或抛异常好 —— 图表不该因为一个面板数写错就崩掉。
 */
export function resolveMatrix(option: MatrixOption | undefined | null): ResolvedMatrix | null {
  if (!option) return null;
  const rows = toWeights(option.rows);
  const columns = toWeights(option.columns);
  const raw = option.gap;
  const gap =
    raw === undefined || raw === null ? DEFAULT_GAP : isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : 0;
  return { rows, columns, gap, panelCount: rows.length * columns.length };
}

function toWeights(value: number | number[] | undefined | null): number[] {
  if (Array.isArray(value)) {
    if (!value.length) return [1];
    return value.map((weight) => (isFinite(Number(weight)) && Number(weight) > 0 ? Number(weight) : 1));
  }
  const count = Math.floor(Number(value));
  if (!isFinite(count) || count <= 0) return [1];
  return new Array(count).fill(1);
}

/**
 * 切分面板。
 *
 * `gap` 不摊进面板本身（面板宽 = `(可用宽 − gap·(n−1)) · w_i / Σw`），
 * 亚像素极端下按 1px 兜底：面板多到画布放不下时允许被裁，但绝不能出负尺寸
 * （负宽高会让 canvas 的 `rect()` 静默变成一个空路径，排查起来毫无线索）。
 */
export function computePanelRects(area: Rect, matrix: ResolvedMatrix): Rect[] {
  const { rows, columns, gap } = matrix;
  const rowCount = rows.length;
  const columnCount = columns.length;
  const rowTotal = rows.reduce((a, b) => a + b, 0);
  const columnTotal = columns.reduce((a, b) => a + b, 0);
  const usableWidth = area.width - gap * (columnCount - 1);
  const usableHeight = area.height - gap * (rowCount - 1);

  const rects: Rect[] = [];
  let y = area.y;
  for (let r = 0; r < rowCount; r++) {
    const height = Math.max(1, (usableHeight * rows[r]) / rowTotal);
    let x = area.x;
    for (let c = 0; c < columnCount; c++) {
      const width = Math.max(1, (usableWidth * columns[c]) / columnTotal);
      rects.push({ x, y, width, height });
      x += width + gap;
    }
    y += height + gap;
  }
  return rects;
}

/** 指针落在第几个面板里；-1 表示落在面板之外（含面板之间的缝隙）。 */
export function panelIndexAt(panels: Rect[], x: number, y: number): number {
  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    if (x >= panel.x && x <= panel.x + panel.width && y >= panel.y && y <= panel.y + panel.height) return i;
  }
  return -1;
}
