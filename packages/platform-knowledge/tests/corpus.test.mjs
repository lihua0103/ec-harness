// 文档语料（KA10）回归：分块行号、locale、幂等重导、检索与引用定位。纯函数级断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService, chunkMarkdown, detectLocale, documentEntry } from '../lib/index.js';

const MARKDOWN = [
  '# 架构总览', '', '平台统一管理知识库。', '',
  '## 检索管线', 'FTS5 trigram 召回。', '',
  '## 验证', 'claims/coverage 语义。', '',
  '# 附录', '附录正文。',
].join('\n');

test('chunkMarkdown yields heading-scoped chunks with exact line ranges and paths', () => {
  const chunks = chunkMarkdown(MARKDOWN);
  assert.equal(chunks.length, 4);
  const [overview, retrieval, validation, appendix] = chunks;
  assert.equal(overview.heading, '架构总览');
  assert.equal(overview.lineStart, 1);
  assert.equal(overview.lineEnd, 4);
  assert.deepEqual(overview.headingPath, ['架构总览']);
  assert.equal(retrieval.heading, '检索管线');
  assert.equal(retrieval.lineStart, 5);
  assert.equal(retrieval.lineEnd, 7);
  assert.deepEqual(retrieval.headingPath, ['架构总览', '检索管线']);
  assert.equal(appendix.heading, '附录');
  assert.deepEqual(appendix.headingPath, ['附录']);
  assert.ok(overview.body.includes('平台统一管理知识库'));
  // 标题前的序言不成块
  const withPreamble = '序言\n# A\n正文\n';
  assert.equal(chunkMarkdown(withPreamble).length, 1);
});

test('detectLocale distinguishes zh/en by CJK ratio', () => {
  assert.equal(detectLocale('平台统一管理知识库'), 'zh');
  assert.equal(detectLocale('platform knowledge service'), 'en');
  assert.equal(detectLocale('platform 知识库 服务'), 'zh');
});

test('ingestDocument is idempotent and re-ingest replaces chunks when the doc changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-corpus-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const first = service.ingestDocument('docs/architecture.md', MARKDOWN);
    assert.equal(first.skipped, false);
    assert.equal(first.chunks, 4);
    const again = service.ingestDocument('docs/architecture.md', MARKDOWN);
    assert.equal(again.skipped, true, '同 digest 同分片数必须跳过');
    const revised = service.ingestDocument('docs/architecture.md', MARKDOWN + '\n## 新增节\n新正文。\n');
    assert.equal(revised.skipped, false);
    assert.equal(revised.chunks, 5);
    // 检索：FTS 路径命中并给出可点击引用
    const hit = service.searchCorpus({ query: '检索管线' });
    assert.equal(hit.searchMode, 'FTS5_TRIGRAM');
    assert.ok(hit.total >= 1);
    const item = hit.items[0];
    assert.equal(item.docPath, 'docs/architecture.md');
    assert.equal(item.citation, `docs/architecture.md#L${item.lineStart}-L${item.lineEnd}`);
    assert.ok(item.headingPath.includes('检索管线'));
    assert.ok(item.excerpt.includes('FTS5 trigram'));
    // 短词降级为 SQL LIKE
    const short = service.searchCorpus({ query: 'trigram' });
    assert.equal(short.searchMode, 'FTS5_TRIGRAM');
    const short2 = service.searchCorpus({ query: '召回' });
    assert.equal(short2.searchMode, 'SQL_LIKE');
    assert.ok(short2.total >= 1);
    // 未命中如实为零
    assert.equal(service.searchCorpus({ query: '完全不存在的词组' }).total, 0);
    // 路径与正文校验
    assert.throws(() => service.ingestDocument('../escape.md', 'x'), /KNOWLEDGE_DOC_PATH_INVALID/);
    assert.throws(() => service.ingestDocument('docs/a.md', ''), /KNOWLEDGE_DOC_BODY_INVALID/);
    assert.throws(() => service.searchCorpus({ query: '' }), /KNOWLEDGE_QUERY_REQUIRED/);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('documentEntry binds full-text digest and per-chunk locale', () => {
  const entry = documentEntry('docs/architecture.md', MARKDOWN);
  assert.equal(entry.docDigest.length, 64);
  assert.ok(entry.chunks.every((chunk) => ['zh', 'en'].includes(chunk.locale)));
  const english = documentEntry('docs/readme.md', '# Title\nBody text about retrieval pipeline.\n');
  assert.ok(english.chunks.every((chunk) => chunk.locale === 'en'));
});
