/** 输入发现与通用工作簿读取（2026-11-24）：目录扫描的分类、取舍与上限；读取时的 DVP 模板拒绝、
 *  Cover/Approval 名称边界、行窗口与路径越界。夹具全部人工合成，禁止来自临床数据。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInputWorkbook, scanInputs } from '../src/inputs.js';
import { DvpError } from '../src/parse.js';
import { makeWorkbook } from './fixtures/make-xlsx.js';

const ALS_SHEETS = [
  { name: 'Cover', rows: [['ALS_COVER_CANARY']] },
  { name: 'Datasets', rows: [['DATASET', 'LABEL'], ['AE', 'Adverse Events'], ['DM', 'Demography']] },
  { name: 'Variables', rows: [
    ['DATASET', 'VARIABLE', 'LABEL', 'TYPE'],
    ['AE', 'AETERM', 'Reported Term', 'CHAR'],
    ['AE', 'AESTDT', 'Start Date', 'NUM'],
    ['DM', 'AGE', 'Age', 'NUM'],
  ] },
  { name: 'Hidden Notes', rows: [['NOTE']], state: 'hidden' as const },
];

function withFiles(layout: Record<string, string | Buffer>): string {
  const directory = mkdtempSync(join(tmpdir(), 'dm-dvp-inputs-'));
  for (const [relative, content] of Object.entries(layout)) {
    const target = join(directory, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return directory;
}

const codeOf = (error: unknown): string => (error instanceof DvpError ? error.code : String(error));
const isCode = (code: string) => (error: unknown): boolean => codeOf(error) === code;

test('scan lists protocols and workbooks recursively, counts the rest, and reports properties only', () => {
  const als = makeWorkbook(ALS_SHEETS);
  const directory = withFiles({
    '1-Protocal/study.pdf': '%PDF-1.4 synthetic',
    '2-ALS/als.xlsx': als,
    '2-ALS/legacy.xls': 'legacy-bytes',
    '3-DVP/dvp.xlsm': 'xlsm-bytes',
    'notes/README.md': 'readme',
    'notes/requirements.docx': 'docx-bytes',
    'notes/data.csv': 'a,b',
    'noext': '',
  });
  const scan = scanInputs(directory);
  assert.equal(scan.files.map((file) => file.path).join('|'), '1-Protocal/study.pdf|2-ALS/als.xlsx|2-ALS/legacy.xls|3-DVP/dvp.xlsm', 'sorted by relative path with / separators');
  assert.equal(scan.files.map((file) => file.kind).join(','), 'protocol,workbook,unsupportedWorkbook,workbook');
  assert.equal(JSON.stringify(scan.summary), JSON.stringify({ protocol: 1, workbook: 2, unsupportedWorkbook: 1 }));
  assert.equal(JSON.stringify(scan.other), JSON.stringify({ '(none)': 1, csv: 1, docx: 1, md: 1 }), 'other types are counted per extension in key order, not listed');
  assert.equal(JSON.stringify(scan.scanned), JSON.stringify({ files: 8, directories: 4, truncated: false }));
  assert.equal(scan.files[1]?.bytes, als.length, 'size is the real file size');
  assert.ok(scan.files.every((file) => Number.isSafeInteger(file.bytes) && !Number.isNaN(Date.parse(file.modifiedAt))), 'size and ISO modified time for every listed file');
  assert.equal(scan.notices.length, 1, 'only the legacy-workbook notice applies');
  assert.match(scan.notices[0] ?? '', /LEGACY_WORKBOOK_NOT_READABLE/);
  // Presence only: no file content reaches the result.
  assert.equal(JSON.stringify(scan).includes('ALS_COVER_CANARY'), false);
  assert.equal(JSON.stringify(scan).includes('Adverse Events'), false);
});

test('scan honours recursion and depth, skips tooling state, and never follows links', () => {
  const outside = mkdtempSync(join(tmpdir(), 'dm-dvp-inputs-outside-'));
  writeFileSync(join(outside, 'linked.pdf'), '%PDF-linked');
  const directory = withFiles({
    'top.pdf': '%PDF-top',
    // Depth 1 files: listed as soon as recursion reaches one level — unless their directory is skipped.
    'nested/inner.pdf': '%PDF-inner',
    '.platform/state.pdf': '%PDF-dot-directory',
    'node_modules/dep.pdf': '%PDF-node-modules',
    // Depth 2: beyond maxDepth 1.
    'nested/deeper/deep.pdf': '%PDF-deep',
    'plain.txt': 'text',
  });
  try {
    symlinkSync(outside, join(directory, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');
    const paths = (scan: ReturnType<typeof scanInputs>): string => scan.files.map((file) => file.path).join(',');
    assert.equal(paths(scanInputs(directory, { recursive: false })), 'top.pdf', 'recursive=false reads the top level only');
    const depth0 = scanInputs(directory, { maxDepth: 0 });
    assert.equal(paths(depth0), 'top.pdf', 'maxDepth=0 reads the top level only');
    assert.match(depth0.notices.join('\n'), /DEPTH_REACHED/, 'unvisited depth is announced, not silently dropped');
    const depth1 = scanInputs(directory, { maxDepth: 1 });
    assert.equal(paths(depth1), 'nested/inner.pdf,top.pdf', 'depth 1 is read; deeper files and skipped directories are not');
    assert.match(depth1.notices.join('\n'), /DEPTH_REACHED/);
    assert.equal(JSON.stringify(depth1).includes('linked.pdf'), false, 'a linked directory is not followed');
    assert.equal(JSON.stringify(depth1.other), JSON.stringify({ txt: 1 }));
    const full = scanInputs(directory);
    assert.equal(paths(full), 'nested/deeper/deep.pdf,nested/inner.pdf,top.pdf', 'the default recursion reaches depth 2 and keeps skipping tooling state');
    assert.equal(full.notices.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('an oversized directory is truncated and says so', () => {
  const layout: Record<string, string> = {};
  for (let index = 0; index < 501; index += 1) layout[`f${String(index).padStart(4, '0')}.pdf`] = 'x';
  const scan = scanInputs(withFiles(layout));
  assert.equal(scan.files.length, 500, 'the list stops at the cap');
  assert.equal(scan.summary.protocol, 501, 'the summary still counts every file that was seen');
  assert.equal(scan.scanned.truncated, true);
  assert.match(scan.notices.join('\n'), /SCAN_TRUNCATED/);
});

test('scan refuses what is not a directory and an invalid depth', () => {
  const directory = withFiles({ 'file.pdf': 'x' });
  assert.throws(() => scanInputs(join(directory, 'missing')), isCode('DIRECTORY_NOT_FOUND'));
  assert.throws(() => scanInputs(join(directory, 'file.pdf')), isCode('NOT_A_DIRECTORY'));
  assert.throws(() => scanInputs(directory, { maxDepth: -1 }), isCode('SCAN_DEPTH_INVALID'));
  assert.throws(() => scanInputs(directory, { maxDepth: 1.5 }), isCode('SCAN_DEPTH_INVALID'));
});

test('an ALS workbook yields an inventory, then a whole sheet or a row window', async () => {
  const directory = withFiles({ 'als.xlsx': makeWorkbook(ALS_SHEETS) });
  const inventory = await readInputWorkbook(directory, 'als.xlsx');
  assert.ok(inventory.kind === 'inventory');
  assert.equal(
    inventory.sheets.map((sheet) => `${sheet.sheetId}:${sheet.name}:${sheet.role}:${sheet.readable}`).join(' | '),
    'sheet-1:Cover:cover:false | sheet-2:Datasets:unknown:true | sheet-3:Variables:unknown:true | sheet-4:Hidden Notes:unknown:true',
    'non-template sheets stay readable whatever their name; hidden state is reported, not hidden',
  );
  assert.match(inventory.sha256, /^[0-9a-f]{64}$/);
  assert.match(inventory.boundaryNotice.join('\n'), /DVP_TEMPLATE_USE_DEDICATED_TOOLS/);
  assert.equal(JSON.stringify(inventory).includes('ALS_COVER_CANARY'), false, 'an inventory carries sheet names only');

  const whole = await readInputWorkbook(directory, 'als.xlsx', 'sheet-3');
  assert.ok(whole.kind === 'sheet');
  assert.equal(whole.window, null);
  assert.equal(whole.rowCount, 4);
  assert.equal(
    whole.cells.slice(0, 4).map((cell) => `${cell.ref}=${cell.value}(${cell.type})`).join(' | '),
    'A1=DATASET(inlineStr) | B1=VARIABLE(inlineStr) | C1=LABEL(inlineStr) | D1=TYPE(inlineStr)',
  );

  const window = await readInputWorkbook(directory, 'als.xlsx', 'sheet-3', { startRow: 2, endRow: 3 });
  assert.ok(window.kind === 'sheet');
  assert.equal(JSON.stringify(window.window), JSON.stringify({ startRow: 2, endRow: 3 }));
  assert.equal(window.cells.map((cell) => cell.ref).join(','), 'A2,B2,C2,D2,A3,B3,C3,D3', 'the window is inclusive on both ends');
});

test('the Cover / Approval name boundary holds for any workbook, and bad references are refused', async () => {
  const directory = withFiles({ 'als.xlsx': makeWorkbook([...ALS_SHEETS, { name: 'Approval Form', rows: [['SIGNATURE_CANARY']] }]) });
  await assert.rejects(readInputWorkbook(directory, 'als.xlsx', 'sheet-1'), isCode('SHEET_CONTENT_NOT_READ'));
  await assert.rejects(readInputWorkbook(directory, 'als.xlsx', 'sheet-5'), isCode('SHEET_CONTENT_NOT_READ'));
  await assert.rejects(readInputWorkbook(directory, 'als.xlsx', 'sheet-99'), isCode('UNKNOWN_SHEET'));
  await assert.rejects(readInputWorkbook(directory, 'als.xlsx', 'sheet-2', { startRow: 0, endRow: 3 }), isCode('WINDOW_INVALID'));
  await assert.rejects(readInputWorkbook(directory, 'als.xlsx', 'sheet-2', { startRow: 5, endRow: 3 }), isCode('WINDOW_INVALID'));
});

test('a DVP template workbook is refused before any content, even for an innocent sheet name', async () => {
  const directory = withFiles({
    'template.xlsx': makeWorkbook([
      { name: 'Cover', rows: [['COVER_CANARY']] },
      { name: 'Edit Checks', rows: [['Unique ID', 'Logic'], ['EC-1', 'fire when A > B']] },
      { name: 'Manual Review', rows: [['Unique ID'], ['MR-1']] },
      { name: 'Extra Notes', rows: [['UNKNOWN_CANARY']] },
    ]),
  });
  const refused = isCode('DVP_TEMPLATE_USE_DEDICATED_TOOLS');
  await assert.rejects(readInputWorkbook(directory, 'template.xlsx'), refused, 'even the inventory is refused');
  await assert.rejects(readInputWorkbook(directory, 'template.xlsx', 'sheet-4'), refused, 'an unnamed-role sheet of a template is still template content');
  await assert.rejects(readInputWorkbook(directory, 'template.xlsx', 'sheet-2'), refused, 'the rule sheet itself points at the dedicated tools');
});

test('dynamic / version-history sheet names alone do not make a workbook a DVP template', async () => {
  const directory = withFiles({
    'spec.xlsx': makeWorkbook([
      { name: 'Version History', rows: [['Version'], ['1.0']] },
      { name: 'Dynamic', rows: [['Unique ID', 'Field Name'], ['DY-1', 'SPEC_VALUE']] },
    ]),
  });
  const read = await readInputWorkbook(directory, 'spec.xlsx', 'sheet-2');
  assert.ok(read.kind === 'sheet');
  assert.equal(read.cells.map((cell) => cell.value).join(','), 'Unique ID,Field Name,DY-1,SPEC_VALUE');
});

test('reads stay inside the operator directory and explain legacy formats', async () => {
  const sibling = withFiles({ 'outside.xlsx': makeWorkbook([{ name: 'Data', rows: [['OUTSIDE_CANARY']] }]) });
  const directory = withFiles({ 'legacy.xls': 'legacy-bytes', 'notes.txt': 'not a workbook' });
  try {
    await assert.rejects(readInputWorkbook(directory, join(sibling, 'outside.xlsx')), isCode('WORKBOOK_OUTSIDE_DIRECTORY'));
    await assert.rejects(readInputWorkbook(directory, 'legacy.xls'), (error: unknown) => {
      assert.ok(error instanceof DvpError);
      assert.equal(error.code, 'WORKBOOK_NOT_XLSX');
      assert.match(error.message, /\.xls/, 'the legacy format is named so the caller knows to convert');
      return true;
    });
    await assert.rejects(readInputWorkbook(directory, 'notes.txt'), isCode('WORKBOOK_NOT_XLSX'));
    await assert.rejects(readInputWorkbook(directory, 'missing.xlsx'), isCode('WORKBOOK_NOT_FOUND'));
  } finally {
    rmSync(sibling, { recursive: true, force: true });
  }
});
