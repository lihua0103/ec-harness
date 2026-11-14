import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformApiError, WorkbenchApi as Api } from '../src/api.js';

const fakeFetch = (handler: (url: string, init?: unknown) => { status: number; body: unknown }) =>
  (async (url: string, init?: unknown) => {
    const { status, body } = handler(url, init);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  }) as never;

const validContext = {
  work: { workId: 'w1', title: '合成工作', state: 'ACTIVE', projectId: 'p1', appId: 'listing' },
  project: { projectId: 'p1', name: '合成项目' },
  workspace: { workspaceId: 'ws1', name: '空间', directory: '/work/study' },
  app: { appId: 'listing', appVersion: '1.0.0', releaseDigest: 'a'.repeat(64), displayName: 'Listing' },
  binding: null, domain: null, sessionId: null,
};

test('workContext validates the payload and forwards the deep-link query', async () => {
  let seen = '';
  const api = new Api('', fakeFetch((url) => {
    seen = url;
    return { status: 200, body: validContext };
  }));
  const context = await api.workContext('w1', { sessionId: 's1', domainId: 'd1' });
  assert.equal(context.work.workId, 'w1');
  assert.match(seen, /\/api\/works\/w1\/context\?sessionId=s1&domainId=d1/);
});

test('a non-2xx response surfaces the control plane code instead of "unknown"', async () => {
  const api = new Api('', fakeFetch(() => ({ status: 404, body: { code: 'WORK_CONTEXT_NOT_BOUND', detail: 'not bound' } })));
  await assert.rejects(
    () => api.workContext('w1'),
    (error: unknown) => error instanceof PlatformApiError && error.code === 'WORK_CONTEXT_NOT_BOUND' && error.status === 404,
  );
});

test('a malformed success body is refused, not shown as an empty workspace', async () => {
  const api = new Api('', fakeFetch(() => ({ status: 200, body: { work: null } })));
  await assert.rejects(() => api.workContext('w1'), /WORK_CONTEXT_INVALID/);
});

test('recordSubmission never carries a submitter field', async () => {
  let body: Record<string, unknown> | undefined;
  const api = new Api('', fakeFetch((_url, init) => {
    body = JSON.parse(String((init as { body: string }).body));
    return { status: 201, body: { submissionId: 'sub1' } };
  }));
  await api.recordSubmission({ workId: 'w1', domainId: 'd1', sessionId: 's1', requestId: 'r1', input: { text: 'go' } });
  assert.ok(body);
  assert.equal('submittedBy' in body, false);
});

test('the default fetch keeps its global receiver', async () => {
  const original = (globalThis as { fetch?: unknown }).fetch;
  let receiver: unknown;
  (globalThis as { fetch?: unknown }).fetch = function (this: unknown) {
    receiver = this;
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
  };
  try {
    const api = new Api();
    await api.bootstrap();
    assert.equal(receiver, globalThis);
  } finally {
    (globalThis as { fetch?: unknown }).fetch = original;
  }
});

test('work detail reads address the Work and page with explicit offset/limit', async () => {
  const seen: string[] = [];
  const api = new Api('', fakeFetch((url) => {
    seen.push(url);
    if (url.includes('/input-baselines')) {
      return { status: 200, body: { total: 2, items: [{ baselineId: 'b', workId: 'w 1', revision: 2 }] } };
    }
    if (url.includes('/artifacts')) return { status: 200, body: { items: [{ name: 'a.csv', digest: 'a'.repeat(64), bytes: 1 }] } };
    if (url.includes('/inputs')) return { status: 200, body: { total: 1, items: [{ commitId: 'c1', sequence: 1 }] } };
    return { status: 200, body: { total: 3, items: [{ runId: 'r1', workId: 'w 1' }] } };
  }));

  const runs = await api.workRuns('w 1', { offset: 10, limit: 10 });
  assert.equal(runs.total, 3);
  const baselines = await api.workInputBaselines('w 1', { offset: 0, limit: 5 });
  assert.equal(baselines.items[0].revision, 2);
  const artifacts = await api.runArtifacts('r/1');
  assert.equal(artifacts.items[0].name, 'a.csv');
  const inputs = await api.runInputs('r1', { offset: 20, limit: 10 });
  assert.equal(inputs.items[0].commitId, 'c1');

  assert.deepEqual(seen, [
    '/api/works/w%201/runs?offset=10&limit=10',
    '/api/works/w%201/input-baselines?offset=0&limit=5',
    '/api/runs/r%2F1/artifacts',
    '/api/runs/r1/inputs?offset=20&limit=10',
  ]);
});

