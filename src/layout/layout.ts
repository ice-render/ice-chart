import type {
  AxisLayout,
  ChartLayout,
  LegendItemLayout,
  LegendLayout,
  NormalizedOption,
  Rect,
  TitleLayout,
} from '../internal';
import { createScale, formatTick } from '../scale';
import { measureTextWidth } from '../util/text';

const TICK_LENGTH = 4;
const LABEL_GAP = 6;
const AXIS_NAME_GAP = 6;
const LEGEND_GAP = 8;

/**
 * 计算图表布局（标题 / 图例 / 绘图区 / 坐标轴）。
 *
 * 顺序：先用「临时比例尺」拿刻度值（刻度只取决于数据域，与像素范围无关），
 * 量出坐标轴占用的空间；再排标题与图例；最后推出绘图区矩形。
 * 真正的比例尺由 Chart 拿到 plot rect 之后创建，保证刻度与布局严格一致。
 */
export function computeLayout(norm: NormalizedOption, ctx: any, canvas: Rect): ChartLayout {
  const theme = norm.theme;
  const margin = norm.option.margin;

  const xScale = createScale(norm.xAxis.type, norm.xAxis.domain, [0, Math.max(1, canvas.width)], {
    logBase: norm.xAxis.option.logBase,
  });
  const xAxisLayout = buildAxisLayout(norm, 'x', norm.xAxis, xScale, ctx);
  // 每个 y 轴各量一次刻度：多轴时刻度数量与标签宽度互不影响
  const yAxisLayouts: AxisLayout[] = norm.yAxes.map((axis) => {
    const scale = createScale(axis.type, axis.domain, [Math.max(1, canvas.height), 0], {
      logBase: axis.option.logBase,
    });
    return buildAxisLayout(norm, 'y', axis, scale, ctx);
  });
  // 同侧的多个轴逐层外移；offset 是相对绘图区边缘的距离
  let leftOffset = 0;
  let rightOffset = 0;
  for (let i = 0; i < norm.yAxes.length; i++) {
    const axis = norm.yAxes[i];
    const layout = yAxisLayouts[i];
    if (axis.option.show === false) {
      layout.offset = 0;
      continue;
    }
    const width = yAxisReserve(axis, layout);
    if (axis.position === 'right') {
      layout.offset = rightOffset;
      rightOffset += width;
    } else {
      layout.offset = leftOffset;
      leftOffset += width;
    }
  }
  const yAxisLayout = yAxisLayouts[0];

  const title = buildTitleLayout(norm);
  const titleHeight = title ? (title.text ? title.textStyle.fontSize * 1.5 : 0) + (title.subtext ? title.subtextStyle.fontSize * 1.4 : 0) : 0;
  // 标题在上、图例在其下方；图例排版需要知道标题占用的高度
  const legend = layoutLegend(norm, ctx, canvas, margin.top + titleHeight);
  const legendSize = legend ? legendSizeOf(legend, norm) : { width: 0, height: 0 };

  let left = margin.left;
  let top = margin.top;
  let right = canvas.width - margin.right;
  let bottom = canvas.height - margin.bottom;

  top += titleHeight;
  if (legend) {
    if (legend.position === 'top') top += legendSize.height + LEGEND_GAP;
    else if (legend.position === 'bottom') bottom -= legendSize.height + LEGEND_GAP;
    else if (legend.position === 'left') left += legendSize.width + LEGEND_GAP;
    else right -= legendSize.width + LEGEND_GAP;
  }

  const showX = norm.xAxis.option.show !== false;
  left += leftOffset;
  right -= rightOffset;
  if (showX) {
    bottom -= xAxisLayout.labelHeight + TICK_LENGTH + LABEL_GAP;
    if (norm.xAxis.option.name) bottom -= xAxisLayout.nameHeight + AXIS_NAME_GAP;
  }

  const plot: Rect = {
    x: Math.round(Math.max(0, left)),
    y: Math.round(Math.max(0, top)),
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top)),
  };

  if (title) {
    title.y = margin.top;
  }

  return {
    canvas,
    plot,
    titleRect: title ? { x: title.x, y: title.y, width: 0, height: titleHeight } : null,
    legendRect: legend ? legendBoundingRect(legend) : null,
    legend,
    title,
    xAxisLayout,
    yAxes: yAxisLayouts,
    yAxisLayout,
    margin,
  };
}

