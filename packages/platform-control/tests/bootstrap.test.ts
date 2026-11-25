/** WP2/WP4 regression: trusted knowledge tenant scope at Run creation, and the shared
 *  bootstrap that keeps the HTTP and Cordis entries identical on assembly, reconcile and
 *  scheduler semantics. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor, type RunLaunch } from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import { configureControlService, startControlRuntime } from '../src/bootstrap.js';
import { readSnapshot } from '../../platform-knowledge/src/snapshot-readonly.js';
import { KnowledgeService } from '../../platform-knowledge/src/index.js';
import type { Config } from '../src/config.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator = (orgId?: string, region?: string): Principal => ({
  actorId: 'session:bootstrap',
  kind: 'operator',
  ...(orgId !== undefined ? { orgId } : {}),
  ...(region !== undefined ? { region } : {}),
});
const serviceActor: Principal = { actorId: 'service:bootstrap', kind: 'service' };

const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

/** A synthetic draft that declares a knowledge domain, so Run creation must demand a scope. */
function knowledgeDraft(id = 'kn-app'): ReturnType<typeof draft> {
  const base = draft(id);
  return { ...base, descriptor: { ...base.descriptor, knowledgePluginId: 'kn-p' } };
}

class IdleExecutor implements RunExecutor {
  readonly kind = 'idle';
  async dispatch(input: { launchId?: string; fencingToken?: number }): Promise<RunLaunch> {
    return {
      launchId: input.launchId ?? 'launch-idle',
      fencingToken: input.fencingToken ?? 1,
      process: { pid: process.pid, identity: 'test-instance', mode: 'in-process' },
    };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

interface Ctx {
  root: string;
  knowledgePath: string;
  service: PlatformControlService;
  knowledge: KnowledgeService;
}

/** One knowledge store with one ACTIVE record per org (same plugin/project), and a control
 *  service whose knowledge wiring comes exclusively from the shared bootstrap. */
const setup = async (config: Config = {}, executor?: RunExecutor): Promise<Ctx> => {
  const root = await mkdtemp(join(tmpdir(), 'platform-bootstrap-'));
  const knowledgePath = join(root, 'platform', 'knowledge.sqlite');
  const knowledge = new KnowledgeService(knowledgePath);
  const base = (id: string) => ({
    knowledgeId: id, scope: 'plugin' as const, pluginId: 'kn-p', kind: 'technical_method' as const,
    title: '重复标记保留所有行', problemSignal: '标记被当作筛选', cause: '混淆行条件与标记',
    method: '按明确键标记每个重复成员', scenarios: ['review'], edc: [], topics: ['row-logic'],
    preconditions: ['p'], notApplicable: ['n'], counterexamples: ['c'], sources: ['s'],
    claims: ['narrow claim'],
  });
  const activate = async (id: string, orgId: string, region: string) => {
    const context = { pluginId: 'kn-p', projectId: 'SYN-001', orgId, region };
    const captured = knowledge.capture(context, base(id));
    knowledge.registerValidator('kn-p', {
      id: `suite-${orgId}`, version: '1', knowledgeIds: [id],
      coverage: [{ knowledgeId: id, candidateDigest: captured.contentDigest, claims: ['narrow claim'] }],
      cases: [
        { id: 'pos', group: 'positive', input: 1, expected: 1 },
        { id: 'neg', group: 'negative', input: 2, expected: 2 },
        { id: 'bnd', group: 'boundary', input: 3, expected: 3 },
      ],
      execute: async (_r, c) => c.input,
    });
    const receipt = await knowledge.validate(context, id, captured.revision, `suite-${orgId}`);
    assert.equal(receipt.state, 'ACTIVE');
  };
  await activate('acme.method', 'acme', 'eu');
  await activate('other.method', 'other', 'eu');
  const service = new PlatformControlService(join(root, 'control.sqlite'), executor ?? null);
  // The fixture store is always the wired knowledge store; binding only reads knowledge-declaring apps.
  configureControlService(service, { ...config, knowledgeStorePath: knowledgePath });
  service.registerApp(knowledgeDraft(), operator());
  service.setDefaultRelease('kn-app', '1.0.0', { expectedRevision: null }, operator());
  return { root, knowledgePath, service, knowledge };
};

const teardown = async (ctx: Ctx) => {
  ctx.service.close();
  ctx.knowledge.close();
  await rm(ctx.root, { recursive: true, force: true });
};

test('enterprise scope missing at run creation fails diagnosably instead of binding cross-tenant records', async () => {
  const ctx = await setup({ knowledgeScope: { mode: 'enterprise' } });
  try {
    const work = ctx.service.createWork(
      { projectId: 'SYN-001', appId: 'kn-app', appVersion: '1.0.0', title: 't' },
      operator(),
    );
    assert.throws(
      () => ctx.service.createWorkRun(work.workId, {}, operator()),
      isPlatformError('KNOWLEDGE_SCOPE_UNAVAILABLE'),
    );
  } finally {
    await teardown(ctx);
  }
});

test('a principal claiming another org than the deployment ceiling is refused as escalation', async () => {
  const ctx = await setup({ knowledgeScope: { mode: 'enterprise', orgId: 'acme', region: 'eu' } });
  try {
    const work = ctx.service.createWork(
      { projectId: 'SYN-001', appId: 'kn-app', appVersion: '1.0.0', title: 't' },
      operator(),
    );
    assert.throws(
      () => ctx.service.createWorkRun(work.workId, {}, operator('other')),
      isPlatformError('KNOWLEDGE_SCOPE_ESCALATION'),
    );
  } finally {
    await teardown(ctx);
  }
});

test('a trusted enterprise scope binds only its org/region records into the Run snapshot', async () => {
  const ctx = await setup({ knowledgeScope: { mode: 'enterprise', orgId: 'acme', region: 'eu' } });
  try {
    const work = ctx.service.createWork(
      { projectId: 'SYN-001', appId: 'kn-app', appVersion: '1.0.0', title: 't' },
      operator(),
    );
    const run = ctx.service.createWorkRun(work.workId, {}, operator());
    const bound = run.knowledge;
    assert.ok(bound, 'knowledge-declaring app must bind a snapshot');
    assert.equal(bound.orgId, 'acme');
    assert.equal(bound.region, 'eu');
    assert.equal(bound.total, 1, 'the other org record must be filtered out of the binding');
    assert.deepEqual(bound.records?.map((r) => r.knowledgeId), ['acme.method']);
    const expected = readSnapshot(ctx.knowledgePath, {
      pluginId: 'kn-p', projectId: 'SYN-001', orgId: 'acme', region: 'eu',
    });
    assert.equal(bound.snapshotDigest, expected?.snapshotDigest, 'binding digest must be recomputable from the store');
  } finally {
    await teardown(ctx);
  }
});

test('local mode keeps the explicit standalone binding without tenant claims', async () => {
  const ctx = await setup();
  try {
    const work = ctx.service.createWork(
      { projectId: 'SYN-001', appId: 'kn-app', appVersion: '1.0.0', title: 't' },
      operator('acme'),
    );
    const run = ctx.service.createWorkRun(work.workId, {}, operator('acme'));
    const bound = run.knowledge;
    assert.ok(bound);
    assert.equal(bound.orgId, undefined, 'local mode must not guess a tenant');
    assert.equal(bound.region, undefined);
    assert.equal(bound.total, 2, 'standalone mode sees the whole local store');
  } finally {
    await teardown(ctx);
  }
});

test('an app without a knowledge domain never demands the enterprise scope', async () => {
  const ctx = await setup({ knowledgeScope: { mode: 'enterprise' } });
  try {
    ctx.service.registerApp(draft('plain-app'), operator());
    ctx.service.setDefaultRelease('plain-app', '1.0.0', { expectedRevision: null }, operator());
    const work = ctx.service.createWork(
      { projectId: 'SYN-001', appId: 'plain-app', appVersion: '1.0.0', title: 't' },
      operator(),
    );
    const run = ctx.service.createWorkRun(work.workId, {}, operator());
    assert.equal(run.knowledge, undefined);
  } finally {
    await teardown(ctx);
  }
});

test('startup reconciliation completes without a scheduler, and a worker-less runtime starts zero loops', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-bootstrap-reconcile-'));
  const path = join(root, 'control.sqlite');
  try {
    let runId = '';
    {
      const service = new PlatformControlService(path, new IdleExecutor());
      service.registerApp(draft('plain2'), operator());
      const run = service.createRun('plain2', '1.0.0', {}, operator());
      await service.dispatchRun(run.runId, run.snapshot.revision, serviceActor);
      runId = run.runId;
      service.close();
    }
    const reopened = new PlatformControlService(path);
    try {
      const runtime = startControlRuntime(reopened, { reconcileOnStartup: true });
      try {
        assert.equal(runtime.schedulerStarted, false, 'worker-less config must start zero dispatch loops');
        assert.equal(reopened.getRun(runId, operator()).snapshot.state, 'UNKNOWN');
      } finally {
        runtime.stop();
      }
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a worker-configured runtime assembles its scheduler and stops it idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-bootstrap-sched-'));
  try {
    const config = {
      worker: {
        profile: 'test/profile',
        dshHome: root,
        workspace: root,
        runtimeBundleDigest: 'b'.repeat(64),
      },
      scheduler: { enabled: true, intervalMs: 3_600_000 },
    };
    const service = new PlatformControlService(join(root, 'control.sqlite'), null);
    try {
      const runtime = startControlRuntime(service, config);
      try {
        assert.equal(runtime.schedulerStarted, true);
      } finally {
        runtime.stop();
        runtime.stop();
      }
    } finally {
      service.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
