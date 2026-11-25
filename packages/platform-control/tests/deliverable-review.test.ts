import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor, type RunOutcome } from '../src/service.js';
import { PlatformStore, reviewDeliverableDigest, type ReviewRecord } from '../src/store.js';
import { PlatformError } from '../src/registry.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:dreview', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:dreview', kind: 'service' };
const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

class OutcomeExecutor implements RunExecutor {
  readonly kind = 'outcome';
  constructor(private readonly outcome: RunOutcome) {}
  async dispatch(input: { launchId?: string; fencingToken?: number }) {
    return {
      launchId: input.launchId ?? 'launch-dreview',
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

/** Two real files so the control plane seals actual bytes. Sorted by name — store.artifacts and
 *  therefore every deliverable manifest come back name-ordered. */
const FILES = [
  { name: 'checks.md', content: '# checks' },
  { name: 'listing.xlsx', content: 'A,G,nh,po' },
] as const;

/** The exact {name, digest, bytes} triples any manifest built from these artifacts must carry. */
const expectedArtifacts = FILES.map(({ name, content }) => ({
  name,
  digest: createHash('sha256').update(content).digest('hex'),
  bytes: Buffer.byteLength(content),
}));

const succeededWithArtifacts = async (dir: string): Promise<RunOutcome> => {
  const artifacts = [] as NonNullable<RunOutcome['artifacts']>;
  for (const { name, content } of FILES) {
    const sourcePath = join(dir, name);
    await writeFile(sourcePath, content);
    artifacts.push({
      name,
      digest: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
      sourcePath,
    });
  }
  return {
    status: 'succeeded',
    exitProven: true,
    cleanedUp: true,
    finishReason: 'completed',
    descendantsDone: true,
    consumedThrough: 1,
    artifacts,
  };
};

const bareSucceeded = (): RunOutcome => ({
  status: 'succeeded',
  exitProven: true,
  cleanedUp: true,
  finishReason: 'completed',
  descendantsDone: true,
  consumedThrough: 1,
});

const setup = async (options: { artifacts?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'platform-dreview-'));
  const filesDir = join(root, 'worker-out');
  await mkdir(filesDir, { recursive: true });
  const withArtifacts = options.artifacts !== false;
  const service = new PlatformControlService(
    join(root, 'control.sqlite'),
    new OutcomeExecutor(withArtifacts ? await succeededWithArtifacts(filesDir) : bareSucceeded()),
    undefined,
    { requireArtifacts: withArtifacts },
  );
  service.registerApp(draft(), operator);
  service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
  const work = service.createWork(
    { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '成果复核工作' },
    operator,
  );
  const run = service.createWorkRun(work.workId, { goal: '产出交付物' }, operator);
  await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
  assert.equal(await waitFor(service, run.runId), 'SUCCEEDED');
  return { root, service, work, run, path: join(root, 'control.sqlite') };
};

/** A second run on the same Work: same artifact names and bytes, a fresh deliverable manifest —
 *  the digest must differ because the run differs, never because bytes happened to repeat. */
const nextRun = async (
  service: PlatformControlService,
  work: { workId: string },
): Promise<{ runId: string }> => {
  const run = service.createWorkRun(work.workId, { goal: '换批重跑' }, operator);
  await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
  assert.equal(await waitFor(service, run.runId), 'SUCCEEDED');
  return run;
};

const digestOf = (record: ReviewRecord): string => {
  assert.ok(record.deliverable, 'the record must bind a deliverable manifest');
  return record.deliverable.manifestDigest;
};

test('W4/R5: only sealed deliverables can request a review, and the request freezes a server-built immutable manifest', async () => {
  // A succeeded run without sealed artifacts must not start a review — and must not write one.
  const bareRoot = await mkdtemp(join(tmpdir(), 'platform-dreview-bare-'));
  const bare = new PlatformControlService(
    join(bareRoot, 'control.sqlite'),
    new OutcomeExecutor(bareSucceeded()),
    undefined,
    { requireArtifacts: false },
  );
  try {
    bare.registerApp(draft(), operator);
    const bareRun = bare.createRun('listing', '1.0.0', {}, operator);
    await bare.dispatchRun(bareRun.runId, bareRun.snapshot.revision, supervisor);
    assert.equal(await waitFor(bare, bareRun.runId), 'SUCCEEDED');
    assert.throws(() => bare.requestReview(bareRun.runId, operator), isPlatformError('RUN_REVIEW_NOT_SEALED'));
    assert.equal(bare.reviewsForRun(bareRun.runId, operator).length, 0, 'a refused review writes nothing');
  } finally {
    bare.close();
    await rm(bareRoot, { recursive: true, force: true });
  }

  // A sealed run gets a review whose manifest the server built from its own sealed artifacts.
  const { root, service, run, path } = await setup();
  try {
    const review = service.requestReview(run.runId, operator, '请复核');
    assert.equal(review.state, 'REQUESTED');
    assert.ok(review.deliverable, 'a bound review always carries its deliverable');
    assert.deepEqual(Object.keys(review.deliverable.manifest).sort(), ['artifacts', 'runId'], 'no review state inside the manifest');
    assert.deepEqual(review.deliverable.manifest.artifacts, expectedArtifacts);
    assert.equal(review.deliverable.manifest.runId, run.runId);
    // The digest is exactly the deterministic function of the sealed rows — recomputed here from
    // the store, not copied from the record.
    const store = new PlatformStore(path);
    const sealed = store.artifacts(run.runId).map(({ name, digest, bytes }) => ({ name, digest, bytes }));
    store.close();
    assert.equal(review.deliverable.manifestDigest, reviewDeliverableDigest({ runId: run.runId, artifacts: sealed }));
    // Deciding never changes the target: state moves, manifest and digest stay frozen.
    const approved = service.recordReviewDecision(
      review.reviewId, 'APPROVED', '核对通过', review.revision, digestOf(review), operator,
    );
    const after = service.reviewsForRun(run.runId, operator)[0];
    assert.equal(after.state, 'APPROVED');
    assert.equal(digestOf(after), digestOf(review));
    assert.equal(digestOf(after), reviewDeliverableDigest(after.deliverable!.manifest));
    assert.deepEqual(after.deliverable!.manifest, review.deliverable.manifest);
    assert.equal(approved.revision, 2);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W4/R5: a decision binds the exact target digest — wrong or missing target never takes effect, and only one decision wins', async () => {
  const { root, service, run } = await setup();
  try {
    const review = service.requestReview(run.runId, operator);
    const digest = digestOf(review);
    const otherDigest = 'f'.repeat(64);

    assert.throws(
      () => service.recordReviewDecision(review.reviewId, 'APPROVED', undefined, review.revision, otherDigest, operator),
      isPlatformError('RUN_REVIEW_TARGET_MISMATCH'),
    );
    assert.throws(
      () => service.recordReviewDecision(review.reviewId, 'APPROVED', undefined, review.revision, undefined, operator),
      isPlatformError('RUN_REVIEW_TARGET_REQUIRED'),
    );
    // Neither attempt left a trace: still REQUESTED, same revision, no decision in the audit.
    const untouched = service.reviewsForRun(run.runId, operator)[0];
    assert.equal(untouched.state, 'REQUESTED');
    assert.equal(untouched.revision, 1);
    const decisions = service.audit(0, 50, operator).items.filter((entry) => entry.action.startsWith('RUN_REVIEW_'));
    assert.deepEqual(decisions.map((entry) => entry.action), ['RUN_REVIEW_REQUESTED']);

    // The correct target with the current revision is the only winning decision.
    const approved = service.recordReviewDecision(review.reviewId, 'APPROVED', '通过', review.revision, digest, operator);
    assert.equal(approved.state, 'APPROVED');
    assert.equal(approved.reviewer, operator.actorId);
    // A concurrent-looking second decision cannot take effect — closed state first, stale CAS next.
    assert.throws(
      () => service.recordReviewDecision(review.reviewId, 'REJECTED', '太迟了', approved.revision, digest, operator),
      isPlatformError('RUN_REVIEW_NOT_OPEN'),
    );
    assert.throws(
      () => service.recordReviewDecision(review.reviewId, 'APPROVED', '太迟了', 99, digest, operator),
      isPlatformError('RUN_REVIEW_NOT_OPEN'),
    );
    const final = service.reviewsForRun(run.runId, operator)[0];
    assert.equal(final.state, 'APPROVED');
    assert.equal(final.revision, 2);
    assert.equal(final.reviewer, operator.actorId, 'the losing decision never overwrote the winner');

    // The todo surface names the frozen target while open — the display marks the binding.
    const open = service.requestReview(run.runId, operator);
    assert.throws(() => service.requestReview(run.runId, operator), isPlatformError('RUN_REVIEW_EXISTS'));
    const todo = service.pendingTodos(operator).find((item) => item.kind === 'review');
    assert.ok(todo, 'the open review is a todo');
    assert.match(todo.summary, /目标清单/);
    assert.ok(todo.summary.includes(digest.slice(0, 12)), 'the todo names the target manifest digest');
    void open;
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W4/R5: audit traces a decision back to the exact artifact digests it judged', async () => {
  const { root, service, run } = await setup();
  try {
    const review = service.requestReview(run.runId, operator, '请复核本轮结果');
    const digest = digestOf(review);
    service.recordReviewDecision(review.reviewId, 'APPROVED', '已核对', review.revision, digest, operator);

    const entries = service.audit(0, 50, operator).items;
    const detailsOf = (entry: { details: unknown }): Record<string, unknown> =>
      entry.details as Record<string, unknown>;
    const decisionEntry = entries.find((entry) => entry.action === 'RUN_REVIEW_APPROVED');
    assert.ok(decisionEntry, 'the decision is audited');
    assert.equal(decisionEntry.target, run.runId);
    assert.equal(detailsOf(decisionEntry).manifestDigest, digest, 'the decision audit names the exact target digest');
    const requestEntry = entries.find((entry) => entry.action === 'RUN_REVIEW_REQUESTED');
    assert.ok(requestEntry, 'the request is audited');
    assert.equal(detailsOf(requestEntry).reviewId, review.reviewId);
    assert.equal(detailsOf(requestEntry).manifestDigest, digest, 'request and decision audits agree on one target');
    assert.deepEqual(
      detailsOf(requestEntry).artifacts,
      expectedArtifacts.map(({ name, digest: d }) => ({ name, digest: d })),
      'the request audit carries every judged artifact digest',
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W4/R5: an approval never carries over to a different deliverable manifest', async () => {
  const { root, service, work, run } = await setup();
  try {
    // Run 1 is approved against its own manifest.
    const review1 = service.requestReview(run.runId, operator);
    const digest1 = digestOf(review1);
    service.recordReviewDecision(review1.reviewId, 'APPROVED', '第一批通过', review1.revision, digest1, operator);

    // Run 2: same artifact names and bytes, a different run — therefore a different manifest.
    const run2 = await nextRun(service, work);
    assert.equal(service.reviewsForRun(run2.runId, operator).length, 0, 'no inherited review on the new run');
    // Sealing run 2 while it has no review must NOT project run 1's approval: different target.
    const sealedFirst = service.sealDeliveryPackage(work.workId, { runId: run2.runId }, operator);
    assert.equal(
      sealedFirst.manifest.review, null,
      'a package only ever shows a review bound to its own manifest — never another run\'s approval',
    );

    // Run 2's own review binds its own digest; the old approval applies nowhere.
    const review2 = service.requestReview(run2.runId, operator);
    const digest2 = digestOf(review2);
    assert.notEqual(digest2, digest1, 'a different run is a different deliverable manifest even with identical bytes');
    assert.equal(review2.state, 'REQUESTED', 'the previous approval is not inherited');
    const sealedOwn = service.sealDeliveryPackage(work.workId, { runId: run2.runId }, operator);
    assert.equal(sealedOwn.manifest.review?.state, 'REQUESTED', 'the package shows the matching open review');

    // Run 2 gets its own decision; each package then reflects exactly its matching review.
    service.recordReviewDecision(review2.reviewId, 'REJECTED', '换批不通过', review2.revision, digest2, operator);
    const sealedAfter = service.sealDeliveryPackage(work.workId, { runId: run2.runId }, operator);
    assert.equal(sealedAfter.manifest.review?.state, 'REJECTED');
    const sealedRun1 = service.sealDeliveryPackage(work.workId, { runId: run.runId }, operator);
    assert.equal(sealedRun1.manifest.review?.state, 'APPROVED', 'run 1 keeps its own conclusion under its own target');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W4/R5: legacy run-only records keep their existing facts and never match a manifest', async () => {
  const { root, service, work, run, path } = await setup();
  try {
    // Plant a pre-W4 record exactly as the old path wrote it: run-bound, no deliverable.
    const legacy: ReviewRecord = {
      reviewId: 'legacy-run-only-review',
      runId: run.runId,
      state: 'REQUESTED',
      requestedBy: 'session:legacy',
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const planting = new PlatformStore(path);
    planting.reviewInsert(legacy);
    planting.close();

    const listed = service.reviewsForRun(run.runId, operator)[0];
    assert.equal('deliverable' in listed, false, 'no manifest is ever invented for an old record');
    // The todo honestly marks the record as run-only.
    const todo = service.pendingTodos(operator).find((item) => item.kind === 'review');
    assert.ok(todo, 'the legacy open review is still a todo');
    assert.match(todo.summary, /未绑定具体成果版本/);
    // One open request per run still holds; a claimed target on a run-only record is refused.
    assert.throws(() => service.requestReview(run.runId, operator), isPlatformError('RUN_REVIEW_EXISTS'));
    assert.throws(
      () => service.recordReviewDecision(legacy.reviewId, 'APPROVED', undefined, 1, 'f'.repeat(64), operator),
      isPlatformError('RUN_REVIEW_TARGET_INVALID'),
    );
    // The legacy decision works on revision alone, exactly as it always did.
    const decided = service.recordReviewDecision(legacy.reviewId, 'APPROVED', '旧批通过', 1, undefined, operator);
    assert.equal(decided.state, 'APPROVED');
    assert.equal('deliverable' in decided, false, 'deciding never retrofits a manifest onto an old record');

    // Sealing must not project the legacy approval into the package: no matching manifest exists.
    const pkg = service.sealDeliveryPackage(work.workId, { runId: run.runId }, operator);
    assert.equal(pkg.manifest.review, null, 'a package only associates reviews bound to its exact manifest');
    // Once the old request is decided, a new request binds the server-built manifest normally.
    const fresh = service.requestReview(run.runId, operator);
    assert.ok(fresh.deliverable);
    assert.notEqual(fresh.reviewId, legacy.reviewId);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W4/R5: execution, sealing and review stay three separate displays', async () => {
  const { root, service, work, run } = await setup();
  try {
    const pkg = service.sealDeliveryPackage(work.workId, { runId: run.runId }, operator);
    assert.equal(pkg.manifest.review, null, 'sealing before any review stays honestly null');
    const review = service.requestReview(run.runId, operator);
    service.recordReviewDecision(review.reviewId, 'APPROVED', undefined, review.revision, digestOf(review), operator);

    // The decision changed the review and nothing else: execution state, seal record and
    // package revision all keep their own facts.
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'SUCCEEDED', 'a review never rewrites the run state');
    const afterPkg = service.deliveryPackagesForWork(work.workId, 0, 10, operator).items[0];
    assert.equal(afterPkg.state, 'SEALED', 'a review never rewrites the delivery package');
    assert.equal(afterPkg.revision, pkg.revision, 'the package record is untouched by the decision');
    assert.deepEqual(afterPkg.manifest.artifacts, pkg.manifest.artifacts, 'the frozen manifest is untouched');
    assert.equal(service.reviewsForRun(run.runId, operator)[0].state, 'APPROVED');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

const call = async (api: RunningWorkbenchApi, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${api.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

test('W4/R5: the decision API requires the bound target digest and keeps honest status codes', async () => {
  const { root, service, run } = await setup();
  const api = await startWorkbenchServer({ service, authenticate: () => operator });
  try {
    const requested = await call(api, 'POST', `/api/runs/${run.runId}/reviews`, { note: '请复核' });
    assert.equal(requested.status, 201);
    const digest = (requested.body as { deliverable: { manifestDigest: string } }).deliverable.manifestDigest;
    assert.match(digest, /^[a-f0-9]{64}$/);
    const reviewId = (requested.body as { reviewId: string }).reviewId;

    const mismatch = await call(api, 'POST', `/api/reviews/${reviewId}/decision`, {
      decision: 'APPROVED', expectedRevision: 1, expectedManifestDigest: 'f'.repeat(64),
    });
    assert.equal(mismatch.status, 400);
    assert.equal((mismatch.body as { code: string }).code, 'RUN_REVIEW_TARGET_MISMATCH');

    const missing = await call(api, 'POST', `/api/reviews/${reviewId}/decision`, {
      decision: 'APPROVED', expectedRevision: 1,
    });
    assert.equal(missing.status, 400);
    assert.equal((missing.body as { code: string }).code, 'RUN_REVIEW_TARGET_REQUIRED');

    const decided = await call(api, 'POST', `/api/reviews/${reviewId}/decision`, {
      decision: 'APPROVED', note: '通过', expectedRevision: 1, expectedManifestDigest: digest,
    });
    assert.equal(decided.status, 200);
    assert.equal((decided.body as { state: string }).state, 'APPROVED');

    const closed = await call(api, 'POST', `/api/reviews/${reviewId}/decision`, {
      decision: 'REJECTED', note: '太迟', expectedRevision: 2, expectedManifestDigest: digest,
    });
    assert.equal(closed.status, 409);
    assert.equal((closed.body as { code: string }).code, 'RUN_REVIEW_NOT_OPEN');
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
