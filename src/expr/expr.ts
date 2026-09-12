/**
 * 数学表达式引擎（迷你 MATLAB 的核心）。
 *
 * 为什么不用 `eval` / `new Function`：表达式是**用户输入**，而且可能来自 URL / 存盘配置。
 * 这里用「词法 → 递归下降语法分析 → 编译成闭包」三步，既不依赖 eval（CSP 安全），
 * 也能在编译期把错误位置报出来（`sin(x` 会告诉你缺右括号、在第几个字符）。
 *
 * 支持：
 * - 运算符 `+ - * / % ^`（`^` 右结合），一元正负，括号；
 * - 常量 `pi / e / tau`；
 * - 函数：三角 / 反三角 / 双曲 / 指数对数 / 取整 / 绝对值 / min / max / pow / mod / hypot / clamp；
 * - 变量：调用方通过 scope 提供（`x`、`t`、以及用户自定义参数 `a`、`k`…）；
 * - **隐式乘法**：`2x`、`3sin(x)`、`2(x+1)`、`2pi`（MATLAB 习惯）。
 */

/** 编译失败的原因分类：调用方可以据此做不同的提示（不用解析错误文本）。 */
export type ExpressionErrorCode = 'empty' | 'syntax' | 'unknown-character' | 'unknown-function' | 'arity';

export class ExpressionError extends Error {
  public position: number;
  public code: ExpressionErrorCode;
  constructor(message: string, position: number, source: string, code: ExpressionErrorCode = 'syntax') {
    super(`[ice-chart] 表达式错误：${message}（位置 ${position}）\n  ${source}\n  ${' '.repeat(Math.max(0, position))}^`);
    this.name = 'ExpressionError';
    this.position = position;
    this.code = code;
  }
}

export interface CompiledExpression {
  /** 原始表达式。 */
  source: string;
  /** 表达式里出现的自由变量（不含常量与函数名），例如 ['x', 'a']。 */
  variables: string[];
  /** 求值；scope 里缺少的变量按 NaN 处理（曲线断开，而不是静默算成 0）。 */
  evaluate(scope?: Record<string, number>): number;
}

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'unary'; op: '-' | '+'; arg: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

interface Token {
  type: 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'end';
  value: string;
  position: number;
}

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  PI: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  TAU: Math.PI * 2,
  inf: Infinity,
  Infinity: Infinity,
  nan: NaN,
};

/** 内置函数：值为元数（1 或 2），参数个数不对直接报错（比算出 NaN 更容易排查）。 */
const FUNCTIONS: Record<string, number> = {
  sin: 1,
  cos: 1,
  tan: 1,
  asin: 1,
  acos: 1,
  atan: 1,
  atan2: 2,
  sinh: 1,
  cosh: 1,
  tanh: 1,
  asinh: 1,
  acosh: 1,
  atanh: 1,
  exp: 1,
  ln: 1,
  log: 1,
  log2: 1,
  log10: 1,
  sqrt: 1,
  cbrt: 1,
  abs: 1,
  sign: 1,
  floor: 1,
  ceil: 1,
  round: 1,
  trunc: 1,
  min: 2,
  max: 2,
  pow: 2,
  mod: 2,
  hypot: 2,
  clamp: 3,
};

