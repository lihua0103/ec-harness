/** DVP 交付物写出：IR → 公司模板 8 sheet 工作簿（治理 3 + 规则 2 + 人工 2 + 系统功能 1）。
 *  纪律：生成物一律候选（CANDIDATE）；UAT 三列（TEST CASE / DM / DBD Comments）永远留空不伪填；
 *  辅助 sheet（Sheet2/分配/Sheet10/WpsReserved）不属于交付结构，不生成。 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { DvpError } from './parse.js';
import { serializeXlsx, type XlsxSheet } from './xlsx-out.js';
import { parseWorkbookInputJson, type WorkbookInput } from './input.js';

const PLACEHOLDER = '（由项目团队填写）';

function changeMarkText(mark: { action: string; version: string } | null): string {
  return mark ? `${mark.action}/${mark.version}` : '';
}

function boolText(value: boolean | null): string {
  return value === null ? '' : value ? 'TRUE' : 'FALSE';
}

const EDIT_CHECKS_HEADERS = [
  'Unique ID (provided by DBD)', 'Add/Delete/Update', 'Visit(s) Applied To', 'Form Name',
  'Query Targeted Field', 'Related Field', 'Query Type', 'Discrepancy Text Message', 'Logic',
];
const FIELD_LEVEL_HEADERS = [
  'Add/Delete/Update', 'FormOID', 'Form Name', 'FieldOID', 'PreText', 'ControlType', 'DataFormat',
  'IsLog', 'IsRequired', 'QueryFutureDate', 'QueryNonConformance',
];
const MANUAL_REVIEW_HEADERS = [
  'Unique ID', 'Add-Delete-Update', 'Visit(s) Applied To', 'Form Name', 'Related Fields',
  'Report Description', 'Discrepancy Text', 'Logic',
];
const MANUAL_PROGRAMMING_HEADERS = [
  'Unique ID', 'Add-Delete-Update', 'Visit(s) Applied To', 'Form Name', 'Related Fields',
  'Report Description', 'Discrepancy Text', 'Assign', 'Logic', 'Column Heading',
  'TEST CASE - Subject ID', 'DM Comments', 'DBD Comments',
];
const DYNAMIC_HEADERS = [
  'Unique ID', 'Add-Delete-Update', 'CRF Page-Domain', 'Field Name', 'Type',
  'Visits', 'Discrepancy Text', 'Condition(internal)',
];
const VERSION_HEADERS = ['Version', 'Version Date', 'Modified By', 'Comments'];

function coverRows(project: WorkbookInput['project']): string[][] {
  const label = (key: keyof NonNullable<WorkbookInput['project']>, fallback: string): string =>
    project && project[key] ? String(project[key]) : fallback;
  return [
    ['本工作簿由 dm-dvp 插件生成（候选 CANDIDATE），交付前由项目团队按公司模板复核、补全并签批。', ''],
    ['Study Code 研究编号', label('studyCode', PLACEHOLDER)],
    ['Study Title 研究名称', label('studyTitle', PLACEHOLDER)],
    ['Protocol No. 方案编号', label('protocolNumber', PLACEHOLDER)],
    ['Sponsor 申办方', label('sponsor', PLACEHOLDER)],
    ['DVP Version 版本', label('dvpVersion', PLACEHOLDER)],
    ['DVP Date 日期', label('dvpDate', PLACEHOLDER)],
    ['Drafted By 起草', label('createdBy', PLACEHOLDER)],
  ];
}

function approvalRows(): string[][] {
  const rows: string[][] = [['本签署页为脚手架：签署栏按公司流程由项目团队线下填写归档，插件不代填。', '']];
  for (const step of ['Drafted By 起草', 'Reviewed By (Data Management) 数据管理审核', 'Reviewed By (DBD) 数据库审核', 'Approved By 批准']) {
    rows.push([step, `${PLACEHOLDER} / ${PLACEHOLDER}`]);
  }
  return rows;
}

function buildSheets(input: WorkbookInput): XlsxSheet[] {
  const sheets: XlsxSheet[] = [
    { name: 'Cover', rows: coverRows(input.project) },
    { name: 'DVP Approval Form', rows: approvalRows() },
    {
      name: 'Version History',
      rows: [VERSION_HEADERS, ...input.versionHistory.map((r) => [r.version, r.date, r.modifiedBy, r.comments])],
    },
    {
      name: 'Edit Checks',
      rows: [EDIT_CHECKS_HEADERS, ...input.crossField.map((r) => [
        r.id, changeMarkText(r.changeMark), r.visits, r.formName, r.targetField,
        r.relatedFields.join('\n'), r.queryType, r.discrepancyText, r.logic,
      ])],
    },
    {
      name: 'Edit Checks(Field Level)',
      rows: [FIELD_LEVEL_HEADERS, ...input.fieldLevel.map((s) => [
        changeMarkText(s.changeMark), s.formOid, s.formName, s.fieldOid, s.preText, s.controlType, s.dataFormat,
        boolText(s.isLog), boolText(s.isRequired), boolText(s.queryFutureDate), boolText(s.queryNonConformance),
      ])],
    },
    {
      name: 'Manual Review',
      rows: [MANUAL_REVIEW_HEADERS, ...input.manualReview.map((r) => [
        r.id, changeMarkText(r.changeMark), r.visits, r.formName, r.relatedFields,
        r.reportDescription, r.discrepancyText, r.logic,
      ])],
    },
    {
      name: 'Manual Review for Programming',
      rows: [MANUAL_PROGRAMMING_HEADERS, ...input.manualReviewProgramming.map((r) => [
        r.id, changeMarkText(r.changeMark), r.visits, r.formName, r.relatedFields,
        r.reportDescription, r.discrepancyText, r.programming?.assign ?? '', r.logic,
        r.programming?.columnHeading ?? '', '', '', '',
      ])],
    },
    {
      name: 'Dynamic',
      rows: [DYNAMIC_HEADERS, ...input.dynamic.map((s) => [
        s.id, changeMarkText(s.changeMark), s.formName, s.fieldName, s.type,
        s.visits ?? '', s.discrepancyText ?? '', s.condition ?? '',
      ])],
    },
  ];
  return sheets;
}

function countIssues(input: WorkbookInput): Record<string, number> {
  const issues: Record<string, number> = {};
  const bump = (key: string, rules: Array<{ issues: string[] }>): void => {
    const n = rules.filter((r) => r.issues.length).length;
    if (n) issues[key] = n;
  };
  bump('crossField', input.crossField);
  bump('fieldLevel', input.fieldLevel);
  bump('manualReview', input.manualReview);
  bump('manualReviewProgramming', input.manualReviewProgramming);
  bump('dynamic', input.dynamic);
  return issues;
}

export interface WriteResult {
  outputPath: string;
  sha256: string;
  sheets: Array<{ name: string; rows: number }>;
  issues: Record<string, number>;
  notices: string[];
}

const NOTICES = [
  'CANDIDATE：生成工作簿为候选草稿，交付前必须由项目团队按公司模板复核、补全（含 Cover/Approval 签署）并走正式审批。',
  'UAT_COLUMNS_LEFT_EMPTY：TEST CASE / DM Comments / DBD Comments 永远留空，由项目团队行内留档，插件不伪填。',
  'AUXILIARY_SHEETS_NOT_GENERATED：Sheet2/分配/Sheet10/WpsReserved 等辅助 sheet 不属于交付结构，未生成。',
  'COVER_IS_SCAFFOLD：Cover 与 Approval 为脚手架占位，项目元数据仅回填调用方显式提供的 project 字段。',
];

/** 写出 DVP 草稿工作簿。outputPath 必须落在 directory 内；默认拒绝覆盖已存在文件。 */
export function writeDvpWorkbook(
  directory: string,
  outputPath: string,
  documentJson: string,
  options: { overwrite?: boolean } = {},
): WriteResult {
  let base: string;
  try { base = realpathSync(resolve(directory)); } catch { throw new DvpError('DIRECTORY_NOT_FOUND'); }
  const target = resolve(base, outputPath);
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (target !== base && !target.startsWith(prefix)) throw new DvpError('OUTPUT_OUTSIDE_DIRECTORY');
  if (!/\.xlsx$/i.test(target)) throw new DvpError('OUTPUT_NOT_XLSX');
  const parent = dirname(target);
  let parentOk = false;
  try { parentOk = statSync(parent).isDirectory(); } catch { parentOk = false; }
  if (!parentOk) throw new DvpError('OUTPUT_DIRECTORY_NOT_FOUND');
  if (existsSync(target) && !options.overwrite) throw new DvpError('OVERWRITE_NOT_ALLOWED');

  const { input, unknownKeys } = parseWorkbookInputJson(documentJson);
  const sheets = buildSheets(input);
  const buffer = serializeXlsx(sheets);
  mkdirSync(parent, { recursive: true });
  writeFileSync(target, buffer);
  return {
    outputPath: target,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    sheets: sheets.map((s) => ({ name: s.name, rows: Math.max(0, s.rows.length - 1) })),
    issues: countIssues(input),
    notices: [
      ...NOTICES,
      ...(unknownKeys.length ? [`UNKNOWN_KEYS_IGNORED:${unknownKeys.join(',')}`] : []),
    ],
  };
}

/** 冒烟辅助（测试用）：读取写出文件字节。 */
export function readWrittenWorkbook(path: string): Buffer {
  return readFileSync(path);
}
