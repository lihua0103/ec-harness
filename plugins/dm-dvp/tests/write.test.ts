import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { writeDvpWorkbook, readWrittenWorkbook, composeEditChecksHeaders, composeFieldLevelHeaders, changeMarkText } from '../src/write.js';
import { parseDvpWorkbook, overviewDvpWorkbook, DvpError } from '../src/parse.js';
import { InputError } from '../src/input.js';

const DOCUMENT = JSON.stringify({
  project: { studyCode: 'SYN-001', dvpVersion: 'V2.0' },
  crossField: [{
    id: 'EC-R01', changeMark: 'Add/V2.0', visits: 'All',
    formName: 'Adverse Event', targetField: 'AE End Date',
    relatedFields: ['AE Start Date'], queryType: 'Date',
    discrepancyText: 'End date precedes start date.',
    logic: 'fire when AE End Date < AE Start Date',
  }],
  fieldLevel: [{
    changeMark: { action: 'Add', version: 'V2.0' },
    formOid: 'AE', formName: 'Adverse Event', fieldOid: 'AEEND', preText: 'End Date',
    controlType: 'DateTime', dataFormat: 'dd MMM yyyy',
    isLog: false, isRequired: true, queryFutureDate: true, queryNonConformance: false,
  }],
  manualReview: [{
    id: 'MR-R01', visits: 'All', formName: 'Adverse Event',
    relatedFields: 'AE Term', reportDescription: 'Reviewer inspects duplicates.',
    discrepancyText: 'Potential duplicate.',
    logic: 'fire when AE Term is not missing',
  }],
  manualReviewProgramming: [{
    id: 'MRP-R01', visits: 'All', formName: 'Adverse Event',
    relatedFields: 'AE Term', reportDescription: 'Programmed review.',
    discrepancyText: 'Potential duplicate.', logic: 'fire when AE Term is not missing',
    programming: { assign: 'DMG', columnHeading: 'AE Listing' },
  }],
  dynamic: [{
    id: 'DY-R01', changeMark: 'Add/V2.0', formName: 'VS', fieldName: 'VSPOS', type: 'Dynamic Field',
    visits: 'All', discrepancyText: 'Position updates per visit.', condition: 'VSPOS = "STANDING"',
  }],
  versionHistory: [{ version: 'V2.0', date: '2026-11-10', modifiedBy: 'DM', comments: 'Synthetic draft.' }],
});

function withTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dm-dvp-write-'));
}

