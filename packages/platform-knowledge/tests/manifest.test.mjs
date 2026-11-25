// M2-01：智能体注册合同。定义必须完整可验收；版本并存、显式激活、重复/冲突/停用行为可追踪。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKnowledgeManifest, manifestDigest, KnowledgeAgentRegistry, KnowledgeService } from '../lib/index.js';

const base = (overrides = {}) => ({
  schemaVersion: 2,
  pluginId: 'p',
  owner: 'P 维护者',
  source: 'src/knowledge-seeds.ts',
  taxonomy: { topics: ['t1', 't2'] },
  seeds: [{ knowledgeId: 'p.one', topics: ['t1'], claims: 1, validator: 'p-suite' }],
  validators: [{ id: 'p-suite', version: '1.0.0', covers: ['p.one'] }],
  capabilities: [{ tool: 'p_status', topics: ['t2'] }],
  noMethodKnowledge: [{ tool: 'p_ping', reason: '健康检查无方法语义' }],
  agent: {
    id: 'p.agent',
    version: '1.0.0',
    owner: 'P 维护者',
    topics: ['t1', 't2'],
    tools: [{ tool: 'p_status', topics: ['t2'] }],
    noMethodTools: [{ tool: 'p_ping', reason: '健康检查无方法语义' }],
  },
  feedback: { events: ['run.failed', 'qc.completed'], projectionVersion: '1' },
  goldenSet: { id: 'p.golden', version: '1', cases: [{ query: 't1 方法', expect: ['p.one'] }] },
  scope: { orgId: 'org-a', projects: ['proj-a'] },
  ...overrides,
});

test('a complete agent manifest parses, freezes and digests deterministically', () => {
  const manifest = parseKnowledgeManifest(base());
  assert.equal(manifest.agent.id, 'p.agent');
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(manifestDigest(parseKnowledgeManifest(base())), manifestDigest(manifest));
});

test('incomplete or unknown manifest declarations are rejected, never silently completed', () => {
  assert.throws(() => parseKnowledgeManifest(base({ schemaVersion: 1 })), /KNOWLEDGE_MANIFEST_SCHEMA_UNSUPPORTED/);
  assert.throws(() => parseKnowledgeManifest(base({ unexpected: true })), /KNOWLEDGE_MANIFEST_UNKNOWN_FIELD/);
  assert.throws(
    () => parseKnowledgeManifest(base({ goldenSet: { id: 'g', version: '1', cases: [] } })),
    /KNOWLEDGE_MANIFEST_GOLDEN_INVALID/,
  );
  assert.throws(
    () => parseKnowledgeManifest(base({ validators: [{ id: 'other', version: '1', covers: ['p.one'] }] })),
    /KNOWLEDGE_MANIFEST_VALIDATOR_UNBOUND/,
  );
  assert.throws(
    () => parseKnowledgeManifest(base({ seeds: [], capabilities: [] })),
    /KNOWLEDGE_MANIFEST_EMPTY/,
  );
  assert.throws(
    () => parseKnowledgeManifest(base({ scope: {} })),
    /KNOWLEDGE_MANIFEST_SCOPE_INVALID/,
  );
});

test('registry keeps versions side by side, activates explicitly and rejects same-version conflicts', () => {
  const registry = new KnowledgeAgentRegistry();
  const first = registry.register(base());
  assert.equal(first.status, 'REGISTERED');
  assert.equal(registry.activeVersion('p'), '1.0.0');

  const second = registry.register(base({ agent: { ...base().agent, version: '2.0.0' } }));
  assert.equal(second.status, 'REGISTERED');
  // 新版本不会自动成为 Run 的默认解析目标。
  assert.equal(registry.resolve('p').agent.version, '1.0.0');
  registry.activate('p', '2.0.0');
  assert.equal(registry.resolve('p').agent.version, '2.0.0');
  assert.equal(registry.resolve('p', '1.0.0').agent.version, '1.0.0');

  const duplicate = registry.register(base());
  assert.equal(duplicate.status, 'EXISTING');
  assert.throws(
    () => registry.register(base({ owner: '另一个维护者' })),
    /KNOWLEDGE_AGENT_VERSION_CONFLICT/,
  );
  assert.throws(() => registry.activate('p', '9.9.9'), /KNOWLEDGE_AGENT_NOT_REGISTERED/);

  assert.equal(registry.unregister('p', '2.0.0'), 1);
  // 停用激活版本后不再残留默认解析目标。
  assert.equal(registry.resolve('p'), undefined);
  assert.equal(registry.resolve('p', '1.0.0').agent.version, '1.0.0');
  // 重装同一版本：重新注册而不是继承停用状态。
  const reinstalled = registry.register(base({ agent: { ...base().agent, version: '2.0.0' } }));
  assert.equal(reinstalled.status, 'REGISTERED');
  assert.equal(registry.resolve('p', '2.0.0').agent.version, '2.0.0');
  assert.equal(registry.list().length, 2);
  assert.ok(registry.history().some((event) => event.operation === 'UNREGISTERED'));
  assert.equal(registry.unregister('unknown'), 0);
});

test('a plugin bundle registration is discoverable and disposal only removes its own version', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-agent-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const dispose = service.registerAgentManifest(base());
    assert.equal(service.agents.list().length, 1);
    assert.equal(service.agents.list()[0].active, true);
    dispose();
    assert.equal(service.agents.list().length, 0);
    assert.equal(service.agents.resolve('p'), undefined);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});