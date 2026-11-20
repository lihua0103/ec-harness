// M2-02：事件到候选。投影按 (eventId, contributor, projectionVersion) 幂等；无证据如实记录结局；
// 候选失败只记台账，不产生“已验证”或业务状态变化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../lib/index.js';

const ctx = { pluginId: 'p', projectId: 'proj-a' };
const draft = (method = 'm') => ({
  knowledgeId: 'projection.method', scope: 'project', pluginId: 'p', projectId: 'proj-a', kind: 'scenario_method',
  title: '投影方法', problemSignal: 'p', cause: 'c', method,
  scenarios: [], edc: [], topics: ['projection'], preconditions: ['p'], notApplicable: ['n'],
  counterexamples: ['c'], sources: ['s'],
});
const event = (overrides = {}) => ({
  eventId: 'run-1', contributor: 'platform-control', projectionVersion: '1',
  kind: 'run.failed', runId: 'run-1', ...overrides,
});

test('the same trusted event delivered twice yields one candidate and one projection record', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-projection-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const first = service.captureFromProjection(ctx, { event: event(), draft: draft() });
    assert.equal(first.outcome, 'CANDIDATE');
    assert.equal(first.duplicate, false);
    assert.equal(service.get(ctx, 'projection.method').revision, 1);

    const again = service.captureFromProjection(ctx, { event: event(), draft: draft() });
    assert.equal(again.duplicate, true);
    assert.equal(again.outcome, 'CANDIDATE');
    assert.equal(again.projectionKey, first.projectionKey);
    assert.equal(service.get(ctx, 'projection.method').revision, 1, '重复投递不得产生新修订');
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('events without reusable evidence record an explicit outcome, and conflicts never pretend to be candidates', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-projection-outcomes-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const none = service.captureFromProjection(ctx, { event: event({ eventId: 'run-2' }) });
    assert.equal(none.outcome, 'NO_REUSABLE_CONCLUSION');
    const pending = service.captureFromProjection(ctx, {
      event: event({ eventId: 'run-3' }),
      disposition: 'PENDING_ANALYSIS',
    });
    assert.equal(pending.outcome, 'PENDING_ANALYSIS');

    assert.throws(
      () => service.captureFromProjection({ pluginId: 'p' }, { event: event({ eventId: 'run-4' }), draft: draft() }),
      /KNOWLEDGE_EVENT_CONTEXT_REQUIRED/,
    );

    // 同一知识 ID 的第二份起草默认按修订 0 提交，不会覆盖已有候选，而是显式冲突。
    service.captureFromProjection(ctx, { event: event({ eventId: 'run-5' }), draft: draft('m2') });
    const conflict = service.captureFromProjection(ctx, {
      event: event({ eventId: 'run-5', projectionVersion: '2' }),
      draft: draft('m3'),
    });
    assert.equal(conflict.outcome, 'CONFLICT');
    assert.match(conflict.reason, /KNOWLEDGE_REVISION_STALE/);
    assert.equal(service.get(ctx, 'projection.method').revision, 1);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});