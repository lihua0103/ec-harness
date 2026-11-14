/** Persistent control-plane state: approved application releases, runs, inputs, events and audit.
 *  SQLite is the local single-owner store; a deployment may replace it with its central service. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExecutionPlan } from '../../platform-runtime/src/plan.js';
import type { RunEvent, RunSnapshot } from '../../platform-runtime/src/run.js';
import type { ModelCatalogRecord, ModelConfigSnapshot } from './models.js';

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
export interface ProjectRecord {
  projectId: string;
  name: string;
  code: string;
  source: 'local';
  createdBy: string;
  createdAt: string;
}
export interface WorkspaceRecord {
  workspaceId: string;
  projectId: string;
  name: string;
  /** Employee-chosen local directory (shown to the employee). */
  directory: string;
  /** Optional path the execution host actually sees, e.g. for Listing/R code path mapping. */
  executionDirectory?: string;
  /** Employee-chosen directory for run outputs; each run uses a subdirectory. */
  outputDirectory?: string;
  revision: number;
  createdBy: string;
  createdAt: string;
}
export interface WorkDraftRecord {
  text: string;
  revision: number;
  updatedAt: string;
}
export type WorkState = 'ACTIVE' | 'ARCHIVED';
/** A Work is the employee's continuous task; Runs are attempts under it. */
export interface WorkRecord {
  workId: string;
  projectId: string;
  workspaceId?: string;
  goal?: string;
  appId: string;
  appVersion: string;
  title: string;
  createdBy: string;
  state: WorkState;
  createdAt: string;
  updatedAt: string;
}
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
  /** Trusted server-derived context, never accepted from run input. */
  workspace?: WorkspaceRecord;
  context?: { goal: string; previousRuns: Array<{ runId: string; input: unknown; result: RunRecord['result'] }>; truncated: boolean };
  runId: string;
  workId: string | null;
  appId: string;
  appVersion: string;
  releaseDigest: string;
  planDigest: string;
  inputDigest: string;
  input: unknown;
  /** Frozen model route for this run; null when created before a catalog existed (legacy). */
  model: ModelConfigSnapshot | null;
  /** Highest input sequence included in the dispatched worker prompt; null before dispatch. */
  dispatchedThrough: number | null;
  /** Last root-session assistant text observed for this attempt; a projection, not a business result. */
  result: { finalResponse: string; sessionId?: string; at: string } | null;
  /** Live assistant messages observed through public SDK notifications; absent after a restart. */
  activities?: Array<{
    kind: 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'status';
    text: string;
    detail?: string;
    sessionId: string;
    seq?: number;
    createdAt: string;
  }>;
  /** Operator confirmed no live execution; releases the workspace but keeps the UNKNOWN history. */
  reconciledAt?: string;
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
  /** Control-owned sealed copy relative to the seal root; absent when only metadata was reported. */
  sealedPath?: string;
  sealedAt?: string;
  createdAt: string;
}
export type InputState = 'PENDING' | 'CONSUMED' | 'UNKNOWN' | 'NOT_SENT' | 'DEFERRED';
const interactionRow = (row: Record<string, unknown>): InteractionRecord => ({
  interactionId: String(row.interaction_id),
  runId: String(row.run_id),
  sessionId: String(row.session_id),
  requestId: String(row.request_id),
  kind: 'user-question',
  body: JSON.parse(String(row.body)),
  state: String(row.state) as InteractionState,
  createdAt: String(row.created_at),
  ...(row.resolved_at ? { resolvedAt: String(row.resolved_at) } : {}),
  ...(row.answer !== null && row.answer !== undefined ? { answer: JSON.parse(String(row.answer)) } : {}),
});
export type InteractionState = 'PENDING' | 'ANSWERED' | 'CANCELLED' | 'EXPIRED';
/** One SDK-native user question bound to a run, session and request id. */
export interface InteractionRecord {
  interactionId: string;
  runId: string;
  sessionId: string;
  requestId: string;
  kind: 'user-question';
  body: unknown;
  state: InteractionState;
  createdAt: string;
  resolvedAt?: string;
  answer?: unknown;
}
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
/** A registered execution domain: where native Sessions actually run. Public metadata only,
 *  never credentials or arbitrary proxy addresses. */
