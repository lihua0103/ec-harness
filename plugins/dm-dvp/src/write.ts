/** DVP 交付物写出：IR → 公司模板工作簿（默认 8 sheet：治理 3 + 规则 2 + 人工 2 + 系统功能 1；
 *  template 配置可按实物差量去 Query Type 列/去 Programming 页/改字段级页名/加 Subject Status 与 Matrix 页/治理页换序）。
 *  纪律：生成物一律候选（CANDIDATE）；UAT 三列（TEST CASE / DM / DBD Comments）永远留空不伪填；
 *  辅助 sheet（Sheet2/分配/Sheet10/WpsReserved）不属于交付结构，不生成。 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { DvpError } from './parse.js';
import { serializeXlsx, type XlsxSheet } from './xlsx-out.js';
import { parseWorkbookInputJson, type TemplateOptions, type WorkbookInput } from './input.js';

const PLACEHOLDER = '（由项目团队填写）';

/** B 列渲染（写簿与测试同源）：'mark' 风格 "Add/V1.0"（既有契约）；'version' 风格（DXP 实物形态）只写版本号数字（V1.0→1.0），无标记留空。 */
export function changeMarkText(t: Pick<TemplateOptions, 'changeMarkStyle'>, mark: { action: string; version: string } | null): string {
  if (!mark) return '';
  return t.changeMarkStyle === 'version' ? mark.version.replace(/^v/i, '') : `${mark.action}/${mark.version}`;
}

function changeMarkCell(t: Pick<TemplateOptions, 'changeMarkStyle'>, rule: { changeMark: { action: string; version: string } | null; changeMarkRaw?: string }): string {
  return rule.changeMarkRaw ?? changeMarkText(t, rule.changeMark);
}

function boolText(value: boolean | string | null): string {
  if (value === null) return '';
  return typeof value === 'string' ? value : value ? 'TRUE' : 'FALSE';
}

const EDIT_CHECKS_HEADERS = [
  'Unique ID (provided by DBD)', 'Add/Delete/Update', 'Visit(s) Applied To', 'Form Name',
  'Query Targeted Field', 'Related Field', 'Query Type', 'Discrepancy Text Message', 'Logic',
];
const FIELD_LEVEL_HEADERS = [
  'Add/Delete/Update', 'FormOID', 'Form Name', 'FieldOID', 'PreText', 'ControlType', 'DataFormat',
  'IsLog', 'IsRequired', 'QueryFutureDate', 'QueryNonConformance',
];
/** DXP-604-101 实物 ALS 页 14 列表头——字节级原文（含换行与尾随空格，2026-11-21 repr 定谳；
 *  公司实物即此形态，含 "Is\r\nRequired\r\n(True/False)" 之类换行，不做"纠正"）。 */
