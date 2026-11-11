import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformStore } from '../src/store.js';
import { ApplicationRegistry, PlatformError } from '../src/registry.js';
import { draft } from './helpers.js';

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
