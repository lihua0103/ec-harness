import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOption } from '../src/option.js';
import { allDatasets, bundleOf, spec } from './fixtures.js';
import type { ChartSpec, Layout } from '../src/spec.js';

const page: Layout = { pageId: 'p', columns: 24, rowHeight: 36, items: [] };
const bundleOfSpec = (chart: ChartSpec) => bundleOf([chart], page, allDatasets());
type AnySeries = Record<string, any>;

function seriesOf(result: ReturnType<typeof buildOption>): AnySeries[] {
  return result.option.series as AnySeries[];
}

test('wide form builds one series per value slot with SUM', () => {
  const chart = spec({
    id: 'b',
    title: '中心',
    type: 'bar',
    datasetId: 'ds_sites',
    slots: { category: 'site', values: [{ column: 'pages' }, { column: 'visits' }] },
  });
  const result = buildOption(bundleOfSpec(chart), chart);
  const series = seriesOf(result);
  assert.equal(series.length, 2);
  assert.deepEqual(series[0]!.data, [16, 10, 5]);
  assert.deepEqual(series[1]!.data, [6, 4, 5]);
  assert.equal(series[0]!.name, '页面数');
  assert.equal(result.points, 6);
});

test('stacked preset sets stack on every series', () => {
  const chart = spec({
    id: 'b',
    title: '中心',
    type: 'horizontalbar',
    preset: 'stacked',
    datasetId: 'ds_sites',
    slots: { category: 'site', values: [{ column: 'pages' }, { column: 'visits' }] },
  });
  const series = seriesOf(buildOption(bundleOfSpec(chart), chart));
  assert.equal(series[0]!.stack, 'total');
  assert.equal(series[1]!.stack, 'total');
});

test('long form splits series by the series column', () => {
  const chart = spec({
    id: 'b',
    title: '季度',
    type: 'bar',
    datasetId: 'ds_sites',
    slots: { category: 'site', series: 'quarter', values: [{ column: 'pages' }] },
  });
  const series = seriesOf(buildOption(bundleOfSpec(chart), chart));
  assert.deepEqual(
    series.map((item) => item.name),
    ['Q1', 'Q2'],
  );
  assert.deepEqual(series[0]!.data, [10, 8, 5]);
  assert.deepEqual(series[1]!.data, [6, 2, null]);
});

test('aggregate AVG and COUNT follow the declared aggregate', () => {
  const avg = spec({
    id: 'b',
    title: '均值',
    type: 'bar',
    datasetId: 'ds_sites',
    slots: { category: 'site', values: [{ column: 'pages', aggregate: 'AVG' }] },
  });
  assert.deepEqual(seriesOf(buildOption(bundleOfSpec(avg), avg))[0]!.data, [8, 5, 5]);

  const counted = spec({
    id: 'b',
    title: '计数',
    type: 'bar',
    datasetId: 'ds_sites',
    slots: { category: 'site', values: [{ column: 'country', aggregate: 'COUNT' }] },
  });
  assert.deepEqual(seriesOf(buildOption(bundleOfSpec(counted), counted))[0]!.data, [2, 2, 1]);
});

test('heatmap builds triple coordinates', () => {
  const chart = spec({
    id: 'h',
    title: '矩阵',
    type: 'heatmap',
    datasetId: 'ds_heat',
    slots: { category: 'site', series: 'metric', values: [{ column: 'value' }] },
  });
  const result = buildOption(bundleOfSpec(chart), chart);
  assert.deepEqual(seriesOf(result)[0]!.data, [
    [0, 0, 3],
    [0, 1, 1],
    [1, 0, 5],
    [1, 1, 2],
  ]);
});

test('boxplot consumes five numeric columns', () => {
  const chart = spec({
    id: 'box',
    title: '箱线',
    type: 'boxplot',
    datasetId: 'ds_box',
    slots: {
      category: 'site',
      values: [{ column: 'q0' }, { column: 'q1' }, { column: 'q2' }, { column: 'q3' }, { column: 'q4' }],
    },
  });
  const series = seriesOf(buildOption(bundleOfSpec(chart), chart));
  assert.equal(series[0]!.data.length, 2);
  assert.deepEqual(series[0]!.data[0], [1, 2, 3, 4, 5]);
});