const FIELD_LEVEL_HEADERS_ALS = [
  'Add/Delete/Update\r\n (applicable for database amendment)', 'FormOID', 'Form Name', 'FieldOID', 'PreText', 'ControlType', 'DataFormat',
  'Is\r\nRequired\r\n(True/False)', 'Query\r\nFuture\r\nDate\r\n(True / False)', 'Query\r\nNon-Conformance\r\n(True / False)',
  'Test Subject Number ', 'Pass / Fail?', 'DM Comments ', 'DBD Comments',
];
/** DXP 实物 Edit Checks 第 9/10 列表头——字节级原文（I 列尾随空格+字面 CRLF，J 列仅尾随空格；2026-11-22 原始字节定谳）。 */
const EDIT_CHECKS_TESTCASE_HEADERS = ['Testcase Query Fired \r\n', 'Testcase Query not Fired '];
/** DXP-604-101 实物 Manual Review 表头——字节级原文（字面 CRLF，2026-11-22 原始字节定谳；第 5 列为 Field Name）。 */
const MANUAL_REVIEW_HEADERS = [
  'Unique ID \r\n(provided by DBD)\r\n', 'Add/Delete/Update (applicable for database amendment)', 'Visits Applied To', 'Form Name', 'Field Name',
  'Report Description', 'Discrepancy Text Message', 'Logic',
];
/** DXP-604-101 实物 Manual Review 首行填写说明（公司标准模板文字，字面 CRLF）。 */
const MANUAL_REVIEW_NOTE_STD = [
  'Note for Listing Programmer: \r\n1. 所有的Data listing的最初几列固定为：Protocol, Site, Subject, Visit;\r\n2. 所有的Data listing的最后几列固定为：Flag (New/Old), Review Comments, Initial/Date\r\n3. Flag (New/Old)：所有与上一次Data Listing呈现的完全一致的记录标记为Old, 否则标记为New.',
];
const MANUAL_PROGRAMMING_HEADERS = [
  'Unique ID', 'Add-Delete-Update', 'Visit(s) Applied To', 'Form Name', 'Related Fields',
  'Report Description', 'Discrepancy Text', 'Assign', 'Logic', 'Column Heading',
  'TEST CASE - Subject ID', 'DM Comments', 'DBD Comments',
];
/** DXP-604-101 实物 Dynamic 页 8 列表头——字节级原文（col1 尾随字面 CRLF、"provide by DBD" 为公司拼写）。 */
const DYNAMIC_HEADERS = [
  'Unique ID (provide by DBD)\r\n', 'Add/Delete/Update (applicable for database amendment)', 'CRF Page / Domain Name', 'Field Name', 'Type',
  'Visits Applied To', 'Discrepancy Text Message', 'Condition ( For internal use)',
];
/** DXP 实物 Version History 表头——双语字节级原文（列内折行为字面 CRLF）。 */
const VERSION_HEADERS = ['Version\r\n版本', 'Version Date\r\n版本日期', 'Modified By\r\n更新者', 'Comments\r\n备注'];
/** DXP-604-101/V6.0 实物形态：Edit Checks 无 Query Type 列（8 列）——字节级原文（"provide by DBD" 公司拼写、
 *  "Add/ Delete/ Update" 空格、列尾字面 CRLF，2026-11-22 原始字节定谳）。 */
const EDIT_CHECKS_HEADERS_NO_QT = [
  'Unique ID (provide by DBD)\r\n', 'Add/ Delete/ Update (applicable for database amendment)', 'Visit(s) Applied To\r\n', 'Form Name\r\n',
  'Query Targeted Field\r\n', 'Related Field', 'Discrepancy Text Message\r\n', 'Logic\r\n',
];
/** V6.0 实物表头原文（含 folrder 拼写——公司实物即此拼法，不做"纠正"）。 */
const SUBJECT_STATUS_HEADERS = ['状态', '条件'];
const MATRIX_BASE_HEADERS = ['Matrices', 'folrder', 'OID'];

/** DXP-604-101 实物 Cover 版式（2026-11-22 原始字节定谳）：R3 标题（实物合并 A3:B3，行数组序列化不含合并）、
 *  R7-R10/R12-R14 七个标签字段（字节级原文，双语+冒号，标签内折行为字面 CRLF）。值列仅回填调用方显式提供的
 *  project 字段，人员签署栏永远留空占位。 */
function coverRows(project: WorkbookInput['project']): string[][] {
  const label = (key: keyof NonNullable<WorkbookInput['project']>, fallback: string): string =>
    project && project[key] ? String(project[key]) : fallback;
  const version = project?.dvpVersion ? String(project.dvpVersion) : PLACEHOLDER;
  const date = project?.dvpDate ? String(project.dvpDate) : '';
  return [
    ['', ''],
    ['', ''],
    ['Data Validation Plan\r\n数据核查计划', ''],
    ['', ''],
    ['', ''],
    ['', ''],
    ['Sponsor:\r\n申办方：', label('sponsor', PLACEHOLDER)],
    ['Protocol No:\r\n方案号：', label('protocolNumber', PLACEHOLDER)],
    ['WuXi Project ID:\r\nWuXi 项目ID：', label('studyCode', PLACEHOLDER)],
    ['DVP Version / Date:\r\n数据核查计划版本：', date ? `${version} / ${date}` : version],
    ['', ''],
    ['Lead Data Manager:\r\n数据管理经理：', PLACEHOLDER],
    ['Data Manager: \r\n数据管理员：', PLACEHOLDER],
    ['Lead Database Developer:\r\n数据库开发负责人：', PLACEHOLDER],
  ];
}

