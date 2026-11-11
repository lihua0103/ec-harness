/** 公司 DVP Logic 方言（`fire when` 开头的英文谓词伪代码）解析器。
 *  方言实证：docs/DVP-TEMPLATE-SCHEMA.md §2——fire when 前缀、< > = 比较、AND/OR/NOT（大小写混用）、
 *  NULL 缺失语义、含空格字段名（如 "Visit Date"、"Not Done"）。
 *  目标：结构化解析 + 诊断；解析不出结构时降级 freeform（绝不硬拒，结构适配不作为门槛）。 */

export type Operand =
  | { kind: 'field'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'string'; text: string }
  | { kind: 'null' }
  | { kind: 'boolean'; text: string };

export type LogicAst =
  | { kind: 'comparison'; left: Operand; op: string; right?: Operand }
  | { kind: 'logical'; op: 'and' | 'or' | 'not'; parts: LogicAst[] }
  | { kind: 'operand'; operand: Operand };

export interface ParseDiagnostic { code: string; message: string; }

export interface LogicParseResult {
  /** 归一化文本；parse 摘要形态（parse.ts slimLogic）可省略以控制返回体积。 */
  normalized?: string;
  status: 'structured' | 'freeform';
  ast?: LogicAst;
  fields: string[];
  diagnostics: ParseDiagnostic[];
}

interface Token { kind: 'word' | 'number' | 'string' | 'op' | 'lparen' | 'rparen'; text: string; }

const OPS = ['>=', '<=', '!=', '<>', '≥', '≤', '≠', '<', '>', '='];
const OP_CANON: Record<string, string> = { '>=': '>=', '<=': '<=', '!=': '!=', '<>': '!=', '≠': '!=', '≥': '>=', '≤': '<=' };
const KEYWORDS = new Set(['and', 'or', 'not', 'null', 'true', 'false', 'is', 'missing', 'between']);

function stripFireWhen(raw: string): string {
  return raw.replace(/^\s*fire\s+when\b[\s:]*/i, '').trim();
}

function tokenize(input: string): { tokens: Token[]; diagnostics: ParseDiagnostic[] } {
  const tokens: Token[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') { tokens.push({ kind: 'lparen', text: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ kind: 'rparen', text: ')' }); i++; continue; }
    if (ch === '\'' || ch === '"') {
      const end = input.indexOf(ch, i + 1);
      if (end < 0) { diagnostics.push({ code: 'UNCLOSED_STRING', message: `第 ${i} 列引号未闭合` }); break; }
      tokens.push({ kind: 'string', text: input.slice(i + 1, end) });
      i = end + 1; continue;
    }
    const op = OPS.find((candidate) => input.startsWith(candidate, i));
    if (op) { tokens.push({ kind: 'op', text: OP_CANON[op] ?? op }); i += op.length; continue; }
    if (/[0-9]/.test(ch) || ch === '.' || ch === '-') {
      const match = /^-?(?:\d+(?:\.\d+)?|\.\d+)/.exec(input.slice(i));
      if (match) { tokens.push({ kind: 'number', text: match[0] }); i += match[0].length; continue; }
    }
    // 词（可含内部空格：字段名 "Visit Date"、"Not Done"）。吞并连续词与词间空白，
    // 边界停在操作符/括号/引号/数字；关键字仅在整词独立成段时按关键字处理（parse 阶段判定）。
    const wordMatch = /^[A-Za-z_][A-Za-z0-9_]*(?:[ \t]+[A-Za-z_][A-Za-z0-9_]*)*/.exec(input.slice(i));
    if (!wordMatch) {
      diagnostics.push({ code: 'UNEXPECTED_CHARACTER', message: `无法识别的字符 ${JSON.stringify(ch)} @${i}` });
      i++; continue;
    }
    const words = wordMatch[0].trim().split(/[ \t]+/);
    for (const word of words) tokens.push({ kind: 'word', text: word });
    i += wordMatch[0].length;
  }
  return { tokens, diagnostics };
}

