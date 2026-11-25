// 证据验收：运行期沉淀的候选按「每条 claim 绑定一项证据检查」激活；缺检查/缺守护/检查不过均不激活。
// 夹具全部为合成数据。最后一例端到端跑 scripts/knowledge-accept.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KnowledgeService, buildAcceptanceSuite, jsonPointer, evaluateAcceptance, digest } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, '..', '..', '..', 'scripts', 'knowledge-accept.mjs');
const ctx = { pluginId: 'p' };
const CLAIMS = ['tail rate is 100 percent', 'row counts equal'];
const draft = (over = {}) => ({
  knowledgeId: 'p.method.note', scope: 'plugin', pluginId: 'p', kind: 'technical_method',
  title: 't', problemSignal: 's', cause: 'c', method: 'm', scenarios: [], edc: [], topics: [],
  preconditions: ['a'], notApplicable: [], counterexamples: ['b'], sources: ['comparison run'],
  claims: [...CLAIMS], ...over,
});
const FACTS = { tail: { rate: 100 }, rows: { std: 242, gen: 242 }, provenance: { evidenceIsCandidate: false } };
const evidence = (sha = 'a'.repeat(64)) => ({ documents: { 'facts.json': FACTS }, sha256: { 'facts.json': sha } });
const spec = (over = {}) => ({
  suiteId: 'accept.note',
  checks: [
    { claim: CLAIMS[0], evidence: 'facts.json', pointer: '/tail/rate', op: 'eq', value: 100 },
    { claim: CLAIMS[1], evidence: 'facts.json', pointer: '/rows', op: 'eq', value: { std: 242, gen: 242 } },
  ],
  guards: [
    { id: 'evidence-not-candidate', group: 'negative', evidence: 'facts.json', pointer: '/provenance/evidenceIsCandidate', op: 'eq', value: false },
    { id: 'rows-nonzero', group: 'boundary', evidence: 'facts.json', pointer: '/rows/std', op: 'gt', value: 0 },
  ],
  ...over,
});
const open = (name) => {
  const root = mkdtempSync(join(tmpdir(), `km-accept-${name}-`));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  return { root, service, close: () => { service.close(); rmSync(root, { recursive: true, force: true }); } };
};
const lastEvents = (service, id) => JSON.stringify(service.events(ctx, id).items);

test('a runtime candidate activates when every claim is backed by a passing evidence check', async () => {
  const { service, close } = open('activate');
  try {
    const record = service.capture(ctx, draft());
    assert.equal(record.state, 'CANDIDATE', '新沉淀的候选默认不可激活路径之外的状态');
    const suite = buildAcceptanceSuite({ record, spec: spec(), evidence: evidence() });
    service.registerValidator('p', suite);
    const out = await service.validate(ctx, record.knowledgeId, record.revision, suite.id);
    assert.equal(out.state, 'ACTIVE');
    assert.equal(out.validationScope, 'CONTENT_CLAIMS');
    assert.equal(out.results.length, 4, '两条 claim 检查 + 负例 + 边界');
    assert.equal(out.results.every((result) => result.passed), true);
    assert.equal(service.search(ctx).total, 1, '激活后进入默认 ACTIVE 检索');
    assert.match(lastEvents(service, record.knowledgeId), /ACTIV/);
    // 用例摘要绑定证据文件摘要：证据换了字节，回执里的 caseDigest 就不同。
    const rebuilt = buildAcceptanceSuite({ record, spec: spec(), evidence: evidence('b'.repeat(64)) });
    assert.notEqual(digest(suite.cases), digest(rebuilt.cases));
  } finally {
    close();
  }
});

test('refuses to build a suite that would let a claim through without its own evidence check', () => {
  const { service, close } = open('refuse');
  try {
    const record = service.capture(ctx, draft());
    const outcome = (acceptanceSpec) => {
      try { buildAcceptanceSuite({ record, spec: acceptanceSpec, evidence: evidence() }); return 'BUILT'; } catch (error) { return error.code; }
    };
    assert.equal(outcome(spec()), 'BUILT');
    assert.equal(outcome(spec({ checks: spec().checks.slice(0, 1) })), 'ACCEPTANCE_CLAIM_WITHOUT_CHECK');
    assert.equal(outcome(spec({ checks: [...spec().checks, { claim: 'not declared', evidence: 'facts.json', pointer: '/tail/rate', op: 'eq', value: 100 }] })), 'ACCEPTANCE_CHECK_NOT_A_CLAIM');
    assert.equal(outcome(spec({ checks: [...spec().checks, { ...spec().checks[0] }] })), 'ACCEPTANCE_CLAIM_WITH_MULTIPLE_CHECKS');
    assert.equal(outcome(spec({ guards: spec().guards.slice(0, 1) })), 'ACCEPTANCE_GUARDS_INCOMPLETE');
    assert.equal(outcome(spec({ guards: [] })), 'ACCEPTANCE_GUARDS_INCOMPLETE');
    assert.equal(outcome(spec({ checks: spec().checks.map((check, index) => (index === 0 ? { ...check, pointer: 'tail' } : check)) })), 'ACCEPTANCE_POINTER_INVALID');
    assert.equal(outcome(spec({ checks: spec().checks.map((check, index) => (index === 0 ? { ...check, op: 'approximately' } : check)) })), 'ACCEPTANCE_OP_INVALID');
    assert.equal(outcome(spec({ checks: spec().checks.map((check, index) => (index === 0 ? { ...check, value: undefined } : check)) })), 'ACCEPTANCE_VALUE_REQUIRED');
    assert.equal(outcome(spec({ checks: spec().checks.map((check, index) => (index === 0 ? { ...check, evidence: 'missing.json' } : check)) })), 'ACCEPTANCE_EVIDENCE_MISSING');
    const noClaims = service.capture(ctx, { ...draft({ knowledgeId: 'p.method.noclaims' }), claims: undefined });
    assert.throws(() => buildAcceptanceSuite({ record: noClaims, spec: spec(), evidence: evidence() }), /ACCEPTANCE_NO_CLAIMS/);
  } finally {
    close();
  }
});

