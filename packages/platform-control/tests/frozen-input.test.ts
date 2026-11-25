// W3 验收（R3/R6）：冻结输入与执行。
// R3 —— Run 创建与换批收敛到同一事务内冻结操作：输入修订（baseline）、Run、outbox 同事务落盘；
//       Listing 四类逐一匹配且 DVP 无 Listing 字段（断言持久化与实际派发载荷，而非仅请求/库表）；
//       换批追加新修订、不改已接纳旧输入；重复提交不产生第二次派发；非法参数或跨项目资料
//       零写入（无 Run、无 baseline、无派发）。
// R6 —— 执行器按 Run 冻结的 runtimeBundleDigest 选定：两个不同制品按各自原锁排空、互不串台；
//       缺制品可见且未启动（不烧 attempt 预算、Run 保持 QUEUED、原因落在 outbox 行），
//       制品登记后恢复排空。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PlatformControlService,
  type RunExecutor,
  type RunLaunch,
} from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import { runInputDigest } from '../src/runs.js';
import { workerPrompt } from '../src/worker.js';
import { AuthorizationError, LocalOperatorPolicy, type PlatformAction, type PlatformPolicy, type Principal, type ResourceScope } from '../src/policy.js';
import type { ExecutionPlan } from '../../platform-runtime/src/plan.js';
import type { InputCommit, RunRecord } from '../src/store.js';
import { draft, dvpDraft } from './helpers.js';