const IMPL: Record<string, (...args: number[]) => number> = {
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  mod: (a, b) => a % b,
  hypot: Math.hypot,
  clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  cbrt: Math.cbrt,
  trunc: Math.trunc,
  sign: Math.sign,
};

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isDigit = (ch: string) => ch >= '0' && ch <= '9';
  const isIdentStart = (ch: string) => /[A-Za-z_]/.test(ch);
  const isIdentPart = (ch: string) => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] || ''))) {
      const start = i;
      while (i < source.length && (isDigit(source[i]) || source[i] === '.')) i++;
      if (source[i] === 'e' || source[i] === 'E') {
        const mark = i;
        i++;
        if (source[i] === '+' || source[i] === '-') i++;
        if (isDigit(source[i] || '')) {
          while (i < source.length && isDigit(source[i])) i++;
        } else {
          i = mark; // 不是科学计数法（比如 "2exp(x)"），回退
        }
      }
      tokens.push({ type: 'num', value: source.slice(start, i), position: start });
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i])) i++;
      tokens.push({ type: 'ident', value: source.slice(start, i), position: start });
      continue;
    }
    if ('+-*/%^'.indexOf(ch) >= 0) {
      tokens.push({ type: 'op', value: ch, position: i });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch, position: i });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch, position: i });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch, position: i });
      i++;
      continue;
    }
    throw new ExpressionError(`无法识别的字符「${ch}」`, i, source, 'unknown-character');
  }
  tokens.push({ type: 'end', value: '', position: source.length });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private index = 0;
  private source: string;
  private variables = new Set<string>();

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenize(source);
  }

  public parse(): Node {
    if (this.peek().type === 'end') throw new ExpressionError('表达式是空的', 0, this.source, 'empty');
    const node = this.parseSum();
    const token = this.peek();
    if (token.type !== 'end') throw new ExpressionError(`多余的内容「${token.value}」`, token.position, this.source);
    return node;
  }

  public getVariables(): string[] {
    return Array.from(this.variables);
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.index++];
  }

  private parseSum(): Node {
    let left = this.parseProduct();
    for (;;) {
      const token = this.peek();
      if (token.type === 'op' && (token.value === '+' || token.value === '-')) {
        this.next();
        left = { kind: 'binary', op: token.value, left, right: this.parseProduct() };
        continue;
      }
      return left;
    }
  }

  private parseProduct(): Node {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token.type === 'op' && '*/%'.indexOf(token.value) >= 0) {
        this.next();
        left = { kind: 'binary', op: token.value, left, right: this.parseUnary() };
        continue;
      }
      // 隐式乘法：`2x`、`3sin(x)`、`2(x+1)`、`2pi`
      if (this.startsAtom(token) && this.endsAtom(left)) {
        left = { kind: 'binary', op: '*', left, right: this.parseUnary() };
        continue;
      }
      return left;
    }
  }

  /** 隐式乘法的右操作数可以是数字、标识符、左括号（但不能是另一个数字紧跟着的情况，如 `2 3`）。 */
  private startsAtom(token: Token): boolean {
    return token.type === 'num' || token.type === 'ident' || token.type === 'lparen';
  }

  /** 只有「数字 / 常量」结尾才允许隐式乘法，避免把 `x y` 这种笔误静默算成乘积。 */
  private endsAtom(node: Node): boolean {
    if (node.kind === 'num') return true;
    if (node.kind === 'var') return CONSTANTS[node.name] !== undefined;
    return false;
  }

  private parseUnary(): Node {
    const token = this.peek();
    if (token.type === 'op' && (token.value === '-' || token.value === '+')) {
      this.next();
      return { kind: 'unary', op: token.value as '-' | '+', arg: this.parseUnary() };
    }
    return this.parsePower();
  }

  private parsePower(): Node {
    const base = this.parseAtom();
    const token = this.peek();
    if (token.type === 'op' && token.value === '^') {
      this.next();
      // 右结合 + 允许 `2^-1`：指数侧继续走一元
      return { kind: 'binary', op: '^', left: base, right: this.parseUnary() };
    }
    return base;
  }

  private parseAtom(): Node {
    const token = this.next();
    if (token.type === 'num') {
      const value = Number(token.value);
      if (!isFinite(value)) throw new ExpressionError(`无法解析的数字「${token.value}」`, token.position, this.source);
      return { kind: 'num', value };
    }
    if (token.type === 'lparen') {
      const inner = this.parseSum();
      const close = this.peek();
      if (close.type !== 'rparen') throw new ExpressionError('缺少右括号', close.position, this.source);
      this.next();
      return inner;
    }
    if (token.type === 'ident') {
      const name = token.value;
      if (this.peek().type === 'lparen') {
        const arity = FUNCTIONS[name];
        if (arity === undefined) throw new ExpressionError(`未知函数「${name}」`, token.position, this.source, 'unknown-function');
        this.next();
        const args: Node[] = [this.parseSum()];
        while (this.peek().type === 'comma') {
          this.next();
          args.push(this.parseSum());
        }
        const close = this.peek();
        if (close.type !== 'rparen') throw new ExpressionError(`函数「${name}」缺少右括号`, close.position, this.source);
        this.next();
        if (args.length !== arity) {
          throw new ExpressionError(
            `函数「${name}」需要 ${arity} 个参数，收到 ${args.length} 个`,
            token.position,
            this.source,
            'arity'
          );
        }
        return { kind: 'call', name, args };
      }
      if (CONSTANTS[name] !== undefined) return { kind: 'num', value: CONSTANTS[name] };
      this.variables.add(name);
      return { kind: 'var', name };
    }
    throw new ExpressionError(
      token.type === 'end' ? '表达式意外结束' : `这里不该出现「${token.value}」`,
      token.position,
      this.source
    );
  }
}

