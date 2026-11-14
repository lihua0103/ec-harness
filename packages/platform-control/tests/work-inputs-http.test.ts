import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:input-http', kind: 'operator', orgId: 'org-acme' };
const digest = (char: string) => char.repeat(64);

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-work-inputs-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'));
  service.registerApp(draft(), operator);
  const api = await startWorkbenchServer({ service, authenticate: () => operator });
  const work = service.createWork(
    { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '输入批次工作' },
    operator,
  );
  return { root, service, api, work };
};

const call = async (api: RunningWorkbenchApi, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${api.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

test('a Work lists input batches newest first with an honest empty state', async () => {
  const { root, service, api, work } = await setup();
  try {
    const empty = await call(api, 'GET', `/api/works/${work.workId}/input-baselines`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { total: 0, items: [] });

    const first = await call(api, 'POST', `/api/works/${work.workId}/input-baselines`, {
      sourceRef: 'dir:/study/v1', digest: digest('a'),
    });
    const second = await call(api, 'POST', `/api/works/${work.workId}/input-baselines`, {
      sourceRef: 'dir:/study/v2', digest: digest('b'),
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.revision, 1);
    assert.equal(second.status, 201);
    assert.equal(second.body.revision, 2);
    assert.equal(second.body.createdBy, operator.actorId);

    const page = await call(api, 'GET', `/api/works/${work.workId}/input-baselines?offset=0&limit=1`);
    assert.equal(page.body.total, 2);
    assert.equal(page.body.items.length, 1);
    assert.equal(page.body.items[0].revision, 2);

    const older = await call(api, 'GET', `/api/works/${work.workId}/input-baselines?offset=1&limit=1`);
    assert.equal(older.body.items[0].revision, 1);
    assert.equal(older.body.items[0].digest, digest('a'));
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an invalid batch is refused and an unknown or archived Work is reported', async () => {
  const { root, service, api, work } = await setup();
  try {
    const invalid = await call(api, 'POST', `/api/works/${work.workId}/input-baselines`, {
      sourceRef: 'dir:/study', digest: 'not-a-digest',
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'INPUT_BASELINE_INVALID');

    const missing = await call(api, 'GET', '/api/works/work-missing/input-baselines');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'WORK_NOT_FOUND');

    service.archiveWork(work.workId, operator);
    const archived = await call(api, 'POST', `/api/works/${work.workId}/input-baselines`, {
      sourceRef: 'dir:/study', digest: digest('c'),
    });
    assert.equal(archived.status, 409);
    assert.equal(archived.body.code, 'WORK_ARCHIVED');
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a service principal cannot append input batches for an operator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-work-inputs-denied-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'));
  try {
    service.registerApp(draft(), operator);
    const work = service.createWork(
      { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '越权输入' },
      operator,
    );
    const servicePrincipal: Principal = { actorId: 'service:worker', kind: 'service' };
    assert.throws(
      () => service.appendInputBaseline(work.workId, { sourceRef: 'dir:/x', digest: digest('d') }, servicePrincipal),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PLATFORM_AUTHORIZATION_DENIED',
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
