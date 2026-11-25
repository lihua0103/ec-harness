/** dm_dvp_write_workbook 输入归一：把外部 documentJson 宽容归一为各区 IR。
 *  与 parse 端共享 rules.ts 语义；写出生成物一律 CANDIDATE。
 *  区值可为内联数组，也可为相对 directory 的文件引用（NDJSON：每行一个 JSON；或 JSON 数组文件）
 *  ——千级规则的全量物化靠 bulk 引用，不靠单轮内联。 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import {
  coerceChangeMark, coerceRuleInput, parseBool,
  validateCrossFieldRule, validateDynamic, validateFieldLevel,
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
  subjectStatus: SubjectStatusRow[];
  matrix: MatrixRow[];
  template: TemplateOptions;
}

export class InputError extends Error { constructor(readonly code: string) { super(code); } }

const SECTION_CAPS = {
  crossField: 2000, fieldLevel: 3000, manualReview: 2000, manualReviewProgramming: 2000, dynamic: 3000, versionHistory: 100,
  subjectStatus: 100, matrix: 300,
} as const;
type SectionKey = keyof typeof SECTION_CAPS;

/** 真实 DVP 实物中存在「受试者状态定义」页：状态名 + 【表单.字段】条件记法（V6.0 实物含此页）。 */
export interface SubjectStatusRow { status: string; condition: string; issues: string[]; }

/** Matrix 页：访视→该访视显示的表单矩阵行（V6.0 实物含此页）。 */
export interface MatrixRow { id: string; folder: string; oid: string; forms: string[]; issues: string[]; }

/** sheet 集/列的差量配置：公司内项目间形态有差量（V2.0 12 页 vs V6.0 10 页），模板不是单一形态。
 *  全部默认保留现有 8 页输出（既有测试契约不变）；V6.0 形态按需开启。 */
export interface TemplateOptions {
  /** 治理页顺序：默认 cover-first（现契约）；实物 V6.0 是 approval-first。 */
  governanceOrder?: 'cover-first' | 'approval-first';
  /** Edit Checks 是否含 Query Type 列（V2.0 实例有、V6.0 无）。默认 true。 */
  editChecksQueryType?: boolean;
  /** 字段级 sheet 名：默认 'Edit Checks(Field Level)'；V6.0 实物为 'Edit Checks Rave'。 */
  fieldLevelSheetName?: string;
  /** 是否生成 Manual Review for Programming 页（V6.0 实物无此页）。默认 true。 */
  includeProgramming?: boolean;
  /** 是否生成 Subject Status 页。默认 false（rows>0 时也自动生成）。 */
  includeSubjectStatus?: boolean;
  /** 是否生成 Matrix 页。默认 false（rows>0 时也自动生成）。 */
  includeMatrix?: boolean;
  /** Edit Checks 是否追加 Testcase Query Fired / not Fired 两列（DXP 实物 10 列形态，无 Query Type）。
   *  两列值按 UAT 纪律留空，由项目团队行内留档。默认 false。 */
  editChecksTestcaseColumns?: boolean;
  /** 字段级页列布局：'default' 为既有 11 列（含 IsLog）；'als' 为 ALS 实物 14 列布局
   *  （无 IsLog，尾接 Test Subject Number / Pass / Fail? / DM Comments / DBD Comments 四列且恒留空）。 */
  fieldLevelLayout?: 'default' | 'als';
  /** Manual Review 页顶部说明行（实物为给 Listing 程序员的注意事项文字块，逐行输出）。 */
  manualReviewNote?: string[];
  /** 按 sheet 名整行覆盖表头（对齐实物逐字节列形，含换行/尾随空格等脏字符；
   *  键=生成的 sheet 名，如 'Edit Checks'/'Manual Review'/'Dynamic'/'Version History'；
   *  列数须与该页旋钮语义一致，超出行按原语义写出不裁剪。 */
  sheetHeaders?: Record<string, string[]>;
  /** 差异文本尾词规范化（公司惯例如「请核查」）：写簿时对 Edit Checks 与 Manual Review 的差异文本
   *  统一为该尾词结尾（已含该尾词不动；以「请核实」结尾的旧文本替换为该尾词）。 */
  discrepancyTail?: string;
  /** B 列（Add/Delete/Update）渲染风格：'mark' 为既有 "Add/V1.0" 标记（默认，契约不变）；
   *  'version' 为实物形态——只写版本号数字（V1.0 → 1.0），无标记时留空。 */
  changeMarkStyle?: 'mark' | 'version';
  /** sheet 输出顺序按名单重排（名单外的 sheet 保持相对顺序排在其后）；如实物 ALS 在 Edit Checks 之前。 */
  sheetOrder?: string[];
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(code);
  return value as Record<string, unknown>;
}

