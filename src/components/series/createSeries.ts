import type { InternalSeries } from '../../internal';
import { BarSeries } from './BarSeries';
import { AreaSeries } from './AreaSeries';
import { LineSeries } from './LineSeries';
import { ScatterSeries } from './ScatterSeries';
import { PieSeries } from './PieSeries';
import { RadarSeries } from './RadarSeries';
import { CandlestickSeries } from './CandlestickSeries';
import { HeatmapSeries } from './HeatmapSeries';
import { SankeySeries } from './SankeySeries';
import { FunnelSeries } from './FunnelSeries';
import { GaugeSeries } from './GaugeSeries';
import { BoxplotSeries } from './BoxplotSeries';
import { WaterfallSeries } from './WaterfallSeries';
import { TreemapSeries } from './TreemapSeries';
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
    case 'candlestick':
      return new CandlestickSeries(series, props);
    case 'heatmap':
      return new HeatmapSeries(series, props);
    case 'sankey':
      return new SankeySeries(series, props);
    case 'funnel':
      return new FunnelSeries(series, props);
    case 'gauge':
      return new GaugeSeries(series, props);
    case 'boxplot':
      return new BoxplotSeries(series, props);
    case 'waterfall':
      return new WaterfallSeries(series, props);
    case 'treemap':
      return new TreemapSeries(series, props);
    case 'line':
    default:
      return new LineSeries(series, props);
  }
}