test('sankey builds nodes and links', () => {
  const chart = spec({
    id: 'flow',
    title: '流转',
    type: 'sankey',
    datasetId: 'ds_flow',
    slots: { source: 'source', target: 'target', values: [{ column: 'value' }] },
  });
  const series = seriesOf(buildOption(bundleOfSpec(chart), chart))[0]!;
  assert.equal(series.data.length, 4);
  assert.equal(series.links.length, 3);
  assert.equal(series.links[0].value, 120);
});

test('scatter skips rows with a missing coordinate and groups by series column', () => {
  const chart = spec({
    id: 'scatter',
    title: '散点',
    type: 'scatter',
    datasetId: 'ds_scatter',
    slots: { x: 'x', y: 'y', size: 'size', series: 'group' },
  });
  const series = seriesOf(buildOption(bundleOfSpec(chart), chart));
  assert.equal(series.length, 2);
  assert.equal(series[0]!.data.length, 2);
  assert.deepEqual(series[0]!.data[0], [1, 2, 10]);
});

test('cards and table produce non-chart models', () => {
  const cards = spec({
    id: 'cards',
    title: '指标',
    type: 'cards',
    datasetId: 'ds_cards',
    slots: { category: 'title', values: [{ column: 'main' }, { column: 'target' }], detail: ['badge', 'sub'] },
  });
  const cardsResult = buildOption(bundleOfSpec(cards), cards);
  assert.equal(cardsResult.kind, 'cards');
  assert.equal(cardsResult.points, 2);
  const items = (cardsResult.option.cards as { items: AnySeries[] }).items;
  assert.equal(items[1]!.target, null);

  const table = spec({ id: 'table', title: '表', type: 'table', datasetId: 'ds_table' });
  const tableResult = buildOption(bundleOfSpec(table), table);
  assert.equal(tableResult.kind, 'table');
  assert.equal(tableResult.points, 3);
});

test('style keys change the option without touching data', () => {
  const chart = spec({
    id: 'b',
    title: '中心',
    type: 'bar',
    datasetId: 'ds_sites',
    slots: { category: 'site', values: [{ column: 'pages' }, { column: 'visits' }] },
    style: { valueLabels: true, seriesColors: ['#111111', '#222222'], legendWithValue: true },
  });
  const result = buildOption(bundleOfSpec(chart), chart);
  const series = seriesOf(result);
  assert.equal(series[0]!.label.show, true);
  assert.equal(series[0]!.itemStyle.color, '#111111');
  assert.deepEqual(result.option.legend, { type: 'scroll', bottom: 0, formatter: { __fn: 'legendWithValue' } });
});

test('itemColors colors a single series per category', () => {
  const chart = spec({
    id: 'b',
    title: '中心',
    type: 'bar',
    datasetId: 'ds_sites',
    slots: { category: 'site', values: [{ column: 'pages' }] },
    style: { itemColors: ['#aaaaaa', '#bbbbbb'] },
  });
  const data = seriesOf(buildOption(bundleOfSpec(chart), chart))[0]!.data;
  assert.deepEqual(data[0], { value: 16, itemStyle: { color: '#aaaaaa' } });
  assert.deepEqual(data[1], { value: 10, itemStyle: { color: '#bbbbbb' } });
});

test('baked specs return their own option and count points', () => {
  const chart: ChartSpec = {
    id: 'baked',
    title: '烘焙',
    mode: 'baked',
    type: 'bar',
    option: { series: [{ type: 'bar', data: [1, 2, 3] }] },
  };
  const result = buildOption(bundleOfSpec(chart), chart);
  assert.equal(result.option.animation, false);
  assert.equal(result.points, 3);
});

test('empty data yields zero points', () => {
  const chart = spec({
    id: 'empty',
    title: '空',
    type: 'bar',
    datasetId: 'ds_empty',
    slots: { category: 'site', values: [{ column: 'pages' }] },
  });
  assert.equal(buildOption(bundleOfSpec(chart), chart).points, 0);
});
