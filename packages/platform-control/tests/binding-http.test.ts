import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:binding-http', kind: 'operator', orgId: 'org-acme' };

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-binding-http-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'));
  service.registerApp(draft(), operator);
  const api = await startWorkbenchServer({ service, authenticate: () => operator });
  return { root, service, api };
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

const digest = 'c'.repeat(64);

test('domains register and list over HTTP without exposing secrets', async () => {
  const { root, service, api } = await setup();
  try {
    const created = await call(api, 'POST', '/api/domains', { kind: 'hosted', deploymentRef: 'dep-1', capabilities: ['listing'] });
    assert.equal(created.status, 201);
    assert.equal(created.body.kind, 'hosted');
    assert.equal(created.body.owner, 'org-acme');
    assert.equal(created.body.state, 'UNKNOWN');
    assert.ok(!('credential' in created.body));
    const listed = await call(api, 'GET', '/api/domains');
    assert.equal(listed.body.items.length, 1);
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('domain health updates through CAS and rejects a stale revision', async () => {
  const { root, service, api } = await setup();
  try {
    const domain = (await call(api, 'POST', '/api/domains', { kind: 'local' })).body;
    const healthy = await call(api, 'PUT', `/api/domains/${domain.domainId}/state`, { state: 'HEALTHY', expectedRevision: 1 });
    assert.equal(healthy.status, 200);
    assert.equal(healthy.body.state, 'HEALTHY');
    const stale = await call(api, 'PUT', `/api/domains/${domain.domainId}/state`, { state: 'DEGRADED', expectedRevision: 1 });
    assert.equal(stale.status, 409);
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a Work binds a native session and the binding is readable over HTTP', async () => {
  const { root, service, api } = await setup();
  try {
    const domain = (await call(api, 'POST', '/api/domains', { kind: 'local' })).body;
    const work = service.createWork({ projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '绑定工作' }, operator);
    const bound = await call(api, 'POST', `/api/works/${work.workId}/bindings`, {
      domainId: domain.domainId, sessionId: 'session-native-1', releaseDigest: digest, workspaceId: 'ws-1',
    });
    assert.equal(bound.status, 201);
    assert.equal(bound.body.relation, 'primary');
    const read = await call(api, 'GET', `/api/works/${work.workId}/binding`);
    assert.equal(read.body.binding.sessionId, 'session-native-1');
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a submission is recorded once and only for the bound session', async () => {
  const { root, service, api } = await setup();
  try {
    const domain = (await call(api, 'POST', '/api/domains', { kind: 'local' })).body;
    const work = service.createWork({ projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '提交工作' }, operator);
    await call(api, 'POST', `/api/works/${work.workId}/bindings`, {
      domainId: domain.domainId, sessionId: 'session-native-1', releaseDigest: digest,
    });
    const request = {
      workId: work.workId, domainId: domain.domainId, sessionId: 'session-native-1',
      requestId: 'req-http-1', submittedBy: operator.actorId, input: { text: 'go' },
    };
    const first = service.recordSubmission(request, operator);
    const second = service.recordSubmission(request, operator);
    assert.equal(second.submissionId, first.submissionId);
    const listed = await call(api, 'GET', `/api/works/${work.workId}/submissions`);
    assert.equal(listed.body.items.length, 1);
    // A different session for the same Work is refused (not bound).
    assert.throws(
      () => service.recordSubmission({ ...request, sessionId: 'session-other' }, operator),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SUBMISSION_SESSION_NOT_BOUND',
    );
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveWorkContext returns the bound session and refuses a deep link to another session', async () => {
  const { root, service, api } = await setup();
  try {
    const domain = (await call(api, 'POST', '/api/domains', { kind: 'local' })).body;
    const project = service.createProject({ name: '合成项目' }, operator);
    const work = service.createWork({ projectId: project.projectId, appId: 'listing', appVersion: '1.0.0', title: '上下文' }, operator);
    await call(api, 'POST', `/api/works/${work.workId}/bindings`, {
      domainId: domain.domainId, sessionId: 'session-context-1', releaseDigest: digest,
    });
    const context = await call(api, 'GET', `/api/works/${work.workId}/context`);
    assert.equal(context.status, 200);
    assert.equal(context.body.sessionId, 'session-context-1');
    assert.equal(context.body.domain.domainId, domain.domainId);
    assert.equal(context.body.project.projectId, project.projectId);
    // The same bound session resolves; a foreign session id is refused.
    const bound = await call(api, 'GET', `/api/works/${work.workId}/context?sessionId=session-context-1&domainId=${domain.domainId}`);
    assert.equal(bound.status, 200);
    const foreign = await call(api, 'GET', `/api/works/${work.workId}/context?sessionId=session-other&domainId=${domain.domainId}`);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.code, 'WORK_CONTEXT_NOT_BOUND');
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
