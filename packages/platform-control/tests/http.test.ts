import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PlatformControlService,
  type RunExecutor,
  type RunOutcome,
  type UserQuestionRequest,
  type UserQuestionResult,
} from '../src/service.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import { AuthorizationError, type Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:http-test', kind: 'operator' };

const catalogDraft = {
  catalogId: 'test.catalog',
  runtimeBundleDigest: 'b'.repeat(64),
  defaultSelectionId: 'model.flash',
  entries: [
    {
      selectionId: 'model.flash',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      displayName: 'DeepSeek-V4.1-Flash',
      adapter: 'dsh-llm-deepseek',
      enabled: true,
      verification: 'provider-declared',
      parameters: { maxTokens: true },
    },
  ],
};

const setup = async (options: { appDir?: string } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'platform-http-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'));
  service.registerApp(draft(), operator);
  service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
  service.registerModelCatalog(catalogDraft, operator);
  const api: RunningWorkbenchApi = await startWorkbenchServer({
    service,
    authenticate: () => operator,
    ...(options.appDir ? { appDir: options.appDir } : {}),
  });
  return { root, service, api };
};

const call = async (api: RunningWorkbenchApi, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${api.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
};

test('bootstrap returns apps, empty works, models and honest executor status', async () => {
  const { root, service, api } = await setup();
  try {
    const response = await call(api, 'GET', '/api/workbench');
    assert.equal(response.status, 200);
    assert.equal(response.body.apps.length, 1);
    assert.equal(response.body.works.total, 0);
    assert.equal(response.body.runs.total, 0);
    assert.equal(response.body.models.catalog.catalogId, 'test.catalog');
    assert.equal(response.body.models.catalog.entries[0].available, true);
    assert.equal(response.body.status.executor, 'not-configured');
    assert.equal(response.body.workspace, undefined);
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a Work and its Run are created through the API with a model snapshot', async () => {
  const { root, service, api } = await setup();
  try {
    const work = await call(api, 'POST', '/api/works', {
      projectId: 'SYN-001',
      appId: 'listing',
      appVersion: '1.0.0',
      title: '合成 HTTP 工作',
    });
    assert.equal(work.status, 201);
    assert.equal(work.body.state, 'ACTIVE');

    const run = await call(api, 'POST', `/api/works/${work.body.workId}/runs`, {
      input: { goal: 'synthetic' },
      modelSelectionId: 'model.flash',
      modelOptions: { maxTokens: 1024 },
    });
    assert.equal(run.status, 201);
    assert.equal(run.body.workId, work.body.workId);
    assert.equal(run.body.snapshot.state, 'QUEUED');
    assert.equal(run.body.model.selectionId, 'model.flash');
    assert.equal(run.body.input, undefined);

    const second = await call(api, 'POST', `/api/works/${work.body.workId}/runs`, { input: {} });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'WORK_ACTIVE_RUN_EXISTS');

    const bootstrap = await call(api, 'GET', '/api/workbench');
    assert.equal(bootstrap.body.works.total, 1);
    assert.equal(bootstrap.body.runs.total, 1);
    assert.equal(bootstrap.body.runs.items[0].model.model, 'deepseek-flash');
    assert.equal(bootstrap.body.runs.items[0].input, undefined);
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('runs can be read, appended to, cancelled and retried through the API', async () => {
  const { root, service, api } = await setup();
  try {
    const work = await call(api, 'POST', '/api/works', {
      projectId: 'SYN-001',
      appId: 'listing',
      appVersion: '1.0.0',
      title: 'HTTP 运行操作',
    });
    const run = await call(api, 'POST', `/api/works/${work.body.workId}/runs`, { input: { step: 1 } });
    const runId = run.body.runId;

    const appended = await call(api, 'POST', `/api/runs/${runId}/inputs`, { input: { step: 2 } });
    assert.equal(appended.status, 201);
    assert.equal(appended.body.sequence, 2);

    const inputs = await call(api, 'GET', `/api/runs/${runId}/inputs`);
    assert.equal(inputs.body.total, 2);

    const events = await call(api, 'GET', `/api/runs/${runId}/events`);
    assert.equal(events.status, 200);
    assert.equal(events.body.total, 0);

    const cancelled = await call(api, 'POST', `/api/runs/${runId}/cancel`, {
      expectedRevision: run.body.snapshot.revision,
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.record.snapshot.state, 'CANCELLED');

    const next = await call(api, 'POST', `/api/works/${work.body.workId}/runs`, { input: { step: 3 } });
    assert.equal(next.status, 201);
    assert.notEqual(next.body.runId, runId);
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('model preference is saved through the API and invalid selections are rejected', async () => {
  const { root, service, api } = await setup();
  try {
    const saved = await call(api, 'PUT', '/api/models/preference', { selectionId: 'model.flash' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.state, 'available');
    const models = await call(api, 'GET', '/api/models');
    assert.equal(models.body.preference.selectionId, 'model.flash');

    const unknown = await call(api, 'PUT', '/api/models/preference', { selectionId: 'model.missing' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'MODEL_SELECTION_UNKNOWN');

    const work = await call(api, 'POST', '/api/works', {
      projectId: 'SYN-001',
      appId: 'listing',
      appVersion: '1.0.0',
      title: '无效模型',
    });
    const badRun = await call(api, 'POST', `/api/works/${work.body.workId}/runs`, {
      input: {},
      modelSelectionId: 'model.missing',
    });
    assert.equal(badRun.status, 400);
    assert.equal(badRun.body.code, 'MODEL_SELECTION_UNKNOWN');
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('authentication failure and malformed requests fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-http-auth-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'));
  const api = await startWorkbenchServer({
    service,
    authenticate: () => {
      throw new AuthorizationError('PLATFORM_IDENTITY_INVALID');
    },
  });
  try {
    const denied = await call(api, 'GET', '/api/workbench');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.ok, false);
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }

  const second = await setup();
  try {
    const malformed = await fetch(`${second.api.url}/api/works`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(malformed.status, 400);
    const missing = await call(second.api, 'POST', `/api/runs/missing/cancel`, { expectedRevision: 1 });
    assert.equal(missing.status, 404);
  } finally {
    await second.api.close();
    second.service.close();
    await rm(second.root, { recursive: true, force: true });
  }
});

test('static assets are whitelisted inside the app directory only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-http-static-'));
  const appDir = join(root, 'app');
  await mkdir(join(appDir, 'src'), { recursive: true });
  await writeFile(join(appDir, 'index.html'), '<!doctype html><title>ok</title>');
  await writeFile(join(appDir, 'src', 'app.mjs'), 'export const ok = true;');
  await writeFile(join(root, 'secret.txt'), 'secret');
  const service = new PlatformControlService(join(root, 'control.sqlite'));
  const api = await startWorkbenchServer({ service, appDir, authenticate: () => operator });
  try {
    const index = await fetch(`${api.url}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    const module = await fetch(`${api.url}/src/app.mjs`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type') ?? '', /text\/javascript/);
    const traversal = await fetch(`${api.url}/..%2Fsecret.txt`);
    assert.equal(traversal.status, 404);
    const disallowed = await fetch(`${api.url}/src`);
    assert.equal(disallowed.status, 404);
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

const serviceActor: Principal = { actorId: 'service:supervisor', kind: 'service' };
class ArtifactExecutor implements RunExecutor {
  readonly kind = 'artifact';
  constructor(private readonly outcome: RunOutcome) {}
  async dispatch(input: { launchId?: string; fencingToken?: number }) {
    return {
      launchId: input.launchId ?? 'launch-artifact',
      fencingToken: input.fencingToken ?? 1,
      outcome: Promise.resolve(this.outcome),
    };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}
const waitTerminal = async (service: PlatformControlService, runId: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(service.getRun(runId, operator).snapshot.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not reach a terminal state');
};

test('sealed artifacts download through the API without exposing the seal path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-http-artifact-'));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'reports'), { recursive: true });
  const source = join(workspace, 'reports', 'output.txt');
  const bytes = Buffer.from('sealed artifact bytes');
  await writeFile(source, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const service = new PlatformControlService(
    join(root, 'control.sqlite'),
    new ArtifactExecutor({
      status: 'succeeded',
      exitProven: true,
      cleanedUp: true,
      descendantsDone: true,
      consumedThrough: 1,
      finishReason: 'completed',
      artifacts: [
        { name: 'reports/output.txt', digest, bytes: bytes.byteLength, mediaType: 'text/plain', sourcePath: source },
      ],
    }),
    undefined,
    { requireArtifacts: true },
  );
  try {
    service.registerApp(draft(), operator);
    const run = service.createRun('listing', '1.0.0', { synthetic: true }, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, serviceActor);
    await waitTerminal(service, run.runId);
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'SUCCEEDED');

    const api = await startWorkbenchServer({ service, authenticate: () => operator });
    try {
      const listed = await call(api, 'GET', `/api/runs/${run.runId}/artifacts`);
      assert.equal(listed.status, 200);
      assert.equal(listed.body.items[0].sealedPath, undefined);
      assert.ok(listed.body.items[0].sealedAt);

      const download = await fetch(`${api.url}/api/runs/${run.runId}/artifacts/reports/output.txt/download`);
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type'), 'text/plain');
      assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
      assert.equal(Buffer.from(await download.arrayBuffer()).toString(), bytes.toString());

      const missing = await fetch(`${api.url}/api/runs/${run.runId}/artifacts/reports/missing.txt/download`);
      assert.equal(missing.status, 404);

      await writeFile(source, 'changed after the worker stopped');
      const resealed = await fetch(`${api.url}/api/runs/${run.runId}/artifacts/reports/output.txt/download`);
      assert.equal(Buffer.from(await resealed.arrayBuffer()).toString(), bytes.toString());
    } finally {
      await api.close();
    }
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('run events stream replays durably from a cursor and survives reconnect', async () => {
  const { root, service, api } = await setup();
  try {
    const run = service.createRun('listing', '1.0.0', { goal: 'synthetic sse' }, operator);
    await service.cancelRun(run.runId, run.snapshot.revision, operator);
    const history = service.runEvents(run.runId, 0, 10, operator);
    assert.ok(history.total >= 1);
    const lastSequence = history.items[0].sequence;
    const controller = new AbortController();
    const response = await fetch(`${api.url}/api/runs/${run.runId}/events/stream?after=0`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = response.body;
    assert.ok(body);
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !/^id: /m.test(text)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    assert.match(text, new RegExp(`^id: ${lastSequence}$`, 'm'));
    assert.match(text, /"event"/);
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

class QuestionHttpExecutor implements RunExecutor {
  readonly kind = 'question-http';
  async dispatch(input: Parameters<RunExecutor['dispatch']>[0]) {
    const pending: Promise<UserQuestionResult> | undefined = input.onUserQuestion?.(
      {
        requestId: 'req-http',
        sessionId: 'session-http',
        questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] }],
      } satisfies UserQuestionRequest,
      { signal: new AbortController().signal },
    );
    const outcome = new Promise<RunOutcome>(() => undefined);
    void pending;
    return { launchId: input.launchId ?? 'launch-http', fencingToken: input.fencingToken ?? 1, outcome };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

test('user questions are answered through the API exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-http-question-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), new QuestionHttpExecutor(), undefined, {
    requireArtifacts: false,
  });
  try {
    service.registerApp(draft(), operator);
    const run = service.createRun('listing', '1.0.0', { goal: 'ask' }, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, serviceActor);
    let items: Array<{ interactionId: string; state: string }> = [];
    for (let attempt = 0; attempt < 100 && items.length === 0; attempt++) {
      items = service.interactions(run.runId, operator);
      if (!items.length) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(items.length, 1);
    const api = await startWorkbenchServer({ service, authenticate: () => operator });
    try {
      const listed = await call(api, 'GET', `/api/runs/${run.runId}/interactions`);
      assert.equal(listed.status, 200);
      assert.equal(listed.body.items[0].state, 'PENDING');
      assert.equal(listed.body.items[0].body.questions[0].id, 'q1');

      const answered = await call(api, 'POST', `/api/interactions/${items[0].interactionId}/answer`, {
        answer: { answers: [{ id: 'q1', selected: ['继续'] }] },
      });
      assert.equal(answered.status, 200);
      assert.equal(answered.body.state, 'ANSWERED');

      const duplicate = await call(api, 'POST', `/api/interactions/${items[0].interactionId}/answer`, {
        answer: { answers: [{ id: 'q1', selected: ['停止'] }] },
      });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.code, 'INTERACTION_NOT_PENDING');

      const missing = await call(api, 'POST', '/api/interactions/does-not-exist/answer', {
        answer: { answers: [{ id: 'q1', selected: ['继续'] }] },
      });
      assert.equal(missing.status, 404);
    } finally {
      await api.close();
    }
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