/** DXP-604-101 实物 Approval Form：R1 标题字节级原文；正文 28 处合并为绘图层网格（单元格标签不可读），
 *  按公司惯例以四角色签署行近似还原（A:F 六列宽度对齐实物合并跨度），签署栏永远留空由项目团队线下填写。 */
function approvalRows(): string[][] {
  const rows: string[][] = [['Data Validation Plan Approval Form\r\n数据核查计划审批表', '', '', '', '', '']];
  for (const role of ['Drafted By 起草', 'Reviewed By (Data Management) 数据管理审核', 'Reviewed By (DBD) 数据库审核', 'Approved By 批准']) {
    rows.push([role, '', '', '', '', '']);
  }
  return rows;
}

/** 组 Edit Checks 表头（写簿与测试同源）：Query Type 列由旋钮决定；DXP 实物 10 列形态另加 Testcase 两列。 */
export function composeEditChecksHeaders(t: Pick<TemplateOptions, 'editChecksQueryType' | 'editChecksTestcaseColumns'>): string[] {
  const showQueryType = t.editChecksQueryType !== false;
  const withTestcase = t.editChecksTestcaseColumns === true;
  return [
    ...(showQueryType ? EDIT_CHECKS_HEADERS : EDIT_CHECKS_HEADERS_NO_QT),
    ...(withTestcase ? EDIT_CHECKS_TESTCASE_HEADERS : []),
  ];
}

/** 组字段级页表头（写簿与测试同源）：default 11 列；als 布局 14 列（无 IsLog，尾四列恒留空）。 */
export function composeFieldLevelHeaders(t: Pick<TemplateOptions, 'fieldLevelLayout'>): string[] {
  return t.fieldLevelLayout === 'als' ? FIELD_LEVEL_HEADERS_ALS : FIELD_LEVEL_HEADERS;
}

/** 公司惯例尾词规范化：已含目标尾词不动；句尾既有「请核实/请核查」（含尾随标点）替换为新尾词；否则追加。
 *  DXP 实物差异文本形如「……，请核查。」（逗号+句号）：尾词自带逗号时，先把句尾既有逗号/句号归一，
 *  避免出现「。。」「，，」。 */
function applyTail(text: string, tail?: string): string {
  if (!tail) return text;
  const t = text.replace(/\s+$/, '');
  if (t.endsWith(tail)) return t;
  let base = t.replace(/(请核实|请核查)[。．.；;！!？?]*$/, '');
  if (/^[，,]/.test(tail)) base = base.replace(/[。，,]$/, '');
  return base + tail;
}

/** 按 sheet 名整行覆盖表头（template.sheetHeaders）：键=生成的 sheet 名；
 *  用于对齐实物逐字节列形（typo/换行/尾随空格），缺省仍用内建常量。 */
function headerFor(t: TemplateOptions, name: string, fallback: string[]): string[] {
  return t.sheetHeaders?.[name] ?? fallback;
}

function isReservedUatHeader(value: string | undefined): boolean {
  return /test\s*case\s*-\s*subject\s*id|testcase\s*(query\s*)?subject|dm comments|dbd comments/i.test(value ?? '');
}

function sourceCellRow(headers: string[], values: string[]): string[] {
  const width = Math.max(headers.length, values.length);
  return Array.from({ length: width }, (_, i) => isReservedUatHeader(headers[i]) ? '' : values[i] ?? '');
}

