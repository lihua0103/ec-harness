/**
 * P1 完成判据：合成数据生成含 12+ 类型、分隔符、堆叠/多系列的页面；
 * 逐项结构检查 0 失败；两次生成内容一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptPage } from '../src/accept.js';
import { buildModel, renderHtml } from '../src/render.js';
import { pageDigest } from '../src/spec.js';
import { allDatasets, bundleOf } from './fixtures.js';
import { p1Layout, p1Specs } from './p1-fixtures.js';

function bundle() {
  const specs = p1Specs();
  return bundleOf(specs, p1Layout(specs), allDatasets());
}

test('P1 page: 14 charts across 12+ types with a divider', () => {
  const model = buildModel(bundle());
  assert.equal(model.items.length, 15);
  assert.equal(model.items.filter((item) => item.kind === 'divider').length, 1);
  assert.equal(model.items.filter((item) => item.kind === 'chart').length, 12);
  assert.equal(model.items.filter((item) => item.kind === 'table').length, 1);
  assert.equal(model.items.filter((item) => item.kind === 'cards').length, 1);
  const types = new Set(p1Specs().map((chart) => chart.type));
  assert.ok(types.size >= 12, `types=${[...types].join(',')}`);
});

test('P1 page passes config-level acceptance with zero failures', () => {
  const record = acceptPage(bundle());
  assert.equal(record.result, 'pass');
  assert.equal(record.structure.blank, 0);
  assert.equal(record.structure.errors.length, 0);
  assert.equal(record.structure.overlaps, 0);
  assert.equal(record.structure.orphans, 0);
  assert.equal(record.structure.rendered, record.structure.items);
});

test('P1 page renders deterministically', () => {
  const first = renderHtml(buildModel(bundle()));
  const second = renderHtml(buildModel(bundle()));
  assert.equal(first, second);
  assert.equal(pageDigest(bundle()), pageDigest(bundle()));
});
