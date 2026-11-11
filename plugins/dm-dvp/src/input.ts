/** dm_dvp_write_workbook 输入归一：把外部 documentJson 宽容归一为各区 IR。
 *  与 parse 端共享 rules.ts 语义；写出生成物一律 CANDIDATE。 */
import {
  coerceChangeMark, coerceRuleInput, parseBool,
  validateCrossFieldRule, validateFieldLevel,
  type CrossFieldRule, type DynamicSpec, type FieldLevelSpec, type ManualReviewRule, type VersionRow,
} from './rules.js';

const asString = (value: unknown): string => typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value).trim();
const asBool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : parseBool(asString(value));

export interface ProjectMeta {
  studyCode?: string; studyTitle?: string; protocolNumber?: string; sponsor?: string;
  dvpVersion?: string; dvpDate?: string; createdBy?: string;
}

export interface WorkbookInput {
  project?: ProjectMeta;
  crossField: CrossFieldRule[];
  fieldLevel: FieldLevelSpec[];
  manualReview: ManualReviewRule[];
  manualReviewProgramming: ManualReviewRule[];
  dynamic: DynamicSpec[];
  versionHistory: VersionRow[];
}

export class InputError extends Error { constructor(readonly code: string) { super(code); } }

const SECTION_CAPS = {
  crossField: 2000, fieldLevel: 3000, manualReview: 2000, manualReviewProgramming: 2000, dynamic: 3000, versionHistory: 100,
} as const;
type SectionKey = keyof typeof SECTION_CAPS;

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(code);
  return value as Record<string, unknown>;
}

export function coerceFieldLevel(value: unknown): FieldLevelSpec {
  const rec = asRecord(value, 'FIELD_LEVEL_NOT_OBJECT');
  const spec: FieldLevelSpec = {
    changeMark: coerceChangeMark(rec.changeMark),
    formOid: asString(rec.formOid), formName: asString(rec.formName), fieldOid: asString(rec.fieldOid),
    preText: asString(rec.preText), controlType: asString(rec.controlType), dataFormat: asString(rec.dataFormat),
    isLog: asBool(rec.isLog), isRequired: asBool(rec.isRequired),
    queryFutureDate: asBool(rec.queryFutureDate), queryNonConformance: asBool(rec.queryNonConformance),
    issues: [],
  };
  spec.issues = validateFieldLevel(spec);
  return spec;
}

export function coerceManualReview(value: unknown): ManualReviewRule {
  const rec = asRecord(value, 'MANUAL_REVIEW_NOT_OBJECT');
  const rule: ManualReviewRule = {
    id: asString(rec.id),
    changeMark: coerceChangeMark(rec.changeMark),
    visits: asString(rec.visits),
    formName: asString(rec.formName ?? rec.form),
    relatedFields: asString(rec.relatedFields),
    reportDescription: asString(rec.reportDescription),
    discrepancyText: asString(rec.discrepancyText),
    logic: asString(rec.logic),
    programming: null,
    issues: [],
  };
  if (rec.programming && typeof rec.programming === 'object' && !Array.isArray(rec.programming)) {
    const p = rec.programming as Record<string, unknown>;
    // 写出方向：TEST CASE / DM Comments / DBD Comments 永远留空（UAT 行内留档由项目团队执行），只接受 assign/columnHeading。
    rule.programming = {
      assign: asString(p.assign), columnHeading: asString(p.columnHeading),
      testCaseSubjectCount: 0, dmCommentCount: 0, dbdCommentCount: 0,
    };
  }
  if (!rule.id) rule.issues.push('MISSING_UNIQUE_ID');
  if (!rule.formName) rule.issues.push('MISSING_FORM_NAME');
  if (!rule.reportDescription && !rule.discrepancyText) rule.issues.push('MISSING_REVIEW_DESCRIPTION');
  return rule;
}

export function coerceDynamic(value: unknown): DynamicSpec {
  const rec = asRecord(value, 'DYNAMIC_NOT_OBJECT');
  const spec: DynamicSpec = {
    id: asString(rec.id),
    changeMark: coerceChangeMark(rec.changeMark),
    formName: asString(rec.formName ?? rec.crfPageDomain),
    fieldName: asString(rec.fieldName), type: asString(rec.type),
    visits: asString(rec.visits), discrepancyText: asString(rec.discrepancyText), condition: asString(rec.condition),
    issues: [],
  };
  if (!spec.id) spec.issues.push('MISSING_UNIQUE_ID');
  if (!spec.type) spec.issues.push('MISSING_TYPE');
  return spec;
}

/** 版本行宽容归一：canonical 键 version/date/modifiedBy/comments；别名 author/by→modifiedBy、change/description→comments。 */
export function coerceVersionRow(value: unknown): VersionRow {
  const rec = asRecord(value, 'VERSION_ROW_NOT_OBJECT');
  return {
    version: asString(rec.version), date: asString(rec.date),
    modifiedBy: asString(rec.modifiedBy ?? rec.author ?? rec.by),
    comments: asString(rec.comments ?? rec.change ?? rec.description),
  };
}

/** 项目元数据宽容归一：canonical 键见 KNOWN_PROJECT_KEYS；未识别键逐条上报，不静默丢弃。 */
export function coerceProject(value: unknown): ProjectMeta {
  const rec = asRecord(value, 'PROJECT_NOT_OBJECT');
  return {
    studyCode: asString(rec.studyCode ?? rec.code) || undefined,
    studyTitle: asString(rec.studyTitle ?? rec.name ?? rec.title) || undefined,
    protocolNumber: asString(rec.protocolNumber ?? rec.protocolNo ?? rec.registry) || undefined,
    sponsor: asString(rec.sponsor) || undefined,
    dvpVersion: asString(rec.dvpVersion ?? rec.version) || undefined,
    dvpDate: asString(rec.dvpDate ?? rec.date) || undefined,
    createdBy: asString(rec.createdBy ?? rec.author) || undefined,
  };
}

