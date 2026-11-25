/** L3 LearningBinding：Run 创建时绑定发布指针与本人 ACTIVE 偏好的受限引用（只有键与修订、
 *  永不携带偏好正文）；服务不可用/无指针时如实缺省不伪造；发布撤回影响面可查（T06/T07）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import { configureControlService } from '../src/bootstrap.js';
import { KnowledgeService } from '../../platform-knowledge/src/index.js';
import type { Config } from '../src/config.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

const operator: Principal = { actorId: 'user:jia', kind: 'operator', orgId: 'acme', region: 'eu' };

/** A synthetic draft that declares a knowledge domain (same fixture shape as bootstrap.test). */
function knowledgeDraft(id = 'kn-app'): ReturnType<typeof draft> {
  const base = draft(id);
  return { ...base, descriptor: { ...base.descriptor, knowledgePluginId: 'kn-p' } };
}

interface Ctx {
  root: string;
  knowledgePath: string;
  service: PlatformControlService;
  knowledge: KnowledgeService;
}

const activate = (knowledge: KnowledgeService, id: string) => {
  const context = { pluginId: 'kn-p', projectId: 'SYN-001', orgId: 'acme', region: 'eu' };
  const captured = knowledge.capture(context, {
    knowledgeId: id, scope: 'plugin', pluginId: 'kn-p', kind: 'technical_method',
    title: '重复标记保留所有行', problemSignal: '标记被当作筛选', cause: '混淆行条件与标记',
    method: '按明确键标记每个重复成员', scenarios: ['review'], edc: [], topics: ['row-logic'],
    preconditions: ['p'], notApplicable: ['n'], counterexamples: ['c'], sources: ['s'],
    claims: ['narrow claim'],
  });
  knowledge.registerValidator('kn-p', {
    id: `suite-${id}`, version: '1', knowledgeIds: [id],
    coverage: [{ knowledgeId: id, candidateDigest: captured.contentDigest, claims: ['narrow claim'] }],
    cases: [
      { id: 'pos', group: 'positive', input: 1, expected: 1 },
      { id: 'neg', group: 'negative', input: 2, expected: 2 },
      { id: 'bnd', group: 'boundary', input: 3, expected: 3 },
    ],
    execute: async (_record, testCase) => testCase.input,
  });
  return knowledge.validate(context, id, captured.revision, `suite-${id}`);
};

const setup = async (config: Config = {}): Promise<Ctx> => {
  const root = await mkdtemp(join(tmpdir(), 'platform-binding-'));
  const knowledgePath = join(root, 'platform', 'knowledge.sqlite');
  const knowledge = new KnowledgeService(knowledgePath);
  await activate(knowledge, 'acme.method');
  const service = new PlatformControlService(join(root, 'control.sqlite'), null, undefined, { requireArtifacts: false });
  configureControlService(service, { ...config, knowledgeStorePath: knowledgePath });
  service.registerApp(knowledgeDraft(), operator);
  service.setDefaultRelease('kn-app', '1.0.0', { expectedRevision: null }, operator);
  return { root, knowledgePath, service, knowledge };
};

const teardown = async (ctx: Ctx) => {
  ctx.service.close();
  ctx.knowledge.close();
  await rm(ctx.root, { recursive: true, force: true });
};

/** 每次 Run 用独立 Work：同一 Work 同时最多一个非终态 Run（QUEUED 也算）。 */
const createRun = (ctx: Ctx) => {
  const work = ctx.service.createWork({ projectId: 'SYN-001', appId: 'kn-app', appVersion: '1.0.0', title: '绑定测试' }, operator);
  return ctx.service.createWorkRun(work.workId, {}, operator);
};

