// dm-viz 知识沉淀回归：种子导入、作用域检索、manifest 与代码注册面一致。纯函数级断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../../../packages/platform-knowledge/src/service.js';
import {
  vizSeeds,
  vizKnowledgeContribution,
  VIZ_PLUGIN_ID,
  VIZ_SEED_VERSION,
  VIZ_TOPICS,
} from '../src/knowledge-seeds.js';

const ctx = { pluginId: VIZ_PLUGIN_ID };
interface ManifestSeed { knowledgeId: string; topics: string[] }
interface ManifestEntry { tool: string; topics?: string[]; reason?: string }
interface Manifest { pluginId: string; taxonomy: { topics: string[] }; seeds: ManifestSeed[]; capabilities: ManifestEntry[]; noMethodKnowledge: ManifestEntry[] }
const manifest = JSON.parse(readFileSync(new URL('../knowledge/manifest.json', import.meta.url), 'utf8')) as Manifest;

test('viz seeds import as CANDIDATE and every manifest topic resolves at least one seed', () => {
  const root = mkdtempSync(join(tmpdir(), 'viz-km-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    service.registerContribution(vizKnowledgeContribution);
    const imported = service.importSeeds(VIZ_PLUGIN_ID, VIZ_SEED_VERSION, vizSeeds);
    assert.equal(imported.conflicts.length, 0);
    assert.equal(imported.imported, vizSeeds.length);
    for (const seed of vizSeeds) assert.equal(service.get(ctx, seed.knowledgeId).state, 'CANDIDATE');
    for (const topic of VIZ_TOPICS) {
      const result = service.search(ctx, { states: ['ACTIVE', 'CANDIDATE'], topics: [topic], limit: 100 });
      assert(result.items.length >= 1, `topic ${topic} 没有可解析的方法知识`);
    }
    // 全文检索可命中方法正文（FTS5 trigram 路径）
    const hit = service.search(ctx, { states: ['CANDIDATE'], query: '确定性管线' });
    assert.equal(hit.total, 1);
    assert.equal(hit.items[0].knowledgeId, 'dm-viz.design.pipeline');
    // 跨插件隔离：其他插件检索不到 viz 私有知识
    assert.equal(service.search({ pluginId: 'other-plugin' }, { states: ['CANDIDATE'], query: '确定性管线' }).total, 0);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifest matches the registered seeds and covers every registered business tool', () => {
  assert.equal(manifest.pluginId, VIZ_PLUGIN_ID);
  const manifestIds = manifest.seeds.map((entry) => entry.knowledgeId).sort();
  assert.deepEqual(manifestIds, vizSeeds.map((seed) => seed.knowledgeId).sort());
  // manifest 声明的每个主题都有种子支撑
  const seedTopics = new Set(vizSeeds.flatMap((seed) => seed.topics));
  for (const topic of manifest.taxonomy.topics) assert.ok(seedTopics.has(topic), `taxonomy topic ${topic} 无种子支撑`);
  // 源码注册的工具必须全部被 manifest 覆盖（capabilities 或 noMethodKnowledge）
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