/** 按模板差量配置组 sheet。默认（无 template 配置）保持既有 8 页输出；V6.0 形态按需开启。 */
function buildSheets(input: WorkbookInput): XlsxSheet[] {
  const t = input.template;
  const showQueryType = t.editChecksQueryType !== false;
  const withTestcase = t.editChecksTestcaseColumns === true;
  const ecHeaders = headerFor(t, 'Edit Checks', composeEditChecksHeaders(t));
  const ecRow = (r: WorkbookInput['crossField'][number]): string[] => {
    if (r.sourceCells) return sourceCellRow(ecHeaders, r.sourceCells);
    const base = [r.id, changeMarkCell(t, r), r.visits, r.formName, r.targetField, r.relatedFieldsRaw ?? r.relatedFields.join('\n')];
    const body = showQueryType ? [...base, r.queryType, applyTail(r.discrepancyText, t.discrepancyTail), r.logic]
      : [...base, applyTail(r.discrepancyText, t.discrepancyTail), r.logic];
    return withTestcase ? [...body, r.testcaseFired ?? '', r.testcaseNotFired ?? ''] : body;
  };
  const dynamicName = t.dynamicSheetName ?? 'Dynamic';
  const sheets: XlsxSheet[] = [
    { name: 'Cover', rows: coverRows(input.project) },
    { name: 'DVP Approval Form', rows: approvalRows() },
    {
      name: 'Version History',
      rows: [headerFor(t, 'Version History', VERSION_HEADERS), ...input.versionHistory.map((r) => [r.version, r.date, r.modifiedBy, r.comments])],
    },
    {
      name: 'Edit Checks',
      rows: [ecHeaders, ...input.crossField.map(ecRow)],
    },
    {
      name: t.fieldLevelSheetName ?? 'Edit Checks(Field Level)',
      rows: t.fieldLevelLayout === 'als' ? (() => {
        const headers = headerFor(t, t.fieldLevelSheetName ?? 'Edit Checks(Field Level)', FIELD_LEVEL_HEADERS_ALS);
        return [
        headers,
        ...input.fieldLevel.map((s) => {
          if (s.sourceCells) return sourceCellRow(headers, s.sourceCells);
          const extra = s.extra ?? [];
          const width = Math.max(headers.length, 10 + extra.length);
          const cells = [
            changeMarkCell(t, s), s.formOid, s.formName, s.fieldOid, s.preText, s.controlType, s.dataFormat,
            s.isRequiredRaw ?? boolText(s.isRequired), s.queryFutureDateRaw ?? boolText(s.queryFutureDate), s.queryNonConformanceRaw ?? boolText(s.queryNonConformance),
            ...Array.from({ length: width - 10 }, () => ''),
          ];
          for (let i = 0; i < extra.length; i++) cells[10 + i] = extra[i];
          return cells;
        }),
        ];
      })() : [
        headerFor(t, t.fieldLevelSheetName ?? 'Edit Checks(Field Level)', FIELD_LEVEL_HEADERS), ...input.fieldLevel.map((s) => s.sourceCells ? sourceCellRow(headerFor(t, t.fieldLevelSheetName ?? 'Edit Checks(Field Level)', FIELD_LEVEL_HEADERS), s.sourceCells) : [
          changeMarkCell(t, s), s.formOid, s.formName, s.fieldOid, s.preText, s.controlType, s.dataFormat,
          boolText(s.isLogRaw ?? s.isLog), boolText(s.isRequiredRaw ?? s.isRequired), boolText(s.queryFutureDateRaw ?? s.queryFutureDate), boolText(s.queryNonConformanceRaw ?? s.queryNonConformance),
        ]),
      ],
    },
    {
      name: 'Manual Review',
      rows: (() => {
        const headers = t.sheetHeaders?.['Manual Review'] ?? MANUAL_REVIEW_HEADERS;
        return [
          ...(t.manualReviewNote ?? MANUAL_REVIEW_NOTE_STD).map((line) => [line]),
          headers,
          ...input.manualReview.map((r) => {
            const cells = r.sourceCells ? sourceCellRow(headers, r.sourceCells) : [
              r.id, changeMarkCell(t, r), r.visits, r.formName, r.relatedFields,
              applyTail(r.reportDescription, t.discrepancyTail), applyTail(r.discrepancyText, t.discrepancyTail), r.logic,
              ...(r.extra ?? []),
            ];
            return cells.length >= headers.length ? cells : [...cells, ...Array.from({ length: headers.length - cells.length }, () => '')];
          }),
        ];
      })(),
    },
    {
      name: 'Manual Review for Programming',
      rows: [headerFor(t, 'Manual Review for Programming', MANUAL_PROGRAMMING_HEADERS), ...input.manualReviewProgramming.map((r) => r.sourceCells ? sourceCellRow(headerFor(t, 'Manual Review for Programming', MANUAL_PROGRAMMING_HEADERS), r.sourceCells) : [
        r.id, changeMarkCell(t, r), r.visits, r.formName, r.relatedFields,
        r.reportDescription, r.discrepancyText, r.programming?.assign ?? '', r.logic,
        r.programming?.columnHeading ?? '', '', '', '',
      ])],
    },
    {
      name: dynamicName,
      rows: [headerFor(t, dynamicName, DYNAMIC_HEADERS), ...input.dynamic.map((s) => s.sourceCells ? sourceCellRow(headerFor(t, dynamicName, DYNAMIC_HEADERS), s.sourceCells) : [
        s.id, changeMarkCell(t, s), s.formName, s.fieldName, s.type,
        s.visits ?? '', s.discrepancyText ?? '', s.condition ?? '', ...(s.extra ?? []),
      ])],
    },
  ];
  if (t.includeProgramming === false) {
    const idx = sheets.findIndex((s) => s.name === 'Manual Review for Programming');
    if (idx >= 0) sheets.splice(idx, 1);
  }
  if (input.subjectStatus.length > 0 || t.includeSubjectStatus === true) {
    sheets.push({
      name: 'Subject Status',
      rows: [SUBJECT_STATUS_HEADERS, ...input.subjectStatus.map((r) => [r.status, r.condition])],
    });
  }
  if (input.matrix.length > 0 || t.includeMatrix === true) {
    const width = input.matrix.reduce((m, r) => Math.max(m, r.forms.length), 0);
    const headers = [...MATRIX_BASE_HEADERS, ...Array.from({ length: width }, () => '新增form')];
    sheets.push({
      name: 'Matrix',
      rows: [headers, ...input.matrix.map((r) => [
        r.id, r.folder, r.oid, ...r.forms, ...Array.from({ length: width - r.forms.length }, () => ''),
      ])],
    });
  }
  if (t.governanceOrder === 'approval-first') {
    const cover = sheets.findIndex((s) => s.name === 'Cover');
    const approval = sheets.findIndex((s) => s.name === 'DVP Approval Form');
    if (cover >= 0 && approval >= 0) [sheets[0], sheets[1]] = [sheets[1], sheets[0]];
  }
  if (t.sheetOrder) {
    const order = (name: string): number => {
      const i = t.sheetOrder!.indexOf(name);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    sheets.sort((a, b) => order(a.name) - order(b.name));
  }
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
  bump('subjectStatus', input.subjectStatus);
  bump('matrix', input.matrix);
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
  'COVER_COMPANY_LAYOUT：Cover/Approval 按公司实物版式生成；项目元数据仅回填调用方显式提供的 project 字段，签署栏永远留空。',
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

  const { input, unknownKeys, bulkSources } = parseWorkbookInputJson(documentJson, base);
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
      ...bulkSources,
      ...(unknownKeys.length ? [`UNKNOWN_KEYS_IGNORED:${unknownKeys.join(',')}`] : []),
    ],
  };
}

/** 冒烟辅助（测试用）：读取写出文件字节。 */
export function readWrittenWorkbook(path: string): Buffer {
  return readFileSync(path);
}