/** 单个 y 轴占用的横向空间。 */
function yAxisReserve(axis: { option: { name?: string } }, layout: AxisLayout): number {
  let width = layout.labelWidth + TICK_LENGTH + LABEL_GAP;
  if (axis.option.name) width += layout.nameHeight + AXIS_NAME_GAP;
  return width;
}

function buildAxisLayout(
  norm: NormalizedOption,
  axis: 'x' | 'y',
  internal: { option: any },
  scale: any,
  ctx: any
): AxisLayout {
  const axisOption = internal.option;
  const fontSize = norm.theme.fontSize;
  const fontFamily = norm.theme.fontFamily;
  if (axisOption.show === false) {
    return { ticks: [], labels: [], offset: 0, labelWidth: 0, labelHeight: 0, nameWidth: 0, nameHeight: 0 };
  }
  const ticks = scale.ticks(axisOption.tickCount || 5);
  const labels: string[] = [];
  let maxLabelWidth = 0;
  for (let i = 0; i < ticks.length; i++) {
    const label = formatTick(ticks[i], scale, i, axisOption.formatter);
    labels.push(label);
    const w = measureTextWidth(ctx, label, fontSize, fontFamily);
    if (w > maxLabelWidth) maxLabelWidth = w;
  }
  const rotate = Math.abs(Number(axisOption.labelRotate) || 0);
  const radians = (rotate * Math.PI) / 180;
  const rotatedHeight = maxLabelWidth * Math.sin(radians) + fontSize * 1.4;
  const name = axisOption.name || '';
  const nameWidth = name ? measureTextWidth(ctx, name, fontSize, fontFamily) : 0;
  return {
    ticks,
    labels,
    offset: 0,
    labelWidth: axis === 'y' ? maxLabelWidth : 0,
    labelHeight: axis === 'x' ? (rotate > 0 ? rotatedHeight : fontSize * 1.4) : 0,
    nameWidth: axis === 'x' ? nameWidth : 0,
    nameHeight: name ? fontSize * 1.4 : 0,
  };
}

function buildTitleLayout(norm: NormalizedOption): TitleLayout | null {
  const option = norm.option.title;
  if (!option || (!option.text && !option.subtext)) return null;
  const theme = norm.theme;
  const textStyle = {
    color: (option.textStyle && option.textStyle.color) || theme.textColor,
    fontSize: (option.textStyle && option.textStyle.fontSize) || theme.fontSize + 4,
    fontWeight: (option.textStyle && option.textStyle.fontWeight) || 'bold',
  };
  const subtextStyle = {
    color: (option.subtextStyle && option.subtextStyle.color) || theme.subTextColor,
    fontSize: (option.subtextStyle && option.subtextStyle.fontSize) || theme.fontSize,
  };
  const align = option.left === 'left' ? 'left' : option.left === 'right' ? 'right' : 'center';
  return { text: option.text || '', subtext: option.subtext || '', x: 0, y: 0, align, textStyle, subtextStyle };
}

/**
 * 图例排版：水平布局（top/bottom）按画布宽度折行，垂直布局（left/right）单列。
 * 这里只依赖画布尺寸，因此可以在绘图区确定之前完成，避免布局的循环依赖。
 */
