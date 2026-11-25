import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { datasetFromGrid, importWorkbookSheet } from '../src/xlsx.js';
import { validateSpec, type Dataset } from '../src/spec.js';
import { buildWorkbook } from './xlsx-fixture.js';
import { spec } from './fixtures.js';

const GRID = [
  ['中心', '页面数', '访视数', '首例入组日期'],
  ['S001', '10', '4', '2026-01-01'],
  ['S002', '8', '3', '2026-02-15'],
  ['', '', '', ''],
  ['S003', '5', '5', '2026-03-01'],
];

test('infers column types from actual values', () => {
  const dataset = datasetFromGrid({ id: 'g1', name: 'grid', rows: GRID });
  assert.deepEqual(
    dataset.columns.map((column) => [column.key, column.label, column.type]),
    [
      ['中心', '中心', 'text'],
      ['页面数', '页面数', 'number'],
      ['访视数', '访视数', 'number'],
      ['首例入组日期', '首例入组日期', 'date'],
    ],
  );
  assert.equal(dataset.rows.length, 3, '全空行被丢弃');
  assert.deepEqual(dataset.rows[0], ['S001', 10, 4, '2026-01-01']);
});

test('de-duplicates repeated headers and treats blanks as null', () => {
  const dataset = datasetFromGrid({
    id: 'g2',
    name: 'dup',
    rows: [
      ['站点', '站点', '值'],
      ['A', 'B', ''],
    ],
  });
  assert.deepEqual(
    dataset.columns.map((column) => column.key),
    ['站点', '站点_2', '值'],
  );
  assert.deepEqual(dataset.rows[0], ['A', 'B', null]);
});

test('explicit column type overrides inference', () => {
  const dataset = datasetFromGrid({
    id: 'g3',
    name: 'override',
    rows: [
      ['编号', '值'],
      ['001', '5'],
    ],
    columnTypes: { 编号: 'text' },
  });
  assert.equal(dataset.columns[0]!.type, 'text');
  assert.deepEqual(dataset.rows[0], ['001', 5]);
});

test('rejects sheets beyond the row limit', () => {
  const rows = [['a'], ['1'], ['2'], ['3']];
  assert.throws(() => datasetFromGrid({ id: 'g4', name: 'big', rows, maxRows: 2 }), /XLSX_ROW_LIMIT/);
});

test('reads a real xlsx workbook through platform-workbook', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dm-viz-xlsx-'));
  const path = join(directory, 'synthetic.xlsx');
  try {
    await writeFile(path, buildWorkbook(GRID));
    const result = await importWorkbookSheet({ path, datasetId: 'x1' });
    assert.equal(result.sheet.name, '数据');
    assert.equal(result.dataset.rows.length, 3);
    assert.deepEqual(
      result.dataset.columns.map((column) => column.type),
      ['text', 'number', 'number', 'date'],
    );
    assert.equal(result.warnings.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a text column bound to SUM is rejected with a locatable error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dm-viz-xlsx-'));
  const path = join(directory, 'synthetic.xlsx');
  try {
    await writeFile(path, buildWorkbook(GRID));
    const { dataset }: { dataset: Dataset } = await importWorkbookSheet({ path, datasetId: 'x2' });
    const bad = spec({
      id: 's_bad',
      title: '错误绑定',
      type: 'bar',
      datasetId: 'x2',
      slots: { category: '中心', values: [{ column: '中心', aggregate: 'SUM' }] },
    });
    assert.throws(
      () => validateSpec(bad, [dataset]),
      (error: unknown) => {
        const typed = error as { code?: string; message?: string };
        assert.equal(typed.code, 'SLOT_COLUMN_NOT_NUMBER');
        assert.match(String(typed.message), /中心/);
        return true;
      },
    );
    const good = spec({
      id: 's_good',
      title: '正确绑定',
      type: 'bar',
      datasetId: 'x2',
      slots: { category: '中心', values: [{ column: '页面数' }] },
    });
    assert.doesNotThrow(() => validateSpec(good, [dataset]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