test('the workbench writes address their exact enterprise resources', async () => {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const api = new Api('', fakeFetch((url, init) => {
    const request = init as { method?: string; body?: string } | undefined;
    calls.push({
      method: request?.method ?? 'GET',
      url,
      ...(request?.body ? { body: JSON.parse(request.body) as Record<string, unknown> } : {}),
    });
    return { status: 200, body: { ok: true, items: [], total: 0 } };
  }));

  await api.projectWorkspaces('p 1');
  await api.createWorkspace('p1', { name: '空间', directory: '/work/a' });
  await api.createWork({ projectId: 'p1', workspaceId: 'ws1', appId: 'listing', appVersion: '1.0.0', title: '标题' });
  await api.workDraft('w 1');
  await api.saveWorkDraft('w 1', '草稿', 3);
  await api.createRun('w 1', { input: { goal: '目标' }, modelSelectionId: 'm1' });
  await api.runInteractions('r 1');
  await api.answerInteraction('i 1', [{ id: 'q1', selected: ['A'] }]);
  await api.setModelPreference('m1');

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'GET /api/projects/p%201/workspaces',
    'POST /api/projects/p1/workspaces',
    'POST /api/works',
    'GET /api/works/w%201/draft',
    'PUT /api/works/w%201/draft',
    'POST /api/works/w%201/runs',
    'GET /api/runs/r%201/interactions',
    'POST /api/interactions/i%201/answer',
    'PUT /api/models/preference',
  ]);
  assert.deepEqual(calls[4].body, { text: '草稿', expectedRevision: 3 });
  assert.deepEqual(calls[5].body, { input: { goal: '目标' }, modelSelectionId: 'm1' });
  assert.deepEqual(calls[7].body, { answer: { answers: [{ id: 'q1', selected: ['A'] }] } });
  assert.deepEqual(calls[8].body, { selectionId: 'm1' });
});

test('a draft revision conflict keeps its 409 and control-plane code', async () => {
  const api = new Api('', fakeFetch(() => ({ status: 409, body: { code: 'WORK_DRAFT_REVISION_STALE', detail: 'stale' } })));
  await assert.rejects(
    () => api.saveWorkDraft('w1', 'x', 1),
    (error: unknown) => error instanceof PlatformApiError && error.status === 409 && error.code === 'WORK_DRAFT_REVISION_STALE',
  );
});

test('project creation, run operations and archiving address their enterprise resources', async () => {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const api = new Api('', fakeFetch((url, init) => {
    const request = init as { method?: string; body?: string } | undefined;
    calls.push({
      method: request?.method ?? 'GET',
      url,
      ...(request?.body ? { body: JSON.parse(request.body) as Record<string, unknown> } : {}),
    });
    return { status: 200, body: { ok: true } };
  }));

  await api.createProject({ name: '临床项目', code: 'SYN-01' });
  await api.createProject({ name: '无编号项目' });
  await api.archiveWork('w 1');
  await api.cancelRun('r 1', 7);
  await api.retryRun('r 1');
  await api.retryRun('r 1', 'm2');
  await api.reconcileRun('r 1');

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'POST /api/projects',
    'POST /api/projects',
    'POST /api/works/w%201/archive',
    'POST /api/runs/r%201/cancel',
    'POST /api/runs/r%201/retry',
    'POST /api/runs/r%201/retry',
    'POST /api/runs/r%201/reconcile',
  ]);
  assert.deepEqual(calls[0].body, { name: '临床项目', code: 'SYN-01' });
  assert.equal('code' in (calls[1].body ?? {}), false);
  assert.deepEqual(calls[3].body, { expectedRevision: 7 });
  assert.equal('modelSelectionId' in (calls[4].body ?? {}), false);
  assert.deepEqual(calls[5].body, { modelSelectionId: 'm2' });
});

