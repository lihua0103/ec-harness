// M1-01：服务端范围。工具/插件请求只能收窄可信声明；越界一律拒绝，语料入口按前缀约束。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService, KnowledgeScopeBoundary } from '../lib/index.js';

const draft = (overrides) => ({
  knowledgeId: 'scope.method', scope: 'plugin', pluginId: 'p', kind: 'scenario_method',
  title: '范围方法', problemSignal: 'p', cause: 'c', method: 'm',
  scenarios: [], edc: [], topics: ['scope'], preconditions: ['p'], notApplicable: ['n'],
  counterexamples: ['c'], sources: ['s'],
  ...overrides,
});

test('a scope declaration rejects escalation and project reads outside the declared set', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-scope-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    service.capture(
      { pluginId: 'p', projectId: 'proj-a', orgId: 'org-a' },
      draft({ scope: 'project', projectId: 'proj-a', orgId: 'org-a', knowledgeId: 'scope.a' }),
    );
    service.capture(
      { pluginId: 'p', projectId: 'proj-b', orgId: 'org-a' },
      draft({ scope: 'project', projectId: 'proj-b', orgId: 'org-a', knowledgeId: 'scope.b' }),
    );
    const boundary = new KnowledgeScopeBoundary(service, {
      pluginId: 'p', orgId: 'org-a', projectIds: ['proj-a'], locale: 'zh-CN',
    });

    assert.equal(boundary.context({ projectId: 'proj-a' }).orgId, 'org-a');
    assert.equal(boundary.context({ projectId: 'proj-a' }).locale, 'zh-CN');
    const result = boundary.search({ projectId: 'proj-a' }, { states: ['CANDIDATE'], limit: 100 });
    assert.deepEqual(result.items.map((item) => item.knowledgeId), ['scope.a']);

    assert.throws(() => boundary.search({ projectId: 'proj-b' }), /KNOWLEDGE_PROJECT_OUT_OF_SCOPE/);
    assert.throws(() => boundary.search({ orgId: 'org-b' }), /KNOWLEDGE_SCOPE_ESCALATION/);
    assert.throws(() => boundary.search({ pluginId: 'q' }), /KNOWLEDGE_SCOPE_ESCALATION/);
    assert.throws(() => boundary.search({ region: 'eu' }), /KNOWLEDGE_SCOPE_ESCALATION/);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('corpus entry is constrained to declared prefixes and refuses to search everything by default', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-scope-corpus-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    service.ingestDocument('docs/public.md', '# 公开\n\n平台文档语料包含知识快照说明。');
    service.ingestDocument('private/secret.md', '# 私有\n\n平台文档语料包含知识快照说明。');
    const open = new KnowledgeScopeBoundary(service, { pluginId: 'p', allProjects: true });
    assert.throws(() => open.searchCorpus({ query: '平台文档语料' }), /KNOWLEDGE_CORPUS_SCOPE_REQUIRED/);

    const scoped = new KnowledgeScopeBoundary(service, { pluginId: 'p', allProjects: true, corpusDocPrefixes: ['docs/'] });
    const page = scoped.searchCorpus({ query: '平台文档语料' });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].docPath, 'docs/public.md');
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});