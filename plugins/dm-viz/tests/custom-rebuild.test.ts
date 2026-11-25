import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebuildCustomOption } from '../src/custom-rebuild.js';

const yAxis = [{ type: 'category', data: ['A', 'B', 'C'] }];
const base = {
  color: ['#1f5fa8'],
  xAxis: [{ type: 'value' }],
  yAxis,
  legend: [{ data: ['One', 'Two'] }],
  series: [],
};

test('window chart becomes range bars plus confirmed scatter', () => {
  const option = rebuildCustomOption('b1p3', {
    ...base,
    series: [
      { type: 'custom', data: [[0, 2, 4], [1, 4, 6], [2, 14, 16]] },
      { type: 'scatter', data: [{ value: [5, 0] }, { value: [6, 1] }] },
    ],
  });
  const series = option.series as Array<Record<string, unknown>>;
  assert.deepEqual(series.map((item) => item.type), ['bar', 'bar', 'scatter']);
  assert.deepEqual(series[0]!.data, [2, 4, 14]);
  assert.deepEqual(series[1]!.data, [2, 2, 2]);
  assert.equal((series[2]!.data as unknown[]).length, 2);
});

test('custom series never survives the rebuild', () => {
  const samples: Record<string, unknown[]> = {
    b1p3: [[0, 2, 4], [1, 4, 6], [2, 14, 16]],
    b3p1: [[0, 18, 24], [1, 26, 20], [2, 15, 18]],
    b5p3: [[0, 10], [1, 11], [2, 12]],
    b8p2: [{ value: [0, 88, 82, 94] }, { value: [1, 79, 67, 91] }],
    b11p1: [{ value: [0, 10, 15, 12, 1] }, { value: [1, 18, 25, 21, 1] }],
    b11p2: [[0, 0, 3, 0, 12], [1, 2, 6, 1, 16]],
  };
  for (const [card, data] of Object.entries(samples)) {
    const option = rebuildCustomOption(card, {
      ...base,
      series: [
        { type: 'custom', data },
        { type: 'custom', data },
      ],
    });
    const types = (option.series as Array<Record<string, unknown>>).map((item) => item.type);
    assert.ok(!types.includes('custom'), card + ' still has custom series');
  }
});

test('error-bar chart keeps interval bounds as markLine segments', () => {
  const option = rebuildCustomOption('b8p2', {
    ...base,
    series: [
      { type: 'custom', data: [{ value: [0, 88, 82, 94] }, { value: [1, 79, 67, 91] }] },
      { type: 'line', data: [[90, 0], [90, 1]] },
    ],
  });
  const series = option.series as Array<Record<string, unknown>>;
  const marks = (series[0]!.markLine as Record<string, unknown>).data as Array<Array<{ coord: number[] }>>;
  assert.deepEqual(marks[0]!.map((point) => point.coord), [[82, 0], [94, 0]]);
  assert.equal(series[1]!.type, 'line');
});

test('b11p2 splits temperature bands into uniform-color series instead of per-point colors', () => {
  // 拆等色系列+null 占位是温度带的配置面表达；逐点色不上堆叠系列。
  const option = rebuildCustomOption('b11p2', {
    ...base,
    series: [
      {
        type: 'custom',
        data: [
          [0, 0, 3, 0, 12],
          [1, 2, 6, 1, 16],
          [2, 4, 9, 1, 20],
        ],
      },
    ],
  });
  const series = option.series as Array<Record<string, unknown>>;
  assert.equal(series.length, 4); // 底座 + 三个温度带系列
  assert.deepEqual((series[0] as { data: unknown[] }).data, [0, 2, 4]);
  assert.deepEqual((series[1] as { data: unknown[] }).data, [3, null, null]);
  assert.deepEqual((series[2] as { data: unknown[] }).data, [null, 4, 5]);
  assert.deepEqual((series[3] as { data: unknown[] }).data, [null, null, null]);
  const colors = series.slice(1).map((item) => (item.itemStyle as { color: string }).color);
  assert.deepEqual(colors, ['#33959b', '#af8a49', '#ce626a']);
  for (const span of series.slice(1)) {
    assert.equal(span.colorBy, undefined, 'colorBy must not be used on stacked series');
    assert.deepEqual((span as { stack?: unknown }).stack, 'band');
  }
  assert.ok((series[1] as { markPoint?: unknown }).markPoint, 'temperature labels ride the first band series');
  assert.equal((series[2] as { markPoint?: unknown }).markPoint, undefined);
});

