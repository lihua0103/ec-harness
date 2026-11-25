import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor } from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import type { InputCommit } from '../src/store.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:work-test', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:work-test', kind: 'service' };
const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

class CaptureExecutor implements RunExecutor {
  readonly kind = 'capture';
  inputs: InputCommit[] | undefined;
  async dispatch(input: { inputs?: InputCommit[]; launchId?: string; fencingToken?: number }) {
    this.inputs = input.inputs;
    return { launchId: input.launchId ?? 'launch-work-1', fencingToken: input.fencingToken ?? 1 };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-work-'));
  const executor = new CaptureExecutor();
  const path = join(root, 'control.sqlite');
  const service = new PlatformControlService(path, executor);
  service.registerApp(draft(), operator);
  service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
  return { root, path, executor, service };
};

test('an UNKNOWN attempt quarantines its Work instead of admitting a competing session', async () => {
  const { root, service } = await setup();
  try {
    const work = service.createWork({ projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: 'Unknown' }, operator);
    const run = service.createWorkRun(work.workId, {}, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    service.reconcileOrphans(supervisor);
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'UNKNOWN');
    assert.throws(() => service.createWorkRun(work.workId, {}, operator), isPlatformError('WORK_ACTIVE_RUN_EXISTS'));
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a Work binds project and app release; runs are attempts under it', async () => {
  const { root, service } = await setup();
  try {
    const work = service.createWork(
      { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '合成工作' },
      operator,
    );
    assert.equal(work.state, 'ACTIVE');
    const run = service.createWorkRun(work.workId, { goal: 'synthetic' }, operator);
    assert.equal(run.workId, work.workId);
    assert.equal(run.appId, 'listing');
    assert.equal(run.appVersion, '1.0.0');
    const page = service.runsForWork(work.workId, 0, 20, operator);
    assert.equal(page.total, 1);
    assert.equal(page.items[0].runId, run.runId);
    assert.equal(service.getWork(work.workId, operator).title, '合成工作');
    assert.equal(service.listWorks('ACTIVE', 0, 20, operator).total, 1);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('same Work admits at most one non-terminal run; a terminal run frees the next attempt', async () => {
  const { root, service } = await setup();
  try {
    const work = service.createWork(
      { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '单活动运行' },
      operator,
    );
    const first = service.createWorkRun(work.workId, {}, operator);
    assert.throws(() => service.createWorkRun(work.workId, {}, operator), isPlatformError('WORK_ACTIVE_RUN_EXISTS'));
    service.fail(first.runId, first.snapshot.revision, 'synthetic failure', supervisor);
    const second = service.createWorkRun(work.workId, {}, operator);
    assert.notEqual(second.runId, first.runId);
    assert.equal(second.workId, work.workId);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('archived Work refuses new runs and retries but keeps history readable', async () => {
  const { root, service } = await setup();
  try {
    const work = service.createWork(
      { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '归档工作' },
      operator,
    );
    const run = service.createWorkRun(work.workId, {}, operator);
    service.fail(run.runId, run.snapshot.revision, 'synthetic failure', supervisor);
    service.archiveWork(work.workId, operator);
    assert.equal(service.getWork(work.workId, operator).state, 'ARCHIVED');
    assert.throws(() => service.createWorkRun(work.workId, {}, operator), isPlatformError('WORK_ARCHIVED'));
    assert.throws(() => service.retryRun(run.runId, operator), isPlatformError('WORK_ARCHIVED'));
    assert.equal(service.runsForWork(work.workId, 0, 20, operator).total, 1);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Work creation validates identifiers and requires an ACTIVE app release', async () => {
  const { root, service } = await setup();
  try {
    assert.throws(
      () => service.createWork({ projectId: '', appId: 'listing', appVersion: '1.0.0', title: 't' }, operator),
      isPlatformError('WORK_INVALID'),
    );
    assert.throws(
      () => service.createWork({ projectId: 'P1', appId: 'listing', appVersion: '1.0.0', title: '   ' }, operator),
      isPlatformError('WORK_INVALID'),
    );
    assert.throws(
      () => service.createWork({ projectId: 'P1', appId: 'missing', appVersion: '1.0.0', title: 't' }, operator),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'APP_NOT_FOUND',
    );
    service.revokeApp('listing', '1.0.0', 'synthetic revoke', operator);
    assert.throws(
      () => service.createWork({ projectId: 'P1', appId: 'listing', appVersion: '1.0.0', title: 't' }, operator),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'APP_RELEASE_NOT_ACTIVE',
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('works and run bindings survive a control restart', async () => {
  const { root, path, service } = await setup();
  try {
    const work = service.createWork(
      { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '持久工作' },
      operator,
    );
    const run = service.createWorkRun(work.workId, { goal: 'persist' }, operator);
    service.close();
    const reopened = new PlatformControlService(path);
    try {
      assert.equal(reopened.getWork(work.workId, operator).title, '持久工作');
      assert.equal(reopened.getRun(run.runId, operator).workId, work.workId);
      assert.equal(reopened.runsForWork(work.workId, 0, 20, operator).total, 1);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatch delivers every accepted input, not only the first page', async () => {
  const { root, executor, service } = await setup();
  try {
    let run = service.createRun('listing', '1.0.0', { sequence: 1 }, operator);
    for (let sequence = 2; sequence <= 101; sequence++) {
      service.appendInput(run.runId, { sequence }, operator);
    }
    run = await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    assert.equal(executor.inputs?.length, 101);
    assert.equal(executor.inputs?.at(-1)?.sequence, 101);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
