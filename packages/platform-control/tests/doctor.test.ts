import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PlatformControlService } from '../src/service.js';
import { PlatformStore } from '../src/store.js';
import { runDoctor } from '../src/doctor.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:doctor', kind: 'operator' };
const check = (report: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
  report.checks.find((item) => item.name === name);

test('a first-run doctor reports warnings but no failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-doctor-fresh-'));
  try {
    const report = await runDoctor({ storePath: join(root, 'control.sqlite'), checkSdk: false });
    assert.equal(report.ok, true);
    assert.equal(check(report, 'node.version')?.status, 'ok');
    assert.equal(check(report, 'store.integrity')?.status, 'warn');
    assert.equal(check(report, 'worker.config')?.status, 'warn');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing store is checked for identity, integrity and facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-doctor-store-'));
  const storePath = join(root, 'control.sqlite');
  try {
    const service = new PlatformControlService(storePath);
    service.registerApp(draft(), operator);
    service.close();

    const store = new PlatformStore(storePath);
    try {
      assert.deepEqual(store.integrityCheck(), { ok: true, messages: [] });
    } finally {
      store.close();
    }

    const report = await runDoctor({ storePath, checkSdk: false });
    assert.equal(report.ok, true);
    assert.equal(check(report, 'store.integrity')?.status, 'ok');
    assert.match(check(report, 'store.facts')?.detail ?? '', /应用 1/);
    // A registered release without an approval is only a warning, not a failure.
    assert.equal(check(report, 'store.approvals')?.status, 'warn');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a store from another product or a corrupted file fails the doctor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-doctor-bad-'));
  try {
    const foreign = join(root, 'foreign.sqlite');
    const db = new DatabaseSync(foreign);
    db.exec('CREATE TABLE something(value TEXT); PRAGMA user_version=7;');
    db.close();
    const foreignReport = await runDoctor({ storePath: foreign, checkSdk: false });
    assert.equal(foreignReport.ok, false);
    assert.equal(check(foreignReport, 'store.identity')?.status, 'fail');

    const corrupt = join(root, 'corrupt.sqlite');
    await writeFile(corrupt, Buffer.from('this is not a sqlite database at all', 'utf8'));
    const corruptReport = await runDoctor({ storePath: corrupt, checkSdk: false });
    assert.equal(corruptReport.ok, false);
    assert.equal(check(corruptReport, 'store.integrity')?.status, 'fail');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker configuration problems are reported as failures, not hidden', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-doctor-worker-'));
  try {
    const report = await runDoctor({
      storePath: join(root, 'control.sqlite'),
      checkSdk: false,
      worker: {
        profile: 'worker',
        dshHome: join(root, 'missing-home'),
        workspace: join(root, 'missing-work'),
        runtimeBundleDigest: 'b'.repeat(64),
        mode: 'child-process',
        runnerPath: join(root, 'missing-runner.mjs'),
      },
    });
    assert.equal(report.ok, false);
    assert.equal(check(report, 'worker.dshHome')?.status, 'fail');
    assert.equal(check(report, 'worker.profile')?.status, 'fail');
    assert.equal(check(report, 'worker.runner')?.status, 'fail');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});