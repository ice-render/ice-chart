import { baseTokens } from 'ice-render';
import type { ChartTheme } from '../types';

const c = (baseTokens as any).color;

/** 亮色主题：默认色板取自 ice-render 的设计 token，保证图表与其他 UI 组件同源。 */
export const LIGHT_CHART_THEME: ChartTheme = {
  backgroundColor: 'transparent',
  colorPalette: [c.blue[500], c.emerald[500], c.amber[500], c.violet[500], c.red[500], c.teal[500], c.pink[500], c.gray[500]],
  textColor: c.gray[800],
  subTextColor: c.gray[500],
  axisLineColor: c.gray[300],
  axisLabelColor: c.gray[600],
  splitLineColor: c.gray[200],
  fontFamily: 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
  fontSize: 12,
  legend: { textColor: c.gray[700], inactiveColor: c.gray[400] },
  tooltip: {
    background: 'rgba(255,255,255,0.96)',
    borderColor: c.gray[200],
    textColor: c.gray[800],
    shadowColor: 'rgba(15,23,42,0.18)',
    fontSize: 12,
    padding: 10,
    radius: 6,
  },
  crosshair: { lineColor: c.gray[400], labelBackground: c.gray[700], labelColor: '#ffffff' },
  brush: { fill: 'rgba(59,130,246,0.16)', stroke: 'rgba(59,130,246,0.75)' },
  selection: { stroke: c.blue[600], dimOpacity: 0.28 },
};

/** 暗色主题。 */
export const DARK_CHART_THEME: ChartTheme = {
  backgroundColor: 'transparent',
  colorPalette: [c.blue[400], c.emerald[400], c.amber[400], c.violet[400], c.red[400], c.teal[400], c.pink[400], c.gray[400]],
  textColor: c.gray[100],
  subTextColor: c.gray[400],
  axisLineColor: c.gray[600],
  axisLabelColor: c.gray[400],
  splitLineColor: c.gray[700],
  fontFamily: 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
  fontSize: 12,
  legend: { textColor: c.gray[300], inactiveColor: c.gray[600] },
  tooltip: {
    background: 'rgba(17,24,39,0.94)',
    borderColor: c.gray[700],
    textColor: c.gray[100],
    shadowColor: 'rgba(0,0,0,0.5)',
    fontSize: 12,
    padding: 10,
    radius: 6,
  },
  crosshair: { lineColor: c.gray[500], labelBackground: c.gray[100], labelColor: c.gray[900] },
  brush: { fill: 'rgba(96,165,250,0.18)', stroke: 'rgba(96,165,250,0.85)' },
  selection: { stroke: c.blue[400], dimOpacity: 0.3 },
};

/** 解析主题：'light' / 'dark' / 'auto' / 自定义片段（与亮色主题深合并）。 */
export function resolveChartTheme(theme: ChartTheme | 'light' | 'dark' | 'auto' | Partial<ChartTheme> | undefined): ChartTheme {
  const base = theme === 'dark' ? DARK_CHART_THEME : LIGHT_CHART_THEME;
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
