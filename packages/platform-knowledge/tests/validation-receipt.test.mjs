// 跨进程验证回执（KA13）实际落地测试：请求绑定候选/套件，回执逐用例核验后按 claims/coverage 激活。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KnowledgeService,
  createValidationReceipt,
  digest,
} from '../lib/index.js';

const ctx = { pluginId: 'p' };
const draft = (id, claims) => ({
  knowledgeId: id, scope: 'plugin', pluginId: 'p', kind: 'scenario_method',
  title: '跨进程验证', problemSignal: 'p', cause: 'c', method: 'm',
  scenarios: [], edc: [], topics: ['receipt'], preconditions: ['p'], notApplicable: ['n'],
  counterexamples: ['c'], sources: ['s'], claims,
});

const suiteFor = (knowledgeId, candidateDigest, overrides = {}) => ({
  id: 'receipt-suite',
  version: '1.0.0',
  knowledgeIds: [knowledgeId],
  cases: [
    { id: 'pos', group: 'positive', input: 1, expected: 1 },
    { id: 'neg', group: 'negative', input: 2, expected: 2 },
    { id: 'bnd', group: 'boundary', input: 3, expected: 3 },
  ],
  execute: async (_record, testCase) => testCase.input,
  coverage: [{
    knowledgeId,
    candidateDigest,
    claims: ['claim-a'],
    evidence: [{ suiteId: 'receipt-suite', suiteVersion: '1.0.0', caseIds: ['pos', 'neg', 'bnd'] }],
  }],
  ...overrides,
});

const executeCases = (suite) => suite.cases.map((testCase) => {
  const actual = testCase.input;
  return {
    id: testCase.id,
    group: testCase.group,
    passed: true,
    actualDigest: digest(actual),
    expectedDigest: digest(testCase.expected),
  };
});

