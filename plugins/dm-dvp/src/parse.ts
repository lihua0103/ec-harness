/** 公司 DVP 工作簿解析：先分类 sheet 角色，再按列语义关键词映射生成规则 IR。
 *  结构适配不作为读取门槛（用户既定原则）：列名按关键词映射，缺失列记诊断不硬拒。
 *  数据边界随部署模式（data-boundary.ts）：
 *  - redacted（默认 / 混有外部模型的部署；docs/DVP-TEMPLATE-SCHEMA.md §8）：
 *      Cover 内容不读取；Approval 签署内容不读取；TEST CASE 受试者号与 DM/DBD 评审意见只计数，不回传；
 *  - full（模型目录全部为公司内部模型；2026-11-24 用户定调）：以上内容原值返回。
 *  - 未识别 sheet 在本工具里只记录存在（没有规则 IR 语义）；全量模式可经 dm_dvp_read_workbook 读取。 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Workbook, type AlsSheetContent } from '../../../packages/platform-workbook/src/index.js';
import {
  parseChangeMark, parseBool, splitList, validateCrossFieldRule, validateFieldLevel, withLogicParse,
  type CrossFieldRule, type DvpDocument, type DynamicSpec,
  type FieldLevelSpec, type ManualReviewProgramming, type ManualReviewRule, type VersionRow,
} from './rules.js';
import { DATA_BOUNDARY_FULL_NOTICE, fullAccess } from './data-boundary.js';

export class DvpError extends Error {
  constructor(readonly code: string, message?: string) { super(message ?? code); }
}

/** 脱敏模式的边界声明。 */
export const BOUNDARY_NOTICES = [
  'COVER_CONTENT_NEVER_READ：Cover sheet 内容永不读取。',
  'APPROVAL_SIGNATURES_NOT_READ：签署/审批 sheet 内容不读取。',
  'TEST_CASE_SUBJECTS_COUNTED_NOT_RETURNED：TEST CASE 受试者号与 DM/DBD 评审意见只计数，不回传内容。',
  'UNRECOGNIZED_SHEETS_PRESENCE_ONLY：未识别 sheet 仅记录存在，不读取。',
];

/** 当前部署模式的边界声明：调用时判定（env 覆盖即时生效）。 */
export function boundaryNotices(): string[] {
  return fullAccess() ? [DATA_BOUNDARY_FULL_NOTICE, 'UNRECOGNIZED_SHEETS_PRESENCE_ONLY：未识别 sheet 在本工具仅记录存在（可经 dm_dvp_read_workbook 读取）。'] : BOUNDARY_NOTICES;
}

export type SheetRole =
  | 'cover' | 'approval' | 'versionHistory' | 'crossField' | 'fieldLevel'
  | 'manualReview' | 'manualReviewProgramming' | 'dynamic' | 'unknown';

export function classifySheet(name: string): { role: SheetRole; readable: boolean; note?: string } {
  const text = name.trim();
  const full = fullAccess();
  if (/^cover$/i.test(text)) {
    return full ? { role: 'cover', readable: true } : { role: 'cover', readable: false, note: 'CONTENT_NEVER_READ（既定边界）' };
  }
  if (/approval/i.test(text)) {
    return full ? { role: 'approval', readable: true } : { role: 'approval', readable: false, note: 'SIGNATURE_CONTENT_NOT_READ（签署内容不读取）' };
  }
  if (/version|revision|history/i.test(text)) return { role: 'versionHistory', readable: true };
  if (/edit\s*checks?/i.test(text)) {
    return /field\s*level/i.test(text) ? { role: 'fieldLevel', readable: true } : { role: 'crossField', readable: true };
  }
  if (/manual\s*review/i.test(text)) {
    return /program/i.test(text) ? { role: 'manualReviewProgramming', readable: true } : { role: 'manualReview', readable: true };
  }
  if (/dynamic/i.test(text)) return { role: 'dynamic', readable: true };
  return { role: 'unknown', readable: false, note: 'UNRECOGNIZED_SHEET_PRESENCE_ONLY（仅记录存在）' };
}

