import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { backupControlStore, restoreBackup, verifyBackup } from '../src/backup.js';
import { PlatformError } from '../src/registry.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:backup', kind: 'operator' };

test('a backup verifies and restores the exact run history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-backup-'));
  try {
    const storePath = join(root, 'control.sqlite');
    const artifactsRoot = join(root, 'artifacts');
    await mkdir(artifactsRoot, { recursive: true });
    await writeFile(join(artifactsRoot, 'sealed.txt'), 'sealed bytes');

    const service = new PlatformControlService(storePath);
    service.registerApp(draft(), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    const project = service.createProject({ name: '备份项目' }, operator);
    const work = service.createWork(
      { projectId: project.projectId, appId: 'listing', appVersion: '1.0.0', title: '备份工作' },
      operator,
    );
    const run = service.createWorkRun(work.workId, { goal: 'restore me' }, operator);
    service.close();

    const backupDir = join(root, 'backup');
    const backup = await backupControlStore({ storePath, artifactsRoot, outDir: backupDir });
    assert.match(backup.manifest.store.digest, /^[a-f0-9]{64}$/);
    assert.equal(backup.manifest.artifacts?.files, 1);

    const verified = await verifyBackup(backupDir);
    assert.deepEqual(verified.problems, []);
    assert.equal(verified.ok, true);

    const restoredPath = join(root, 'restored', 'control.sqlite');
    await restoreBackup({
      backupDir,
      targetStorePath: restoredPath,
      targetArtifactsRoot: join(root, 'restored', 'artifacts'),
    });
    assert.equal(await readFile(join(root, 'restored', 'artifacts', 'sealed.txt'), 'utf8'), 'sealed bytes');

    const reopened = new PlatformControlService(restoredPath);
    try {
      const restoredRun = reopened.getRun(run.runId, operator);
      assert.equal(restoredRun.snapshot.state, 'QUEUED');
      assert.equal(restoredRun.workId, work.workId);
      assert.equal(reopened.listWorks(undefined, 0, 10, operator).total, 1);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a tampered artifact fails backup verification and blocks restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-backup-tamper-'));
  try {
    const storePath = join(root, 'control.sqlite');
    const artifactsRoot = join(root, 'artifacts');
    await mkdir(artifactsRoot, { recursive: true });
    await writeFile(join(artifactsRoot, 'sealed.txt'), 'original');
    const service = new PlatformControlService(storePath);
    service.registerApp(draft(), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    service.close();

    const backupDir = join(root, 'backup');
    await backupControlStore({ storePath, artifactsRoot, outDir: backupDir });
    await writeFile(join(backupDir, 'artifacts', 'sealed.txt'), 'tampered');

    const verified = await verifyBackup(backupDir);
    assert.equal(verified.ok, false);
    assert.ok(verified.problems.includes('ARTIFACT_DIGEST_MISMATCH'));
    await assert.rejects(
      restoreBackup({ backupDir, targetStorePath: join(root, 'restored.sqlite') }),
      (error: unknown) => error instanceof PlatformError && error.code === 'BACKUP_VERIFY_FAILED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing non-empty backup target is never overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-backup-existing-'));
  try {
    const storePath = join(root, 'control.sqlite');
    const service = new PlatformControlService(storePath);
    service.registerApp(draft(), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    service.close();
    const outDir = join(root, 'backup');
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'keep.txt'), 'do not delete');

    await assert.rejects(
      backupControlStore({ storePath, outDir }),
      (error: unknown) => error instanceof PlatformError && error.code === 'BACKUP_TARGET_NOT_EMPTY',
    );
    assert.equal(await readFile(join(outDir, 'keep.txt'), 'utf8'), 'do not delete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});