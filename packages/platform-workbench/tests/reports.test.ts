import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactDownloadPath,
  formatBytes,
  monogram,
  pageWindow,
  relativeTime,
  runStateLabel,
  runTone,
  selectWorkRows,
  summarizeArtifacts,
  type WorkRow,
} from '../src/reports.js';

test('a page window is clamped to real records instead of showing a fake empty page', () => {
  assert.deepEqual(pageWindow(0, 0, 10), {
    total: 0, offset: 0, limit: 10, page: 1, pages: 1,
    hasPrevious: false, hasNext: false, first: 0, last: 0,
  });
  const first = pageWindow(23, 0, 10);
  assert.equal(first.first, 1);
  assert.equal(first.last, 10);
  assert.equal(first.pages, 3);
  assert.equal(first.hasNext, true);
  assert.equal(first.hasPrevious, false);
  const last = pageWindow(23, 20, 10);
  assert.equal(last.first, 21);
  assert.equal(last.last, 23);
  assert.equal(last.hasNext, false);
  // An offset beyond the last record is corrected, not used to render an empty page.
  const corrected = pageWindow(23, 999, 10);
  assert.equal(corrected.offset, 20);
  assert.equal(corrected.page, 3);
  const negative = pageWindow(23, -5, 10);
  assert.equal(negative.offset, 0);
  assert.equal(negative.page, 1);
});

test('artifact summaries count only recorded seals and valid sizes', () => {
  const summary = summarizeArtifacts([
    { name: 'a.csv', digest: 'a'.repeat(64), bytes: 1024, sealedAt: '2026-11-12T00:00:00.000Z' },
    { name: 'b.csv', digest: 'b'.repeat(64), bytes: 2048 },
    { name: 'c.csv', digest: 'c'.repeat(64), bytes: -1 as number },
  ]);
  assert.deepEqual(summary, { total: 3, sealed: 1, unsealed: 2, bytes: 3072 });
});

test('an artifact download path encodes every segment and cannot escape its run', () => {
  assert.equal(
    artifactDownloadPath('run-1', 'reports/output.csv'),
    '/api/runs/run-1/artifacts/reports/output.csv/download',
  );
  // A traversal segment is refused rather than normalised into a different artifact.
  assert.throws(() => artifactDownloadPath('run 1', '../secret file.txt'), /ARTIFACT_PATH_INVALID/);
  assert.throws(() => artifactDownloadPath('r', 'a/../../b.txt'), /ARTIFACT_PATH_INVALID/);
  assert.throws(() => artifactDownloadPath('r', '..'), /ARTIFACT_PATH_INVALID/);
  assert.throws(() => artifactDownloadPath('r', ''), /ARTIFACT_PATH_INVALID/);
});

test('run state labels are honest for unknown or missing states', () => {
  assert.equal(runStateLabel('SUCCEEDED'), '已成功');
  assert.equal(runStateLabel('WAITING_FOR_USER'), '等待答复');
  assert.equal(runStateLabel('SOMETHING_NEW'), '状态未记录');
  assert.equal(runStateLabel(undefined), '状态未记录');
});

test('byte formatting never invents a size', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
  assert.equal(formatBytes(undefined), '大小未记录');
  assert.equal(formatBytes(-1), '大小未记录');
});

test('activity labels are derived from a recorded time, never invented for a missing one', () => {
  const now = new Date(2026, 10, 13, 16, 52).getTime();
  const at = (day: number, hour: number, minute: number) => new Date(2026, 10, day, hour, minute).toISOString();
  assert.equal(relativeTime(at(13, 16, 52), now), '刚刚');
  assert.equal(relativeTime(at(13, 16, 44), now), '8 分钟前');
  assert.equal(relativeTime(at(13, 9, 10), now), '今天 09:10');
  assert.equal(relativeTime(at(12, 18, 40), now), '昨天 18:40');
  assert.equal(relativeTime(at(10, 8, 0), now), '3 天前');
  assert.equal(relativeTime(new Date(2026, 9, 14, 8, 0).toISOString(), now), '2026-10-14');
  // A clock skew into the future is still "just now", not a negative duration.
  assert.equal(relativeTime(at(13, 17, 30), now), '刚刚');
  assert.equal(relativeTime(undefined, now), '时间未记录');
  assert.equal(relativeTime('not-a-date', now), '时间未记录');
  assert.equal(relativeTime('', now), '时间未记录');
});

