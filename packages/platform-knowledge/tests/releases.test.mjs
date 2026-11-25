/** L3 发布清单（T06，开发设计 §4 KnowledgeRelease / §5 release.*）：
 *  发布前启动的 Run A 不漂移；发布后 Run B 绑定新版；撤回后新旧 Run 都不能重取失效正文；
 *  回滚只切仍获准清单、不复活撤回条目；expectedVersion CAS；不可变清单内容寻址；租户掩蔽。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, KnowledgeService } from '../lib/index.js';

const makeService = () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-release-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  return { root, service };
};

const context = (overrides = {}) => ({ pluginId: 'demo', projectId: 'P-1', orgId: 'acme', region: 'eu', ...overrides });
const manager = (overrides = {}) => ({ actorId: 'release:manager', orgId: 'acme', region: 'eu', ...overrides });

const baseDraft = (id) => ({
  knowledgeId: id, scope: 'plugin', pluginId: 'demo', kind: 'technical_method',
  title: `方法 ${id}`, problemSignal: '信号', cause: '原因', method: '方法',
  scenarios: [], edc: [], topics: [], preconditions: ['前提'], notApplicable: ['不适用'],
  counterexamples: ['反例'], sources: ['来源'], claims: [`claim ${id}`],
});

/** 激活一条记录（claims/coverage 合同；bootstrap.test 同款最小套件）。 */
const activate = async (service, id, overrides = {}) => {
  const draft = baseDraft(id);
  const captured = service.capture(context(overrides.context ?? {}), { ...draft, ...overrides.draft });
  service.registerValidator('demo', {
    id: `suite-${id}`, version: '1', knowledgeIds: [id],
    coverage: [{ knowledgeId: id, candidateDigest: captured.contentDigest, claims: draft.claims }],
    cases: [
      { id: 'pos', group: 'positive', input: 1, expected: 1 },
      { id: 'neg', group: 'negative', input: 2, expected: 2 },
      { id: 'bnd', group: 'boundary', input: 3, expected: 3 },
    ],
    execute: async (_record, testCase) => testCase.input,
  });
  return service.validate(context(overrides.context ?? {}), id, captured.revision, `suite-${id}`);
};

