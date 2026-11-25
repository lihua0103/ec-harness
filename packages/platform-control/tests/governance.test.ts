import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor } from '../src/service.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import { PlatformError } from '../src/registry.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:governance', kind: 'operator' };

class NoopExecutor implements RunExecutor {
  readonly kind = 'noop';
  async dispatch(input: { launchId?: string; fencingToken?: number }) {
    return { launchId: input.launchId ?? 'launch-noop', fencingToken: input.fencingToken ?? 1 };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

const entry = (overrides: Record<string, unknown> = {}) => ({
  selectionId: 'model.flash',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  displayName: 'DeepSeek-Flash',
  adapter: 'dsh-llm-deepseek',
  enabled: true,
  verification: 'provider-declared',
  parameters: { maxTokens: true },
  ...overrides,
});

const catalogDraft = () => ({
  catalogId: 'deployment.default',
  runtimeBundleDigest: 'b'.repeat(64),
  defaultSelectionId: 'model.flash',
  entries: [entry()],
});

test('an active approval bound to the exact release digest gates run creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-approval-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), new NoopExecutor(), undefined, {
    requireReleaseApproval: true,
  });
  try {
    service.registerApp(draft(), operator);
    const release = service.getApp('listing', '1.0.0', operator);
    assert.throws(() => service.createRun('listing', '1.0.0', {}, operator), isPlatformError('APP_RELEASE_NOT_APPROVED'));

    assert.throws(
      () => service.approveRelease({
        appId: 'listing',
        appVersion: '1.0.0',
        releaseDigest: 'f'.repeat(64),
        approvedBy: 'qa-lead',
      }, operator),
      isPlatformError('APP_APPROVAL_DIGEST_MISMATCH'),
    );

    const approval = service.approveRelease({
      appId: 'listing',
      appVersion: '1.0.0',
      releaseDigest: release.releaseDigest,
      approvedBy: 'qa-lead',
      evidence: 'test-run:42',
      rollbackTarget: '0.9.0',
    }, operator);
    assert.equal(approval.state, 'ACTIVE');
    assert.equal(approval.evidence, 'test-run:42');
    assert.equal(service.releaseApproval('listing', '1.0.0', operator)?.revision, 1);

    const run = service.createRun('listing', '1.0.0', {}, operator);
    assert.equal(run.snapshot.state, 'QUEUED');

    service.revokeReleaseApproval('listing', '1.0.0', 'superseded', operator);
    assert.throws(() => service.createRun('listing', '1.0.0', {}, operator), isPlatformError('APP_RELEASE_NOT_APPROVED'));
    assert.equal(service.status().approvals?.revoked, 1);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an expired approval blocks new runs and survives restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-approval-expiry-'));
  const path = join(root, 'control.sqlite');
  const service = new PlatformControlService(path, new NoopExecutor(), undefined, { requireReleaseApproval: true });
  try {
    service.registerApp(draft(), operator);
    const release = service.getApp('listing', '1.0.0', operator);
    service.approveRelease({
      appId: 'listing',
      appVersion: '1.0.0',
      releaseDigest: release.releaseDigest,
      approvedBy: 'qa-lead',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }, operator);
    assert.throws(
      () => service.createRun('listing', '1.0.0', {}, operator),
      isPlatformError('APP_RELEASE_APPROVAL_EXPIRED'),
    );
  } finally {
    service.close();
  }
  const reopened = new PlatformControlService(path, new NoopExecutor(), undefined, { requireReleaseApproval: true });
  try {
    assert.equal(reopened.releaseApproval('listing', '1.0.0', operator)?.approvedBy, 'qa-lead');
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('approval and model-health facts are exposed over the same-origin API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-governance-http-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), new NoopExecutor());
  let api: RunningWorkbenchApi | undefined;
  try {
    service.registerApp(draft(), operator);
    service.registerModelCatalog(catalogDraft(), operator);
    const release = service.getApp('listing', '1.0.0', operator);
    api = await startWorkbenchServer({ service, authenticate: () => operator });

    const approve = await fetch(`${api.url}/api/apps/listing/1.0.0/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        releaseDigest: release.releaseDigest,
        approvedBy: 'qa-lead',
        evidence: 'uat-run-7',
      }),
    });
    assert.equal(approve.status, 201);
    const approval = await approve.json() as { state: string; approvedBy: string };
    assert.equal(approval.state, 'ACTIVE');
    assert.equal(approval.approvedBy, 'qa-lead');

    const read = await fetch(`${api.url}/api/apps/listing/1.0.0/approval`).then((res) => res.json()) as { approval: { evidence: string } };
    assert.equal(read.approval.evidence, 'uat-run-7');
    const list = await fetch(`${api.url}/api/approvals`).then((res) => res.json()) as { items: Array<{ appId: string }> };
    assert.equal(list.items[0]?.appId, 'listing');

    service.recordModelHealth({ selectionId: 'model.flash', state: 'degraded', reason: 'elevated latency' }, operator);
    const models = await fetch(`${api.url}/api/models`).then((res) => res.json()) as {
      health: Array<{ selectionId: string; state: string }>;
    };
    assert.deepEqual(models.health.map((item) => [item.selectionId, item.state]), [['model.flash', 'degraded']]);
  } finally {
    await api?.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a recorded unavailable health fact blocks dispatch when health is enforced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-model-health-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), new NoopExecutor(), undefined, {
    requireModelHealth: true,
  });
  try {
    service.registerApp(draft(), operator);
    service.registerModelCatalog(catalogDraft(), operator);
    const run = service.createRun('listing', '1.0.0', {}, operator);

    const unavailable = service.recordModelHealth(
      { selectionId: 'model.flash', state: 'unavailable', reason: 'provider 401' },
      operator,
    );
    assert.equal(unavailable.state, 'unavailable');
    assert.throws(() => service.createRun('listing', '1.0.0', {}, operator), isPlatformError('MODEL_HEALTH_UNAVAILABLE'));
    await assert.rejects(
      service.dispatchRun(run.runId, run.snapshot.revision, { actorId: 'service:health', kind: 'service' }),
      isPlatformError('MODEL_HEALTH_UNAVAILABLE'),
    );

    service.recordModelHealth({ selectionId: 'model.flash', state: 'healthy' }, operator);
    const recovered = service.createRun('listing', '1.0.0', {}, operator);
    assert.equal(recovered.snapshot.state, 'QUEUED');
    assert.equal(service.modelHealth(operator)[0].state, 'healthy');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('health recording requires a known catalog selection and a reason when unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-model-health-invalid-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), new NoopExecutor());
  try {
    service.registerApp(draft(), operator);
    assert.throws(
      () => service.recordModelHealth({ selectionId: 'model.flash', state: 'healthy' }, operator),
      isPlatformError('MODEL_CATALOG_UNAVAILABLE'),
    );
    service.registerModelCatalog(catalogDraft(), operator);
    assert.throws(
      () => service.recordModelHealth({ selectionId: 'model.missing', state: 'healthy' }, operator),
      isPlatformError('MODEL_SELECTION_UNKNOWN'),
    );
    assert.throws(
      () => service.recordModelHealth({ selectionId: 'model.flash', state: 'unavailable' }, operator),
      isPlatformError('MODEL_HEALTH_INVALID'),
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});