export function coerceFieldLevel(value: unknown): FieldLevelSpec {
  const rec = asRecord(value, 'FIELD_LEVEL_NOT_OBJECT');
  const spec: FieldLevelSpec = {
    changeMark: coerceChangeMark(rec.changeMark),
    changeMarkRaw: typeof rec.changeMarkRaw === 'string' ? rec.changeMarkRaw : undefined,
    formOid: asString(rec.formOid), formName: asString(rec.formName), fieldOid: asString(rec.fieldOid),
    preText: asString(rec.preText), controlType: asString(rec.controlType), dataFormat: asString(rec.dataFormat),
    isLog: asBool(rec.isLog), isRequired: asBool(rec.isRequired),
    queryFutureDate: asBool(rec.queryFutureDate), queryNonConformance: asBool(rec.queryNonConformance),
    issues: [],
  };
  // 源模板原值透传：字符串原样保留（不 trim 不归一），写簿层原样输出；缺省走 boolText 归一。
  if (typeof rec.isLogRaw === 'string') spec.isLogRaw = rec.isLogRaw;
  if (typeof rec.isRequiredRaw === 'string') spec.isRequiredRaw = rec.isRequiredRaw;
  if (typeof rec.queryFutureDateRaw === 'string') spec.queryFutureDateRaw = rec.queryFutureDateRaw;
  if (typeof rec.queryNonConformanceRaw === 'string') spec.queryNonConformanceRaw = rec.queryNonConformanceRaw;
  const extraRaw = rec.extra ?? rec.extraCells;
  if (extraRaw !== undefined && extraRaw !== null) spec.extra = Array.isArray(extraRaw) ? extraRaw.map(asString) : [asString(extraRaw)];
  if (Array.isArray(rec.sourceCells)) spec.sourceCells = rec.sourceCells.map(asString);
  spec.issues = validateFieldLevel(spec);
  return spec;
}

