/** WP1 regression: installed artifact bytes re-verify at consumption time — in the worker
 *  entrances before any business input is consumed, and in the doctor's startup precheck. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { DshProfileExecutor, type WorkerConfig, type WorkerHarnessFactory } from '../src/worker.js';
import { runDoctor } from '../src/doctor.js';
import { directoryDigest } from '../src/release-manifest.js';
import { draft, provider } from './helpers.js';
import type { Principal } from '../src/policy.js';

const operator: Principal = { actorId: 'session:artifact', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:artifact', kind: 'service' };

const consumedPromptEvents = (prompt: string) => [
  { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [
    { id: 'input-1', content: [{ type: 'text', text: prompt }] },
  ] } },
  { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
];

class OkHarnessFactory implements WorkerHarnessFactory {
  async create(config: WorkerConfig, runId: string) {
    const workspace = join(config.workspace, runId);
    return {
      run: async (prompt: string) => {
        await writeFile(join(workspace, 'out.txt'), 'artifact');
        await writeFile(join(workspace, 'platform-result.json'), JSON.stringify({ status: 'succeeded', artifacts: [] }));
        return { sessionId: 'session-1', finalResponse: 'done', finishReason: 'completed', events: consumedPromptEvents(prompt) };
      },
      close: async () => {},
    };
  }
}

const waitForTerminal = async (service: PlatformControlService, runId: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = service.getRun(runId, operator).snapshot.state;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(state)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not reach a terminal state');
};

interface Env {
  root: string;
  libDir: string;
  config: (overrides?: Partial<WorkerConfig>) => WorkerConfig;
  service: PlatformControlService;
}

/** One installed artifact directory whose digest matches a registered app release. */
const setup = async (executorConfig: (libDir: string) => WorkerConfig): Promise<Env> => {
  const root = await mkdtemp(join(tmpdir(), 'platform-artifact-'));
  const libDir = join(root, 'installed', 'plugin-listing', 'lib');
  await mkdir(libDir, { recursive: true });
  await writeFile(join(libDir, 'index.js'), 'module.exports = 1;\n');
  const artifactDigest = directoryDigest(libDir);
  const base = draft();
  const registered = {
    ...base,
    providers: [{ ...provider('listing', '1.0.0'), artifactDigest }],
  };
  const config = executorConfig(libDir);
  const executor = new DshProfileExecutor(config, new OkHarnessFactory());
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor, undefined, {
    requireArtifacts: false,
  });
  service.registerApp(registered, operator);
  service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
  return { root, libDir, config: () => config, service };
};

test('dispatch with a tampered install refuses the launch before consuming input', async () => {
  const env = await setup((libDir) => ({
    profile: 'worker', dshHome: join(tmpdir(), 'artifact-home'), workspace: libDir,
    runtimeBundleDigest: 'b'.repeat(64),
    pluginArtifactPaths: { 'plugin-listing': libDir },
  }));
  try {
    // Tamper AFTER registration: the approved digest no longer matches the installed bytes.
    await writeFile(join(env.libDir, 'index.js'), 'module.exports = 2;\n');
    const run = env.service.createRun('listing', '1.0.0', { goal: 'business input' }, operator);
    await assert.rejects(
      env.service.dispatchRun(run.runId, run.snapshot.revision, supervisor),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'WORKER_ARTIFACT_MISMATCH',
    );
    const attempts = env.service.attempts(run.runId, operator);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].state, 'FAILED', 'the refusal must land on the launch attempt');
    assert.match(attempts[0].detail ?? '', /plan=.* installed=/);
    const inputs = env.service.inputs(run.runId, 0, 20, operator);
    assert.equal(inputs.total, 1, 'the frozen input is registered at creation');
    assert.equal(inputs.items[0].state, 'PENDING', 'the refusal must leave the input unconsumed');
  } finally {
    env.service.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test('dispatch with a missing install directory reports the artifact as missing', async () => {
  const env = await setup((libDir) => ({
    profile: 'worker', dshHome: join(tmpdir(), 'artifact-home'), workspace: libDir,
    runtimeBundleDigest: 'b'.repeat(64),
    pluginArtifactPaths: { 'plugin-listing': join(libDir, '..', 'not-installed') },
  }));
  try {
    const run = env.service.createRun('listing', '1.0.0', {}, operator);
    await assert.rejects(
      env.service.dispatchRun(run.runId, run.snapshot.revision, supervisor),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'WORKER_ARTIFACT_MISSING',
    );
    assert.match(env.service.attempts(run.runId, operator)[0].detail ?? '', /not-installed/);
  } finally {
    env.service.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test('a matching install runs normally and undeclared plugins keep prior behavior', async () => {
  const env = await setup((libDir) => ({
    profile: 'worker', dshHome: join(tmpdir(), 'artifact-home'), workspace: join(tmpdir(), `artifact-ws-${Date.now()}`),
    runtimeBundleDigest: 'b'.repeat(64),
    pluginArtifactPaths: { 'plugin-listing': libDir, 'plugin-other': join(tmpdir(), 'declared-but-unrelated') },
  }));
  try {
    const run = env.service.createRun('listing', '1.0.0', {}, operator);
    await env.service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    await waitForTerminal(env.service, run.runId);
    const record = env.service.getRun(run.runId, operator);
    assert.equal(record.snapshot.state, 'SUCCEEDED', record.snapshot.reason ?? 'no reason recorded');
  } finally {
    env.service.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test('doctor precheck verifies installed bytes against the approved plan in the store', async () => {
  const env = await setup((libDir) => ({
    profile: 'worker', dshHome: join(tmpdir(), 'artifact-home'), workspace: libDir,
    runtimeBundleDigest: 'b'.repeat(64),
    pluginArtifactPaths: { 'plugin-listing': libDir },
  }));
  try {
    const storePath = join(env.root, 'control.sqlite');
    // Fresh install matches the approved plan.
    const ok = await runDoctor({ storePath, worker: env.config(), checkSdk: false });
    const okCheck = ok.checks.find((check) => check.name === 'worker.artifacts');
    assert.ok(okCheck);
    assert.equal(okCheck.status, 'ok');

    // Tamper with the install: the precheck must fail with the same evidence the worker uses.
    await writeFile(join(env.libDir, 'index.js'), 'module.exports = 3;\n');
    const bad = await runDoctor({ storePath, worker: env.config(), checkSdk: false });
    const badCheck = bad.checks.find((check) => check.name === 'worker.artifacts');
    assert.ok(badCheck);
    assert.equal(badCheck.status, 'fail');
    assert.match(badCheck.detail, /plan=/);
    assert.match(badCheck.detail, /installed=/);
  } finally {
    env.service.close();
    await rm(env.root, { recursive: true, force: true });
  }
});
