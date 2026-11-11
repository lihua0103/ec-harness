/** Durable, owner-scoped synthetic task state with optimistic transactions. Not a data sandbox. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ListingError } from './workbook.js';

export interface Snapshot { id: string; revision: number; payload: string; }
export class TaskStore {
  private readonly db: DatabaseSync;
  private closed = false;
  private closing = false;
  private operations = 0;
  /** Keep the connection lease until asynchronous filesystem operations have also settled. */
  async withOperation<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) throw new ListingError('STORE_CLOSING');
    this.operations++;
    try { return await action(); }
    finally { this.operations--; if (this.closing && this.operations === 0) this.finishClose(); }
  }
  constructor(root: string, private readonly owner: string) {
    if (!owner || owner.length > 512) throw new ListingError('INVALID_TASK_OWNER');
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) throw new ListingError('STORE_PATH_CHANGED');
    let db: DatabaseSync | undefined;
    try {
      const path = join(root, 'tasks.sqlite');
      try { if (lstatSync(path).isSymbolicLink()) throw new ListingError('STORE_PATH_CHANGED'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      db = new DatabaseSync(path, { allowExtension: false });
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > 1) throw new ListingError('STORE_VERSION_UNSUPPORTED');
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), payload TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS task_events (sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL, owner TEXT NOT NULL, revision INTEGER NOT NULL, operation TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
        PRAGMA user_version=1; COMMIT;`);
      this.db = db;
    } catch (error) {
      try { db?.close(); } finally { }
      throw error;
    }
  }
  get(id: string): Snapshot | undefined {
    const row = this.db.prepare('SELECT id, revision, payload FROM tasks WHERE id=? AND owner=?').get(id, this.owner);
    return row ? { id: String(row.id), revision: Number(row.revision), payload: String(row.payload) } : undefined;
  }
  list(): Array<{id: string; revision: number}> {
    return this.db.prepare('SELECT id, revision FROM tasks WHERE owner=? ORDER BY id').all(this.owner)
      .map(row => ({ id: String(row.id), revision: Number(row.revision) }));
  }
  save(id: string, expectedRevision: number, payload: string, operation: string): number {
    if (Buffer.byteLength(payload) > 32 * 1024 * 1024) throw new ListingError('TASK_STATE_TOO_LARGE');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const revision = expectedRevision + 1;
      if (expectedRevision === 0) {
        this.db.prepare('INSERT INTO tasks(id,owner,revision,payload) VALUES(?,?,?,?)').run(id, this.owner, revision, payload);
      } else {
        const result = this.db.prepare('UPDATE tasks SET revision=?,payload=? WHERE id=? AND owner=? AND revision=?').run(revision, payload, id, this.owner, expectedRevision);
        if (Number(result.changes) !== 1) throw new ListingError('TASK_VERSION_STALE');
      }
      this.db.prepare('INSERT INTO task_events(task_id,owner,revision,operation,created_at) VALUES(?,?,?,?,?)').run(id, this.owner, revision, operation, new Date().toISOString());
      this.db.exec('COMMIT');
      return revision;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private finishClose(): void {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }
  close(): void {
    this.closing = true;
    if (this.operations === 0) this.finishClose();
  }
}
