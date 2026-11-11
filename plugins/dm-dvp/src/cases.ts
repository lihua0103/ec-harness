/** 测试用例候选生成：正例（应触发）/反例（不应触发）/恰边界（边界期望写进 rationale）。
 *  推导只依据规则 IR 的结构化逻辑；解析不出的逻辑降级 unresolved，不硬造用例。
 *  纪律：产物全部是候选（CANDIDATE）——从未在任何 EDC 或 UAT 环境执行，不构成验证证据。 */
import { parseLogic, collectComparisons, type Comparison } from './firewhen.js';
import type { CrossFieldRule } from './rules.js';

export interface CaseAssignment { field: string; value: string; }
export interface CaseCandidate {
  ruleId: string;
  kind: 'positive' | 'negative' | 'boundary' | 'unresolved';
  caseName: string;
  assignments: CaseAssignment[];
  rationale: string;
  confidence: 'structural' | 'heuristic';
  note?: string;
}
export interface CaseReport {
  ruleId: string; queryType: string;
  logicStatus: 'structured' | 'freeform' | 'absent';
  candidates: CaseCandidate[];
}
export interface CaseResult {
  reports: CaseReport[];
  totals: { rules: number; candidates: number; unresolved: number };
  notices: string[];
}

const NOTICES = [
  '全部用例为候选（CANDIDATE）：从未在任何 EDC 或 UAT 环境执行，不构成验证证据；UAT 用例由项目团队在 Manual Review for Programming 行内留档执行。',
  '复合 AND/OR/NOT 逻辑不会拆成单比较候选；无法证明整规则期望时返回 unresolved。',
  '取值占位（VALUE_A/RULE_SPECIFIC 等）需按项目数据规范替换为真实合规值。',
];

function below(n: number): string { return Number.isInteger(n) ? String(n - 1) : String(Number((n - 0.1).toFixed(6))); }
function above(n: number): string { return Number.isInteger(n) ? String(n + 1) : String(Number((n + 0.1).toFixed(6))); }