test('发布与指针：expectedVersion CAS、manifest 内容寻址不可变', async () => {
  const { root, service } = makeService();
  try {
    const receipt = await activate(service, 'demo.k1');
    assert.equal(receipt.state, 'ACTIVE');
    const first = service.publishRelease(manager(), {
      pluginId: 'demo', audience: 'org:acme', entries: [{ knowledgeId: 'demo.k1', revision: receipt.revision }],
      expectedVersion: 0,
    });
    assert.equal(first.pointer.version, 1);
    assert.equal(first.pointer.releaseId, first.release.releaseId);
    const recomputed = digest({
      schemaVersion: 1, pluginId: 'demo', orgId: 'acme', region: 'eu', audience: 'org:acme',
      entries: first.release.entries,
    });
    assert.equal(first.release.manifestDigest, recomputed, 'manifest 摘要由内容重算得出');
    assert.equal(service.releasePointerInfo(manager(), 'demo')?.version, 1);
    assert.throws(
      () => service.publishRelease(manager(), {
        pluginId: 'demo', audience: 'org:acme',
        entries: [{ knowledgeId: 'demo.k1', revision: receipt.revision }], expectedVersion: 0,
      }),
      /RELEASE_VERSION_STALE/,
      '过期指针版本拒绝',
    );
    assert.throws(
      () => service.publishRelease(manager(), {
        pluginId: 'demo', audience: 'org:acme', entries: [], expectedVersion: 1,
      }),
      /RELEASE_ENTRIES_INVALID/,
    );
    assert.throws(
      () => service.publishRelease(manager(), {
        pluginId: 'demo', audience: 'org:acme',
        entries: [{ knowledgeId: 'demo.k1', revision: 999 }], expectedVersion: 1,
      }),
      /RELEASE_ENTRY_NOT_ACTIVE/,
      '只能发布当前 ACTIVE 的修订',
    );
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('T06：发布前 Run A 不漂移；发布后 Run B 绑定新版', async () => {
  const { root, service } = makeService();
  try {
    const r1 = await activate(service, 'demo.k1');
    // 发布前：Run A 绑定活库快照（无指针语义）
    const runA = service.snapshot(context(), 'run-A');
    assert.deepEqual(runA.records.map((ref) => ref.knowledgeId), ['demo.k1']);
    const r2 = await activate(service, 'demo.k2');
    const first = service.publishRelease(manager(), {
      pluginId: 'demo', audience: 'org:acme', entries: [{ knowledgeId: 'demo.k1', revision: r1.revision }],
      expectedVersion: 0,
    });
    const runB1 = service.snapshot(context(), 'run-B1');
    assert.deepEqual(runB1.records.map((ref) => ref.knowledgeId), ['demo.k1'], '发布指针接管新 Run 的快照来源');
    const second = service.publishRelease(manager(), {
      pluginId: 'demo', audience: 'org:acme',
      entries: [
        { knowledgeId: 'demo.k1', revision: r1.revision },
        { knowledgeId: 'demo.k2', revision: r2.revision },
      ],
      expectedVersion: 1,
    });
    assert.equal(second.release.prevReleaseId, first.release.releaseId);
    const runB2 = service.snapshot(context(), 'run-B2');
    assert.equal(runB2.records.length, 2, '新 Run 绑定新版清单');
    // 同一旧 Run 不漂移：快照不可变（同 Run 同上下文重复取回原集合）
    const runA2 = service.readSnapshot(context(), 'run-A');
    assert.deepEqual(runA2.records, runA.records);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('T06：撤回后新旧 Run 都不能重取失效正文；新快照排除撤回条目', async () => {
  const { root, service } = makeService();
  try {
    const r1 = await activate(service, 'demo.k1');
    await activate(service, 'demo.k2');
    const first = service.publishRelease(manager(), {
      pluginId: 'demo', audience: 'org:acme', entries: [{ knowledgeId: 'demo.k1', revision: r1.revision }],
      expectedVersion: 0,
    });
    const runA = service.snapshot(context(), 'run-A');
    const second = service.publishRelease(manager(), {
      pluginId: 'demo', audience: 'org:acme',
      entries: [
        { knowledgeId: 'demo.k1', revision: r1.revision },
        { knowledgeId: 'demo.k2', revision: 1 },
      ],
      expectedVersion: 1,
    });
    const withdrawn = service.withdrawRelease(manager(), second.release.releaseId, '关键退化：误报上升');
    assert.equal(withdrawn.entries.length, 2);
    assert.equal(service.getRelease(manager(), second.release.releaseId).state, 'WITHDRAWN');
    // 旧 Run（v1 快照，含 k1@1）与撤回清单共享 (k1, rev1) → 固定集合检索也排除（不能重取失效正文）
    const pinnedA = service.searchPinned(context(), runA, {});
    assert.deepEqual(pinnedA.evidence.excluded.map((ref) => ref.reason), ['WITHDRAWN']);
    assert.equal(pinnedA.items.length, 0);
    // 新快照（指针仍在 v2）剔除撤回条目 → EMPTY（如实为空，不冒充可用）
    const runC = service.snapshot(context(), 'run-C');
    assert.equal(runC.records.length, 0);
    // 撤回重复执行冲突；跨租户撤回 404 掩蔽
    assert.throws(() => service.withdrawRelease(manager(), second.release.releaseId, 'again'), /RELEASE_ALREADY_WITHDRAWN/);
    assert.throws(
      () => service.withdrawRelease(manager({ orgId: 'other' }), first.release.releaseId, '越权'),
      /RELEASE_NOT_FOUND/,
    );
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('回滚只切仍获准清单；撤回条目不因回滚或重新发布复活', async () => {
  const { root, service } = makeService();
  try {
    const r1 = await activate(service, 'demo.k1');
    const r2 = await activate(service, 'demo.k2');
    const first = service.publishRelease(manager(), {
      pluginId: 'demo', audience: 'org:acme', entries: [{ knowledgeId: 'demo.k1', revision: r1.revision }],
      expectedVersion: 0,
    });
    const second = service.publishRelease(manager(), {
      pluginId: 'demo', audience: 'org:acme',
      entries: [{ knowledgeId: 'demo.k2', revision: r2.revision }], expectedVersion: 1,
    });
    service.withdrawRelease(manager(), second.release.releaseId, '关键退化');
    assert.throws(
      () => service.rollbackRelease(manager(), { pluginId: 'demo', expectedVersion: 0, reason: 'stale' }),
      /RELEASE_VERSION_STALE/,
    );
    const rolled = service.rollbackRelease(manager(), { pluginId: 'demo', expectedVersion: 2, reason: '回退到上一获准清单' });
    assert.equal(rolled.release.releaseId, first.release.releaseId);
    assert.equal(service.releasePointerInfo(manager(), 'demo')?.version, 3);
    // v1 里的 k1@1 从未被撤回 → 回滚后新快照重新可用（回滚不是撤回）
    const runD = service.snapshot(context(), 'run-D');
    assert.deepEqual(runD.records.map((ref) => ref.knowledgeId), ['demo.k1']);
    // 撤回过的 k2@1 即使再次入清单也不得复活
    service.publishRelease(manager(), {
      pluginId: 'demo', audience: 'org:acme', entries: [{ knowledgeId: 'demo.k2', revision: r2.revision }],
      expectedVersion: 3,
    });
    const runE = service.snapshot(context(), 'run-E');
    assert.equal(runE.records.length, 0, '撤回条目不因新清单复活');
    const pinnedE = service.searchPinned(context(), runE, {});
    assert.equal(pinnedE.evidence.status, 'EMPTY');
    // 回滚目标必须是仍获准（CURRENT）清单
    assert.throws(
      () => service.rollbackRelease(manager(), { pluginId: 'demo', expectedVersion: 4, toReleaseId: second.release.releaseId, reason: 'x' }),
      /RELEASE_ROLLBACK_TARGET_WITHDRAWN/,
    );
    assert.throws(
      () => service.rollbackRelease(manager(), { pluginId: 'demo', expectedVersion: 4, toReleaseId: 'release:missing', reason: 'x' }),
      /RELEASE_NOT_FOUND/,
    );
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('发布条目校验：插件不符、租户不符、重复条目拒绝；清单按租户掩蔽', async () => {
  const { root, service } = makeService();
  try {
    await activate(service, 'demo.k1');
    await activate(service, 'other.k1', { context: { pluginId: 'demo', projectId: 'P-1', orgId: 'other', region: 'eu' } });
    assert.throws(
      () => service.publishRelease(manager(), {
        pluginId: 'demo', audience: 'org:acme',
        entries: [
          { knowledgeId: 'demo.k1', revision: 1 },
          { knowledgeId: 'demo.k1', revision: 1 },
        ],
        expectedVersion: 0,
      }),
      /RELEASE_ENTRY_DUPLICATE/,
    );
    assert.throws(
      () => service.publishRelease(manager({ orgId: 'other' }), {
        pluginId: 'demo', audience: 'org:other',
        entries: [{ knowledgeId: 'demo.k1', revision: 1 }], expectedVersion: 0,
      }),
      /RELEASE_ENTRY_TENANT_MISMATCH/,
      '不能发布其他租户的记录',
    );
    assert.deepEqual(service.releasesList(manager({ orgId: 'other' }), { pluginId: 'demo' }), [], '清单按租户掩蔽');
    assert.equal(service.releasePointerInfo(manager({ orgId: 'other' }), 'demo'), undefined);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-10 发布指针不吞没 project 域：快照 = 清单 ∪ 当前项目 ACTIVE 条目', async () => {
  const { root, service } = makeService();
  try {
    // 一条 plugin 方法发布进清单
    const pluginReceipt = await activate(service, 'demo.plugin');
    // 一条 project 专属方法（仅 P-1 可见），不进入清单
    const projectReceipt = await activate(service, 'demo.proj', {
      draft: { scope: 'project', projectId: 'P-1' },
      context: { projectId: 'P-1' },
    });
    assert.equal(projectReceipt.state, 'ACTIVE');

    service.publishRelease(manager(), {
      pluginId: 'demo', audience: 'org:acme',
      entries: [{ knowledgeId: 'demo.plugin', revision: pluginReceipt.revision }],
      expectedVersion: 0,
    });

    // 发布后绑定：清单条目 + project 条目都在，project 方法不丢失
    const bound = service.snapshot(context(), 'run-union');
    const ids = bound.records.map((r) => r.knowledgeId).sort();
    assert.ok(ids.includes('demo.plugin'), '清单方法在绑定内');
    assert.ok(ids.includes('demo.proj'), 'P0-10：project 方法不随发布消失');
    assert.equal(bound.records.length, 2);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
