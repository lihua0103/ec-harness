// ClaimEvidence 结构化覆盖测试：无 evidence 的套件保持兼容；坏 suite/case 引用拒绝注册；真实 evidence 激活。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService, digest } from '../lib/index.js';

const ctx = { pluginId: 'p' };
const draft = (id, claims) => ({
  knowledgeId: id, scope: 'plugin', pluginId: 'p', kind: 'scenario_method',
  title: '声明与用例绑定', problemSignal: 'p', cause: 'c', method: 'm',
  scenarios: [], edc: [], topics: ['claim-evidence'], preconditions: ['p'], notApplicable: ['n'],
  counterexamples: ['c'], sources: ['s'], claims,
});

test('structured claim evidence binds claims to executed cases and rejects invalid references', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-claim-evidence-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const rec = service.capture(ctx, draft('claim.evidence', ['claim-a']));
    const base = {
      id: 'evidence-suite', version: '1.0.0', knowledgeIds: ['claim.evidence'],
      cases: [
        { id: 'pos', group: 'positive', input: 1, expected: 1 },
        { id: 'neg', group: 'negative', input: 2, expected: 2 },
        { id: 'bnd', group: 'boundary', input: 3, expected: 3 },
      ],
      execute: async (_r, c) => c.input,
    };
    assert.throws(() => service.registerValidator('p', {
      ...base,
      id: 'bad-case',
      coverage: [{ knowledgeId: 'claim.evidence', candidateDigest: rec.contentDigest, claims: ['claim-a'], evidence: [{ suiteId: 'bad-case', suiteVersion: '1.0.0', caseIds: ['missing'] }] }],
    }), /KNOWLEDGE_CLAIM_EVIDENCE_CASE_INVALID/);

    service.registerValidator('p', {
      ...base,
      coverage: [{ knowledgeId: 'claim.evidence', candidateDigest: rec.contentDigest, claims: ['claim-a'], evidence: [{ suiteId: 'evidence-suite', suiteVersion: '1.0.0', caseIds: ['pos', 'neg', 'bnd'] }] }],
    });
    const receipt = await service.validate(ctx, 'claim.evidence', rec.revision, 'evidence-suite');
    assert.equal(receipt.validationScope, 'CONTENT_CLAIMS');
    assert.equal(receipt.state, 'ACTIVE');
    assert.equal(receipt.claimEvidence.valid, true);

    // 向后兼容：未声明 evidence 的套件仍按 claims/coverage 激活。
    const legacy = service.capture(ctx, draft('legacy.evidence', ['claim-legacy']));
    service.registerValidator('p', {
      ...base,
      id: 'legacy-suite', knowledgeIds: ['legacy.evidence'],
      coverage: [{ knowledgeId: 'legacy.evidence', candidateDigest: legacy.contentDigest, claims: ['claim-legacy'] }],
    });
    const legacyReceipt = await service.validate(ctx, 'legacy.evidence', legacy.revision, 'legacy-suite');
    assert.equal(legacyReceipt.state, 'ACTIVE');
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