/** 把调用方给的工作簿路径限定在操作者提供的目录内（真实路径比较，拒绝越界与非 .xlsx/.xlsm）。
 *  overview / parse 与通用读取（inputs.ts）共用同一条规则，不各写一份。 */
export function locateInsideDirectory(directory: string, workbookPath: string): string {
  let base: string;
  try { base = realpathSync(resolve(directory)); } catch { throw new DvpError('DIRECTORY_NOT_FOUND'); }
  const candidate = resolve(base, workbookPath);
  let real: string;
  try { real = realpathSync(candidate); } catch { throw new DvpError('WORKBOOK_NOT_FOUND'); }
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (real !== base && !real.startsWith(prefix)) throw new DvpError('WORKBOOK_OUTSIDE_DIRECTORY');
  const stat = statSync(real);
  if (!stat.isFile()) throw new DvpError('WORKBOOK_NOT_FILE');
  if (!/\.(xlsx|xlsm)$/i.test(real)) {
    throw new DvpError('WORKBOOK_NOT_XLSX', /\.xls$/i.test(real)
      ? '旧版 .xls（二进制 BIFF）不能直接读取；请在 Excel 中另存为 .xlsx 后重试'
      : '仅支持 .xlsx / .xlsm（OOXML）工作簿');
  }
  return real;
}

