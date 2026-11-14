import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { DshProfileExecutor, promptWasConsumed, workerPrompt, type WorkerConfig, type WorkerHarnessFactory } from '../src/worker.js';
import { draft } from './helpers.js';
import type { Principal } from '../src/policy.js';

const operator: Principal = { actorId: 'session:test', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:supervisor', kind: 'service' };
const consumedPromptEvents = (prompt: string) => [
  { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [
    { id: 'input-1', content: [{ type: 'text', text: prompt }] },
  ] } },
  { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
];

class ManifestHarnessFactory implements WorkerHarnessFactory {
  cancelled = 0;
  constructor(
    private readonly manifest: unknown,
    private readonly artifact = 'hello',
  ) {}
  async create(config: WorkerConfig, runId: string, _model?: unknown, hooks?: { workspace?: string }) {
    const workspace = hooks?.workspace ?? join(config.workspace, runId);
    return {
      run: async (prompt: string) => {
        await writeFile(join(workspace, 'out.txt'), this.artifact);
        await writeFile(join(workspace, 'platform-result.json'), JSON.stringify(this.manifest));
        return {
          sessionId: 'session-1', finalResponse: 'done', finishReason: 'completed',
          events: consumedPromptEvents(prompt),
        };
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
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(state)) return;
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
  const executor = new DshProfileExecutor(
    { profile: 'worker', dshHome, workspace, timeoutMs: 1000, runtimeBundleDigest: 'b'.repeat(64) },
    factory,
  );
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor, undefined, {
    requireArtifacts: true,
  });
  service.registerApp(draft(), operator);
  return { root, service };
};

test('inbox evidence requires exact prompt admission and claim, not cancellation or text', () => {
  assert.equal(promptWasConsumed(consumedPromptEvents('goal'), 'goal'), true);
  assert.equal(promptWasConsumed(undefined, 'goal'), false);
  assert.equal(promptWasConsumed(consumedPromptEvents('other'), 'goal'), false);
  const events = consumedPromptEvents('goal');
  assert.equal(promptWasConsumed(events.slice(0, 1), 'goal'), false);
  assert.equal(promptWasConsumed([events[0], { ...events[1], data: { ...events[1].data, outcome: 'canceled' } }], 'goal'), false);
  assert.equal(promptWasConsumed([events[1]], 'goal'), false);
});

test('duplicate and mismatched descendant notifications cannot balance into completion', async () => {
  const factory: WorkerHarnessFactory = {
    async create() {
      return {
        run: async (prompt, options) => {
          options?.onNotification?.({ method: 'subagent.started', params: { parentSessionId: 's', childSessionId: 'a' } });
          options?.onNotification?.({ method: 'subagent.finished', params: { parentSessionId: 's', childSessionId: 'b' } });
          return { sessionId: 's', finalResponse: 'done', finishReason: 'completed', events: consumedPromptEvents(prompt) };
        },
        close: async () => {},
      };
    },
  };
  const { root, service } = await setup(factory);
  try {
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    await waitForTerminal(service, run.runId);
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'UNKNOWN');
    assert.equal(service.getRun(run.runId, operator).snapshot.barrier.descendantsDone, false);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

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

test('a worker whose process exit cannot be proven never reaches a terminal success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-worker-closefail-'));
  const workspace = join(root, 'work');
  const dshHome = join(root, 'worker-home');
  await mkdir(workspace, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  const factory: WorkerHarnessFactory = {
    async create() {
      return {
        run: async () => ({ sessionId: 's', finalResponse: 'done' }),
        close: async () => {
          throw new Error('process did not exit');
        },
      };
    },
  };
  const executor = new DshProfileExecutor(
    { profile: 'worker', dshHome, workspace, runtimeBundleDigest: 'b'.repeat(64) },
    factory,
  );
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor, undefined, {
    requireArtifacts: false,
  });
  try {
    service.registerApp(draft(), operator);
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    await waitForTerminal(service, run.runId);
    const failed = service.getRun(run.runId, operator);
    assert.equal(failed.snapshot.state, 'UNKNOWN');
    assert.match(failed.snapshot.reason ?? '', /WORKER_EXIT_UNPROVEN/);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatch rejects a worker environment whose runtime bundle differs from the plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-worker-mismatch-'));
  const workspace = join(root, 'work');
  const dshHome = join(root, 'worker-home');
  await mkdir(workspace, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  const executor = new DshProfileExecutor(
    { profile: 'worker', dshHome, workspace, runtimeBundleDigest: 'c'.repeat(64) },
    new ManifestHarnessFactory({ status: 'succeeded', artifacts: [] }),
  );
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor);
  try {
    service.registerApp(draft(), operator);
    const run = service.createRun('listing', '1.0.0', {}, operator);
    await assert.rejects(
      service.dispatchRun(run.runId, run.snapshot.revision, supervisor),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'WORKER_RUNTIME_MISMATCH',
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cancel without proven exit evidence returns false (close-failure and unknown launch)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-worker-cancel-evidence-'));
  const workspace = join(root, 'work');
  const dshHome = join(root, 'worker-home');
  await mkdir(workspace, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  const factory: WorkerHarnessFactory = {
    async create() {
      return {
        run: async () => ({ sessionId: 's', finalResponse: 'done' }),
        close: async () => {
          throw new Error('process did not exit');
        },
      };
    },
  };
  const executor = new DshProfileExecutor(
    { profile: 'worker', dshHome, workspace, runtimeBundleDigest: 'b'.repeat(64) },
    factory,
  );
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor);
  try {
    service.registerApp(draft(), operator);
    const run = service.createRun('listing', '1.0.0', {}, operator);
    const bound = await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    const launchId = bound.snapshot.launchId!;
    // Let the outcome observe the failed close and record unproven exit evidence.
    await waitForTerminal(service, run.runId);
    assert.equal(await executor.cancel(launchId), false);
    // (b) a launch this instance never dispatched has no evidence either.
    assert.equal(await executor.cancel('worker-never-dispatched'), false);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('exit evidence is durable: a restarted executor settles cancel from launch_attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-worker-durable-evidence-'));
  const workspace = join(root, 'work');
  const dshHome = join(root, 'worker-home');
  await mkdir(workspace, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  const path = join(root, 'control.sqlite');
  const service = new PlatformControlService(path, null, undefined, { requireArtifacts: false });
  const evidence = {
    record: (id: string, proven: boolean) => service.recordExitEvidence(id, proven),
    read: (id: string) => service.readExitEvidence(id),
  };
  const config = { profile: 'worker', dshHome, workspace, runtimeBundleDigest: 'b'.repeat(64) };
  try {
    service.registerApp(draft(), operator);
    // Proven exit: a normal worker close records true and survives a new executor instance.
    const okExec = new DshProfileExecutor(
      config,
      new ManifestHarnessFactory({ status: 'succeeded', artifacts: [] }),
      evidence,
    );
    service.setExecutor(okExec);
    const okRun = service.createRun('listing', '1.0.0', {}, operator);
    const okBound = await service.dispatchRun(okRun.runId, okRun.snapshot.revision, supervisor);
    await waitForTerminal(service, okRun.runId);
    assert.equal(service.readExitEvidence(okBound.snapshot.launchId!), true);
    const restartedOk = new DshProfileExecutor(
      config,
      new ManifestHarnessFactory({ status: 'succeeded', artifacts: [] }),
      evidence,
    );
    assert.equal(await restartedOk.cancel(okBound.snapshot.launchId!), true);

    // Unproven exit: close failure records false; a restarted executor must not settle it.
    const badExec = new DshProfileExecutor(
      config,
      {
        async create() {
          return {
            run: async () => ({ sessionId: 's', finalResponse: 'done' }),
            close: async () => {
              throw new Error('no exit');
            },
          };
        },
      },
      evidence,
    );
    service.setExecutor(badExec);
    const badRun = service.createRun('listing', '1.0.0', {}, operator);
    const badBound = await service.dispatchRun(badRun.runId, badRun.snapshot.revision, supervisor);
    await waitForTerminal(service, badRun.runId);
    assert.equal(service.readExitEvidence(badBound.snapshot.launchId!), false);
    const restartedBad = new DshProfileExecutor(
      config,
      new ManifestHarnessFactory({ status: 'succeeded', artifacts: [] }),
      evidence,
    );
    assert.equal(await restartedBad.cancel(badBound.snapshot.launchId!), false);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

class RecordingHarnessFactory implements WorkerHarnessFactory {
  readonly seen: Array<{ provider?: string; model?: string }> = [];
  async create(_config: WorkerConfig, _runId: string, model?: import('../src/models.js').ModelConfigSnapshot | null) {
    this.seen.push({ provider: model?.provider, model: model?.model });
    return {
      run: async () => ({ sessionId: 'session-model', finalResponse: 'done' }),
      close: async () => {},
    };
  }
}
const modelEntry = {
  selectionId: 'model.flash',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  displayName: 'DeepSeek-V4.1-Flash',
  adapter: 'dsh-llm-deepseek',
  enabled: true,
  verification: 'provider-declared',
  parameters: { maxTokens: true },
};

test('the run model snapshot is passed to the worker harness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-worker-model-'));
  const workspace = join(root, 'work');
  const dshHome = join(root, 'worker-home');
  await mkdir(workspace, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  const factory = new RecordingHarnessFactory();
  const executor = new DshProfileExecutor(
    {
      profile: 'worker',
      dshHome,
      workspace,
      adapter: 'dsh-llm-deepseek',
      runtimeBundleDigest: 'b'.repeat(64),
    },
    factory,
  );
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor);
  try {
    service.registerApp(draft(), operator);
    service.registerModelCatalog(
      {
        catalogId: 'deployment.default',
        runtimeBundleDigest: 'b'.repeat(64),
        defaultSelectionId: 'model.flash',
        entries: [modelEntry],
      },
      operator,
    );
    const run = service.createRun('listing', '1.0.0', {}, operator, {
      modelSelectionId: 'model.flash',
      modelOptions: { maxTokens: 2048 },
    });
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    assert.deepEqual(factory.seen, [{ provider: 'deepseek-official', model: 'deepseek-flash' }]);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatch rejects a run model route implemented by a different worker adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-worker-model-mismatch-'));
  const workspace = join(root, 'work');
  const dshHome = join(root, 'worker-home');
  await mkdir(workspace, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  const executor = new DshProfileExecutor(
    {
      profile: 'worker',
      dshHome,
      workspace,
      adapter: 'dsh-llm-other',
      runtimeBundleDigest: 'b'.repeat(64),
    },
    new RecordingHarnessFactory(),
  );
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor);
  try {
    service.registerApp(draft(), operator);
    service.registerModelCatalog(
      {
        catalogId: 'deployment.default',
        runtimeBundleDigest: 'b'.repeat(64),
        defaultSelectionId: 'model.flash',
        entries: [modelEntry],
      },
      operator,
    );
    const run = service.createRun('listing', '1.0.0', {}, operator, { modelSelectionId: 'model.flash' });
    await assert.rejects(
      service.dispatchRun(run.runId, run.snapshot.revision, supervisor),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'WORKER_MODEL_ROUTE_MISMATCH',
    );
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'QUEUED');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a bound project workspace is the cwd and keeps this run artifacts inside it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-worker-bound-'));
  const projectDir = join(root, 'project');
  const workRoot = join(root, 'work');
  await mkdir(projectDir, { recursive: true });
  await mkdir(workRoot, { recursive: true });
  const seen: Array<{ cwd?: string; workspace?: string }> = [];
  const factory: WorkerHarnessFactory = {
    async create(_config, _runId, _model, hooks) {
      seen.push({ cwd: hooks?.cwd, workspace: hooks?.workspace });
      return {
        run: async (prompt: string) => {
          const target = hooks?.workspace ?? join(workRoot, 'missing');
          await mkdir(target, { recursive: true });
          await writeFile(join(target, 'out.txt'), 'hello');
          await writeFile(join(target, 'platform-result.json'), JSON.stringify({
            status: 'succeeded', summary: 'done',
            artifacts: [{ name: 'out.txt', path: 'out.txt', mediaType: 'text/plain' }],
          }));
          return {
            sessionId: 'session-bound', finalResponse: 'done', finishReason: 'completed',
            events: [
              ...consumedPromptEvents(prompt),
              // The initial route is recorded in request/header, not model/selection.
              { type: 'request/header', data: { header: { config: {
                provider: 'deepseek-official', model: 'deepseek-flash',
              } }, reason: 'initial' } },
            ],
          };
        },
        close: async () => {},
      };
    },
  };
  const executor = new DshProfileExecutor(
    { profile: 'worker', dshHome: join(root, 'home'), workspace: workRoot, timeoutMs: 1000, runtimeBundleDigest: 'b'.repeat(64) },
    factory,
  );
  await mkdir(join(root, 'home'), { recursive: true });
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor, undefined, { requireArtifacts: true });
  try {
    service.registerApp(draft(), operator);
    service.registerModelCatalog({
      catalogId: 'deployment.default', runtimeBundleDigest: 'b'.repeat(64),
      defaultSelectionId: 'model.flash', entries: [modelEntry],
    }, operator);
    const project = service.createProject({ name: '合成项目' }, operator);
    const workspace = await service.createWorkspace({ projectId: project.projectId, name: '空间', directory: projectDir }, operator);
    const work = service.createWork({
      projectId: project.projectId, workspaceId: workspace.workspaceId,
      appId: 'listing', appVersion: '1.0.0', title: '绑定空间', goal: '完整目标',
    }, operator);
    const run = service.createWorkRun(work.workId, { goal: '完整目标' }, operator, { modelSelectionId: 'model.flash' });
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    await waitForTerminal(service, run.runId);
    const finished = service.getRun(run.runId, operator);
    assert.equal(finished.snapshot.state, 'SUCCEEDED');
    const realProject = await realpath(projectDir);
    const expected = join(realProject, '.platform', 'runs', run.runId);
    assert.equal(seen[0]?.cwd, realProject);
    assert.equal(seen[0]?.workspace, expected);
    const artifacts = service.artifacts(run.runId, operator);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.name, 'out.txt');
    assert.ok(artifacts[0]?.sealedAt);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an operator can reconcile an UNKNOWN run and release its workspace for a new run', async () => {
  const factory: WorkerHarnessFactory = {
    async create() {
      return {
        run: () => new Promise(() => {}),
        close: async () => {},
      };
    },
  };
  const { root, service } = await setup(factory);
  const projectDir = join(root, 'project');
  await mkdir(projectDir, { recursive: true });
  try {
    const project = service.createProject({ name: '对账项目' }, operator);
    const workspace = await service.createWorkspace({
      projectId: project.projectId, name: '空间', directory: projectDir,
    }, operator);
    const work = service.createWork({
      projectId: project.projectId, workspaceId: workspace.workspaceId,
      appId: 'listing', appVersion: '1.0.0', title: '对账', goal: '目标',
    }, operator);
    const run = service.createWorkRun(work.workId, { goal: '目标' }, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    service.reconcileOrphans(supervisor);
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'UNKNOWN');
    await assert.rejects(
      Promise.resolve().then(() => service.createWorkRun(work.workId, { goal: '再次' }, operator)),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'WORK_ACTIVE_RUN_EXISTS',
    );
    const reconciled = service.reconcileUnknown(run.runId, operator);
    assert.equal(reconciled.snapshot.state, 'UNKNOWN');
    assert.ok(reconciled.reconciledAt);
    assert.equal(service.reconcileUnknown(run.runId, operator).reconciledAt, reconciled.reconciledAt);
    const next = service.createWorkRun(work.workId, { goal: '再次' }, operator);
    assert.notEqual(next.runId, run.runId);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the worker manifest contract names the artifact-name rule', () => {
  const text = workerPrompt(
    { appId: 'ec.listing', appVersion: '1.0.0', runId: 'r1', input: { goal: 'g' } } as never,
    { planDigest: 'p' } as never,
    '/tmp/ws',
  );
  assert.match(text, /name 是登记名/);
  assert.ok(text.includes('. _ / -'), 'the allowed character set is stated verbatim');
  assert.match(text, /name 不合规会使整次运行登记失败/);
});
