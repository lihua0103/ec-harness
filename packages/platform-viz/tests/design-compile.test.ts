import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDesignLabels, compileDesignCharts } from '../src/design-compile.js';
import type { DesignChart } from '../src/design.js';

const base = { series: [{ type: 'bar', data: [1, 2], label: { show: true } }] };

test('numeric label text becomes {c}', () => {
  const option = applyDesignLabels(base, [{ series: 0, key: 'label', texts: ['1', '2'] }]);
  const label = (option.series as Array<Record<string, unknown>>)[0]!.label as Record<string, unknown>;
  assert.equal(label.formatter, '{c}');
});

test('text label becomes data names with {b}', () => {
  const option = applyDesignLabels(base, [{ series: 0, key: 'label', texts: ['Site 101', 'Site 102'] }]);
  const series = (option.series as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(series.data, [
    { value: 1, name: 'Site 101' },
    { value: 2, name: 'Site 102' },
  ]);
  assert.equal((series.label as Record<string, unknown>).formatter, '{b}');
});

test('unreliable label text is skipped instead of baked', () => {
  const option = applyDesignLabels(base, [{ series: 0, key: 'label', texts: ['undefined', '2'] }]);
  assert.deepEqual((option.series as Array<Record<string, unknown>>)[0]!.data, [1, 2]);
});

test('heatmap items keep itemStyle and take the label from raw', () => {
  const option = applyDesignLabels(
    { series: [{ type: 'heatmap', data: [{ value: [0, 0, 0.4], raw: 5, itemStyle: { color: '#123' } }] }] },
    [{ series: 0, key: 'label', texts: ['5'] }],
  );
  const series = (option.series as Array<Record<string, unknown>>)[0]!;
  const item = (series.data as Array<Record<string, unknown>>)[0]!;
  assert.equal(item.name, '5');
  assert.deepEqual(item.itemStyle, { color: '#123' });
  assert.equal((series.label as Record<string, unknown>).formatter, '{b}');
});

test('heatmap without visualMap gets a minimal mapping', () => {
  const option = applyDesignLabels(
    { series: [{ type: 'heatmap', data: [{ value: [0, 0, 5], raw: 5 }] }] },
    [],
  );
  assert.ok(Array.isArray(option.visualMap));
  assert.equal((option.visualMap as unknown[]).length, 1);
});

test('object items prefer the computed label text', () => {
  const option = applyDesignLabels(
    { series: [{ type: 'funnel', data: [{ value: 1557, name: 'x' }] }] },
    [{ series: 0, key: 'label', texts: ['Due endpoint visits\n1,557'] }],
  );
  const item = (option.series as Array<Record<string, unknown>>)[0]!.data as Array<Record<string, unknown>>;
  assert.equal(item[0]!.name, 'Due endpoint visits\n1,557');
});

test('compile keeps design order and reports unsupported types', () => {
  const charts: DesignChart[] = [
    { order: 0, id: '', card: '', title: 'A', option: { series: [{ type: 'bar', data: [1] }] } },
    { order: 1, id: '', card: 'b1p3', title: 'B', option: { series: [{ type: 'custom', data: [[0, 1]] }] } },
    { order: 2, id: '', card: 'b0p1', title: 'C', option: { series: [{ type: 'heatmap', data: [{ value: [0, 0, 1], raw: 5 }] }] } },
  ];
  const compiled = compileDesignCharts(charts, 'page-x');
  assert.deepEqual(
    compiled.specs.map((spec) => spec.id),
    ['viz_o0', 'viz_b0p1'],
  );
  assert.deepEqual(compiled.skipped, [{ card: 'b1p3', reason: 'CHART_TYPE_UNSUPPORTED:custom' }]);
  assert.deepEqual(
    compiled.layout.items.map((item) => (item.kind === 'chart' ? item.i : item.i)),
    ['viz_o0', 'viz_b0p1'],
  );
  assert.equal(compiled.specs[0]!.mode, 'baked');
});
