import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDvpWorkbook, overviewDvpWorkbook, classifySheet, DvpError } from '../src/parse.js';
import { makeWorkbook } from './fixtures/make-xlsx.js';

const SHEETS = [
  { name: 'Cover', rows: [['CONFIDENTIAL_COVER_CANARY']] },
  { name: 'Version History', rows: [
    ['Version', 'Date', 'Modified By', 'Comments'],
    ['2.0', '2026-08-14', 'DM Lead', 'V2.0 full issue'],
  ] },
  { name: 'Edit Checks', rows: [
    ['Unique ID', 'Add/Delete/Update', 'Visits Applied To', 'Form Name', 'Query Targeted Field', 'Related Field', 'Query Type', 'Discrepancy Text Message', 'Logic'],
    ['EC-001', 'Add/V2.0', 'V1, V2', 'AE', 'AE Start Date', 'AE End Date', 'Date', 'Start date must not precede end date.', 'fire when AE Start Date > AE End Date'],
    ['EC-002', '', 'V1', 'DMSTD', 'DMSTDTC', '', 'Missing', 'DMSTDTC is required.', 'fire when DMSTDTC is missing'],
    ['EC-003', '', 'V1', 'LB', 'LB Value', 'LB Unit', 'Range', 'Value out of range.', 'fire when LB Value > 10'],
    ['EC-004', '', 'V1', 'AE', 'AE Serious', '', 'Custom', 'Seriousness criteria review.', 'fire when review the seriousness per manual'],
  ] },
  { name: 'Edit Checks(Field Level)', rows: [
    ['Form OID', 'Form Name', 'Field OID', 'Pre-Text', 'Control Type', 'Data Format', 'Is Log', 'Is Required', 'Query Future Date', 'Query Non Conformance'],
    ['AE', 'Adverse Events', 'AESTDT', 'Start Date', 'Date Picker', 'DD-MMM-YYYY', 'FALSE', 'TRUE', 'TRUE', 'FALSE'],
  ] },
  { name: 'Manual Review for DM', rows: [
    ['Unique ID', 'Visits Applied To', 'Form Name', 'Related Fields', 'Report Description', 'Discrepancy Text Message'],
    ['MR-001', 'V1', 'AE', 'AE Term', 'Reviewer inspects duplicate patterns.', 'Potential duplicate identified.'],
  ] },
  { name: 'Manual Review for Programming', rows: [
    ['Unique ID', 'Assign To', 'Logic', 'Column Heading', 'TEST CASE - Subject ID', 'DM Comment', 'DBD Comment'],
    ['MRP-001', 'DATA MGMT', 'fire when AE Term = "SYNTERM" AND AE Date = "SYNDATE"', 'AE Listing', 'SUBJ-001\nSUBJ-002', 'review note one', ''],
  ] },
  { name: 'Dynamic', rows: [
    ['Unique ID', 'Form Name', 'Field Name', 'Type', 'Visits', 'Discrepancy Text', 'Condition(internal)'],
    ['DY-001', 'VS', 'VSPOS', 'Format', 'All', 'Value changes per visit.', 'VSPOS = "STANDING"'],
  ] },
  { name: 'Approval Form', rows: [['SIGNATURE_CANARY', 'Synthetic Name', 'Role']] },
  { name: 'Extra Notes', rows: [['UNKNOWN_CANARY']] },
];

function withTempWorkbook(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dm-dvp-parse-'));
  writeFileSync(join(directory, 'dvp.xlsx'), makeWorkbook(SHEETS));
  return directory;
}

