import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import { PlatformError } from '../src/registry.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:quota', kind: 'operator' };
const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

/** Service without an executor: runs stay QUEUED, which is exactly the state quotas count. */
const setup = async (quotas: { maxConcurrentRunsPerProject?: number; maxRunsPerDayPerProject?: number }) => {
  const root = await mkdtemp(join(tmpdir(), 'platform-quota-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), null, undefined, {
    requireArtifacts: false,
    quotas,
  });
  service.registerApp(draft(), operator);
  service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
  const works = [
    service.createWork(
      { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '配额工作一' },
      operator,
    ),
    service.createWork(
      { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '配额工作二' },
      operator,
    ),
    service.createWork(
      { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '配额工作三' },
      operator,
    ),
  ];
  return { root, service, works };
};

test('the concurrency quota counts every non-terminal run of the project (E2-3)', async () => {
  const { root, service, works } = await setup({ maxConcurrentRunsPerProject: 1 });
  try {
    const first = service.createWorkRun(works[0].workId, { goal: '一' }, operator);
    assert.equal(first.snapshot.state, 'QUEUED');
    // A second queued run in the same project exceeds the cap — before any dispatch happened.
    assert.throws(
      () => service.createWorkRun(works[1].workId, { goal: '二' }, operator),
      isPlatformError('RUN_QUOTA_CONCURRENCY_EXCEEDED'),
    );
    // Cancelling the first run releases the slot.
    await service.cancelRun(first.runId, first.snapshot.revision, operator);
    const second = service.createWorkRun(works[1].workId, { goal: '二' }, operator);
    assert.equal(second.snapshot.state, 'QUEUED');
    // The quota facts state the counting boundary instead of implying universal coverage.
    const facts = service.quotaFacts(operator);
    assert.equal(facts.maxConcurrentRunsPerProject, 1);
    assert.equal(facts.scope.notCounted.includes('runs without a Work'), true);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the daily quota counts every run created today, terminal or not', async () => {
  const { root, service, works } = await setup({ maxRunsPerDayPerProject: 2 });
  try {
    service.createWorkRun(works[0].workId, { goal: '一' }, operator);
    service.createWorkRun(works[1].workId, { goal: '二' }, operator);
    assert.throws(
      () => service.createWorkRun(works[2].workId, { goal: '三' }, operator),
      isPlatformError('RUN_QUOTA_DAILY_EXCEEDED'),
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('quota refusals surface as HTTP 429 with the control-plane code', async () => {
  const { root, service, works } = await setup({ maxConcurrentRunsPerProject: 1 });
  const api = await startWorkbenchServer({ service, authenticate: () => operator });
  try {
    service.createWorkRun(works[0].workId, { goal: '一' }, operator);
    const response = await fetch(`${api.url}/api/works/${encodeURIComponent(works[1].workId)}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { goal: '二' } }),
    });
    assert.equal(response.status, 429);
    const body = await response.json() as { code: string };
    assert.equal(body.code, 'RUN_QUOTA_CONCURRENCY_EXCEEDED');

    const facts = await fetch(`${api.url}/api/quotas`);
    assert.equal(facts.status, 200);
    const quota = await facts.json() as { maxConcurrentRunsPerProject: number };
    assert.equal(quota.maxConcurrentRunsPerProject, 1);
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