test('tile monograms come from the title itself and never render an empty tile', () => {
  assert.equal(monogram('归档资料整理'), '归');
  assert.equal(monogram('QC 报告生成'), 'QC');
  assert.equal(monogram('Baseline Listing'), 'BL');
  assert.equal(monogram('Listing'), 'LI');
  assert.equal(monogram('  数据核查 · 基线批次 '), '数');
  assert.equal(monogram(''), '·');
  assert.equal(monogram(undefined), '·');
});

test('only recorded run states get a health colour', () => {
  assert.equal(runTone('RUNNING'), 'ok');
  assert.equal(runTone('SUCCEEDED'), 'ok');
  assert.equal(runTone('FAILED'), 'error');
  assert.equal(runTone('WAITING_FOR_USER'), 'warn');
  assert.equal(runTone('UNKNOWN'), 'warn');
  assert.equal(runTone('CANCELLED'), 'muted');
  assert.equal(runTone('SOMETHING_NEW'), 'muted');
  assert.equal(runTone(undefined), 'muted');
});

const workRow = (over: Partial<WorkRow> & { workId: string; title: string }): WorkRow => ({
  state: 'ACTIVE',
  projectId: 'p1',
  projectName: '临床数据项目',
  appId: 'app',
  appVersion: '1.0.0',
  appName: '合成应用',
  ...over,
});

test('queue search covers title, project and application, case-insensitively', () => {
  const rows = [
    workRow({ workId: 'a', title: '归档资料整理' }),
    workRow({ workId: 'b', title: 'QC 报告生成', appName: 'Listing 开发' }),
    workRow({ workId: 'c', title: '基线核查', projectName: '肾病研究协作' }),
  ];
  const pick = (query: string) => selectWorkRows(rows, { query, state: 'all', sort: 'recent' }).map((r) => r.workId);
  assert.deepEqual(pick('归档'), ['a']);
  assert.deepEqual(pick('listing'), ['b']);
  assert.deepEqual(pick('肾病'), ['c']);
  assert.deepEqual(pick('  QC  '), ['b']);
  assert.deepEqual(pick('不存在'), []);
  // No recorded activity on any row: the recent order falls back to the zh-CN title order.
  assert.deepEqual(pick(''), ['a', 'c', 'b']);
});

test('the state filter separates archived work without losing it', () => {
  const rows = [
    workRow({ workId: 'a', title: '进行中' }),
    workRow({ workId: 'b', title: '已归档的', state: 'ARCHIVED' }),
  ];
  const pick = (state: 'active' | 'archived' | 'all') => selectWorkRows(rows, { query: '', state, sort: 'title' }).map((r) => r.workId);
  assert.deepEqual(pick('active'), ['a']);
  assert.deepEqual(pick('archived'), ['b']);
  assert.deepEqual(pick('all').length, 2);
});

test('recent order puts unrecorded activity last; title and project orders are stable', () => {
  const rows = [
    workRow({ workId: 'old', title: 'B 工作', updatedAt: '2026-11-10T08:00:00.000Z' }),
    workRow({ workId: 'none', title: 'A 工作' }),
    workRow({ workId: 'new', title: 'C 工作', updatedAt: '2026-11-13T08:00:00.000Z' }),
    workRow({ workId: 'other', title: 'D 工作', projectName: '另一个项目', updatedAt: '2026-11-12T08:00:00.000Z' }),
  ];
  const order = (sort: 'recent' | 'title' | 'project') => selectWorkRows(rows, { query: '', state: 'all', sort }).map((r) => r.workId);
  assert.deepEqual(order('recent'), ['new', 'other', 'old', 'none']);
  assert.deepEqual(order('title'), ['none', 'old', 'new', 'other']);
  // zh-CN collation orders 临床数据项目 before 另一个项目; titles break ties inside a project.
  assert.deepEqual(order('project'), ['none', 'old', 'new', 'other']);
  // The input array is never reordered in place.
  assert.deepEqual(rows.map((r) => r.workId), ['old', 'none', 'new', 'other']);
});
