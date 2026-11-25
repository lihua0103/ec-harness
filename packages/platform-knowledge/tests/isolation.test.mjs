/** L1 权威服务隔离（L1 完成定义）：组织/区域/项目隔离覆盖列表、直接 ID、计数、分页、快照与事件日志。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../lib/index.js';

const makeService = () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-iso-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  return { root, service };
};

const context = (overrides = {}) => ({ pluginId: 'demo', projectId: 'P-1', orgId: 'acme', region: 'eu', ...overrides });

const baseDraft = (id) => ({
  knowledgeId: id, scope: 'plugin', pluginId: 'demo', kind: 'technical_method',
  title: `方法 ${id}`, problemSignal: `信号 ${id}`, cause: '原因', method: '方法',
  scenarios: [], edc: [], topics: [], preconditions: ['前提'], notApplicable: ['不适用'],
  counterexamples: ['反例'], sources: ['来源'], claims: [`claim ${id}`],
});

/** 激活（快照只绑定 ACTIVE 记录；claims/coverage 最小套件）。tenant 缺省 = acme/eu；
 *  显式 { orgId: undefined, region: undefined } 表示无租户（shared）。 */
const activate = async (service, id, tenant = {}) => {
  const captured = service.capture(context(tenant), baseDraft(id));
  service.registerValidator('demo', {
    id: `suite-${id}`, version: '1', knowledgeIds: [id],
    coverage: [{ knowledgeId: id, candidateDigest: captured.contentDigest, claims: baseDraft(id).claims }],
    cases: [
      { id: 'pos', group: 'positive', input: 1, expected: 1 },
      { id: 'neg', group: 'negative', input: 2, expected: 2 },
      { id: 'bnd', group: 'boundary', input: 3, expected: 3 },
    ],
    execute: async (_record, testCase) => testCase.input,
  });
  await service.validate(context(tenant), id, captured.revision, `suite-${id}`);
};

test('列表/计数/分页：跨租户条目不泄漏，shared 条目全租户可见', async () => {
  const { root, service } = makeService();
  try {
    await activate(service, 'acme.a');
    await activate(service, 'acme.b');
    await activate(service, 'other.a', { orgId: 'other' });
    await activate(service, 'shared.z', { orgId: undefined, region: undefined });

    const acme = service.search(context(), { limit: 1 });
    assert.equal(acme.total, 3, 'acme 看到 2 条本组织 + 1 条 shared');
    assert.equal(acme.items.length, 1, '分页只返回当前页');
    const page2 = service.search(context(), { limit: 1, offset: 1 });
    assert.equal(page2.total, 3, '分页 total 不因页大小泄漏或截断');
    const page3 = service.search(context(), { limit: 1, offset: 2 });
    assert.deepEqual(
      [...acme.items, ...page2.items, ...page3.items].map((r) => r.knowledgeId),
      ['acme.a', 'acme.b', 'shared.z'],
      '跨组织记录不在任何一页出现',
    );
    const other = service.search(context({ orgId: 'other' }), {});
    assert.equal(other.total, 2);
    assert.deepEqual(other.items.map((r) => r.knowledgeId).sort(), ['other.a', 'shared.z']);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('直接 ID 与事件日志：越权读取 404 掩蔽，日志不可跨租户读取', async () => {
  const { root, service } = makeService();
  try {
    await activate(service, 'acme.a');
    // 直接 ID：另一组织读不到（KNOWLEDGE_NOT_FOUND，与不存在不可区分）
    assert.throws(() => service.get(context({ orgId: 'other' }), 'acme.a'), /KNOWLEDGE_NOT_FOUND/);
    assert.throws(() => service.get(context({ region: 'cn' }), 'acme.a'), /KNOWLEDGE_NOT_FOUND/, '区域也参与隔离');
    // 事件日志：可见性先于任何行加载（events 内部先 get 校验）
    assert.throws(() => service.events(context({ orgId: 'other' }), 'acme.a'), /KNOWLEDGE_NOT_FOUND/);
    const events = service.events(context(), 'acme.a');
    assert.ok(events.total >= 1);
    // 项目隔离：project 记录不出现在其他项目
    service.capture(context({ projectId: 'P-2' }), { ...baseDraft('acme.p2'), scope: 'project', projectId: 'P-2' });
    assert.equal(
      service.search(context(), {}).items.filter((r) => r.knowledgeId === 'acme.p2').length,
      0,
      'P-1 上下文看不到 P-2 的项目记录',
    );
    assert.ok(service.search(context({ projectId: 'P-2' }), { states: ['CANDIDATE'] }).items.some((r) => r.knowledgeId === 'acme.p2'));
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('快照与学习个案按租户隔离', async () => {
  const { root, service } = makeService();
  try {
    await activate(service, 'acme.a');
    await activate(service, 'other.a', { orgId: 'other' });
    const acmeSnapshot = service.snapshot(context(), 'run-iso');
    assert.deepEqual(acmeSnapshot.records.map((ref) => ref.knowledgeId), ['acme.a']);
    const otherSnapshot = service.snapshot(context({ orgId: 'other' }), 'run-iso');
    assert.deepEqual(otherSnapshot.records.map((ref) => ref.knowledgeId), ['other.a']);
    // 事件来源（控制面投影）跨组织不互见
    service.captureFromProjection(context(), {
      event: { eventId: 'e-1', contributor: 'platform-control', projectionVersion: '1', kind: 'run.failed', runId: 'run-iso' },
      disposition: 'PENDING_ANALYSIS',
    });
    service.captureFromProjection(context({ orgId: 'other' }), {
      event: { eventId: 'e-1', contributor: 'platform-control', projectionVersion: '1', kind: 'run.failed', runId: 'run-iso' },
      disposition: 'PENDING_ANALYSIS',
    });
    assert.equal(service.learningCases(context()).length, 0, '投影台账不是个案；打开是显式动作');
    const openedAcme = service.learningCaseOpen(context(), {
      sourceEvent: { eventId: 'e-1', contributor: 'platform-control', projectionVersion: '1', kind: 'run.failed', runId: 'run-iso' },
      hypothesisKey: 'h1',
    });
    const otherCases = service.learningCases(context({ orgId: 'other' }));
    assert.deepEqual(otherCases.map((c) => c.caseId), [], '另一组织看不到 acme 的个案');
    // 同一 event_id 在不同租户是不同事件（租户在幂等键内）
    const openedOther = service.learningCaseOpen(context({ orgId: 'other' }), {
      sourceEvent: { eventId: 'e-1', contributor: 'platform-control', projectionVersion: '1', kind: 'run.failed', runId: 'run-iso' },
      hypothesisKey: 'h1',
    });
    assert.notEqual(openedOther.case.caseId, openedAcme.case.caseId);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