function compileNode(node: Node): (scope: Record<string, number>) => number {
  switch (node.kind) {
    case 'num':
      return () => node.value;
    case 'var':
      return (scope) => {
        const value = scope[node.name];
        return typeof value === 'number' ? value : NaN;
      };
    case 'unary': {
      const arg = compileNode(node.arg);
      return node.op === '-' ? (scope) => -arg(scope) : arg;
    }
    case 'binary': {
      const left = compileNode(node.left);
      const right = compileNode(node.right);
      switch (node.op) {
        case '+':
          return (scope) => left(scope) + right(scope);
        case '-':
          return (scope) => left(scope) - right(scope);
        case '*':
          return (scope) => left(scope) * right(scope);
        case '/':
          return (scope) => left(scope) / right(scope);
        case '%':
          return (scope) => left(scope) % right(scope);
        case '^':
          return (scope) => Math.pow(left(scope), right(scope));
        default:
          return () => NaN;
      }
    }
    case 'call': {
      const name = node.name;
      const impl = IMPL[name] || (Math as any)[name];
      const args = node.args.map(compileNode);
      if (!impl) return () => NaN;
      return (scope) => impl(...args.map((arg) => arg(scope)));
    }
  }
}

const cache = new Map<string, CompiledExpression>();

/** 编译表达式（带缓存：同一串表达式在参数扫动时每帧都会用到）。 */
export function compileExpression(source: string): CompiledExpression {
  const text = String(source === undefined || source === null ? '' : source);
  const cached = cache.get(text);
  if (cached) return cached;
  const parser = new Parser(text);
  const ast = parser.parse();
  const fn = compileNode(ast);
  const compiled: CompiledExpression = {
    source: text,
    variables: parser.getVariables(),
    evaluate: (scope) => fn(scope || {}),
  };
  cache.set(text, compiled);
  return compiled;
}

/** 一次性求值（少量调用用这个；高频采样请先 compileExpression 再复用）。 */
export function evaluateExpression(source: string, scope: Record<string, number> = {}): number {
  return compileExpression(source).evaluate(scope);
}

export interface CompiledSampler {
  /** 更新参数（复用内部 scope，参数扫动时每帧调用）。 */
  setParams(params: Record<string, number>): void;
  /** 求值：`name` 是自变量名（function 图是 'x'，参数曲线是 't'）。 */
  evaluate(variableName: string, value: number): number;
}

/**
 * 生成一个采样器：绑定表达式与参数，复用内部 scope。
 * 采样是每帧上万次的热路径，这里既不能每次新建对象，也不能每次重新编译。
 */
export function compileSampler(source: string, baseScope: Record<string, number> = {}): CompiledSampler {
  const compiled = compileExpression(source);
  const scope: Record<string, number> = { ...baseScope };
  return {
    setParams(params: Record<string, number>): void {
      for (const name of Object.keys(params)) scope[name] = Number(params[name]);
    },
    evaluate(variableName: string, value: number): number {
      scope[variableName] = value;
      return compiled.evaluate(scope);
    },
  };
}
