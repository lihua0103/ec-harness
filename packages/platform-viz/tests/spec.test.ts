import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderedItems, pageDigest, validateBundle, validateLayout, validateSpec } from '../src/spec.js';
import { bundleOf, emptyDataset, layout, sitesDataset, spec, tableDataset } from './fixtures.js';

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'NO_CODE';
  }
}

const barSpec = spec({
  id: 's_bar',
  title: '中心页面数',
  type: 'horizontalbar',
  datasetId: 'ds_sites',
  slots: { category: 'site', values: [{ column: 'pages' }, { column: 'visits' }] },
});

const barLayout = layout([{ kind: 'chart', i: 'c1', specId: 's_bar', x: 0, y: 0, w: 12, h: 8 }]);

test('accepts a valid bundle', () => {
  assert.doesNotThrow(() => validateBundle(bundleOf([barSpec], barLayout, [sitesDataset()])));
});

test('rejects a text column bound to SUM', () => {
  const bad = spec({
    id: 's_bad',
    title: '非法绑定',
    type: 'bar',
    datasetId: 'ds_sites',
    slots: { category: 'site', values: [{ column: 'country', aggregate: 'SUM' }] },
  });
  assert.equal(codeOf(() => validateSpec(bad, [sitesDataset()])), 'SLOT_COLUMN_NOT_NUMBER');
});

test('allows COUNT on a text column', () => {
  const counted = spec({
    id: 's_count',
    title: '按中心计数',
    type: 'bar',
    datasetId: 'ds_sites',
    slots: { category: 'site', values: [{ column: 'country', aggregate: 'COUNT' }] },
  });
  assert.doesNotThrow(() => validateSpec(counted, [sitesDataset()]));
});

test('requires an option for baked specs', () => {
  const baked = spec({ id: 's_baked', title: '烘焙', type: 'bar', mode: 'baked' });
  assert.equal(codeOf(() => validateSpec(baked, [])), 'SPEC_BAKED_OPTION_REQUIRED');
});

test('rejects unknown chart types', () => {
  const unknown = spec({ id: 's_unknown', title: '未知', type: 'sunburst', datasetId: 'ds_sites' });
  assert.equal(codeOf(() => validateSpec(unknown, [sitesDataset()])), 'CHART_TYPE_UNKNOWN');
});

test('allows a table without slots', () => {
  const table = spec({ id: 's_table', title: '国家表', type: 'table', datasetId: 'ds_table' });
  assert.doesNotThrow(() => validateSpec(table, [tableDataset()]));
});

test('reports duplicate layout keys', () => {
  const issues = validateLayout(
    layout([
      { kind: 'chart', i: 'c1', specId: 's_bar', x: 0, y: 0, w: 12, h: 8 },
      { kind: 'chart', i: 'c1', specId: 's_bar', x: 12, y: 0, w: 12, h: 8 },
    ]),
    [barSpec],
  );
  assert.ok(issues.some((issue) => issue.code === 'LAYOUT_ITEM_KEY_DUPLICATE'));
});

test('reports overlap, out-of-grid and orphans', () => {
  const issues = validateLayout(
    layout([
      { kind: 'chart', i: 'c1', specId: 's_bar', x: 0, y: 0, w: 12, h: 8 },
      { kind: 'chart', i: 'c2', specId: 's_bar', x: 6, y: 4, w: 12, h: 8 },
      { kind: 'chart', i: 'c3', specId: 'missing', x: 20, y: 0, w: 8, h: 4 },
    ]),
    [barSpec],
  );
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes('LAYOUT_OVERLAP'));
  assert.ok(codes.includes('LAYOUT_ITEM_OUT_OF_GRID'));
  assert.ok(codes.includes('LAYOUT_ORPHAN_SPEC'));
});

test('orders items by row, column and key', () => {
  const page = layout([
    { kind: 'chart', i: 'b', specId: 's_bar', x: 12, y: 0, w: 12, h: 4 },
    { kind: 'chart', i: 'a', specId: 's_bar', x: 0, y: 0, w: 12, h: 4 },
    { kind: 'chart', i: 'c', specId: 's_bar', x: 0, y: 4, w: 12, h: 4 },
  ]);
  assert.deepEqual(
    orderedItems(page).map((item) => item.i),
    ['a', 'b', 'c'],
  );
});

test('page digest ignores object key order', () => {
  const first = bundleOf([barSpec], barLayout, [sitesDataset(), emptyDataset()]);
  const reordered = {
    layout: first.layout,
    specs: first.specs,
    datasets: first.datasets.map((dataset) => ({ rows: dataset.rows, columns: dataset.columns, name: dataset.name, id: dataset.id })),
  } as typeof first;
  assert.equal(pageDigest(first), pageDigest(reordered));
});
