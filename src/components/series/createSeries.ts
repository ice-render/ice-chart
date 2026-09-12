import type { InternalSeries } from '../../internal';
import { BarSeries } from './BarSeries';
import { AreaSeries } from './AreaSeries';
import { LineSeries } from './LineSeries';
import { ScatterSeries } from './ScatterSeries';
import { PieSeries } from './PieSeries';
import { RadarSeries } from './RadarSeries';
import { SeriesBase } from './SeriesBase';

/** 按系列类型创建对应的渲染组件（工厂，便于后续扩展 candlestick / pie 等）。 */
export function createSeriesComponent(
  series: InternalSeries,
  props: { left: number; top: number; width: number; height: number; zIndex?: number }
): SeriesBase {
  switch (series.type) {
    case 'bar':
      return new BarSeries(series, props);
    case 'area':
      return new AreaSeries(series, props);
    case 'scatter':
      return new ScatterSeries(series, props);
    case 'pie':
      return new PieSeries(series, props);
    case 'radar':
      return new RadarSeries(series, props);
    case 'line':
    default:
      return new LineSeries(series, props);
  }
}