export function coerceManualReview(value: unknown): ManualReviewRule {
  const rec = asRecord(value, 'MANUAL_REVIEW_NOT_OBJECT');
  const rule: ManualReviewRule = {
    id: asString(rec.id),
    changeMark: coerceChangeMark(rec.changeMark),
    changeMarkRaw: typeof rec.changeMarkRaw === 'string' ? rec.changeMarkRaw : undefined,
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
  const extraRaw = rec.extra ?? rec.extraCells;
  if (extraRaw !== undefined && extraRaw !== null) {
    rule.extra = Array.isArray(extraRaw) ? extraRaw.map((c) => asString(c)) : [asString(extraRaw)];
  }
  if (Array.isArray(rec.sourceCells)) rule.sourceCells = rec.sourceCells.map(asString);
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
    changeMarkRaw: typeof rec.changeMarkRaw === 'string' ? rec.changeMarkRaw : undefined,
    formName: asString(rec.formName ?? rec.crfPageDomain),
    fieldName: asString(rec.fieldName), type: asString(rec.type),
    visits: asString(rec.visits), discrepancyText: asString(rec.discrepancyText), condition: asString(rec.condition),
    issues: [],
  };
  if (Array.isArray(rec.extra)) spec.extra = rec.extra.map((v) => asString(v));
  else if (Array.isArray(rec.extraCells)) spec.extra = rec.extraCells.map((v) => asString(v));
  if (Array.isArray(rec.sourceCells)) spec.sourceCells = rec.sourceCells.map(asString);
  spec.issues = validateDynamic(spec);
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

/** 受试者状态行宽容归一：canonical 键 status/condition；别名 state/name→status、rule/criteria→condition。 */
export function coerceSubjectStatus(value: unknown): SubjectStatusRow {
  const rec = asRecord(value, 'SUBJECT_STATUS_NOT_OBJECT');
  const row: SubjectStatusRow = {
    status: asString(rec.status ?? rec.state ?? rec.name),
    condition: asString(rec.condition ?? rec.rule ?? rec.criteria),
    issues: [],
  };
  if (!row.status) row.issues.push('MISSING_STATUS');
  if (!row.condition) row.issues.push('MISSING_CONDITION');
  return row;
}

/** Matrix 行宽容归一：canonical 键 id/folder/oid/forms；别名 matrix/matrices→id、folrder→folder（实物表头拼写别名）、formList→forms；
 *  forms 可为数组或分号/换行分隔文本。 */
export function coerceMatrixRow(value: unknown): MatrixRow {
  const rec = asRecord(value, 'MATRIX_NOT_OBJECT');
  const rawForms = rec.forms ?? rec.formList;
  const forms = Array.isArray(rawForms)
    ? rawForms.map((f) => asString(f)).filter((f) => f !== '')
    : asString(rawForms).split(/[;\n；]/).map((s) => s.trim()).filter((s) => s !== '');
  const row: MatrixRow = {
    id: asString(rec.id ?? rec.matrix ?? rec.matrices),
    folder: asString(rec.folder ?? rec.folrder),
    oid: asString(rec.oid),
    forms,
    issues: [],
  };
  if (!row.id) row.issues.push('MISSING_MATRIX_ID');
  return row;
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
const MANUAL_REVIEW_KEYS = new Set(['id', 'changeMark', 'changeMarkRaw', 'visits', 'formName', 'form', 'relatedFields', 'relatedField', 'reportDescription', 'discrepancyText', 'message', 'logic', 'programming', 'extra', 'extraCells', 'sourceCells']);
const KNOWN_ITEM_KEYS: Record<SectionKey, ReadonlySet<string>> = {
  crossField: new Set(['id', 'changeMark', 'changeMarkRaw', 'visits', 'formName', 'form', 'targetField', 'targetedField', 'fields', 'relatedFields', 'relatedFieldsRaw', 'sourceCells', 'relatedField', 'queryType', 'discrepancyText', 'message', 'logic', 'testcaseFired', 'testcaseNotFired']),
  fieldLevel: new Set(['changeMark', 'changeMarkRaw', 'formOid', 'formName', 'fieldOid', 'preText', 'controlType', 'dataFormat', 'isLog', 'isRequired', 'queryFutureDate', 'queryNonConformance', 'isLogRaw', 'isRequiredRaw', 'queryFutureDateRaw', 'queryNonConformanceRaw', 'extra', 'extraCells', 'sourceCells']),
  manualReview: MANUAL_REVIEW_KEYS,
  manualReviewProgramming: MANUAL_REVIEW_KEYS,
  dynamic: new Set(['id', 'changeMark', 'changeMarkRaw', 'formName', 'crfPageDomain', 'fieldName', 'type', 'visits', 'discrepancyText', 'message', 'condition', 'extra', 'extraCells', 'sourceCells']),
  versionHistory: new Set(['version', 'date', 'modifiedBy', 'author', 'by', 'comments', 'change', 'description']),
  subjectStatus: new Set(['status', 'state', 'name', 'condition', 'rule', 'criteria']),
  matrix: new Set(['id', 'matrix', 'matrices', 'folder', 'folrder', 'oid', 'forms', 'formList']),
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
 *  区值可为内联数组或文件引用（见 readBulkItems）；bulk 来源以 bulkSources 回报（BULK_SOURCE）。
 *  未识别键（顶层/条目/项目级/template 级）合并记入 unknownKeys，不硬拒；写端以 notices 逐条暴露。 */
export function parseWorkbookInputJson(text: string, directory?: string): { input: WorkbookInput; unknownKeys: string[]; bulkSources: string[] } {
  if (text.length > 4_000_000) throw new InputError('DOCUMENT_PAYLOAD_TOO_LARGE');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new InputError('INVALID_DOCUMENT_JSON'); }
  const rec = asRecord(parsed, 'DOCUMENT_NOT_OBJECT');
  const bulkSources: string[] = [];
  const templateUnknown: string[] = [];
  const template = coerceTemplateOptions(rec.template, templateUnknown);
  const unknownList = [
    ...Object.keys(rec).filter((k) => !(k in SECTION_CAPS) && k !== 'project' && k !== 'template'),
    ...templateUnknown,
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
      }, directory, bulkSources) as CrossFieldRule[],
      fieldLevel: sectionOf(rec, 'fieldLevel', SECTION_CAPS.fieldLevel, (v) => { const s = coerceFieldLevel(v); if (s.issues.length) issues.fieldLevel = (issues.fieldLevel ?? 0) + 1; return s; }, directory, bulkSources) as FieldLevelSpec[],
      manualReview: sectionOf(rec, 'manualReview', SECTION_CAPS.manualReview, coerceManualReview, directory, bulkSources) as ManualReviewRule[],
      manualReviewProgramming: sectionOf(rec, 'manualReviewProgramming', SECTION_CAPS.manualReviewProgramming, coerceManualReview, directory, bulkSources) as ManualReviewRule[],
      dynamic: sectionOf(rec, 'dynamic', SECTION_CAPS.dynamic, coerceDynamic, directory, bulkSources) as DynamicSpec[],
      versionHistory: sectionOf(rec, 'versionHistory', SECTION_CAPS.versionHistory, coerceVersionRow, directory, bulkSources) as VersionRow[],
      subjectStatus: sectionOf(rec, 'subjectStatus', SECTION_CAPS.subjectStatus, coerceSubjectStatus, directory, bulkSources) as SubjectStatusRow[],
      matrix: sectionOf(rec, 'matrix', SECTION_CAPS.matrix, coerceMatrixRow, directory, bulkSources) as MatrixRow[],
      template,
    },
    unknownKeys,
    bulkSources,
  };
}

