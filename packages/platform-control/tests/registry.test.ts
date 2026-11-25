import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutionPlan } from '../../platform-runtime/src/plan.js';
import { PlatformStore } from '../src/store.js';
import { ApplicationRegistry, PlatformError, releaseDigestOf, releaseOf } from '../src/registry.js';
import { draft, provider } from './helpers.js';

const open = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-registry-'));
  const store = new PlatformStore(join(root, 'control.sqlite'));
  return { root, store, registry: new ApplicationRegistry(store) };
};

test('application releases register, stay deterministic across restart, and reject conflicting content', async () => {
  const { root, store, registry } = await open();
  try {
    const registered = registry.register(draft(), 'operator:test');
    assert.equal(registered.state, 'ACTIVE');
    assert.equal(registered.plan.planDigest, registry.register(draft(), 'operator:test').plan.planDigest);
    assert.equal(registry.list('ACTIVE').length, 1);
    assert.throws(
      () => registry.register({ ...draft(), runtimeBundleDigest: 'c'.repeat(64) }, 'operator:test'),
      (error: unknown) => error instanceof PlatformError && error.code === 'APP_RELEASE_CONFLICT',
    );
    assert.throws(
      () => registry.register({ ...draft(), providers: [] }, 'operator:test'),
      (error: unknown) => error instanceof PlatformError && error.code === 'APP_RELEASE_PROVIDERS_REQUIRED',
    );
    store.close();

    const reopenedStore = new PlatformStore(join(root, 'control.sqlite'));
    try {
      const reopened = new ApplicationRegistry(reopenedStore);
      assert.equal(reopened.get('listing', '1.0.0').plan.planDigest, registered.plan.planDigest);
      assert.equal(reopened.list().length, 1);
    } finally {
      reopenedStore.close();
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('revocation is recorded and keeps existing release facts intact', async () => {
  const { root, store, registry } = await open();
  try {
    registry.register(draft(), 'operator:test');
    const revoked = registry.revoke('listing', '1.0.0', 'superseded by 2.0.0', 'operator:test');
    assert.equal(revoked.state, 'REVOKED');
    assert.equal(revoked.revokeReason, 'superseded by 2.0.0');
    assert.throws(
      () => registry.active('listing', '1.0.0'),
      (error: unknown) => error instanceof PlatformError && error.code === 'APP_RELEASE_NOT_ACTIVE',
    );
    assert.throws(
      () => registry.register(draft(), 'operator:test'),
      (error: unknown) => error instanceof PlatformError && error.code === 'APP_RELEASE_REVOKED',
    );
    assert.equal(registry.list('REVOKED').length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('new registrations store plan contract v2 and re-verify through the envelope', async () => {
  const { root, store, registry } = await open();
  try {
    const record = registry.register(draft(), 'operator:test');
    assert.equal(record.plan.planContractVersion, '2');
    assert.equal(record.plan.descriptorDigest?.length, 64);
    assert.equal(record.plan.view, null, 'no declared view is recorded as explicit null');
    // Re-reading re-runs the envelope verification and does not change identity.
    const readBack = registry.get('listing', '1.0.0');
    assert.equal(readBack.releaseDigest, record.releaseDigest);
    assert.equal(readBack.plan.planDigest, record.plan.planDigest);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy-format records re-verify in their original format and detect tampering', async () => {
  const legacyRecord = () => {
    // A record registered before contract v2: v1 plan body (no marker), original digest formula.
    const base = draft();
    const legacyPlan = resolveExecutionPlan(releaseOf(base, '1'));
    assert.equal(legacyPlan.planContractVersion, undefined);
    return {
      draft: base,
      plan: legacyPlan,
      releaseDigest: releaseDigestOf(base, legacyPlan.planDigest),
      appId: 'listing',
      appVersion: '1.0.0',
      state: 'ACTIVE' as const,
      createdAt: new Date().toISOString(),
    };
  };

  const clean = await open();
  try {
    clean.store.appInsert(legacyRecord());
    const readBack = clean.registry.get('listing', '1.0.0');
    assert.equal(readBack.plan.planContractVersion, undefined, 'legacy record is read as v1, not rewritten');
    assert.equal(readBack.releaseDigest, legacyRecord().releaseDigest, 'legacy record verifies in its original format');
  } finally {
    clean.store.close();
    await rm(clean.root, { recursive: true, force: true });
  }

  const tamperedCase = await open();
  try {
    const record = legacyRecord();
    const tamperedDraft = { ...record.draft, descriptor: { ...record.draft.descriptor, description: 'rewritten after approval' } };
    tamperedCase.store.appInsert({ ...record, draft: tamperedDraft });
    assert.throws(
      () => tamperedCase.registry.get('listing', '1.0.0'),
      (error: unknown) => error instanceof PlatformError && error.code === 'APP_RECORD_CHANGED',
    );
  } finally {
    tamperedCase.store.close();
    await rm(tamperedCase.root, { recursive: true, force: true });
  }
});

test('any controlled declaration change moves releaseDigest, voiding the old approval', async () => {
  const { root, store, registry } = await open();
  try {
    const base = draft();
    const baseDigest = releaseDigestOf(base, resolveExecutionPlan(releaseOf(base)).planDigest);
    const mutants: Array<[string, typeof base]> = [
      ['inputSchema', { ...base, descriptor: { ...base.descriptor, inputSchema: { type: 'object', required: ['batch'] }, inputSchemaVersion: '2' } }],
      ['materialRoles', { ...base, descriptor: { ...base.descriptor, materialRoles: ['需求说明', 'ALS'] } }],
      ['resultViews', {
        ...base,
        descriptor: {
          ...base.descriptor,
          resultViews: [{ viewId: 'checks', title: '检查', kind: 'table' as const, findingKind: 'check', columns: [{ field: 'id', label: 'ID' }] }],
        },
      }],
      ['capability mapping', { ...base, requiredCapabilities: [{ capabilityId: 'listing', version: '2.0.0' }], providers: [provider('listing', '2.0.0')] }],
      ['plugin artifact', { ...base, providers: [{ ...provider('listing', '1.0.0'), artifactDigest: 'c'.repeat(64) }] }],
      ['provenance', { ...base, provenance: { builder: 'builder-b' } }],
    ];
    for (const [what, mutant] of mutants) {
      const mutantDigest = releaseDigestOf(mutant, resolveExecutionPlan(releaseOf(mutant)).planDigest);
      assert.notEqual(mutantDigest, baseDigest, `${what} must move releaseDigest`);
    }
    // The old approval row binds baseDigest only: changed bytes are not covered by it.
    const approval = {
      approvalId: 'approval-1',
      appId: 'listing',
      appVersion: '1.0.0',
      releaseDigest: baseDigest,
      state: 'ACTIVE' as const,
      approvedBy: 'operator:test',
      approvedAt: new Date().toISOString(),
      revision: 1,
    };
    store.approvalPut(approval);
    const [, mutant] = mutants[0];
    const mutantDigest = releaseDigestOf(mutant, resolveExecutionPlan(releaseOf(mutant)).planDigest);
    assert.notEqual(store.approvalGet('listing', '1.0.0')?.releaseDigest, mutantDigest);
    // And the mutated bytes cannot silently replace the approved release under the same identity.
    registry.register(base, 'operator:test');
    assert.throws(
      () => registry.register(mutant, 'operator:test'),
      (error: unknown) => error instanceof PlatformError && error.code === 'APP_RELEASE_CONFLICT',
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
