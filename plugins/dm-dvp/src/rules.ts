/** DVP 规则 IR：列语义对齐公司模板（docs/DVP-TEMPLATE-SCHEMA.md，实例 TAISHAN-304 V2.0 结构）。
 *  本模块只定义数据形状、诊断校验与外部输入宽容归一；生成物一律是候选（CANDIDATE），不是已验证 DVP。 */
import type {LogicParseResult} from './firewhen.js';
import {parseLogic} from './firewhen.js';

export type QueryType = 'Date' | 'Custom' | 'Missing' | 'Range';
export const QUERY_TYPES: readonly QueryType[] = ['Date', 'Custom', 'Missing', 'Range'];

/** Dynamic Type 8 枚举：对齐公司模板（docs/DVP-TEMPLATE-SCHEMA.md §5，拼写逐字一致）。
 *  此表是系统既有配置的登记；越枚举不硬拒、记 DYNAMIC_TYPE_UNRECOGNIZED 诊断，交项目团队按目标系统核对。 */
export type DynamicType = 'Dynamic Field' | 'Dynamic Search list' | 'Dynamic Page' | 'Derivation' | 'Dynamic Visit' | 'Participant Status' | 'Dynamic Option' | 'Add Event';
export const DYNAMIC_TYPES: readonly DynamicType[] = ['Dynamic Field', 'Dynamic Search list', 'Dynamic Page', 'Derivation', 'Dynamic Visit', 'Participant Status', 'Dynamic Option', 'Add Event'];

export interface ChangeMark { action: 'Add' | 'Update' | 'Delete'; version: string; }

export interface CrossFieldRule {
  id: string;
  changeMark: ChangeMark | null;
  /** 源模板变更标记原文；存在时写簿层不经过 mark/version 归一。 */
  changeMarkRaw?: string;
  visits: string;
  formName: string;
  targetField: string;
  relatedFields: string[];
  /** 源模板相关字段列原文透传；存在时写簿层原样写出，列表 IR 仍保留用于语义校验。 */
  relatedFieldsRaw?: string;
  /** Ordered source-cell projection for exact template transport; IR fields remain available for validation. */
  sourceCells?: string[];
  queryType: QueryType | string;
  discrepancyText: string;
  logic: string;
  /** DXP 实物形态：Testcase 两列的示例值（触发的用例值 / 未触发的用例值，由生成方按逻辑推导，
   *  交付前由项目团队核对；UAT 三列留空纪律不涉及这两列——它们是规则行内的测试示例，不是行内 UAT 留档）。 */
  testcaseFired?: string;
  testcaseNotFired?: string;
  logicParse?: LogicParseResult;
  issues: string[];
}

export interface FieldLevelSpec {
  changeMark: ChangeMark | null;
  /** 源模板变更标记原文；存在时写簿层不经过 mark/version 归一。 */
  changeMarkRaw?: string;
  formOid: string; formName: string; fieldOid: string; preText: string;
  controlType: string; dataFormat: string;
  isLog: boolean | null; isRequired: boolean | null;
  queryFutureDate: boolean | null; queryNonConformance: boolean | null;
  /** 源模板布尔列原值透传：传入字符串时写簿层原样输出；缺省仍按 boolText 归一。 */
  isLogRaw?: string;
  isRequiredRaw?: string;
  queryFutureDateRaw?: string;
  queryNonConformanceRaw?: string;
  /** 源模板字段级规则 IR 之外的尾随列，按原序透传；缺省不生成尾列。 */
  extra?: string[];
  sourceCells?: string[];
  issues: string[];
}

export interface ManualReviewProgramming {
  assign: string; columnHeading: string;
  /** 脱敏模式下只记条数；条数在任何模式下都返回（用户既定边界：外部模型部署时临床项目内容不外显）。 */
  testCaseSubjectCount: number; dmCommentCount: number; dbdCommentCount: number;
  /** 全量模式（模型目录全部为公司内部模型，data-boundary.ts）：TEST CASE / DM / DBD 评审意见原值。 */
  testCase?: string; dmComment?: string; dbdComment?: string;
}

