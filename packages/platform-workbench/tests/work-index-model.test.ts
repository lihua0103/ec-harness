import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkRow } from '../src/reports.js';
import { groupWorkRows, pickPreviewWorkId, workRowState, workTimeLabel } from '../src/client/work-index-model.js';

// B1 (方案 B): the work-index projections are pure and clock-injected, so the 「我的工作」
// master list groups by the local day boundary, never invents a time for an unrecorded row,
// and re-selects a preview by the plan §2 rule (visible selection → visible priority → first).

const row = (workId: string, overrides: Partial<WorkRow> = {}): WorkRow => ({
  workId,
  title: `工作 ${workId}`,
  state: 'ACTIVE',
  projectId: 'p',
  projectName: '项目',
  appId: 'app',
  appVersion: '1',
  appName: '应用',
  ...overrides,
});

// 2026-11-22 is a Sunday; the day boundary below is local midnight, injected as `now`.
const NOW = new Date(2026, 10, 22, 10, 30, 0).getTime();
const at = (day: number, hour: number, minute: number): string =>
  new Date(2026, 10, day, hour, minute).toISOString();

test('recent order groups by the local day boundary into 今天 / 更早', () => {
  const sections = groupWorkRows([
    row('today-late', { updatedAt: at(22, 9, 42) }),
    row('today-early', { updatedAt: at(22, 0, 5) }),
    row('older', { updatedAt: at(21, 16, 57) }),
    row('ancient', { updatedAt: at(1, 8, 0) }),
  ], NOW);
  assert.deepEqual(sections.map((section) => section.key), ['today', 'earlier']);
  assert.equal(sections[0].label, '今天');
  assert.deepEqual(sections[0].rows.map((item) => item.workId), ['today-late', 'today-early']);
  assert.equal(sections[1].label, '更早');
  assert.deepEqual(sections[1].rows.map((item) => item.workId), ['older', 'ancient']);
});

test('rows without a usable updatedAt keep an unlabelled trailing section — no invented time', () => {
  const sections = groupWorkRows([
    row('dated', { updatedAt: at(22, 8, 0) }),
    row('undated-1', {}),
    row('undated-2', { updatedAt: 'not-a-date' }),
    row('zero', { updatedAt: '1970-01-01T00:00:00Z' }),
  ], NOW);
  assert.deepEqual(sections.map((section) => section.key), ['today', 'undated']);
  assert.equal(sections[1].label, '');
  assert.deepEqual(sections[1].rows.map((item) => item.workId), ['undated-1', 'undated-2', 'zero']);
});

test('an empty result has no sections and the English locale labels the same groups', () => {
  assert.deepEqual(groupWorkRows([], NOW), []);
  const sections = groupWorkRows([row('a', { updatedAt: at(22, 23, 59) }), row('b', { updatedAt: at(20, 12, 0) })], NOW, 'en-US');
  assert.deepEqual(sections.map((section) => section.label), ['Today', 'Earlier']);
});

test('row time labels: clock today, weekday within the week, date beyond, nothing when unrecorded', () => {
  assert.equal(workTimeLabel(at(22, 9, 5), NOW), '09:05');
  assert.equal(workTimeLabel(at(21, 18, 3), NOW), '昨天');
  assert.equal(workTimeLabel(at(18, 9, 0), NOW), '周三');
  assert.equal(workTimeLabel(at(1, 9, 0), NOW), '2026-11-01');
  assert.equal(workTimeLabel(undefined, NOW), '');
  assert.equal(workTimeLabel('garbage', NOW), '');
  assert.equal(workTimeLabel(at(18, 9, 0), NOW, 'en-US'), 'Wed');
  assert.equal(workTimeLabel(at(21, 18, 3), NOW, 'en-US'), 'Yesterday');
});

test('preview selection keeps a still-visible selection before priority and first row', () => {
  const rows = [row('a'), row('b'), row('c')];
  assert.equal(pickPreviewWorkId(rows, 'b', 'c'), 'b');
  // The priority work only wins when the previous selection is no longer visible.
  assert.equal(pickPreviewWorkId(rows, 'gone', 'c'), 'c');
  assert.equal(pickPreviewWorkId(rows, null, 'b'), 'b');
  // Neither selection nor priority visible → the first visible row.
  assert.equal(pickPreviewWorkId(rows, 'gone', 'also-gone'), 'a');
  assert.equal(pickPreviewWorkId(rows, null, null), 'a');
  // An empty result selects nothing — an empty state, never a fabricated target.
  assert.equal(pickPreviewWorkId([], 'a', 'b'), null);
  assert.equal(pickPreviewWorkId([], null, null), null);
});

test('row state: the latest known run wins, archive and no-run stay muted', () => {
  assert.deepEqual(workRowState(row('w'), { snapshot: { state: 'FAILED' } }), { label: '失败', tone: 'error' });
  assert.deepEqual(workRowState(row('w'), { snapshot: { state: 'SUCCEEDED' } }), { label: '已完成', tone: 'ok' });
  assert.deepEqual(workRowState(row('w'), { snapshot: { state: 'WAITING_FOR_USER' } }), { label: '等待答复', tone: 'warn' });
  assert.deepEqual(workRowState(row('w'), undefined), { label: '暂无运行状态', tone: 'muted' });
  assert.deepEqual(workRowState(row('w', { state: 'ARCHIVED' }), undefined), { label: '已归档', tone: 'muted' });
  // An archived work with a run record still shows the run — the archive does not rewrite it.
  assert.deepEqual(workRowState(row('w', { state: 'ARCHIVED' }), { snapshot: { state: 'RUNNING' } }), { label: '运行中', tone: 'ok' });
  // An unrecognised state never reads as a healthy run.
  const unknown = workRowState(row('w'), { snapshot: { state: 'SOMETHING_NEW' } });
  assert.equal(unknown.tone, 'muted');
});