class Parser {
  private pos = 0;
  private readonly diagnostics: ParseDiagnostic[] = [];
  constructor(private readonly tokens: Token[]) {}

  parse(): { ast?: LogicAst; diagnostics: ParseDiagnostic[]; fields: string[] } {
    if (this.tokens.length === 0) {
      this.diagnostics.push({ code: 'EMPTY_LOGIC', message: '归一化后逻辑为空' });
      return { diagnostics: this.diagnostics, fields: [] };
    }
    let ast: LogicAst | undefined;
    try {
      ast = this.parseOr();
      if (this.pos < this.tokens.length) {
        const rest = this.tokens[this.pos];
        this.diagnostics.push({ code: 'TRAILING_TOKENS', message: `逻辑末尾多余内容: ${JSON.stringify(rest.text)}` });
      }
    } catch (error) {
      if (error instanceof ParseAbort) this.diagnostics.push({ code: error.code, message: error.message });
      else throw error;
    }
    return { ast, diagnostics: this.diagnostics, fields: ast ? collectFields(ast) : [] };
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }

  private parseOr(): LogicAst {
    const parts = [this.parseAnd()];
    while (this.isKeyword('or')) { this.next(); parts.push(this.parseAnd()); }
    return parts.length === 1 ? parts[0] : { kind: 'logical', op: 'or', parts };
  }

  private parseAnd(): LogicAst {
    const parts = [this.parseUnary()];
    while (this.isKeyword('and')) { this.next(); parts.push(this.parseUnary()); }
    return parts.length === 1 ? parts[0] : { kind: 'logical', op: 'and', parts };
  }

  private parseUnary(): LogicAst {
    // 前缀 NOT 仅在 "(...)" 之前视为逻辑非；"Not" 后跟词组按字段名处理（"Not Done" 是合法字段名，
    // 词法上无法区分 bare `NOT x = y`，这里选择字段名优先——方言权衡，记录于 DEVELOPMENT.md）。
    if (this.isKeyword('not') && this.tokens[this.pos + 1]?.kind === 'lparen') {
      this.next();
      return { kind: 'logical', op: 'not', parts: [this.parseUnary()] };
    }
    if (this.peek()?.kind === 'lparen') {
      this.next();
      const inner = this.parseOr();
      const closing = this.next();
      if (!closing || closing.kind !== 'rparen') throw new ParseAbort('UNBALANCED_PARENS', '括号不配对');
      return inner;
    }
    return this.parseComparison();
  }

  private parseComparison(): LogicAst {
    const left = this.parseOperand();
    const opToken = this.peek();
    if (opToken && opToken.kind === 'op') {
      this.next();
      const right = this.parseOperand();
      return { kind: 'comparison', left, op: opToken.text, right };
    }
    // 词组比较：`X is missing` / `X is not missing` / `X not null`。
    if (this.isWord('is')) {
      this.next();
      const negated = this.isKeyword('not');
      if (negated) this.next();
      if (this.isWord('missing')) {
        this.next();
        return { kind: 'comparison', left, op: negated ? '!=' : '=', right: { kind: 'null' } };
      }
      throw new ParseAbort('UNSUPPORTED_IS_PHRASE', 'is 后仅支持 missing');
    }
    if (this.isWord('not') && this.tokens[this.pos + 1]?.text.toLowerCase() === 'null') {
      this.next(); this.next();
      return { kind: 'comparison', left, op: '!=', right: { kind: 'null' } };
    }
    return { kind: 'operand', operand: left };
  }

