import { compileExpression, compileSampler, evaluateExpression, ExpressionError } from '../../src/expr/expr';

describe('数学表达式引擎', () => {
  it('四则运算与优先级', () => {
    expect(evaluateExpression('1+2*3')).toBe(7);
    expect(evaluateExpression('(1+2)*3')).toBe(9);
    expect(evaluateExpression('10/4')).toBe(2.5);
    expect(evaluateExpression('10%3')).toBe(1);
  });

  it('幂是右结合，且比一元负号优先级高（与 MATLAB 一致）', () => {
    expect(evaluateExpression('2^3^2')).toBe(512);
    expect(evaluateExpression('-2^2')).toBe(-4);
    expect(evaluateExpression('2^-1')).toBe(0.5);
  });

  it('内置常量与函数', () => {
    expect(evaluateExpression('sin(pi/2)')).toBeCloseTo(1, 12);
    expect(evaluateExpression('cos(0)')).toBe(1);
    expect(evaluateExpression('log(e)')).toBeCloseTo(1, 12);
    expect(evaluateExpression('log10(1000)')).toBeCloseTo(3, 12);
    expect(evaluateExpression('sqrt(16)')).toBe(4);
    expect(evaluateExpression('hypot(3,4)')).toBe(5);
    expect(evaluateExpression('max(3,7)')).toBe(7);
    expect(evaluateExpression('clamp(5,0,1)')).toBe(1);
    expect(evaluateExpression('atan2(1,1)')).toBeCloseTo(Math.PI / 4, 12);
  });

  it('隐式乘法：2x / 3sin(x) / 2(x+1) / 2pi', () => {
    expect(evaluateExpression('2x', { x: 3 })).toBe(6);
    expect(evaluateExpression('3sin(x)', { x: Math.PI / 2 })).toBeCloseTo(3, 12);
    expect(evaluateExpression('2(x+1)', { x: 1 })).toBe(4);
    expect(evaluateExpression('2pi')).toBeCloseTo(Math.PI * 2, 12);
    // 变量紧跟变量不当成乘法（那是笔误，要报错，不能静默相乘）
    expect(() => evaluateExpression('x y', { x: 2, y: 3 })).toThrow(/多余的内容/);
  });

  it('变量来自 scope，缺失的变量算 NaN（曲线断开，而不是静默当 0）', () => {
    expect(evaluateExpression('a*x+b', { a: 2, x: 3, b: 1 })).toBe(7);
    expect(Number.isNaN(evaluateExpression('a*x', { x: 1 }))).toBe(true);
  });

  it('编译结果带缓存（参数扫动时每帧要复用同一份编译产物）', () => {
    expect(compileExpression('sin(x)+a')).toBe(compileExpression('sin(x)+a'));
    expect(compileExpression('sin(x)+a').variables.sort()).toEqual(['a', 'x']);
  });

  it('采样器复用 scope：参数变了直接 setParams，不重新编译', () => {
    const sampler = compileSampler('a*sin(x)', { a: 2 });
    expect(sampler.evaluate('x', Math.PI / 2)).toBeCloseTo(2, 12);
    sampler.setParams({ a: 5 });
    expect(sampler.evaluate('x', Math.PI / 2)).toBeCloseTo(5, 12);
    expect(sampler.evaluate('x', 0)).toBe(0);
  });

  it('语法错误报出位置（可读的报错，而不是静默 NaN）', () => {
    expect(() => compileExpression('sin(x')).toThrow(ExpressionError);
    expect(() => compileExpression('2 +')).toThrow(/表达式意外结束/);
    expect(() => compileExpression('foo(1)')).toThrow(/未知函数/);
    expect(() => compileExpression('sin(1,2)')).toThrow(/需要 1 个参数/);
    expect(() => compileExpression('1 $ 2')).toThrow(/无法识别的字符/);
    expect(() => compileExpression('')).toThrow(/表达式是空的/);
  });

  it('报错信息里带原文与位置指针', () => {
    try {
      compileExpression('sin(x');
      throw new Error('应当抛错');
    } catch (err: any) {
      expect(err.message).toContain('sin(x');
      expect(err.message).toContain('位置');
    }
  });
});
