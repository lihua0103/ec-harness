/** fire-when → 目标 EDC 渲染。公司方言本身就是 EDC 无关中间层（docs/DVP-TEMPLATE-SCHEMA.md §7.2）；
 *  本模块把结构化 AST 渲染为 Rave 风格检查步骤（variable/operator/value/joiner）或通用表达式。
 *  纪律：渲染结果是配置参考（RENDER_REFERENCE_ONLY），不直接写入生产 EDC 配置；
 *  AND/OR 混合嵌套标记 NEEDS_MANUAL_GROUPING，复合 NOT 标记 NEEDS_MANUAL_REWRITE——不代做语义改写。 */
import { parseLogic, type LogicAst, type Operand } from './firewhen.js';
import type { CrossFieldRule } from './rules.js';

export type RenderTarget = 'rave-steps' | 'generic-expression';
export const RENDER_TARGETS: readonly RenderTarget[] = ['rave-steps', 'generic-expression'];

export interface CheckStep {
  step: number;
  joiner: '' | 'And' | 'Or';
  variable: string;
  operator: string;
  value?: string | number | boolean;
  rightVariable?: string;
  note?: string;
}

export interface RuleRender {
  id: string;
  queryType: string;
  status: 'structured' | 'freeform' | 'absent';
  steps: CheckStep[];
  expression?: string;
  warnings: string[];
}

export interface RenderResult {
  target: RenderTarget;
  rules: RuleRender[];
  totals: { rules: number; rendered: number; freeform: number; absent: number; flagged: number };
  notices: string[];
}

const NOTICES = [
  'RENDER_REFERENCE_ONLY：渲染结果是目标 EDC 的配置参考草稿，须在目标系统中复核后由项目团队配置，不直接写入生产环境。',
  'GROUPING_FLAGGED：AND/OR 混合嵌套的规则标记 NEEDS_MANUAL_GROUPING——扁平步骤序列不承载分组语义，分组与顺序由项目团队确认。',
  'COMPOUND_NOT_FLAGGED：对组合条件的 NOT 标记 NEEDS_MANUAL_REWRITE——自动 De Morgan 改写易引入缺失语义漂移，不做。',
];

const OP_MAP: Record<string, string> = {
  '>': 'GreaterThan', '>=': 'GreaterThanOrEqual',
  '<': 'LessThan', '<=': 'LessThanOrEqual',
  '=': 'Equal', '!=': 'NotEqual',
};
const NULL_OP_MAP: Record<string, string> = { '=': 'IsMissing', '!=': 'IsPopulated' };
const INVERT_OP: Record<string, string> = { '>': '<=', '>=': '<', '<': '>=', '<=': '>', '=': '!=', '!=': '=' };
const MAX_STEPS = 50;

function operandValue(operand: Operand): { value?: string | number | boolean; rightVariable?: string } {
  switch (operand.kind) {
    case 'number': return { value: Number(operand.text) };
    case 'string': return { value: operand.text };
    case 'boolean': return { value: operand.text };
    case 'field': return { rightVariable: operand.text };
    case 'null': return {};
  }
}

function stepFromComparison(
  node: { left: Operand; op: string; right?: Operand },
  joiner: '' | 'And' | 'Or',
  step: number,
  note?: string,
): CheckStep {
  const variable = node.left.kind === 'field' ? node.left.text : `<literal:${node.left.kind}>`;
  const right = node.right;
  if (right?.kind === 'null') {
    return { step, joiner, variable, operator: NULL_OP_MAP[node.op] ?? node.op, ...(note ? { note } : {}) };
  }
  const mapped = OP_MAP[node.op] ?? node.op;
  const payload = right ? operandValue(right) : {};
  return { step, joiner, variable, operator: mapped, ...payload, ...(note ? { note } : {}) };
}

function containsMixedLogic(node: LogicAst): boolean {
  const ops = new Set<string>();
  const walk = (n: LogicAst): void => {
    if (n.kind === 'logical') { if (n.op !== 'not') ops.add(n.op); n.parts.forEach(walk); }
  };
  walk(node);
  return ops.size > 1;
}

function emitSteps(ast: LogicAst, warnings: Set<string>): CheckStep[] {
  const out: CheckStep[] = [];
  const walk = (node: LogicAst, joiner: '' | 'And' | 'Or', note?: string): void => {
    if (out.length >= MAX_STEPS) { warnings.add('TOO_MANY_COMPARISONS_TRUNCATED'); return; }
    switch (node.kind) {
      case 'comparison':
        out.push(stepFromComparison(node, joiner, out.length + 1, note));
        break;
      case 'logical': {
        if (node.op === 'not') {
          const inner = node.parts[0];
          if (inner?.kind === 'comparison') {
            walk({ ...inner, op: INVERT_OP[inner.op] ?? inner.op }, joiner, 'NOT(...) applied as operator inversion');
          } else {
            warnings.add('NEEDS_MANUAL_REWRITE');
          }
          break;
        }
        if (containsMixedLogic(node)) warnings.add('NEEDS_MANUAL_GROUPING');
        const childJoiner = node.op === 'and' ? 'And' : 'Or';
        node.parts.forEach((part, i) => walk(part, i === 0 ? joiner : childJoiner, note));
        break;
      }
      case 'operand':
        warnings.add('NON_COMPARISON_PART');
        break;
    }
  };
  walk(ast, '');
  return out;
}

function renderRule(rule: CrossFieldRule, target: RenderTarget): RuleRender {
  const warnings = new Set<string>();
  if (!rule.logic) {
    return { id: rule.id, queryType: rule.queryType, status: 'absent', steps: [], warnings: ['NO_LOGIC_PROVIDED'] };
  }
  const parsed = rule.logicParse?.ast
    ? { ...rule.logicParse }
    : parseLogic(rule.logic);
  if (parsed.status !== 'structured' || !parsed.ast) {
    return {
      id: rule.id, queryType: rule.queryType, status: 'freeform', steps: [],
      ...(target === 'generic-expression' ? { expression: parsed.normalized ?? rule.logic } : {}),
      warnings: ['FREEFORM_LOGIC_NOT_RENDERED'],
    };
  }
  const result: RuleRender = {
    id: rule.id, queryType: rule.queryType, status: 'structured',
    steps: target === 'rave-steps' ? emitSteps(parsed.ast, warnings) : [],
    ...(target === 'generic-expression' ? { expression: parsed.normalized } : {}),
    warnings: [...warnings],
  };
  return result;
}

export function renderChecks(rules: CrossFieldRule[], target: RenderTarget): RenderResult {
  if (!RENDER_TARGETS.includes(target)) throw new Error('RENDER_TARGET_UNKNOWN');
  const rendered = rules.map((rule) => renderRule(rule, target));
  const result: RenderResult = { target, rules: rendered, totals: {
    rules: rendered.length,
    rendered: rendered.filter((r) => r.status === 'structured').length,
    freeform: rendered.filter((r) => r.status === 'freeform').length,
    absent: rendered.filter((r) => r.status === 'absent').length,
    flagged: rendered.filter((r) => r.warnings.some((w) => w === 'NEEDS_MANUAL_GROUPING' || w === 'NEEDS_MANUAL_REWRITE')).length,
  }, notices: NOTICES };
  return result;
}
