import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor, type RunOutcome } from '../src/service.js';
import { PlatformStore } from '../src/store.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:todos', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:todos', kind: 'service' };

class OutcomeExecutor implements RunExecutor {
  readonly kind = 'outcome';
  constructor(private readonly outcome: RunOutcome) {}
  async dispatch(input: { launchId?: string; fencingToken?: number }) {
    return {
      launchId: input.launchId ?? 'launch-todos',
      fencingToken: input.fencingToken ?? 1,
      outcome: Promise.resolve(this.outcome),
    };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

const waitFor = async (service: PlatformControlService, runId: string): Promise<string> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = service.getRun(runId, operator).snapshot.state;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not reach a terminal state');
};

/** Outcome carrying one real file so the control plane seals actual bytes. */
const succeededWithArtifacts = async (dir: string): Promise<RunOutcome> => {
  const artifacts = [] as NonNullable<RunOutcome['artifacts']>;
  const name = 'listing.xlsx';
  const content = 'A,G,nh,po';
  const sourcePath = join(dir, name);
  await writeFile(sourcePath, content);
  artifacts.push({
    name,
    digest: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    sourcePath,
  });
  return {
    status: 'succeeded',
    exitProven: true,
    cleanedUp: true,
    finishReason: 'completed',
    descendantsDone: true,
    consumedThrough: 1,
    artifacts,
  };
};

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-todos-'));
  const filesDir = join(root, 'worker-out');
  await mkdir(filesDir, { recursive: true });
  const service = new PlatformControlService(
    join(root, 'control.sqlite'),
    new OutcomeExecutor(await succeededWithArtifacts(filesDir)),
    undefined,
    { requireArtifacts: true },
  );
  service.registerApp(draft(), operator);
  const work = service.createWork(
    { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '统一待办工作' },
    operator,
  );
  const run = service.createWorkRun(work.workId, { goal: '产出交付物' }, operator);
  await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
  assert.equal(await waitFor(service, run.runId), 'SUCCEEDED');
  return { root, service, path: join(root, 'control.sqlite'), work, run };
};

/** The service owns its store privately; the test opens the same file to plant one pending
 *  question, exactly the record shape the runtime path writes (see submissions.test). */
const plantQuestion = (path: string, runId: string, interactionId: string, createdAt: string) => {
  const store = new PlatformStore(path);
  try {
    store.interactionInsert({
      interactionId,
      runId,
      sessionId: 'session-todo',
      requestId: `req-${interactionId}`,
      kind: 'user-question',
      body: { questions: [{ id: 'q1', question: '批次用哪一版？', options: [{ label: 'A' }, { label: 'B' }] }] },
      state: 'PENDING',
      createdAt,
    });
  } finally {
    store.close();
  }
};

test('the unified todo list aggregates three sources, each keeping its own kind and verb (E3-4)', async ({ }) => {
  const { root, service, path, work, run } = await setup();
  try {
    plantQuestion(path, run.runId, 'todo-question-1', '2026-11-18T00:00:01.000Z');
    const review = service.requestReview(run.runId, operator, '请复核');
    const pkg = service.sealDeliveryPackage(work.workId, { runId: run.runId }, operator);
    service.deliverDeliveryPackage(pkg.packageId, '已发项目组', pkg.revision, operator);

    const todos = service.pendingTodos(operator);
    assert.deepEqual(todos.map((item) => item.kind), ['question', 'review', 'delivery-receipt'], 'oldest first across kinds');
    const question = todos.find((item) => item.kind === 'question')!;
    assert.equal(question.id, 'todo-question-1');
    assert.equal(question.runId, run.runId);
    assert.equal(question.workId, work.workId);
    assert.match(question.summary, /1 个问题/);
    assert.match(question.resolveHint, /answer/);
    const reviewTodo = todos.find((item) => item.kind === 'review')!;
    assert.equal(reviewTodo.id, review.reviewId);
    assert.match(reviewTodo.summary, /session:todos/);
    assert.match(reviewTodo.resolveHint, /decision/);
    const receipt = todos.find((item) => item.kind === 'delivery-receipt')!;
    assert.equal(receipt.id, pkg.packageId);
    assert.match(receipt.summary, /等待接收/);
    assert.match(receipt.resolveHint, /acknowledge/);

    // Each kind disappears exactly when its own resolution act happens — never another kind's.
    service.recordReviewDecision(review.reviewId, 'APPROVED', '核对通过', review.revision, operator);
    assert.equal(service.pendingTodos(operator).some((item) => item.kind === 'review'), false);
    service.acknowledgeDeliveryPackage(pkg.packageId, undefined, service.getDeliveryPackage(pkg.packageId, operator).revision, operator);
    assert.equal(service.pendingTodos(operator).some((item) => item.kind === 'delivery-receipt'), false);

    // A question on a still-running run resolves by answering, and only that.
    const run2 = service.createWorkRun(work.workId, { goal: '继续提问' }, operator);
    plantQuestion(path, run2.runId, 'todo-question-2', '2026-11-18T00:01:00.000Z');
    assert.equal(service.pendingTodos(operator).filter((item) => item.kind === 'question').length, 2);
    service.answerInteraction('todo-question-2', { answers: [{ id: 'q1', selected: ['B'] }] }, operator);
    const remaining = service.pendingTodos(operator).filter((item) => item.kind === 'question');
    assert.deepEqual(remaining.map((item) => item.id), ['todo-question-1'], 'the answered question leaves the list; the untouched one stays');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/todos and the workbench bootstrap carry the unified list (E3-4)', async () => {
  const { root, service, path, work, run } = await setup();
  let api: RunningWorkbenchApi | undefined;
  try {
    plantQuestion(path, run.runId, 'todo-question-http', '2026-11-18T02:00:00.000Z');
    service.requestReview(run.runId, operator);
    api = await startWorkbenchServer({ service, authenticate: () => operator });

    const todos = await fetch(`${api.url}/api/todos`).then((res) => res.json()) as {
      items: Array<{ kind: string; id: string; workId: string | null; resolveHint: string }>;
    };
    assert.deepEqual(todos.items.map((item) => item.kind), ['question', 'review']);
    assert.ok(todos.items.every((item) => item.workId === work.workId));

    const bootstrap = await fetch(`${api.url}/api/workbench`).then((res) => res.json()) as {
      todos?: Array<{ kind: string }>;
    };
    assert.equal(bootstrap.todos?.length, 2);
  } finally {
    await api?.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