  private parseOperand(): Operand {
    const token = this.next();
    if (!token) throw new ParseAbort('UNEXPECTED_END', '表达式意外结束');
    if (token.kind === 'string') return { kind: 'string', text: token.text };
    if (token.kind === 'number') return { kind: 'number', text: token.text };
    if (token.kind === 'op') throw new ParseAbort('DANGLING_OPERATOR', `操作符 ${token.text} 缺少左操作数`);
    if (token.kind === 'rparen') throw new ParseAbort('UNEXPECTED_PAREN', '意外右括号');
    const lower = token.text.toLowerCase();
    if (lower === 'null') return { kind: 'null' };
    if (lower === 'true' || lower === 'false') return { kind: 'boolean', text: lower };
    // 词组操作数：吞并后续属于同一字段名的词，直到操作符/关键字边界。
    let text = token.text;
    while (true) {
      const ahead = this.peek();
      if (!ahead || ahead.kind !== 'word') break;
      const aheadLower = ahead.text.toLowerCase();
      if (KEYWORDS.has(aheadLower) && !(aheadLower === 'not' && this.tokens[this.pos + 1] && this.tokens[this.pos + 1].kind === 'word' && !KEYWORDS.has(this.tokens[this.pos + 1].text.toLowerCase()))) break;
      // "Not Done" 中 Not 后跟普通词 → 视为字段名一部分；独立 not 则是关键字。
      text += ` ${ahead.text}`;
      this.next();
    }
    return { kind: 'field', text };
  }

  private isKeyword(word: string): boolean {
    const token = this.peek();
    return !!token && token.kind === 'word' && token.text.toLowerCase() === word;
  }
  private isWord(word: string): boolean { return this.isKeyword(word); }
}

class ParseAbort extends Error { constructor(readonly code: string, message: string) { super(message); } }

function collectFields(ast: LogicAst): string[] {
  const fields: string[] = [];
  const walk = (node: LogicAst): void => {
    if (node.kind === 'logical') node.parts.forEach(walk);
    else if (node.kind === 'comparison') { if (node.left.kind === 'field') fields.push(node.left.text); if (node.right?.kind === 'field') fields.push(node.right.text); }
    else if (node.kind === 'operand' && node.operand.kind === 'field') fields.push(node.operand.text);
  };
  walk(ast);
  return [...new Set(fields)];
}

/** 无结构回退：正则提取疑似字段名（操作符前的连续词组），保持 freeform 也有可用线索。 */
function fallbackFields(normalized: string): string[] {
  const found = new Set<string>();
  const pattern = /([A-Za-z_][A-Za-z]*(?:[ \t]+[A-Za-z_][A-Za-z]*)*)\s*(?:>=|<=|!=|<>|≥|≤|≠|<|>|=)\s*/g;
  for (const match of normalized.matchAll(pattern)) {
    const words = match[1].trim().split(/[ \t]+/).filter((w) => !KEYWORDS.has(w.toLowerCase()));
    if (words.length) found.add(words.join(' '));
  }
  return [...found];
}

export function parseLogic(raw: string): LogicParseResult {
  const normalized = stripFireWhen(raw).replace(/\s*\n+\s*/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const { tokens, diagnostics: tokenDiags } = tokenize(normalized);
  const parser = new Parser(tokens);
  const { ast, diagnostics: parseDiags, fields } = parser.parse();
  const diagnostics = [...tokenDiags, ...parseDiags];
  // 只有含比较/缺失结构的才称 structured；纯词组（叙述性文本）降级 freeform。
  if (diagnostics.length === 0 && ast && ast.kind !== 'operand') {
    return { normalized, status: 'structured', ast, fields, diagnostics: [] };
  }
  if (diagnostics.length === 0) diagnostics.push({ code: 'NO_COMPARISON', message: '逻辑未包含比较/缺失结构' });
  return {
    normalized, status: 'freeform',
    ...(ast ? { ast } : {}),
    fields: fields.length ? fields : fallbackFields(normalized),
    diagnostics: diagnostics.length ? diagnostics : [{ code: 'NOT_STRUCTURED', message: '未识别出比较/逻辑结构' }],
  };
}

export interface Comparison { left: Operand; op: string; right?: Operand; }

/** 展平 AST 中的全部比较（供测试用例生成器使用）。 */
export function collectComparisons(ast: LogicAst): Comparison[] {
  const out: Comparison[] = [];
  const walk = (node: LogicAst): void => {
    if (node.kind === 'logical') node.parts.forEach(walk);
    else if (node.kind === 'comparison') out.push({ left: node.left, op: node.op, ...(node.right ? { right: node.right } : {}) });
  };
  walk(ast);
  return out;
}