test('发布指针与偏好引用随 Run 冻结；引用不含偏好值（T06/T07 前半）', async () => {
  const ctx = await setup({ knowledgeScope: { mode: 'enterprise', orgId: 'acme', region: 'eu' } });
  try {
    // 发布前：Run 只绑快照，无发布引用（不伪造）
    const runBefore = createRun(ctx);
    assert.equal(runBefore.knowledge?.release, undefined);
    assert.equal(runBefore.knowledge?.preferences, undefined);
    // 本人保存 ACTIVE 偏好 + 发布 v1
    ctx.knowledge.preferencesSetMine(operator, {
      key: 'review.summaryOrder', value: 'exceptionsFirst', pluginId: 'kn-p', expectedRevision: 0,
    });
    const active = ctx.knowledge.get(
      { pluginId: 'kn-p', projectId: 'SYN-001', orgId: 'acme', region: 'eu' },
      'acme.method',
    );
    const published = ctx.knowledge.publishRelease(operator, {
      pluginId: 'kn-p', audience: 'org:acme',
      entries: [{ knowledgeId: 'acme.method', revision: active.revision }], expectedVersion: 0,
    });
    const run = createRun(ctx);
    assert.equal(run.knowledge?.release?.releaseId, published.release.releaseId);
    assert.equal(run.knowledge?.release?.version, 1);
    assert.deepEqual(run.knowledge?.preferences, [
      { key: 'review.summaryOrder', pluginKey: 'kn-p', revision: 1 },
    ], 'LearningBinding 只携带键与修订');
    // 共享运行记录不得暴露私有偏好正文：整个 JSON 里不存在偏好值字符串
    const serialized = JSON.stringify(run);
    assert.ok(!serialized.includes('exceptionsFirst'), '偏好值绝不出现在运行记录中');
    // 新发布 → 新 Run 绑定新版（指针引用切换），旧 Run 不漂移
    const republished = ctx.knowledge.publishRelease(operator, {
      pluginId: 'kn-p', audience: 'org:acme',
      entries: [{ knowledgeId: 'acme.method', revision: active.revision }], expectedVersion: 1,
    });
    const runAfter = createRun(ctx);
    assert.equal(runAfter.knowledge?.release?.releaseId, republished.release.releaseId);
    assert.equal(runBefore.knowledge?.release, undefined, '发布前启动的 Run 不回溯换版');
    // 撤回影响面：绑定该发布的 Run 可查（待复核清单）
    ctx.knowledge.withdrawRelease(operator, republished.release.releaseId, '关键退化');
    const impact = ctx.service.knowledgeReleaseImpact(operator, republished.release.releaseId);
    assert.deepEqual(impact.runs, [runAfter.runId]);
  } finally {
    await teardown(ctx);
  }
});

test('暂停的偏好不注入新 Run（T03 注入半边）；删除后同样不注入', async () => {
  const ctx = await setup({ knowledgeScope: { mode: 'enterprise', orgId: 'acme', region: 'eu' } });
  try {
    ctx.knowledge.preferencesSetMine(operator, { key: 'output.locale', value: 'zh-CN', expectedRevision: 0 });
    assert.equal(createRun(ctx).knowledge?.preferences?.length, 1);
    ctx.knowledge.preferencesPauseMine(operator, 'output.locale');
    assert.equal(createRun(ctx).knowledge?.preferences, undefined, '暂停后不再注入');
    ctx.knowledge.preferencesDeleteMine(operator, 'output.locale');
    assert.equal(createRun(ctx).knowledge?.preferences, undefined, '删除后不再注入');
  } finally {
    await teardown(ctx);
  }
});

test('偏好服务缺失（本地模式无本人偏好）如实缺省：Run 照常创建、不伪造绑定', async () => {
  const ctx = await setup();
  try {
    const run = createRun(ctx);
    assert.ok(run.knowledge, '知识快照仍绑定（本地模式无租户列）');
    assert.equal(run.knowledge?.release, undefined, '无发布指针时不伪造');
    assert.equal(run.knowledge?.preferences, undefined, '无偏好时不伪造');
  } finally {
    await teardown(ctx);
  }
});

test('发布指针与偏好的解析是只读文件口：控制面从不写知识库', async () => {
  const ctx = await setup({ knowledgeScope: { mode: 'enterprise', orgId: 'acme', region: 'eu' } });
  try {
    const before = ctx.knowledge.checkSnapshotImpact(
      { pluginId: 'kn-p', projectId: 'SYN-001', orgId: 'acme', region: 'eu' },
      { records: [] },
    );
    createRun(ctx);
    const after = ctx.knowledge.checkSnapshotImpact(
      { pluginId: 'kn-p', projectId: 'SYN-001', orgId: 'acme', region: 'eu' },
      { records: [] },
    );
    assert.deepEqual(before, after, 'Run 创建不改变知识库状态（绑定走只读口）');
    // 未知发布的影响面是空清单，不是错误——掩蔽语义
    assert.deepEqual(ctx.service.knowledgeReleaseImpact(operator, 'release:unknown').runs, []);
  } finally {
    await teardown(ctx);
  }
});
