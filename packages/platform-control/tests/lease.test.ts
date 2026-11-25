import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor, type RunLaunch } from '../src/service.js';
import { PlatformStore } from '../src/store.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:lease', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:lease', kind: 'service' };

class IdleExecutor implements RunExecutor {
  readonly kind = 'idle';
  async dispatch(input: { launchId?: string; fencingToken?: number }): Promise<RunLaunch> {
    return {
      launchId: input.launchId ?? 'launch-idle',
      fencingToken: input.fencingToken ?? 1,
      process: { pid: process.pid, identity: 'test-instance', mode: 'in-process' },
    };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-lease-'));
  const path = join(root, 'control.sqlite');
  const service = new PlatformControlService(path, new IdleExecutor());
  service.registerApp(draft(), operator);
  return { root, path, service };
};

test('a dispatched launch carries a supervision lease that renewal extends', async () => {
  const { root, path, service } = await setup();
  const probe = new PlatformStore(path);
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    const dispatched = await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    const attempt = probe.attemptGet(dispatched.snapshot.launchId!);
    assert.ok(attempt);
    assert.equal(attempt.leaseOwner, 'service:lease');
    assert.ok(attempt.leaseExpiresAt);
    // The host process is recorded explicitly, with an instance identity rather than a bare pid.
    assert.equal(attempt.processMode, 'in-process');
    assert.equal(attempt.pid, process.pid);
    assert.equal(attempt.processIdentity, 'test-instance');
    const before = attempt.leaseExpiresAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const renewed = service.renewOpenLaunchLeases(120_000);
    assert.deepEqual(renewed, [dispatched.snapshot.launchId]);
    const renewedAttempt = probe.attemptGet(dispatched.snapshot.launchId!);
    assert.ok(renewedAttempt?.leaseExpiresAt);
    assert.ok(Date.parse(renewedAttempt.leaseExpiresAt) > Date.parse(before!));
  } finally {
    probe.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an expired lease reconciles to UNKNOWN rather than silently restarting', async () => {
  const { root, path, service } = await setup();
  const probe = new PlatformStore(path);
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    const dispatched = await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    const future = new Date(Date.now() + 10 * 60 * 1000);
    const expired = service.expiredLaunches(future);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].launchId, dispatched.snapshot.launchId);

    const result = service.reconcileExpiredLaunches(supervisor, future);
    assert.equal(result.reconciled, 1);
    const reconciled = service.getRun(run.runId, operator);
    assert.equal(reconciled.snapshot.state, 'UNKNOWN');
    assert.match(reconciled.snapshot.reason ?? '', /LAUNCH_LEASE_EXPIRED/);
    const attempt = probe.attemptGet(dispatched.snapshot.launchId!);
    assert.equal(attempt?.state, 'UNKNOWN');
    assert.equal(attempt?.leaseOwner, undefined);
  } finally {
    probe.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a live lease is not reconciled and the run stays supervised', async () => {
  const { root, service } = await setup();
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    const result = service.reconcileExpiredLaunches(supervisor);
    assert.equal(result.reconciled, 0);
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'STARTING');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('startup reconciliation clears the stale lease and records UNKNOWN', async () => {
  const { root, path, service } = await setup();
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    const dispatched = await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    service.close();

    const reopened = new PlatformControlService(path);
    try {
      const result = reopened.reconcileOrphans(supervisor);
      assert.equal(result.failed, 1);
      assert.equal(reopened.getRun(run.runId, operator).snapshot.state, 'UNKNOWN');
      const probe = new PlatformStore(path);
      try {
        assert.equal(probe.attemptGet(dispatched.snapshot.launchId!)?.leaseOwner, undefined);
      } finally {
        probe.close();
      }
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});