test('a failing check keeps the candidate CANDIDATE and records the failure', async () => {
  const { service, close } = open('failing');
  try {
    const record = service.capture(ctx, draft());
    const wrong = spec();
    wrong.checks[0] = { ...wrong.checks[0], value: 99 };
    service.registerValidator('p', buildAcceptanceSuite({ record, spec: wrong, evidence: evidence() }));
    const out = await service.validate(ctx, record.knowledgeId, record.revision, wrong.suiteId);
    assert.equal(out.state, 'CANDIDATE');
    assert.equal(out.passed, false);
    assert.match(lastEvents(service, record.knowledgeId), /VALIDATION_FAILED/);
    assert.equal(service.search(ctx).total, 0);
  } finally {
    close();
  }
});

test('the suite only accepts the candidate revision it was built for', async () => {
  const { service, close } = open('pinned');
  try {
    const first = service.capture(ctx, draft());
    service.registerValidator('p', buildAcceptanceSuite({ record: first, spec: spec(), evidence: evidence() }));
    const second = service.capture(ctx, draft({ method: 'revised body' }), first.revision);
    const out = await service.validate(ctx, second.knowledgeId, second.revision, 'accept.note');
    assert.equal(out.state, 'CANDIDATE', '新修订不能借用旧候选的证据套件激活');
    assert.equal(out.passed, false);
  } finally {
    close();
  }
});

test('jsonPointer resolves objects, arrays and escapes; evaluateAcceptance compares by op', () => {
  const doc = { 'a/b': { '~c': [10, 20] }, list: [{ v: 1 }, { v: 2 }] };
  assert.equal(jsonPointer(doc, '/a~1b/~0c/1'), 20);
  assert.equal(jsonPointer(doc, '/list/1/v'), 2);
  assert.equal(jsonPointer(doc, '/list/01'), undefined);
  assert.equal(jsonPointer(doc, '/missing/deep'), undefined);
  assert.equal(jsonPointer(doc, ''), doc);
  assert.throws(() => jsonPointer(doc, 'a/b'), /ACCEPTANCE_POINTER_INVALID/);
  assert.equal(evaluateAcceptance(100, 'eq', 100), true);
  assert.equal(evaluateAcceptance('100', 'eq', 100), false);
  assert.equal(evaluateAcceptance(3, 'gte', 3), true);
  assert.equal(evaluateAcceptance('3', 'gte', 3), false, '数值比较不做字符串转换');
  assert.equal(evaluateAcceptance([1, { a: 2 }], 'contains', { a: 2 }), true);
  assert.equal(evaluateAcceptance('abcdef', 'contains', 'cde'), true);
  assert.equal(evaluateAcceptance(undefined, 'exists', undefined), false);
  assert.equal(evaluateAcceptance(null, 'type', 'null'), true);
  assert.equal(evaluateAcceptance(undefined, 'ne', 1), true);
});

test('CLI activates a candidate from a spec file (exit 0); a failing spec exits 2 and leaves it CANDIDATE', () => {
  const root = mkdtempSync(join(tmpdir(), 'km-accept-cli-'));
  const store = join(root, 'knowledge.sqlite');
  try {
    const seed = new KnowledgeService(store);
    const first = seed.capture(ctx, draft({ knowledgeId: 'p.method.cli' }));
    const second = seed.capture(ctx, draft({ knowledgeId: 'p.method.cli2' }));
    seed.close(); // sqlite 单写者：CLI 运行前释放本进程的连接
    writeFileSync(join(root, 'facts.json'), JSON.stringify(FACTS));
    writeFileSync(join(root, 'accept.json'), JSON.stringify(spec({ suiteId: 'accept.cli' })));
    const wrong = spec({ suiteId: 'accept.cli.wrong' });
    wrong.checks[1] = { ...wrong.checks[1], value: { std: 242, gen: 241 } };
    writeFileSync(join(root, 'wrong.json'), JSON.stringify(wrong));
    const run = (id, specName) => spawnSync(process.execPath, [CLI, '--store', store, '--plugin', 'p', '--knowledge', id, '--spec', join(root, specName)], { encoding: 'utf8' });

    const ok = run(first.knowledgeId, 'accept.json');
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);
    assert.match(ok.stdout, /"state":"ACTIVE"/);
    const failed = run(second.knowledgeId, 'wrong.json');
    assert.equal(failed.status, 2, failed.stderr || failed.stdout);
    assert.match(failed.stdout, /"state":"CANDIDATE"/);
    const check = new KnowledgeService(store);
    try {
      assert.equal(check.get(ctx, first.knowledgeId).state, 'ACTIVE');
      assert.equal(check.get(ctx, second.knowledgeId).state, 'CANDIDATE');
    } finally {
      check.close();
    }
    assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 1, '缺参数=用法错误');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
