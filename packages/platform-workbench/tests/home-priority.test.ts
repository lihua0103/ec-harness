import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunSummary, WorkbenchBootstrap, WorkbenchItem } from '../src/api.js';
import { homePriority, latestHomeRuns } from '../src/home-priority.js';

const work: WorkbenchItem = { workId: 'w', title: 'Protocol review', projectId: 'p', appId: 'app', appVersion: '1', state: 'ACTIVE' };
const run = (runId: string, day: string, state: string, workId = 'w'): RunSummary => ({
  workId, runId, appId: 'app', appVersion: '1', createdAt: `2026-11-${day}T00:00:00Z`, snapshot: { state },
});

test('homepage surfaces the latest known failure without adding a to-do', () => {
  const todos: NonNullable<WorkbenchBootstrap['todos']> = [];
  const runs = latestHomeRuns([run('old', '17', 'SUCCEEDED'), run('new', '18', 'FAILED')]);
  assert.equal(homePriority([work], runs, todos)?.runId, 'new');
  assert.equal(homePriority([work], runs, todos)?.kind, 'failed');
  assert.equal(todos.length, 0);
});

test('homepage ignores superseded failures, absent works and archived works', () => {
  assert.equal(homePriority([work], latestHomeRuns([run('new', '18', 'RUNNING'), run('old', '17', 'FAILED')]), []), null);
  const failed = latestHomeRuns([run('old', '17', 'FAILED')]);
  assert.equal(homePriority([{ ...work, state: 'ARCHIVED' }], failed, []), null);
  assert.equal(homePriority([], failed, []), null);
});

test('actionable server to-do takes precedence over a failed run', () => {
  const todos: NonNullable<WorkbenchBootstrap['todos']> = [
    { kind: 'review', id: 'review', workId: 'w', runId: 'review-run', createdAt: '2026-11-17T00:00:00Z', summary: '', resolveHint: '' },
    { kind: 'question', id: 'unlinked', workId: 'w', runId: null, createdAt: '2026-11-18T00:00:00Z', summary: '', resolveHint: '' },
  ];
  const priority = homePriority([work], latestHomeRuns([run('failed', '18', 'FAILED')]), todos);
  assert.equal(priority?.kind, 'todo');
  assert.equal(priority?.runId, 'review-run');
});
