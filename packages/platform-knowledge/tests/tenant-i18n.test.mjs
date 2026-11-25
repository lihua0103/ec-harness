// KA07/08/09：租户/区域隔离、i18n 别名召回、eventRef 校验。纯函数级断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../lib/index.js';

const base = (id, extra = {}) => ({
  knowledgeId: id, scope: 'plugin', pluginId: 'p', kind: 'scenario_method',
  title: '重复标记保留所有行', problemSignal: '标记被当作筛选', cause: '混淆语义',
  method: '按明确键标记每个重复成员', scenarios: [], edc: [], topics: ['row-logic'],
  preconditions: ['p'], notApplicable: ['n'], counterexamples: ['c'], sources: ['s'], ...extra,
});

test('orgId/region from trusted context are stamped on capture and isolate retrieval', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-tenant-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const ctxA = { pluginId: 'p', orgId: 'acme', region: 'eu' };
    const ctxB = { pluginId: 'p', orgId: 'other', region: 'eu' };
    const ctxC = { pluginId: 'p', orgId: 'acme', region: 'cn' };
    const rec = service.capture(ctxA, base('tenant.method'));
    assert.equal(rec.orgId, 'acme');
    assert.equal(rec.region, 'eu');
    assert.equal(service.get(ctxA, 'tenant.method').knowledgeId, 'tenant.method');
    assert.throws(() => service.get(ctxB, 'tenant.method'), /KNOWLEDGE_NOT_FOUND/);
    assert.throws(() => service.get(ctxC, 'tenant.method'), /KNOWLEDGE_NOT_FOUND/);
    // 伪造草稿 orgId 与可信上下文不一致 → 拒绝写入
    assert.throws(() => service.capture(ctxA, base('forged', { orgId: 'other' })), /KNOWLEDGE_CONTEXT_MISMATCH/);
    assert.throws(() => service.capture(ctxA, base('forged-region', { region: 'cn' })), /KNOWLEDGE_CONTEXT_MISMATCH/);
    // shared 记录也必须满足租户过滤（平台租户归属）
    service.capture(ctxA, { ...base('shared.method'), scope: 'shared', pluginId: undefined, orgId: 'acme', region: 'eu' });
    assert.equal(service.search(ctxB, { states: ['CANDIDATE'], query: '重复标记' }).total, 0);
    assert.equal(service.search(ctxA, { states: ['CANDIDATE'], query: '重复标记' }).items.length, 2);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('i18n aliases enable cross-language recall and locale field is validated', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-i18n-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    service.capture({ pluginId: 'p' }, base('i18n.method', {
      i18n: {
        primaryLocale: 'zh-CN', locales: ['zh-CN', 'en-US'],
        aliases: { 'en-US': ['duplicate marker'], 'zh-CN': ['重复标记'] },
      },
    }));
    const hit = service.search({ pluginId: 'p' }, { states: ['CANDIDATE'], query: 'duplicate marker' });
    assert.equal(hit.searchMode, 'FTS5_TRIGRAM');
    assert.equal(hit.total, 1, '英文别名应召回中文主语言记录');
    assert.deepEqual(service.get({ pluginId: 'p' }, 'i18n.method').i18n.aliases['en-US'], ['duplicate marker']);
    // 译文状态、locale 格式校验
    assert.throws(() => service.capture({ pluginId: 'p' }, base('bad-i18n', {
      i18n: { primaryLocale: '!!', locales: [], aliases: {} },
    })), /KNOWLEDGE_I18N_INVALID/);
    assert.throws(() => service.capture({ pluginId: 'p', locale: 'bad locale' }, base('bad-locale')), /KNOWLEDGE_LOCALE_INVALID/);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('eventRef binds a candidate to a real run event and rejects fabricated digests', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-eventref-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const rec = service.capture({ pluginId: 'p' }, base('event.method', {
      eventRef: {
        kind: 'qc.completed', runId: 'run-123',
        inputDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64), at: new Date().toISOString(),
      },
    }));
    assert.equal(rec.eventRef.kind, 'qc.completed');
    assert.equal(rec.eventRef.runId, 'run-123');
    assert.throws(() => service.capture({ pluginId: 'p' }, base('bad-ref', {
      eventRef: { kind: 'run.failed', runId: 'r', inputDigest: 'not-a-digest' },
    })), /KNOWLEDGE_EVENT_REF_INVALID/);
    assert.throws(() => service.capture({ pluginId: 'p' }, base('bad-kind', {
      eventRef: { kind: 'model.self_report', runId: 'r' },
    })), /KNOWLEDGE_EVENT_REF_INVALID/);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
