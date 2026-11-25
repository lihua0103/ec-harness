// 平台知识服务自有回归：v1→v2 迁移、FTS5 trigram 召回、降级路径与语义一致性。
// 全部纯函数级断言，不依赖业务插件；从构建产物 lib/index.js 导入（verify 先 build 再 test）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeService, canonical, digest } from '../lib/index.js';

const PLUGIN = 't-plugin';
const ctx = { pluginId: PLUGIN, projectId: 'project-a' };

function draft(id = 'method-a', extra = {}) {
  return {
    knowledgeId: id,
    scope: 'plugin',
    pluginId: PLUGIN,
    kind: 'technical_method',
    title: '重复标记保留所有行',
    problemSignal: '标记被当作筛选',
    cause: '混淆行条件与标记',
    method: '按明确键标记每个重复成员，不筛除其他行',
    scenarios: ['review'],
    edc: [],
    topics: ['row-logic'],
    preconditions: ['需求明确要求重复标记'],
    notApplicable: ['仅输出重复行的筛选需求'],
    counterexamples: ['只保留重复行'],
    sources: ['historical-method/manual'],
    ...extra,
  };
}

test('fresh store opens with FTS5 trigram and full-text recall works for CJK', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-fts-basic-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    assert.equal(service.searchMode, 'FTS5_TRIGRAM', '本构建 FTS5+trigram 应可用');
    service.capture(ctx, draft());
    const hit = service.search(ctx, { states: ['CANDIDATE'], query: '重复标记' });
    assert.equal(hit.searchMode, 'FTS5_TRIGRAM');
    assert.equal(hit.total, 1);
    assert.equal(hit.items[0].knowledgeId, 'method-a');
    // 多词 AND：两个词都 ≥3 码位时仍走 FTS，且全部命中
    const both = service.search(ctx, { states: ['CANDIDATE'], query: '重复标记 所有行' });
    assert.equal(both.searchMode, 'FTS5_TRIGRAM');
    assert.equal(both.total, 1);
    // 未命中必须如实为零，不得回落到“最新 N 条”
    const miss = service.search(ctx, { states: ['CANDIDATE'], query: '完全不存在的词组' });
    assert.equal(miss.searchMode, 'FTS5_TRIGRAM');
    assert.equal(miss.total, 0);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('terms shorter than 3 codepoints or containing quotes degrade to scoped substring with identical results', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-fts-short-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    service.capture(ctx, draft());
    const short = service.search(ctx, { states: ['CANDIDATE'], query: '重复 标记' });
    assert.equal(short.searchMode, 'SCOPED_UNICODE_SUBSTRING', '两码位词必须走降级路径');
    assert.equal(short.total, 1, '降级路径命中语义与 v1 一致');
    const quoted = service.search(ctx, { states: ['CANDIDATE'], query: '"重复标记"' });
    assert.equal(quoted.searchMode, 'SCOPED_UNICODE_SUBSTRING');
    // 引号词不做子串剥离：与 v1 语义一致，含引号的词原样匹配 → 不命中
    assert.equal(quoted.total, 0);
    // 空查询 = 匹配全部（沿用 v1 语义）
    const all = service.search(ctx, { states: ['CANDIDATE'] });
    assert.equal(all.searchMode, 'SCOPED_UNICODE_SUBSTRING');
    assert.equal(all.total, 1);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('scope isolation holds on the FTS path: shared cross-plugin, plugin-private, project-isolated', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-fts-scope-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    service.capture(ctx, draft());
    const other = service.search({ pluginId: 'other-plugin', projectId: 'project-a' }, { states: ['CANDIDATE'], query: '重复标记' });
    assert.equal(other.total, 0, '插件私有知识不得跨插件命中');
    const shared = { ...draft('shared-method'), scope: 'shared' };
    delete shared.pluginId;
    service.capture(ctx, shared);
    assert.equal(
      service.search({ pluginId: 'other-plugin' }, { states: ['CANDIDATE'], query: '重复标记' }).total,
      1,
      'shared 知识对其他插件可见',
    );
    const project = service.capture(ctx, { ...draft('project-decision'), scope: 'project', projectId: 'project-a', kind: 'project_decision' });
    assert.ok(project.revision >= 1);
    const fromOtherProject = service.search({ pluginId: PLUGIN, projectId: 'project-b' }, { states: ['CANDIDATE'], query: '重复标记' });
    // plugin 与 shared 作用域对其他项目可见；project-a 的裁定不得出现在 project-b 上下文
    assert.equal(fromOtherProject.total, 2);
    assert.ok(!fromOtherProject.items.some((item) => item.knowledgeId === 'project-decision'), 'project 作用域不得跨项目命中');
    assert.throws(() => service.get({ pluginId: PLUGIN, projectId: 'project-b' }, 'project-decision'), /KNOWLEDGE_NOT_FOUND/);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('v1 database migrates in place: FTS backfilled, revisions untouched, schema upgraded', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-fts-migrate-'));
  const path = join(root, 'knowledge.sqlite');
  const body = draft();
  const contentDigest = digest(body);
  const raw = new DatabaseSync(path);
  try {
    raw.exec(`CREATE TABLE knowledge_revisions(
      id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,
      scope TEXT NOT NULL,plugin_id TEXT,project_id TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(id,revision),CHECK(state IN ('CANDIDATE','ACTIVE','CONFLICT','SUPERSEDED','REVOKED'))
    ) STRICT;`);
    raw
      .prepare(
        "INSERT INTO knowledge_revisions(id,revision,digest,state,scope,plugin_id,project_id,body,created_at) VALUES(?,?,?,'CANDIDATE','plugin',?,NULL,?,?)",
      )
      .run('method-a', 1, contentDigest, PLUGIN, canonical(body), new Date().toISOString());
    raw.exec('PRAGMA application_id=1162038091; PRAGMA user_version=1;');
  } finally {
    raw.close();
  }
  const service = new KnowledgeService(path);
  try {
    assert.equal(service.searchMode, 'FTS5_TRIGRAM');
    const record = service.get(ctx, 'method-a');
    assert.equal(record.contentDigest, contentDigest, '迁移不得改写既有修订');
    assert.equal(record.revision, 1);
    const hit = service.search(ctx, { states: ['CANDIDATE'], query: '重复标记' });
    assert.equal(hit.searchMode, 'FTS5_TRIGRAM');
    assert.equal(hit.total, 1, '存量修订必须被回填进全文索引');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 6);
    } finally {
      db.close();
    }
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart keeps FTS rows and snapshots; new revisions enter the index on insert', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-fts-restart-'));
  const path = join(root, 'knowledge.sqlite');
  let service = new KnowledgeService(path);
  try {
    service.capture(ctx, draft());
    const snapshot = service.snapshot(ctx, 'run-1');
    service.capture(ctx, { ...draft(), method: '修订后的正文：按明确键标记每个重复成员' }, 1);
    const second = service.search(ctx, { states: ['CANDIDATE'], query: '修订后的正文' });
    assert.equal(second.total, 1, '新修订即时进入全文索引');
    assert.deepEqual(service.snapshot(ctx, 'run-1'), snapshot);
    service.close();
    service = new KnowledgeService(path);
    assert.equal(service.search(ctx, { states: ['CANDIDATE'], query: '重复标记' }).total, 1, '重启后索引持久');
    assert.deepEqual(service.readSnapshot(ctx, 'run-1'), snapshot);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('state filter and newest-eligible dedupe keep v1 semantics on the FTS path', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-fts-state-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    service.capture(ctx, draft());
    // 默认只查 ACTIVE：候选不可见
    assert.equal(service.search(ctx, { query: '重复标记' }).total, 0);
    service.capture(ctx, { ...draft(), method: '修订二：重复标记语义说明文字' }, 1);
    const candidates = service.search(ctx, { states: ['CANDIDATE'], query: '重复标记' });
    // 同一 id 两代修订：新修订先命中并去重，只返回一条
    assert.equal(candidates.total, 1);
    assert.equal(candidates.items[0].revision, 2);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