test('a refused run operation keeps the control plane code instead of claiming success', async () => {
  const api = new Api('', fakeFetch(() => ({ status: 409, body: { code: 'RUN_TERMINAL', detail: 'SUCCEEDED' } })));
  await assert.rejects(
    () => api.cancelRun('r1', 3),
    (error: unknown) => error instanceof PlatformApiError && error.status === 409 && error.code === 'RUN_TERMINAL',
  );
  await assert.rejects(
    () => api.retryRun('r1'),
    (error: unknown) => error instanceof PlatformApiError && error.status === 409 && error.code === 'RUN_TERMINAL',
  );
});

test('a project creation refusal keeps PROJECT_* / authorization codes', async () => {
  const api = new Api('', fakeFetch(() => ({ status: 403, body: { code: 'PLATFORM_AUTHORIZATION_DENIED', detail: 'project.create' } })));
  await assert.rejects(
    () => api.createProject({ name: 'x' }),
    (error: unknown) => error instanceof PlatformApiError && error.status === 403 && error.code === 'PLATFORM_AUTHORIZATION_DENIED',
  );
});




test('listWorks forwards explicit paging so a large catalogue is not silently truncated', async () => {
  const seen: string[] = [];
  const api = new Api('', fakeFetch((url) => {
    seen.push(url);
    return { status: 200, body: { total: 240, items: [] } };
  }));
  await api.listWorks();
  await api.listWorks('ARCHIVED');
  await api.listWorks(undefined, { offset: 100, limit: 100 });
  await api.listWorks('ACTIVE', { offset: 200, limit: 100 });
  assert.deepEqual(seen, [
    '/api/works',
    '/api/works?state=ARCHIVED',
    '/api/works?offset=100&limit=100',
    '/api/works?state=ACTIVE&offset=200&limit=100',
  ]);
});

test('domains and bindings use the control-plane paths and carry no client actor', async () => {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const api = new Api('', fakeFetch((url, init) => {
    calls.push({ url, ...(init && (init as { body?: string }).body ? { body: JSON.parse(String((init as { body: string }).body)) } : {}) });
    if (url === '/api/domains') return { status: 200, body: { items: [{ domainId: 'd1', kind: 'local', state: 'HEALTHY' }] } };
    if (url === '/api/works/w1/bindings') return { status: 201, body: { bindingId: 'b1', workId: 'w1', domainId: 'd1', sessionId: 's1', releaseDigest: 'a'.repeat(64), relation: 'primary', revision: 1 } };
    return { status: 201, body: { domainId: 'd2', kind: 'local', state: 'UNKNOWN' } };
  }));
  const listed = await api.domains();
  assert.equal(listed.items[0]?.domainId, 'd1');
  await api.createDomain({ kind: 'local' });
  const bound = await api.bindWorkSession('w1', {
    domainId: 'd1', sessionId: 's1', releaseDigest: 'a'.repeat(64), workspaceId: 'ws1',
  });
  assert.equal(bound.sessionId, 's1');
  assert.deepEqual(calls.map((call) => call.url), ['/api/domains', '/api/domains', '/api/works/w1/bindings']);
  assert.deepEqual(calls[1]?.body, { kind: 'local' });
  assert.equal('submittedBy' in (calls[2]?.body ?? {}), false);
  assert.equal('createdBy' in (calls[2]?.body ?? {}), false);
});
