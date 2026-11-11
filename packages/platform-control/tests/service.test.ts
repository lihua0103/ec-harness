import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor, type RunOutcome } from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:test', kind: 'operator' };
const serviceActor: Principal = { actorId: 'service:supervisor', kind: 'service' };

class FakeExecutor implements RunExecutor {
  readonly kind = 'fake';
  launched: string[] = [];
  cancelled: string[] = [];
  async dispatch(): Promise<{ launchId: string; fencingToken: number }> {
    const launchId = `launch-${this.launched.length + 1}`;
    this.launched.push(launchId);
    return { launchId, fencingToken: this.launched.length };
  }
  async cancel(launchId: string): Promise<boolean> {
    this.cancelled.push(launchId);
    return true;
  }
}
class OutcomeExecutor implements RunExecutor {
  readonly kind = 'outcome';
  constructor(private readonly outcome: RunOutcome) {}
  async dispatch() {
    return { launchId: 'launch-outcome', fencingToken: 1, outcome: Promise.resolve(this.outcome) };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}
const waitForTerminal = async (service: PlatformControlService, runId: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = service.getRun(runId, operator).snapshot.state;
    if (state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not reach a terminal state');
};

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-service-'));
  const path = join(root, 'control.sqlite');
  const executor = new FakeExecutor();
  const service = new PlatformControlService(path, executor);
  service.registerApp(draft(), operator);
  return { root, path, executor, service };
};

test('a run is registered, dispatched, completed with all barrier facts, and survives restart', async () => {
  const { root, path, executor, service } = await setup();
  try {
    let run = service.createRun('listing', '1.0.0', { requirement: 'synthetic' }, operator);
    assert.equal(run.snapshot.state, 'QUEUED');
    assert.match(run.planDigest, /^[a-f0-9]{64}$/);
    run = await service.dispatchRun(run.runId, run.snapshot.revision, serviceActor);
    assert.equal(run.snapshot.state, 'STARTING');
    assert.equal(executor.launched.length, 1);
    run = service.started(run.runId, run.snapshot.revision, serviceActor);
    run = service.setBarrier(
      run.runId,
      { inputsSettled: true, descendantsDone: true, artifactsRegistered: true, cleanedUp: true },
      run.snapshot.revision,
      serviceActor,
    );
    run = service.finish(run.runId, run.snapshot.revision, serviceActor);
    assert.equal(run.snapshot.state, 'SUCCEEDED');
    service.close();

    const reopened = new PlatformControlService(path);
    try {
      const loaded = reopened.getRun(run.runId, operator);
      assert.equal(loaded.snapshot.state, 'SUCCEEDED');
      assert.equal(loaded.snapshot.revision, run.snapshot.revision);
      assert.equal(reopened.listRuns(undefined, 0, 20, operator).total, 1);
      assert.ok(reopened.audit(0, 100, operator).items.some((entry) => entry.action === 'RUN_CREATED'));
    } finally {
      reopened.close();
    }
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cancel wins before dispatch and needs the supervisor after launch', async () => {
  const { root, executor, service } = await setup();
  try {
    const queued = service.createRun('listing', '1.0.0', {}, operator);
    const cancelled = await service.cancelRun(queued.runId, queued.snapshot.revision, operator);
    assert.equal(cancelled.record.snapshot.state, 'CANCELLED');
    assert.equal(cancelled.cancelSettled, true);
    await assert.rejects(
      service.dispatchRun(queued.runId, cancelled.record.snapshot.revision, serviceActor),
      (error: unknown) => error instanceof PlatformError && error.code === 'RUN_CANCEL_REQUESTED',
    );

    let running = service.createRun('listing', '1.0.0', {}, operator);
    running = await service.dispatchRun(running.runId, running.snapshot.revision, serviceActor);
    const pending = await service.cancelRun(running.runId, running.snapshot.revision, operator);
    assert.equal(pending.cancelSettled, true);
    assert.equal(pending.record.snapshot.state, 'CANCELLED');
    assert.deepEqual(executor.cancelled, [executor.launched[0]]);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('revocation blocks new runs and stale revisions cannot overwrite newer facts', async () => {
  const { root, service } = await setup();
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    service.revokeApp('listing', '1.0.0', 'synthetic revoke', operator);
    assert.throws(
      () => service.createRun('listing', '1.0.0', {}, operator),
      (error: unknown) => error instanceof PlatformError && error.code === 'APP_RELEASE_NOT_ACTIVE',
    );
    await service.cancelRun(run.runId, run.snapshot.revision, operator);
    await assert.rejects(
      service.cancelRun(run.runId, run.snapshot.revision, operator),
      (error: unknown) => error instanceof PlatformError && error.code === 'RUN_TERMINAL',
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('worker outcome registers artifacts and completes the run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-outcome-'));
  const path = join(root, 'control.sqlite');
  const executor = new OutcomeExecutor({
    status: 'succeeded',
    finalResponse: 'done',
    artifacts: [{ name: 'output/listing.csv', digest: 'a'.repeat(64), bytes: 42, mediaType: 'text/csv' }],
  });
  const service = new PlatformControlService(path, executor, undefined, { requireArtifacts: true });
  try {
    service.registerApp(draft(), operator);
    const run = service.createRun('listing', '1.0.0', { synthetic: true }, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, serviceActor);
    await waitForTerminal(service, run.runId);
    const finished = service.getRun(run.runId, operator);
    assert.equal(finished.snapshot.state, 'SUCCEEDED');
    assert.equal(finished.snapshot.barrier.artifactsRegistered, true);
    assert.deepEqual(
      service.artifacts(run.runId, operator).map((artifact) => artifact.name),
      ['output/listing.csv'],
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid worker artifacts fail the run instead of leaving it running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-outcome-invalid-'));
  const executor = new OutcomeExecutor({
    status: 'succeeded',
    artifacts: [{ name: '../escape.csv', digest: 'a'.repeat(64), bytes: 1 }],
  });
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor, undefined, {
    requireArtifacts: true,
  });
  try {
    service.registerApp(draft(), operator);
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, serviceActor);
    await waitForTerminal(service, run.runId);
    const failed = service.getRun(run.runId, operator);
    assert.equal(failed.snapshot.state, 'FAILED');
    assert.match(failed.snapshot.reason ?? '', /WORKER_RESULT_INVALID/);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatchQueued dispatches bounded batches and leaves no duplicate launch', async () => {
  const { root, executor, service } = await setup();
  try {
    const first = service.createRun('listing', '1.0.0', {}, operator);
    const second = service.createRun('listing', '1.0.0', {}, operator);
    const dispatched = await service.dispatchQueued(1, serviceActor);
    assert.equal(dispatched.length, 1);
    assert.equal(service.getRun(dispatched[0].runId, operator).snapshot.state, 'STARTING');
    const remaining = await service.dispatchQueued(1, serviceActor);
    assert.equal(remaining.length, 1);
    assert.notEqual(dispatched[0].runId, remaining[0].runId);
    assert.equal(executor.launched.length, 2);
    assert.equal((await service.dispatchQueued(1, serviceActor)).length, 0);
    assert.ok([first.runId, second.runId].includes(dispatched[0].runId));
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('startup reconciliation fails runs left active by a previous control process', async () => {
  const { root, path, service } = await setup();
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, serviceActor);
    service.close();
    const reopened = new PlatformControlService(path);
    try {
      const result = reopened.reconcileOrphans(serviceActor);
      assert.equal(result.failed, 1);
      const failed = reopened.getRun(run.runId, operator);
      assert.equal(failed.snapshot.state, 'FAILED');
      assert.equal(failed.snapshot.reason, 'HOST_RESTARTED_RECONCILIATION_REQUIRED');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run input commits are ordered, appendable while active, and closed at terminal', async () => {
  const { root, service } = await setup();
  try {
    const run = service.createRun('listing', '1.0.0', { first: true }, operator);
    const initial = service.inputs(run.runId, 0, 20, operator);
    assert.equal(initial.total, 1);
    assert.equal(initial.items[0].sequence, 1);
    const appended = service.appendInput(run.runId, { second: true }, operator);
    assert.equal(appended.sequence, 2);
    assert.equal(appended.state, 'PENDING');
    const page = service.inputs(run.runId, 0, 20, operator);
    assert.deepEqual(
      page.items.map((item) => item.sequence),
      [1, 2],
    );
    await service.cancelRun(run.runId, service.getRun(run.runId, operator).snapshot.revision, operator);
    assert.throws(
      () => service.appendInput(run.runId, { late: true }, operator),
      (error: unknown) => error instanceof PlatformError && error.code === 'RUN_TERMINAL',
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('launch attempts persist dispatch, start and terminal state', async () => {
  const { root, service } = await setup();
  try {
    let run = service.createRun('listing', '1.0.0', {}, operator);
    run = await service.dispatchRun(run.runId, run.snapshot.revision, serviceActor);
    assert.equal(service.attempts(run.runId, operator)[0].state, 'STARTING');
    run = service.started(run.runId, run.snapshot.revision, serviceActor);
    assert.equal(service.attempts(run.runId, operator)[0].state, 'RUNNING');
    run = service.setBarrier(
      run.runId,
      { inputsSettled: true, descendantsDone: true, artifactsRegistered: true, cleanedUp: true },
      run.snapshot.revision,
      serviceActor,
    );
    run = service.finish(run.runId, run.snapshot.revision, serviceActor);
    const attempt = service.attempts(run.runId, operator)[0];
    assert.equal(attempt.state, 'SUCCEEDED');
    assert.ok(attempt.endedAt);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('retry creates a new run from a failed/cancelled run and rejects active runs', async () => {
  const { root, service } = await setup();
  try {
    const original = service.createRun('listing', '1.0.0', { first: true }, operator);
    assert.throws(
      () => service.retryRun(original.runId, operator),
      (error: unknown) => error instanceof PlatformError && error.code === 'RUN_RETRY_NOT_TERMINAL_FAILURE',
    );
    await service.cancelRun(original.runId, original.snapshot.revision, operator);
    const retry = service.retryRun(original.runId, operator);
    assert.notEqual(retry.runId, original.runId);
    assert.equal(retry.snapshot.state, 'QUEUED');
    assert.deepEqual(retry.input, {
      retryOf: original.runId,
      input: { first: true },
      inputDigest: original.inputDigest,
    });
    assert.equal(service.getRun(original.runId, operator).snapshot.state, 'CANCELLED');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
