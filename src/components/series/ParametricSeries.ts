import { CurveSeriesBase } from './CurveSeriesBase';
import { compileSampler, type CompiledSampler } from '../../expr/expr';
import { sampleParametricCurve } from '../../expr/sample';
import type { SeriesType } from '../../types';
import type { Rect } from '../../internal';

/**
 * 参数曲线：`x = x(t), y = y(t)`。
 *
 * 李萨如曲线 `(sin(3t), cos(2t))`、螺线 `(t*cos(t), t*sin(t))`、心形线这类
 * 「不是函数图像」的曲线都靠它。x 不单调，因此二分查找与「按 x 取最近点」都不适用，
 * 命中一律走「离指针最近的锚点」。
 *
 * **极坐标简写**：写 `polarExpression: '1 + cos(3*t)'` 就是 `r = r(θ)`，
 * 组件内部按 `x = r·cosθ, y = r·sinθ` 展开成同一条参数曲线 ——
 * 玫瑰线 / 心形线 / 螺线这些经典极坐标图直接可用（配合 `aspect: 'equal'` 与 `polarGrid`）。
 *
 * y 轴数据域由 t 区间内的采样值决定；x 轴同理 —— 缩放会改变可视窗口，
 * 但曲线本身固定（参数区间不变），这与函数绘图不同，符合直觉。
 */
export class ParametricSeries extends CurveSeriesBase {
  public seriesType: SeriesType = 'parametric';

  private cachedSources = '';
  private samplerX: CompiledSampler | null = null;
  private samplerY: CompiledSampler | null = null;
  private samplerR: CompiledSampler | null = null;

  constructor(...args: ConstructorParameters<typeof CurveSeriesBase>) {
    super(...args);
    this.monotonicX = false;
  }

  private samplersFor(params: Record<string, number>): { x: (t: number) => number; y: (t: number) => number } {
    const option: any = this.series.option;
    // 极坐标简写：r(θ) 展开成 (r·cosθ, r·sinθ)，与参数曲线共用全部采样/命中/缓存逻辑
    const polarSource = option.polarExpression === undefined || option.polarExpression === null ? '' : String(option.polarExpression);
    if (polarSource) {
      const signature = `polar\u0000${polarSource}\u0000${Object.keys(params).sort().join(',')}`;
      if (signature !== this.cachedSources || !this.samplerR) {
        this.cachedSources = signature;
        try {
          this.samplerR = compileSampler(polarSource);
        } catch (err) {
          this.samplerR = { setParams: () => undefined, evaluate: () => NaN };
        }
      }
      const samplerR = this.samplerR;
      samplerR.setParams(params);
      return {
        x: (t: number) => samplerR.evaluate('t', t) * Math.cos(t),
        y: (t: number) => samplerR.evaluate('t', t) * Math.sin(t),
      };
    }
    const sourceX = String(option.xExpression || '');
    const sourceY = String(option.yExpression || '');
    const signature = `${sourceX}\u0000${sourceY}\u0000${Object.keys(params).sort().join(',')}`;
    if (signature !== this.cachedSources || !this.samplerX || !this.samplerY) {
      this.cachedSources = signature;
      // 表达式是用户输入：编译失败不能把渲染打挂（错误由 chart.expressionErrors() 暴露）
      const fallback: CompiledSampler = { setParams: () => undefined, evaluate: () => NaN };
      try {
        this.samplerX = compileSampler(sourceX);
      } catch (err) {
        this.samplerX = fallback;
      }
      try {
        this.samplerY = compileSampler(sourceY);
      } catch (err) {
        this.samplerY = fallback;
      }
    }
    const samplerX = this.samplerX;
    const samplerY = this.samplerY;
    samplerX.setParams(params);
    samplerY.setParams(params);
    return {
      x: (t: number) => samplerX.evaluate('t', t),
      y: (t: number) => samplerY.evaluate('t', t),
    };
  }

  protected evaluateAt(parameter: number, params: Record<string, number>): [number, number] {
    const { x, y } = this.samplersFor(params);
    return [x(parameter), y(parameter)];
  }

  protected parameterRange(_rect: Rect): [number, number] {
    const domain = this.series.option.domain;
    const from = domain ? Number(domain[0]) : 0;
    const to = domain ? Number(domain[1]) : Math.PI * 2;
    if (!isFinite(from) || !isFinite(to) || to === from) return [0, Math.PI * 2];
    return [from, to];
  }

  protected baseSampleCount(): number {
    const samples = Number(this.series.option.samples);
    return Math.max(24, Math.min(6000, isFinite(samples) && samples > 0 ? samples : 360));
  }

  protected sampleCurve(params: Record<string, number>, rect: Rect): Array<[number, number]> {
    const { x, y } = this.samplersFor(params);
    const [from, to] = this.parameterRange(rect);
    return sampleParametricCurve(x, y, from, to, {
      base: this.baseSampleCount(),
      adaptive: this.series.option.adaptive !== false,
      tolerance: this.series.option.samplingTolerance,
    });
  }
}
