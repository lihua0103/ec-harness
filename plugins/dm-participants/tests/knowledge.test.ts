// dm-participants 知识沉淀回归：种子导入、作用域检索、manifest 与代码注册面一致。纯函数级断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../../../packages/platform-knowledge/src/service.js';
import {
  ptSeeds,
  ptKnowledgeContribution,
  PT_PLUGIN_ID,
  PT_SEED_VERSION,
  PT_TOPICS,
} from '../src/knowledge-seeds.js';

const ctx = { pluginId: PT_PLUGIN_ID };
interface ManifestSeed { knowledgeId: string; topics: string[] }
interface ManifestEntry { tool: string; topics?: string[]; reason?: string }
interface Manifest { pluginId: string; taxonomy: { topics: string[] }; seeds: ManifestSeed[]; capabilities: ManifestEntry[]; noMethodKnowledge: ManifestEntry[] }
const manifest = JSON.parse(readFileSync(new URL('../knowledge/manifest.json', import.meta.url), 'utf8')) as Manifest;

test('participants seeds import as CANDIDATE and every manifest topic resolves at least one seed', () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-km-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    service.registerContribution(ptKnowledgeContribution);
    const imported = service.importSeeds(PT_PLUGIN_ID, PT_SEED_VERSION, ptSeeds);
    assert.equal(imported.conflicts.length, 0);
    assert.equal(imported.imported, ptSeeds.length);
    for (const seed of ptSeeds) assert.equal(service.get(ctx, seed.knowledgeId).state, 'CANDIDATE');
    for (const topic of PT_TOPICS) {
      const result = service.search(ctx, { states: ['ACTIVE', 'CANDIDATE'], topics: [topic], limit: 100 });
      assert(result.items.length >= 1, `topic ${topic} 没有可解析的方法知识`);
    }
    const hit = service.search(ctx, { states: ['CANDIDATE'], query: '原始数据保留' });
    assert.equal(hit.total, 1);
    assert.equal(hit.items[0].knowledgeId, 'dm-participants.channel.pipeline');
    assert.equal(service.search({ pluginId: 'other-plugin' }, { states: ['CANDIDATE'], query: '原始数据保留' }).total, 0);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifest matches the registered seeds and covers every registered business tool', () => {
  assert.equal(manifest.pluginId, PT_PLUGIN_ID);
  const manifestIds = manifest.seeds.map((entry) => entry.knowledgeId).sort();
  assert.deepEqual(manifestIds, ptSeeds.map((seed) => seed.knowledgeId).sort());
  const seedTopics = new Set(ptSeeds.flatMap((seed) => seed.topics));
  for (const topic of manifest.taxonomy.topics) assert.ok(seedTopics.has(topic), `taxonomy topic ${topic} 无种子支撑`);
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const registeredTools = [...source.matchAll(/name:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
  const toolNames = new Set(registeredTools);
  const mapped = new Set([
    ...manifest.capabilities.map((c) => c.tool),
    ...manifest.noMethodKnowledge.map((c) => c.tool),
  ]);
  const metaTool = (name: string) => /_knowledge_(capture|validate|events|search|get|status)$/.test(name);
  for (const tool of toolNames) {
    if (metaTool(tool)) continue;
    assert.ok(mapped.has(tool), `工具 ${tool} 未在 manifest capabilities/noMethodKnowledge 中声明`);
  }
});