export interface ManualReviewRule {
  id: string;
  sheet?: string;
  changeMark: ChangeMark | null;
  /** 源模板变更标记原文；存在时写簿层不经过 mark/version 归一。 */
  changeMarkRaw?: string;
  visits: string; formName: string;
  relatedFields: string; reportDescription: string; discrepancyText: string;
  logic: string;
  programming: ManualReviewProgramming | null;
  /** 附加单元格（对齐实物 MR 多出的列，如 Pass/Fail、核查结论等；由生成方按实物列形提供，候选内容）。 */
  extra?: string[];
  sourceCells?: string[];
  issues: string[];
}

export interface DynamicSpec {
  id: string;
  changeMark: ChangeMark | null;
  /** 源模板变更标记原文；存在时写簿层不经过 mark/version 归一。 */
  changeMarkRaw?: string;
  formName: string; fieldName: string; type: string;
  visits?: string; discrepancyText?: string; condition?: string;
  /** 源模板中超出规则 IR 的尾随列，按原序写出；缺省不产生尾列。 */
  extra?: string[];
  sourceCells?: string[];
  issues: string[];
}

export interface VersionRow { version: string; date: string; modifiedBy: string; comments: string; }

export interface DvpDocument {
  workbookPath: string; sha256: string;
  sheets: Array<{ name: string; sheetId: string; visibility: string; role: string; note?: string }>;
  versionHistory: VersionRow[];
  crossField: CrossFieldRule[];
  fieldLevel: FieldLevelSpec[];
  manualReview: ManualReviewRule[];
  dynamic: DynamicSpec[];
}

export class RulesInputError extends Error { constructor(readonly code: string) { super(code); } }

const TEXT_CAP = 4000, ID_CAP = 80;

export function parseChangeMark(raw: string): ChangeMark | null {
  const text = raw.trim();
  if (!text) return null;
  const slash = text.indexOf('/');
  if (slash < 0) return { action: 'Update', version: text };
  const action = text.slice(0, slash).trim();
  const version = text.slice(slash + 1).trim();
  if (!['Add', 'Update', 'Delete'].includes(action)) return null;
  return { action: action as ChangeMark['action'], version };
}

export function parseBool(raw: string): boolean | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  return null;
}

/** 列表单元格拆分：换行/分号/逗号；不用斜杠（字段名可能含斜杠）。 */
export function splitList(value: string): string[] {
  return value.split(/\r?\n|\s*[;,]\s*/).map((s) => s.trim()).filter(Boolean);
}

export function validateCrossFieldRule(rule: CrossFieldRule): string[] {
  const issues: string[] = [];
  if (!rule.id) issues.push('MISSING_UNIQUE_ID');
  else if (rule.id.length > ID_CAP) issues.push('ID_TOO_LONG');
  if (!rule.formName) issues.push('MISSING_FORM_NAME');
  if (!rule.targetField) issues.push('MISSING_TARGET_FIELD');
  if (!QUERY_TYPES.includes(rule.queryType as QueryType)) issues.push(`QUERY_TYPE_UNRECOGNIZED:${rule.queryType || '(empty)'}`);
  if (!rule.discrepancyText) issues.push('MISSING_DISCREPANCY_TEXT');
  else if (rule.discrepancyText.length > TEXT_CAP) issues.push('DISCREPANCY_TEXT_TOO_LONG');
  if (!rule.logic) issues.push('MISSING_LOGIC');
  else if (rule.logic.length > TEXT_CAP) issues.push('LOGIC_TOO_LONG');
  return issues;
}

export function validateFieldLevel(spec: FieldLevelSpec): string[] {
  const issues: string[] = [];
  if (!spec.formOid) issues.push('MISSING_FORM_OID');
  if (!spec.fieldOid) issues.push('MISSING_FIELD_OID');
  if (!spec.formName) issues.push('MISSING_FORM_NAME');
  for (const [key, value] of [['isLog', spec.isLog], ['isRequired', spec.isRequired], ['queryFutureDate', spec.queryFutureDate], ['queryNonConformance', spec.queryNonConformance]] as const) {
    if (value === null) issues.push(`BOOL_UNPARSEABLE:${key}`);
  }
  return issues;
}

