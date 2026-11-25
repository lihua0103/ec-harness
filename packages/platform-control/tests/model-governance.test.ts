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

const operator: Principal = { actorId: 'session:model-gov', kind: 'operator' };
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

/** Service with a registered app + catalog whose default selection resolves on every run. */
const setup = async (options: { requireModelApproval?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'platform-model-gov-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), null, undefined, {
    requireArtifacts: false,
    ...options,
  });
  service.registerApp(draft(), operator);
  service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
  service.registerModelCatalog(catalogDraft(), operator);
  const work = service.createWork(
    { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '模型治理工作' },
    operator,
  );
  return { root, service, work };
};

test('approval is off by default; a deployment must opt in (E2-3 honesty, E2-4)', async () => {
  const { root, service, work } = await setup();
  try {
    // The catalog default resolves; no approval exists; the run still starts.
    const run = service.createWorkRun(work.workId, { goal: '默认关闭' }, operator);
    assert.equal(run.snapshot.state, 'QUEUED');
    assert.equal(service.modelApproval('model.flash', operator), null);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an active approval gates the resolved selection, whichever way it was picked', async () => {
  const { root, service, work } = await setup({ requireModelApproval: true });
  try {
    // Catalog default (no explicit choice, no preference) hits the same gate.
    assert.throws(
      () => service.createWorkRun(work.workId, { goal: '未批准' }, operator),
      isPlatformError('MODEL_APPROVAL_REQUIRED'),
    );
    assert.throws(
      () => service.createWorkRun(work.workId, { goal: '显式选择' }, operator, { modelSelectionId: 'model.flash' }),
      isPlatformError('MODEL_APPROVAL_REQUIRED'),
    );

    // A selection that is not in the registered catalog cannot be approved.
    assert.throws(
      () => service.approveModel({ selectionId: 'model.ghost', approvedBy: 'ops' }, operator),
      isPlatformError('MODEL_APPROVAL_SELECTION_UNKNOWN'),
    );
    // Refusals keep the input honest.
    assert.throws(
      () => service.approveModel({ selectionId: 'model.flash', approvedBy: '  ' }, operator),
      isPlatformError('MODEL_APPROVAL_INVALID'),
    );

    const approval = service.approveModel({
      selectionId: 'model.flash',
      approvedBy: 'ops-lead',
      evidence: '评审记录 #12',
    }, operator);
    assert.equal(approval.state, 'ACTIVE');
    assert.equal(approval.revision, 1);

    const run = service.createWorkRun(work.workId, { goal: '已批准' }, operator);
    assert.equal(run.model?.selectionId, 'model.flash');
    // One active run per work: settle it so later refusals can be attributed to the gate.
    await service.cancelRun(run.runId, run.snapshot.revision, operator);

    // Revocation takes effect immediately; a re-grant bumps the revision.
    service.revokeModelApproval('model.flash', '供应商事件', operator);
    assert.throws(
      () => service.createWorkRun(work.workId, { goal: '撤回后' }, operator),
      isPlatformError('MODEL_APPROVAL_REQUIRED'),
    );
    const regranted = service.approveModel({ selectionId: 'model.flash', approvedBy: 'ops-lead' }, operator);
    assert.equal(regranted.revision, 3);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an expired approval blocks new runs and the record survives a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-model-gov-restart-'));
  const path = join(root, 'control.sqlite');
  const service = new PlatformControlService(path, null, undefined, {
    requireArtifacts: false,
    requireModelApproval: true,
  });
  try {
    service.registerApp(draft(), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    service.registerModelCatalog(catalogDraft(), operator);
    service.approveModel({
      selectionId: 'model.flash',
      approvedBy: 'ops-lead',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }, operator);
    const work = service.createWork(
      { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '过期审批' },
      operator,
    );
    assert.throws(
      () => service.createWorkRun(work.workId, { goal: '过期' }, operator),
      isPlatformError('MODEL_APPROVAL_EXPIRED'),
    );
  } finally {
    service.close();
  }
  const reopened = new PlatformControlService(path, null, undefined, { requireArtifacts: false, requireModelApproval: true });
  try {
    const record = reopened.modelApproval('model.flash', operator);
    assert.equal(record?.state, 'ACTIVE');
    assert.equal(record?.approvedBy, 'ops-lead');
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the model-approval HTTP surface grants, reads, revokes and lists', async () => {
  const { root, service } = await setup();
  const api = await startWorkbenchServer({ service, authenticate: () => operator });
  try {
    const grant = await fetch(`${api.url}/api/models/model.flash/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvedBy: 'ops-lead' }),
    });
    assert.equal(grant.status, 201);
    const granted = await grant.json() as { approvalId: string; state: string };
    assert.equal(granted.state, 'ACTIVE');

    const read = await fetch(`${api.url}/api/models/model.flash/approval`);
    assert.equal(read.status, 200);
    const record = await read.json() as { approval: { approvalId: string } | null };
    assert.equal(record.approval?.approvalId, granted.approvalId);

    const list = await fetch(`${api.url}/api/models/approvals`);
    assert.equal(list.status, 200);
    const listed = await list.json() as { items: unknown[] };
    assert.equal(listed.items.length, 1);

    const revoke = await fetch(`${api.url}/api/models/model.flash/approval/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '供应商事件' }),
    });
    assert.equal(revoke.status, 200);
    const revoked = await revoke.json() as { state: string };
    assert.equal(revoked.state, 'REVOKED');

    const unknown = await fetch(`${api.url}/api/models/model.ghost/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvedBy: 'ops-lead' }),
    });
    assert.equal(unknown.status, 400);
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('pendingTodos surfaces an unapproved model only when the deployment gates on approval', async () => {
  const gated = await setup({ requireModelApproval: true });
  try {
    const before = gated.service.pendingTodos(operator).filter((todo) => todo.kind === 'model-approval');
    assert.equal(before.length, 1, '开启审批门禁后，未批准的已登记模型是一条待办');
    assert.equal(before[0].id, 'model.flash');
    assert.match(before[0].summary, /MODEL_APPROVAL_REQUIRED/);
    assert.match(before[0].resolveHint, /approval/);
    gated.service.approveModel({ selectionId: 'model.flash', approvedBy: 'qa' }, operator);
    assert.equal(
      gated.service.pendingTodos(operator).filter((todo) => todo.kind === 'model-approval').length,
      0,
      '审批生效后待办消失',
    );
  } finally {
    gated.service.close();
    await rm(gated.root, { recursive: true, force: true });
  }
  const ungated = await setup();
  try {
    assert.equal(
      ungated.service.pendingTodos(operator).filter((todo) => todo.kind === 'model-approval').length,
      0,
      '未开启审批门禁时不制造无意义的待办',
    );
  } finally {
    ungated.service.close();
    await rm(ungated.root, { recursive: true, force: true });
  }
});
