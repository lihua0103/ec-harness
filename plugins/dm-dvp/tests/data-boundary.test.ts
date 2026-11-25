/** 数据安全开关（data-boundary.ts，手动维护的 .runtime/data-boundary.json，与模型无关）。
 *  redacted（开关开启，默认）：Cover、Approval 不读，TEST CASE 与 DM/DBD 评审意见只计数；
 *  full（开关关闭）：以上内容原值返回。
 *  两种模式的行为分别由 tests/parse.test.ts、tests/inputs.test.ts（默认开启）与本文件锁定。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataBoundaryMode, fullAccess } from '../src/data-boundary.js';
import { classifySheet, overviewDvpWorkbook, parseDvpWorkbook, BOUNDARY_NOTICES } from '../src/parse.js';
import { readInputWorkbook } from '../src/inputs.js';
import { makeWorkbook } from './fixtures/make-xlsx.js';

const SHEETS = [
  { name: 'Cover', rows: [['Study Title', 'SYNTHETIC STUDY TITLE'], ['Protocol', 'SYN-001']] },
  { name: 'Edit Checks', rows: [
    ['Unique ID', 'Add/Delete/Update', 'Visits Applied To', 'Form Name', 'Query Targeted Field', 'Related Field', 'Query Type', 'Discrepancy Text Message', 'Logic'],
    ['EC-001', 'Add/V2.0', 'V1', 'AE', 'AE Term', 'AE Date', 'Date', 'Synthetic message.', 'fire when AE Term = "X"'],
  ] },
  { name: 'Manual Review for Programming', rows: [
    ['Unique ID', 'Assign To', 'Logic', 'Column Heading', 'TEST CASE - Subject ID', 'DM Comment', 'DBD Comment'],
    ['MRP-001', 'DATA MGMT', 'fire when AE Term = "X"', 'AE Listing', 'SUBJ-001\nSUBJ-002', 'synthetic dm note', 'synthetic dbd note'],
  ] },
  { name: 'Approval Form', rows: [['Signature', 'Synthetic Approver', 'Role']] },
];

const dirs: string[] = [];
function withTempWorkbook(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dm-dvp-boundary-'));
  dirs.push(directory);
  writeFileSync(join(directory, 'dvp.xlsx'), makeWorkbook(SHEETS));
  return directory;
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const withMode = async <T>(mode: 'full' | 'redacted', fn: () => Promise<T>): Promise<T> => {
  const prev = process.env.DM_DATA_BOUNDARY;
  process.env.DM_DATA_BOUNDARY = mode;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.DM_DATA_BOUNDARY; else process.env.DM_DATA_BOUNDARY = prev; }
};

test('开关来源：env 覆盖 > 开关文件 dataSecurity > 默认开启；与模型目录无关', async (t) => {
  const prevFile = process.env.DM_DATA_BOUNDARY_FILE;
  const prev = process.env.DM_DATA_BOUNDARY;
  delete process.env.DM_DATA_BOUNDARY;
  t.after(() => { if (prev === undefined) delete process.env.DM_DATA_BOUNDARY; else process.env.DM_DATA_BOUNDARY = prev; if (prevFile === undefined) delete process.env.DM_DATA_BOUNDARY_FILE; else process.env.DM_DATA_BOUNDARY_FILE = prevFile; });
  process.env.DM_DATA_BOUNDARY_FILE = join(mkdtempSync(join(tmpdir(), 'db-')), 'data-boundary.json');
  const file = process.env.DM_DATA_BOUNDARY_FILE;
  assert.equal(dataBoundaryMode(), 'redacted', '没有开关文件 = 数据安全开启');
  writeFileSync(file, JSON.stringify({ _comment: 'x', dataSecurity: false }));
  assert.equal(dataBoundaryMode(), 'full', '开关关闭（dataSecurity=false）= 全量');
  writeFileSync(file, '{ not json');
  assert.equal(dataBoundaryMode(), 'redacted', '开关文件损坏 = 按开启处理');
  writeFileSync(file, JSON.stringify({ dataSecurity: 'false' }));
  assert.equal(dataBoundaryMode(), 'redacted', '只有布尔 false 才算关闭');
  writeFileSync(file, JSON.stringify({ dataSecurity: true }));
  assert.equal(dataBoundaryMode(), 'redacted', '开关开启');
  process.env.DM_DATA_BOUNDARY = 'redacted';
  assert.equal(dataBoundaryMode(), 'redacted', 'env 优先于开关文件');
  writeFileSync(file, JSON.stringify({ dataSecurity: false }));
  assert.equal(dataBoundaryMode(), 'redacted', 'env=redacted 时开关关闭也不生效');
  process.env.DM_DATA_BOUNDARY = 'full';
  writeFileSync(file, JSON.stringify({ dataSecurity: true }));
  assert.equal(dataBoundaryMode(), 'full', 'env=full 时开关开启也不生效');
});

test('classifySheet：脱敏模式 Cover/Approval 不可读并带说明；全量模式可读且无说明', async () => {
  await withMode('redacted', async () => {
    assert.deepEqual(classifySheet('Cover'), { role: 'cover', readable: false, note: 'CONTENT_NEVER_READ（既定边界）' });
    assert.equal(classifySheet('Approval Form').readable, false);
    assert.equal(fullAccess(), false);
  });
  await withMode('full', async () => {
    assert.deepEqual(classifySheet('Cover'), { role: 'cover', readable: true });
    assert.deepEqual(classifySheet('Approval Form'), { role: 'approval', readable: true });
    assert.deepEqual(classifySheet('Extra Notes'), { role: 'unknown', readable: false, note: 'UNRECOGNIZED_SHEET_PRESENCE_ONLY（仅记录存在）' }, '未识别 sheet 在专用解析工具里仍只记录存在');
  });
});

test('overview：边界声明随模式；全量模式 Cover/Approval 标为可读', async () => {
  const directory = withTempWorkbook();
  await withMode('redacted', async () => {
    const o = await overviewDvpWorkbook(directory, 'dvp.xlsx');
    assert.deepEqual(o.boundaryNotice, BOUNDARY_NOTICES);
    assert.equal(o.sheets.find((s) => s.role === 'cover')?.readable, false);
  });
  await withMode('full', async () => {
    const o = await overviewDvpWorkbook(directory, 'dvp.xlsx');
    assert.match(o.boundaryNotice[0] ?? '', /DATA_BOUNDARY_FULL/);
    assert.ok(!o.boundaryNotice.join('\n').includes('CONTENT_NEVER_READ'));
    assert.ok(['cover', 'approval'].every((role) => o.sheets.find((s) => s.role === role)?.readable === true));
  });
});

test('parse：脱敏模式内容不进入返回值；全量模式 Cover/Approval 原值行列与评审意见原值返回', async () => {
  const directory = withTempWorkbook();
  await withMode('redacted', async () => {
    const { document, stats } = await parseDvpWorkbook(directory, 'dvp.xlsx');
    const mr = document.manualReview[0]?.programming;
    assert.equal(mr?.testCaseSubjectCount, 2);
    assert.equal(mr?.dmCommentCount, 1);
    assert.equal('testCase' in (mr ?? {}), false, '脱敏模式没有原值字段');
    assert.ok(stats.sheets.every((s) => s.content === undefined), '脱敏模式没有原值行列');
    assert.ok(!JSON.stringify(stats).includes('SYNTHETIC STUDY TITLE') && !JSON.stringify(document).includes('SUBJ-001'));
  });
  await withMode('full', async () => {
    const { document, stats } = await parseDvpWorkbook(directory, 'dvp.xlsx');
    const cover = stats.sheets.find((s) => s.role === 'cover');
    assert.deepEqual(cover?.content, [['Study Title', 'SYNTHETIC STUDY TITLE'], ['Protocol', 'SYN-001']], 'Cover 原值行列');
    assert.deepEqual(stats.sheets.find((s) => s.role === 'approval')?.content, [['Signature', 'Synthetic Approver', 'Role']]);
    const mr = document.manualReview[0]?.programming;
    assert.equal(mr?.testCase, 'SUBJ-001\nSUBJ-002');
    assert.equal(mr?.dmComment, 'synthetic dm note');
    assert.equal(mr?.dbdComment, 'synthetic dbd note');
    assert.equal(mr?.testCaseSubjectCount, 2, '条数在全量模式照常返回');
    assert.equal(document.crossField.length, 1, '规则 IR 不受模式影响');
  });
});

test('read_workbook：脱敏模式拒绝 DVP 模板与 Cover；全量模式直接可读', async () => {
  const directory = withTempWorkbook();
  await withMode('redacted', async () => {
    await assert.rejects(readInputWorkbook(directory, 'dvp.xlsx'), /DVP 模板工作簿含 DVP 规则 sheet|DVP 规则 sheet/);
  });
  await withMode('full', async () => {
    const inv = await readInputWorkbook(directory, 'dvp.xlsx');
    assert.ok(inv.kind === 'inventory');
    if (inv.kind !== 'inventory') return;
    assert.ok(inv.sheets.every((s) => s.readable), '全部 sheet 可读');
    const cover = inv.sheets.find((s) => s.role === 'cover');
    assert.ok(cover, '清单里有 Cover');
    const sheet = await readInputWorkbook(directory, 'dvp.xlsx', cover?.sheetId);
    assert.ok(sheet.kind === 'sheet');
    assert.ok(JSON.stringify(sheet).includes('SYNTHETIC STUDY TITLE'), 'Cover 单元格原值可读');
  });
});
