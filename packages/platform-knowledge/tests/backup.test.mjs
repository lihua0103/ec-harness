// KA16：一致备份与恢复冒烟。备份必须包含修订、全文索引、标签、语料分片与快照；恢复后摘要可用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeService, computeSnapshotDigest } from '../lib/index.js';

test('KA16: VACUUM INTO backup restores revisions/FTS/chunks/snapshots and keeps digests', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-backup-'));
  const source = join(root, 'knowledge.sqlite');
  const backup = join(root, 'backup.sqlite');
  let service = new KnowledgeService(source);
  try {
    service.capture({ pluginId: 'p' }, {
      knowledgeId: 'backup.method', scope: 'plugin', pluginId: 'p', kind: 'scenario_method',
      title: '备份一致性', problemSignal: 'p', cause: 'c', method: 'VACUUM INTO consistent backup',
      scenarios: [], edc: [], topics: ['backup'], preconditions: ['p'], notApplicable: ['n'],
      counterexamples: ['c'], sources: ['s'],
    });
    service.ingestDocument('docs/example.md', '# 备份\n\nVACUUM INTO 一致性。\n');
    const snapshot = service.snapshot({ pluginId: 'p' }, 'run-backup');
    service.backup(backup);
    assert.ok(statSync(backup).size > 0);
    service.close();
    service = new KnowledgeService(backup);
    const record = service.get({ pluginId: 'p' }, 'backup.method');
    assert.equal(record.method, 'VACUUM INTO consistent backup');
    assert.equal(service.search({ pluginId: 'p' }, { states: ['CANDIDATE'], query: 'consistent backup' }).total, 1);
    assert.equal(service.searchCorpus({ query: 'VACUUM INTO' }).total, 1);
    assert.deepEqual(service.readSnapshot({ pluginId: 'p' }, 'run-backup'), snapshot);
    const readonly = computeSnapshotDigest(backup, { pluginId: 'p' });
    assert.ok(readonly);
    const db = new DatabaseSync(backup, { readOnly: true });
    try {
      assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 5);
      assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM knowledge_chunks').get().n), 1);
    } finally {
      db.close();
    }
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
