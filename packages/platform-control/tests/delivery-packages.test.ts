import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PlatformControlService,
  type RunExecutor,
  type RunOutcome,
} from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:delivery', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:delivery', kind: 'service' };
const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

class OutcomeExecutor implements RunExecutor {
  readonly kind = 'outcome';
  constructor(private readonly outcome: RunOutcome) {}
  async dispatch(input: { launchId?: string; fencingToken?: number }) {
    return {
      launchId: input.launchId ?? 'launch-delivery',
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

/** Outcome carrying two real files so the control plane seals actual bytes, not claims. */
const succeededWithArtifacts = async (dir: string): Promise<RunOutcome> => {
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

const setup = async (options: { requireArtifacts?: boolean; noArtifacts?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'platform-delivery-'));
  const filesDir = join(root, 'worker-out');
  await mkdir(filesDir, { recursive: true });
  const outcome = options.noArtifacts
    ? { status: 'succeeded', exitProven: true, cleanedUp: true, finishReason: 'completed', descendantsDone: true, consumedThrough: 1 } as RunOutcome
    : await succeededWithArtifacts(filesDir);
  const service = new PlatformControlService(join(root, 'control.sqlite'), new OutcomeExecutor(outcome), undefined, {
    requireArtifacts: options.requireArtifacts ?? true,
  });
  service.registerApp(draft(), operator);
  service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
  const work = service.createWork(
    { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '交付包工作' },
    operator,
  );
  const run = service.createWorkRun(work.workId, { goal: '产出交付物' }, operator);
  await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
  await waitFor(service, run.runId);
  return { root, service, work, run };
};

test('sealing freezes artifact digests and the honest review snapshot, then deliver and receive are separate facts', async () => {
  const { root, service, work, run } = await setup();
  try {
    const pkg = service.sealDeliveryPackage(work.workId, { runId: run.runId }, operator);
    assert.equal(pkg.state, 'SEALED');
    assert.equal(pkg.manifest.artifacts.length, 2);
    assert.equal(pkg.manifest.review, null, 'a never-reviewed run must seal with review=null, not an invented state');
    assert.match(pkg.packageDigest, /^[a-f0-9]{64}$/);
    assert.equal(pkg.sealedBy, operator.actorId);

    const delivered = service.deliverDeliveryPackage(pkg.packageId, '已发项目组', pkg.revision, operator);
    assert.equal(delivered.state, 'DELIVERED');
    assert.ok(delivered.deliveredAt);
    const received = service.acknowledgeDeliveryPackage(pkg.packageId, undefined, delivered.revision, operator);
    assert.equal(received.state, 'RECEIVED');
    assert.ok(received.receivedAt);
    assert.equal(received.deliveredNote, '已发项目组');
    // RECEIVED is terminal for withdrawal: the record stays, the state cannot regress.
    assert.throws(
      () => service.withdrawDeliveryPackage(pkg.packageId, 'too late', received.revision, operator),
      isPlatformError('DELIVERY_PACKAGE_STATE'),
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a run without sealed artifacts cannot be sealed into a delivery package', async () => {
  const { root, service, work, run } = await setup({ noArtifacts: true, requireArtifacts: false });
  try {
    assert.throws(
      () => service.sealDeliveryPackage(work.workId, { runId: run.runId }, operator),
      isPlatformError('DELIVERY_PACKAGE_INVALID'),
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('supersession is explicit, same-Work only, and never silently replaces a package', async () => {
  const { root, service, work, run } = await setup();
  try {
    const first = service.sealDeliveryPackage(work.workId, { runId: run.runId }, operator);
    // Review the first run, then produce a second succeeded run and seal it: the second package
    // must not inherit the first package's review (旧审核不自动迁移).
    const review = service.requestReview(run.runId, operator);
    service.recordReviewDecision(
      review.reviewId, 'APPROVED', '核对通过', review.revision, review.deliverable!.manifestDigest, operator,
    );
    const run2 = service.createWorkRun(work.workId, { goal: '换批重跑' }, operator);
    await service.dispatchRun(run2.runId, run2.snapshot.revision, supervisor);
    await waitFor(service, run2.runId);
    // Give the replacement its own review: the new package must carry that review, never run1's approval.
    service.requestReview(run2.runId, operator);
    const second = service.sealDeliveryPackage(work.workId, { runId: run2.runId }, operator);
    assert.equal(second.manifest.review?.state, 'REQUESTED', 'second run has its own open review, not the first run approval');
    assert.notEqual(first.manifest.review, second.manifest.review);

    assert.throws(
      () => service.supersedeDeliveryPackage(first.packageId, first.packageId, first.revision, operator),
      isPlatformError('DELIVERY_PACKAGE_SUPERSEDE_INVALID'),
    );
    const superseded = service.supersedeDeliveryPackage(first.packageId, second.packageId, first.revision, operator);
    assert.equal(superseded.state, 'SUPERSEDED');
    assert.equal(superseded.supersededBy, second.packageId);
    const history = service.deliveryPackagesForWork(work.workId, 0, 10, operator);
    assert.equal(history.total, 2);
    assert.equal(history.items[0].packageId, second.packageId, 'newest first');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('withdrawal demands a reason, CAS rejects a stale revision, and archived Works cannot seal', async () => {
  const { root, service, work, run } = await setup();
  try {
    const pkg = service.sealDeliveryPackage(work.workId, { runId: run.runId }, operator);
    assert.throws(
      () => service.withdrawDeliveryPackage(pkg.packageId, '   ', pkg.revision, operator),
      isPlatformError('DELIVERY_PACKAGE_REASON_REQUIRED'),
    );
    assert.throws(
      () => service.deliverDeliveryPackage(pkg.packageId, undefined, pkg.revision + 5, operator),
      isPlatformError('DELIVERY_PACKAGE_REVISION_STALE'),
    );
    const withdrawn = service.withdrawDeliveryPackage(pkg.packageId, '交付对象变更', pkg.revision, operator);
    assert.equal(withdrawn.state, 'WITHDRAWN');
    assert.equal(withdrawn.withdrawReason, '交付对象变更');
    assert.throws(
      () => service.acknowledgeDeliveryPackage(pkg.packageId, undefined, withdrawn.revision, operator),
      isPlatformError('DELIVERY_PACKAGE_STATE'),
    );

    service.archiveWork(work.workId, operator);
    assert.throws(
      () => service.sealDeliveryPackage(work.workId, { runId: run.runId }, operator),
      isPlatformError('WORK_ARCHIVED'),
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a run from another Work cannot be sealed into this Work, and a service principal is denied', async () => {
  const { root, service, work, run } = await setup();
  try {
    const otherWork = service.createWork(
      { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '另一个工作' },
      operator,
    );
    const otherRun = service.createWorkRun(otherWork.workId, { goal: '别的工作' }, operator);
    await service.dispatchRun(otherRun.runId, otherRun.snapshot.revision, supervisor);
    await waitFor(service, otherRun.runId);
    assert.throws(
      () => service.sealDeliveryPackage(work.workId, { runId: otherRun.runId }, operator),
      isPlatformError('DELIVERY_PACKAGE_INVALID'),
    );
    const servicePrincipal: Principal = { actorId: 'service:worker', kind: 'service' };
    assert.throws(
      () => service.sealDeliveryPackage(work.workId, { runId: run.runId }, servicePrincipal),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PLATFORM_AUTHORIZATION_DENIED',
    );
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

test('the HTTP surface addresses the exact package resources and keeps honest status codes', async () => {
  const { root, service, work, run } = await setup();
  const api = await startWorkbenchServer({ service, authenticate: () => operator });
  try {
    const empty = await call(api, 'GET', `/api/works/${work.workId}/delivery-packages`);
    assert.deepEqual(empty.body, { total: 0, items: [] });

    const sealed = await call(api, 'POST', `/api/works/${work.workId}/delivery-packages`, { runId: run.runId });
    assert.equal(sealed.status, 201);
    assert.equal(sealed.body.state, 'SEALED');
    const packageId = sealed.body.packageId as string;

    const delivered = await call(api, 'POST', `/api/delivery-packages/${packageId}/deliver`, {
      note: '邮件发出', expectedRevision: sealed.body.revision,
    });
    assert.equal(delivered.status, 200);
    assert.equal(delivered.body.state, 'DELIVERED');

    const stale = await call(api, 'POST', `/api/delivery-packages/${packageId}/acknowledge`, {
      expectedRevision: 99,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'DELIVERY_PACKAGE_REVISION_STALE');

    const received = await call(api, 'POST', `/api/delivery-packages/${packageId}/acknowledge`, {
      expectedRevision: delivered.body.revision,
    });
    assert.equal(received.status, 200);
    assert.equal(received.body.state, 'RECEIVED');

    const listed = await call(api, 'GET', `/api/works/${work.workId}/delivery-packages`);
    assert.equal(listed.body.total, 1);
    assert.equal(listed.body.items[0].packageId, packageId);

    const missing = await call(api, 'GET', '/api/delivery-packages/no-such-package');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'DELIVERY_PACKAGE_NOT_FOUND');

    const withdrawn = await call(api, 'POST', '/api/works/no-such-work/delivery-packages', { runId: run.runId });
    assert.equal(withdrawn.status, 404);
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
