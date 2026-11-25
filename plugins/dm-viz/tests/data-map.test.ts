import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDataMap, buildDynamicXlsx, configFieldList, DIMENSION_COLUMN } from '../src/data-map.js';

test('line option: primitives → axis + named series replacement with seed rows', () => {
  const option = {
    xAxis: { type: 'category', data: ['2026-10', '2026-11', '2026-12'] },
    yAxis: { type: 'value' },
    series: [
      { name: 'Actual', type: 'line', data: [8, 18, 29] },
      { name: 'Approved plan', type: 'line', data: [12, 22, 33] },
    ],
  };
  const plan = planDataMap(option, 'line');
  assert.equal(plan.dynamic, true);
  assert.deepEqual(plan.header, ['CATEGORY', 'Actual', 'Approved plan']);
  assert.deepEqual(plan.rows[1], ['2026-10', 8, 12]);
  assert.deepEqual(plan.rows[3], ['2026-12', 29, 33]);
  assert.equal(plan.dataMap.axis, true);
  assert.deepEqual(plan.dataMap.series, ['Actual', 'Approved plan']);
});

test('pie option: {name,value} points → categoryValue shape with axis off', () => {
  const option = {
    series: [
      {
        name: 'Anomalies', type: 'pie',
        data: [
          { name: 'Enrollment', value: 120 },
          { name: 'Supply', value: 15 },
        ],
      },
    ],
  };
  const plan = planDataMap(option, 'pie');
  assert.equal(plan.dynamic, true);
  assert.equal(plan.dataMap.axis, false);
  assert.deepEqual(plan.dataMap.series, [{ match: 'Anomalies', shape: 'categoryValue' }]);
  assert.deepEqual(plan.header, ['CATEGORY', 'Anomalies']);
  assert.deepEqual(plan.rows.slice(1), [['Enrollment', 120], ['Supply', 15]]);
});

test('unnamed pie series: measure name VALUE is synthesized on the option and header', () => {
  const option = {
    series: [
      {
        type: 'pie',
        data: [
          { name: 'Enrollment', value: 96, itemStyle: { color: '#1f5fa8' }, selected: false },
          { name: 'Supply', value: 15 },
        ],
      },
    ],
  };
  const plan = planDataMap(option, 'pie');
  assert.equal(plan.dynamic, true);
  assert.deepEqual(plan.header, ['CATEGORY', 'VALUE']);
  assert.equal((option.series as { name?: string }[])[0]!.name, 'VALUE'); // 写回供渲染器按名命中
  assert.deepEqual(plan.rows.slice(1), [['Enrollment', 96], ['Supply', 15]]);
});

test('bar option with {value,itemStyle} per-point objects: axis categories + plain series entry', () => {
  const option = {
    xAxis: { type: 'value' },
    yAxis: { type: 'category', data: ['Evaluable', 'Valid-needs-SAP', 'Invalid', 'Not collected', 'In transit'] },
    series: [
      {
        name: 'Due endpoints', type: 'bar',
        data: [
          { value: 1061, itemStyle: { color: '#1f5fa8', borderRadius: [0, 4, 4, 0] } },
          { value: 148, itemStyle: { color: '#1f5fa8', borderRadius: [0, 4, 4, 0] } },
        ],
      },
    ],
  };
  const plan = planDataMap(option, 'bar');
  assert.equal(plan.dynamic, true);
  assert.equal(plan.dataMap.axis, true); // 类目轴被识别，维度列取真实轴标签
  assert.deepEqual(plan.dataMap.series, ['Due endpoints']); // 直接替换（渲染器原地合并保留逐点样式）
  assert.deepEqual(plan.header, ['CATEGORY', 'Due endpoints']);
  assert.deepEqual(plan.rows[1], ['Evaluable', 1061]);
  assert.equal((option.series as { data: { value: number }[] }[])[0]!.data[0]!.value, 1061);
});

test('helper pie series keeps its __ name and stays out of the dataset', () => {
  const option = {
    series: [
      {
        name: '__totals', type: 'pie',
        data: [{ name: 'A', value: 1 }, { name: 'B', value: 2 }],
      },
    ],
  };
  const plan = planDataMap(option, 'pie');
  assert.equal(plan.dynamic, false);
  assert.equal((option.series as { name?: string }[])[0]!.name, '__totals');
});

test('helper series and unmappable pair data are skipped; none left → not dynamic', () => {
  const withHelper = planDataMap({
    xAxis: { type: 'category', data: ['a', 'b'] },
    series: [
      { name: '__totals', type: 'scatter', data: [5, 6] },
      { name: 'Key CRFs', type: 'bar', data: [37, 27] },
    ],
  }, 'bar');
  assert.deepEqual(withHelper.header, ['CATEGORY', 'Key CRFs']);

  const pairsOnly = planDataMap({
    xAxis: { type: 'category', data: ['x', 'y'] },
    series: [{ name: 'Dumbbell', type: 'custom', data: [[1, 2], [3, 4]] }],
  }, 'custom');
  assert.equal(pairsOnly.dynamic, false);
});

