import { diagnoseExpression, errorsOf, warningsOf } from '../../src/expr/diagnostics';

/**
 * 表达式诊断：回答「用户有没有胡乱输入公式」。
 *
 * 覆盖三层：语法 → 静态（变量 / 参数）→ 运行（整段画不出来 / 输出恒定）。
 */

const codes = (list: ReturnType<typeof diagnoseExpression>): string[] => list.map((d) => d.code).sort();

describe('表达式诊断', () => {
  it('正常表达式没有任何诊断', () => {
    expect(diagnoseExpression('sin(x)/x', { variable: 'x' })).toEqual([]);
    expect(
      diagnoseExpression('a*sin(x)+b', { variable: 'x', params: { a: 1, b: 2 }, values: [0, 1, 2] })
    ).toEqual([]);
  });

  it('语法错误：报出位置，且分类为 syntax', () => {
    const list = diagnoseExpression('sin(x', { variable: 'x' });
    expect(list).toHaveLength(1);
    expect(list[0].severity).toBe('error');
    expect(list[0].code).toBe('syntax');
    expect(list[0].position).toBe(5);
    expect(list[0].message).toMatch(/缺少右括号/);
  });

  it('未知函数 / 参数个数不对 / 非法字符 分别有独立分类', () => {
    expect(codes(diagnoseExpression('foo(x)', { variable: 'x' }))).toEqual(['unknown-function']);
    expect(codes(diagnoseExpression('sin(1,2)', { variable: 'x' }))).toEqual(['arity']);
    expect(codes(diagnoseExpression('1 $ 2', { variable: 'x' }))).toEqual(['unknown-character']);
  });

  it('空表达式：给一句「该怎么写」的提示', () => {
    const list = diagnoseExpression('   ', { variable: 't' });
    expect(list[0].code).toBe('empty');
    expect(list[0].message).toMatch(/sin\(3\*t\)/);
  });

  it('未定义的变量：这是最常犯的错，以前是静默画不出来', () => {
    const list = diagnoseExpression('b*sin(x)', { variable: 'x', params: { a: 1 } });
    const unknown = list.filter((d) => d.code === 'unknown-variable');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].severity).toBe('error');
    expect(unknown[0].message).toContain('b');
    // 提示里要给出可用变量，用户才知道该写什么
    expect(unknown[0].message).toContain('x');
    expect(unknown[0].message).toContain('a');
    expect(unknown[0].message).toContain('series.params');
  });

  it('参数定义了却没用到：警告（不阻断绘制）', () => {
    const list = diagnoseExpression('sin(x)', { variable: 'x', params: { a: 1 } });
    expect(codes(list)).toEqual(['unused-parameter']);
    expect(warningsOf(list)).toHaveLength(1);
    expect(errorsOf(list)).toHaveLength(0);
  });

  it('参数曲线的两条表达式按并集判断「参数没用上」', () => {
    // a 只用在后一条表达式里，前一条不该报「参数 a 没用到」
    const xList = diagnoseExpression('sin(t)', { variable: 't', params: { a: 2 }, additionalVariables: ['a'] });
    expect(codes(xList)).toEqual([]);
    const yList = diagnoseExpression('a*cos(t)', { variable: 't', params: { a: 2 }, additionalVariables: [] });
    expect(codes(yList)).toEqual([]);
  });

  it('运行层：区间内没有任何有限值', () => {
    const list = diagnoseExpression('sqrt(-x)', { variable: 'x', values: [NaN, NaN, NaN] });
    expect(codes(list)).toEqual(['no-finite-values']);
    expect(list[0].message).toMatch(/负数开方|分母/);
  });

  it('运行层：输出恒定（水平线，多半不是本意）', () => {
    const list = diagnoseExpression('sin(0)', { variable: 'x', values: [0, 0, 0, 0] });
    expect(codes(list)).toEqual(['constant-value']);
    expect(list[0].severity).toBe('warning');
  });

  it('运行层：部分有值就不报错（断点/极点是正常现象）', () => {
    const list = diagnoseExpression('1/x', { variable: 'x', values: [1, NaN, -1, Infinity] });
    expect(list).toEqual([]);
  });

  it('多个问题一起报（变量名错 + 参数没用上）', () => {
    const list = diagnoseExpression('b*x', { variable: 'x', params: { a: 1 } });
    expect(codes(list)).toEqual(['unknown-variable', 'unused-parameter']);
    expect(errorsOf(list)).toHaveLength(1);
    expect(warningsOf(list)).toHaveLength(1);
  });
});
