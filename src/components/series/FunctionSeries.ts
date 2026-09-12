import { CurveSeriesBase } from './CurveSeriesBase';
import { compileSampler, type CompiledSampler } from '../../expr/expr';
import { sampleFunctionCurve } from '../../expr/sample';
import type { SeriesType } from '../../types';
import type { Rect } from '../../internal';

/**
 * 函数绘图：`y = f(x)`（迷你 MATLAB 的主力图类型）。
 *
 * - x 轴范围来自 `series.option.domain`（默认 [-10, 10]），缩放后按**可视区间**重新采样；
 * - y 轴数据域由**可视区间内的采样值**决定（自适应 + 稳健分位数），
 *   所以放大到某个局部时 y 轴会自动贴到那条曲线附近（像 fplot 一样）；
 * - 表达式见 `src/expr/expr.ts`：`sin(x)/x`、`x^2*exp(-x)`、`2x+1`、`sin(a*x)` 都行。
 */
export class FunctionSeries extends CurveSeriesBase {
  public seriesType: SeriesType = 'function';

  /** 表达式编译结果按「表达式 + 参数集合」缓存，参数扫动时不会每帧重新解析。 */
  private cachedSource = '';
  private sampler: CompiledSampler | null = null;

  private samplerFor(params: Record<string, number>): (x: number) => number {
    const source = String(this.series.option.expression || '');
    if (source !== this.cachedSource || !this.sampler) {
      this.cachedSource = source;
      // 表达式是用户输入：编译失败不能把渲染打挂（错误由 chart.expressionErrors() 暴露）
      try {
        this.sampler = compileSampler(source);
      } catch (err) {
        this.sampler = { setParams: () => undefined, evaluate: () => NaN };
      }
    }
    const sampler = this.sampler;
    sampler.setParams(params);
    return (x: number) => sampler.evaluate('x', x);
  }

  protected evaluateAt(parameter: number, params: Record<string, number>): [number, number] {
    const fn = this.samplerFor(params);
    return [parameter, fn(parameter)];
  }

  protected parameterRange(rect: Rect): [number, number] {
    const coord: any = this.coord;
    const domain = coord && coord.xScale && coord.xScale.domain;
    if (domain && domain.length >= 2) {
      const from = Number(domain[0]);
      const to = Number(domain[domain.length - 1]);
      if (isFinite(from) && isFinite(to) && to > from) return [from, to];
    }
    const option = this.series.option.domain;
    const fallbackFrom = option ? Number(option[0]) : -10;
    const fallbackTo = option ? Number(option[1]) : 10;
    void rect;
    return [fallbackFrom, fallbackTo];
  }

  protected baseSampleCount(): number {
    const samples = Number(this.series.option.samples);
    return Math.max(24, Math.min(4000, isFinite(samples) && samples > 0 ? samples : 240));
  }

  protected sampleCurve(params: Record<string, number>, rect: Rect): Array<[number, number]> {
    const fn = this.samplerFor(params);
    const [from, to] = this.parameterRange(rect);
    return sampleFunctionCurve(fn, from, to, {
      base: this.baseSampleCount(),
      adaptive: this.series.option.adaptive !== false,
      tolerance: this.series.option.samplingTolerance,
    });
  }
}
