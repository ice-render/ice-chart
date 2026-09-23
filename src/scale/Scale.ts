import { LinearScale } from './LinearScale';
import { BandScale } from './BandScale';
import { TimeScale } from './TimeScale';
import { LogScale } from './LogScale';
import type { ScaleType } from '../types';

/**
 * 比例尺：数据域 ↔ 像素域的唯一换算入口。
 *
 * 与 d3-scale 的取舍：只保留图表真正需要的部分（band / linear / time / log），
 * 不引入运行时依赖。`fractionOf / valueAtFraction` 是**跨图联动**的基础：
 * 不同图表尺寸不同，但同一个数值对应的 0~1 比例是稳定的。
 */
export interface Scale {
  readonly type: ScaleType;
  domain: any[];
  range: [number, number];
  map(value: any): number;
  invert(pixel: number): any;
  ticks(count?: number): any[];
  bandwidth(): number;
  /** 类目轴上单个类目带的起点；非类目轴返回 map(value)。 */
  bandStart(value: any, index?: number): number;
  step(): number;
  isBand(): boolean;
  /** 像素落在哪个类目带内；-1 表示不在任何带内。非类目轴恒为 -1。 */
  indexAt(pixel: number): number;
  fractionOf(value: any): number;
  valueAtFraction(fraction: number): any;
  /** 数据域跨度（类目轴为类目数，数值轴为 max-min）。 */
  span(): number;
  /** 轴标签的默认格式化。 */
  format(value: any, index: number): string;
  clone(): Scale;
}

export interface CreateScaleOptions {
  paddingInner?: number;
  paddingOuter?: number;
  logBase?: number;
  /** 时间刻度的期望数量。 */
  tickCount?: number;
  /**
   * 类目轴的**现成查表口**：`类目 key → 下标`。给了它 `BandScale` 就不自建索引表。
   *
   * 由归一化在「域原样来自增量维护的类目表」时给出（见 `InternalAxis.categoryLookup`）。
   */
  categoryLookup?: (key: string) => number;
}

export function createScale(
  type: ScaleType,
  domain: any[],
  range: [number, number],
  options: CreateScaleOptions = {}
): Scale {
  switch (type) {
    case 'category':
      return new BandScale(domain, range, options);
    case 'time':
      return new TimeScale(domain as [number, number], range, options);
    case 'log':
      return new LogScale(domain as [number, number], range, options);
    case 'linear':
    default:
      return new LinearScale(domain as [number, number], range);
  }
}