/** Dynamic 行校验：与 Query Type 对称——必填项 + Type 8 枚举，越枚举记诊断不硬拒（不识别即上报）。 */
export function validateDynamic(spec: DynamicSpec): string[] {
  const issues: string[] = [];
  if (!spec.id) issues.push('MISSING_UNIQUE_ID');
  else if (spec.id.length > ID_CAP) issues.push('ID_TOO_LONG');
  if (!spec.type) issues.push('MISSING_TYPE');
  else if (!DYNAMIC_TYPES.includes(spec.type as DynamicType)) issues.push(`DYNAMIC_TYPE_UNRECOGNIZED:${spec.type}`);
  return issues;
}

/** 附带逻辑解析（fire-when）并合并诊断；不修改输入对象。 */
export function withLogicParse(rule: CrossFieldRule): CrossFieldRule {
  const logicParse = rule.logic ? parseLogic(rule.logic) : undefined;
  const issues = [
    ...rule.issues,
    ...validateCrossFieldRule(rule),
    ...(logicParse?.diagnostics.map((d) => `LOGIC:${d.code}`) ?? []),
  ];
  return {...rule, logicParse, issues: [...new Set(issues)]};
}

const asString = (value: unknown): string => typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value).trim();
const asStringArray = (value: unknown): string[] => Array.isArray(value) ? value.map(asString).filter((s) => s) : splitList(asString(value));

/** 宽容归一外部传入的单条规则：字符串字段强制 string，relatedFields 接受数组或分隔文本。
 *  识别别名：form→formName、fields 数组（首元素→targetField、其余→relatedFields）、
 *  message→discrepancyText、targetedField→targetField、relatedField→relatedFields；
 *  其余未识别键由 input 层逐条上报（UNKNOWN_KEYS_IGNORED），不静默丢弃。 */
export function coerceRuleInput(value: unknown): CrossFieldRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RulesInputError('RULE_NOT_OBJECT');
  const rec = value as Record<string, unknown>;
  const changeMark = coerceChangeMark(rec.changeMark);
  const fieldList = asStringArray(rec.fields);
  const relatedRaw = rec.relatedFields === undefined ? rec.relatedField : rec.relatedFields;
  const rule: CrossFieldRule = {
    id: asString(rec.id),
    changeMark,
    changeMarkRaw: typeof rec.changeMarkRaw === 'string' ? rec.changeMarkRaw : undefined,
    visits: asString(rec.visits),
    formName: asString(rec.formName ?? rec.form),
    targetField: asString(rec.targetField ?? rec.targetedField) || fieldList[0] || '',
    relatedFields: relatedRaw === undefined ? fieldList.slice(1) : asStringArray(relatedRaw),
    relatedFieldsRaw: typeof rec.relatedFieldsRaw === 'string' ? rec.relatedFieldsRaw : undefined,
    sourceCells: Array.isArray(rec.sourceCells) ? rec.sourceCells.map(asString) : undefined,
    queryType: asString(rec.queryType),
    discrepancyText: asString(rec.discrepancyText ?? rec.message),
    logic: asString(rec.logic),
    testcaseFired: rec.testcaseFired === undefined ? undefined : asString(rec.testcaseFired),
    testcaseNotFired: rec.testcaseNotFired === undefined ? undefined : asString(rec.testcaseNotFired),
    issues: [],
  };
  return {...rule, issues: validateCrossFieldRule(rule)};
}

/** Add/Delete/Update 变更标记归一：'Add/V2.0' 文本或 {action,version} 对象；未知动作 → null。 */
export function coerceChangeMark(raw: unknown): ChangeMark | null {
  if (typeof raw === 'string') return parseChangeMark(raw);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const action = asString((raw as Record<string, unknown>).action);
    if (['Add', 'Update', 'Delete'].includes(action)) {
      return { action: action as ChangeMark['action'], version: asString((raw as Record<string, unknown>).version) };
    }
  }
  return null;
}

/** 解析工具入参 rulesJson：接受规则数组或 {crossField:[...]}。 */
export function parseRulesJson(text: string): CrossFieldRule[] {
  if (text.length > 1_000_000) throw new RulesInputError('RULES_PAYLOAD_TOO_LARGE');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new RulesInputError('INVALID_RULES_JSON'); }
  let list: unknown[] | null = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).crossField)) {
    list = (parsed as Record<string, unknown>).crossField as unknown[];
  }
  if (!list) throw new RulesInputError('RULES_SHAPE_UNSUPPORTED');
  if (list.length > 2000) throw new RulesInputError('TOO_MANY_RULES');
  return list.map((item) => coerceRuleInput(item));
}
