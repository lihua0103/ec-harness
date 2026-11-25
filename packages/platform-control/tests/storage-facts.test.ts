import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:storage', kind: 'operator' };

test('storage facts state the real store path and name what backup does not cover (E0d)', async (t) => {
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = undefined;
  t.after(() => {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
  });
  const root = await mkdtemp(join(tmpdir(), 'platform-storage-'));
  const storePath = join(root, 'control.sqlite');
  const service = new PlatformControlService(storePath, null, undefined, { requireArtifacts: false });
  service.registerApp(draft(), operator);
  try {
    const facts = service.storageFacts(operator);
    // The absolute on-disk location, not a relative promise that shifts with the CWD.
    assert.equal(facts.controlStorePath, storePath);
    assert.deepEqual(facts.backupCoverage, {
      controlStore: true,
      sealedArtifacts: true,
      knowledgeStore: false,
      nativeSessionHomes: false,
    });
    assert.equal(facts.recoveryRestrictionMarkers, false);

    const servicePrincipal: Principal = { actorId: 'service:storage', kind: 'service' };
    assert.throws(() => service.storageFacts(servicePrincipal));
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the workbench bootstrap carries the storage block so the UI can label it honestly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-storage-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), null, undefined, { requireArtifacts: false });
  service.registerApp(draft(), operator);
  const api = await startWorkbenchServer({ service, authenticate: () => operator });
  try {
    const response = await fetch(`${api.url}/api/workbench`);
    const body = await response.json() as { storage?: { controlStorePath: string; backupCoverage?: Record<string, boolean> } };
    assert.equal(response.status, 200);
    assert.ok(body.storage, 'bootstrap must include the storage block');
    assert.equal(body.storage.controlStorePath, join(root, 'control.sqlite'));
    assert.equal(body.storage.backupCoverage?.nativeSessionHomes, false);
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
