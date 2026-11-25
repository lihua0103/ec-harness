import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { ChildProcessWorkerExecutor } from '../src/child-worker.js';
import { PlatformError } from '../src/registry.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:child', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:child', kind: 'service' };

const RUNNER = `import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const job = JSON.parse(await readFile(process.argv[2], 'utf8'));
const mode = process.env.FAKE_CHILD_MODE ?? 'success';
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const result = (extra = {}) => ({ type: 'result', result: { sessionId: 's1', finalResponse: 'done', finishReason: 'completed', events: [], ...extra } });
if (mode === 'hang') {
  createInterface({ input: process.stdin }).on('line', (line) => {
    try { if (JSON.parse(line).type === 'cancel') process.exit(0); } catch {}
  });
  setInterval(() => {}, 1000);
} else if (mode === 'question') {
  emit({ type: 'question', request: { requestId: 'q1', sessionId: 's1', questions: [{ id: 'x', question: 'which dataset?' }] } });
  createInterface({ input: process.stdin }).once('line', async (line) => {
    const message = JSON.parse(line);
    await writeFile(join(job.workspace, 'out.txt'), 'answered');
    await writeFile(join(job.workspace, 'platform-result.json'), JSON.stringify({ status: 'succeeded', summary: 'answered:' + JSON.stringify(message.result), artifacts: [{ name: 'out.txt', path: 'out.txt' }] }));
    emit(result({ events: [
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'i1', content: [{ type: 'text', text: job.prompt }] }] } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    ] }));
    process.exit(0);
  });
} else {
  await writeFile(join(job.workspace, 'out.txt'), 'hello');
  await writeFile(join(job.workspace, 'platform-result.json'), JSON.stringify({ status: 'succeeded', summary: 'done', artifacts: [{ name: 'out.txt', path: 'out.txt', mediaType: 'text/plain' }] }));
  emit({ type: 'notification', notification: { method: 'session.event', params: { sessionId: 's1', event: { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'hello' }] } } } } } });
  emit(result({ events: [
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'i1', content: [{ type: 'text', text: job.prompt }] }] } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
  ] }));
  process.exit(0);
}
`;

const waitForTerminal = async (service: PlatformControlService, runId: string): Promise<string> => {
  for (let attempt = 0; attempt < 400; attempt++) {
    const state = service.getRun(runId, operator).snapshot.state;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not reach a terminal state');
};

const setup = async (mode: string) => {
  const root = await mkdtemp(join(tmpdir(), 'platform-child-'));
  const workspace = join(root, 'work');
  const dshHome = join(root, 'worker-home');
  await mkdir(workspace, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  const runnerPath = join(root, 'runner.mjs');
  await writeFile(runnerPath, RUNNER);
  process.env.FAKE_CHILD_MODE = mode;
  const service = new PlatformControlService(join(root, 'control.sqlite'), null, undefined, { requireArtifacts: true });
  service.setExecutor(new ChildProcessWorkerExecutor({
    profile: 'worker',
    dshHome,
    workspace,
    runtimeBundleDigest: 'b'.repeat(64),
    runnerPath,
    timeoutMs: 20_000,
    killTimeoutMs: 3000,
  }, {
    record: (launchId, proven) => service.recordExitEvidence(launchId, proven),
    read: (launchId) => service.readExitEvidence(launchId),
  }));
  service.registerApp(draft(), operator);
  return { root, service };
};

test('the child executor runs a real process, seals artifacts and records the process identity', async () => {
  const { root, service } = await setup('success');
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    const dispatched = await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    assert.equal(await waitForTerminal(service, run.runId), 'SUCCEEDED', service.getRun(run.runId, operator).snapshot.reason ?? '');
    const artifacts = service.artifacts(run.runId, operator);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].name, 'out.txt');
    assert.ok(artifacts[0].sealedAt);
    const attempts = service.attempts(run.runId, operator);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].processMode, 'child-process');
    assert.ok((attempts[0].pid ?? 0) > 0);
    assert.equal(attempts[0].state, 'SUCCEEDED');
    // Live notifications inside the child were projected, not duplicated by the final result.
    const activities = service.getRun(run.runId, operator).activities ?? [];
    assert.ok(activities.some((activity) => activity.text === 'hello'));
    assert.equal(service.readExitEvidence(dispatched.snapshot.launchId!), true);
  } finally {
    delete process.env.FAKE_CHILD_MODE;
    service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a child question round-trips through the platform inbox and back over stdio', async () => {
  const { root, service } = await setup('question');
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    let pending: ReturnType<typeof service.pendingInteractions> = [];
    for (let attempt = 0; attempt < 300; attempt++) {
      pending = service.pendingInteractions(operator).filter((item) => item.runId === run.runId);
      if (pending.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(pending.length, 1);
    const interaction = service.interactions(run.runId, operator).find((item) => item.state === 'PENDING');
    assert.ok(interaction);
    service.answerInteraction(interaction.interactionId, {
      answers: [{ id: 'x', selected: [], custom: 'DAPA-CKD' }],
    }, operator);
    assert.equal(await waitForTerminal(service, run.runId), 'SUCCEEDED');
    const result = service.getRun(run.runId, operator).result;
    assert.match(result?.finalResponse ?? '', /DAPA-CKD/);
  } finally {
    delete process.env.FAKE_CHILD_MODE;
    service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('cancel terminates the child process tree and only then settles as CANCELLED', async () => {
  const { root, service } = await setup('hang');
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    const dispatched = await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    const current = service.getRun(run.runId, operator);
    const cancelled = await service.cancelRun(run.runId, current.snapshot.revision, operator);
    assert.equal(cancelled.cancelSettled, true);
    assert.equal(await waitForTerminal(service, run.runId), 'CANCELLED');
    const attempts = service.attempts(run.runId, operator);
    assert.equal(attempts.at(-1)?.state, 'CANCELLED');
    assert.equal(service.readExitEvidence(dispatched.snapshot.launchId!), true);
  } finally {
    delete process.env.FAKE_CHILD_MODE;
    service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a missing runner fails the launch instead of reporting success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-child-missing-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), null, undefined, { requireArtifacts: true });
  try {
    service.setExecutor(new ChildProcessWorkerExecutor({
      profile: 'worker',
      dshHome: root,
      workspace: root,
      runtimeBundleDigest: 'b'.repeat(64),
      runnerPath: join(root, 'does-not-exist.mjs'),
      killTimeoutMs: 1000,
    }, {
      record: (launchId, proven) => service.recordExitEvidence(launchId, proven),
      read: (launchId) => service.readExitEvidence(launchId),
    }));
    service.registerApp(draft(), operator);
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await assert.rejects(
      service.dispatchRun(run.runId, run.snapshot.revision, supervisor),
      (error: unknown) => error instanceof PlatformError && error.code === 'WORKER_RUNNER_MISSING',
    );
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'QUEUED');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});