function layoutLegend(norm: NormalizedOption, ctx: any, canvas: Rect, topOffset: number): LegendLayout | null {
  const option = norm.option.legend;
  if (!option || option.show === false) return null;
  const items: LegendItemLayout[] = norm.series.map((s) => ({
    seriesId: s.id,
    seriesIndex: s.index,
    name: s.name,
    color: s.color,
    hidden: !!s.hidden,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  }));
  if (!items.length) return null;
  const legend: LegendLayout = { position: option.position || 'top', items };
  const fontSize = norm.theme.fontSize;
  const itemWidth = option.itemWidth || 12;
  const itemHeight = Math.max(option.itemHeight || 12, fontSize * 1.4);
  const gap = option.itemGap || 16;
  const pieces = items.map((item) => ({ item, textWidth: measureTextWidth(ctx, item.name, fontSize, norm.theme.fontFamily) }));
  const rowHeight = itemHeight + 4;
  const margin = norm.option.margin;

  if (legend.position === 'left' || legend.position === 'right') {
    const maxText = Math.max(...pieces.map((p) => p.textWidth), 0);
    const totalHeight = pieces.length * rowHeight;
    const x = legend.position === 'left' ? margin.left : canvas.width - margin.right - (itemWidth + 6 + maxText);
    const available = Math.max(0, canvas.height - topOffset - margin.bottom);
    const startY = Math.max(topOffset, topOffset + (available - totalHeight) / 2);
    for (let i = 0; i < pieces.length; i++) {
      const it = pieces[i].item;
      it.x = x;
      it.y = startY + i * rowHeight;
      it.width = itemWidth + 6 + pieces[i].textWidth;
      it.height = rowHeight;
    }
    return legend;
  }

  const rows: Array<Array<{ item: LegendItemLayout; textWidth: number }>> = [];
  let row: Array<{ item: LegendItemLayout; textWidth: number }> = [];
  let rowWidth = 0;
  const maxWidth = Math.max(40, canvas.width - margin.left - margin.right);
  for (const p of pieces) {
    const w = itemWidth + 6 + p.textWidth;
    if (row.length && rowWidth + gap + w > maxWidth) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    rowWidth += (row.length > 1 ? gap : 0) + w;
    row.push(p);
  }
  if (row.length) rows.push(row);

  let y = legend.position === 'top' ? topOffset : canvas.height - margin.bottom - rows.length * rowHeight;
  for (const r of rows) {
    const total = r.reduce((sum, p, i) => sum + itemWidth + 6 + p.textWidth + (i > 0 ? gap : 0), 0);
    let x = (canvas.width - total) / 2;
    for (const p of r) {
      p.item.x = x;
      p.item.y = y;
      p.item.width = itemWidth + 6 + p.textWidth;
      p.item.height = rowHeight;
      x += p.item.width + gap;
    }
    y += rowHeight;
  }
  return legend;
}

/** 图例整体尺寸（按行/列累加，避免依赖已计算的包围盒）。 */
function legendSizeOf(legend: LegendLayout, norm: NormalizedOption): { width: number; height: number } {
  const option = norm.option.legend;
  const fontSize = norm.theme.fontSize;
  const itemWidth = option.itemWidth || 12;
  const itemHeight = Math.max(option.itemHeight || 12, fontSize * 1.4);
  const rowHeight = itemHeight + 4;
  if (legend.position === 'left' || legend.position === 'right') {
    const maxRight = Math.max(...legend.items.map((it) => it.x + it.width), 0);
    const minX = Math.min(...legend.items.map((it) => it.x), 0);
    return { width: Math.max(itemWidth + 6, maxRight - minX), height: legend.items.length * rowHeight };
  }
  let rows = 1;
  let lastY = legend.items.length ? legend.items[0].y : 0;
  for (const it of legend.items) {
    if (it.y > lastY) {
      rows += 1;
      lastY = it.y;
    }
  }
  return { width: 0, height: rows * rowHeight };
}

function legendBoundingRect(legend: LegendLayout): Rect {
  if (!legend.items.length) return { x: 0, y: 0, width: 0, height: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const it of legend.items) {
    x0 = Math.min(x0, it.x);
    y0 = Math.min(y0, it.y);
    x1 = Math.max(x1, it.x + it.width);
    y1 = Math.max(y1, it.y + it.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
