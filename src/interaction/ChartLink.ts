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

  for (const chart of charts) {
    const onHover = (params: DataPointParams) => {
      if (!linkHover || !params) return;
      for (const other of charts) {
        // silent：联动的回显不能再往外广播，否则 A→B→A 会无限递归
        if (other !== chart) other.silent(() => other.showHoverAtValue(params.xValue));
      }
    };
    const onLeave = () => {
      if (!linkHover) return;
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