test('overview：先分类后读取，Cover/未知 sheet 标记不可读且不触碰内容', async () => {
  const directory = withTempWorkbook();
  const overview = await overviewDvpWorkbook(directory, 'dvp.xlsx');
  assert.equal(overview.sheets.length, SHEETS.length);
  const cover = overview.sheets.find((s) => s.name === 'Cover');
  assert.equal(cover?.role, 'cover');
  assert.equal(cover?.readable, false);
  const unknown = overview.sheets.find((s) => s.name === 'Extra Notes');
  assert.equal(unknown?.role, 'unknown');
  assert.equal(unknown?.readable, false);
  const checks = overview.sheets.find((s) => s.name === 'Edit Checks');
  assert.equal(checks?.role, 'crossField');
  const fieldLevel = overview.sheets.find((s) => s.name === 'Edit Checks(Field Level)');
  assert.equal(fieldLevel?.role, 'fieldLevel');
  assert.match(overview.sha256, /^[0-9a-f]{64}$/);
});

test('classifySheet：名称分类规则', () => {
  assert.equal(classifySheet('Cover').role, 'cover');
  assert.equal(classifySheet('Approval Form').role, 'approval');
  assert.equal(classifySheet('Version History').role, 'versionHistory');
  assert.equal(classifySheet('Edit Checks').role, 'crossField');
  assert.equal(classifySheet('Edit Checks (Field Level)').role, 'fieldLevel');
  assert.equal(classifySheet('Manual Review for DM').role, 'manualReview');
  assert.equal(classifySheet('Manual Review for Programming').role, 'manualReviewProgramming');
  assert.equal(classifySheet('Dynamic').role, 'dynamic');
  assert.equal(classifySheet('Scratch Pad').role, 'unknown');
});

test('parse：规则 IR 完整解析、fire-when 结构化、变更标记与列表拆分', async () => {
  const directory = withTempWorkbook();
  const { document, stats } = await parseDvpWorkbook(directory, 'dvp.xlsx');
  assert.equal(document.crossField.length, 4);
  const first = document.crossField[0];
  assert.equal(first.id, 'EC-001');
  assert.deepEqual(first.changeMark, { action: 'Add', version: 'V2.0' });
  assert.equal(first.queryType, 'Date');
  assert.deepEqual(first.relatedFields, ['AE End Date']);
  assert.equal(first.logicParse?.status, 'structured');
  assert.deepEqual(first.logicParse?.fields, ['AE Start Date', 'AE End Date']);
  assert.deepEqual(first.issues, []);
  const missing = document.crossField[1];
  assert.equal(missing.queryType, 'Missing');
  assert.equal(document.crossField[3].logicParse?.status, 'freeform');

  // 字段级布尔解析
  assert.equal(document.fieldLevel.length, 1);
  const spec = document.fieldLevel[0];
  assert.equal(spec.isLog, false);
  assert.equal(spec.isRequired, true);
  assert.equal(spec.queryFutureDate, true);
  assert.equal(spec.queryNonConformance, false);
  assert.deepEqual(spec.issues, []);

  // 人工评审两 sheet 汇入同一区；programming 记录 assign 且带 sheet 来源
  assert.equal(document.manualReview.length, 2);
  assert.equal(document.manualReview[0].programming, null);
  assert.equal(document.manualReview[1].sheet, 'Manual Review for Programming');
  assert.equal(document.manualReview[1].programming?.assign, 'DATA MGMT');

  // 动态与版本历史
  assert.equal(document.dynamic[0].type, 'Format');
  assert.equal(document.dynamic[0].visits, 'All');
  assert.equal(document.dynamic[0].discrepancyText, 'Value changes per visit.');
  assert.equal(document.dynamic[0].condition, 'VSPOS = "STANDING"');
  assert.equal(document.versionHistory[0].version, '2.0');

  // 分区统计
  assert.equal(stats.sections.crossField?.total, 4);
  assert.equal(stats.sections.fieldLevel?.total, 1);
  assert.equal(stats.sections.manualReview?.total, 1);
  assert.equal(stats.sections.manualReviewProgramming?.total, 1);
  assert.equal(stats.sections.versionHistory?.total, 1);
});