test('write→parse 往返：8 sheet、角色分类、各字段保真', async () => {
  const dir = withTempDir();
  try {
    const result = writeDvpWorkbook(dir, 'dvp-draft.xlsx', DOCUMENT);
    assert.equal(result.sheets.length, 8);
    assert.deepEqual(result.sheets.map((s) => s.name), [
      'Cover', 'DVP Approval Form', 'Version History', 'Edit Checks',
      'Edit Checks(Field Level)', 'Manual Review', 'Manual Review for Programming', 'Dynamic',
    ]);
    assert.equal(result.issues.crossField ?? 0, 0, '合规规则不应带诊断');
    assert.ok(result.notices.some((n) => n.startsWith('CANDIDATE')));

    const overview = await overviewDvpWorkbook(dir, 'dvp-draft.xlsx');
    assert.deepEqual(overview.sheets.map((s) => s.role), [
      'cover', 'approval', 'versionHistory', 'crossField', 'fieldLevel',
      'manualReview', 'manualReviewProgramming', 'dynamic',
    ]);

    const { document, stats } = await parseDvpWorkbook(dir, 'dvp-draft.xlsx');
    assert.equal(document.crossField[0].id, 'EC-R01');
    assert.deepEqual(document.crossField[0].changeMark, { action: 'Add', version: 'V2.0' });
    assert.deepEqual(document.crossField[0].relatedFields, ['AE Start Date']);
    assert.equal(document.crossField[0].logicParse?.status, 'structured');
    assert.equal(document.fieldLevel[0].isRequired, true);
    assert.equal(document.fieldLevel[0].isLog, false);
    assert.equal(document.fieldLevel[0].queryFutureDate, true);
    assert.equal(document.fieldLevel[0].changeMark?.action, 'Add');
    assert.equal(document.manualReview.length, 2);
    assert.equal(document.manualReview[0].programming, null);
    const programmed = document.manualReview.find((r) => r.programming);
    assert.equal(programmed?.programming?.assign, 'DMG');
    assert.equal(programmed?.programming?.testCaseSubjectCount, 0);
    assert.equal(document.dynamic[0].visits, 'All');
    assert.equal(document.dynamic[0].discrepancyText, 'Position updates per visit.');
    assert.equal(document.dynamic[0].condition, 'VSPOS = "STANDING"');
    assert.equal(document.versionHistory[0].version, 'V2.0');
    assert.equal(stats.sections.crossField?.total, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('写出边界：Cover 脚手架占位、UAT 三列留空、未知顶层键上报', async () => {
  const dir = withTempDir();
  try {
    const payload = JSON.stringify({
      crossField: [JSON.parse(JSON.stringify({ id: 'EC-R02', formName: 'VS', targetField: 'VSRES', queryType: 'Range', discrepancyText: 'Out of range.', logic: 'fire when VSRES > 3' }))],
      notASection: [1, 2, 3],
    });
    const result = writeDvpWorkbook(dir, 'draft2.xlsx', payload);
    assert.equal(result.notices.some((n) => n.includes('UNKNOWN_KEYS_IGNORED:notASection')), true);
    assert.equal(result.issues.crossField ?? 0, 0);
    const { document } = await parseDvpWorkbook(dir, 'draft2.xlsx');
    // 脚手架：Cover/Approval 无 project 元数据时全占位（由 dm-dvp 解析端按边界仍不读 Cover 内容）。
    const coverContent = document.sheets.find((s) => s.role === 'cover');
    assert.equal(coverContent?.note?.includes('CONTENT_NEVER_READ'), true);
    // UAT 三列留空的真断言在 round-trip：TEST CASE 数据行计数为 0。
    const buffer = readWrittenWorkbook(join(dir, 'draft2.xlsx'));
    assert.ok(buffer.length > 0);
    const parsed = await parseDvpWorkbook(dir, 'draft2.xlsx');
    assert.equal(parsed.document.manualReview.length, 0);
    assert.equal(parsed.document.dynamic.length, 0);
    assert.equal(parsed.document.crossField[0].logicParse?.status, 'structured');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('键名宽容归一：别名落表、条目级未知键逐条上报、issues 归零', async () => {
  const dir = withTempDir();
  try {
    // 复刻 e2e 中 agent 的自拟键名：form/fields/message + 真未知键 checkId/source；
    // versionHistory 用 author/change；project 用 name/registry。别名应归一落表，未知键应上报。
    const payload = JSON.stringify({
      project: { name: 'SYN Study', registry: 'NCT-SYN', sponsor: 'Sponsor X' },
      crossField: [{
        id: 'CF-A1', checkId: 'AGE-MIN', form: 'DM Demographics',
        fields: ['AGE', 'AGEGRP'], queryType: 'Custom',
        message: 'Age group inconsistent.', logic: "fire when AGE < 60 and AGEGRP = 'ELDERLY'",
        source: 'Protocol §4',
      }],
      versionHistory: [{ version: 'V0.1', date: '2026-11-10', author: 'DM Assistant', change: 'Candidate draft.' }],
    });
    const result = writeDvpWorkbook(dir, 'aliases.xlsx', payload);
    const unknownNotice = result.notices.find((n) => n.startsWith('UNKNOWN_KEYS_IGNORED'));
    assert.ok(unknownNotice, '应有 UNKNOWN_KEYS_IGNORED notice（checkId/source 是真未知键）');
    assert.ok(unknownNotice.includes('crossField[0].checkId'), unknownNotice);
    assert.ok(unknownNotice.includes('crossField[0].source'), unknownNotice);
    assert.ok(!unknownNotice.includes('registry') && !unknownNotice.includes('author'), '合法别名不应上报：' + unknownNotice);
    assert.equal(result.issues.crossField ?? 0, 0, '别名归一后不应再缺 formName/targetField/discrepancyText');
    const { document } = await parseDvpWorkbook(dir, 'aliases.xlsx');
    assert.equal(document.crossField[0].formName, 'DM Demographics');
    assert.equal(document.crossField[0].targetField, 'AGE');
    assert.deepEqual(document.crossField[0].relatedFields, ['AGEGRP']);
    assert.equal(document.crossField[0].discrepancyText, 'Age group inconsistent.');
    assert.equal(document.versionHistory[0].modifiedBy, 'DM Assistant');
    assert.equal(document.versionHistory[0].comments, 'Candidate draft.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('覆盖保护与目录边界', () => {
  const dir = withTempDir();
  try {
    writeDvpWorkbook(dir, 'same.xlsx', DOCUMENT);
    assert.throws(() => writeDvpWorkbook(dir, 'same.xlsx', DOCUMENT), (e: unknown) => e instanceof DvpError && e.code === 'OVERWRITE_NOT_ALLOWED');
    const second = writeDvpWorkbook(dir, 'same.xlsx', DOCUMENT, { overwrite: true });
    assert.equal(second.sheets.length, 8);
    assert.throws(() => writeDvpWorkbook(dir, join('..', 'escape.xlsx'), DOCUMENT), (e: unknown) => e instanceof DvpError && e.code === 'OUTPUT_OUTSIDE_DIRECTORY');
    assert.throws(() => writeDvpWorkbook(dir, 'draft.txt', DOCUMENT), (e: unknown) => e instanceof DvpError && e.code === 'OUTPUT_NOT_XLSX');
    assert.throws(() => writeDvpWorkbook(dir, 'nested/deep/draft.xlsx', DOCUMENT), (e: unknown) => e instanceof DvpError && e.code === 'OUTPUT_DIRECTORY_NOT_FOUND');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('同输入字节可复现（固定 mtime）', () => {
  const dirA = withTempDir();
  const dirB = withTempDir();
  try {
    const a = writeDvpWorkbook(dirA, 'a.xlsx', DOCUMENT);
    const b = writeDvpWorkbook(dirB, 'b.xlsx', DOCUMENT);
    assert.equal(a.sha256, b.sha256);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('Dynamic Type 枚举：越枚举计入 issues.dynamic 不静默，合法枚举零诊断', () => {
  const dir = withTempDir();
  try {
    // 合法枚举（DOCUMENT 夹具用 Dynamic Field）：dynamic 不带诊断。
    const ok = writeDvpWorkbook(dir, 'ok.xlsx', DOCUMENT);
    assert.equal(ok.issues.dynamic ?? 0, 0, '合法 Dynamic Type 不应带诊断');
    // 越枚举（Require/Show）：写出仍成功（不硬拒），但 issues.dynamic 如实计数。
    const bad = JSON.stringify({
      dynamic: [
        { id: 'DY-B01', formName: 'VS', fieldName: 'VSPOS', type: 'Require' },
        { id: 'DY-B02', formName: 'VS', fieldName: 'VSPOS2', type: 'Show' },
        { id: 'DY-B03', formName: 'VS', fieldName: 'VSPOS3', type: 'Derivation' },
      ],
    });
    const result = writeDvpWorkbook(dir, 'bad.xlsx', bad);
    assert.equal(result.issues.dynamic, 2, '两条越枚举应计入 issues.dynamic');
    assert.equal(result.sheets.find((s) => s.name === 'Dynamic')?.rows, 3, '越枚举不硬拒，仍写出供核对');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bulk 写入：NDJSON/JSON 数组文件引用展开，BULK_SOURCE 回报，越界/坏行/缺文件拒绝', () => {
  const dir = withTempDir();
  try {
    const ndjson = [
      { id: 'EC-B01', formName: 'AE', targetField: 'AEEND', relatedFields: ['AESTDT'], queryType: 'Missing', discrepancyText: 'AEEND 已提供，但 AESTDT 未提供。请核实。', logic: 'AEEND <> Null AND AESTDT = Null', visits: 'ALL' },
      { id: 'EC-B02', formName: 'LB', targetField: 'LBRES', queryType: 'Range', discrepancyText: 'LBRES 超出允许范围。请核实。', logic: 'LBRES > 10' },
      '',
      { id: 'EC-B03', formName: 'VS', targetField: 'VSRES', queryType: 'Custom', discrepancyText: 'VSRES 不等于 VSPOS，请核实。', logic: 'VSRES <> VSPOS' },
    ].map((r) => (r === '' ? '' : JSON.stringify(r))).join('\n');
    writeFileSync(join(dir, 'cross.ndjson'), ndjson, 'utf8');
    writeFileSync(join(dir, 'fields.json'), JSON.stringify([
      { formOid: 'AE', formName: 'AE', fieldOid: 'AEEND', isLog: false, isRequired: true, queryFutureDate: false, queryNonConformance: true },
    ]), 'utf8');
    const result = writeDvpWorkbook(dir, 'bulk.xlsx', JSON.stringify({ crossField: 'cross.ndjson', fieldLevel: 'fields.json' }));
    assert.equal(result.sheets.find((s) => s.name === 'Edit Checks')?.rows, 3, 'NDJSON 空行跳过后 3 条');
    assert.equal(result.sheets.find((s) => s.name === 'Edit Checks(Field Level)')?.rows, 1);
    assert.ok(result.notices.includes('BULK_SOURCE:crossField=cross.ndjson(3 rows)'), result.notices.join(' | '));
    assert.ok(result.notices.includes('BULK_SOURCE:fieldLevel=fields.json(1 rows)'));
    assert.throws(
      () => writeDvpWorkbook(dir, 'esc.xlsx', JSON.stringify({ crossField: '../outside.ndjson' })),
      (e: unknown) => e instanceof InputError && e.code === 'BULK_REF_OUTSIDE_DIRECTORY',
    );
    writeFileSync(join(dir, 'bad.ndjson'), '{"id":\n', 'utf8');
    assert.throws(
      () => writeDvpWorkbook(dir, 'bad.xlsx', JSON.stringify({ crossField: 'bad.ndjson' })),
      (e: unknown) => e instanceof InputError && e.code === 'BULK_FILE_BAD_LINE:1',
    );
    assert.throws(
      () => writeDvpWorkbook(dir, 'nf.xlsx', JSON.stringify({ crossField: 'missing.ndjson' })),
      (e: unknown) => e instanceof InputError && e.code === 'BULK_FILE_NOT_FOUND',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('模板差量配置（V6.0 形态）：approval-first、无 Query Type、Rave 页名、无 Programming 页、Subject Status/Matrix 页', () => {
  const dir = withTempDir();
  try {
    const payload = JSON.stringify({
      template: {
        governanceOrder: 'approval-first', editChecksQueryType: false,
        fieldLevelSheetName: 'Edit Checks Rave', includeProgramming: false,
        includeSubjectStatus: true, includeMatrix: true,
      },
      crossField: [{ id: 'SV_01', visits: '筛选期', formName: '知情同意书', targetField: '签署日期', discrepancyText: '访视日期早于知情同意书签署日期。请核实。', logic: '访视日期 < 【知情同意书.签署日期】' }],
      subjectStatus: [
        { status: 'Screening', condition: '【受试者信息.受试者筛选号】<> Null' },
        { status: 'Enrolled', condition: '【筛选/入组确认.计划入组】= 是' },
      ],
      matrix: [
        { id: 'DYN_VISIT_02', folder: '筛选期', oid: 'SCR', forms: ['实验室检查', 'KPS评分'] },
        { id: 'DYN_VISIT_C2D1', folder: '第2周期（Day1）', oid: 'C2D1', forms: ['甲状腺功能'] },
      ],
    });
    const result = writeDvpWorkbook(dir, 'v6-form.xlsx', payload);
    assert.deepEqual(result.sheets.map((s) => s.name), [
      'DVP Approval Form', 'Cover', 'Version History', 'Edit Checks', 'Edit Checks Rave',
      'Manual Review', 'Dynamic', 'Subject Status', 'Matrix',
    ]);
    assert.equal(result.sheets.find((s) => s.name === 'Subject Status')?.rows, 2);
    assert.equal(result.sheets.find((s) => s.name === 'Matrix')?.rows, 2, 'Matrix 行数不含表头');
    // 非法 sheet 名 / 非法治理顺序硬拒；未知 template 键上报
    assert.throws(
      () => writeDvpWorkbook(dir, 'bad-name.xlsx', JSON.stringify({ template: { fieldLevelSheetName: 'a/b' } })),
      (e: unknown) => e instanceof InputError && e.code === 'INVALID_SHEET_NAME',
    );
    assert.throws(
      () => writeDvpWorkbook(dir, 'bad-order.xlsx', JSON.stringify({ template: { governanceOrder: 'latest' } })),
      (e: unknown) => e instanceof InputError && e.code === 'TEMPLATE_BAD_GOVERNANCE_ORDER',
    );
    const tunk = writeDvpWorkbook(dir, 'tunk.xlsx', JSON.stringify({ template: { theme: 'dark' } }));
    assert.ok(tunk.notices.some((n) => n.includes('UNKNOWN_KEYS_IGNORED:template.theme')), tunk.notices.join(' | '));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Subject Status/Matrix 区有行时默认也生成对应页（无需 template 开关）；folrder 别名与 forms 文本分隔', () => {
  const dir = withTempDir();
  try {
    const payload = JSON.stringify({
      subjectStatus: [{ status: 'Screen Failed', condition: '【筛选/入组确认.入选标准】不满足' }],
      matrix: [{ id: 'DYN_VISIT_03', folrder: '肿瘤评估', oid: 'TUM', forms: '影像评估;疗效评估' }],
    });
    const result = writeDvpWorkbook(dir, 'ss.xlsx', payload);
    assert.equal(result.sheets.find((s) => s.name === 'Subject Status')?.rows, 1);
    assert.equal(result.sheets.find((s) => s.name === 'Matrix')?.rows, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DXP 实物形态旋钮：Testcase 两列、ALS 14 列布局、MR note 行、尾词规范化', () => {
  const dir = withTempDir();
  try {
    // 表头组装（与写簿同源）
    assert.deepEqual(composeEditChecksHeaders({ editChecksQueryType: false, editChecksTestcaseColumns: true }).slice(-2),
      ['Testcase Query Fired \r\n', 'Testcase Query not Fired '], '字节级原文：I 列尾随 CRLF+空格、J 列尾随空格');
    assert.equal(composeEditChecksHeaders({ editChecksQueryType: false, editChecksTestcaseColumns: true }).length, 10);
    assert.equal(composeEditChecksHeaders({}).length, 9, '默认契约不变：9 列含 Query Type');
    assert.equal(composeFieldLevelHeaders({ fieldLevelLayout: 'als' }).length, 14);
    assert.equal(composeFieldLevelHeaders({}).length, 11, '默认契约不变：11 列含 IsLog');
    assert.equal(composeFieldLevelHeaders({ fieldLevelLayout: 'als' })[0], 'Add/Delete/Update\r\n (applicable for database amendment)', '字节级原文：CRLF+前导空格');
    assert.equal(composeFieldLevelHeaders({ fieldLevelLayout: 'als' })[7], 'Is\r\nRequired\r\n(True/False)', '字节级原文：H1 三行折行');
    assert.equal(composeFieldLevelHeaders({ fieldLevelLayout: 'als' })[10], 'Test Subject Number ', '字节级原文：K1 尾随空格');

    const payload = JSON.stringify({
      template: {
        editChecksQueryType: false, editChecksTestcaseColumns: true,
        fieldLevelSheetName: 'ALS', fieldLevelLayout: 'als',
        manualReviewNote: ['Note for Listing Programmer:  1. 所有的Data listing的最初几列固定为：Protocol, Site, Subject, Visit;'],
        discrepancyTail: '请核查',
      },
      crossField: [{ id: 'IE_01', visits: '筛选期（D-14~D-1）', formName: '入选标准', targetField: '年龄', discrepancyText: '筛选年龄超出方案范围。请核实。', logic: '年龄 > 75' }],
      fieldLevel: [{ changeMark: { action: 'Add', version: 'V1.0' }, formOid: 'IE', formName: '入选标准', fieldOid: 'IEAGE', preText: '年龄', controlType: 'Text', dataFormat: '', isLog: false, isRequired: true, queryFutureDate: false, queryNonConformance: false }],
      manualReview: [{ id: 'MR_01', visits: 'ALL', formName: '血常规', relatedFields: 'WBC', reportDescription: '复核白细胞异常。', discrepancyText: '白细胞计数异常，请核实。', logic: '人工核查' }],
    });
    const result = writeDvpWorkbook(dir, 'dxp-form.xlsx', payload);
    assert.ok(result.sheets.find((s) => s.name === 'ALS'), 'fieldLevelSheetName=ALS 应生效');
    assert.ok(result.notices.every((n) => !n.startsWith('UNKNOWN_KEYS_IGNORED')), '新旋钮不应记未知键：' + result.notices.join(' | '));
    // 尾词规范化经 parse 往返校验（Edit Checks 差异文本列）
    return (async () => {
      const { document } = await parseDvpWorkbook(dir, 'dxp-form.xlsx');
      assert.equal(document.crossField[0].discrepancyText.endsWith('请核查'), true, document.crossField[0].discrepancyText);
      assert.equal(document.crossField[0].discrepancyText.includes('请核实'), false, '旧尾词应被替换');
    })();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fieldLevel bool 原值透传：源模板三列 raw 字面输出（消除 bool 归一残差）', async () => {
  const dir = withTempDir();
  try {
    const payload = JSON.stringify({
      template: { fieldLevelLayout: 'als' },
      fieldLevel: [
        { formOid: 'AE', formName: '不良事件', fieldOid: 'AETERM', preText: '不良事件名称', controlType: 'TextField', dataFormat: '$200',
          isRequired: true, queryFutureDate: false, queryNonConformance: false, isRequiredRaw: 'True', queryFutureDateRaw: 'False', queryNonConformanceRaw: 'False' },
        { formOid: 'AE', formName: '不良事件', fieldOid: 'AESTDAT', preText: '开始日期', controlType: 'DateTime', dataFormat: '',
          isRequired: true, queryFutureDate: false, queryNonConformance: true },
      ],
    });
    const result = writeDvpWorkbook(dir, 'raw-bool.xlsx', payload);
    assert.ok(result.notices.every((n) => !n.startsWith('UNKNOWN_KEYS_IGNORED')), 'raw 三键应为已知键：' + result.notices.join(' | '));
    const files = unzipSync(readWrittenWorkbook(join(dir, 'raw-bool.xlsx')));
    const sheetXml = Object.entries(files)
      .filter(([n]) => n.startsWith('xl/worksheets/'))
      .map(([, b]) => strFromU8(b))
      .find((x) => x.includes('AETERM'));
    assert.ok(sheetXml, 'ALS sheet XML 应存在');
    assert.equal(sheetXml.includes('>True<'), true, 'isRequiredRaw 字面 True 原样输出');
    assert.equal((sheetXml.match(/>True</g) ?? []).length, 1);
    assert.equal((sheetXml.match(/>False</g) ?? []).length, 2, 'queryFutureDateRaw/queryNonConformanceRaw 字面 False 原样输出');
    assert.equal((sheetXml.match(/>TRUE</g) ?? []).length, 2, '未传 raw 的行仍走 boolText 归一（契约不变；第 2 行 isRequired+queryNonConformance）');
    assert.equal((sheetXml.match(/>FALSE</g) ?? []).length, 1, '未传 raw 的行仍走 boolText 归一（契约不变）');
    const { document } = await parseDvpWorkbook(dir, 'raw-bool.xlsx');
    assert.equal(document.fieldLevel[0].isRequired, true);
    assert.equal(document.fieldLevel[1].isRequired, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('源模板原文通道：relatedFields 尾换行与 Dynamic extra 列逐字保留', () => {
  const dir = withTempDir();
  try {
    const payload = JSON.stringify({
      template: { changeMarkStyle: 'version' },
      crossField: [
        { id: 'EC-RAW-1', changeMark: { action: 'Update', version: 'v2.0' }, changeMarkRaw: 'Update-v2.0 ', formName: 'AE', targetField: 'AETERM', relatedFields: ['AEEND'], relatedFieldsRaw: 'AEEND\n', queryType: 'Custom', discrepancyText: 'Check.', logic: 'AETERM <> Null', sourceCells: ['EC-RAW-1', 'Update-v2.0 ', 'ALL', 'AE', 'AETERM', 'AEEND\n', 'Custom', 'Check.', 'AETERM <> Null'] },
        { id: 'EC-IR-1', formName: 'AE', targetField: 'AETERM', relatedFields: ['AEEND', 'AESEV'], queryType: 'Custom', discrepancyText: 'Check.', logic: 'AETERM <> Null' },
      ],
      dynamic: [{ id: 'DYN-RAW-1', changeMark: { action: 'Update', version: 'v3.0' }, changeMarkRaw: 'update-v3.0', formName: 'AE', fieldName: 'AETERM', type: 'Dynamic Field', extra: ['Template note\\r\\n'] }],
    });
    const result = writeDvpWorkbook(dir, 'raw-fields.xlsx', payload);
    assert.ok(result.notices.every((n) => !n.startsWith('UNKNOWN_KEYS_IGNORED')), result.notices.join(' | '));
    const files = unzipSync(readWrittenWorkbook(join(dir, 'raw-fields.xlsx')));
    const sheetXmls = Object.entries(files).filter(([n]) => n.startsWith('xl/worksheets/')).map(([, b]) => strFromU8(b));
    const ecXml = sheetXmls.find((x) => x.includes('EC-RAW-1'));
    const dynXml = sheetXmls.find((x) => x.includes('DYN-RAW-1'));
    assert.ok(ecXml?.includes('Update-v2.0 '), 'changeMarkRaw 不应用 version/style 归一');
    assert.ok(dynXml?.includes('update-v3.0'), 'Dynamic changeMarkRaw 原样透传');
    assert.ok(ecXml?.includes('AEEND\n</t>'), 'relatedFieldsRaw 保留尾换行');
    assert.ok(ecXml?.includes('AEEND\nAESEV'), '未提供 raw 时继续按 IR 列表换行 join');
    assert.ok(dynXml?.includes('Template note\\r\\n</t>'), 'Dynamic extra 按模板原序逐字追加');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('源模板字段级尾列：ALS extra 按原序透传', () => {
  const dir = withTempDir();
  try {
    const payload = JSON.stringify({
      template: { fieldLevelLayout: 'als', fieldLevelSheetName: 'Field Checks' },
      fieldLevel: [{ formOid: 'F1', formName: 'Form', fieldOid: 'ITEM', preText: 'Label', controlType: 'Text', dataFormat: '',
        isLog: false, isRequired: true, queryFutureDate: false, queryNonConformance: false,
        extra: ['Marker A', 'Marker B'] }],
    });
    const result = writeDvpWorkbook(dir, 'field-extra.xlsx', payload);
    assert.ok(result.notices.every((n) => !n.startsWith('UNKNOWN_KEYS_IGNORED')), result.notices.join(' | '));
    const files = unzipSync(readWrittenWorkbook(join(dir, 'field-extra.xlsx')));
    const xml = Object.entries(files).filter(([n]) => n.startsWith('xl/worksheets/')).map(([, b]) => strFromU8(b)).find((x) => x.includes('ITEM'));
    assert.ok(xml?.includes('Marker A'));
    assert.ok(xml?.includes('Marker B'));
    assert.ok(xml!.indexOf('Marker A') < xml!.indexOf('Marker B'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('旋钮非法值硬拒：fieldLevelLayout 非枚举、MR note 非字符串数组、尾词超长', () => {
  const dir = withTempDir();
  try {
    assert.throws(
      () => writeDvpWorkbook(dir, 'bad-layout.xlsx', JSON.stringify({ template: { fieldLevelLayout: 'dxp' } })),
      (e: unknown) => e instanceof InputError && e.code === 'TEMPLATE_BAD_FIELD_LEVEL_LAYOUT',
    );
    assert.throws(
      () => writeDvpWorkbook(dir, 'bad-note.xlsx', JSON.stringify({ template: { manualReviewNote: [1, 2] } })),
      (e: unknown) => e instanceof InputError && e.code === 'TEMPLATE_BAD_MANUAL_REVIEW_NOTE',
    );
    assert.throws(
      () => writeDvpWorkbook(dir, 'bad-tail.xlsx', JSON.stringify({ template: { discrepancyTail: 'x'.repeat(21) } })),
      (e: unknown) => e instanceof InputError && e.code === 'TEMPLATE_BAD_DISCREPANCY_TAIL',
    );
    assert.throws(
      () => writeDvpWorkbook(dir, 'bad-mrh.xlsx', JSON.stringify({ template: { sheetHeaders: '11列' } })),
      (e: unknown) => e instanceof InputError && e.code === 'TEMPLATE_BAD_SHEET_HEADERS',
    );
    assert.throws(
      () => writeDvpWorkbook(dir, 'bad-mrh2.xlsx', JSON.stringify({ template: { sheetHeaders: { 'Manual Review': { a: 1 } } } })),
      (e: unknown) => e instanceof InputError && e.code === 'TEMPLATE_BAD_SHEET_HEADERS',
    );
    assert.throws(
      () => writeDvpWorkbook(dir, 'bad-mrh3.xlsx', JSON.stringify({ template: { sheetHeaders: { 'Manual Review': ['x'.repeat(201)] } } })),
      (e: unknown) => e instanceof InputError && e.code === 'TEMPLATE_BAD_SHEET_HEADERS',
    );
    assert.throws(
      () => writeDvpWorkbook(dir, 'bad-cms.xlsx', JSON.stringify({ template: { changeMarkStyle: 'dxp' } })),
      (e: unknown) => e instanceof InputError && e.code === 'TEMPLATE_BAD_CHANGE_MARK_STYLE',
    );
    assert.throws(
      () => writeDvpWorkbook(dir, 'bad-order.xlsx', JSON.stringify({ template: { sheetOrder: 'ALS' } })),
      (e: unknown) => e instanceof InputError && e.code === 'TEMPLATE_BAD_SHEET_ORDER',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DXP r2 旋钮：testcase 值列、sheetHeaders 表头覆盖与 MR extra、version 风格 B 列、sheetOrder 重排', () => {
  const dir = withTempDir();
  try {
    // B 列渲染同源断言
    assert.equal(changeMarkText({ changeMarkStyle: 'version' }, { action: 'Add', version: 'V1.0' }), '1.0');
    assert.equal(changeMarkText({ changeMarkStyle: 'version' }, { action: 'Add', version: 'v2.1' }), '2.1');
    assert.equal(changeMarkText({ changeMarkStyle: 'version' }, null), '');
    assert.equal(changeMarkText({}, { action: 'Add', version: 'V1.0' }), 'Add/V1.0', '默认契约不变');

    const payload = JSON.stringify({
      template: {
        changeMarkStyle: 'version',
        sheetHeaders: {
          'Manual Review': ['Unique ID', '版本', '访视', '表单', '相关字段', '复核说明', '差异文本', '逻辑', 'Flag', 'Review Comments', 'Initial/Date'],
          'Edit Checks': ['Unique ID (provide by DBD)\r\n', 'Add/ Delete/ Update (applicable for database amendment)', 'Visit(s) Applied To\r\n', 'Form Name\r\n', 'Query Targeted Field\r\n', 'Related Field', 'Discrepancy Text Message\r\n', 'Logic\r\n', 'Testcase Query Fired \r\n', 'Testcase Query not Fired '],
          'Version History': ['Version\r\n版本', 'Version Date\r\n版本日期', 'Modified By\r\n更新者', 'Comments\r\n备注'],
        },
        sheetOrder: ['DVP Approval Form', 'Cover', 'Version History', 'ALS', 'Edit Checks', 'Manual Review', 'Dynamic'],
        fieldLevelSheetName: 'ALS',
        editChecksTestcaseColumns: true,
        includeProgramming: false,
      },
      crossField: [{ id: 'EC_01', changeMark: { action: 'Add', version: 'V1.0' }, formName: '访视日期', targetField: '访视日期', visits: '筛选期', discrepancyText: '计划访视日期外。', logic: '访视日期 > 计划访视日期上限', testcaseFired: '16 Feb 2021', testcaseNotFired: '17 Feb 2021' }],
      fieldLevel: [{ changeMark: { action: 'Add', version: 'V1.0' }, formOid: 'SV', formName: '访视日期', fieldOid: 'SVDATE', preText: '访视日期', controlType: 'DateTime', dataFormat: 'dd mmm yyyy', isLog: false, isRequired: true, queryFutureDate: false, queryNonConformance: false }],
      manualReview: [{ id: 'MR_01', visits: 'ALL', formName: '血常规', relatedFields: 'WBC', reportDescription: '复核白细胞。', discrepancyText: '白细胞异常。', logic: '人工核查', extraCells: ['Fail', 'WBC 偏高', 'XY 2021-03-01'] }],
    });
    const result = writeDvpWorkbook(dir, 'r2.xlsx', payload);
    assert.deepEqual(result.sheets.map((s) => s.name),
      ['DVP Approval Form', 'Cover', 'Version History', 'ALS', 'Edit Checks', 'Manual Review', 'Dynamic'],
      'sheetOrder 应把 ALS 排到 Edit Checks 前：' + result.sheets.map((s) => s.name).join(','));
    // 未传 manualReviewNote 时默认落 STD 公司便签行（1 note + 1 data），行数统计不含表头
    assert.equal(result.sheets.find((s) => s.name === 'Manual Review')?.rows, 2, '默认 STD 便签行应计入');
    assert.ok(result.notices.every((n) => !n.startsWith('UNKNOWN_KEYS_IGNORED')), '新键名应全部已知：' + result.notices.join(' | '));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
