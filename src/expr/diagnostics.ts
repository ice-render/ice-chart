import { compileExpression, ExpressionError, type ExpressionErrorCode } from './expr';

/**
 * 表达式诊断：回答「用户是不是胡乱输入了公式」这个问题。
 *
 * 编译错误只是第一层。真实场景里更常见、也更难自己发现的是**能编译但画不出来**：
 * `b*x`（b 没定义）、`sqrt(-x)`（整段都是 NaN）、`sin(0)`（画出来是一条常数线
 * ——不一定是错，但通常不是本意）。这些以前都是静默的，用户只看到「一片空白」。
 *
 * 这里把三层检查合成一份结构化结果，交给表单去标红 / 提示：
 * 1. **语法层**：编译失败（含位置），由 `ExpressionError.code` 分类；
 * 2. **静态层**：变量没定义（对比「自变量 + params」）、参数定义了却没用上；
 * 3. **运行层**：在当前区间内没有任何有限值、输出恒定。
 *
 * 纯函数、不依赖 DOM，因此可以被完整单测。
 */

export type ExpressionDiagnosticCode =
  | 'empty'
  | 'syntax'
  | 'unknown-character'
  | 'unknown-function'
  | 'arity'
  | 'unknown-variable'
  | 'unused-parameter'
  | 'no-finite-values'
  | 'constant-value';

export interface ExpressionDiagnostic {
  code: ExpressionDiagnosticCode;
  /** error = 画不出来；warning = 画出来了但多半不是本意。 */
  severity: 'error' | 'warning';
  /** 人类可读的说明（含「怎么改」）。 */
  message: string;
  /** 出错字符位置（仅语法类）。 */
  position?: number;
}

export interface DiagnoseExpressionOptions {
  /** 自变量名：`function` 图是 `x`，参数曲线是 `t`。 */
  variable: string;
  /** 表达式里可以引用的参数（来自 `series.params`）。 */
  params?: Record<string, number>;
  /**
   * 同一条系列里其它表达式用到的变量（参数曲线的 x(t) / y(t) 是两条表达式，
   * 参数只要被任意一条用到就不该报「没用上」）。
   */
  additionalVariables?: string[];
  /**
   * 当前区间内的采样值（用于运行层检查）。
   * 不传就只做静态检查；传了才有「整段画不出来 / 输出恒定」这两条。
   */
  values?: number[];
}

/** 语法错误码 → 诊断码（一一对应，保留这个映射是为了 API 稳定）。 */
function mapErrorCode(code: ExpressionErrorCode): ExpressionDiagnosticCode {
  return code;
}

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
}

export function diagnoseExpression(source: string, options: DiagnoseExpressionOptions): ExpressionDiagnostic[] {
  const text = String(source === undefined || source === null ? '' : source);
  const params = options.params || {};
  const out: ExpressionDiagnostic[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    out.push({
      code: 'empty',
      severity: 'error',
      message: `表达式是空的：请填写 ${options.variable} 的公式，例如 ${options.variable === 't' ? 'sin(3*t)' : 'sin(x)/x'}`,
    });
    return out;
  }

  let variables: string[] = [];
  try {
    variables = compileExpression(text).variables;
  } catch (err) {
    if (err instanceof ExpressionError) {
      out.push({
        code: mapErrorCode(err.code),
        severity: 'error',
        message: err.message,
        position: err.position,
      });
      return out;
    }
    out.push({ code: 'syntax', severity: 'error', message: String(err && (err as Error).message ? (err as Error).message : err) });
    return out;
  }

  // 静态层：变量必须来自「自变量 + params」
  const available = [options.variable, ...Object.keys(params)];
  const unknown = variables.filter((name) => name !== options.variable && !(name in params));
  for (const name of unknown) {
    out.push({
      code: 'unknown-variable',
      severity: 'error',
      message: `未定义的变量「${name}」：可用的是 ${available.join('、')}。想当参数用请写进 series.params（会自动进 JSON 快照）。`,
    });
  }
  const used = new Set([...variables, ...(options.additionalVariables || [])]);
  const unused = Object.keys(params).filter((name) => !used.has(name));
  for (const name of unused) {
    out.push({
      code: 'unused-parameter',
      severity: 'warning',
      message: `参数「${name}」定义了但表达式没有用到，改公式或去掉它。`,
    });
  }

  // 运行层：有没有画得出来的值
  // 只有在静态层没问题时才做 —— 否则「b 没定义」会连带报一条「整段画不出来」，
  // 用户看到的是症状而不是根因（级联噪音）。
  const values = options.values;
  if (values && values.length && !out.some((item) => item.severity === 'error')) {
    const finite = values.filter((v) => typeof v === 'number' && isFinite(v));
    if (!finite.length) {
      out.push({
        code: 'no-finite-values',
        severity: 'error',
        message: '在当前区间内没有任何可绘制的值：检查是否对负数开方、对 0 取对数，或者分母整段为 0。',
      });
    } else {
      const sorted = finite.slice().sort((a, b) => a - b);
      const lo = quantile(sorted, 0.02);
      const hi = quantile(sorted, 0.98);
      if (Math.abs(hi - lo) < 1e-12) {
        out.push({
          code: 'constant-value',
          severity: 'warning',
          message: `输出恒为 ${Number(hi.toPrecision(6))}：函数与自变量无关（或恰好取到常数），画出来是一条水平线。`,
        });
      }
    }
  }

  return out;
}

/** 只取错误（表单标红用）。 */
export function errorsOf(diagnostics: ExpressionDiagnostic[]): ExpressionDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'error');
}

/** 只取警告（表单提示用）。 */
export function warningsOf(diagnostics: ExpressionDiagnostic[]): ExpressionDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'warning');
}
