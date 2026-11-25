// 学习闭环：验证器固定用例复现活代码 → 种子 CANDIDATE → validate 激活 → 事件读取。全部纯函数级断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../../../packages/platform-knowledge/src/service.js';
import { dvpMethodSuite } from '../src/knowledge-validators.js';
import { dvpSeeds, dvpKnowledgeContribution, DVP_PLUGIN_ID, DVP_SEED_VERSION } from '../src/knowledge-seeds.js';

const ctx = { pluginId: DVP_PLUGIN_ID };

test('validator suite cases reproduce installed helpers: positive, negative, boundary', async () => {
  for (const testCase of dvpMethodSuite.cases) {
    const actual = await dvpMethodSuite.execute({} as never, testCase);
    assert.deepEqual(actual, testCase.expected, `case ${testCase.id} mismatch`);
  }
});

test('manifest seed declarations reconcile with seed source (single source of truth)', () => {
  const manifest = JSON.parse(readFileSync(new URL('../knowledge/manifest.json', import.meta.url), 'utf8')) as {
    taxonomy: { topics: string[] };
    seeds: Array<{ knowledgeId: string; topics: string[]; claims?: number }>;
  };
  const declared = manifest.seeds.map((seed) => seed.knowledgeId).sort();
  assert.deepEqual(declared, dvpSeeds.map((seed) => seed.knowledgeId).sort());
  const topics = new Set(manifest.taxonomy.topics);
  for (const seed of dvpSeeds) {
    const entry = manifest.seeds.find((declaredSeed) => declaredSeed.knowledgeId === seed.knowledgeId);
    assert.ok(entry, `${seed.knowledgeId} 未登记进 manifest`);
    assert.equal(entry.claims ?? 0, seed.claims?.length ?? 0, `${seed.knowledgeId} claims 计数失谐`);
    for (const topic of seed.topics) assert.ok(topics.has(topic), `${seed.knowledgeId} 主题 ${topic} 未在 taxonomy 声明`);
  }
});

