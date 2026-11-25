import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor, type RunLaunch } from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import { PlatformStore } from '../src/store.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:outbox', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:outbox', kind: 'service' };

class FlakyExecutor implements RunExecutor {
  readonly kind = 'flaky';
  launches: string[] = [];
  failures = 0;
  constructor(private readonly failTimes = 0) {}
  async dispatch(input: { launchId?: string; fencingToken?: number }): Promise<RunLaunch> {
    if (this.failures < this.failTimes) {
      this.failures++;
      throw new PlatformError('WORKER_TEMPORARY');
    }
    const launchId = input.launchId ?? `launch-${this.launches.length + 1}`;
    this.launches.push(launchId);
    return { launchId, fencingToken: input.fencingToken ?? this.launches.length };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

const setup = async (failTimes = 0) => {
  const root = await mkdtemp(join(tmpdir(), 'platform-outbox-'));
  const executor = new FlakyExecutor(failTimes);
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor);
  service.registerApp(draft(), operator);
  return { root, executor, service };
};

test('a run and its dispatch intent are committed together and dispatch once', async () => {
  const { root, service, executor } = await setup();
  try {
    const run = service.createRun('listing', '1.0.0', { goal: 'x' }, operator);
    const queued = service.outboxForRun(run.runId, operator);
    assert.equal(queued?.state, 'PENDING');
    assert.equal(queued?.attempts, 0);

    const first = await service.dispatchOutbox(supervisor, { limit: 1 });
    assert.equal(first.claimed, 1);
    assert.equal(first.dispatched, 1);
    assert.equal(executor.launches.length, 1);
    assert.equal(service.outboxForRun(run.runId, operator)?.state, 'DONE');

    const second = await service.dispatchOutbox(supervisor, { limit: 1 });
    assert.equal(second.claimed, 0);
    assert.equal(executor.launches.length, 1);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a cancelled queued run leaves the outbox without dispatching', async () => {
  const { root, service, executor } = await setup();
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await service.cancelRun(run.runId, run.snapshot.revision, operator);
    assert.equal(service.outboxForRun(run.runId, operator)?.state, 'DONE');
    const tick = await service.dispatchOutbox(supervisor, { limit: 1 });
    assert.equal(tick.claimed, 0);
    assert.equal(executor.launches.length, 0);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('transient dispatch failures back off, then succeed on a later attempt', async () => {
  const { root, service, executor } = await setup(1);
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    const now = new Date();
    const first = await service.dispatchOutbox(supervisor, { limit: 1, now });
    assert.equal(first.retried, 1);
    const afterFailure = service.outboxForRun(run.runId, operator);
    assert.equal(afterFailure?.state, 'PENDING');
    assert.equal(afterFailure?.attempts, 1);
    assert.ok(Date.parse(afterFailure!.nextAttemptAt) > now.getTime());

    // Still backing off: not claimed now.
    const immediate = await service.dispatchOutbox(supervisor, { limit: 1, now });
    assert.equal(immediate.claimed, 0);

    const later = await service.dispatchOutbox(supervisor, {
      limit: 1,
      now: new Date(Date.now() + 60_000),
    });
    assert.equal(later.dispatched, 1);
    assert.equal(executor.launches.length, 1);
    assert.equal(service.outboxForRun(run.runId, operator)?.state, 'DONE');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a permanent release failure is dead-lettered instead of retried forever', async () => {
  const { root, service, executor } = await setup();
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    service.revokeApp('listing', '1.0.0', 'withdrawn', operator);
    const tick = await service.dispatchOutbox(supervisor, { limit: 1 });
    assert.equal(tick.dead, 1);
    assert.equal(executor.launches.length, 0);
    const message = service.outboxForRun(run.runId, operator);
    assert.equal(message?.state, 'DEAD');
    assert.match(message?.lastError ?? '', /APP_RELEASE_NOT_ACTIVE/);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('retryable failures stop after the attempt budget with a dead letter', async () => {
  const { root, service } = await setup(99);
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    let now = Date.now();
    for (let attempt = 0; attempt < 6; attempt++) {
      now += 11 * 60 * 1000;
      await service.dispatchOutbox(supervisor, { limit: 1, now: new Date(now) });
    }
    const message = service.outboxForRun(run.runId, operator);
    assert.equal(message?.state, 'DEAD');
    assert.ok((message?.attempts ?? 0) >= 5);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('without a configured executor the queue stays pending instead of spending attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-outbox-noexec-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'));
  try {
    service.registerApp(draft(), operator);
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await assert.rejects(
      service.dispatchOutbox(supervisor, { limit: 1 }),
      (error: unknown) => error instanceof PlatformError && error.code === 'EXECUTOR_NOT_CONFIGURED',
    );
    const message = service.outboxForRun(run.runId, operator);
    assert.equal(message?.state, 'PENDING');
    assert.equal(message?.attempts, 0);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale claim returns to the pool after its claim lease expires', async () => {
  const { root, service } = await setup();
  const path = join(root, 'control.sqlite');
  const probe = new PlatformStore(path);
  try {
    service.createRun('listing', '1.0.0', {}, operator);
    const at = new Date(Date.now() + 1000);
    const first = probe.outboxClaim('owner-a', at.toISOString(), 1, 60_000);
    assert.equal(first.length, 1);
    assert.equal(first[0].state, 'CLAIMED');
    // Before expiry the same claim is not re-handed out.
    const tooEarly = probe.outboxClaim(
      'owner-b',
      new Date(at.getTime() + 30_000).toISOString(),
      1,
      60_000,
    );
    assert.equal(tooEarly.length, 0);
    // After expiry a new owner may claim it.
    const late = probe.outboxClaim(
      'owner-b',
      new Date(at.getTime() + 61_000).toISOString(),
      1,
      60_000,
    );
    assert.equal(late.length, 1);
    assert.equal(late[0].claimedBy, 'owner-b');
  } finally {
    probe.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('the concurrency cap defers dispatch without spending attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-outbox-cap-'));
  const executor = new FlakyExecutor();
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor, undefined, {
    maxConcurrentRuns: 1,
  });
  try {
    service.registerApp(draft(), operator);
    const first = service.createRun('listing', '1.0.0', {}, operator);
    const second = service.createRun('listing', '1.0.0', {}, operator);

    const one = await service.dispatchOutbox(supervisor, { limit: 2 });
    assert.equal(one.dispatched, 1);
    const deferred = service.outboxForRun(second.runId, operator);
    assert.equal(deferred?.state, 'PENDING');
    assert.equal(deferred?.attempts, 0);

    const blocked = await service.dispatchOutbox(supervisor, { limit: 2 });
    assert.equal(blocked.claimed, 0);

    await service.cancelRun(first.runId, service.getRun(first.runId, operator).snapshot.revision, operator);
    const resumed = await service.dispatchOutbox(supervisor, { limit: 2 });
    assert.equal(resumed.dispatched, 1);
    assert.equal(executor.launches.length, 2);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