function comparisonCases(comp: Comparison, ruleId: string): CaseCandidate[] {
  const fieldName = comp.left.kind === 'field' ? comp.left.text : '(表达式)';
  const mk = (kind: CaseCandidate['kind'], caseName: string, assignments: CaseAssignment[], rationale: string, note?: string): CaseCandidate =>
    ({ ruleId, kind, caseName, assignments, rationale, confidence: 'structural', ...(note ? { note } : {}) });

  // 缺失语义：is missing / is not missing / not null。
  if (comp.right?.kind === 'null') {
    if (comp.op === '=') {
      return [
        mk('positive', 'FIELD_MISSING_TRIGGER', [{ field: fieldName, value: '(留空)' }], `${fieldName} 缺失时规则应触发。`),
        mk('negative', 'FIELD_POPULATED_NO_TRIGGER', [{ field: fieldName, value: '(填写任意合规值)' }], `${fieldName} 有值时不应触发。`),
      ];
    }
    if (comp.op === '!=') {
      return [
        mk('positive', 'FIELD_POPULATED_TRIGGER', [{ field: fieldName, value: '(填写任意合规值)' }], `${fieldName} 有值时规则应触发。`),
        mk('negative', 'FIELD_MISSING_NO_TRIGGER', [{ field: fieldName, value: '(留空)' }], `${fieldName} 缺失时不应触发。`),
      ];
    }
  }
  if (!comp.right) {
    return [mk('unresolved', 'NO_RIGHT_OPERAND', [{ field: fieldName, value: 'RULE_SPECIFIC' }], '比较缺少右操作数，无法推导取值。')];
  }
  switch (comp.right.kind) {
    case 'number': {
      const n = Number(comp.right.text);
      const low = below(n), high = above(n);
      switch (comp.op) {
        case '>':
          return [
            mk('positive', 'ABOVE_THRESHOLD_TRIGGER', [{ field: fieldName, value: high }], `${fieldName} 大于 ${n} 时应触发。`, 'PER_COMPARISON'),
            mk('boundary', 'AT_BOUNDARY_NO_TRIGGER', [{ field: fieldName, value: String(n) }], `等于 ${n} 时严格大于（>）不应触发——恰边界。`, 'PER_COMPARISON'),
            mk('negative', 'BELOW_THRESHOLD_NO_TRIGGER', [{ field: fieldName, value: low }], `${fieldName} 小于 ${n} 时不应触发。`, 'PER_COMPARISON'),
          ];
        case '>=':
          return [
            mk('boundary', 'AT_THRESHOLD_TRIGGER', [{ field: fieldName, value: String(n) }], `等于 ${n} 时应触发——含边界比较，边界值本身就是正例。`, 'PER_COMPARISON'),
            mk('negative', 'BELOW_THRESHOLD_NO_TRIGGER', [{ field: fieldName, value: low }], `${fieldName} 低于 ${n} 时不应触发。`, 'PER_COMPARISON'),
          ];
        case '<':
          return [
            mk('positive', 'BELOW_THRESHOLD_TRIGGER', [{ field: fieldName, value: low }], `${fieldName} 小于 ${n} 时应触发。`, 'PER_COMPARISON'),
            mk('boundary', 'AT_BOUNDARY_NO_TRIGGER', [{ field: fieldName, value: String(n) }], `等于 ${n} 时严格小于（<）不应触发——恰边界。`, 'PER_COMPARISON'),
            mk('negative', 'ABOVE_THRESHOLD_NO_TRIGGER', [{ field: fieldName, value: high }], `${fieldName} 大于 ${n} 时不应触发。`, 'PER_COMPARISON'),
          ];
        case '<=':
          return [
            mk('boundary', 'AT_THRESHOLD_TRIGGER', [{ field: fieldName, value: String(n) }], `等于 ${n} 时应触发——含边界比较。`, 'PER_COMPARISON'),
            mk('negative', 'ABOVE_THRESHOLD_NO_TRIGGER', [{ field: fieldName, value: high }], `${fieldName} 高于 ${n} 时不应触发。`, 'PER_COMPARISON'),
          ];
        case '=':
          return [
            mk('positive', 'EQUAL_TRIGGER', [{ field: fieldName, value: String(n) }], `${fieldName} 等于 ${n} 时应触发。`, 'PER_COMPARISON'),
            mk('negative', 'DIFFERENT_NO_TRIGGER', [{ field: fieldName, value: above(n) }], `${fieldName} 不等于 ${n} 时不应触发。`, 'PER_COMPARISON'),
          ];
        case '!=':
          return [
            mk('positive', 'DIFFERENT_TRIGGER', [{ field: fieldName, value: above(n) }], `${fieldName} 不等于 ${n} 时应触发。`, 'PER_COMPARISON'),
            mk('negative', 'EQUAL_NO_TRIGGER', [{ field: fieldName, value: String(n) }], `${fieldName} 等于 ${n} 时不应触发。`, 'PER_COMPARISON'),
          ];
        default:
          return [mk('unresolved', 'UNKNOWN_OPERATOR', [{ field: fieldName, value: 'RULE_SPECIFIC' }], `无法识别的比较符 ${comp.op}。`)];
      }
    }
    case 'string': {
      const s = comp.right.text;
      if (comp.op === '=') {
        return [
          mk('positive', 'MATCH_TRIGGER', [{ field: fieldName, value: s }], `${fieldName} 等于该值时应触发。`, 'PER_COMPARISON'),
          mk('negative', 'MISMATCH_NO_TRIGGER', [{ field: fieldName, value: 'ALT_VALUE' }], `${fieldName} 为不同值时不应触发。`, 'PER_COMPARISON'),
        ];
      }
      if (comp.op === '!=') {
        return [
          mk('positive', 'MISMATCH_TRIGGER', [{ field: fieldName, value: 'ALT_VALUE' }], `${fieldName} 为不同值时应触发。`, 'PER_COMPARISON'),
          mk('negative', 'MATCH_NO_TRIGGER', [{ field: fieldName, value: s }], `${fieldName} 等于该值时不应触发。`, 'PER_COMPARISON'),
        ];
      }
      return [mk('unresolved', 'STRING_WITH_ORDER_OPERATOR', [{ field: fieldName, value: 'RULE_SPECIFIC' }], `字符串参与 ${comp.op} 比较，取值与期望需按项目编码列表人工判定。`)];
    }
    case 'field':
      return [mk('unresolved', 'FIELD_PAIR_NEEDS_PROJECT_DATA',
        [{ field: fieldName, value: 'VALUE_A' }, { field: comp.right.text, value: 'VALUE_B' }],
        '字段间比较（如日期先后）需按项目数据规范取具体值，结构已识别、取值待项目数据。', 'PER_COMPARISON · 结构化推导')];
    case 'boolean': {
      const b = comp.right.text;
      const opposite = b === 'true' ? 'false' : 'true';
      if (comp.op === '=') {
        return [
          mk('positive', 'BOOLEAN_MATCH_TRIGGER', [{ field: fieldName, value: b }], `${fieldName} 为 ${b} 时应触发。`, 'PER_COMPARISON'),
          mk('negative', 'BOOLEAN_MISMATCH_NO_TRIGGER', [{ field: fieldName, value: opposite }], `${fieldName} 为 ${opposite} 时不应触发。`, 'PER_COMPARISON'),
        ];
      }
      if (comp.op === '!=') {
        return [
          mk('positive', 'BOOLEAN_MISMATCH_TRIGGER', [{ field: fieldName, value: opposite }], `${fieldName} 为 ${opposite} 时应触发。`, 'PER_COMPARISON'),
          mk('negative', 'BOOLEAN_MATCH_NO_TRIGGER', [{ field: fieldName, value: b }], `${fieldName} 为 ${b} 时不应触发。`, 'PER_COMPARISON'),
        ];
      }
      return [mk('unresolved', 'BOOLEAN_WITH_ORDER_OPERATOR', [{ field: fieldName, value: 'RULE_SPECIFIC' }], `布尔量参与 ${comp.op} 比较，需人工判定。`)];
    }
    default:
      return [mk('unresolved', 'UNSUPPORTED_OPERAND', [{ field: fieldName, value: 'RULE_SPECIFIC' }], '右操作数类型不支持自动取值。')];
  }
}

