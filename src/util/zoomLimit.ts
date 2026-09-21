/**
 * 缩放比例限制（类目 / 时间轴）。
 *
 * 口径跟主流轻量图表库一致：限制写成「**每根占多少像素**」，而不是「占数据域的百分之几」。
 * 后者会随「图上载入了多少根」浮动 —— 页面按需加载 / 裁剪数据时，同一个百分比代表的
 * 密度完全不一样（实测：K 线页缩放到底能到 **0.24px/根**，一根都占不到一个像素，
 * 整片糊成色带；而放大那头卡在「数据域的 5%」，比例一变限制就跟着变）。
 *
 * | 选项 | 含义 | 默认 |
 * |---|---|---|
 * | `minBarSpacing` | 最密能到多少（管「缩到底」） | `0.5` px/根 |
 * | `maxBarSpacing` | 最粗能到多少（管「放到头」） | `0` = 自动 → 绘图区宽度的一半 |
 *
 * 半幅这个默认值等价于「一屏最少两根」（主流库里的 `MinVisibleBarsCount = 2` 就是配着
 * 「最大间距 = 半幅」来的），所以两根是放大到头的极限。
 */
export interface ZoomLimitOptions {
  minBarSpacing?: number;
  maxBarSpacing?: number;
}

/** 最密 0.5px/根（主流库的 `minBarSpacing` 默认值）。 */
export const DEFAULT_MIN_BAR_SPACING = 0.5;

export function minBarSpacingOf(option: ZoomLimitOptions | undefined): number {
  const raw = Number(option && option.minBarSpacing);
  return isFinite(raw) && raw > 0 ? raw : DEFAULT_MIN_BAR_SPACING;
}

/** 每根能占到的最大像素；`maxBarSpacing <= 0` 表示「自动」= 绘图区宽度的一半。 */
export function maxBarSpacingOf(option: ZoomLimitOptions | undefined, plotWidth: number): number {
  const raw = Number(option && option.maxBarSpacing);
  if (isFinite(raw) && raw > 0) return raw;
  return Math.max(1, plotWidth * 0.5);
}

/** 缩放限制对应的**可见根数**区间（闭区间）。 */
export function barCountRange(plotWidth: number, option: ZoomLimitOptions | undefined): [number, number] {
  const width = Math.max(1, plotWidth);
  const minCount = Math.max(2, Math.ceil(width / maxBarSpacingOf(option, width)));
  const maxCount = Math.max(minCount, Math.floor(width / minBarSpacingOf(option)));
  return [minCount, maxCount];
}

/** 把「想看到的根数」夹进缩放比例限制。 */
export function clampBarCount(count: number, plotWidth: number, option: ZoomLimitOptions | undefined): number {
  const [minCount, maxCount] = barCountRange(plotWidth, option);
  if (!isFinite(count)) return minCount;
  return Math.min(maxCount, Math.max(minCount, count));
}

/** 这个根数是否已经超出缩放比例限制（用来拦「别人塞进来的窗口」）。 */
export function outOfBarCountRange(count: number, plotWidth: number, option: ZoomLimitOptions | undefined): boolean {
  const [minCount, maxCount] = barCountRange(plotWidth, option);
  return count < minCount || count > maxCount;
}