test('contribution registration validates and unregisters', () => {
  const root = mkdtempSync(join(tmpdir(), 'dvp-km-contrib-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const unregister = service.registerContribution(dvpKnowledgeContribution);
    assert.throws(() => service.registerContribution(dvpKnowledgeContribution), /ALREADY_REGISTERED/);
    unregister();
    service.registerContribution(dvpKnowledgeContribution);
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('seeded template method without claims stays CANDIDATE; narrow-claim seeds activate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dvp-km-seeds-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    service.registerContribution(dvpKnowledgeContribution);
    service.registerValidator(DVP_PLUGIN_ID, dvpMethodSuite);
    const imported = service.importSeeds(DVP_PLUGIN_ID, DVP_SEED_VERSION, dvpSeeds);
    assert.equal(imported.conflicts.length, 0);
    assert.equal(dvpSeeds.length >= 5, true);
    for (const seed of dvpSeeds) assert.equal(service.get(ctx, seed.knowledgeId).state, 'CANDIDATE');

    // 宽方法正文（template 四层结构）未声明窄声明：固定用例通过也不能激活。
    const template = service.get(ctx, 'dm-dvp.template.discipline');
    assert.equal((template.claims?.length ?? 0), 0);
    const templateReceipt = await service.validate(ctx, 'dm-dvp.template.discipline', template.revision, 'dm-dvp.methods-suite');
    assert.equal(templateReceipt.passed, true);
    assert.equal(templateReceipt.validationScope, 'TOOL_REGRESSION_ONLY');
    assert.equal(templateReceipt.state, 'CANDIDATE');
    assert.equal(service.search(ctx, { topics: ['template'] }).total, 0, 'template 无 ACTIVE 方法');

    // firewhen 窄声明全部被套件覆盖 → 激活并可检索
    const firewhen = service.get(ctx, 'dm-dvp.firewhen.dialect');
    assert.ok((firewhen.claims?.length ?? 0) >= 5);
    const receipt = await service.validate(ctx, 'dm-dvp.firewhen.dialect', firewhen.revision, 'dm-dvp.methods-suite');
    assert.equal(receipt.passed, true);
    assert.equal(receipt.validationScope, 'CONTENT_CLAIMS');
    assert.equal(receipt.state, 'ACTIVE');
    assert.equal(service.search(ctx, { topics: ['firewhen'] }).total, 1);
    const events = service.events(ctx, 'dm-dvp.template.discipline');
    assert.ok(events.items.some((e) => e.operation === 'VALIDATION_SCOPE_INSUFFICIENT'));
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a knowledge whose declared claims are all covered by the installed suite becomes ACTIVE', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dvp-km-claims-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    service.registerValidator(DVP_PLUGIN_ID, dvpMethodSuite);
    service.importSeeds(DVP_PLUGIN_ID, DVP_SEED_VERSION, dvpSeeds);
    const record = service.get(ctx, 'dm-dvp.changemark.format');
    assert.deepEqual(record.claims, ['change-mark action/version', 'change-mark unknown action']);
    const receipt = await service.validate(ctx, 'dm-dvp.changemark.format', record.revision, 'dm-dvp.methods-suite');
    assert.equal(receipt.passed, true);
    assert.equal(receipt.validationScope, 'CONTENT_CLAIMS');
    assert.equal(receipt.state, 'ACTIVE');
    assert.deepEqual(receipt.claims.uncovered, []);
    assert.equal(service.search(ctx, { topics: ['change-mark'] }).items.some((r) => r.knowledgeId === 'dm-dvp.changemark.format'), true);
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('uncovered claims keep the candidate inactive and record the actual scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dvp-km-uncovered-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    service.registerValidator(DVP_PLUGIN_ID, dvpMethodSuite);
    const captured = service.capture(ctx, {
      knowledgeId: 'dm-dvp.changemark.format', scope: 'plugin', pluginId: DVP_PLUGIN_ID, kind: 'scenario_method',
      title: '新增未覆盖声明', problemSignal: 'p', cause: 'c', method: 'm',
      scenarios: ['dvp'], edc: [], topics: ['change-mark'],
      preconditions: ['p'], notApplicable: ['n'], counterexamples: ['c'], sources: ['s'],
      claims: ['change-mark action/version', 'change-mark version-only parsing'],
    });
    const receipt = await service.validate(ctx, 'dm-dvp.changemark.format', captured.revision, 'dm-dvp.methods-suite');
    assert.equal(receipt.passed, true);
    assert.equal(receipt.validationScope, 'TOOL_REGRESSION_ONLY');
    assert.equal(receipt.state, 'CANDIDATE');
    // Coverage is bound to the exact candidate digest; a different revision has no coverage.
    assert.deepEqual(receipt.claims.uncovered, ['change-mark action/version', 'change-mark version-only parsing']);
    service.registerValidator(DVP_PLUGIN_ID, {
      ...dvpMethodSuite,
      id: 'dm-dvp.partial-suite',
      coverage: [{
        knowledgeId: 'dm-dvp.changemark.format',
        candidateDigest: captured.contentDigest,
        claims: ['change-mark action/version'],
      }],
    });
    const partial = await service.validate(ctx, 'dm-dvp.changemark.format', captured.revision, 'dm-dvp.partial-suite');
    assert.deepEqual(partial.claims.uncovered, ['change-mark version-only parsing']);
    assert.equal(partial.state, 'CANDIDATE');
    const events = service.events(ctx, 'dm-dvp.changemark.format');
    assert.ok(events.items.some((e) => e.operation === 'VALIDATION_SCOPE_INSUFFICIENT'));
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('evidence-incomplete candidate refuses activation; suite-mismatched id blocked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dvp-km-guard-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    service.registerValidator(DVP_PLUGIN_ID, dvpMethodSuite);
    const weak = service.capture(ctx, {
      knowledgeId: 'dm-dvp.weak', scope: 'plugin', pluginId: DVP_PLUGIN_ID, kind: 'scenario_method',
      title: '证据缺失', problemSignal: 'x', cause: 'x', method: 'x',
      scenarios: [], edc: [], topics: [], preconditions: [], notApplicable: [], counterexamples: [], sources: [],
    });
    await assert.rejects(
      service.validate(ctx, 'dm-dvp.weak', weak.revision, 'dm-dvp.methods-suite'),
      /KNOWLEDGE_(VALIDATOR_TARGET_MISMATCH|EVIDENCE_INCOMPLETE)/);

    const covered = service.capture(ctx, {
      knowledgeId: 'dm-dvp.template.discipline', scope: 'plugin', pluginId: DVP_PLUGIN_ID, kind: 'scenario_method',
      title: '同 ID 新修订', problemSignal: 'p', cause: 'c', method: 'm',
      scenarios: ['dvp'], edc: [], topics: ['template'],
      preconditions: ['p'], notApplicable: ['n'], counterexamples: ['c'], sources: ['s'],
    });
    const receipt = await service.validate(ctx, 'dm-dvp.template.discipline', covered.revision, 'dm-dvp.methods-suite');
    assert.equal(receipt.passed, true);
    // No claims declared: fixed helper cases cannot stand in for validating the method text.
    assert.equal(receipt.state, 'CANDIDATE');
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});
