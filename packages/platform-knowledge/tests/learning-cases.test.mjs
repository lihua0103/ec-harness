/** L3 学习个案与提案（T04/T05，开发设计 §5 learning.proposeFromCase / §6 合成例）：
 *  个案幂等键、显式贡献确认、去项目化新建候选（禁 projectId/scope 升级/直接 ACTIVE）、
 *  eventRef 用真实 runId、幂等键同内容原回执/异内容冲突、NO_REUSABLE 是有效结局、租户隔离。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../lib/index.js';

const makeService = () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-learn-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  return { root, service };
};

const context = (overrides = {}) => ({ pluginId: 'dm-dvp', projectId: 'PROJ-A', orgId: 'acme', region: 'eu', ...overrides });
const actor = { actorId: 'user:jia', orgId: 'acme', region: 'eu' };

const proposalDraft = (overrides = {}) => ({
  knowledgeId: 'k.dvp.missing-vs-na',
  kind: 'technical_method',
  title: '有显式不适用证据时不计为缺失',
  problemSignal: '字段缺失与表单不适用被混为一类',
  cause: '两类信号使用同一处置口径',
  method: '有显式不适用证据时不将该项计为缺失',
  scenarios: ['review'],
  edc: [],
  topics: ['missing-vs-na'],
  preconditions: ['存在可判定的不适用证据字段'],
  notApplicable: ['无证据仅有缺值'],
  counterexamples: ['证据互相冲突应转未决'],
  sources: ['项目 A 复盘'],
  claims: ['有显式不适用证据时不计缺失'],
  ...overrides,
});

const pendingCase = (service) => {
  // 与控制面投影同一事件（真实事件绑定，KA12）
  const projection = service.captureFromProjection(context(), {
    event: {
      eventId: 'run-42', contributor: 'platform-control', projectionVersion: '1',
      kind: 'run.failed', runId: 'run-42', inputDigest: 'a'.repeat(64),
    },
    disposition: 'PENDING_ANALYSIS',
  });
  assert.equal(projection.outcome, 'PENDING_ANALYSIS');
  const opened = service.learningCaseOpen(context(), {
    sourceEvent: {
      eventId: 'run-42', contributor: 'platform-control', projectionVersion: '1',
      kind: 'run.failed', runId: 'run-42', inputDigest: 'a'.repeat(64),
    },
    hypothesisKey: 'missing-vs-na',
  });
  assert.equal(opened.duplicate, false);
  return opened.case;
};

test('个案打开幂等：同 (pluginId, eventId, hypothesisKey) 返回原个案；不同假设是新个案', () => {
  const { root, service } = makeService();
  try {
    const first = pendingCase(service);
    const second = service.learningCaseOpen(context(), {
      sourceEvent: first.sourceEvent, hypothesisKey: 'missing-vs-na',
    });
    assert.equal(second.duplicate, true);
    assert.equal(second.case.caseId, first.caseId);
    const otherHypothesis = service.learningCaseOpen(context(), {
      sourceEvent: first.sourceEvent, hypothesisKey: 'edc-scope',
    });
    assert.equal(otherHypothesis.duplicate, false);
    assert.notEqual(otherHypothesis.case.caseId, first.caseId);
    assert.equal(service.learningCases(context()).length, 2);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('提案拒绝：未显式确认贡献、携带项目身份、直接设状态、scope 升级', () => {
  const { root, service } = makeService();
  try {
    const learningCase = pendingCase(service);
    assert.throws(
      () => service.proposeFromCase(context(), actor, {
        caseId: learningCase.caseId, contributionConfirmed: false, idempotencyKey: 'idem-1', draft: proposalDraft(),
      }),
      /LEARNING_CONTRIBUTION_NOT_CONFIRMED/,
    );
    assert.throws(
      () => service.proposeFromCase(context(), actor, {
        caseId: learningCase.caseId, contributionConfirmed: true, idempotencyKey: 'idem-1',
        draft: proposalDraft({ projectId: 'PROJ-A' }),
      }),
      /LEARNING_PROPOSAL_PROJECT_LEAK/,
      '去项目化：候选不得携带项目身份',
    );
    assert.throws(
      () => service.proposeFromCase(context(), actor, {
        caseId: learningCase.caseId, contributionConfirmed: true, idempotencyKey: 'idem-1',
        draft: proposalDraft({ state: 'ACTIVE' }),
      }),
      /LEARNING_STATE_OVERRIDE_NOT_ALLOWED/,
      '模型/调用方不能直接设 ACTIVE',
    );
    assert.throws(
      () => service.proposeFromCase(context(), actor, {
        caseId: learningCase.caseId, contributionConfirmed: true, idempotencyKey: 'idem-1',
        draft: proposalDraft({ scope: 'shared' }),
      }),
      /LEARNING_SCOPE_ESCALATION_NOT_ALLOWED/,
      '受众升级不是提案能做的事',
    );
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('提案成功：新建 CANDIDATE、eventRef 用真实 runId、个案转为 PROPOSED 并留提案人', async () => {
  const { root, service } = makeService();
  try {
    const learningCase = pendingCase(service);
    const proposal = service.proposeFromCase(context(), actor, {
      caseId: learningCase.caseId, contributionConfirmed: true, idempotencyKey: 'idem-1', draft: proposalDraft(),
    });
    assert.equal(proposal.duplicate, false);
    const candidate = service.get(context(), proposal.knowledgeId, proposal.revision);
    assert.equal(candidate.state, 'CANDIDATE', '提案是候选，激活仍走 claims/coverage');
    assert.equal(candidate.scope, 'plugin');
    assert.equal(candidate.projectId, undefined, '候选不携带项目身份');
    assert.equal(candidate.eventRef?.runId, 'run-42', 'KA12：事件引用是真实 runId');
    const after = service.learningCaseVisible(context(), learningCase.caseId);
    assert.equal(after.status, 'PROPOSED');
    assert.equal(after.proposal?.proposedBy, 'user:jia');
    assert.equal(after.proposal?.knowledgeId, proposal.knowledgeId);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('幂等键：同键同内容返回原回执；同键不同内容冲突（不用最后写入覆盖）', () => {
  const { root, service } = makeService();
  try {
    const learningCase = pendingCase(service);
    const first = service.proposeFromCase(context(), actor, {
      caseId: learningCase.caseId, contributionConfirmed: true, idempotencyKey: 'idem-1', draft: proposalDraft(),
    });
    assert.throws(
      () => service.proposeFromCase(context(), actor, {
        caseId: learningCase.caseId, contributionConfirmed: true, idempotencyKey: 'idem-1',
        draft: proposalDraft({ knowledgeId: 'k.dvp.missing-vs-na-v2' }),
      }),
      /LEARNING_PROPOSAL_CONFLICT/,
    );
    // 同幂等键同内容（重复投递）→ 原 candidateRef
    const duplicate = service.proposeFromCase(context(), actor, {
      caseId: learningCase.caseId, contributionConfirmed: true, idempotencyKey: 'idem-1', draft: proposalDraft(),
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.knowledgeId, first.knowledgeId);
    // 已提案个案再提案 → 明确拒绝
    assert.throws(
      () => service.proposeFromCase(context(), actor, {
        caseId: learningCase.caseId, contributionConfirmed: true, idempotencyKey: 'idem-2', draft: proposalDraft({ knowledgeId: 'k.dvp.third' }),
      }),
      /LEARNING_CASE_ALREADY_PROPOSED/,
    );
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('无需复用（NO_REUSABLE）是有效结局；复位后才能再提案；租户隔离互不可见', () => {
  const { root, service } = makeService();
  try {
    const learningCase = pendingCase(service);
    service.learningCaseDispose(context(), learningCase.caseId, 'NO_REUSABLE', '一次性的项目内口径');
    assert.equal(service.learningCaseVisible(context(), learningCase.caseId).status, 'NO_REUSABLE');
    assert.throws(
      () => service.proposeFromCase(context(), actor, {
        caseId: learningCase.caseId, contributionConfirmed: true, idempotencyKey: 'idem-1', draft: proposalDraft(),
      }),
      /LEARNING_CASE_NOT_OPEN/,
    );
    service.learningCaseDispose(context(), learningCase.caseId, 'PENDING');
    const proposal = service.proposeFromCase(context(), actor, {
      caseId: learningCase.caseId, contributionConfirmed: true, idempotencyKey: 'idem-1', draft: proposalDraft(),
    });
    assert.equal(proposal.duplicate, false);
    // 另一组织看不到本案：越权与不存在不可区分
    const otherOrg = { ...context(), orgId: 'other' };
    assert.throws(
      () => service.learningCaseDispose(otherOrg, learningCase.caseId, 'NO_REUSABLE'),
      /LEARNING_CASE_NOT_FOUND/,
    );
    assert.deepEqual(service.learningCases(otherOrg), []);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
