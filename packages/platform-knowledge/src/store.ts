import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, digest, normalizeDraft, type KnowledgeDraft, type KnowledgeRecord, type State } from './schema.js';
const APPLICATION_ID = 1162038091;
export class KnowledgeStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    let existing = false;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('KNOWLEDGE_STORE_PATH_INVALID');
      existing = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const identity = (db: DatabaseSync) => {
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version),
        id = Number(db.prepare('PRAGMA application_id').get()!.application_id);
      if (
        version === 0 &&
        id === 0 &&
        db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().length === 0
      )
        return;
      if (version !== 1 || id !== APPLICATION_ID) throw new Error('KNOWLEDGE_STORE_IDENTITY_MISMATCH');
    };
    if (existing) {
      const probe = new DatabaseSync(path, { readOnly: true, allowExtension: false });
      try {
        identity(probe);
      } finally {
        probe.close();
      }
    }
    this.db = new DatabaseSync(path, { allowExtension: false });
    try {
      this.db.exec('PRAGMA busy_timeout=5000');
      identity(this.db);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      identity(this.db);
      this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_revisions(
        id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,
        scope TEXT NOT NULL,plugin_id TEXT,project_id TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(id,revision),CHECK(state IN ('CANDIDATE','ACTIVE','CONFLICT','SUPERSEDED','REVOKED'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_events(sequence INTEGER PRIMARY KEY,id TEXT NOT NULL,revision INTEGER NOT NULL,operation TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_validations(id TEXT PRIMARY KEY,knowledge_id TEXT NOT NULL,revision INTEGER NOT NULL,candidate_digest TEXT NOT NULL,body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_seed_imports(plugin_id TEXT NOT NULL,package_version TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(plugin_id,package_version)) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_seed_states(plugin_id TEXT NOT NULL,knowledge_id TEXT NOT NULL,digest TEXT NOT NULL,package_version TEXT NOT NULL,PRIMARY KEY(plugin_id,knowledge_id)) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_snapshots(id TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT;
      PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = action();
      this.db.exec('COMMIT');
      return r;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  event(id: string, revision: number, operation: string, details: unknown): void {
    this.db
      .prepare('INSERT INTO knowledge_events(id,revision,operation,details,created_at) VALUES(?,?,?,?,?)')
      .run(id, revision, operation, canonical(details), new Date().toISOString());
  }
  private decode(row: Record<string, unknown>): KnowledgeRecord {
    const body = normalizeDraft(JSON.parse(String(row.body)));
    if (
      digest(body) !== row.digest ||
      body.knowledgeId !== row.id ||
      body.scope !== row.scope ||
      (body.pluginId ?? null) !== row.plugin_id ||
      (body.projectId ?? null) !== row.project_id
    )
      throw new Error('KNOWLEDGE_RECORD_CHANGED');
    return {
      ...body,
      revision: Number(row.revision),
      contentDigest: String(row.digest),
      state: String(row.state) as State,
      createdAt: String(row.created_at),
    };
  }
  get(id: string, revision?: number): KnowledgeRecord | undefined {
    const row =
      revision === undefined
        ? this.db.prepare('SELECT * FROM knowledge_revisions WHERE id=? ORDER BY revision DESC LIMIT 1').get(id)
        : this.db.prepare('SELECT * FROM knowledge_revisions WHERE id=? AND revision=?').get(id, revision);
    return row ? this.decode(row) : undefined;
  }
  /** Scope filtering occurs in SQL before bodies are loaded or text searched. */
  scoped(pluginId: string, projectId?: string): KnowledgeRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM knowledge_revisions WHERE scope='shared' OR
      (plugin_id=? AND scope='plugin') OR (plugin_id=? AND project_id=? AND scope='project') ORDER BY id,revision DESC`,
      )
      .all(pluginId, pluginId, projectId ?? '')
      .map((row) => this.decode(row));
  }
  insert(value: KnowledgeDraft, expectedRevision: number): KnowledgeRecord {
    const body = normalizeDraft(value),
      previous = this.get(body.knowledgeId);
    if ((previous?.revision ?? 0) !== expectedRevision) throw new Error('KNOWLEDGE_REVISION_STALE');
    if (
      previous &&
      (previous.scope !== body.scope || previous.pluginId !== body.pluginId || previous.projectId !== body.projectId)
    )
      throw new Error('KNOWLEDGE_PROMOTION_REQUIRES_NEW_ID');
    const hash = digest(body);
    if (previous?.contentDigest === hash) return previous;
    const revision = expectedRevision + 1,
      createdAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO knowledge_revisions(id,revision,digest,state,scope,plugin_id,project_id,body,created_at) VALUES(?,?,?,'CANDIDATE',?,?,?,?,?)",
      )
      .run(
        body.knowledgeId,
        revision,
        hash,
        body.scope,
        body.pluginId ?? null,
        body.projectId ?? null,
        canonical(body),
        createdAt,
      );
    this.event(body.knowledgeId, revision, 'CANDIDATE_CAPTURED', { contentDigest: hash });
    return { ...body, revision, contentDigest: hash, state: 'CANDIDATE', createdAt };
  }
  setState(id: string, revision: number, state: State, details: unknown): void {
    const record = this.get(id, revision);
    if (!record) throw new Error('KNOWLEDGE_NOT_FOUND');
    this.db.prepare('UPDATE knowledge_revisions SET state=? WHERE id=? AND revision=?').run(state, id, revision);
    this.event(id, revision, state, details);
  }
  supersedeActive(id: string, exceptRevision: number): void {
    for (const row of this.db
      .prepare("SELECT revision FROM knowledge_revisions WHERE id=? AND state='ACTIVE' AND revision!=?")
      .all(id, exceptRevision)) {
      this.setState(id, Number(row.revision), 'SUPERSEDED', { replacement: exceptRevision });
    }
  }
  validation(id: string, record: KnowledgeRecord, body: unknown): void {
    this.db
      .prepare('INSERT INTO knowledge_validations(id,knowledge_id,revision,candidate_digest,body) VALUES(?,?,?,?,?)')
      .run(id, record.knowledgeId, record.revision, record.contentDigest, canonical(body));
  }
  countEvents(id: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM knowledge_events WHERE id=?').get(id);
    return Number(row?.total ?? 0);
  }
  /** Newest-first event feed for one knowledge id; the caller owns visibility checks. */
  recentEvents(
    id: string,
    offset: number,
    limit: number,
  ): Array<{ sequence: number; id: string; revision: number; operation: string; details: unknown; createdAt: string }> {
    return (
      this.db
        .prepare('SELECT * FROM knowledge_events WHERE id=? ORDER BY sequence DESC LIMIT ? OFFSET ?')
        .all(id, limit, offset) as Array<Record<string, unknown>>
    ).map((row) => ({
      sequence: Number(row.sequence),
      id: String(row.id),
      revision: Number(row.revision),
      operation: String(row.operation),
      details: JSON.parse(String(row.details)),
      createdAt: String(row.created_at),
    }));
  }
  seedImport(pluginId: string, version: string, hash: string): 'new' | 'existing' {
    const row = this.db
      .prepare('SELECT digest FROM knowledge_seed_imports WHERE plugin_id=? AND package_version=?')
      .get(pluginId, version);
    if (row) {
      if (row.digest !== hash) throw new Error('KNOWLEDGE_SEED_VERSION_CHANGED');
      return 'existing';
    }
    this.db
      .prepare('INSERT INTO knowledge_seed_imports(plugin_id,package_version,digest) VALUES(?,?,?)')
      .run(pluginId, version, hash);
    return 'new';
  }
  seedState(pluginId: string, knowledgeId: string): { digest: string; packageVersion: string } | undefined {
    const row = this.db
      .prepare('SELECT digest,package_version FROM knowledge_seed_states WHERE plugin_id=? AND knowledge_id=?')
      .get(pluginId, knowledgeId);
    return row ? { digest: String(row.digest), packageVersion: String(row.package_version) } : undefined;
  }
  setSeedState(pluginId: string, knowledgeId: string, digest: string, packageVersion: string): void {
    this.db
      .prepare(
        'INSERT INTO knowledge_seed_states(plugin_id,knowledge_id,digest,package_version) VALUES(?,?,?,?) ON CONFLICT(plugin_id,knowledge_id) DO UPDATE SET digest=excluded.digest,package_version=excluded.package_version',
      )
      .run(pluginId, knowledgeId, digest, packageVersion);
  }
  saveSnapshot(id: string, body: unknown): void {
    const json = canonical(body),
      previous = this.db.prepare('SELECT body FROM knowledge_snapshots WHERE id=?').get(id);
    if (previous && previous.body !== json) throw new Error('KNOWLEDGE_SNAPSHOT_IMMUTABLE');
    if (!previous) this.db.prepare('INSERT INTO knowledge_snapshots(id,body) VALUES(?,?)').run(id, json);
  }
  snapshot(id: string): unknown {
    const row = this.db.prepare('SELECT body FROM knowledge_snapshots WHERE id=?').get(id);
    if (!row) throw new Error('KNOWLEDGE_SNAPSHOT_NOT_FOUND');
    return JSON.parse(String(row.body));
  }
}
