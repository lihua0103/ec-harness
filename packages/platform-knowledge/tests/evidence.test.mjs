// M1-03：证据与降级。固定集合/实际返回/最终引用三分；空、撤回、不可见、篡改分别如实标注。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService, digest, reconcileCitations } from '../lib/index.js';

const manualSnapshot = (context, records) => {
  const body = { context, records };
  return { ...body, snapshotDigest: digest(body) };
};
const draft = (overrides = {}) => ({
  knowledgeId: 'evidence.method', scope: 'plugin', pluginId: 'p', kind: 'scenario_method',
  title: '证据方法', problemSignal: 'p', cause: 'c', method: 'm',
  scenarios: [], edc: [], topics: ['evidence'], preconditions: ['p'], notApplicable: ['n'],
  counterexamples: ['c'], sources: ['s'],
  ...overrides,
});

test('evidence separates the bound set, actual returns and final citations', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-evidence-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const ctx = { pluginId: 'p' };
    const empty = service.snapshot(ctx, 'run-empty');
    const emptyPage = service.searchPinned(ctx, empty);
    assert.equal(emptyPage.evidence.status, 'EMPTY');
    assert.equal(emptyPage.evidence.snapshot.total, 0);

    const record = service.capture(ctx, draft());
    const snapshot = manualSnapshot(ctx, [
      { knowledgeId: record.knowledgeId, revision: record.revision, contentDigest: record.contentDigest },
    ]);
    const page = service.searchPinned(ctx, snapshot);
    assert.equal(page.evidence.status, 'BOUND');
    assert.equal(page.evidence.returned.length, 1);
    assert.equal(page.evidence.returned[0].state, 'CANDIDATE');

    const ref = page.evidence.returned[0];
    const first = service.cite(ctx, 'run-1', snapshot, [{ knowledgeId: ref.knowledgeId, revision: ref.revision }]);
    assert.equal(first.recorded.length, 1);
    assert.equal(first.rejected.length, 0);
    const second = service.cite(ctx, 'run-1', snapshot, [{ knowledgeId: ref.knowledgeId, revision: ref.revision }]);
    assert.equal(second.existing.length, 1, '重复引用幂等');
    assert.equal(service.citations(ctx, 'run-1').length, 1);

    const foreign = service.cite(ctx, 'run-1', snapshot, [
      { knowledgeId: 'other.method', revision: 1 },
      { knowledgeId: ref.knowledgeId, revision: ref.revision, contentDigest: 'f'.repeat(64) },
    ]);
    assert.deepEqual(foreign.rejected.map((entry) => entry.reason), ['NOT_IN_SNAPSHOT', 'DIGEST_MISMATCH']);

    // 未引用不等于采纳，未知引用不得冒称来自本次返回。
    assert.equal(reconcileCitations(page.evidence.returned, []).uncited.length, 1);
    const unknown = reconcileCitations(page.evidence.returned, [{ knowledgeId: 'ghost', revision: 1, contentDigest: '0'.repeat(64) }]);
    assert.equal(unknown.unknown.length, 1);
    assert.equal(unknown.uncited.length, 1);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('records outside the authorized context are excluded, not silently widened', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-evidence-scope-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  try {
    const record = service.capture(
      { pluginId: 'p', projectId: 'proj-a' },
      draft({ scope: 'project', projectId: 'proj-a', knowledgeId: 'evidence.project' }),
    );
    // 快照绑定在无项目的平台上下文，回放时项目级记录不可见——绝不扩权返回。
    const snapshot = manualSnapshot({ pluginId: 'p' }, [
      { knowledgeId: record.knowledgeId, revision: record.revision, contentDigest: record.contentDigest },
    ]);
    const page = service.searchPinned({ pluginId: 'p' }, snapshot);
    assert.equal(page.items.length, 0);
    assert.equal(page.evidence.excluded[0].reason, 'NOT_VISIBLE');
    assert.equal(page.evidence.status, 'DEGRADED');
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});