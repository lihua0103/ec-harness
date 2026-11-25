// KA12/13/14：运行事件候选、跨进程验证协议、快照影响查询。纯函数级断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KnowledgeService,
  createValidationRequest,
  createValidationReceipt,
  verifyValidationReceipt,
  caseSetDigest,
  validatorDigest,
  receiptDigest,
  bindRequestCandidate,
  canonical,
  digest,
} from '../lib/index.js';

const base = (id, extra = {}) => ({
  knowledgeId: id, scope: 'plugin', pluginId: 'p', kind: 'scenario_method',
  title: '重复标记保留所有行', problemSignal: '标记被当作筛选', cause: '混淆语义',
  method: '按明确键标记每个重复成员', scenarios: [], edc: [], topics: ['row-logic'],
  preconditions: ['p'], notApplicable: ['n'], counterexamples: ['c'], sources: ['s'], ...extra,
});

test('KA12: captureFromRunEvent binds runId/digests and requires trusted project context', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-run-event-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const ctx = { pluginId: 'p', projectId: 'SYN-1', orgId: 'acme' };
    const rec = service.captureFromRunEvent(
      ctx,
      { kind: 'qc.completed', runId: 'run-42', inputDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64) },
      base('event.method'),
    );
    assert.equal(rec.eventRef.kind, 'qc.completed');
    assert.equal(rec.eventRef.runId, 'run-42');
    assert.equal(rec.eventRef.inputDigest, 'a'.repeat(64));
    assert.ok(rec.eventRef.at);
    // 缺项目上下文时拒绝（事件候选必须绑定到项目，防止误升通用方法）
    assert.throws(
      () => service.captureFromRunEvent({ pluginId: 'p' }, { kind: 'run.failed', runId: 'r' }, base('x')),
      /KNOWLEDGE_EVENT_CONTEXT_REQUIRED/,
    );
    const feed = service.events(ctx, 'event.method');
    assert.ok(feed.items.some((e) => e.operation === 'CANDIDATE_CAPTURED'));
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('KA13: request/receipt bind digests; verification rejects unapproved executors and tampered bindings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-protocol-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const ctx = { pluginId: 'p' };
    const captured = service.capture(ctx, base('proto.method', { claims: ['narrow claim'] }));
    const suite = {
      id: 'proto-suite', version: '1', knowledgeIds: ['proto.method'],
      coverage: [{ knowledgeId: 'proto.method', candidateDigest: captured.contentDigest, claims: ['narrow claim'] }],
      cases: [
        { id: 'pos', group: 'positive', input: 1, expected: 1 },
        { id: 'neg', group: 'negative', input: 2, expected: 2 },
        { id: 'bnd', group: 'boundary', input: 3, expected: 3 },
      ],
      execute: async (_r, c) => c.input,
    };
    const request = createValidationRequest({
      requestId: 'req-1', actor: 'service:worker', pluginId: 'p',
      knowledgeId: 'proto.method', revision: captured.revision, candidateDigest: captured.contentDigest,
      validatorId: suite.id, validatorVersion: suite.version,
      validatorDigest: validatorDigest(suite), caseSetDigest: caseSetDigest(suite),
      executionEpoch: 1, issuedAt: new Date().toISOString(),
    });
    assert.ok(request.idempotencyKey, '幂等键必须由绑定字段派生');
    assert.ok(bindRequestCandidate(request, service.get(ctx, 'proto.method')), '请求必须绑定真实候选摘要');
    const receipt = createValidationReceipt(request, 'executor-approved', [
      { id: 'pos', group: 'positive', passed: true, actualDigest: digest(1), expectedDigest: digest(1) },
      { id: 'neg', group: 'negative', passed: true, actualDigest: digest(2), expectedDigest: digest(2) },
      { id: 'bnd', group: 'boundary', passed: true, actualDigest: digest(3), expectedDigest: digest(3) },
    ]);
    assert.equal(verifyValidationReceipt(request, receipt, ['executor-approved']).ok, true);
    assert.equal(verifyValidationReceipt(request, receipt, ['other-executor']).ok, false);
    // 篡改回执绑定 → 拒绝
    const tampered = { ...receipt, requestDigest: '0'.repeat(64) };
    assert.equal(verifyValidationReceipt(request, tampered, ['executor-approved']).ok, false);
    const empty = { ...receipt, results: [] };
    assert.equal(verifyValidationReceipt(request, empty, ['executor-approved']).ok, false);
    // receiptDigest 稳定：同内容同摘要
    assert.equal(receiptDigest(receipt), receiptDigest({ ...receipt }));
    // 实际激活仍走 service.validate（claims/coverage）
    service.registerValidator('p', suite);
    const activation = await service.validate(ctx, 'proto.method', captured.revision, 'proto-suite');
    assert.equal(activation.state, 'ACTIVE');
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('KA14: snapshot impact reports revoked/superseded bindings without rewriting history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-impact-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const ctx = { pluginId: 'p' };
    const captured = service.capture(ctx, base('impact.method', { claims: ['narrow claim'] }));
    service.registerValidator('p', {
      id: 'impact-suite', version: '1', knowledgeIds: ['impact.method'],
      coverage: [{ knowledgeId: 'impact.method', candidateDigest: captured.contentDigest, claims: ['narrow claim'] }],
      cases: [
        { id: 'pos', group: 'positive', input: 1, expected: 1 },
        { id: 'neg', group: 'negative', input: 2, expected: 2 },
        { id: 'bnd', group: 'boundary', input: 3, expected: 3 },
      ],
      execute: async (_r, c) => c.input,
    });
    await service.validate(ctx, 'impact.method', captured.revision, 'impact-suite');
    const snapshot = service.snapshot(ctx, 'run-impact');
    assert.equal(service.checkSnapshotImpact(ctx, snapshot).affected.length, 0);
    // 撤回后：快照引用进入 affected，历史不改写
    service.setState(ctx, 'impact.method', 1, 'REVOKED', 'bad applicability');
    const impact = service.checkSnapshotImpact(ctx, snapshot);
    assert.equal(impact.affected.length, 1);
    assert.equal(impact.affected[0].currentState, 'REVOKED');
    assert.deepEqual(service.readSnapshot(ctx, 'run-impact'), snapshot, '快照不可变');
    // 不可见引用不泄露
    const foreign = service.checkSnapshotImpact({ pluginId: 'other' }, snapshot);
    assert.equal(foreign.affected.length, 0);
    assert.equal(foreign.unchanged, snapshot.records.length);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