function unknownProjectKeys(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.keys(raw as Record<string, unknown>).filter((k) => !KNOWN_PROJECT_KEYS.has(k)).map((k) => `project.${k}`);
}

/** 区值为字符串时视为文件引用：NDJSON（每行一个 JSON，空行跳过）或 JSON 数组文件。
 *  必须落在 directory 内（realpath 归一防符号链接逃逸）；8MB 上限；坏行/缺文件/越界逐错误码上报。 */
const BULK_FILE_MAX_BYTES = 8_000_000;

function readBulkItems(directory: string, ref: string, cap: number, key: SectionKey): { items: unknown[]; notice: string } {
  let base: string;
  try { base = realpathSync(resolve(directory)); } catch { throw new InputError('BULK_DIRECTORY_NOT_FOUND'); }
  const target = resolve(base, ref);
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (target !== base && !target.startsWith(prefix)) throw new InputError('BULK_REF_OUTSIDE_DIRECTORY');
  let st: import('node:fs').Stats;
  try { st = statSync(target); } catch { throw new InputError('BULK_FILE_NOT_FOUND'); }
  if (!st.isFile()) throw new InputError('BULK_FILE_NOT_FOUND');
  if (st.size > BULK_FILE_MAX_BYTES) throw new InputError('BULK_FILE_TOO_LARGE');
  const text = readFileSync(target, 'utf8');
  let items: unknown[];
  if (text.trimStart().startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new InputError('BULK_FILE_BAD_JSON'); }
    if (!Array.isArray(parsed)) throw new InputError('BULK_FILE_NOT_ARRAY');
    items = parsed;
  } else {
    items = [];
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      try { items.push(JSON.parse(t)); } catch { throw new InputError(`BULK_FILE_BAD_LINE:${i + 1}`); }
    });
  }
  if (items.length > cap) throw new InputError(`SECTION_TOO_LARGE:${key}`);
  const rel = relative(base, target).replaceAll(sep, '/');
  return { items, notice: `BULK_SOURCE:${key}=${rel}(${items.length} rows)` };
}

const KNOWN_TEMPLATE_KEYS = new Set(['governanceOrder', 'editChecksQueryType', 'fieldLevelSheetName', 'includeProgramming', 'includeSubjectStatus', 'includeMatrix', 'editChecksTestcaseColumns', 'fieldLevelLayout', 'discrepancyTail', 'manualReviewNote', 'sheetHeaders', 'changeMarkStyle', 'sheetOrder']);