function columnOf(ref: string): { row: number; col: number } | null {
  const match = /^([A-Za-z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  if (!match) return null;
  const col = [...match[1]].reduce((n, c) => n * 26 + c.toUpperCase().charCodeAt(0) - 64, 0);
  return { row: Number(match[2]), col };
}

function gridOf(content: AlsSheetContent): Map<number, Map<number, string>> {
  const grid = new Map<number, Map<number, string>>();
  for (const cell of content.cells) {
    const position = columnOf(cell.ref);
    if (!position) continue;
    let rowMap = grid.get(position.row);
    if (!rowMap) grid.set(position.row, rowMap = new Map());
    // 公式单元格的缓存值不可得（workbook.ts 既定行为）：按空值处理，另在 sheet 报告计数提示。
    if (!rowMap.has(position.col)) rowMap.set(position.col, cell.formula ? '' : cell.value);
  }
  return grid;
}

/** 全量模式下治理页（Cover / Approval）的原值行列：行号升序、列为该页最大列索引、空单元格为 ''；上限 maxRows 行。 */
function rowsOf(content: AlsSheetContent, maxRows = 500): string[][] {
  const grid = gridOf(content);
  const rows = [...grid.keys()].sort((a, b) => a - b);
  const width = Math.max(0, ...[...grid.values()].flatMap((row) => [...row.keys()]));
  return rows.slice(0, maxRows).map((rowIndex) => {
    const rowMap = grid.get(rowIndex) ?? new Map<number, string>();
    return Array.from({ length: width }, (_, c) => rowMap.get(c + 1) ?? '');
  });
}

/** 按表头修正按 sheet 名字判出的角色（结构适配不作为读取门槛）。
 *  实物（2020 版 V1.0，529 行）：Rave 的字段级规格放在名为 "Edit Checks Rave" 的 sheet 里，名字命中
 *  "Edit Checks" 关键词被判成跨字段规则 → 目标字段/查询类型/逻辑等 5 列找不到，整页规则全空，且排在第一页。
 *  规则：对 crossField / fieldLevel 候选，比较表头与两套列规格各自的命中数，命中明显更多（≥4 且多于对方）
 *  的那套胜出；平手或都认不出表头时保留按名字的结果。 */
function roleByHeaders(grid: Map<number, Map<number, string>>, role: SheetRole): SheetRole {
  if (role !== 'crossField' && role !== 'fieldLevel') return role;
  const crossHits = extractTable(grid, CROSS_SPECS)?.columns.size ?? 0;
  const fieldHits = extractTable(grid, FIELD_LEVEL_SPECS)?.columns.size ?? 0;
  if (fieldHits >= 4 && fieldHits > crossHits) return 'fieldLevel';
  if (crossHits >= 4 && crossHits > fieldHits) return 'crossField';
  return role;
}

interface ColumnSpec { key: string; pattern: RegExp; }

/** 表头行识别：前 5 行内取“关键词命中数最多”的行（≥2 命中才算表）；平局取最先出现。 */
function extractTable(grid: Map<number, Map<number, string>>, specs: ColumnSpec[]): { columns: Map<string, number>; headerRow: number } | null {
  const maxRow = Math.min(5, Math.max(...[...grid.keys()], 0));
  let best: { columns: Map<string, number>; headerRow: number } | null = null;
  for (let row = 1; row <= maxRow; row++) {
    const rowMap = grid.get(row);
    if (!rowMap) continue;
    const columns = new Map<string, number>();
    for (const [col, header] of rowMap) {
      const text = String(header).trim();
      if (!text) continue;
      const spec = specs.find((s) => !columns.has(s.key) && s.pattern.test(text));
      if (spec) columns.set(spec.key, col);
    }
    if (!best || columns.size > best.columns.size) best = { columns, headerRow: row };
    if (best.columns.size === specs.length) break;
  }
  return best && best.columns.size >= 2 ? best : null;
}

interface RowRecord { row: number; get: (key: string) => string; }

function records(grid: Map<number, Map<number, string>>, columns: Map<string, number>, headerRow: number): RowRecord[] {
  const out: RowRecord[] = [];
  const rows = [...grid.keys()].sort((a, b) => a - b);
  for (const row of rows) {
    if (row <= headerRow) continue;
    const rowMap = grid.get(row);
    if (!rowMap) continue;
    const get = (key: string) => {
      const col = columns.get(key);
      return col === undefined ? '' : (rowMap.get(col) ?? '').trim();
    };
    // 全部映射列皆空 → 空行/页脚行，跳过（不产生幽灵规则）。
    if ([...columns.values()].every((col) => !(rowMap.get(col) ?? '').trim())) continue;
    out.push({ row, get });
  }
  return out;
}

function noteMissingColumns(note: string | undefined, columns: Map<string, number>, required: string[]): string {
  const missing = required.filter((key) => !columns.has(key));
  return [...(note ? [note] : []), ...missing.map((key) => `COLUMN_NOT_FOUND:${key}`)].join('; ');
}

const CROSS_SPECS: ColumnSpec[] = [
  { key: 'id', pattern: /unique\s*id/i },
  { key: 'changeMark', pattern: /add\s*[/&-]\s*delete/i },
  { key: 'visits', pattern: /visits?\s*applied/i },
  { key: 'formName', pattern: /form\s*name/i },
  { key: 'targetField', pattern: /target(ed)?\s*field/i },
  { key: 'relatedFields', pattern: /related\s*fields?/i },
  { key: 'queryType', pattern: /query\s*type/i },
  { key: 'discrepancy', pattern: /discrepancy/i },
  { key: 'logic', pattern: /\blogic\b/i },
];
const FIELD_LEVEL_SPECS: ColumnSpec[] = [
  { key: 'changeMark', pattern: /add\s*[/&-]\s*delete/i },
  { key: 'formOid', pattern: /form\s*oid/i },
  { key: 'formName', pattern: /form\s*name/i },
  { key: 'fieldOid', pattern: /field\s*oid/i },
  { key: 'preText', pattern: /pre[\s-]*text/i },
  { key: 'controlType', pattern: /control\s*type/i },
  { key: 'dataFormat', pattern: /data\s*format/i },
  { key: 'isLog', pattern: /is\s*log/i },
  { key: 'isRequired', pattern: /is\s*required/i },
  { key: 'queryFutureDate', pattern: /future\s*date/i },
  { key: 'queryNonConformance', pattern: /non-?\s*conformance/i },
];
const MANUAL_REVIEW_SPECS: ColumnSpec[] = [
  { key: 'id', pattern: /unique\s*id/i },
  { key: 'changeMark', pattern: /add\s*[/&-]\s*delete/i },
  { key: 'visits', pattern: /visits?\s*applied|visits?/i },
  { key: 'formName', pattern: /form\s*name/i },
  { key: 'relatedFields', pattern: /related\s*fields?/i },
  { key: 'reportDescription', pattern: /report\s*description/i },
  { key: 'discrepancy', pattern: /discrepancy/i },
  { key: 'logic', pattern: /\blogic\b/i },
  { key: 'assign', pattern: /assign/i },
  { key: 'columnHeading', pattern: /column\s*heading/i },
  // 脱敏模式只计数（内容不进入返回值）；全量模式随 programming.testCase/dmComment/dbdComment 原值返回。
  { key: 'testCase', pattern: /test\s*case/i },
  { key: 'dmComment', pattern: /\bdm\s*comment/i },
  { key: 'dbdComment', pattern: /\bdbd\s*comment/i },
];
const DYNAMIC_SPECS: ColumnSpec[] = [
  { key: 'id', pattern: /unique\s*id/i },
  { key: 'changeMark', pattern: /add\s*[/&-]\s*delete/i },
  { key: 'formName', pattern: /form\s*name|crf\s*page|page\s*-?\s*domain/i },
  { key: 'fieldName', pattern: /field\s*name/i },
  { key: 'type', pattern: /\btype\b/i },
  { key: 'visits', pattern: /visits?\s*applied|visits?/i },
  { key: 'discrepancy', pattern: /discrepancy/i },
  { key: 'condition', pattern: /condition/i },
];
const VERSION_SPECS: ColumnSpec[] = [
  { key: 'version', pattern: /version/i },
  { key: 'date', pattern: /date/i },
  { key: 'modifiedBy', pattern: /modified\s*by/i },
  { key: 'comments', pattern: /comments?/i },
];

/** DvpDocument 内嵌的逻辑解析只保留 status/fields/diagnostics（AST 不进文档，控制返回体积）。 */
function slimLogic(rule: CrossFieldRule): CrossFieldRule {
  return rule.logicParse
    ? { ...rule, logicParse: { status: rule.logicParse.status, fields: rule.logicParse.fields, diagnostics: rule.logicParse.diagnostics } }
    : rule;
}

function buildCrossField(recs: RowRecord[]): CrossFieldRule[] {
  return recs.map((rec) => {
    const rule: CrossFieldRule = {
      id: rec.get('id'),
      changeMark: parseChangeMark(rec.get('changeMark')),
      visits: rec.get('visits'),
      formName: rec.get('formName'),
      targetField: rec.get('targetField'),
      relatedFields: splitList(rec.get('relatedFields')),
      queryType: rec.get('queryType'),
      discrepancyText: rec.get('discrepancy'),
      logic: rec.get('logic'),
      issues: [],
    };
    rule.issues = validateCrossFieldRule(rule);
    return slimLogic(withLogicParse(rule));
  });
}

function buildFieldLevel(recs: RowRecord[]): FieldLevelSpec[] {
  return recs.map((rec) => {
    const spec: FieldLevelSpec = {
      changeMark: parseChangeMark(rec.get('changeMark')),
      formOid: rec.get('formOid'), formName: rec.get('formName'), fieldOid: rec.get('fieldOid'),
      preText: rec.get('preText'), controlType: rec.get('controlType'), dataFormat: rec.get('dataFormat'),
      isLog: parseBool(rec.get('isLog')), isRequired: parseBool(rec.get('isRequired')),
      queryFutureDate: parseBool(rec.get('queryFutureDate')), queryNonConformance: parseBool(rec.get('queryNonConformance')),
      issues: [],
    };
    spec.issues = validateFieldLevel(spec);
    return spec;
  });
}

function countEntries(value: string): number {
  return value ? value.split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean).length : 0;
}

function buildManualReview(recs: RowRecord[], sheetName: string, isProgramming: boolean): ManualReviewRule[] {
  return recs.map((rec) => {
    let programming: ManualReviewProgramming | null = null;
    if (isProgramming) {
      // 受试者号与评审意见：只统计条数，字符串内容到此为止，不进入返回对象。
      programming = {
        assign: rec.get('assign'),
        columnHeading: rec.get('columnHeading'),
        testCaseSubjectCount: countEntries(rec.get('testCase')),
        dmCommentCount: countEntries(rec.get('dmComment')),
        dbdCommentCount: countEntries(rec.get('dbdComment')),
        // 全量模式（公司内部模型部署）：原值一并返回；脱敏模式到此为止，字符串内容不进入返回对象。
        ...(fullAccess() ? { testCase: rec.get('testCase'), dmComment: rec.get('dmComment'), dbdComment: rec.get('dbdComment') } : {}),
      };
    }
    const rule: ManualReviewRule = {
      id: rec.get('id'),
      sheet: sheetName,
      changeMark: parseChangeMark(rec.get('changeMark')),
      visits: rec.get('visits'),
      formName: rec.get('formName'),
      relatedFields: rec.get('relatedFields'),
      reportDescription: rec.get('reportDescription'),
      discrepancyText: rec.get('discrepancy'),
      logic: rec.get('logic'),
      programming,
      issues: [],
    };
    if (!rule.id) rule.issues.push('MISSING_UNIQUE_ID');
    if (!rule.formName) rule.issues.push('MISSING_FORM_NAME');
    if (!rule.reportDescription && !rule.discrepancyText) rule.issues.push('MISSING_REVIEW_DESCRIPTION');
    return rule;
  });
}

function buildDynamic(recs: RowRecord[]): DynamicSpec[] {
  return recs.map((rec) => {
    const spec: DynamicSpec = {
      id: rec.get('id'),
      changeMark: parseChangeMark(rec.get('changeMark')),
      formName: rec.get('formName'),
      fieldName: rec.get('fieldName'),
      type: rec.get('type'),
      visits: rec.get('visits'),
      discrepancyText: rec.get('discrepancy'),
      condition: rec.get('condition'),
      issues: [],
    };
    if (!spec.id) spec.issues.push('MISSING_UNIQUE_ID');
    if (!spec.type) spec.issues.push('MISSING_TYPE');
    return spec;
  });
}

function buildVersionHistory(recs: RowRecord[]): VersionRow[] {
  return recs.map((rec) => ({
    version: rec.get('version'), date: rec.get('date'),
    modifiedBy: rec.get('modifiedBy'), comments: rec.get('comments'),
  }));
}

export interface SheetReport {
  name: string; sheetId: string; visibility: string; role: string;
  note?: string; warnings?: string[]; formulaCells?: number; records?: number;
  /** 仅全量模式的 Cover / Approval：该页原值行列（上限 500 行）。 */
  content?: string[][];
}
export interface SectionStats { total: number; returned: number; offset: number; nextOffset: number | null; }
export type DvpSection = 'crossField' | 'fieldLevel' | 'manualReview' | 'dynamic' | 'versionHistory';
export interface PagingStats { total: number; offset: number; returned: number; nextOffset: number | null; }
export interface ParseStats {
  sections: Record<string, SectionStats>;
  /** Cursor for each returned document array; continue with the same section + nextOffset. */
  paging: Record<DvpSection, PagingStats>;
  sheets: SheetReport[];
  boundaryNotice: string[];
}
export interface ParseResult { document: DvpDocument; stats: ParseStats; }
export interface ParseOptions { limit?: number; offset?: number; section?: DvpSection; }

export interface OverviewSheet { name: string; sheetId: string; path: string; visibility: string; role: string; readable: boolean; note?: string; }
export interface OverviewResult { workbookPath: string; sha256: string; sheets: OverviewSheet[]; boundaryNotice: string[]; }

export async function overviewDvpWorkbook(directory: string, workbookPath: string): Promise<OverviewResult> {
  const real = locateInsideDirectory(directory, workbookPath);
  const buffer = readFileSync(real);
  const workbook = await Workbook.open(buffer);
  try {
    const sheets = await workbook.listSheets();
    return {
      workbookPath: real,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      sheets: sheets.map((sheet) => {
        const classified = classifySheet(sheet.name);
        return {
          name: sheet.name, sheetId: sheet.id, path: sheet.path, visibility: sheet.visibility,
          role: classified.role, readable: classified.readable, ...(classified.note ? { note: classified.note } : {}),
        };
      }),
      boundaryNotice: boundaryNotices(),
    };
  } finally { workbook.close(); }
}

interface SectionResult<T> { report: Pick<SheetReport, 'note' | 'warnings' | 'formulaCells' | 'records'>; items: T[]; }

function parseSection<T>(
  content: AlsSheetContent, specs: ColumnSpec[], requiredColumns: string[],
  build: (recs: RowRecord[]) => T[],
): SectionResult<T> {
  const grid = gridOf(content);
  const table = extractTable(grid, specs);
  const report: Pick<SheetReport, 'note' | 'warnings' | 'formulaCells' | 'records'> = {};
  const formulaCells = content.cells.filter((cell) => cell.formula).length;
  if (formulaCells) report.formulaCells = formulaCells;
  if (content.warnings.length) report.warnings = content.warnings;
  if (!table) {
    report.note = noteMissingColumns(undefined, new Map(), requiredColumns) || 'HEADERS_NOT_RECOGNIZED（前 5 行未识别出表头）';
    return { report, items: [] };
  }
  report.note = noteMissingColumns(undefined, table.columns, requiredColumns) || undefined;
  const recs = records(grid, table.columns, table.headerRow);
  report.records = recs.length;
  return { report, items: build(recs) };
}

export async function parseDvpWorkbook(directory: string, workbookPath: string, options: ParseOptions = {}): Promise<ParseResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new DvpError('PAGING_OFFSET_INVALID', String(offset));
  if (offset > 0 && !options.section) throw new DvpError('PAGING_SECTION_REQUIRED', 'offset 需要同时指定 section');
  if (options.section && !['crossField', 'fieldLevel', 'manualReview', 'dynamic', 'versionHistory'].includes(options.section)) {
    throw new DvpError('PAGING_SECTION_INVALID', String(options.section));
  }
  const real = locateInsideDirectory(directory, workbookPath);
  const buffer = readFileSync(real);
  const workbook = await Workbook.open(buffer);
  try {
    const sheets = await workbook.listSheets();
    const document: DvpDocument = {
      workbookPath: real,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      sheets: [], versionHistory: [], crossField: [], fieldLevel: [], manualReview: [], dynamic: [],
    };
    const collected: Record<DvpSection, unknown[]> = {
      crossField: [], fieldLevel: [], manualReview: [], dynamic: [], versionHistory: [],
    };
    const roleItems: Record<string, unknown[]> = {};
    const stats: ParseStats = {
      sections: {},
      paging: {
        crossField: { total: 0, offset: 0, returned: 0, nextOffset: null },
        fieldLevel: { total: 0, offset: 0, returned: 0, nextOffset: null },
        manualReview: { total: 0, offset: 0, returned: 0, nextOffset: null },
        dynamic: { total: 0, offset: 0, returned: 0, nextOffset: null },
        versionHistory: { total: 0, offset: 0, returned: 0, nextOffset: null },
      },
      sheets: [], boundaryNotice: boundaryNotices(),
    };
    const bump = (section: string, total: number): void => {
      const current = stats.sections[section] ?? { total: 0, returned: 0, offset: 0, nextOffset: null };
      current.total += total;
      stats.sections[section] = current;
    };
    const collect = (section: DvpSection, role: string, items: unknown[]): void => {
      collected[section].push(...items);
      (roleItems[role] ??= []).push(...items);
      bump(role, items.length);
    };
    for (const sheet of sheets) {
      const classified = classifySheet(sheet.name);
      const report: SheetReport = { name: sheet.name, sheetId: sheet.id, visibility: sheet.visibility, role: classified.role };
      if (classified.note) report.note = classified.note;
      document.sheets.push({
        name: sheet.name, sheetId: sheet.id, visibility: sheet.visibility, role: classified.role,
        ...(classified.note ? { note: classified.note } : {}),
      });
      if (!classified.readable) { stats.sheets.push(report); continue; }
      const content = await workbook.readWorksheet(sheet.id);
      if (classified.role === 'cover' || classified.role === 'approval') {
        // 全量模式下的治理页：没有规则 IR 语义，原值行列直接附在 sheet 报告里（上限 500 行）
        report.content = rowsOf(content);
        stats.sheets.push(report);
        continue;
      }
      // 按表头修正按名字判出的角色（见 roleByHeaders）：旧版模板的 "Edit Checks Rave" 名字像跨字段规则，
      // 表头却是字段级规格；不改的话 5 列找不到、整页规则全空。
      const role = roleByHeaders(gridOf(content), classified.role);
      let roleNote: string | undefined;
      if (role !== classified.role) {
        report.role = role;
        roleNote = `ROLE_BY_HEADER：sheet 名像 ${classified.role}，按表头识别为 ${role}`;
        const entry = document.sheets[document.sheets.length - 1];
        if (entry && entry.sheetId === sheet.id) entry.role = role;
      }
      switch (role) {
        case 'crossField': {
          const { report: sectionReport, items } = parseSection(content, CROSS_SPECS, ['id', 'formName', 'targetField', 'queryType', 'discrepancy', 'logic'], buildCrossField);
          Object.assign(report, sectionReport);
          collect('crossField', role, items);
          break;
        }
        case 'fieldLevel': {
          const { report: sectionReport, items } = parseSection(content, FIELD_LEVEL_SPECS, ['formOid', 'fieldOid', 'formName'], buildFieldLevel);
          Object.assign(report, sectionReport);
          collect('fieldLevel', role, items);
          break;
        }
        case 'manualReview':
        case 'manualReviewProgramming': {
          const isProgramming = classified.role === 'manualReviewProgramming';
          const { report: sectionReport, items } = parseSection(content, MANUAL_REVIEW_SPECS, ['id', 'formName'],
            (recs) => buildManualReview(recs, sheet.name, isProgramming));
          Object.assign(report, sectionReport);
          collect('manualReview', classified.role, items);
          break;
        }
        case 'dynamic': {
          const { report: sectionReport, items } = parseSection(content, DYNAMIC_SPECS, ['id', 'formName', 'type'], buildDynamic);
          Object.assign(report, sectionReport);
          collect('dynamic', classified.role, items);
          break;
        }
        case 'versionHistory': {
          const { report: sectionReport, items } = parseSection(content, VERSION_SPECS, ['version'], buildVersionHistory);
          Object.assign(report, sectionReport);
          collect('versionHistory', classified.role, items);
          break;
        }
        default:
          break;
      }
      // 列解析的 note 会覆盖 report.note：角色修正的说明放在最前面保留下来
      if (roleNote) report.note = roleNote + (report.note ? `；${report.note}` : '');
      stats.sheets.push(report);
    }
    const sections: DvpSection[] = ['crossField', 'fieldLevel', 'manualReview', 'dynamic', 'versionHistory'];
    const pageSets = new Map<DvpSection, Set<unknown>>();
    for (const section of sections) {
      const all = collected[section];
      const selectable = options.section === undefined || options.section === section;
      const start = options.section === section ? offset : 0;
      const page = selectable ? all.slice(start, start + limit) : [];
      pageSets.set(section, new Set(page));
      stats.paging[section] = {
        total: all.length, offset: start, returned: page.length,
        nextOffset: selectable && start + page.length < all.length ? start + page.length : null,
      };
      (document as unknown as Record<string, unknown[]>)[section] = page;
    }
    for (const [role, items] of Object.entries(roleItems)) {
      const section: DvpSection = role === 'manualReviewProgramming' ? 'manualReview' : role as DvpSection;
      const page = pageSets.get(section) ?? new Set();
      const sectionStats = stats.sections[role];
      if (sectionStats) {
        sectionStats.offset = stats.paging[section].offset;
        sectionStats.nextOffset = stats.paging[section].nextOffset;
        sectionStats.returned = items.filter((item) => page.has(item)).length;
      }
    }
    for (const section of sections) {
      const sectionStats = stats.sections[section];
      if (sectionStats) {
        sectionStats.offset = stats.paging[section].offset;
        sectionStats.nextOffset = stats.paging[section].nextOffset;
        sectionStats.returned = pageSets.get(section)!.size;
      }
    }
    return { document, stats };
  } finally { workbook.close(); }
}