test('an in-process executor receipt activates only after every case and claim is verified', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-receipt-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const record = service.capture(ctx, draft('receipt.method', ['claim-a']));
    const suite = suiteFor('receipt.method', record.contentDigest);
    service.registerValidator('p', suite);

    const request = service.createValidationRequestFor(ctx, 'receipt.method', record.revision, 'receipt-suite', 'worker-1');
    assert.equal(request.candidateDigest, record.contentDigest);
    assert.match(request.caseSetDigest, /^[a-f0-9]{64}$/);

    const receipt = createValidationReceipt(request, 'executor-1', executeCases(suite));
    const applied = service.validateWithReceipt(ctx, 'receipt.method', record.revision, request, receipt, ['executor-1']);
    assert.equal(applied.state, 'ACTIVE');
    assert.equal(applied.validationScope, 'CONTENT_CLAIMS');
    assert.match(applied.receiptDigest, /^[a-f0-9]{64}$/);
    assert.equal(service.get(ctx, 'receipt.method').state, 'ACTIVE');
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unapproved executor, a stale candidate and mismatched cases are rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-receipt-negative-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const record = service.capture(ctx, draft('receipt.stale', ['claim-a']));
    const suite = suiteFor('receipt.stale', record.contentDigest);
    service.registerValidator('p', suite);
    const request = service.createValidationRequestFor(ctx, 'receipt.stale', record.revision, 'receipt-suite', 'worker-1');

    // Unapproved executor.
    const foreign = createValidationReceipt(request, 'executor-x', executeCases(suite));
    assert.throws(
      () => service.validateWithReceipt(ctx, 'receipt.stale', record.revision, request, foreign, ['executor-1']),
      /KNOWLEDGE_RECEIPT_REJECTED:EXECUTOR_NOT_APPROVED/,
    );

    // Missing or extra case results never activate.
    const partial = createValidationReceipt(request, 'executor-1', executeCases(suite).slice(0, 2));
    assert.throws(
      () => service.validateWithReceipt(ctx, 'receipt.stale', record.revision, request, partial, ['executor-1']),
      /KNOWLEDGE_RECEIPT_CASE_COUNT_MISMATCH/,
    );
    const duplicate = createValidationReceipt(request, 'executor-1', [
      ...executeCases(suite).slice(0, 2),
      executeCases(suite)[0],
    ]);
    assert.throws(
      () => service.validateWithReceipt(ctx, 'receipt.stale', record.revision, request, duplicate, ['executor-1']),
      /KNOWLEDGE_RECEIPT_CASE_MISMATCH/,
    );

    // A result that claims a different expectation is rejected even when it reports passed.
    const wrongExpectation = createValidationReceipt(request, 'executor-1', executeCases(suite).map((result) =>
      result.id === 'pos' ? { ...result, expectedDigest: digest(999) } : result));
    assert.throws(
      () => service.validateWithReceipt(ctx, 'receipt.stale', record.revision, request, wrongExpectation, ['executor-1']),
      /KNOWLEDGE_RECEIPT_EXPECTATION_MISMATCH/,
    );

    // A receipt for a different revision cannot activate a newer candidate.
    const newer = service.capture(ctx, { ...draft('receipt.stale', ['claim-a']), method: 'm2' }, record.revision);
    assert.throws(
      () => service.validateWithReceipt(ctx, 'receipt.stale', newer.revision, request, createValidationReceipt(request, 'executor-1', executeCases(suite)), ['executor-1']),
      /KNOWLEDGE_REQUEST_TARGET_MISMATCH|KNOWLEDGE_REQUEST_DIGEST_MISMATCH/,
    );
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repeated receipt is idempotent and a second different receipt for one request is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-receipt-idempotent-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const record = service.capture(ctx, draft('receipt.dup', ['claim-a']));
    const suite = suiteFor('receipt.dup', record.contentDigest);
    service.registerValidator('p', suite);
    const request = service.createValidationRequestFor(ctx, 'receipt.dup', record.revision, 'receipt-suite', 'worker-1');
    const receipt = createValidationReceipt(request, 'executor-1', executeCases(suite));
    const first = service.validateWithReceipt(ctx, 'receipt.dup', record.revision, request, receipt, ['executor-1']);
    assert.equal(first.state, 'ACTIVE');
    assert.equal(first.duplicate, false);

    const eventsAfterFirst = service.events(ctx, 'receipt.dup').items.length;
    const replay = service.validateWithReceipt(ctx, 'receipt.dup', record.revision, request, receipt, ['executor-1']);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.state, 'ACTIVE');
    assert.equal(replay.receiptDigest, first.receiptDigest);
    assert.equal(service.events(ctx, 'receipt.dup').items.length, eventsAfterFirst, '重复回执不得再写状态事件');

    const competing = createValidationReceipt(request, 'executor-1', executeCases(suite).map((result) => ({
      ...result, actualDigest: digest({ altered: result.id }),
    })));
    assert.throws(
      () => service.validateWithReceipt(ctx, 'receipt.dup', record.revision, request, competing, ['executor-1']),
      /KNOWLEDGE_RECEIPT_ALREADY_APPLIED/,
    );
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('a failing case keeps the candidate and records the receipt as evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-receipt-failing-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const record = service.capture(ctx, draft('receipt.failing', ['claim-a']));
    const suite = suiteFor('receipt.failing', record.contentDigest);
    service.registerValidator('p', suite);
    const request = service.createValidationRequestFor(ctx, 'receipt.failing', record.revision, 'receipt-suite', 'worker-1');
    const results = executeCases(suite).map((result) => (result.id === 'neg' ? { ...result, passed: false } : result));
    const applied = service.validateWithReceipt(ctx, 'receipt.failing', record.revision, request, createValidationReceipt(request, 'executor-1', results), ['executor-1']);
    assert.equal(applied.state, 'CANDIDATE');
    assert.equal(applied.reason, 'VALIDATION_FAILED');
    const events = service.events(ctx, 'receipt.failing').items;
    assert.ok(events.some((event) => event.operation === 'VALIDATION_FAILED'));
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});