export function suggestCases(rules: CrossFieldRule[]): CaseResult {
  const reports: CaseReport[] = rules.map((rule) => {
    const ruleId = rule.id || '(no id)';
    const queryType = String(rule.queryType || 'UNSPECIFIED');
    const parsed = rule.logicParse && rule.logicParse.ast ? rule.logicParse : rule.logic ? parseLogic(rule.logic) : undefined;
    if (!rule.logic || !parsed) {
      return {
        ruleId, queryType, logicStatus: 'absent',
        candidates: [{
          ruleId, kind: 'unresolved', caseName: 'NO_LOGIC_PROVIDED', assignments: [],
          rationale: '规则没有 Logic 内容，无法推导用例；需 DM 依据报告描述人工设计。',
          confidence: 'heuristic',
        }],
      };
    }
    if (parsed.status !== 'structured' || !parsed.ast) {
      return {
        ruleId, queryType, logicStatus: 'freeform',
        candidates: [{
          ruleId, kind: 'unresolved', caseName: 'CUSTOM_REQUIRES_MANUAL_CASES',
          assignments: [{ field: rule.targetField || '(规则域)', value: 'RULE_SPECIFIC' }],
          rationale: '逻辑未解析出结构化比较（Custom 类或叙述式），需 DM 依据描述手工设计用例。',
          confidence: 'heuristic',
          note: parsed.diagnostics.map((d) => d.code).join(','),
        }],
      };
    }
    if (parsed.ast.kind === 'logical') {
      return {
        ruleId, queryType, logicStatus: 'structured',
        candidates: [{
          ruleId, kind: 'unresolved', caseName: 'COMPOSITE_LOGIC_NEEDS_WHOLE_RULE_CASES', assignments: [],
          rationale: '逻辑包含 AND/OR/NOT 组合；单比较取值不能证明整条规则的触发期望，因此不生成正反例。需按完整逻辑构造并复核数据集。',
          confidence: 'structural',
          note: `LOGICAL_${parsed.ast.op.toUpperCase()}`,
        }],
      };
    }
    const comparisons = collectComparisons(parsed.ast);
    if (!comparisons.length) {
      return {
        ruleId, queryType, logicStatus: 'structured',
        candidates: [{
          ruleId, kind: 'unresolved', caseName: 'NO_COMPARISON_FOUND', assignments: [],
          rationale: 'AST 中未找到比较节点，需人工复核逻辑。', confidence: 'structural',
        }],
      };
    }
    return {
      ruleId, queryType, logicStatus: 'structured',
      candidates: comparisons.flatMap((comp) => comparisonCases(comp, ruleId)),
    };
  });
  const allCandidates = reports.flatMap((report) => report.candidates);
  return {
    reports,
    totals: {
      rules: reports.length,
      candidates: allCandidates.length,
      unresolved: allCandidates.filter((c) => c.kind === 'unresolved').length,
    },
    notices: NOTICES,
  };
}
