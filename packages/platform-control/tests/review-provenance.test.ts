import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PlatformControlService,
  type KnowledgeCaptureEvent,
  type RunExecutor,
  type RunOutcome,
} from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:review', kind: 'operator' };
const approver: Principal = { actorId: 'user:qa-lead', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:review', kind: 'service' };
const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

class OutcomeExecutor implements RunExecutor {
  readonly kind = 'outcome';
  constructor(private readonly outcome: RunOutcome) {}
  async dispatch(input: { launchId?: string; fencingToken?: number }) {
    return {
      launchId: input.launchId ?? 'launch-outcome',
      fencingToken: input.fencingToken ?? 1,
      outcome: Promise.resolve(this.outcome),
    };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

const waitFor = async (service: PlatformControlService, runId: string): Promise<string> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = service.getRun(runId, operator).snapshot.state;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not reach a terminal state');
};

/** Outcome carrying real files so the control plane seals actual bytes (R5: a review stands on
 *  sealed artifacts, never on metadata). */
const succeededWithArtifacts = async (dir: string, base: RunOutcome): Promise<RunOutcome> => {
  const artifacts = [] as NonNullable<RunOutcome['artifacts']>;
  for (const [name, content] of [['listing.xlsx', 'A,G,nh,po'], ['checks.md', '# checks']] as const) {
    const sourcePath = join(dir, name);
    await writeFile(sourcePath, content);
    artifacts.push({
      name,
      digest: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
      sourcePath,
    });
  }
  return { ...base, artifacts };
};

const setup = async (outcome: RunOutcome, artifacts = false) => {
  const root = await mkdtemp(join(tmpdir(), 'platform-review-'));
  let effective = outcome;
  let requireArtifacts = false;
  if (artifacts) {
    const filesDir = join(root, 'worker-out');
    await mkdir(filesDir, { recursive: true });
    effective = await succeededWithArtifacts(filesDir, outcome);
    requireArtifacts = true;
  }
  const service = new PlatformControlService(join(root, 'control.sqlite'), new OutcomeExecutor(effective), undefined, {
    requireArtifacts,
  });
  service.registerApp(draft(), operator);
  return { root, service };
};

const succeeded: RunOutcome = {
  status: 'succeeded',
  exitProven: true,
  cleanedUp: true,
  finishReason: 'completed',
  descendantsDone: true,
  consumedThrough: 1,
  finalResponse: 'done',
};

test('build provenance is validated, stored and bound into the release digest', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'platform-prov-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'platform-prov-b-'));
  const plain = new PlatformControlService(join(rootA, 'control.sqlite'));
  const withProv = new PlatformControlService(join(rootB, 'control.sqlite'));
  try {
    plain.registerApp(draft(), operator);
    const provenance = {
      sourceRevision: 'git:abc123',
      builder: 'ci-build-7',
      builtAt: '2026-11-17T00:00:00.000Z',
      sbomDigest: 'c'.repeat(64),
      dependenciesDigest: 'd'.repeat(64),
    };
    const release = { ...draft(), provenance };
    withProv.registerApp(release, operator);
    const stored = withProv.getApp('listing', '1.0.0', operator);
    assert.deepEqual(stored.draft.provenance, provenance);
    assert.notEqual(stored.releaseDigest, plain.getApp('listing', '1.0.0', operator).releaseDigest);

    assert.throws(
      () => withProv.registerApp({ ...draft('other'), provenance: { sbomDigest: 'short' } }, operator),
      isPlatformError('APP_PROVENANCE_INVALID'),
    );
    assert.throws(
      () => withProv.registerApp(
        { ...draft('other2'), provenance: { builder: 'x', extra: 'y' } } as unknown as Parameters<typeof withProv.registerApp>[0],
        operator,
      ),
      isPlatformError('APP_PROVENANCE_INVALID'),
    );
  } finally {
    plain.close();
    withProv.close();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test('rollback switches the default route and never revokes the source version (R6)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-rollback-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), new OutcomeExecutor(succeeded), undefined, {
    requireReleaseApproval: true,
  });
  try {
    service.registerApp(draft('listing', '0.9.0'), operator);
    service.registerApp(draft('listing', '1.0.0'), operator);
    const newer = service.getApp('listing', '1.0.0', operator);
    const older = service.getApp('listing', '0.9.0', operator);
    for (const app of [newer, older]) {
      service.approveRelease({
        appId: app.appId,
        appVersion: app.appVersion,
        releaseDigest: app.releaseDigest,
      }, approver);
    }
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);

    assert.throws(() => service.rollbackRelease('listing', '1.0.0', '1.0.0', 'same', operator), isPlatformError('APP_ROLLBACK_INVALID'));
    assert.throws(() => service.rollbackRelease('listing', '1.0.0', '9.9.9', 'missing', operator), isPlatformError('APP_NOT_FOUND'));

    const result = service.rollbackRelease('listing', '1.0.0', '0.9.0', 'regression in 1.0.0', operator);
    assert.equal(result.previous.appVersion, '1.0.0');
    assert.equal(result.current.appVersion, '0.9.0');
    assert.equal(result.current.revision, result.previous.revision + 1);
    assert.equal(result.target.appVersion, '0.9.0');
    assert.equal(result.target.state, 'ACTIVE');
    // R6: ordinary rollback only reroutes; the source version stays ACTIVE and runnable,
    // and security revocation ('app.revoke') is a separate write action.
    assert.equal(service.getApp('listing', '1.0.0', operator).state, 'ACTIVE');
    assert.equal(service.defaultRelease('listing', operator)?.appVersion, '0.9.0');
    // A form built against the old pointer revision can no longer commit (CAS).
    assert.throws(
      () => service.rollbackRelease('listing', '1.0.0', '0.9.0', 'stale form', operator),
      isPlatformError('APP_DEFAULT_REVISION_STALE'),
    );
    const onNew = service.createRun('listing', '1.0.0', {}, operator);
    assert.equal(onNew.appVersion, '1.0.0');
    const onOld = service.createRun('listing', '0.9.0', {}, operator);
    assert.equal(onOld.appVersion, '0.9.0');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a succeeded run can request and record one review decision, but no further rewrite', async () => {
  const { root, service } = await setup(succeeded, true);
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    assert.throws(() => service.requestReview(run.runId, operator), isPlatformError('RUN_REVIEW_NOT_SUCCEEDED'));
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    assert.equal(await waitFor(service, run.runId), 'SUCCEEDED');

    const review = service.requestReview(run.runId, operator, '请复核本轮结果');
    assert.equal(review.state, 'REQUESTED');
    assert.equal(review.revision, 1);
    // R5: the request binds a server-built deliverable manifest frozen from the sealed artifacts.
    assert.ok(review.deliverable, 'the request must bind a deliverable manifest');
    const digest = review.deliverable.manifestDigest;
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.throws(() => service.requestReview(run.runId, operator), isPlatformError('RUN_REVIEW_EXISTS'));

    assert.throws(
      () => service.recordReviewDecision(review.reviewId, 'APPROVED', undefined, 99, digest, operator),
      isPlatformError('RUN_REVIEW_REVISION_STALE'),
    );
    assert.throws(
      () => service.recordReviewDecision(review.reviewId, 'REJECTED', '', 1, digest, operator),
      isPlatformError('RUN_REVIEW_INVALID'),
    );
    const approved = service.recordReviewDecision(review.reviewId, 'APPROVED', '已核对', 1, digest, operator);
    assert.equal(approved.state, 'APPROVED');
    assert.equal(approved.reviewer, operator.actorId);
    assert.equal(approved.revision, 2);
    assert.throws(
      () => service.recordReviewDecision(review.reviewId, 'REJECTED', 'late', 2, digest, operator),
      isPlatformError('RUN_REVIEW_NOT_OPEN'),
    );
    const history = service.reviewsForRun(run.runId, operator);
    assert.equal(history.length, 1);
    assert.equal(history[0].state, 'APPROVED');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a terminal run hands digests to the knowledge sink exactly once', async () => {
  const failed: RunOutcome = { status: 'failed', error: 'WORKER_FAILED', exitProven: true, cleanedUp: true };
  const { root, service } = await setup(failed);
  const events: KnowledgeCaptureEvent[] = [];
  try {
    service.setKnowledgeCaptureSink((event) => { events.push(event) });
    const run = service.createRun('listing', '1.0.0', { goal: 'synthetic' }, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    assert.equal(await waitFor(service, run.runId), 'FAILED');
    // T04：终端事实已持久入队，泵投递给 sink；重复泵不重复交付（幂等键 (kind,eventId)）。
    const drained = await service.drainKnowledgeCaptureOutbox();
    assert.equal(drained.done, 1);
    const again = await service.drainKnowledgeCaptureOutbox();
    assert.equal(again.claimed, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'run.failed');
    assert.equal(events[0].runId, run.runId);
    assert.equal(events[0].inputDigest, run.inputDigest);
    assert.deepEqual(events[0].artifactDigests, []);
    assert.equal(events[0].projectId, undefined);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a throwing knowledge sink never changes the run outcome', async () => {
  const failed: RunOutcome = { status: 'failed', error: 'WORKER_FAILED', exitProven: true, cleanedUp: true };
  const { root, service } = await setup(failed);
  try {
    service.setKnowledgeCaptureSink(() => { throw new Error('sink-down') });
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    assert.equal(await waitFor(service, run.runId), 'FAILED');
    // T04：消费崩溃（sink 抛错）不丢事件——退避重试直到预算耗尽死信并审计；Run 状态不受影响。
    let last = { claimed: 0, done: 0, retried: 0, dead: 0 };
    for (let attempt = 0; attempt < 5; attempt++) {
      last = await service.drainKnowledgeCaptureOutbox({ now: new Date(Date.now() + (attempt + 1) * 60_000) });
    }
    assert.equal(last.dead, 1, '预算耗尽后死信');
    assert.ok(
      service.audit(0, 50, operator).items.some((entry) => entry.action === 'KNOWLEDGE_CAPTURE_DEAD_LETTERED'),
      '死信被审计留痕',
    );
    assert.equal((await waitFor(service, run.runId)) ?? 'FAILED', 'FAILED', 'Run 状态不因 sink 失败改变');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('review and rollback facts are reachable over the same-origin API', async () => {
  const { root, service } = await setup(succeeded, true);
  let api: RunningWorkbenchApi | undefined;
  try {
    service.registerApp(draft('listing', '0.9.0'), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    api = await startWorkbenchServer({ service, authenticate: () => operator });

    const run = service.createRun('listing', '1.0.0', {}, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    assert.equal(await waitFor(service, run.runId), 'SUCCEEDED');

    const requested = await fetch(`${api.url}/api/runs/${run.runId}/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: '请复核' }),
    });
    assert.equal(requested.status, 201);
    const review = await requested.json() as {
      reviewId: string; state: string; revision: number; deliverable: { manifestDigest: string };
    };
    assert.equal(review.state, 'REQUESTED');
    assert.ok(review.deliverable, 'the API response carries the bound deliverable manifest');

    const listed = await fetch(`${api.url}/api/runs/${run.runId}/reviews`).then((res) => res.json()) as { items: unknown[] };
    assert.equal(listed.items.length, 1);

    const decided = await fetch(`${api.url}/api/reviews/${review.reviewId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'APPROVED',
        expectedRevision: review.revision,
        expectedManifestDigest: review.deliverable.manifestDigest,
      }),
    });
    assert.equal(decided.status, 200);
    assert.equal((await decided.json() as { state: string }).state, 'APPROVED');

    const stale = await fetch(`${api.url}/api/reviews/${review.reviewId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'REJECTED',
        note: 'late',
        expectedRevision: 2,
        expectedManifestDigest: review.deliverable.manifestDigest,
      }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { code: string }).code, 'RUN_REVIEW_NOT_OPEN');

    const rolled = await fetch(`${api.url}/api/apps/listing/1.0.0/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toVersion: '0.9.0', reason: 'regression' }),
    });
    assert.equal(rolled.status, 200);
    const rolledBody = await rolled.json() as { previous: { appVersion: string }; current: { appVersion: string } };
    assert.equal(rolledBody.previous.appVersion, '1.0.0');
    assert.equal(rolledBody.current.appVersion, '0.9.0');
    // R6: an ordinary rollback never revokes the source version.
    assert.equal(service.getApp('listing', '1.0.0', operator).state, 'ACTIVE');
  } finally {
    await api?.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a release registered without provenance keeps a stable digest across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-prov-legacy-'));
  const path = join(root, 'control.sqlite');
  const first = new PlatformControlService(path);
  first.registerApp(draft(), operator);
  const digest = first.getApp('listing', '1.0.0', operator).releaseDigest;
  first.close();
  const reopened = new PlatformControlService(path);
  try {
    assert.equal(reopened.getApp('listing', '1.0.0', operator).releaseDigest, digest);
    assert.equal(reopened.getApp('listing', '1.0.0', operator).draft.provenance, undefined);
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a review decision is projected to the knowledge sink as qc.completed exactly once', async () => {
  const { root, service } = await setup(succeeded, true);
  const events: KnowledgeCaptureEvent[] = [];
  try {
    service.setKnowledgeCaptureSink((event) => { events.push(event) });
    const run = service.createRun('listing', '1.0.0', { goal: 'review-knowledge' }, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    assert.equal(await waitFor(service, run.runId), 'SUCCEEDED');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const before = events.filter((event) => event.kind === 'qc.completed').length;
    const review = service.requestReview(run.runId, operator, '请复核');
    assert.equal(events.filter((event) => event.kind === 'qc.completed').length, before, '请求复核还不是 QC 完成的可信事实');
    const approved = service.recordReviewDecision(
      review.reviewId, 'APPROVED', '已核对', 1, review.deliverable?.manifestDigest, operator,
    );
    await service.drainKnowledgeCaptureOutbox();
    const qc = events.filter((event) => event.kind === 'qc.completed');
    assert.equal(qc.length, 1, '一次复核决定只投影一次');
    assert.equal(qc[0].review?.reviewId, approved.reviewId);
    assert.equal(qc[0].review?.decision, 'APPROVED');
    assert.equal(qc[0].runId, run.runId);
    assert.ok(qc[0].artifactDigests.length > 0, 'QC 事件携带已封存工件摘要');
    // 同一复核的第二份决定被拒绝，也不产生第二条事件
    assert.throws(
      () => service.recordReviewDecision(review.reviewId, 'REJECTED', '翻案', 2, review.deliverable?.manifestDigest, operator),
      isPlatformError('RUN_REVIEW_NOT_OPEN'),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(events.filter((event) => event.kind === 'qc.completed').length, 1);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
