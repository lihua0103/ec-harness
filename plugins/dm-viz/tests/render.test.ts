import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { buildModel, escapeHtml, renderHtml } from '../src/render.js';
import { bundleOf, cardsDataset, layout, sitesDataset, spec, tableDataset } from './fixtures.js';

const datasets = [sitesDataset(), tableDataset(), cardsDataset()];
const page = layout([
  { kind: 'divider', i: 'd1', title: '中心监测', x: 0, y: 0, w: 24, h: 1, style: { subTitle: '按中心' } },
  {
    kind: 'chart',
    i: 'c1',
    specId: 's_bar',
    x: 0,
    y: 1,
    w: 8,
    h: 6,
  },
  { kind: 'chart', i: 'c2', specId: 's_table', x: 8, y: 1, w: 8, h: 6 },
  { kind: 'chart', i: 'c3', specId: 's_cards', x: 16, y: 1, w: 8, h: 6 },
]);

const specs = [
  spec({
    id: 's_bar',
    title: '中心页面数',
    type: 'horizontalbar',
    datasetId: 'ds_sites',
    slots: { category: 'site', values: [{ column: 'pages' }] },
  }),
  spec({ id: 's_table', title: '国家表', type: 'table', datasetId: 'ds_table' }),
  spec({
    id: 's_cards',
    title: '关键指标',
    type: 'cards',
    datasetId: 'ds_cards',
    slots: { category: 'title', values: [{ column: 'main' }, { column: 'target' }], detail: ['badge', 'sub'] },
  }),
];

test('buildModel resolves every item kind', () => {
  const model = buildModel(bundleOf(specs, page, datasets));
  assert.equal(model.items.length, 4);
  assert.deepEqual(
    model.items.map((item) => item.kind),
    ['divider', 'chart', 'table', 'cards'],
  );
  assert.equal(model.heightPx, 7 * 36);
});

test('renderHtml contains each title and the chart mount point', () => {
  const html = renderHtml(buildModel(bundleOf(specs, page, datasets)));
  for (const title of ['中心监测', '中心页面数', '国家表', '关键指标']) assert.ok(html.includes(title), title);
  assert.ok(html.includes('data-chart="c1"'));
  assert.ok(html.includes('<table class="viz-table">'));
  assert.ok(html.includes('viz-kpi'));
});

test('renderHtml escapes markup in titles and payload', () => {
  const hostile = layout([
    { kind: 'chart', i: 'c1', specId: 's_bar', x: 0, y: 0, w: 12, h: 6 },
  ]);
  const titleSpec = spec({
    id: 's_bar',
    title: '<script>alert(1)</script>',
    type: 'horizontalbar',
    datasetId: 'ds_sites',
    slots: { category: 'site', values: [{ column: 'pages' }] },
  });
  const html = renderHtml(buildModel(bundleOf([titleSpec], hostile, datasets)));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('renderHtml escapes markup inside the embedded option payload', () => {
  const page = layout([{ kind: 'chart', i: 'c1', specId: 's_baked', x: 0, y: 0, w: 12, h: 6 }]);
  const baked = {
    id: 's_baked',
    title: '烘焙',
    mode: 'baked' as const,
    type: 'bar',
    option: { series: [{ type: 'bar', name: '</script><script>alert(1)</script>', data: [1] }] },
  };
  const html = renderHtml(buildModel(bundleOf([baked], page, datasets)));
  assert.ok(!html.includes('</script><script>alert(1)</script>'));
  assert.ok(html.includes('\\u003c/script>'));
});

test('escapeHtml covers the five markup characters', () => {
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
});

test('the inline render shell parses as JavaScript', () => {
  const html = renderHtml(buildModel(bundleOf(specs, page, datasets)));
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
  assert.equal(inline.length, 1);
  // 只编译不执行；用 vm.Script 而非 new Function，避免把字符串当可执行代码构造。
  assert.doesNotThrow(() => new Script(inline[0]!));
});