/** template 配置宽容归一：未知键上报（记 `template.键`）；非法治理顺序/表名硬拒。 */
function coerceTemplateOptions(raw: unknown, unknownOut: string[]): TemplateOptions {
  if (raw === undefined || raw === null) return {};
  const rec = asRecord(raw, 'TEMPLATE_NOT_OBJECT');
  for (const k of Object.keys(rec)) if (!KNOWN_TEMPLATE_KEYS.has(k)) unknownOut.push(`template.${k}`);
  const governanceOrder = (asString(rec.governanceOrder) || undefined) as TemplateOptions['governanceOrder'];
  if (governanceOrder && governanceOrder !== 'cover-first' && governanceOrder !== 'approval-first') throw new InputError('TEMPLATE_BAD_GOVERNANCE_ORDER');
  const fieldLevelSheetName = asString(rec.fieldLevelSheetName) || undefined;
  if (fieldLevelSheetName && (fieldLevelSheetName.length > 31 || /[\[\]:*?\\/]/.test(fieldLevelSheetName))) throw new InputError('INVALID_SHEET_NAME');
  const manualReviewNoteRaw = rec.manualReviewNote;
  if (manualReviewNoteRaw !== undefined && manualReviewNoteRaw !== null) {
    if (!Array.isArray(manualReviewNoteRaw) || manualReviewNoteRaw.length > 20 || manualReviewNoteRaw.some((l) => typeof l !== 'string' || l.length > 500)) {
      throw new InputError('TEMPLATE_BAD_MANUAL_REVIEW_NOTE');
    }
  }
  const fieldLevelLayout = (asString(rec.fieldLevelLayout) || undefined) as TemplateOptions['fieldLevelLayout'];
  if (fieldLevelLayout && fieldLevelLayout !== 'default' && fieldLevelLayout !== 'als') throw new InputError('TEMPLATE_BAD_FIELD_LEVEL_LAYOUT');
  const discrepancyTail = asString(rec.discrepancyTail) || undefined;
  if (discrepancyTail && discrepancyTail.length > 20) throw new InputError('TEMPLATE_BAD_DISCREPANCY_TAIL');
  const sheetHeadersRaw = rec.sheetHeaders;
  if (sheetHeadersRaw !== undefined && sheetHeadersRaw !== null) {
    if (typeof sheetHeadersRaw !== 'object' || Array.isArray(sheetHeadersRaw)) throw new InputError('TEMPLATE_BAD_SHEET_HEADERS');
    const entries = Object.entries(sheetHeadersRaw as Record<string, unknown>);
    if (entries.length > 12) throw new InputError('TEMPLATE_BAD_SHEET_HEADERS');
    for (const [k, v] of entries) {
      if (!Array.isArray(v) || v.length > 20 || v.some((c) => typeof c !== 'string' || c.length > 200)) {
        throw new InputError('TEMPLATE_BAD_SHEET_HEADERS');
      }
    }
  }
  const changeMarkStyle = (asString(rec.changeMarkStyle) || undefined) as TemplateOptions['changeMarkStyle'];
  if (changeMarkStyle && changeMarkStyle !== 'mark' && changeMarkStyle !== 'version') throw new InputError('TEMPLATE_BAD_CHANGE_MARK_STYLE');
  const sheetOrderRaw = rec.sheetOrder;
  if (sheetOrderRaw !== undefined && sheetOrderRaw !== null) {
    if (!Array.isArray(sheetOrderRaw) || sheetOrderRaw.length > 20 || sheetOrderRaw.some((l) => typeof l !== 'string' || l.length > 60)) {
      throw new InputError('TEMPLATE_BAD_SHEET_ORDER');
    }
  }
  return {
    governanceOrder,
    editChecksQueryType: asBool(rec.editChecksQueryType) ?? undefined,
    fieldLevelSheetName,
    includeProgramming: asBool(rec.includeProgramming) ?? undefined,
    includeSubjectStatus: asBool(rec.includeSubjectStatus) ?? undefined,
    includeMatrix: asBool(rec.includeMatrix) ?? undefined,
    editChecksTestcaseColumns: asBool(rec.editChecksTestcaseColumns) ?? undefined,
    fieldLevelLayout,
    manualReviewNote: manualReviewNoteRaw === undefined || manualReviewNoteRaw === null ? undefined : [...manualReviewNoteRaw as string[]],
    discrepancyTail,
    sheetHeaders: sheetHeadersRaw === undefined || sheetHeadersRaw === null
      ? undefined
      : Object.fromEntries(Object.entries(sheetHeadersRaw as Record<string, string[]>).map(([k, v]) => [k, [...v]])),
    changeMarkStyle,
    sheetOrder: sheetOrderRaw === undefined || sheetOrderRaw === null ? undefined : [...sheetOrderRaw as string[]],
  };
}

function sectionOf(input: Record<string, unknown>, key: SectionKey, cap: number, coerce: (v: unknown) => unknown, directory: string | undefined, bulkSources: string[]): unknown[] {
  const raw = input[key];
  if (raw === undefined || raw === null) return [];
  let items: unknown[];
  if (typeof raw === 'string') {
    if (!directory) throw new InputError(`BULK_REF_REQUIRES_DIRECTORY:${key}`);
    const bulk = readBulkItems(directory, raw, cap, key);
    items = bulk.items;
    bulkSources.push(bulk.notice);
  } else if (Array.isArray(raw)) {
    items = raw;
  } else {
    throw new InputError(`SECTION_NOT_ARRAY:${key}`);
  }
  if (items.length > cap) throw new InputError(`SECTION_TOO_LARGE:${key}`);
  return items.map((item) => coerce(item));
}
