// 只读快照摘要（KA11）回归：与 KnowledgeService.snapshot 逐字节一致；只读不写入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { KnowledgeService, computeSnapshotDigest } from '../lib/index.js';

const PLUGIN = 't-plugin';
const ctx = { pluginId: PLUGIN, projectId: 'project-a' };

function draft(id = 'method-a', extra = {}) {
  return {
    knowledgeId: id, scope: 'plugin', pluginId: PLUGIN, kind: 'technical_method',
    title: '重复标记保留所有行', problemSignal: '标记被当作筛选', cause: '混淆行条件与标记',
    method: '按明确键标记每个重复成员', scenarios: ['review'], edc: [], topics: ['row-logic'],
    preconditions: ['p'], notApplicable: ['n'], counterexamples: ['c'], sources: ['s'], ...extra,
  };
}

test('computeSnapshotDigest matches the service snapshot byte for byte, without writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-readonly-'));
  const path = join(root, 'knowledge.sqlite');
  const service = new KnowledgeService(path);
  try {
    // 空库：0 条也是有效绑定
    const empty = computeSnapshotDigest(path, ctx);
    assert.equal(empty.total, 0);
    const emptySnapshot = service.snapshot(ctx, 'run-empty');
    assert.equal(empty.snapshotDigest, emptySnapshot.snapshotDigest);

    service.capture(ctx, draft());
    const candidateOnly = computeSnapshotDigest(path, ctx);
    assert.equal(candidateOnly.total, 0, 'CANDIDATE 不参与绑定');
    assert.equal(candidateOnly.snapshotDigest, service.snapshot(ctx, 'run-c').snapshotDigest);

    // 激活一条：需声明 claims 并由覆盖的套件激活
    const captured = service.capture(ctx, draft('activate-me', { claims: ['narrow claim'] }));
    service.registerValidator(PLUGIN, {
      id: 't-suite2', version: '1', knowledgeIds: ['activate-me'],
      coverage: [{ knowledgeId: 'activate-me', candidateDigest: captured.contentDigest, claims: ['narrow claim'] }],
      cases: [
        { id: 'pos', group: 'positive', input: 1, expected: 1 },
        { id: 'neg', group: 'negative', input: 2, expected: 2 },
        { id: 'bnd', group: 'boundary', input: 3, expected: 3 },
      ],
      execute: async (_r, c) => c.input,
    });
    const receipt = await service.validate(ctx, 'activate-me', captured.revision, 't-suite2');
    assert.equal(receipt.state, 'ACTIVE');
    const bound = computeSnapshotDigest(path, ctx);
    assert.equal(bound.total, 1);
    assert.equal(bound.snapshotDigest, service.snapshot(ctx, 'run-a').snapshotDigest, '摘要公式必须与服务端一致');

    // 新 CANDIDATE 修订不改变绑定（在途运行不漂移的读侧证明）
    service.capture(ctx, { ...draft('activate-me'), method: '未验证的新修订' }, 1);
    const after = computeSnapshotDigest(path, ctx);
    assert.equal(after.snapshotDigest, bound.snapshotDigest, '新候选不得改变 ACTIVE 快照');
    const mtime = statSync(path).mtimeMs;
    computeSnapshotDigest(path, ctx);
    assert.equal(statSync(path).mtimeMs, mtime, '只读打开不得触发写入（WAL mtime 不变）');
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeSnapshotDigest returns undefined for missing store or foreign schema', () => {
  assert.equal(computeSnapshotDigest(join(tmpdir(), 'pk-no-such-store.sqlite'), ctx), undefined);
});
