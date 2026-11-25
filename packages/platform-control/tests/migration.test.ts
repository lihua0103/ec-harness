import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { summarizeBrowserStorage, summarizeControlStore, summarizeMigration } from '../src/migration.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:migration', kind: 'operator' };

const v4 = {
  version: 4,
  projects: [{ id: 'p1' }, { id: 'p2' }],
  works: [
    {
      id: 'w1', title: '旧工作', createdAt: '2026-11-01T00:00:00.000Z',
      inputs: [{ revision: 1 }, { revision: 2 }], messages: [{ role: 'user' }],
      readOnlyReason: '应用不可用',
    },
    {
      id: 'w2', title: '旧工作二', createdAt: '2026-11-02T00:00:00.000Z',
      inputs: [{ revision: 1 }], messages: [],
    },
  ],
  drafts: { 'p1:listing': {} },
  recovery: [{ id: 'REC1' }],
  preferences: { favorites: [], recent: [], defaultModelId: 'm' },
};

test('a v4 browser record is summarized without rewriting it', () => {
  const before = JSON.stringify(v4);
  const summary = summarizeBrowserStorage(JSON.stringify(v4));
  assert.deepEqual(summary, {
    kind: 'v4', projects: 2, works: 2, inputs: 3, messages: 1, drafts: 1,
    readOnlyWorks: 1, recovery: 1,
    earliest: '2026-11-01T00:00:00.000Z', latest: '2026-11-02T00:00:00.000Z',
  });
  assert.equal(JSON.stringify(v4), before);
});

test('a v3 record and a localStorage dump are both recognized', () => {
  const v3 = { version: 3, projects: [{ id: 'p1' }], tasks: [{ id: 't1', request: 'x', createdAt: '2026-11-03T00:00:00.000Z', status: 'stopped', messages: [] }], draft: {} };
  assert.equal(summarizeBrowserStorage(v3).kind, 'v3');
  assert.equal(summarizeBrowserStorage(v3).works, 1);
  assert.equal(summarizeBrowserStorage(v3).readOnlyWorks, 1);

  const dump = { 'emerald.dsh.platform.prototype.v4': JSON.stringify(v4), other: 'x' };
  assert.equal(summarizeBrowserStorage(dump).kind, 'v4');
  assert.equal(summarizeBrowserStorage(dump).works, 2);
  // The CLI passes the file's raw text, which is itself a JSON dump object.
  assert.equal(summarizeBrowserStorage(JSON.stringify(dump)).kind, 'v4');
});

test('an unrecognized or corrupt record is reported, not turned into zero works', () => {
  const unknown = summarizeBrowserStorage({ version: 9 });
  assert.equal(unknown.kind, 'unknown');
  assert.match(unknown.error ?? '', /v4 或 v3/);
  const corrupt = summarizeBrowserStorage('{not json');
  assert.equal(corrupt.kind, 'unknown');
  assert.equal(summarizeBrowserStorage(undefined).kind, 'none');
});

test('a missing control store is an empty deployment, not a migration failure', () => {
  const summary = summarizeControlStore(join(tmpdir(), `missing-${Date.now()}.sqlite`));
  assert.equal(summary.status, 'MISSING');
  assert.equal(summary.works.length, 0);
});

test('the control store is opened read-only and its work/run digest is stable across runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-migration-'));
  const storePath = join(root, 'control.sqlite');
  const service = new PlatformControlService(storePath);
  try {
    service.registerApp(draft(), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    service.createWork({ projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '迁移工作' }, operator);
    const first = summarizeControlStore(storePath);
    assert.equal(first.status, 'OK');
    assert.equal(first.counts.works, 1);
    assert.equal(first.works.length, 1);
    assert.equal(first.works[0]?.title, '迁移工作');
    assert.equal(first.unboundWorks, 1);
    const second = summarizeControlStore(storePath);
    assert.equal(second.digest, first.digest);
    // A read-only inventory cannot have changed the durable record.
    assert.equal(second.counts.works, first.counts.works);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a file that is not a SQLite database is UNREADABLE, never treated as empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-migration-bad-'));
  const bad = join(root, 'control.sqlite');
  await writeFile(bad, 'this is not a database');
  try {
    assert.equal(summarizeControlStore(bad).status, 'UNREADABLE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a dry-run report states what would migrate and what stays read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-migration-report-'));
  const storePath = join(root, 'control.sqlite');
  const service = new PlatformControlService(storePath);
  try {
    service.registerApp(draft(), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    service.createWork({ projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '待迁移' }, operator);
    const report = summarizeMigration({ storePath, browserStorage: JSON.stringify(v4), now: '2026-11-12T00:00:00.000Z' });
    assert.equal(report.dryRun, true);
    assert.equal(report.generatedAt, '2026-11-12T00:00:00.000Z');
    assert.equal(report.controlStore.status, 'OK');
    assert.equal(report.browserStorage.kind, 'v4');
    assert.ok(report.notes.some((note) => note.includes('未创建、更新或删除')));
    assert.ok(report.notes.some((note) => note.includes('只读展示')));
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('dry-run classifies each Work by verifiable Session, no Session, or unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-migration-decisions-'));
  const storePath = join(root, 'control.sqlite');
  const sessionsHome = join(root, 'sessions');
  await mkdir(join(sessionsHome, 'workspace-a', 'session-good'), { recursive: true });
  const service = new PlatformControlService(storePath);
  try {
    service.registerApp(draft(), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    const verified = service.createWork({ projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '可验证' }, operator);
    const unknown = service.createWork({ projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '未知会话' }, operator);
    const readOnly = service.createWork({ projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '无会话' }, operator);
    const domain = service.registerDomain({ owner: 'owner:session:migration', kind: 'local', capabilities: [] }, operator);
    const app = service.getApp('listing', '1.0.0', operator);
    service.bindWorkSession({ workId: verified.workId, domainId: domain.domainId, sessionId: 'session-good', releaseDigest: app.releaseDigest }, operator);
    service.bindWorkSession({ workId: unknown.workId, domainId: domain.domainId, sessionId: 'session-missing', releaseDigest: app.releaseDigest }, operator);

    const summary = summarizeControlStore(storePath, sessionsHome);
    assert.deepEqual(summary.decisions, { verifiedSession: 1, readOnly: 1, unknownSession: 1 });
    assert.equal(summary.works.find((work) => work.workId === verified.workId)?.decision, 'verified-session');
    assert.equal(summary.works.find((work) => work.workId === unknown.workId)?.decision, 'unknown-session');
    assert.equal(summary.works.find((work) => work.workId === readOnly.workId)?.decision, 'no-session-read-only');
    const report = summarizeMigration({ storePath, sessionsHome, now: '2026-11-12T00:00:00.000Z' });
    assert.ok(report.notes.some((note) => note.includes('可验证 Session 1')));
    assert.ok(report.notes.some((note) => note.includes('本轮不写迁移')));
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
