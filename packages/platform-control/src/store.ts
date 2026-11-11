/** Persistent control-plane state: approved application releases, runs, inputs, events and audit.
 *  SQLite is the local single-owner store; a deployment may replace it with its central service. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExecutionPlan } from '../../platform-runtime/src/plan.js';
import type { RunEvent, RunSnapshot } from '../../platform-runtime/src/run.js';

export const CONTROL_APPLICATION_ID = 1162038092;

export interface AppReleaseDraft {
  descriptor: {
    appId: string;
    version: string;
    displayName: string;
    description: string;
    listingTypes?: string[];
    materialRoles?: string[];
    resultTypes?: string[];
  };
  requiredCapabilities: Array<{ capabilityId: string; version: string }>;
  providers: Array<{
    capabilityId: string;
    version: string;
    pluginId: string;
    pluginVersion: string;
    artifactDigest: string;
    protocolVersion: string;
    inputSchemaVersion: string;
    outputSchemaVersion: string;
    dependencies: Array<{ capabilityId: string; version: string }>;
  }>;
  runtimeBundleDigest: string;
}
export type AppState = 'ACTIVE' | 'REVOKED';
export interface StoredAppBody {
  draft: AppReleaseDraft;
  plan: ExecutionPlan;
  releaseDigest: string;
}
export interface AppRecord extends StoredAppBody {
  appId: string;
  appVersion: string;
  state: AppState;
  createdAt: string;
  revokedAt?: string;
  revokeReason?: string;
}
export interface RunRecord {
  runId: string;
  appId: string;
  appVersion: string;
  releaseDigest: string;
  planDigest: string;
  inputDigest: string;
  input: unknown;
  snapshot: RunSnapshot;
  createdAt: string;
  updatedAt: string;
}
export interface AuditEntry {
  sequence: number;
  actor: string;
  action: string;
  target: string;
  details: unknown;
  createdAt: string;
}
export interface ArtifactRecord {
  name: string;
  digest: string;
  bytes: number;
  mediaType?: string;
  createdAt: string;
}
export type InputState = 'PENDING' | 'CONSUMED' | 'UNKNOWN' | 'NOT_SENT' | 'DEFERRED';
export interface InputCommit {
  commitId: string;
  runId: string;
  sequence: number;
  contentDigest: string;
  body: unknown;
  state: InputState;
  createdAt: string;
}
export type AttemptState = 'STARTING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
export interface LaunchAttempt {
  launchId: string;
  runId: string;
  fencingToken: number;
  state: AttemptState;
  startedAt: string;
  endedAt?: string;
  detail?: string;
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    }
    return item;
  });

export class PlatformStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    let existing = false;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('PLATFORM_STORE_PATH_INVALID');
      existing = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const identity = (db: DatabaseSync): void => {
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
      const id = Number(db.prepare('PRAGMA application_id').get()!.application_id);
      if (version === 0 && id === 0) return;
      if (version !== 1 || id !== CONTROL_APPLICATION_ID) throw new Error('PLATFORM_STORE_IDENTITY_MISMATCH');
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
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS app_releases(
          app_id TEXT NOT NULL,
          app_version TEXT NOT NULL,
          release_digest TEXT NOT NULL,
          state TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          revoke_reason TEXT,
          PRIMARY KEY(app_id, app_version),
          CHECK(state IN ('ACTIVE','REVOKED'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS runs(
          run_id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          app_version TEXT NOT NULL,
          release_digest TEXT NOT NULL,
          plan_digest TEXT NOT NULL,
          state TEXT NOT NULL,
          revision INTEGER NOT NULL,
          input_digest TEXT NOT NULL,
          input_body TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS run_events(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          event TEXT NOT NULL,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS run_artifacts(
          run_id TEXT NOT NULL,
          name TEXT NOT NULL,
          digest TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          media_type TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY(run_id, name)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS run_inputs(
          commit_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          content_digest TEXT NOT NULL,
          body TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(run_id, sequence),
          CHECK(state IN ('PENDING','CONSUMED','UNKNOWN','NOT_SENT','DEFERRED'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS launch_attempts(
          launch_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          fencing_token INTEGER NOT NULL,
          state TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          detail TEXT,
          CHECK(state IN ('STARTING','RUNNING','SUCCEEDED','FAILED','CANCELLED','UNKNOWN'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS audit_events(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT NOT NULL,
          details TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        PRAGMA application_id=${CONTROL_APPLICATION_ID};
        PRAGMA user_version=1;
        COMMIT;
      `);
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
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  audit(actor: string, action: string, target: string, details: unknown): void {
    this.db
      .prepare('INSERT INTO audit_events(actor,action,target,details,created_at) VALUES(?,?,?,?,?)')
      .run(actor, action, target, canonical(details), new Date().toISOString());
  }
  auditList(offset: number, limit: number): { items: AuditEntry[]; total: number } {
    const rows = this.db
      .prepare('SELECT * FROM audit_events ORDER BY sequence DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Array<Record<string, unknown>>;
    const total = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count,
    );
    return {
      total,
      items: rows.map((row) => ({
        sequence: Number(row.sequence),
        actor: String(row.actor),
        action: String(row.action),
        target: String(row.target),
        details: JSON.parse(String(row.details)),
        createdAt: String(row.created_at),
      })),
    };
  }
  appGet(appId: string, appVersion?: string): AppRecord | undefined {
    const row = appVersion
      ? this.db.prepare('SELECT * FROM app_releases WHERE app_id=? AND app_version=?').get(appId, appVersion)
      : this.db
          .prepare('SELECT * FROM app_releases WHERE app_id=? ORDER BY created_at DESC, app_version DESC LIMIT 1')
          .get(appId);
    return row ? this.decodeApp(row as Record<string, unknown>) : undefined;
  }
  appActive(appId: string, appVersion: string): AppRecord | undefined {
    const record = this.appGet(appId, appVersion);
    return record?.state === 'ACTIVE' ? record : undefined;
  }
  appList(state?: AppState): AppRecord[] {
    const rows = state
      ? this.db.prepare('SELECT * FROM app_releases WHERE state=? ORDER BY app_id, app_version').all(state)
      : this.db.prepare('SELECT * FROM app_releases ORDER BY app_id, app_version').all();
    return (rows as Array<Record<string, unknown>>).map((row) => this.decodeApp(row));
  }
  appInsert(app: AppRecord): void {
    this.db
      .prepare('INSERT INTO app_releases(app_id,app_version,release_digest,state,body,created_at) VALUES(?,?,?,?,?,?)')
      .run(app.appId, app.appVersion, app.releaseDigest, app.state, canonical(app), app.createdAt);
  }
  appRevoke(appId: string, appVersion: string, reason: string, revokedAt: string): void {
    this.db
      .prepare(
        "UPDATE app_releases SET state='REVOKED', revoked_at=?, revoke_reason=? WHERE app_id=? AND app_version=?",
      )
      .run(revokedAt, reason, appId, appVersion);
  }
  runInsert(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs(run_id,app_id,app_version,release_digest,plan_digest,state,revision,input_digest,input_body,body,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.runId,
        run.appId,
        run.appVersion,
        run.releaseDigest,
        run.planDigest,
        run.snapshot.state,
        run.snapshot.revision,
        run.inputDigest,
        canonical(run.input),
        canonical(run),
        run.createdAt,
        run.updatedAt,
      );
  }
  runGet(runId: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId);
    return row ? this.decodeRun(row as Record<string, unknown>) : undefined;
  }
  runList(appId: string | undefined, offset: number, limit: number): { items: RunRecord[]; total: number } {
    const where = appId ? 'WHERE app_id=?' : '';
    const args = appId ? [appId] : [];
    const rows = this.db
      .prepare(`SELECT * FROM runs ${where} ORDER BY updated_at DESC, run_id LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as Array<Record<string, unknown>>;
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS count FROM runs ${where}`).get(...args) as { count: number }).count,
    );
    return { total, items: rows.map((row) => this.decodeRun(row)) };
  }
  runUpdate(snapshot: RunSnapshot, expectedRevision: number, event: RunEvent, actor: string): RunRecord {
    const current = this.runGet(snapshot.runId);
    if (!current) throw new Error('RUN_NOT_FOUND');
    if (current.snapshot.revision !== expectedRevision) throw new Error('RUN_REVISION_STALE');
    const updatedAt = new Date().toISOString();
    const next: RunRecord = { ...current, snapshot, updatedAt };
    const update = this.db
      .prepare('UPDATE runs SET state=?, revision=?, body=?, updated_at=? WHERE run_id=? AND revision=?')
      .run(next.snapshot.state, next.snapshot.revision, canonical(next), updatedAt, next.runId, expectedRevision);
    if (Number(update.changes) !== 1) throw new Error('RUN_REVISION_STALE');
    this.db
      .prepare('INSERT INTO run_events(run_id,revision,event,actor,created_at) VALUES(?,?,?,?,?)')
      .run(next.runId, next.snapshot.revision, canonical(event), actor, updatedAt);
    return next;
  }
  attemptInsert(attempt: LaunchAttempt): void {
    this.db
      .prepare('INSERT INTO launch_attempts(launch_id,run_id,fencing_token,state,started_at) VALUES(?,?,?,?,?)')
      .run(attempt.launchId, attempt.runId, attempt.fencingToken, attempt.state, attempt.startedAt);
  }
  attemptUpdate(launchId: string, state: AttemptState, detail?: string): void {
    const terminal = state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED' || state === 'UNKNOWN';
    this.db
      .prepare('UPDATE launch_attempts SET state=?, ended_at=?, detail=? WHERE launch_id=?')
      .run(state, terminal ? new Date().toISOString() : null, detail ?? null, launchId);
  }
  attemptUpdateOpenByRun(runId: string, state: AttemptState, detail: string): void {
    this.db
      .prepare(
        "UPDATE launch_attempts SET state=?, ended_at=?, detail=? WHERE run_id=? AND (state='STARTING' OR state='RUNNING')",
      )
      .run(state, new Date().toISOString(), detail, runId);
  }
  attempts(runId: string): LaunchAttempt[] {
    const rows = this.db
      .prepare('SELECT * FROM launch_attempts WHERE run_id=? ORDER BY started_at')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      launchId: String(row.launch_id),
      runId: String(row.run_id),
      fencingToken: Number(row.fencing_token),
      state: String(row.state) as AttemptState,
      startedAt: String(row.started_at),
      ...(row.ended_at ? { endedAt: String(row.ended_at) } : {}),
      ...(row.detail ? { detail: String(row.detail) } : {}),
    }));
  }
  inputInsert(commit: InputCommit): void {
    this.db
      .prepare(
        'INSERT INTO run_inputs(commit_id,run_id,sequence,content_digest,body,state,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        commit.commitId,
        commit.runId,
        commit.sequence,
        commit.contentDigest,
        canonical(commit.body),
        commit.state,
        commit.createdAt,
      );
  }
  inputs(runId: string, offset: number, limit: number): { items: InputCommit[]; total: number } {
    const rows = this.db
      .prepare('SELECT * FROM run_inputs WHERE run_id=? ORDER BY sequence LIMIT ? OFFSET ?')
      .all(runId, limit, offset) as Array<Record<string, unknown>>;
    const total = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM run_inputs WHERE run_id=?').get(runId) as { count: number })
        .count,
    );
    return {
      total,
      items: rows.map((row) => ({
        commitId: String(row.commit_id),
        runId: String(row.run_id),
        sequence: Number(row.sequence),
        contentDigest: String(row.content_digest),
        body: JSON.parse(String(row.body)),
        state: String(row.state) as InputState,
        createdAt: String(row.created_at),
      })),
    };
  }
  inputNextSequence(runId: string): number {
    const row = this.db.prepare('SELECT MAX(sequence) AS value FROM run_inputs WHERE run_id=?').get(runId) as {
      value: number | null;
    };
    return Number(row.value ?? 0) + 1;
  }
  inputMark(runId: string, commitId: string, state: InputState): void {
    const result = this.db
      .prepare('UPDATE run_inputs SET state=? WHERE run_id=? AND commit_id=?')
      .run(state, runId, commitId);
    if (Number(result.changes) !== 1) throw new Error('RUN_INPUT_NOT_FOUND');
  }
  artifactInsert(runId: string, artifact: ArtifactRecord): void {
    this.db
      .prepare('INSERT INTO run_artifacts(run_id,name,digest,bytes,media_type,created_at) VALUES(?,?,?,?,?,?)')
      .run(runId, artifact.name, artifact.digest, artifact.bytes, artifact.mediaType ?? null, artifact.createdAt);
  }
  artifacts(runId: string): ArtifactRecord[] {
    const rows = this.db.prepare('SELECT * FROM run_artifacts WHERE run_id=? ORDER BY name').all(runId) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      name: String(row.name),
      digest: String(row.digest),
      bytes: Number(row.bytes),
      ...(row.media_type ? { mediaType: String(row.media_type) } : {}),
      createdAt: String(row.created_at),
    }));
  }
  artifactCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM run_artifacts').get() as { count: number }).count);
  }
  runCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT state, COUNT(*) AS count FROM runs GROUP BY state').all() as Array<{
      state: string;
      count: number;
    }>;
    return Object.fromEntries(rows.map((row) => [String(row.state), Number(row.count)]));
  }
  runEvents(
    runId: string,
    offset: number,
    limit: number,
  ): {
    items: Array<{ sequence: number; revision: number; event: unknown; actor: string; createdAt: string }>;
    total: number;
  } {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE run_id=? ORDER BY sequence DESC LIMIT ? OFFSET ?')
      .all(runId, limit, offset) as Array<Record<string, unknown>>;
    const total = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM run_events WHERE run_id=?').get(runId) as { count: number })
        .count,
    );
    return {
      total,
      items: rows.map((row) => ({
        sequence: Number(row.sequence),
        revision: Number(row.revision),
        event: JSON.parse(String(row.event)),
        actor: String(row.actor),
        createdAt: String(row.created_at),
      })),
    };
  }
  private decodeApp(row: Record<string, unknown>): AppRecord {
    const body = JSON.parse(String(row.body)) as StoredAppBody;
    const record: AppRecord = {
      ...body,
      appId: String(row.app_id),
      appVersion: String(row.app_version),
      state: String(row.state) as AppState,
      createdAt: String(row.created_at),
      ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
      ...(row.revoke_reason ? { revokeReason: String(row.revoke_reason) } : {}),
    };
    if (canonical(record.draft) !== canonical(body.draft) || record.releaseDigest !== String(row.release_digest)) {
      throw new Error('APP_RECORD_CHANGED');
    }
    return record;
  }
  private decodeRun(row: Record<string, unknown>): RunRecord {
    const body = JSON.parse(String(row.body)) as RunRecord;
    if (body.runId !== String(row.run_id) || body.snapshot.revision !== Number(row.revision)) {
      throw new Error('RUN_RECORD_CHANGED');
    }
    return body;
  }
}