test('b11p2 neutralizes leftover piecewise visualMap so it cannot swallow band colors', () => {
  // 根因（displayList+SSR 实证）：旧设计 piecewise visualMap dimension:3 指向重建后不存在的维，
  // outOfRange 透明吞掉全部色带、pieces 错染单柱、show:true 画假图例。
  // 中和=seriesIndex:[]（控件只当图例）+pieces 色=设计色带；系列名保持 VALUE.. 供 planFor 按名匹配。
  const option = rebuildCustomOption('b11p2', {
    ...base,
    visualMap: [{
      type: 'piecewise', dimension: 3, show: true, seriesIndex: 'all',
      outOfRange: { color: ['rgba(0,0,0,0)'] },
      pieces: [
        { value: 0, label: '< 15 °C', color: '#007b82' },
        { value: 1, label: '15–25 °C', color: '#9c6d1c' },
        { value: 2, label: '> 25 °C', color: '#c23b45' },
      ],
    }],
    series: [{ type: 'custom', data: [[0, 0, 3, 0, 12], [1, 2, 6, 1, 16]] }],
  });
  const vm = (option.visualMap as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(vm.seriesIndex, [], 'visualMap must target no series after rebuild');
  assert.deepEqual((vm.pieces as Array<{ color: string }>).map((p) => p.color), ['#33959b', '#af8a49', '#ce626a']);
  assert.equal(vm.show, true, 'controller stays as the three-band legend');
  const names = (option.series as Array<{ name?: string }>).map((s) => s.name);
  assert.deepEqual(names, ['', '', '', ''], 'series names stay unsynthesized here; planFor assigns VALUE.. later');
});

test('b11p2 normalizes xAxis and guards value axis against alignAxisType', () => {
  // design.json 的 b11p2 无 xAxis 键；keepFrame 不拷它，历史重建产物无 xAxis →
  // 第三方 alignAxisType 会把无 data 的 value 主轴强改 category，复发竖直柱。
  const withoutXAxis: Record<string, unknown> = { ...base, series: [{ type: 'custom', data: [[0, 0, 3, 0, 12]] }] };
  delete withoutXAxis.xAxis;
  const rebuilt = rebuildCustomOption('b11p2', withoutXAxis);
  assert.ok(Array.isArray(rebuilt.xAxis), 'rebuild must normalize xAxis to an array');
  assert.equal((rebuilt.xAxis as Array<Record<string, unknown>>)[0]!.type, 'value');
  assert.deepEqual((rebuilt.xAxis as Array<Record<string, unknown>>)[0]!.data, ['value-axis-guard']);

  // 已有对象形态的 xAxis 转数组并保留 name/max 等字段。
  const withObjectAxis = rebuildCustomOption('b11p2', {
    ...base,
    xAxis: { type: 'value', name: 'Hours since dispatch', max: 17 },
    series: [{ type: 'custom', data: [[0, 0, 3, 0, 12]] }],
  });
  assert.ok(Array.isArray(withObjectAxis.xAxis));
  const axis = (withObjectAxis.xAxis as Array<Record<string, unknown>>)[0]!;
  assert.equal(axis.type, 'value');
  assert.equal(axis.name, 'Hours since dispatch');
  assert.equal(axis.max, 17);
  assert.deepEqual(axis.data, ['value-axis-guard']);
});

test('unsupported card is refused instead of silently dropped', () => {
  assert.throws(() => rebuildCustomOption('b0p0', { ...base }), /CUSTOM_REBUILD_UNSUPPORTED/);
});
