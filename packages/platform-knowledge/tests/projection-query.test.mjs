// M2-02 智能体侧读取：投影台账按插件过滤、可按结局筛选、条数有上限；不跨插件泄漏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../lib/index.js';

const draft = (pluginId, projectId) => ({
  knowledgeId: 'projection.method', scope: 'project', pluginId, projectId, kind: 'scenario_method',
  title: '投影方法', problemSignal: 'p', cause: 'c', method: 'm',
  scenarios: [], edc: [], topics: ['projection'], preconditions: ['p'], notApplicable: ['n'],
  counterexamples: ['c'], sources: ['s'],
});

test('listProjections is per plugin, filterable by outcome and never leaks another plugin', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-projection-query-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const a = { pluginId: 'p', projectId: 'proj-a' };
    const b = { pluginId: 'q', projectId: 'proj-b' };
    service.captureFromProjection(a, {
      event: { eventId: 'run-1', contributor: 'platform-control', projectionVersion: '1', kind: 'run.failed', runId: 'run-1' },
      disposition: 'PENDING_ANALYSIS',
    });
    service.captureFromProjection(a, {
      event: { eventId: 'run-2', contributor: 'platform-control', projectionVersion: '1', kind: 'qc.completed', runId: 'run-2' },
      draft: draft('p', 'proj-a'),
    });
    service.captureFromProjection(b, {
      event: { eventId: 'run-9', contributor: 'platform-control', projectionVersion: '1', kind: 'run.failed', runId: 'run-9' },
      disposition: 'PENDING_ANALYSIS',
    });

    const all = service.listProjections(a);
    assert.equal(all.length, 2, '只返回本插件的投影');
    assert.ok(all.every((item) => item.pluginId === 'p'));
    assert.ok(!all.some((item) => item.eventId === 'run-9'), '不得读到其他插件的事故');

    const pending = service.listProjections(a, { outcome: 'PENDING_ANALYSIS' });
    assert.deepEqual(pending.map((item) => item.eventId), ['run-1']);

    const candidates = service.listProjections(a, { outcome: 'CANDIDATE' });
    assert.deepEqual(candidates.map((item) => item.eventId), ['run-2']);

    assert.equal(service.listProjections(a, { limit: 1 }).length, 1, 'limit 生效');
    assert.equal(service.listProjections(a, { limit: 9999 }).length, 2, '超上限被夹紧而不是报错');
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});