const operator: Principal = { actorId: 'session:w3-root', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:w3', kind: 'service' };
const alice: Principal = { actorId: 'session:w3-alice', kind: 'operator' };
const LISTING_BUNDLE = 'b'.repeat(64);
const DVP_BUNDLE = 'c'.repeat(64);
const LISTING_TYPES = ['Manual', 'Medical', 'PK', 'Report'] as const;

const code = (expected: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === expected;
const denied = (expected: string) => (error: unknown) =>
  error instanceof AuthorizationError && error.code === expected;

/** Captures what the executor ACTUALLY received — run, plan, inputs, model — so the tests can
 *  assert the real dispatch payload, not just the request or the database rows. */
interface DispatchObservation {
  run: RunRecord;
  plan: ExecutionPlan;
  inputs?: InputCommit[];
  model?: unknown;
  launchId?: string;
}
class RecordingExecutor implements RunExecutor {
  readonly kind = 'recording';
  readonly received: DispatchObservation[] = [];
  async dispatch(input: {
    run: RunRecord;
    plan: ExecutionPlan;
    inputs?: InputCommit[];
    model?: unknown;
    launchId?: string;
    fencingToken?: number;
  }): Promise<RunLaunch> {
    this.received.push({
      run: input.run, plan: input.plan, inputs: input.inputs,
      model: input.model, launchId: input.launchId,
    });
    return { launchId: input.launchId ?? `launch-${this.received.length}`, fencingToken: input.fencingToken ?? this.received.length };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

/** W2's dual-identity policy: project scope is enforced on every authorize that carries a
 *  projectId, resolved from server-side ownership (never request parameters). */
class DualIdentityPolicy implements PlatformPolicy {
  private readonly base = new LocalOperatorPolicy();
  constructor(private readonly projects: Map<string, string[]>) {}
  authorize(principal: Principal, action: PlatformAction, resource?: ResourceScope): void {
    this.base.authorize(principal, action, resource);
    const allowed = this.projects.get(principal.actorId);
    if (allowed && resource?.projectId !== undefined && !allowed.includes(resource.projectId)) {
      throw new AuthorizationError('PLATFORM_PROJECT_ACCESS_DENIED', resource.projectId);
    }
  }
}

const setupWithExecutor = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-w3-freeze-'));
  const executor = new RecordingExecutor();
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor);
  service.registerApp(draft(), operator);
  service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
  return { root, executor, service };
};

const newWork = (service: PlatformControlService, title: string, appId = 'listing') =>
  service.createWork({ projectId: 'SYN-001', appId, appVersion: '1.0.0', title }, operator);

const runCount = (service: PlatformControlService) =>
  service.listRuns(undefined, 0, 100, operator).total;

test('W3/R3: each Listing type is frozen with exactly its own input and dispatched with the same payload', async () => {
  const { root, executor, service } = await setupWithExecutor();
  try {
    for (const listingType of LISTING_TYPES) {
      const work = newWork(service, `四类工作-${listingType}`);
      const input = { goal: `运行 ${listingType}`, listingType, rows: [`${listingType}-r1`, `${listingType}-r2`] };
      const run = service.createWorkRun(work.workId, input, operator);

      // Persistence: the Run, its input commit and the work-level baseline all carry the SAME
      // canonical digest, computed at freeze time inside the transaction.
      const stored = service.getRun(run.runId, operator);
      assert.equal(stored.inputDigest, runInputDigest(input), `${listingType}: run.inputDigest 是冻结摘要`);
      assert.deepEqual(stored.input, input, `${listingType}: run.input 是原输入`);
      const commits = service.inputs(run.runId, 0, 10, operator);
      assert.equal(commits.total, 1);
      assert.equal(commits.items[0].sequence, 1);
      assert.equal(commits.items[0].contentDigest, stored.inputDigest);
      assert.deepEqual(commits.items[0].body, input);
      const baselines = service.inputBaselinesForWork(work.workId, 0, 10, operator);
      assert.equal(baselines.total, 1, `${listingType}: 每个工作一份 baseline`);
      assert.equal(baselines.items[0].digest, stored.inputDigest, `${listingType}: baseline.digest = run.inputDigest`);
      assert.equal(baselines.items[0].sourceRef, `input:${stored.inputDigest}`);

      // Actual dispatch: the executor received the same frozen input and the same bundle.
      const tick = await service.dispatchOutbox(supervisor, { limit: 5 });
      assert.equal(tick.dispatched, 1);
      const seen = executor.received.at(-1)!;
      assert.equal(seen.run.runId, run.runId);
      assert.deepEqual(seen.run.input, input, `${listingType}: 派发载荷 input 与冻结输入逐一匹配`);
      assert.deepEqual(seen.inputs?.[0]?.body, input, `${listingType}: 派发 inputs[0].body 与冻结输入逐一匹配`);
      assert.equal(seen.plan.runtimeBundleDigest, LISTING_BUNDLE, `${listingType}: 按 Run 自己的制品派发`);
      assert.equal(seen.inputs?.every((commit) => commit.contentDigest === runInputDigest(input)), true);
    }
    assert.equal(executor.received.length, LISTING_TYPES.length);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W3/R3: a DVP run is frozen and dispatched with its own input and carries no Listing fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-w3-dvp-'));
  const executor = new RecordingExecutor();
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor);
  try {
    service.registerApp(dvpDraft(), operator);
    service.setDefaultRelease('dm-dvp', '1.0.0', { expectedRevision: null }, operator);
    const work = newWork(service, 'DVP 工作', 'dm-dvp');
    const input = { protocol: 'PROT-1', rules: [{ id: 'R1', kind: 'consistency' }] };
    const run = service.createWorkRun(work.workId, input, operator);
    await service.dispatchOutbox(supervisor, { limit: 5 });

    const stored = service.getRun(run.runId, operator);
    assert.equal(stored.inputDigest, runInputDigest(input));
    assert.equal(stored.appId, 'dm-dvp');
    const seen = executor.received.at(-1)!;
    assert.deepEqual(seen.run.input, input, '派发载荷忠实搬运 DVP 自身输入');
    assert.deepEqual(seen.inputs?.[0]?.body, input);
    assert.equal(seen.plan.runtimeBundleDigest, DVP_BUNDLE);
    const serialized = JSON.stringify(seen.run.input);
    assert.equal(serialized.includes('listingType'), false, '派发输入不含 Listing 字段');
    assert.equal(serialized.includes('listingTypes'), false);
    const descriptor = service.getApp('dm-dvp', '1.0.0', operator).draft.descriptor as { listingTypes?: unknown };
    assert.equal(descriptor.listingTypes, undefined, 'DVP 描述符本就未声明 Listing 字段');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W3/R3: a rebatch appends a new revision and never mutates the accepted run’s frozen inputs', async () => {
  const { root, executor, service } = await setupWithExecutor();
  try {
    const work = newWork(service, '换批工作');
    const inputA = { goal: '第一批', batch: 'A' };
    const run1 = service.createWorkRun(work.workId, inputA, operator);
    const revision1 = service.inputBaselinesForWork(work.workId, 0, 10, operator).items[0];
    assert.equal(revision1.revision, 1);
    assert.equal(revision1.digest, runInputDigest(inputA));

    // A duplicate submission while run1 is active is refused: no second run, no second dispatch.
    assert.throws(
      () => service.createWorkRun(work.workId, { goal: '重复提交' }, operator),
      code('WORK_ACTIVE_RUN_EXISTS'),
    );
    await service.dispatchOutbox(supervisor, { limit: 5 });
    assert.equal(executor.received.length, 1, '重复提交不产生第二次派发');
    assert.equal(service.outboxForRun(run1.runId, operator)?.state, 'DONE');

    // Settle run1, then rebatch: the new batch appends revision 2; revision 1 is untouched.
    await service.cancelRun(run1.runId, service.getRun(run1.runId, operator).snapshot.revision, operator);
    assert.equal(service.getRun(run1.runId, operator).snapshot.state, 'CANCELLED');
    const inputB = { goal: '第二批', batch: 'B' };
    const run2 = service.createWorkRun(work.workId, inputB, operator);
    assert.notEqual(run2.runId, run1.runId);

    const history = service.inputBaselinesForWork(work.workId, 0, 10, operator);
    assert.equal(history.total, 2);
    assert.deepEqual(
      history.items.map((item) => [item.revision, item.digest]),
      [[2, runInputDigest(inputB)], [1, runInputDigest(inputA)]],
      '换批追加修订 2，修订 1 原样保留',
    );

    const stored1 = service.getRun(run1.runId, operator);
    assert.equal(stored1.inputDigest, runInputDigest(inputA), '已接纳旧 Run 的冻结摘要不变');
    assert.deepEqual(stored1.input, inputA, '已接纳旧 Run 的输入不变');
    const commits1 = service.inputs(run1.runId, 0, 10, operator);
    assert.equal(commits1.total, 1);
    assert.deepEqual(commits1.items[0].body, inputA, '已接纳旧 Run 的输入提交不变');
    const stored2 = service.getRun(run2.runId, operator);
    assert.equal(stored2.inputDigest, runInputDigest(inputB));
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W3/R3: an active run blocks duplicate submission with no second dispatch ever', async () => {
  const { root, executor, service } = await setupWithExecutor();
  try {
    const work = newWork(service, '并发守卫工作');
    const run1 = service.createWorkRun(work.workId, { goal: '唯一运行' }, operator);
    await service.dispatchOutbox(supervisor, { limit: 5 });
    assert.equal(executor.received.length, 1);
    // run1 is now STARTING (active): the same-Work admission check inside the freeze transaction
    // refuses the duplicate, so no second outbox message can ever exist for this Work.
    assert.throws(
      () => service.createWorkRun(work.workId, { goal: '第二次' }, operator),
      code('WORK_ACTIVE_RUN_EXISTS'),
    );
    const later = await service.dispatchOutbox(supervisor, { limit: 5 });
    assert.equal(later.claimed, 0);
    assert.equal(executor.received.length, 1, '派发次数恰为一次');
    assert.equal(runCount(service), 1, '没有第二个 Run 落库');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W3/R3: an invalid parameter produces no Run, no baseline revision and no dispatch', async () => {
  const { root, executor, service } = await setupWithExecutor();
  try {
    const work = newWork(service, '非法输入工作');
    const before = runCount(service);
    const oversized = { goal: '太大', blob: 'x'.repeat(1024 * 1024 + 64) };
    assert.throws(
      () => service.createWorkRun(work.workId, oversized, operator),
      code('RUN_INPUT_TOO_LARGE'),
    );
    assert.equal(runCount(service), before, '没有 Run 落库');
    assert.equal(service.inputBaselinesForWork(work.workId, 0, 10, operator).total, 0, '没有 baseline 落库');
    const tick = await service.dispatchOutbox(supervisor, { limit: 5 });
    assert.equal(tick.claimed, 0);
    assert.equal(executor.received.length, 0, '没有派发');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W3/R3: cross-project material produces no Run, no baseline and no dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-w3-scope-'));
  const scope = new Map<string, string[]>();
  const executor = new RecordingExecutor();
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor, new DualIdentityPolicy(scope));
  try {
    service.registerApp(draft(), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    const prjA = service.createProject({ name: '项目A' }, operator);
    const prjB = service.createProject({ name: '项目B' }, operator);
    scope.set(alice.actorId, [prjA.projectId]);
    const workB = service.createWork({ projectId: prjB.projectId, appId: 'listing', appVersion: '1.0.0', title: '贝塔工作' }, operator);

    const before = runCount(service);
    assert.throws(
      () => service.createWorkRun(workB.workId, { goal: '跨项目运行' }, alice),
      denied('PLATFORM_PROJECT_ACCESS_DENIED'),
    );
    assert.equal(runCount(service), before, '跨项目资料不产生 Run');
    assert.equal(service.inputBaselinesForWork(workB.workId, 0, 10, operator).total, 0, '跨项目资料不产生 baseline');
    const tick = await service.dispatchOutbox(supervisor, { limit: 5 });
    assert.equal(tick.claimed, 0);
    assert.equal(executor.received.length, 0, '跨项目资料不产生派发');

    // The owning identity freezes and dispatches the same Work without friction.
    const run = service.createWorkRun(workB.workId, { goal: '属主运行' }, operator);
    await service.dispatchOutbox(supervisor, { limit: 5 });
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'STARTING');
    assert.equal(executor.received.length, 1);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W3/R3: a version revoked before submission conflicts with no write at all', async () => {
  const { root, executor, service } = await setupWithExecutor();
  try {
    const work = newWork(service, '撤版工作');
    const before = runCount(service);
    service.revokeApp('listing', '1.0.0', '安全撤权', operator);
    assert.throws(
      () => service.createWorkRun(work.workId, { goal: '过期提交' }, operator),
      code('APP_RELEASE_NOT_ACTIVE'),
    );
    assert.equal(runCount(service), before, '撤版后无 Run');
    assert.equal(service.inputBaselinesForWork(work.workId, 0, 10, operator).total, 0, '撤版后无 baseline');
    const tick = await service.dispatchOutbox(supervisor, { limit: 5 });
    assert.equal(tick.claimed, 0);
    assert.equal(executor.received.length, 0);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W3/R6: two different artifacts drain under their original locks, never crossing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-w3-drain-'));
  const byListing = new RecordingExecutor();
  const byDvp = new RecordingExecutor();
  const service = new PlatformControlService(join(root, 'control.sqlite'), null);
  try {
    // Exact-bundle registration only: no legacy fallback executor exists in this deployment.
    service.registerExecutor(LISTING_BUNDLE, byListing);
    service.registerExecutor(DVP_BUNDLE, byDvp);
    service.registerApp(draft(), operator);
    service.registerApp(dvpDraft(), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    service.setDefaultRelease('dm-dvp', '1.0.0', { expectedRevision: null }, operator);

    const listingWork = newWork(service, 'Listing 工作');
    const dvpWork = newWork(service, 'DVP 工作', 'dm-dvp');
    const listingRun = service.createWorkRun(listingWork.workId, { goal: 'Listing 运行' }, operator);
    const dvpRun = service.createWorkRun(dvpWork.workId, { goal: 'DVP 运行' }, operator);

    const tick = await service.dispatchOutbox(supervisor, { limit: 5 });
    assert.equal(tick.dispatched, 2);
    assert.equal(tick.noExecutor, 0);

    assert.deepEqual(byListing.received.map((seen) => seen.run.runId), [listingRun.runId], 'Listing 执行器只收到自己的 Run');
    assert.deepEqual(byDvp.received.map((seen) => seen.run.runId), [dvpRun.runId], 'DVP 执行器只收到自己的 Run');
    assert.equal(byListing.received[0].plan.runtimeBundleDigest, LISTING_BUNDLE);
    assert.equal(byDvp.received[0].plan.runtimeBundleDigest, DVP_BUNDLE);
    assert.equal(byListing.received[0].run.appId, 'listing');
    assert.equal(byDvp.received[0].run.appId, 'dm-dvp');
    assert.equal(service.getRun(listingRun.runId, operator).snapshot.state, 'STARTING');
    assert.equal(service.getRun(dvpRun.runId, operator).snapshot.state, 'STARTING');
    assert.equal(service.outboxForRun(listingRun.runId, operator)?.state, 'DONE');
    assert.equal(service.outboxForRun(dvpRun.runId, operator)?.state, 'DONE');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W3/R6: a missing artifact is visible, never starts, never spends attempts — and resumes once registered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-w3-missing-'));
  const byDvp = new RecordingExecutor();
  const service = new PlatformControlService(join(root, 'control.sqlite'), null);
  try {
    // Only the DVP bundle is registered; a Listing run would need an artifact nobody registered.
    service.registerExecutor(DVP_BUNDLE, byDvp);
    service.registerApp(draft(), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    const work = service.createWork({ projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '缺制品工作' }, operator);
    const run = service.createRun('listing', '1.0.0', { goal: '无执行器运行' }, operator);

    const tick = await service.dispatchOutbox(supervisor, { limit: 5 });
    assert.equal(tick.claimed, 1, '消息被取出检查');
    assert.equal(tick.dispatched, 0);
    assert.equal(tick.noExecutor, 1, '缺制品被如实计数');

    // Visible: the reason names the missing bundle on the outbox row; the run stays QUEUED and
    // the attempt budget is untouched — the message stays due, not dead.
    const message = service.outboxForRun(run.runId, operator);
    assert.equal(message?.state, 'PENDING');
    assert.equal(message?.attempts, 0, '不烧 attempt 预算');
    assert.match(message?.lastError ?? '', /EXECUTOR_UNAVAILABLE/);
    assert.match(message?.lastError ?? '', new RegExp(LISTING_BUNDLE.slice(0, 12)));
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'QUEUED', 'Run 保持 QUEUED 未启动');
    assert.equal(byDvp.received.length, 0, '任何执行器都未收到该 Run');

    // A repeated tick must neither spend budget nor start the run.
    const again = await service.dispatchOutbox(supervisor, { limit: 5 });
    assert.equal(again.noExecutor, 1);
    assert.equal(service.outboxForRun(run.runId, operator)?.attempts, 0);

    // Registering the exact artifact resumes the drain under the original lock.
    const byListing = new RecordingExecutor();
    service.registerExecutor(LISTING_BUNDLE, byListing);
    const resumed = await service.dispatchOutbox(supervisor, { limit: 5 });
    assert.equal(resumed.dispatched, 1);
    assert.equal(byListing.received.length, 1);
    assert.equal(byListing.received[0].plan.runtimeBundleDigest, LISTING_BUNDLE);
    assert.notEqual(service.getRun(run.runId, operator).snapshot.state, 'QUEUED');
    assert.equal(service.outboxForRun(run.runId, operator)?.state, 'DONE');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W3: the worker prompt carries every frozen input verbatim, in sequence order', () => {
  const commit1: InputCommit = {
    commitId: 'c1', runId: 'r', sequence: 1, contentDigest: 'd1'.padEnd(64, '0'),
    body: { goal: '第一批输入' }, state: 'PENDING', createdAt: '2026-11-20T00:00:00.000Z',
  };
  const commit2: InputCommit = {
    commitId: 'c2', runId: 'r', sequence: 2, contentDigest: 'd2'.padEnd(64, '0'),
    body: { goal: '第二批输入', rows: ['r1'] }, state: 'PENDING', createdAt: '2026-11-20T00:00:01.000Z',
  };
  const run = {
    runId: 'run-1', workId: null, appId: 'listing', appVersion: '1.0.0',
    releaseDigest: 'r'.padEnd(64, '0'), planDigest: 'p'.padEnd(64, '0'),
    inputDigest: 'd1'.padEnd(64, '0'), input: { goal: '第一批输入' },
    model: null, dispatchedThrough: null, result: null,
    snapshot: { state: 'STARTING', revision: 2 }, createdAt: '', updatedAt: '',
  } as unknown as RunRecord;
  const plan = { planDigest: 'p'.padEnd(64, '0'), runtimeBundleDigest: LISTING_BUNDLE } as unknown as ExecutionPlan;
  const prompt = workerPrompt(run, plan, '/ws', [commit1, commit2]);
  assert.ok(prompt.includes(`#1 ${JSON.stringify(commit1.body)}`), '冻结输入 #1 逐字出现');
  assert.ok(prompt.includes(`#2 ${JSON.stringify(commit2.body)}`), '冻结输入 #2 逐字出现');
  const empty = workerPrompt(run, plan, '/ws', []);
  assert.ok(empty.includes(`#1 ${JSON.stringify(run.input)}`), '无提交时回退到 run.input');
});