test('边界（不可协商）：Cover/签署/未知 sheet/受试者号/评审意见内容均不出现在任何返回值', async () => {
  const directory = withTempWorkbook();
  const { document, stats } = await parseDvpWorkbook(directory, 'dvp.xlsx');
  const serialized = JSON.stringify({ document, stats });
  for (const canary of ['CONFIDENTIAL_COVER_CANARY', 'SIGNATURE_CANARY', 'UNKNOWN_CANARY', 'SUBJ-001', 'SUBJ-002', 'review note one']) {
    assert.ok(!serialized.includes(canary), `泄漏：${canary}`);
  }
  const programming = document.manualReview.find((rule) => rule.programming);
  assert.equal(programming?.programming?.testCaseSubjectCount, 2);
  assert.equal(programming?.programming?.dmCommentCount, 1);
  assert.equal(programming?.programming?.dbdCommentCount, 0);
  // 未识别 sheet / Cover / Approval 仍记录存在与角色
  assert.ok(document.sheets.some((sheet) => sheet.name === 'Extra Notes' && sheet.role === 'unknown'));
  assert.ok(document.sheets.some((sheet) => sheet.name === 'Cover' && sheet.role === 'cover'));
});

test('limit 分页：返回截断、聚合覆盖全量', async () => {
  const directory = withTempWorkbook();
  const { document, stats } = await parseDvpWorkbook(directory, 'dvp.xlsx', { limit: 2 });
  assert.equal(document.crossField.length, 2);
  assert.equal(stats.sections.crossField?.total, 4);
  assert.equal(stats.sections.crossField?.returned, 2);
  assert.equal(stats.paging.crossField.returned, 2);
  assert.equal(stats.paging.crossField.nextOffset, 2);
});

test('真分页：section + offset 可继续读取且不重不漏', async () => {
  const directory = withTempWorkbook();
  const full = await parseDvpWorkbook(directory, 'dvp.xlsx', { limit: 1000 });
  const first = await parseDvpWorkbook(directory, 'dvp.xlsx', { limit: 2, section: 'crossField' });
  assert.deepEqual(first.document.crossField.map((r) => r.id), ['EC-001', 'EC-002']);
  assert.equal(first.document.fieldLevel.length, 0, 'section selection does not leak other sections');
  assert.equal(first.stats.paging.fieldLevel.nextOffset, null);
  assert.equal(first.stats.paging.crossField.offset, 0);
  assert.equal(first.stats.paging.crossField.nextOffset, 2);
  const second = await parseDvpWorkbook(directory, 'dvp.xlsx', { limit: 2, section: 'crossField', offset: 2 });
  assert.deepEqual(second.document.crossField.map((r) => r.id), ['EC-003', 'EC-004']);
  assert.equal(second.stats.paging.crossField.offset, 2);
  assert.equal(second.stats.paging.crossField.nextOffset, null);
  assert.deepEqual(
    [...first.document.crossField, ...second.document.crossField].map((r) => r.id),
    full.document.crossField.map((r) => r.id),
  );
  await assert.rejects(parseDvpWorkbook(directory, 'dvp.xlsx', { offset: 1 }),
    (error: unknown) => error instanceof DvpError && error.code === 'PAGING_SECTION_REQUIRED');
  await assert.rejects(parseDvpWorkbook(directory, 'dvp.xlsx', { section: 'nope' as never }),
    (error: unknown) => error instanceof DvpError && error.code === 'PAGING_SECTION_INVALID');
});

test('目录边界：workbook 不在目录内、缺失、非 xlsx 都显式拒绝', async () => {
  const directory = withTempWorkbook();
  await assert.rejects(parseDvpWorkbook(directory, '../other/evil.xlsx'), (error: unknown) => error instanceof DvpError && error.code === 'WORKBOOK_NOT_FOUND');
  await assert.rejects(parseDvpWorkbook(directory, 'missing.xlsx'), (error: unknown) => error instanceof DvpError && error.code === 'WORKBOOK_NOT_FOUND');
  writeFileSync(join(directory, 'fake.xlsx'), Buffer.from('not a zip'));
  await assert.rejects(parseDvpWorkbook(directory, 'fake.xlsx'), (error: unknown) => error instanceof DvpError || error instanceof Error);
});
