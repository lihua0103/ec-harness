import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareOptions, pairDesignCharts, type DesignChart } from '../src/design.js';
import { buildModel } from '../src/render.js';
import { allDatasets, bundleOf, layout, spec } from './fixtures.js';
import type { ChartSpec } from '../src/spec.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const base: Record<string, any> = {
  color: ['#409eff', '#67c23a'],
  xAxis: { type: 'category', data: ['S001', 'S002', 'S003'] },
  yAxis: { type: 'value' },
  series: [{ name: '页面数', type: 'bar', data: [16, 10, 5] }],
};

test('identical options produce no diffs', () => {
  assert.deepEqual(compareOptions(clone(base), clone(base)), []);
});

test('detects data differences', () => {
  const changed = clone(base);
  (changed.series as Array<{ data: number[] }>)[0]!.data = [16, 10, 4];
  const diffs = compareOptions(changed, clone(base));
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]!.field, 'series[0].data');
});

test('detects series count and type differences', () => {
  const more = clone(base);
  (more.series as unknown[]).push({ name: '访视数', type: 'line', data: [6, 4, 5] });
  assert.ok(compareOptions(more, clone(base)).some((diff) => diff.field === 'seriesCount'));

  const other = clone(base);
  (other.series as Array<{ type: string }>)[0]!.type = 'line';
  assert.ok(compareOptions(other, clone(base)).some((diff) => diff.field === 'series[0].type'));
});

test('detects category axis orientation and values', () => {
  const flipped = clone(base);
  flipped.xAxis = { type: 'value' };
  flipped.yAxis = { type: 'category', data: ['S001', 'S002', 'S003'] };
  assert.ok(compareOptions(flipped, clone(base)).some((diff) => diff.field === 'categoryAxis'));

  const reordered = clone(base);
  (reordered.xAxis as { data: string[] }).data = ['S002', 'S001', 'S003'];
  assert.ok(compareOptions(reordered, clone(base)).some((diff) => diff.field === 'categoryValues'));
});

test('ignores ECharts default palette but compares explicit colors', () => {
  const designDefault = clone(base);
  designDefault.color = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc'];
  assert.deepEqual(compareOptions(designDefault, clone(base)), []);

  const explicit = clone(base);
  explicit.color = ['#111111'];
  assert.ok(compareOptions(explicit, clone(base)).some((diff) => diff.field === 'color'));
});

test('compares pie slices by name and value', () => {
  const pie = {
    series: [{ type: 'pie', data: [{ name: 'China', value: 12 }, { name: 'Japan', value: 8 }] }],
  };
  const changed = {
    series: [{ type: 'pie', data: [{ name: 'China', value: 12 }, { name: 'Japan', value: 9 }] }],
  };
  assert.deepEqual(compareOptions(pie, clone(pie)), []);
  assert.ok(compareOptions(changed, pie).some((diff) => diff.field === 'series[0].data'));
});

test('pairs charts in order and marks match, diff and pending', () => {
  const specs: ChartSpec[] = [
    spec({ id: 's1', title: '中心', type: 'bar', datasetId: 'ds_sites', slots: { category: 'site', values: [{ column: 'pages' }] } }),
    spec({ id: 's2', title: '占比', type: 'pie', datasetId: 'ds_table', slots: { category: 'country', values: [{ column: 'sites' }] } }),
  ];
  const bundle = bundleOf(
    specs,
    layout([
      { kind: 'chart', i: 'c1', specId: 's1', x: 0, y: 0, w: 12, h: 6 },
      { kind: 'chart', i: 'c2', specId: 's2', x: 12, y: 0, w: 12, h: 6 },
    ]),
    allDatasets(),
  );
  const model = buildModel(bundle);
  const first = model.items.find((item) => item.i === 'c1')!;
  const second = model.items.find((item) => item.i === 'c2')!;
  const design: DesignChart[] = [
    { order: 0, id: 'b0p1', card: 'b0p1', title: '', option: clone(first.option!) },
    { order: 1, id: 'b0p2', card: 'b0p2', title: '', option: clone(second.option!) },
    { order: 2, id: 'b0p3', card: 'b0p3', title: '', option: clone(first.option!) },
  ];
  const result = pairDesignCharts(design, model);
  assert.deepEqual(
    result.pairs.map((pair) => pair.verdict),
    ['match', 'match', 'pending'],
  );
  assert.equal(result.pairs[0]!.renderRef, 'c1');
  assert.equal(result.pairs[2]!.knownDiffs[0], 'RENDER_ITEM_MISSING');
  assert.equal(result.details.length, 2);
});