test('renderer contract round-trip: seed rows → fake item → wanted series receive original data', () => {
  const option = {
    xAxis: { type: 'category', data: ['2026-10', '2026-11'] },
    series: [{ name: 'Actual', type: 'line', data: [8, 18] }],
  };
  const plan = planDataMap(option, 'line');
  const byColumn = new Map(plan.header.map((name, index) => [name, index]));
  const item = {
    xAxisData: plan.rows.slice(1).map((row) => row[byColumn.get(DIMENSION_COLUMN)!]),
    seriesData: plan.header.slice(1).map((name) => ({
      name,
      data: plan.rows.slice(1).map((row) => row[byColumn.get(name)!]),
    })),
  };
  assert.deepEqual(item.xAxisData, ['2026-10', '2026-11']);
  assert.deepEqual(item.seriesData[0], { name: 'Actual', data: [8, 18] });
});

test('buildDynamicXlsx + configFieldList produce dataset artifacts', () => {
  const plan = planDataMap({
    xAxis: { type: 'category', data: ['a', 'b'] },
    series: [{ name: 'Actual', type: 'bar', data: [1, 2] }],
  }, 'bar');
  const buffer = buildDynamicXlsx(plan);
  assert.ok(buffer.length > 200);
  const dataset = {
    tableId: '7', tableName: 'VIZ_DYN_x',
    columns: {
      CATEGORY: { id: '1', name: 'CATEGORY', type: 'Text' },
      Actual: { id: '2', name: 'Actual', type: 'Number' },
    },
  };
  const fieldList = configFieldList(dataset as never, plan.header);
  assert.equal(fieldList.dimension[0].name, 'CATEGORY');
  assert.deepEqual(fieldList.number.map((slot: { name: string }) => slot.name), ['Actual']);
});

test('unnamed non-pie series get synthesized VALUE names written back', () => {
  const option: any = {
    xAxis: { type: 'category', data: ['a', 'b', 'c'] },
    series: [
      { type: 'bar', data: [1, 2, 3] },
      { type: 'bar', data: [{ value: 4, itemStyle: { color: '#33959b' } }, { value: 5, itemStyle: { color: '#33959b' } }, { value: 6, itemStyle: { color: '#33959b' } }] },
      { type: 'scatter', data: [[1, 0], [2, 0]] },
    ],
  };
  const plan = planDataMap(option, 'bar');
  assert.equal(plan.dynamic, true);
  assert.equal(option.series[0].name, 'VALUE');
  assert.equal(option.series[1].name, 'VALUE2');
  // 不可数据化的 [x,y] 散点保持无名，不进数据集
  assert.equal(option.series[2].name, undefined);
  assert.deepEqual(plan.header, ['CATEGORY', 'VALUE', 'VALUE2']);
  assert.deepEqual(plan.rows.slice(1).map((row) => row.slice(1)), [[1, 4], [2, 5], [3, 6]]);
});

test('null missing points are tolerated and carried into seed rows', () => {
  const option: any = {
    xAxis: { type: 'category', data: ['a', 'b', 'c', 'd'] },
    series: [
      { name: 'S', type: 'bar', data: [10, null, 30, 25] },
      { type: 'bar', data: [null, 2, null, 4] }, // 首点即 null：分类基准取首个非空点
    ],
  };
  const plan = planDataMap(option, 'bar');
  assert.equal(plan.dynamic, true);
  assert.equal(option.series[1].name, 'VALUE'); // 首点 null 的无名系列仍被合成命名
  assert.deepEqual(plan.header, ['CATEGORY', 'S', 'VALUE']);
  assert.deepEqual(plan.rows[1], ['a', 10, null]);
  assert.deepEqual(plan.rows[2], ['b', null, 2]);
  assert.deepEqual(plan.rows[4], ['d', 25, 4]);
});

test('category axis length wins over shorter series; tails null-filled', () => {
  // b11p1 实证：到达系列只有 4 行、类目轴 5 行（Center 05 到达未知）——行数必须跟轴走，
  // 否则轴被数据集截断、最后一行整体丢失。
  const option: any = {
    yAxis: { type: 'category', data: ['C1', 'C2', 'C3', 'C4', 'C5'] },
    xAxis: { type: 'value' },
    series: [
      { type: 'bar', data: [0, 10, null, 14] }, // 少于轴：尾行 null
      { type: 'bar', data: [3, 5, null, 5, 5] },
    ],
  };
  const plan = planDataMap(option, 'bar');
  assert.equal(plan.dynamic, true);
  assert.deepEqual(plan.header, ['CATEGORY', 'VALUE', 'VALUE2']);
  assert.deepEqual(
    plan.rows.slice(1),
    [
      ['C1', 0, 3],
      ['C2', 10, 5],
      ['C3', null, null],
      ['C4', 14, 5],
      ['C5', null, 5],
    ],
  );
});