export type ExecutionDomainKind = 'local' | 'hosted';
export type ExecutionDomainState = 'HEALTHY' | 'DEGRADED' | 'UNKNOWN';
export interface ExecutionDomainRecord {
  domainId: string;
  /** Owning organization, or the local operator identity for standalone use. */
  owner: string;
  kind: ExecutionDomainKind;
  /** Controlled deployment reference (opaque, public); absent for a local domain. */
  deploymentRef?: string;
  /** Declared capability ids this domain can execute. */
  capabilities: string[];
  state: ExecutionDomainState;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
/** How a Work's current primary session was obtained. Fork/reopen are explicit, never silent. */
export type BindingRelation = 'primary' | 'fork' | 'reopened';
/** A Work's association to a native Session in one execution domain. */
export interface WorkSessionBindingRecord {
  bindingId: string;
  workId: string;
  domainId: string;
  sessionId: string;
  workspaceId?: string;
  releaseDigest: string;
  relation: BindingRelation;
  /** For fork/reopen: the Work whose session it derives from. */
  sourceWorkId?: string;
  revision: number;
  createdBy: string;
  createdAt: string;
}
export type SubmissionState = 'RECORDED' | 'ACCEPTED' | 'CONSUMED' | 'UNKNOWN' | 'REJECTED';
/** A trusted enterprise submission intent, correlated with one native prompt by requestId.
 *  Acceptance/consumption facts stay with the native log; the control plane records intent. */
export interface SubmissionRecord {
  submissionId: string;
  workId: string;
  domainId: string;
  sessionId: string;
  requestId: string;
  inputDigest: string;
  submittedBy: string;
  orgId?: string;
  state: SubmissionState;
  /** Native admission evidence (accepted receipt), never a client assertion. */
  admission?: string;
  consumedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** An immutable input batch for a Work; a new batch appends, it never rewrites an old one. */
export interface InputBaselineRecord {
  baselineId: string;
  workId: string;
  /** Monotonic per Work; never renumbered. */
  revision: number;
  /** Stable reference to the source (e.g. a directory digest, an imported file set). */
  sourceRef: string;
  /** SHA-256 of the inputs this baseline covers. */
  digest: string;
  createdBy: string;
  createdAt: string;
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
          work_id TEXT,
          dispatched_through INTEGER,
          result_body TEXT,
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
          sealed_path TEXT,
          sealed_at TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY(run_id, name)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS run_interactions(
          interaction_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          body TEXT NOT NULL,
          state TEXT NOT NULL,
          answer TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          UNIQUE(run_id, request_id)
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
          exit_proven INTEGER,
          CHECK(state IN ('STARTING','RUNNING','SUCCEEDED','FAILED','CANCELLED','UNKNOWN'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS projects(
          project_id TEXT PRIMARY KEY,
          body TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS project_workspaces(
          workspace_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          directory TEXT NOT NULL,
          body TEXT NOT NULL,
          UNIQUE(project_id, directory)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS work_drafts(
          work_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          text TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(work_id, actor_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS works(
          work_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          app_id TEXT NOT NULL,
          app_version TEXT NOT NULL,
          state TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK(state IN ('ACTIVE','ARCHIVED'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS audit_events(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT NOT NULL,
          details TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS model_catalog(
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          catalog_id TEXT NOT NULL,
          catalog_digest TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS model_preferences(
          actor_id TEXT PRIMARY KEY,
          selection_id TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS execution_domains(
          domain_id TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          state TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK(state IN ('HEALTHY','DEGRADED','UNKNOWN'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS work_session_bindings(
          binding_id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL,
          domain_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          release_digest TEXT NOT NULL,
          relation TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(work_id, domain_id, session_id),
          CHECK(relation IN ('primary','fork','reopened'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS submissions(
          submission_id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL,
          domain_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          input_digest TEXT NOT NULL,
          submitted_by TEXT NOT NULL,
          state TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(domain_id, session_id, request_id),
          CHECK(state IN ('RECORDED','ACCEPTED','CONSUMED','UNKNOWN','REJECTED'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS input_baselines(
          baseline_id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(work_id, revision)
        ) STRICT;
        PRAGMA application_id=${CONTROL_APPLICATION_ID};
        PRAGMA user_version=1;
        COMMIT;
      `);
      // Additive migration for stores created before exit evidence was persisted.
      const attemptCols = this.db.prepare('PRAGMA table_info(launch_attempts)').all() as Array<{ name: string }>;
      if (!attemptCols.some((column) => column.name === 'exit_proven')) {
        this.db.exec('ALTER TABLE launch_attempts ADD COLUMN exit_proven INTEGER');
      }
      // Additive migration for stores created before Work existed.
      const runCols = this.db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
      if (!runCols.some((column) => column.name === 'work_id')) {
        this.db.exec('ALTER TABLE runs ADD COLUMN work_id TEXT');
      }
      if (!runCols.some((column) => column.name === 'dispatched_through')) {
        this.db.exec('ALTER TABLE runs ADD COLUMN dispatched_through INTEGER');
      }
      if (!runCols.some((column) => column.name === 'result_body')) {
        this.db.exec('ALTER TABLE runs ADD COLUMN result_body TEXT');
      }
      // Additive migration for artifacts recorded before sealed copies existed.
      const artifactCols = this.db.prepare('PRAGMA table_info(run_artifacts)').all() as Array<{ name: string }>;
      if (!artifactCols.some((column) => column.name === 'sealed_path')) {
        this.db.exec('ALTER TABLE run_artifacts ADD COLUMN sealed_path TEXT');
      }
      if (!artifactCols.some((column) => column.name === 'sealed_at')) {
        this.db.exec('ALTER TABLE run_artifacts ADD COLUMN sealed_at TEXT');
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS runs_by_work ON runs(work_id, state)');
      // Hard admission rule in addition to the service check: one non-terminal Run per Work.
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_work ON runs(work_id) WHERE work_id IS NOT NULL AND state IN ('QUEUED','STARTING','RUNNING')",
      );
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
  private transactionDepth = 0;
  transaction<T>(action: () => T): T {
    // Nested calls use a savepoint so an inner failure rolls back only the inner unit.
    if (this.transactionDepth > 0) {
      const savepoint = `sp_${this.transactionDepth}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      this.transactionDepth++;
      try {
        const result = action();
        this.db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${savepoint}`);
        this.db.exec(`RELEASE ${savepoint}`);
        throw error;
      } finally {
        this.transactionDepth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }
  projectGet(projectId: string): ProjectRecord | undefined {
    const row = this.db.prepare('SELECT body FROM projects WHERE project_id=?').get(projectId);
    return row ? JSON.parse(String(row.body)) as ProjectRecord : undefined;
  }
  projectList(): ProjectRecord[] {
    return this.db.prepare('SELECT body FROM projects ORDER BY rowid DESC').all()
      .map((row) => JSON.parse(String(row.body)) as ProjectRecord);
  }
  projectInsert(project: ProjectRecord): void {
    this.db.prepare('INSERT INTO projects(project_id,body) VALUES(?,?)')
      .run(project.projectId, canonical(project));
  }
  workspaceGet(workspaceId: string): WorkspaceRecord | undefined {
    const row = this.db.prepare('SELECT body FROM project_workspaces WHERE workspace_id=?').get(workspaceId);
    return row ? JSON.parse(String(row.body)) as WorkspaceRecord : undefined;
  }
  workspaceList(projectId: string): WorkspaceRecord[] {
    return this.db.prepare('SELECT body FROM project_workspaces WHERE project_id=? ORDER BY rowid').all(projectId)
      .map((row) => JSON.parse(String(row.body)) as WorkspaceRecord);
  }
  workspaceInsert(workspace: WorkspaceRecord): void {
    this.db.prepare('INSERT INTO project_workspaces(workspace_id,project_id,directory,body) VALUES(?,?,?,?)')
      .run(workspace.workspaceId, workspace.projectId, workspace.directory, canonical(workspace));
  }
  draftGet(workId: string, actorId: string): WorkDraftRecord {
    const row = this.db.prepare('SELECT text,revision,updated_at FROM work_drafts WHERE work_id=? AND actor_id=?')
      .get(workId, actorId);
    return row
      ? { text: String(row.text), revision: Number(row.revision), updatedAt: String(row.updated_at) }
      : { text: '', revision: 0, updatedAt: '' };
  }
  draftPut(workId: string, actorId: string, text: string, expectedRevision: number): WorkDraftRecord | null {
    return this.transaction(() => {
      const current = this.draftGet(workId, actorId);
      if (current.revision !== expectedRevision) return null;
      const next = { text, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      this.db.prepare(`INSERT INTO work_drafts(work_id,actor_id,text,revision,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(work_id,actor_id) DO UPDATE SET text=excluded.text,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(workId, actorId, next.text, next.revision, next.updatedAt);
      return next;
    });
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
  modelCatalogGet(): ModelCatalogRecord | undefined {
    const row = this.db.prepare('SELECT body FROM model_catalog WHERE singleton=1').get() as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as ModelCatalogRecord) : undefined;
  }
  modelCatalogPut(record: ModelCatalogRecord): void {
    this.db
      .prepare(
        `INSERT INTO model_catalog(singleton,catalog_id,catalog_digest,body,created_at,updated_at)
         VALUES(1,?,?,?,?,?)
         ON CONFLICT(singleton) DO UPDATE SET
           catalog_id=excluded.catalog_id,
           catalog_digest=excluded.catalog_digest,
           body=excluded.body,
           updated_at=excluded.updated_at`,
      )
      .run(record.catalogId, record.catalogDigest, JSON.stringify(record), record.createdAt, record.updatedAt);
  }
  modelPreferenceGet(actorId: string): { selectionId: string; updatedAt: string } | undefined {
    const row = this.db
      .prepare('SELECT selection_id, updated_at FROM model_preferences WHERE actor_id=?')
      .get(actorId) as { selection_id: string; updated_at: string } | undefined;
    return row ? { selectionId: row.selection_id, updatedAt: row.updated_at } : undefined;
  }
  modelPreferenceSet(actorId: string, selectionId: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO model_preferences(actor_id,selection_id,updated_at) VALUES(?,?,?)
         ON CONFLICT(actor_id) DO UPDATE SET selection_id=excluded.selection_id, updated_at=excluded.updated_at`,
      )
      .run(actorId, selectionId, updatedAt);
  }
  runInsert(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs(run_id,work_id,dispatched_through,result_body,app_id,app_version,release_digest,plan_digest,state,revision,input_digest,input_body,body,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.runId,
        run.workId,
        run.dispatchedThrough,
        run.result === null ? null : JSON.stringify(run.result),
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
  /** Fair queue scan: oldest QUEUED first, independent of how many newer terminal rows exist. */
  queuedRuns(limit: number): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE state='QUEUED' ORDER BY created_at ASC, run_id LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.decodeRun(row));
  }
  /** Same-Work admission: at most one non-terminal Run may exist for a Work. */
  activeRunForWork(workId: string): RunRecord | undefined {
    const rows = this.db
      .prepare(
        "SELECT * FROM runs WHERE work_id=? AND state IN ('QUEUED','STARTING','RUNNING','UNKNOWN') ORDER BY created_at",
      )
      .all(workId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.decodeRun(row)).find((run) => !run.reconciledAt);
  }
  /** Conservatively reserve a registered source directory until all prior execution is settled. */
  activeRunForDirectory(directory: string): RunRecord | undefined {
    const rows = this.db.prepare("SELECT * FROM runs WHERE state IN ('QUEUED','STARTING','RUNNING','UNKNOWN')").all();
    return rows.map((row) => this.decodeRun(row)).find((run) =>
      !run.reconciledAt && run.workspace?.directory === directory);
  }
  /** Record an explicit operator reconciliation without rewriting the UNKNOWN outcome. */
  runMarkReconciled(runId: string, at: string): void {
    const current = this.runGet(runId);
    if (!current) throw new Error('RUN_NOT_FOUND');
    const next: RunRecord = { ...current, reconciledAt: at, updatedAt: at };
    const update = this.db.prepare('UPDATE runs SET body=?, updated_at=? WHERE run_id=?')
      .run(canonical(next), at, runId);
    if (Number(update.changes) !== 1) throw new Error('RUN_NOT_FOUND');
  }
  runsForWork(workId: string, offset: number, limit: number): { items: RunRecord[]; total: number } {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE work_id=? ORDER BY created_at DESC, run_id LIMIT ? OFFSET ?')
      .all(workId, limit, offset) as Array<Record<string, unknown>>;
    const total = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM runs WHERE work_id=?').get(workId) as { count: number })
        .count,
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
  /** Persist which input sequence range was actually included in the dispatched prompt.
   *  This is a launch fact, not a state transition; it does not advance the run revision. */
  runSetDispatchedThrough(runId: string, through: number): void {
    const result = this.db
      .prepare('UPDATE runs SET dispatched_through=?, updated_at=? WHERE run_id=?')
      .run(through, new Date().toISOString(), runId);
    if (Number(result.changes) !== 1) throw new Error('RUN_NOT_FOUND');
  }
  /** Record the last observed assistant text without advancing the run revision. */
  runSetResult(runId: string, result: RunRecord['result']): void {
    const update = this.db
      .prepare('UPDATE runs SET result_body=?, updated_at=? WHERE run_id=?')
      .run(result === null ? null : JSON.stringify(result), new Date().toISOString(), runId);
    if (Number(update.changes) !== 1) throw new Error('RUN_NOT_FOUND');
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
  attemptSetExitProven(launchId: string, proven: boolean): void {
    this.db.prepare('UPDATE launch_attempts SET exit_proven=? WHERE launch_id=?').run(proven ? 1 : 0, launchId);
  }
  attemptExitProven(launchId: string): boolean | null {
    const row = this.db.prepare('SELECT exit_proven FROM launch_attempts WHERE launch_id=?').get(launchId) as
      | { exit_proven: number | null }
      | undefined;
    if (!row || row.exit_proven === null) return null;
    return row.exit_proven === 1;
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
      .prepare(
        'INSERT INTO run_artifacts(run_id,name,digest,bytes,media_type,sealed_path,sealed_at,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        runId,
        artifact.name,
        artifact.digest,
        artifact.bytes,
        artifact.mediaType ?? null,
        artifact.sealedPath ?? null,
        artifact.sealedAt ?? null,
        artifact.createdAt,
      );
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
      ...(row.sealed_path ? { sealedPath: String(row.sealed_path) } : {}),
      ...(row.sealed_at ? { sealedAt: String(row.sealed_at) } : {}),
      createdAt: String(row.created_at),
    }));
  }
  artifactCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM run_artifacts').get() as { count: number }).count);
  }
  interactionInsert(record: InteractionRecord): void {
    this.db
      .prepare(
        'INSERT INTO run_interactions(interaction_id,run_id,session_id,request_id,kind,body,state,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        record.interactionId,
        record.runId,
        record.sessionId,
        record.requestId,
        record.kind,
        JSON.stringify(record.body),
        record.state,
        record.createdAt,
      );
  }
  interactionGet(interactionId: string): InteractionRecord | null {
    const row = this.db.prepare('SELECT * FROM run_interactions WHERE interaction_id=?').get(interactionId) as
      | Record<string, unknown>
      | undefined;
    return row ? interactionRow(row) : null;
  }
  interactionsForRun(runId: string): InteractionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM run_interactions WHERE run_id=? ORDER BY created_at ASC, interaction_id ASC')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map(interactionRow);
  }

  /** Every still-pending question, oldest first; the service applies the caller's run access policy. */
  pendingInteractions(limit = 200): InteractionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM run_interactions WHERE state='PENDING' ORDER BY created_at ASC, interaction_id ASC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(interactionRow);
  }
  /** CAS: only a PENDING interaction can be answered or expired; returns whether this call won. */
  interactionResolve(interactionId: string, state: InteractionState, answer: unknown): boolean {
    const result = this.db
      .prepare("UPDATE run_interactions SET state=?, answer=?, resolved_at=? WHERE interaction_id=? AND state='PENDING'")
      .run(state, answer === null || answer === undefined ? null : JSON.stringify(answer), new Date().toISOString(), interactionId);
    return Number(result.changes) === 1;
  }
  runCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT state, COUNT(*) AS count FROM runs GROUP BY state').all() as Array<{
      state: string;
      count: number;
    }>;
    return Object.fromEntries(rows.map((row) => [String(row.state), Number(row.count)]));
  }
  /** Ascending replay after a durable cursor; used by the resumable event stream. */
  runEventsAfter(
    runId: string,
    after: number,
    limit: number,
  ): Array<{ sequence: number; revision: number; event: unknown; actor: string; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE run_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?')
      .all(runId, after, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      revision: Number(row.revision),
      event: JSON.parse(String(row.event)),
      actor: String(row.actor),
      createdAt: String(row.created_at),
    }));
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
    // Historical runs created before the model catalog / Work existed read as unrecorded.
    return {
      ...body,
      workId: body.workId ?? (row.work_id ? String(row.work_id) : null),
      model: body.model ?? null,
      dispatchedThrough:
        row.dispatched_through === null || row.dispatched_through === undefined
          ? body.dispatchedThrough ?? null
          : Number(row.dispatched_through),
      result:
        row.result_body === null || row.result_body === undefined
          ? body.result ?? null
          : (JSON.parse(String(row.result_body)) as RunRecord['result']),
    };
  }
  workInsert(work: WorkRecord): void {
    this.db
      .prepare(
        'INSERT INTO works(work_id,project_id,app_id,app_version,state,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        work.workId,
        work.projectId,
        work.appId,
        work.appVersion,
        work.state,
        canonical(work),
        work.createdAt,
        work.updatedAt,
      );
  }
  workGet(workId: string): WorkRecord | undefined {
    const row = this.db.prepare('SELECT body FROM works WHERE work_id=?').get(workId) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as WorkRecord) : undefined;
  }
  workList(state: WorkState | undefined, offset: number, limit: number): { items: WorkRecord[]; total: number } {
    const where = state ? 'WHERE state=?' : '';
    const args = state ? [state] : [];
    const rows = this.db
      .prepare(`SELECT body FROM works ${where} ORDER BY updated_at DESC, work_id LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as Array<{ body: string }>;
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS count FROM works ${where}`).get(...args) as { count: number }).count,
    );
    return { total, items: rows.map((row) => JSON.parse(row.body) as WorkRecord) };
  }
  workUpdate(work: WorkRecord): void {
    const result = this.db
      .prepare('UPDATE works SET state=?, body=?, updated_at=? WHERE work_id=?')
      .run(work.state, canonical(work), work.updatedAt, work.workId);
    if (Number(result.changes) !== 1) throw new Error('WORK_NOT_FOUND');
  }

  // ── Execution domains ──────────────────────────────────────────────────────
  domainGet(domainId: string): ExecutionDomainRecord | undefined {
    const row = this.db.prepare('SELECT body FROM execution_domains WHERE domain_id=?').get(domainId) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as ExecutionDomainRecord) : undefined;
  }
  domainList(owner: string): ExecutionDomainRecord[] {
    return this.db.prepare('SELECT body FROM execution_domains WHERE owner=? ORDER BY created_at')
      .all(owner)
      .map((row) => JSON.parse(String((row as { body: string }).body)) as ExecutionDomainRecord);
  }
  domainInsert(domain: ExecutionDomainRecord): void {
    this.db
      .prepare('INSERT INTO execution_domains(domain_id,owner,state,body,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(domain.domainId, domain.owner, domain.state, canonical(domain), domain.createdAt, domain.updatedAt);
  }
  /** CAS on revision; a stale writer cannot silently change health. */
  domainUpdate(domain: ExecutionDomainRecord, expectedRevision: number): boolean {
    return this.transaction(() => {
      const current = this.domainGet(domain.domainId);
      if (!current || current.revision !== expectedRevision) return false;
      const result = this.db
        .prepare('UPDATE execution_domains SET owner=?,state=?,body=?,updated_at=? WHERE domain_id=?')
        .run(domain.owner, domain.state, canonical(domain), domain.updatedAt, domain.domainId);
      return Number(result.changes) === 1;
    });
  }

  // ── Work ↔ Session bindings ────────────────────────────────────────────────
  bindingGet(bindingId: string): WorkSessionBindingRecord | undefined {
    const row = this.db.prepare('SELECT body FROM work_session_bindings WHERE binding_id=?').get(bindingId) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as WorkSessionBindingRecord) : undefined;
  }
  bindingsForWork(workId: string): WorkSessionBindingRecord[] {
    return this.db.prepare('SELECT body FROM work_session_bindings WHERE work_id=? ORDER BY created_at')
      .all(workId)
      .map((row) => JSON.parse(String((row as { body: string }).body)) as WorkSessionBindingRecord);
  }
  /** The single current primary binding for a Work, if any (relation='primary'). */
  primaryBindingForWork(workId: string): WorkSessionBindingRecord | undefined {
    const row = this.db
      .prepare("SELECT body FROM work_session_bindings WHERE work_id=? AND relation='primary' ORDER BY created_at DESC LIMIT 1")
      .get(workId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as WorkSessionBindingRecord) : undefined;
  }
  bindingForSession(domainId: string, sessionId: string): WorkSessionBindingRecord | undefined {
    const row = this.db
      .prepare('SELECT body FROM work_session_bindings WHERE domain_id=? AND session_id=? ORDER BY created_at LIMIT 1')
      .get(domainId, sessionId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as WorkSessionBindingRecord) : undefined;
  }
  bindingInsert(binding: WorkSessionBindingRecord): void {
    this.db
      .prepare(
        'INSERT INTO work_session_bindings(binding_id,work_id,domain_id,session_id,release_digest,relation,body,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        binding.bindingId, binding.workId, binding.domainId, binding.sessionId,
        binding.releaseDigest, binding.relation, canonical(binding), binding.createdAt,
      );
  }
  bindingCount(workId: string): number {
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM work_session_bindings WHERE work_id=?').get(workId) as {
        count: number;
      }).count,
    );
  }
  /** CAS on revision; the Work's current primary is demoted to a superseded copy by the caller. */
  bindingUpdate(binding: WorkSessionBindingRecord, expectedRevision: number): boolean {
    return this.transaction(() => {
      const current = this.bindingGet(binding.bindingId);
      if (!current || current.revision !== expectedRevision) return false;
      const result = this.db
        .prepare('UPDATE work_session_bindings SET body=?, relation=? WHERE binding_id=?')
        .run(canonical(binding), binding.relation, binding.bindingId);
      return Number(result.changes) === 1;
    });
  }

  // ── Submission intents ─────────────────────────────────────────────────────
  submissionGet(submissionId: string): SubmissionRecord | undefined {
    const row = this.db.prepare('SELECT body FROM submissions WHERE submission_id=?').get(submissionId) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as SubmissionRecord) : undefined;
  }
  /** The unique (domainId, sessionId, requestId) natural key: a retry returns the same intent. */
  submissionByRequest(domainId: string, sessionId: string, requestId: string): SubmissionRecord | undefined {
    const row = this.db
      .prepare('SELECT body FROM submissions WHERE domain_id=? AND session_id=? AND request_id=?')
      .get(domainId, sessionId, requestId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as SubmissionRecord) : undefined;
  }
  submissionInsert(submission: SubmissionRecord): void {
    this.db
      .prepare(
        'INSERT INTO submissions(submission_id,work_id,domain_id,session_id,request_id,input_digest,submitted_by,state,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        submission.submissionId, submission.workId, submission.domainId, submission.sessionId,
        submission.requestId, submission.inputDigest, submission.submittedBy, submission.state,
        canonical(submission), submission.createdAt, submission.updatedAt,
      );
  }
  /** CAS on state: only RECORDED/ACCEPTED advance; a terminal outcome is never rewritten blindly. */
  submissionUpdate(submission: SubmissionRecord, expectedState: SubmissionState): boolean {
    const result = this.db
      .prepare('UPDATE submissions SET state=?, body=?, updated_at=? WHERE submission_id=? AND state=?')
      .run(submission.state, canonical(submission), submission.updatedAt, submission.submissionId, expectedState);
    return Number(result.changes) === 1;
  }
  submissionsForWork(workId: string): SubmissionRecord[] {
    return this.db.prepare('SELECT body FROM submissions WHERE work_id=? ORDER BY created_at')
      .all(workId)
      .map((row) => JSON.parse(String((row as { body: string }).body)) as SubmissionRecord);
  }

  // ── Input baselines ────────────────────────────────────────────────────────
  baselineGet(baselineId: string): InputBaselineRecord | undefined {
    const row = this.db.prepare('SELECT body FROM input_baselines WHERE baseline_id=?').get(baselineId) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as InputBaselineRecord) : undefined;
  }
  baselinesForWork(workId: string): InputBaselineRecord[] {
    return this.db.prepare('SELECT body FROM input_baselines WHERE work_id=? ORDER BY revision')
      .all(workId)
      .map((row) => JSON.parse(String((row as { body: string }).body)) as InputBaselineRecord);
  }
  baselineLatestRevision(workId: string): number {
    const row = this.db.prepare('SELECT MAX(revision) AS value FROM input_baselines WHERE work_id=?').get(workId) as {
      value: number | null;
    };
    return Number(row.value ?? 0);
  }
  baselineInsert(baseline: InputBaselineRecord): void {
    this.db
      .prepare('INSERT INTO input_baselines(baseline_id,work_id,revision,body,created_at) VALUES(?,?,?,?,?)')
      .run(baseline.baselineId, baseline.workId, baseline.revision, canonical(baseline), baseline.createdAt);
  }
}
