import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { DshProfileExecutor, type WorkerConfig, type WorkerHarnessFactory } from '../src/worker.js';
import { draft } from './helpers.js';
import type { Principal } from '../src/policy.js';

const operator: Principal = { actorId: 'session:test', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:supervisor', kind: 'service' };

class ManifestHarnessFactory implements WorkerHarnessFactory {
  cancelled = 0;
  constructor(
    private readonly manifest: unknown,
    private readonly artifact = 'hello',
  ) {}
  async create(config: WorkerConfig, runId: string) {
    const workspace = join(config.workspace, runId);
    return {
      run: async () => {
        await writeFile(join(workspace, 'out.txt'), this.artifact);
        await writeFile(join(workspace, 'platform-result.json'), JSON.stringify(this.manifest));
        return { sessionId: 'session-1', finalResponse: 'done' };
      },
      close: async () => {},
    };
  }
}
class HangingHarnessFactory implements WorkerHarnessFactory {
  async create() {
    return {
      run: (_prompt: string, options?: { signal?: AbortSignal }) =>
        new Promise<{ sessionId: string; finalResponse: string }>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      close: async () => {},
    };
  }
}

const waitForTerminal = async (service: PlatformControlService, runId: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = service.getRun(runId, operator).snapshot.state;
    if (state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not reach a terminal state');
};

const setup = async (factory: WorkerHarnessFactory) => {
  const root = await mkdtemp(join(tmpdir(), 'platform-worker-'));
  const workspace = join(root, 'work');
  const dshHome = join(root, 'worker-home');
  await mkdir(workspace, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  const executor = new DshProfileExecutor({ profile: 'worker', dshHome, workspace, timeoutMs: 1000 }, factory);
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor, undefined, {
    requireArtifacts: true,
  });
  service.registerApp(draft(), operator);
  return { root, service };
};

test('DshProfileExecutor records the worker manifest artifacts through the control plane', async () => {
  const { root, service } = await setup(
    new ManifestHarnessFactory({
      status: 'succeeded',
      summary: 'listing complete',
      artifacts: [{ name: 'output/out.txt', path: 'out.txt', mediaType: 'text/plain' }],
    }),
  );
  try {
    const run = service.createRun('listing', '1.0.0', { goal: 'synthetic' }, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    await waitForTerminal(service, run.runId);
    const finished = service.getRun(run.runId, operator);
    assert.equal(finished.snapshot.state, 'SUCCEEDED');
    const artifacts = service.artifacts(run.runId, operator);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].name, 'output/out.txt');
    assert.equal(artifacts[0].bytes, 5);
    assert.match(artifacts[0].digest, /^[a-f0-9]{64}$/);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelling a running DSH worker settles only after the harness closes', async () => {
  const { root, service } = await setup(new HangingHarnessFactory());
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    const pending = service.cancelRun(run.runId, service.getRun(run.runId, operator).snapshot.revision, operator);
    const result = await pending;
    assert.equal(result.cancelSettled, true);
    assert.equal(result.record.snapshot.state, 'CANCELLED');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a manifest path outside the worker workspace fails the run', async () => {
  const { root, service } = await setup(
    new ManifestHarnessFactory({
      status: 'succeeded',
      artifacts: [{ name: 'escape', path: '../../escape.txt' }],
    }),
  );
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    await waitForTerminal(service, run.runId);
    const failed = service.getRun(run.runId, operator);
    assert.equal(failed.snapshot.state, 'FAILED');
    assert.match(
      failed.snapshot.reason ?? '',
      /WORKER_ARTIFACT_OUTSIDE_WORKSPACE|WORKER_ARTIFACT_INVALID|WORKER_RESULT_INVALID/,
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
