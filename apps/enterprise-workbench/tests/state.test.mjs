import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeRun, appLabel, barrierLabel, canAppend, canCancel, canRetry, describeModel, executorLabel, formatTime,
  inputStatusLabel, isTerminal, latestRun, modelEntries, resolvePreference, runNotice, runStateLabel, sortRuns,
} from '../src/state.mjs';

const catalog = {
  catalogId: 'test',
  defaultSelectionId: 'model.flash',
  entries: [
    { selectionId: 'model.flash', provider: 'deepseek-official', model: 'deepseek-flash', displayName: 'Flash', available: true, verification: 'provider-declared' },
    { selectionId: 'model.off', provider: 'deepseek-official', model: 'deepseek-off', displayName: 'Off', available: false, unavailableReason: '组织停用' },
  ],
};
const run = (overrides = {}) => ({
  runId: 'r1', workId: 'w1', appId: 'listing', appVersion: '1.0.0',
  createdAt: '2026-11-11T00:00:00.000Z',
  snapshot: { state: 'QUEUED', revision: 1, fencingToken: 0, barrier: {}, cancelRequested: false },
  model: null,
  ...overrides,
});

test('run states are labelled with honest tone and terminal semantics', () => {
  assert.equal(runStateLabel('QUEUED').label, '已排队');
  assert.equal(runStateLabel('SUCCEEDED').tone, 'success');
  assert.match(runStateLabel('SUCCEEDED').detail, /不代表业务审核/);
  assert.equal(runStateLabel('UNRECORDED').tone, 'unknown');
  assert.equal(isTerminal('SUCCEEDED'), true);
  assert.equal(isTerminal('QUEUED'), false);
});

test('run ordering prefers newest creation and finds the active attempt', () => {
  const older = run({ runId: 'old', createdAt: '2026-11-10T00:00:00.000Z', snapshot: { ...run().snapshot, state: 'FAILED' } });
  const newer = run({ runId: 'new', createdAt: '2026-11-12T00:00:00.000Z' });
  assert.deepEqual(sortRuns([older, newer]).map((item) => item.runId), ['new', 'old']);
  assert.equal(latestRun([older, newer]).runId, 'new');
  assert.equal(activeRun([older, newer]).runId, 'new');
  assert.equal(activeRun([older]), null);
});

test('preference resolution never invents an available model', () => {
  assert.equal(resolvePreference(catalog, null).state, 'none');
  assert.equal(resolvePreference(catalog, null).entry.selectionId, 'model.flash');
  assert.deepEqual(
    resolvePreference(catalog, { selectionId: 'model.flash', state: 'available' }),
    { selectionId: 'model.flash', entry: modelEntries(catalog)[0], state: 'available' },
  );
  assert.equal(resolvePreference({ ...catalog, defaultSelectionId: 'model.off' }, null).entry, null);
  assert.equal(resolvePreference({ ...catalog, defaultSelectionId: undefined }, null).entry, null);
  const disabled = resolvePreference(catalog, { selectionId: 'model.off', state: 'unavailable' });
  assert.equal(disabled.state, 'unavailable');
  assert.equal(disabled.entry.selectionId, 'model.off');
  const unknown = resolvePreference(catalog, { selectionId: 'model.gone', state: 'unknown' });
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.entry, null);
});

test('model descriptions expose route and selection source without guessing', () => {
  assert.match(describeModel(null).name, /未记录/);
  assert.equal(describeModel({ provider: 'deepseek-official', model: 'deepseek-flash', selectionId: 'm', selectionSource: 'explicit' }).route, 'deepseek-official/deepseek-flash');
  assert.equal(describeModel({ provider: 'p', model: 'm', selectionId: 'm', selectionSource: 'preference' }).source, '保存的偏好');
  assert.equal(describeModel({ provider: 'p', model: 'm', selectionId: 'm', selectionSource: 'retry' }).source, '沿用原运行');
});

test('executor, notice and action rules keep queued work honest', () => {
  assert.equal(executorLabel({ executor: 'not-configured' }).tone, 'waiting');
  assert.match(executorLabel({ executor: 'not-configured' }).note, /不会产生模型或工具活动/);
  const notice = runNotice(run(), { executor: 'not-configured' });
  assert.equal(notice.title, '已保存并排队，尚未执行');
  assert.equal(runNotice(run({ snapshot: { ...run().snapshot, state: 'RUNNING' } }), { executor: 'x' }), null);
  const failed = runNotice(run({ snapshot: { ...run().snapshot, state: 'FAILED', reason: 'WORKER_TIMEOUT' } }), { executor: 'x' });
  assert.match(failed.text, /WORKER_TIMEOUT/);
  assert.equal(canCancel(run()), true);
  assert.equal(canCancel(run({ snapshot: { ...run().snapshot, cancelRequested: true } })), false);
  assert.equal(canRetry(run({ snapshot: { ...run().snapshot, state: 'FAILED' } })), true);
  assert.equal(canRetry(run()), false);
});

test('unknown and finalizing runs never offer unsafe input or retry', () => {
  const unknown = run({ snapshot: { ...run().snapshot, state: 'UNKNOWN' } });
  assert.equal(runStateLabel('UNKNOWN').label, '结果未知');
  assert.equal(isTerminal('UNKNOWN'), false);
  assert.equal(canAppend(unknown), false);
  assert.equal(canRetry(unknown), false);
  assert.equal(canCancel(unknown), false);
  assert.equal(canAppend(run({ snapshot: { ...run().snapshot, state: 'FINALIZING' } })), false);
  assert.equal(canAppend(run()), true);
});

test('supporting labels remain readable', () => {
  assert.equal(appLabel([{ appId: 'a', appVersion: '1', descriptor: { displayName: '应用 A' } }], 'a', '1'), '应用 A');
  assert.equal(appLabel([], 'a', '1'), 'a@1');
  assert.equal(barrierLabel({ inputsSettled: true, descendantsDone: true, artifactsRegistered: false, cleanedUp: false }), '2/4 项事实');
  assert.equal(inputStatusLabel('PENDING'), '已保存，待接收');
  assert.equal(inputStatusLabel('CONSUMED'), '已被执行接收');
  assert.equal(inputStatusLabel('other'), '未记录');
  assert.equal(formatTime('not-a-date'), '时间未记录');
  assert.match(formatTime('2026-11-11T00:00:00.000Z'), /2026/);
});
