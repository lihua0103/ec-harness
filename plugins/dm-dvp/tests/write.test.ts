import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDvpWorkbook, readWrittenWorkbook } from '../src/write.js';
import { parseDvpWorkbook, overviewDvpWorkbook, DvpError } from '../src/parse.js';

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
