import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evidenceLabel,
  exclusionLines,
  returnedLines,
  snapshotLine,
  type KnowledgeEvidenceView,
} from '../src/client/knowledge-evidence.js';

test('an unbound run says so instead of showing zero knowledge', () => {
  assert.match(snapshotLine(undefined), /未绑定/);
});

test('a bound snapshot shows digest, count and the re-playable record count', () => {
  const line = snapshotLine({
    snapshotDigest: 'a'.repeat(64),
    total: 3,
    pluginId: 'dm-listing',
    boundAt: '2026-11-20T09:00:00.000Z',
    records: [{ knowledgeId: 'dm-listing.review.methods', revision: 2, contentDigest: 'b'.repeat(64) }],
  });
  assert.match(line, /dm-listing/);
  assert.match(line, /3 条/);
  assert.match(line, /可重放 1 条/);
  assert.match(line, /aaaaaaaaaaaa/);
});

const evidence = (overrides: Partial<KnowledgeEvidenceView> = {}): KnowledgeEvidenceView => ({
  status: 'BOUND',
  snapshot: { digest: 'a'.repeat(64), total: 2 },
  returned: [{ knowledgeId: 'dm-listing.pk.common', revision: 1 }],
  excluded: [],
  ...overrides,
});

test('each evidence status keeps its own wording; none collapses into success', () => {
  const labels = (['BOUND', 'EMPTY', 'DEGRADED', 'UNBOUND'] as const).map((status) =>
    evidenceLabel(evidence({ status })),
  );
  assert.equal(new Set(labels).size, 4, '四种状态必须可区分');
  assert.match(labels[1], /无命中/);
  assert.match(labels[3], /未绑定/);
});

test('exclusions are grouped by reason and never hidden', () => {
  const lines = exclusionLines(evidence({
    status: 'DEGRADED',
    excluded: [
      { knowledgeId: 'k-1', revision: 1, reason: 'REVOKED' },
      { knowledgeId: 'k-2', revision: 4, reason: 'NOT_VISIBLE' },
      { knowledgeId: 'k-3', revision: 2, reason: 'REVOKED' },
    ],
  }));
  assert.deepEqual(lines, ['无权限（未可见）：k-2@4', '已撤回：k-1@1、k-3@2']);
});

test('returned refs are listed for citation reconciliation', () => {
  assert.deepEqual(returnedLines(evidence()), ['dm-listing.pk.common@1']);
});