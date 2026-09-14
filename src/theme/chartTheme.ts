import type { ChartTheme } from '../types';

/**
 * 主题基调：**Bootstrap 5**。
 *
 * 取的是 Bootstrap 官方调色板与设计变量（primary/secondary/success/danger/warning/info、
 * gray-100~900、`$border-radius: .375rem`、系统字体栈），这样图表放在 Bootstrap 页面里
 * 与按钮、卡片、表格是同一套视觉语言，不需要额外对齐色板。
 *
 * 说明：`colorPalette` 的前几位刻意排成「primary → success → danger → info → indigo」，
 * 把低对比度的 `warning` 黄往后放 —— 折线/散点用黄色在浅色底上辨识度差，
 * 但作为第 6 个系列色出现时是安全的。
 */

/** Bootstrap 5 调色板（官方 hex 值）。 */
/**
 * 图表默认色板（**唯一来源**）。
 *
 * 以前它散落在 layout/force、layout/treemap、layout/sankey、WaterfallSeries 各自的
 * `palette || ['#0D6EFD']` 兜底里 —— 同一页面里不同图表可能来自不同来源的色板，
 * 视觉上就是「配色怪」。现在统一成一处，各处以它兜底。
 */
export const CHART_PALETTE: string[] = [
  '#0D6EFD',
  '#10B981',
  '#F59E0B',
  '#EF4444',
  '#8B5CF6',
  '#14B8A6',
  '#EC4899',
  '#6366F1',
];

export const BOOTSTRAP_TOKENS = {
  primary: '#0D6EFD',
  secondary: '#6C757D',
  success: '#198754',
  danger: '#DC3545',
  warning: '#FFC107',
  info: '#0DCAF0',
  light: '#F8F9FA',
  dark: '#212529',
  indigo: '#6610F2',
  purple: '#6F42C1',
  pink: '#D63384',
  orange: '#FD7E14',
  teal: '#20C997',
  cyan: '#0DCAF0',
  gray: {
    100: '#F8F9FA',
    200: '#E9ECEF',
    300: '#DEE2E6',
    400: '#CED4DA',
    500: '#ADB5BD',
    600: '#6C757D',
    700: '#495057',
    800: '#343A40',
    900: '#212529',
  },
  /** Bootstrap 的 --bs-body-font-family。 */
  fontFamily:
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
  /** --bs-border-radius */
  radius: 6,
} as const;

const B = BOOTSTRAP_TOKENS;

/** 系列默认色序：与 Bootstrap 主题色一致，低对比度的黄色后置。 */
const BOOTSTRAP_PALETTE = [
  B.primary,
  B.success,
  B.danger,
  B.info,
  B.indigo,
  B.warning,
  B.orange,
  B.teal,
  B.pink,
  B.secondary,
];

/** 亮色主题（Bootstrap 默认外观）。 */
export const BOOTSTRAP_CHART_THEME: ChartTheme = {
  backgroundColor: 'transparent',
  colorPalette: BOOTSTRAP_PALETTE,
  textColor: B.dark,
  subTextColor: B.secondary,
  axisLineColor: B.gray[300],
  axisLabelColor: B.gray[600],
  splitLineColor: B.gray[200],
  // 压在图形上的文字用白色描边（浅色主题）
  labelHaloColor: 'rgba(255,255,255,0.85)',
  fontFamily: B.fontFamily,
  fontSize: 12,
  legend: { textColor: B.gray[700], inactiveColor: B.gray[400] },
  tooltip: {
    background: '#ffffff',
    borderColor: B.gray[300],
    textColor: B.dark,
    shadowColor: 'rgba(33,37,41,0.18)',
    fontSize: 12,
    padding: 10,
    radius: B.radius,
  },
  crosshair: { lineColor: B.gray[500], labelBackground: B.gray[700], labelColor: '#ffffff' },
  brush: { fill: 'rgba(13,110,253,0.16)', stroke: 'rgba(13,110,253,0.8)' },
  selection: { stroke: B.primary, dimOpacity: 0.3 },
};

/** 暗色主题（Bootstrap 5 `data-bs-theme="dark"` 的中性灰基调）。 */
export const BOOTSTRAP_DARK_CHART_THEME: ChartTheme = {
  backgroundColor: 'transparent',
  colorPalette: [
    '#4D94FF',
    '#479F76',
    '#EA868F',
    '#6EDFF6',
    '#A370F7',
    '#FFDA6A',
    '#FD9843',
    '#79DFC1',
    '#E685B5',
    B.gray[500],
  ],
  textColor: B.gray[200],
  subTextColor: B.gray[500],
  axisLineColor: B.gray[700],
  axisLabelColor: B.gray[400],
  splitLineColor: B.gray[800],
  // 深色主题必须用深色描边，否则桑基/关系图的节点名会糊成一团白
  labelHaloColor: 'rgba(10,18,32,0.88)',
  fontFamily: B.fontFamily,
  fontSize: 12,
  legend: { textColor: B.gray[300], inactiveColor: B.gray[700] },
  tooltip: {
    background: B.gray[800],
    borderColor: B.gray[700],
    textColor: B.gray[100],
    shadowColor: 'rgba(0,0,0,0.5)',
    fontSize: 12,
    padding: 10,
    radius: B.radius,
  },
  crosshair: { lineColor: B.gray[600], labelBackground: B.gray[300], labelColor: B.dark },
  brush: { fill: 'rgba(77,148,255,0.2)', stroke: 'rgba(77,148,255,0.85)' },
  selection: { stroke: '#4D94FF', dimOpacity: 0.32 },
};

/** 兼容旧名字：light 主题现在就是 Bootstrap 主题。 */
export const LIGHT_CHART_THEME = BOOTSTRAP_CHART_THEME;
/** 兼容旧名字：dark 主题。 */
export const DARK_CHART_THEME = BOOTSTRAP_DARK_CHART_THEME;

/**
 * 解析主题：`'light'`（默认，Bootstrap）/ `'dark'` / `'auto'` / 自定义片段（浅合并到亮色主题）。
 *
 * `'auto'` = **跟随引擎实例主题**：`preferDark` 由调用方（`ICEChart`）按 `ice.getTheme()` 的明暗算出。
 * 以前 `'auto'` 实际上被当成 `'light'`（函数里只判断了 `'dark'`），与文档承诺不一致 —— 现已改正。
 */
export function resolveChartTheme(
  theme: ChartTheme | 'light' | 'dark' | 'auto' | Partial<ChartTheme> | undefined,
  options: { preferDark?: boolean } = {}
): ChartTheme {
  const base =
    theme === 'dark' || (theme === 'auto' && options.preferDark) ? BOOTSTRAP_DARK_CHART_THEME : BOOTSTRAP_CHART_THEME;
  if (!theme || typeof theme === 'string') return base;
  return {
    ...base,
    ...theme,
    legend: { ...base.legend, ...(theme.legend || {}) },
    tooltip: { ...base.tooltip, ...(theme.tooltip || {}) },
    crosshair: { ...base.crosshair, ...(theme.crosshair || {}) },
    brush: { ...base.brush, ...(theme.brush || {}) },
    selection: { ...base.selection, ...(theme.selection || {}) },
  };
}
