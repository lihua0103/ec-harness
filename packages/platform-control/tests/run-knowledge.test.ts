// KA11：Run 创建时绑定只读知识快照。绑定语义、无源缺省、在途不漂移与只读性。纯函数级断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor } from '../src/service.js';
import { draft } from './helpers.js';
import { computeSnapshotDigest, readSnapshot, KnowledgeService } from '../../platform-knowledge/src/index.js';
import type { Principal } from '../src/policy.js';

const operator: Principal = { actorId: 'session:knowledge-test', kind: 'operator' };

class NoopExecutor implements RunExecutor {
  readonly kind = 'noop';
  async dispatch() {
    return { launchId: 'launch-knowledge-1', fencingToken: 1 };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

test('run creation binds a read-only knowledge snapshot for apps declaring knowledgePluginId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-run-knowledge-'));
  const knowledgePath = join(root, 'knowledge.sqlite');
  const service = new PlatformControlService(join(root, 'control.sqlite'), new NoopExecutor());
  try {
    const release = draft('listing');
    release.descriptor.knowledgePluginId = 'dm-listing';
    service.registerApp(release, operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    // 知识库先存在（空库）：0 条也是有效绑定；库不存在则如实缺省。
    const bootstrap = new KnowledgeService(knowledgePath);
    bootstrap.close();
    service.setKnowledgeSnapshotSource((app, projectId) => {
      const pluginId = app.draft.descriptor.knowledgePluginId;
      if (!pluginId) return undefined;
      const snapshot = readSnapshot(knowledgePath, { pluginId, projectId });
      if (!snapshot) return undefined;
      return {
        snapshotDigest: snapshot.snapshotDigest,
        total: snapshot.total,
        pluginId,
        projectId,
        boundAt: new Date().toISOString(),
        records: snapshot.records.map((record) => ({ ...record })),
      };
    });
    const work = service.createWork({ projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '知识绑定' }, operator);
    const run = service.createWorkRun(work.workId, {}, operator);
    assert.ok(run.knowledge, '声明知识域的应用必须绑定快照（0 条也是有效绑定）');
    assert.equal(run.knowledge.pluginId, 'dm-listing');
    assert.equal(run.knowledge.projectId, 'SYN-001');
    assert.equal(run.knowledge.total, 0, '空知识库绑定为 0 条，不伪造');
    assert.deepEqual(run.knowledge.records, [], '空集合也是可重放的实际修订集合');

    // 运行详情与 Work 视图都暴露绑定（不泄露输入）
    assert.equal(service.getRun(run.runId, operator).knowledge?.snapshotDigest, run.knowledge.snapshotDigest);
    assert.ok(service.runsForWork(work.workId, 0, 10, operator).items[0].knowledge);

    // 知识更新后：旧 Run 的绑定不变（在途不漂移），新 Run 绑定新摘要
    const knowledge = new KnowledgeService(knowledgePath);
    try {
      const captured = knowledge.capture({ pluginId: 'dm-listing', projectId: 'SYN-001' }, {
        knowledgeId: 'dm-listing.run-bound', scope: 'project', pluginId: 'dm-listing', projectId: 'SYN-001',
        kind: 'scenario_method', title: '窄声明', problemSignal: 'p', cause: 'c', method: 'm',
        scenarios: [], edc: [], topics: [], preconditions: ['p'], notApplicable: ['n'],
        counterexamples: ['c'], sources: ['s'], claims: ['run-bound claim'],
      });
      knowledge.registerValidator('dm-listing', {
        id: 'run-bound-suite', version: '1', knowledgeIds: ['dm-listing.run-bound'],
        coverage: [{ knowledgeId: 'dm-listing.run-bound', candidateDigest: captured.contentDigest, claims: ['run-bound claim'] }],
        cases: [
          { id: 'pos', group: 'positive', input: 1, expected: 1 },
          { id: 'neg', group: 'negative', input: 2, expected: 2 },
          { id: 'bnd', group: 'boundary', input: 3, expected: 3 },
        ],
        execute: async (_r, c) => c.input,
      });
      const receipt = await knowledge.validate({ pluginId: 'dm-listing', projectId: 'SYN-001' }, 'dm-listing.run-bound', captured.revision, 'run-bound-suite');
      assert.equal(receipt.state, 'ACTIVE', '前置：窄声明候选已激活');
    } finally {
      knowledge.close();
    }
    const run2Work = service.createWork({ projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '知识绑定二' }, operator);
    const run2 = service.createWorkRun(run2Work.workId, {}, operator);
    assert.notEqual(run2.knowledge?.snapshotDigest, run.knowledge.snapshotDigest, '知识变化后新 Run 绑定新摘要');
    assert.equal(run2.knowledge?.records?.length, 1, '新 Run 带上实际修订集合');
    assert.equal(run2.knowledge?.records?.[0].knowledgeId, 'dm-listing.run-bound');
    assert.equal(service.getRun(run.runId, operator).knowledge?.snapshotDigest, run.knowledge.snapshotDigest);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('apps without knowledgePluginId and services without a source stay unbound, never guessed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-run-knowledge-none-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), new NoopExecutor());
  try {
    service.registerApp(draft('listing'), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    const work = service.createWork({ projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '无绑定' }, operator);
    const run = service.createWorkRun(work.workId, {}, operator);
    assert.equal(run.knowledge, undefined, '未声明知识域/未配置源时缺省，不伪造绑定');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the local snapshot source never writes the knowledge store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-run-knowledge-ro-'));
  const knowledgePath = join(root, 'knowledge.sqlite');
  const knowledge = new KnowledgeService(knowledgePath);
  knowledge.close();
  const before = statSync(knowledgePath).mtimeMs;
  const snapshot = computeSnapshotDigest(knowledgePath, { pluginId: 'dm-listing', projectId: 'SYN-001' });
  assert.ok(snapshot);
  assert.equal(statSync(knowledgePath).mtimeMs, before, '只读摘要不得触发知识库写入');
  await rm(root, { recursive: true, force: true });
});
