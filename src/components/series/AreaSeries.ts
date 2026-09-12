import { LineSeries } from './LineSeries';
import type { SeriesType } from '../../types';
import type { InternalSeries } from '../../internal';

/** 面积图：折线 + 到基线的填充（堆叠时基线为前序堆叠值）。 */
export class AreaSeries extends LineSeries {
  public seriesType: SeriesType = 'area';

  constructor(series: InternalSeries, props: { left: number; top: number; width: number; height: number; zIndex?: number }) {
    super(series, props);
    this.fillArea = true;
  }
}
