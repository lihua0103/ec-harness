/** DVP 规则 IR：列语义对齐公司模板（docs/DVP-TEMPLATE-SCHEMA.md，实例 TAISHAN-304 V2.0 结构）。
 *  本模块只定义数据形状、诊断校验与外部输入宽容归一；生成物一律是候选（CANDIDATE），不是已验证 DVP。 */
import type {LogicParseResult} from './firewhen.js';
import {parseLogic} from './firewhen.js';

export type QueryType = 'Date' | 'Custom' | 'Missing' | 'Range';
export const QUERY_TYPES: readonly QueryType[] = ['Date', 'Custom', 'Missing', 'Range'];

export interface ChangeMark { action: 'Add' | 'Update' | 'Delete'; version: string; }

export interface CrossFieldRule {
  id: string;
  changeMark: ChangeMark | null;
  visits: string;
  formName: string;
  targetField: string;
  relatedFields: string[];
  queryType: QueryType | string;
  discrepancyText: string;
  logic: string;
  logicParse?: LogicParseResult;
  issues: string[];
}

export interface FieldLevelSpec {
  changeMark: ChangeMark | null;
  formOid: string; formName: string; fieldOid: string; preText: string;
  controlType: string; dataFormat: string;
  isLog: boolean | null; isRequired: boolean | null;
  queryFutureDate: boolean | null; queryNonConformance: boolean | null;
  issues: string[];
}

export interface ManualReviewProgramming {
  assign: string; columnHeading: string;
  /** 行内 UAT 用例与评审意见只记条数，不回传内容（用户既定边界：临床项目内容不外显）。 */
  testCaseSubjectCount: number; dmCommentCount: number; dbdCommentCount: number;
}

export interface ManualReviewRule {
  id: string;
  sheet?: string;
  changeMark: ChangeMark | null;
  visits: string; formName: string;
  relatedFields: string; reportDescription: string; discrepancyText: string;
  logic: string;
  programming: ManualReviewProgramming | null;
  issues: string[];
}

export interface DynamicSpec {
  id: string;
  changeMark: ChangeMark | null;
  formName: string; fieldName: string; type: string;
  visits?: string; discrepancyText?: string; condition?: string;
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
    visits: asString(rec.visits),
    formName: asString(rec.formName ?? rec.form),
    targetField: asString(rec.targetField ?? rec.targetedField) || fieldList[0] || '',
    relatedFields: relatedRaw === undefined ? fieldList.slice(1) : asStringArray(relatedRaw),
    queryType: asString(rec.queryType),
    discrepancyText: asString(rec.discrepancyText ?? rec.message),
    logic: asString(rec.logic),
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
