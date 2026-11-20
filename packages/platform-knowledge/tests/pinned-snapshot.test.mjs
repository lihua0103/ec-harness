// M1-02：快照实际消费。Run 绑定固定修订集合：升级不漂移、撤回/撤权失败关闭、摘要可重算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService, readSnapshot } from '../lib/index.js';

const ctx = { pluginId: 'p', projectId: 'proj-a', orgId: 'org-a' };
const draft = (id, method) => ({
  knowledgeId: id, scope: 'project', pluginId: 'p', projectId: 'proj-a', orgId: 'org-a', kind: 'scenario_method',
  title: '快照方法', problemSignal: 'p', cause: 'c', method,
  scenarios: [], edc: [], topics: ['pin'], preconditions: ['p'], notApplicable: ['n'],
  counterexamples: ['c'], sources: ['s'], claims: ['claim-a'],
});
const suiteFor = (knowledgeId, candidateDigest) => ({
  id: 'pin-suite',
  version: '1.0.0',
  knowledgeIds: [knowledgeId],
  cases: [
    { id: 'pos', group: 'positive', input: 1, expected: 1 },
    { id: 'neg', group: 'negative', input: 2, expected: 2 },
    { id: 'bnd', group: 'boundary', input: 3, expected: 3 },
  ],
  execute: async (_record, testCase) => testCase.input,
  coverage: [{ knowledgeId, candidateDigest, claims: ['claim-a'] }],
});

const activate = async (service, id, method, expectedRevision = 0) => {
  const record = service.capture(ctx, draft(id, method), expectedRevision);
  const dispose = service.registerValidator('p', suiteFor(id, record.contentDigest));
  try {
    const receipt = await service.validate(ctx, id, record.revision, 'pin-suite');
    assert.equal(receipt.state, 'ACTIVE');
  } finally {
    dispose();
  }
  return record;
};

test('a bound snapshot replays its original revision after an upgrade and fails closed after revocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-pinned-'));
  const path = join(root, 'knowledge.sqlite');
  const service = new KnowledgeService(path);
  try {
    const first = await activate(service, 'pin.method', 'v1');
    const snapshotA = service.snapshot(ctx, 'run-a');
    assert.equal(snapshotA.records.length, 1);
    assert.equal(snapshotA.records[0].revision, 1);

    // Run B 之前升级知识：旧修订被替代，但 Run A 的固定集合不得漂移。
    await activate(service, 'pin.method', 'v2', first.revision);
    const live = service.search(ctx, { limit: 100 });
    assert.equal(live.items[0].revision, 2);
    const pinned = service.searchPinned(ctx, snapshotA, { limit: 100 });
    assert.equal(pinned.items.length, 1);
    assert.equal(pinned.items[0].revision, 1);
    assert.equal(pinned.items[0].state, 'SUPERSEDED');
    assert.equal(pinned.evidence.status, 'BOUND');
    assert.equal(pinned.evidence.snapshot.digest, snapshotA.snapshotDigest);

    // 只读快照摘要与服务端逐字节一致（含租户过滤）。
    const snapshotB = service.snapshot(ctx, 'run-b');
    const readonly = readSnapshot(path, ctx);
    assert.equal(readonly.snapshotDigest, snapshotB.snapshotDigest);
    assert.deepEqual(readonly.records, snapshotB.records);

    // 篡改记录必须被发现。
    const tampered = { ...snapshotA, records: [{ ...snapshotA.records[0], revision: 2 }] };
    assert.throws(() => service.searchPinned(ctx, tampered), /KNOWLEDGE_SNAPSHOT_INVALID/);

    // 撤回后原 Run 不再返回失效正文，但事实仍可追溯。
    service.setState(ctx, 'pin.method', 2, 'REVOKED', '测试撤回');
    const revoked = service.searchPinned(ctx, snapshotA, { limit: 100 });
    assert.equal(revoked.items.length, 0);
    assert.equal(revoked.evidence.status, 'DEGRADED');
    assert.deepEqual(revoked.evidence.excluded.map((entry) => entry.reason), ['REVOKED']);
    assert.ok(service.events(ctx, 'pin.method').items.some((event) => event.operation === 'REVOKED'));
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a snapshot bound to one tenant or project cannot be replayed under another', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-pinned-ctx-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    await activate(service, 'pin.ctx', 'v1');
    const snapshot = service.snapshot(ctx, 'run-ctx');
    assert.throws(
      () => service.searchPinned({ pluginId: 'p', projectId: 'proj-a' }, snapshot),
      /KNOWLEDGE_SNAPSHOT_CONTEXT_MISMATCH/,
    );
    assert.throws(
      () => service.searchPinned({ pluginId: 'p', projectId: 'proj-b', orgId: 'org-a' }, snapshot),
      /KNOWLEDGE_SNAPSHOT_CONTEXT_MISMATCH/,
    );
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});