/** 逐条目未知键上报清单：canonical 键 + 已声明别名都算已知；其余记 `区[i].键`，不静默丢弃。 */
const MANUAL_REVIEW_KEYS = new Set(['id', 'changeMark', 'visits', 'formName', 'form', 'relatedFields', 'relatedField', 'reportDescription', 'discrepancyText', 'message', 'logic', 'programming']);
const KNOWN_ITEM_KEYS: Record<SectionKey, ReadonlySet<string>> = {
  crossField: new Set(['id', 'changeMark', 'visits', 'formName', 'form', 'targetField', 'targetedField', 'fields', 'relatedFields', 'relatedField', 'queryType', 'discrepancyText', 'message', 'logic']),
  fieldLevel: new Set(['changeMark', 'formOid', 'formName', 'fieldOid', 'preText', 'controlType', 'dataFormat', 'isLog', 'isRequired', 'queryFutureDate', 'queryNonConformance']),
  manualReview: MANUAL_REVIEW_KEYS,
  manualReviewProgramming: MANUAL_REVIEW_KEYS,
  dynamic: new Set(['id', 'changeMark', 'formName', 'crfPageDomain', 'fieldName', 'type', 'visits', 'discrepancyText', 'message', 'condition']),
  versionHistory: new Set(['version', 'date', 'modifiedBy', 'author', 'by', 'comments', 'change', 'description']),
};
const KNOWN_PROJECT_KEYS = new Set(['studyCode', 'code', 'studyTitle', 'name', 'title', 'protocolNumber', 'protocolNo', 'registry', 'sponsor', 'dvpVersion', 'version', 'dvpDate', 'date', 'createdBy', 'author']);

function unknownItemKeys(section: SectionKey, raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const known = KNOWN_ITEM_KEYS[section];
  const out: string[] = [];
  raw.forEach((item, i) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const k of Object.keys(item as Record<string, unknown>)) {
        if (!known.has(k)) out.push(`${section}[${i}].${k}`);
      }
    }
  });
  return out;
}

/** 解析写出入参 documentJson（上限 4MB；各区分条上限见 SECTION_CAPS）。
 *  未识别键（顶层/条目/项目级）合并记入 unknownKeys，不硬拒；写端以 notices 逐条暴露。 */
export function parseWorkbookInputJson(text: string): { input: WorkbookInput; unknownKeys: string[] } {
  if (text.length > 4_000_000) throw new InputError('DOCUMENT_PAYLOAD_TOO_LARGE');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new InputError('INVALID_DOCUMENT_JSON'); }
  const rec = asRecord(parsed, 'DOCUMENT_NOT_OBJECT');
  const unknownList = [
    ...Object.keys(rec).filter((k) => !(k in SECTION_CAPS) && k !== 'project'),
    ...(rec.project === undefined || rec.project === null ? [] : unknownProjectKeys(rec.project)),
    ...(Object.keys(SECTION_CAPS) as SectionKey[]).flatMap((key) => unknownItemKeys(key, rec[key])),
  ];
  const unknownKeys = unknownList.length > 80 ? [...unknownList.slice(0, 80), `(+${unknownList.length - 80} more)`] : unknownList;
  const issues: Record<string, number> = {};
  return {
    input: {
      project: rec.project === undefined || rec.project === null ? undefined : coerceProject(rec.project),
      crossField: sectionOf(rec, 'crossField', SECTION_CAPS.crossField, (v) => {
        const rule = coerceRuleInput(v);
        const enriched = { ...rule, issues: validateCrossFieldRule(rule) };
        if (enriched.issues.length) issues.crossField = (issues.crossField ?? 0) + 1;
        return enriched;
      }) as CrossFieldRule[],
      fieldLevel: sectionOf(rec, 'fieldLevel', SECTION_CAPS.fieldLevel, (v) => { const s = coerceFieldLevel(v); if (s.issues.length) issues.fieldLevel = (issues.fieldLevel ?? 0) + 1; return s; }) as FieldLevelSpec[],
      manualReview: sectionOf(rec, 'manualReview', SECTION_CAPS.manualReview, coerceManualReview) as ManualReviewRule[],
      manualReviewProgramming: sectionOf(rec, 'manualReviewProgramming', SECTION_CAPS.manualReviewProgramming, coerceManualReview) as ManualReviewRule[],
      dynamic: sectionOf(rec, 'dynamic', SECTION_CAPS.dynamic, coerceDynamic) as DynamicSpec[],
      versionHistory: sectionOf(rec, 'versionHistory', SECTION_CAPS.versionHistory, coerceVersionRow) as VersionRow[],
    },
    unknownKeys,
  };
}

function unknownProjectKeys(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.keys(raw as Record<string, unknown>).filter((k) => !KNOWN_PROJECT_KEYS.has(k)).map((k) => `project.${k}`);
}

function sectionOf(input: Record<string, unknown>, key: SectionKey, cap: number, coerce: (v: unknown) => unknown): unknown[] {
  const raw = input[key];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new InputError(`SECTION_NOT_ARRAY:${key}`);
  if (raw.length > cap) throw new InputError(`SECTION_TOO_LARGE:${key}`);
  return raw.map((item) => { const out = coerce(item); return out; });
}
