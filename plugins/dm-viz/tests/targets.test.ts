import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRbqmTarget, platformTarget, type ApplyOperation, type TargetTransport } from '../src/targets.js';
import type { Bundle, ChartSpec } from '../../../packages/platform-viz/src/index.js';
import { allDatasets, bundleOf, layout, spec } from './fixtures.js';

function pageBundle(): Bundle {
  const specs: ChartSpec[] = [
    spec({
      id: 't1',
      title: '单系列',
      type: 'bar',
      datasetId: 'ds_sites',
      slots: { category: 'site', values: [{ column: 'pages' }] },
    }),
    spec({
      id: 't2',
      title: '堆叠',
      type: 'horizontalbar',
      preset: 'stacked',
      datasetId: 'ds_sites',
      slots: { category: 'site', values: [{ column: 'pages' }, { column: 'visits' }] },
    }),
  ];
  return bundleOf(
    specs,
    layout(
      [
        { kind: 'divider', i: 'd0', title: '分区', x: 0, y: 0, w: 24, h: 1 },
        { kind: 'chart', i: 'c1', specId: 't1', x: 0, y: 1, w: 12, h: 6 },
        { kind: 'chart', i: 'c2', specId: 't2', x: 12, y: 1, w: 12, h: 6 },
      ],
      'tp',
    ),
    allDatasets(),
  );
}

function countOf(operations: ApplyOperation[], kind: ApplyOperation['op']): number {
  return operations.filter((operation) => operation.op === kind).length;
}

test('platform target produces no external operations and no gaps', () => {
  const plan = platformTarget.plan(pageBundle());
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.gaps, []);
  assert.equal(platformTarget.kind, 'platform');
  assert.equal(platformTarget.capabilities().runtimeTypeRegistration, false);
});

test('rbqm plan registers types and configs before layout', () => {
  const plan = createRbqmTarget().plan(pageBundle());
  assert.deepEqual(plan.gaps, []);
  assert.equal(countOf(plan.operations, 'upsertDataset'), allDatasets().length);
  assert.equal(countOf(plan.operations, 'registerChartType'), 2);
  assert.equal(countOf(plan.operations, 'saveChartConfig'), 2);
  assert.equal(countOf(plan.operations, 'saveChartLayout'), 1);
  assert.equal(plan.operations.at(-1)!.op, 'saveChartLayout');
  const layoutPayload = plan.operations.at(-1)!.payload as { items: Array<Record<string, unknown>> };
  assert.equal(layoutPayload.items.length, 3);
  assert.equal(layoutPayload.items[0]!.type, 3);
  assert.equal(layoutPayload.items[1]!.type, 1);
});

test('unsupported types become gaps and are not written', () => {
  const plan = createRbqmTarget({ supportedTypes: ['bar'] }).plan(pageBundle());
  assert.ok(plan.gaps.includes('UNSUPPORTED_TYPE:horizontalbar@t2'));
  assert.equal(countOf(plan.operations, 'registerChartType'), 1);
  assert.equal(countOf(plan.operations, 'saveChartConfig'), 1);
});

test('series limit is reported when the target cannot register types', () => {
  const plan = createRbqmTarget({ runtimeTypeRegistration: false, maxSeriesPerChart: 1 }).plan(pageBundle());
  assert.ok(plan.gaps.includes('SERIES_LIMIT:t2:2>1'));
});

test('baked specs without registration are reported, not silently degraded', () => {
  const baked: ChartSpec = {
    id: 'b1',
    title: '烘焙',
    mode: 'baked',
    type: 'bar',
    option: { series: [{ type: 'bar', data: [1, 2] }] },
  };
  const bundle = bundleOf(
    [baked],
    layout([{ kind: 'chart', i: 'c1', specId: 'b1', x: 0, y: 0, w: 12, h: 6 }], 'bp'),
    allDatasets(),
  );
  const plan = createRbqmTarget({ runtimeTypeRegistration: false, supportsBaked: false }).plan(bundle);
  assert.ok(plan.gaps.includes('BAKED_UNSUPPORTED:b1'));
  assert.ok(plan.gaps.includes('BAKED_REQUIRES_REGISTRATION:b1'));
});

test('apply writes through the transport and collects ids', async () => {
  const calls: ApplyOperation[] = [];
  const transport: TargetTransport = {
    async call(operation) {
      calls.push(operation);
      return { ok: true, id: `${operation.op}:${calls.length}` };
    },
  };
  const result = await createRbqmTarget().apply(pageBundle(), transport);
  assert.equal(result.gaps.length, 0);
  assert.equal(result.applied, calls.length);
  assert.equal(result.results.length, calls.length);
  assert.ok(result.results.every((entry) => entry.ok));
  assert.equal(result.results.at(-1)!.id, `saveChartLayout:${calls.length}`);
});

test('apply refuses to write when gaps exist', async () => {
  let called = 0;
  const transport: TargetTransport = {
    async call() {
      called++;
      return { ok: true };
    },
  };
  const result = await createRbqmTarget({ supportedTypes: ['bar'] }).apply(pageBundle(), transport);
  assert.equal(called, 0);
  assert.equal(result.applied, 0);
  assert.ok(result.gaps.includes('UNSUPPORTED_TYPE:horizontalbar@t2'));
});

test('transport failures are recorded per operation, not thrown away', async () => {
  const transport: TargetTransport = {
    async call(operation) {
      if (operation.op === 'saveChartConfig') throw new Error('HTTP 500');
      return { ok: true };
    },
  };
  const result = await createRbqmTarget().apply(pageBundle(), transport);
  const failed = result.results.filter((entry) => !entry.ok);
  assert.equal(failed.length, 2);
  assert.equal(failed[0]!.detail, 'HTTP 500');
  assert.equal(result.applied, result.results.length - 2);
});

test('planning does not mutate the bundle', () => {
  const bundle = pageBundle();
  const before = JSON.stringify(bundle);
  createRbqmTarget().plan(bundle);
  platformTarget.plan(bundle);
  assert.equal(JSON.stringify(bundle), before);
});
