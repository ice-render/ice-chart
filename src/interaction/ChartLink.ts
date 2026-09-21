import type { BrushRange, ChartLinkOption, DataPointParams, ZoomRange } from '../types';
import type { ICEChart } from '../ICEChart';

export interface ChartLinkHandle {
  charts: ICEChart[];
  unlink(): void;
}

/**
 * 多图联动：一组图表共享「悬停列 / 缩放窗口 / 刷选范围」。
 *
 * 实现刻意只用**公开的语义事件**（item:hover / zoom:change / pan:change / brush:end），
 * 因此：
 * - 任何抛出这些事件的图表都能加入联动，不依赖内部实现细节；
 * - 联动是应用层可组合的能力，不需要全局单例；
 * - 按 x 数据值（而不是像素）联动，不同尺寸 / 不同数据范围的图表也能对齐。
 */
export function linkCharts(charts: ICEChart[], option: ChartLinkOption = {}): ChartLinkHandle {
  const axis = option.axis || 'x';
  const linkHover = option.hover !== false;
  const linkZoom = option.zoom !== false;
  const linkBrush = option.brush !== false;
  const listeners: Array<() => void> = [];
  /**
   * 最近一次**由真实指针**触发悬停的图表，也就是这轮联动回显的源头。
   *
   * 为什么必须记：联动是把悬停**回显**给同组其它图表，那些图本身并没有指针悬停。
   * 而一次 mousemove 会依次到达组内每一张图，没接住指针的图会判定「指针已离开画布」
   * 而清掉悬停并抛 `item:leave`。如果照单全收，这回「回显之死」就会顺着联动把源头
   * 那张图真正的悬停一起清掉 —— 表现是鼠标在 K 线上移动时**竖线一闪就没了**
   * （多 pane K 线图实测：价格 pane 的 `controller.hover` 恒为 null；只要 unlink 就正常）。
   *
   * 所以只认源头图自己发的 `item:leave`：回显死掉不算离开。
   */
  let origin: ICEChart | null = null;

  for (const chart of charts) {
    const onHover = (params: DataPointParams) => {
      if (!linkHover || !params) return;
      origin = chart;
      for (const other of charts) {
        // silent：联动的回显不能再往外广播，否则 A→B→A 会无限递归
        if (other !== chart) other.silent(() => other.showHoverAtValue(params.xValue));
      }
    };
    const onLeave = () => {
      if (!linkHover) return;
      // 不是源头发的 leave（只是上一轮回显被清掉）→ 不能反过来清掉源头
      if (origin !== chart) return;
      origin = null;
      for (const other of charts) {
        if (other !== chart) other.silent(() => other.clearHover());
      }
    };
    const onZoom = (range: ZoomRange | BrushRange) => {
      if (linkZoom && range) applyRange(charts, chart, range, axis);
    };
    const onPan = (range: ZoomRange) => {
      if (linkZoom && range) applyRange(charts, chart, range, axis);
    };
    const onBrush = (range: BrushRange | null) => {
      if (linkBrush && range) applyRange(charts, chart, range, axis);
    };
    chart.on('item:hover', onHover);
    chart.on('item:leave', onLeave);
    chart.on('zoom:change', onZoom);
    chart.on('pan:change', onPan);
    chart.on('brush:end', onBrush);
    listeners.push(() => {
      chart.off('item:hover', onHover);
      chart.off('item:leave', onLeave);
      chart.off('zoom:change', onZoom);
      chart.off('pan:change', onPan);
      chart.off('brush:end', onBrush);
    });
  }

  return {
    charts,
    unlink() {
      for (const off of listeners) off();
      listeners.length = 0;
    },
  };
}

function applyRange(
  charts: ICEChart[],
  source: ICEChart,
  range: ZoomRange | BrushRange,
  axis: 'x' | 'y' | 'xy'
): void {
  if ((axis === 'x' || axis === 'xy') && range.x) {
    for (const other of charts) {
      if (other !== source) other.silent(() => other.setDomain('x', range.x as any[], 'link'));
    }
  }
  if ((axis === 'y' || axis === 'xy') && range.y) {
    for (const other of charts) {
      if (other !== source) other.silent(() => other.setDomain('y', range.y as any[], 'link'));
    }
  }
}
