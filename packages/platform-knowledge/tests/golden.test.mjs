// KA15：每插件检索黄金集。查询→期望 knowledgeId 集合；noHitHonesty 与 crossScopeLeak 显式验收。
// 默认使用共享构建产物 lib/index.js；种子从各插件构建后的 lib 读取（verify-all 已先 build 各插件）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KnowledgeService } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const plugin = async (name) => import(pathToFileURL(join(root, 'plugins', name, 'lib', 'index.js')).href);
const platformPackage = async (name) => import(pathToFileURL(join(root, 'packages', name, 'lib', 'index.js')).href);
const ctx = (id) => ({ pluginId: id });

test('KA15 golden sets: every plugin query retrieves its expected method and no unknown hits leak', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pk-golden-'));
  const service = new KnowledgeService(join(tmp, 'knowledge.sqlite'));
  try {
    // 用例声明只有一处来源：各插件 knowledge/manifest.json 的 goldenSet（含 expectEmpty 负例），
    // 本测试按声明执行，避免测试与定义各自漂移。
    const specs = [
      { name: 'dm-listing', id: 'dm-listing', seeds: 'listingSeeds', version: 'LISTING_SEED_VERSION', con: 'listingKnowledgeContribution' },
      { name: 'dm-dvp', id: 'dm-dvp', seeds: 'dvpSeeds', version: 'DVP_SEED_VERSION', con: 'dvpKnowledgeContribution' },
      { name: 'dm-viz', id: 'ec-clinical-dm-viz', seeds: 'vizSeeds', version: 'VIZ_SEED_VERSION', con: 'vizKnowledgeContribution' },
      { name: 'dm-participants', id: 'ec-clinical-dm-participants', seeds: 'ptSeeds', version: 'PT_SEED_VERSION', con: 'ptKnowledgeContribution' },
      { dir: 'packages', name: 'platform-control', id: 'ec-platform-control', seeds: 'controlSeeds', version: 'CONTROL_SEED_VERSION', con: 'controlKnowledgeContribution' },
      { dir: 'packages', name: 'platform-knowledge', id: 'ec-platform-knowledge', seeds: 'knowledgeSeeds', version: 'KNOWLEDGE_SEED_VERSION', con: 'knowledgeKnowledgeContribution' },
      { dir: 'packages', name: 'platform-workbench', id: 'ec-platform-workbench', seeds: 'workbenchSeeds', version: 'WORKBENCH_SEED_VERSION', con: 'workbenchKnowledgeContribution' },
    ];
    for (const spec of specs) {
      const dir = spec.dir ?? 'plugins';
      const manifest = JSON.parse(readFileSync(join(root, dir, spec.name, 'knowledge', 'manifest.json'), 'utf8'));
      const mod = await (dir === 'packages' ? platformPackage(spec.name) : plugin(spec.name));
      service.registerContribution(mod[spec.con]);
      const imported = service.importSeeds(spec.id, mod[spec.version], mod[spec.seeds]);
      assert.equal(imported.conflicts.length, 0, `${spec.name} 种子导入冲突`);
      const context = ctx(spec.id);
      const cases = manifest.goldenSet.cases;
      assert.ok(cases.length > 0, `${spec.name} 黄金集为空`);
      for (const testCase of cases) {
        const result = service.search(context, { query: testCase.query, states: ['ACTIVE', 'CANDIDATE'], limit: 100 });
        if (testCase.expectEmpty) {
          assert.equal(result.total, 0, `${spec.id} 负例「${testCase.query}」不应命中`);
          continue;
        }
        assert.ok(Array.isArray(testCase.expect) && testCase.expect.length > 0, `${spec.id} 黄金用例「${testCase.query}」缺 expect`);
        for (const id of testCase.expect)
          assert.ok(result.items.some((item) => item.knowledgeId === id), `${spec.id} 查询「${testCase.query}」未召回 ${id}`);
      }
      const probe = cases.find((testCase) => !testCase.expectEmpty).query;
      // noHitHonesty：不存在词必须返回 0，不能回落到“最新 N 条”
      const miss = service.search(context, { query: '完全不存在的黄金集探针词', states: ['ACTIVE', 'CANDIDATE'] });
      assert.equal(miss.total, 0, `${spec.id} 未命中不诚实`);
      // crossScopeLeak：其他插件不得看到本插件私有知识
      const foreign = service.search({ pluginId: `${spec.id}-other` }, { query: probe, states: ['ACTIVE', 'CANDIDATE'] });
      assert.ok(!foreign.items.some((item) => mod[spec.seeds].some((seed) => seed.knowledgeId === item.knowledgeId)), `${spec.id} 跨插件泄漏`);
    }
  } finally {
    service.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
