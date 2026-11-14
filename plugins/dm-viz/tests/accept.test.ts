import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptPage, type PairResult } from '../src/accept.js';
import { pageDigest } from '../src/spec.js';
import { bundleOf, emptyDataset, layout, sitesDataset, spec } from './fixtures.js';

const datasets = [sitesDataset(), emptyDataset()];
const barSpec = spec({
  id: 's_bar',
  title: '中心页面数',
  type: 'horizontalbar',
  datasetId: 'ds_sites',
  slots: { category: 'site', values: [{ column: 'pages' }] },
});
const emptySpec = spec({
  id: 's_empty',
  title: '空图',
  type: 'bar',
  datasetId: 'ds_empty',
  slots: { category: 'site', values: [{ column: 'pages' }] },
});

test('passes when every item renders data and layout is clean', () => {
  const page = layout([
    { kind: 'divider', i: 'd1', title: '分区', x: 0, y: 0, w: 24, h: 1 },
    { kind: 'chart', i: 'c1', specId: 's_bar', x: 0, y: 1, w: 12, h: 6 },
  ]);
  const record = acceptPage(bundleOf([barSpec], page, [...datasets]));
  assert.equal(record.result, 'pass');
  assert.equal(record.structure.blank, 0);
  assert.equal(record.structure.canvases, 1);
  assert.equal(record.structure.dividers, 1);
});

test('fails on a blank item and names it', () => {
  const page = layout([{ kind: 'chart', i: 'c1', specId: 's_empty', x: 0, y: 0, w: 12, h: 6 }]);
  const record = acceptPage(bundleOf([emptySpec], page, [...datasets]));
  assert.equal(record.result, 'fail');
  assert.deepEqual(record.structure.blankItems, ['c1']);
});

test('fails on overlapping items', () => {
  const page = layout([
    { kind: 'chart', i: 'c1', specId: 's_bar', x: 0, y: 0, w: 12, h: 6 },
    { kind: 'chart', i: 'c2', specId: 's_bar', x: 6, y: 0, w: 12, h: 6 },
  ]);
  const record = acceptPage(bundleOf([barSpec], page, [...datasets]));
  assert.equal(record.result, 'fail');
  assert.equal(record.structure.overlaps, 1);
});

test('pending design pairs keep the result from passing', () => {
  const page = layout([{ kind: 'chart', i: 'c1', specId: 's_bar', x: 0, y: 0, w: 12, h: 6 }]);
  const pairs: PairResult[] = [
    { specId: 's_bar', designRef: 'b0p1', renderRef: 'c1', verdict: 'pending', knownDiffs: [] },
  ];
  assert.equal(acceptPage(bundleOf([barSpec], page, [...datasets]), pairs).result, 'fail');
  pairs[0]!.verdict = 'match';
  assert.equal(acceptPage(bundleOf([barSpec], page, [...datasets]), pairs).result, 'pass');
});

test('acceptance digest follows the configuration, not the render', () => {
  const page = layout([{ kind: 'chart', i: 'c1', specId: 's_bar', x: 0, y: 0, w: 12, h: 6 }]);
  const bundle = bundleOf([barSpec], page, [...datasets]);
  const first = acceptPage(bundle);
  const second = acceptPage(bundle);
  assert.equal(first.specDigest, second.specDigest);
  assert.equal(first.specDigest, pageDigest(bundle));
});
