/** Persistent control-plane state: approved application releases, runs, inputs, events and audit.
 *  SQLite is the local single-owner store; a deployment may replace it with its central service. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ExecutionPlan } from '../../platform-runtime/src/plan.js';
import type { RunEvent, RunSnapshot } from '../../platform-runtime/src/run.js';
import type { ModelCatalogRecord, ModelConfigSnapshot } from './models.js';
import type { RunFinding } from './service.js';
import { currentCorrelation } from './observability.js';
import { PlatformError } from './registry.js';

export const CONTROL_APPLICATION_ID = 1162038092;

/** E4-3 keyset cursor: opaque to clients, base64url of the sort key that produced the page.
 *  Exported so the service's catalog pagination encodes cursors the same way. */
export const encodeCursor = (t: string, id: string): string =>
  Buffer.from(JSON.stringify({ t, id }), 'utf8').toString('base64url');
export const decodeCursor = (cursor: string): { t: string; id: string } | null => {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown };
    return typeof value.t === 'string' && typeof value.id === 'string' ? { t: value.t, id: value.id } : null;
  } catch {
    return null;
  }
};

export interface AppReleaseDraft {
  descriptor: {
    appId: string;
    version: string;
    displayName: string;
    description: string;
    listingTypes?: string[];
    materialRoles?: string[];
    resultTypes?: string[];
    /** 知识域 ID（插件 knowledge/manifest.json 的 pluginId）：Run 创建时据此绑定知识快照。 */
    knowledgePluginId?: string;
    /** 封闭参数 schema（R1/R3）：合同身份以 digest 固定进计划 v2；登记时拒绝封闭子集外的
     *  关键字（registry → assertClosedSchema），提交值在 Run 冻结入口校验（runs.create →
     *  validateRunInput，创建与换批共用）。必须是 JSON 对象，canonical ≤ 64KB；版本缺省 '1'。 */
    inputSchema?: unknown;
    inputSchemaVersion?: string;
    /** Declarative result views (E1-5): the app describes how its contributed findings render.
     *  The platform renders generically from this declaration and never branches on an appId. */
    resultViews?: Array<{
      viewId: string;
      title: string;
      kind: 'table' | 'metrics';
      /** Which finding kind this view renders; findings align across runs by stable key. */
      findingKind: string;
      columns?: Array<{ field: string; label: string }>;
      metrics?: Array<{ field: string; label: string; unit?: string; stat: 'count' | 'sum' | 'avg' }>;
    }>;
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
  /** Build provenance: who built the bytes and from which source. Digest-only; no secrets. */
  provenance?: {
    sourceRevision?: string;
    builder?: string;
    builtAt?: string;
    /** SHA-256 of the SBOM produced for this release. */
    sbomDigest?: string;
    /** SHA-256 over the locked dependency graph. */
    dependenciesDigest?: string;
  };
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
/** The per-app default release pointer (W2/R6): which registered release new Works are created
 *  from. One row per app; `revision` is a monotonic CAS counter so concurrent switches cannot
 *  silently overwrite each other, and a stale creation form can be detected against it. */
export interface AppDefaultReleaseRecord {
  appId: string;
  appVersion: string;
  releaseDigest: string;
  revision: number;
  updatedBy: string;
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
  /** Run 创建时绑定的知识快照（KA11）：只读摘要，在途运行不随知识更新漂移；未配置知识源时缺省。
   *  records 是实际修订集合（M1-02）：Run 可据此重放固定知识，而不只是校验一个摘要。 */
  knowledge?: {
    snapshotDigest: string;
    total: number;
    pluginId: string;
    projectId?: string;
    boundAt: string;
    records?: Array<{ knowledgeId: string; revision: number; contentDigest: string }>;
  };
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
  /** Request correlation id captured when the entry was written (absent for old rows). */
  correlationId?: string;
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
  /** Supervisor that owns the launch lease (a service principal id). */
  leaseOwner?: string;
  /** ISO time after which the lease no longer proves the launch is supervised. */
  leaseExpiresAt?: string;
  /** Last lease renewal, distinct from process-exit evidence. */
  heartbeatAt?: string;
  /** Host process that runs the launch. `in-process` means the SDK harness runs inside the
   *  control process, so OS-level process-tree supervision cannot prove its exit separately;
   *  `child-process` means a deployment supplied a separately supervised worker process. */
  pid?: number;
  processIdentity?: string;
  processMode?: 'in-process' | 'child-process';
}

/** Durable dispatch queue. A run and its dispatch message are committed in one transaction, so a
 *  crash between "run created" and "worker started" resumes instead of losing the run. */
export type OutboxState = 'PENDING' | 'CLAIMED' | 'DONE' | 'DEAD';
export interface OutboxMessage {
  messageId: string;
  runId: string;
  kind: 'run.dispatch';
  state: OutboxState;
  attempts: number;
  nextAttemptAt: string;
  claimedBy?: string;
  claimExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/** A deployment approval binding a release digest to an approver and its evidence. */
export type ReleaseApprovalState = 'ACTIVE' | 'REVOKED';
export interface ReleaseApprovalRecord {
  approvalId: string;
  appId: string;
  appVersion: string;
  releaseDigest: string;
  state: ReleaseApprovalState;
  approvedBy: string;
  approvedAt: string;
  /** Deployment-supplied evidence reference (test run, review ticket); never a secret. */
  evidence?: string;
  /** Version this approval rolls back to when the release is withdrawn. */
  rollbackTarget?: string;
  expiresAt?: string;
  revokedAt?: string;
  revokeReason?: string;
  revision: number;
}

/** E2-4 model governance: an approval for one catalog selection, reusing the release-approval
 *  lifecycle. An approval binds to the selection id — the catalog entry itself is immutable data. */
export interface ModelApprovalRecord {
  approvalId: string;
  selectionId: string;
  state: ReleaseApprovalState;
  approvedBy: string;
  approvedAt: string;
  evidence?: string;
  expiresAt?: string;
  revokedAt?: string;
  revokeReason?: string;
  revision: number;
}

/** Last recorded health of one catalog selection. Health is a deployment probe fact, not a
 *  guarantee that the next request succeeds. */
export type ModelHealthState = 'healthy' | 'degraded' | 'unavailable' | 'unknown';
export interface ModelHealthRecord {
  selectionId: string;
  state: ModelHealthState;
  reason?: string;
  checkedAt: string;
  catalogDigest?: string;
  revision: number;
}

/** A business review of one succeeded execution's results. Technical success, sealed artifacts
 *  and business approval are separate facts; this record is only the last one. */
export type ReviewState = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';
/**
 * R5 deliverable binding: the immutable manifest a review is requested against, built by the
 * server from the run's own sealed artifacts at request time. Records without one are legacy
 * reviews bound only to the run (未绑定具体成果版本) — they keep their existing facts and never
 * match any deliverable manifest.
 */
export interface ReviewDeliverable {
  /** Server-computed digest over the deliverable manifest; a decision must bind this exact
   *  target. Deliberately excludes review state, so a decision or a delivery package's seal-time
   *  snapshot can never change the target it binds (no circular dependency). */
  manifestDigest: string;
  manifest: { runId: string; artifacts: Array<{ name: string; digest: string; bytes: number }> };
}
export interface ReviewRecord {
  reviewId: string;
  runId: string;
  state: ReviewState;
  requestedBy: string;
  reviewer?: string;
  note?: string;
  /** Present on reviews requested after deliverable binding (R5); absent on legacy records. */
  deliverable?: ReviewDeliverable;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
/**
 * A delivery package (E1-3): sealing, delivering and receiving are three separate facts and one
 * package never silently replaces another. The manifest freezes the sealed artifact digests and
 * the review snapshot at seal time; a later review never migrates into an old package.
 */
export type DeliveryPackageState = 'SEALED' | 'DELIVERED' | 'RECEIVED' | 'WITHDRAWN' | 'SUPERSEDED';
export interface DeliveryManifest {
  runId: string;
  appId: string;
  appVersion: string;
  artifacts: Array<{ name: string; digest: string; bytes: number }>;
  /** Review snapshot read at seal time; null means the run was never reviewed. */
  review: { reviewId: string; state: ReviewState; updatedAt: string } | null;
}
export interface DeliveryPackageRecord {
  packageId: string;
  workId: string;
  runId: string;
  appId: string;
  state: DeliveryPackageState;
  manifest: DeliveryManifest;
  /** Deterministic digest over the frozen manifest; changes mean the package content changed. */
  packageDigest: string;
  note?: string;
  deliveredAt?: string;
  deliveredNote?: string;
  receivedAt?: string;
  receivedNote?: string;
  withdrawnAt?: string;
  withdrawReason?: string;
  /** Set when this package was explicitly replaced by a newer package of the same Work. */
  supersededBy?: string;
  sealedBy: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
/**
 * Deterministic evaluation harness (E2-1 fallback): expert gold sets are not yet available, so
 * quality assurance starts with checks that need no expert judgement — artifact presence, sealed
 * digests, byte ceilings and goal-text anchors — executed against a Run's own records. Every
 * check is pure and recomputable; nothing here claims expert equivalence, and expert
 * expectations (gold sets) remain deferred until the business supplies them.
 */
export type DeterministicCheck =
  | { kind: 'artifact-present'; artifactName: string }
  | { kind: 'artifact-digest'; artifactName: string; digest: string }
  | { kind: 'artifact-bytes-max'; artifactName: string; maxBytes: number }
  | { kind: 'goal-contains'; text: string };
export interface EvaluationEntry {
  entryId: string;
  label: string;
  checks: DeterministicCheck[];
}
export type EvaluationSetState = 'ACTIVE' | 'ARCHIVED';
export interface EvaluationSetRecord {
  evaluationSetId: string;
  appId: string;
  name: string;
  description: string;
  entries: EvaluationEntry[];
  state: EvaluationSetState;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface EvaluationCheckResult {
  entryId: string;
  label: string;
  check: DeterministicCheck;
  pass: boolean;
  detail: string;
}
export interface EvaluationRunRecord {
  evaluationRunId: string;
  evaluationSetId: string;
  runId: string;
  appId: string;
  /** Deterministic checks always complete: no model, no pending expert state. */
  state: 'COMPLETED';
  results: EvaluationCheckResult[];
  passed: number;
  failed: number;
  createdBy: string;
  createdAt: string;
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

/** Deterministic JSON (sorted keys) shared by digest computations over stored facts. */
export const canonical = (value: unknown): string =>
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

/** Deterministic digest over a review's deliverable manifest (R5): runId + artifact identities
 *  only. Review state is deliberately excluded so the digest can never feed back into itself
 *  through a decision or a delivery package's seal-time review snapshot. */
export const reviewDeliverableDigest = (manifest: {
  runId: string;
  artifacts: Array<{ name: string; digest: string; bytes: number }>;
}): string =>
  createHash('sha256').update(canonical({ schema: 'review-deliverable/v1', ...manifest })).digest('hex');

const decodeAuditRow = (row: Record<string, unknown>): AuditEntry => ({
  sequence: Number(row.sequence),
  actor: String(row.actor),
  action: String(row.action),
  target: String(row.target),
  details: JSON.parse(String(row.details)),
  createdAt: String(row.created_at),
  ...(row.correlation_id ? { correlationId: String(row.correlation_id) } : {}),
});

const decodeAttempt = (row: Record<string, unknown>): LaunchAttempt => ({
  launchId: String(row.launch_id),
  runId: String(row.run_id),
  fencingToken: Number(row.fencing_token),
  state: String(row.state) as AttemptState,
  startedAt: String(row.started_at),
  ...(row.ended_at ? { endedAt: String(row.ended_at) } : {}),
  ...(row.detail ? { detail: String(row.detail) } : {}),
  ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
  ...(row.lease_expires_at ? { leaseExpiresAt: String(row.lease_expires_at) } : {}),
  ...(row.heartbeat_at ? { heartbeatAt: String(row.heartbeat_at) } : {}),
  ...(row.pid !== null && row.pid !== undefined ? { pid: Number(row.pid) } : {}),
  ...(row.process_identity ? { processIdentity: String(row.process_identity) } : {}),
  ...(row.process_mode ? { processMode: String(row.process_mode) as 'in-process' | 'child-process' } : {}),
});

const decodeModelHealth = (row: Record<string, unknown>): ModelHealthRecord => ({
  selectionId: String(row.selection_id),
  state: String(row.state) as ModelHealthState,
  ...(row.reason ? { reason: String(row.reason) } : {}),
  checkedAt: String(row.checked_at),
  ...(row.catalog_digest ? { catalogDigest: String(row.catalog_digest) } : {}),
  revision: Number(row.revision),
});

const decodeOutbox = (row: Record<string, unknown>): OutboxMessage => ({
  messageId: String(row.message_id),
  runId: String(row.run_id),
  kind: String(row.kind) as OutboxMessage['kind'],
  state: String(row.state) as OutboxState,
  attempts: Number(row.attempts),
  nextAttemptAt: String(row.next_attempt_at),
  ...(row.claimed_by ? { claimedBy: String(row.claimed_by) } : {}),
  ...(row.claim_expires_at ? { claimExpiresAt: String(row.claim_expires_at) } : {}),
  ...(row.last_error ? { lastError: String(row.last_error) } : {}),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export class PlatformStore {
  private readonly db: DatabaseSync;
  private readonly storeLocation: string;
  private closed = false;
  constructor(path: string) {
    this.storeLocation = resolve(path);
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
          lease_owner TEXT,
          lease_expires_at TEXT,
          heartbeat_at TEXT,
          pid INTEGER,
          process_identity TEXT,
          process_mode TEXT,
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
          created_at TEXT NOT NULL,
          correlation_id TEXT
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
        CREATE TABLE IF NOT EXISTS outbox_messages(
          message_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          state TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          next_attempt_at TEXT NOT NULL,
          claimed_by TEXT,
          claim_expires_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK(state IN ('PENDING','CLAIMED','DONE','DEAD')),
          CHECK(kind IN ('run.dispatch'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS release_approvals(
          app_id TEXT NOT NULL,
          app_version TEXT NOT NULL,
          approval_id TEXT NOT NULL,
          release_digest TEXT NOT NULL,
          state TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(app_id, app_version),
          CHECK(state IN ('ACTIVE','REVOKED'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS app_default_releases(
          app_id TEXT PRIMARY KEY,
          app_version TEXT NOT NULL,
          release_digest TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_by TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS model_health(
          selection_id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          reason TEXT,
          checked_at TEXT NOT NULL,
          catalog_digest TEXT,
          revision INTEGER NOT NULL,
          CHECK(state IN ('healthy','degraded','unavailable','unknown'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS delivery_reviews(
          review_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          state TEXT NOT NULL,
          manifest_digest TEXT,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK(state IN ('REQUESTED','APPROVED','REJECTED','SUPERSEDED'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS delivery_packages(
          package_id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          app_id TEXT NOT NULL,
          state TEXT NOT NULL,
          package_digest TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK(state IN ('SEALED','DELIVERED','RECEIVED','WITHDRAWN','SUPERSEDED'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS evaluation_sets(
          evaluation_set_id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          state TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK(state IN ('ACTIVE','ARCHIVED'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS evaluation_runs(
          evaluation_run_id TEXT PRIMARY KEY,
          evaluation_set_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          app_id TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL
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
      // Additive migration for launch leases and audit correlation.
      const attemptColsAfter = this.db.prepare('PRAGMA table_info(launch_attempts)').all() as Array<{ name: string }>;
      for (const column of ['lease_owner', 'lease_expires_at', 'heartbeat_at', 'process_identity', 'process_mode'] as const) {
        if (!attemptColsAfter.some((entry) => entry.name === column)) {
          this.db.exec(`ALTER TABLE launch_attempts ADD COLUMN ${column} TEXT`);
        }
      }
      if (!attemptColsAfter.some((entry) => entry.name === 'pid')) {
        this.db.exec('ALTER TABLE launch_attempts ADD COLUMN pid INTEGER');
      }
      const auditCols = this.db.prepare('PRAGMA table_info(audit_events)').all() as Array<{ name: string }>;
      if (!auditCols.some((column) => column.name === 'correlation_id')) {
        this.db.exec('ALTER TABLE audit_events ADD COLUMN correlation_id TEXT');
      }
      // R5 additive migration: reviews requested before deliverable binding carry no manifest
      // digest — they stay run-only facts and never match a deliverable manifest.
      const reviewCols = this.db.prepare('PRAGMA table_info(delivery_reviews)').all() as Array<{ name: string }>;
      if (!reviewCols.some((column) => column.name === 'manifest_digest')) {
        this.db.exec('ALTER TABLE delivery_reviews ADD COLUMN manifest_digest TEXT');
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS runs_by_work ON runs(work_id, state)');
      this.db.exec('CREATE INDEX IF NOT EXISTS outbox_due ON outbox_messages(state, next_attempt_at)');
      this.db.exec('CREATE INDEX IF NOT EXISTS outbox_run ON outbox_messages(run_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS attempts_open ON launch_attempts(state, lease_expires_at)');
      this.db.exec('CREATE INDEX IF NOT EXISTS audit_by_target ON audit_events(target, sequence)');
      this.db.exec('CREATE INDEX IF NOT EXISTS reviews_by_run ON delivery_reviews(run_id, created_at)');
      this.db.exec('CREATE INDEX IF NOT EXISTS packages_by_work ON delivery_packages(work_id, created_at)');
      this.db.exec('CREATE INDEX IF NOT EXISTS eval_runs_by_set ON evaluation_runs(evaluation_set_id, created_at)');
      this.db.exec(`CREATE TABLE IF NOT EXISTS run_findings(
        run_id TEXT NOT NULL,
        finding_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT,
        summary TEXT,
        fields TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, finding_key)
      ) STRICT`);
      // E2-4 model governance: one approval record per catalog selection, mirroring the
      // release-approval pattern (ACTIVE/REVOKED with revision, body kept as canonical JSON).
      this.db.exec(`CREATE TABLE IF NOT EXISTS model_approvals(
        selection_id TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        state TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(selection_id),
        CHECK(state IN ('ACTIVE','REVOKED'))
      ) STRICT`);
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
  /** The absolute on-disk store location, for honest storage-topology labels (E0d). */
  get location(): string {
    return this.storeLocation;
  }
  /** SQLite's own consistency check plus a schema identity check; used by the doctor and backup. */
  integrityCheck(): { ok: boolean; messages: string[] } {
    const messages: string[] = [];
    let ok = true;
    try {
      const quick = this.db.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: string }>;
      for (const row of quick) {
        const message = String(row.quick_check ?? '');
        if (message && message.toLowerCase() !== 'ok') { ok = false; messages.push(message) }
      }
      const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      const application = Number((this.db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id);
      if (version !== 1 || application !== CONTROL_APPLICATION_ID) {
        ok = false;
        messages.push(`schema identity mismatch (user_version=${version}, application_id=${application})`);
      }
    } catch (error) {
      ok = false;
      messages.push(error instanceof Error ? error.message : 'INTEGRITY_CHECK_FAILED');
    }
    return { ok, messages };
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
    const correlation = currentCorrelation();
    this.db
      .prepare('INSERT INTO audit_events(actor,action,target,details,created_at,correlation_id) VALUES(?,?,?,?,?,?)')
      .run(
        actor,
        action,
        target,
        canonical(details),
        new Date().toISOString(),
        correlation?.correlationId ?? null,
      );
  }
  auditList(offset: number, limit: number): { items: AuditEntry[]; total: number } {
    const rows = this.db
      .prepare('SELECT * FROM audit_events ORDER BY sequence DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Array<Record<string, unknown>>;
    const total = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count,
    );
    return { total, items: rows.map(decodeAuditRow) };
  }
  /** Ascending audit pages for a verifiable export; never reorders or rewrites facts. */
  auditRowsAfter(after: number, limit: number): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_events WHERE sequence>? ORDER BY sequence ASC LIMIT ?')
      .all(after, limit) as Array<Record<string, unknown>>;
    return rows.map(decodeAuditRow);
  }
  auditRowsForTarget(target: string, limit = 1000): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_events WHERE target=? ORDER BY sequence ASC LIMIT ?')
      .all(target, limit) as Array<Record<string, unknown>>;
    return rows.map(decodeAuditRow);
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
  // ── Default release pointers (W2/R6) ───────────────────────────────────────
  defaultReleaseGet(appId: string): AppDefaultReleaseRecord | undefined {
    const row = this.db.prepare('SELECT * FROM app_default_releases WHERE app_id=?').get(appId) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          appId: String(row.app_id),
          appVersion: String(row.app_version),
          releaseDigest: String(row.release_digest),
          revision: Number(row.revision),
          updatedBy: String(row.updated_by),
          updatedAt: String(row.updated_at),
        }
      : undefined;
  }
  defaultReleaseList(): AppDefaultReleaseRecord[] {
    const rows = this.db.prepare('SELECT * FROM app_default_releases ORDER BY app_id').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      appId: String(row.app_id),
      appVersion: String(row.app_version),
      releaseDigest: String(row.release_digest),
      revision: Number(row.revision),
      updatedBy: String(row.updated_by),
      updatedAt: String(row.updated_at),
    }));
  }
  /** CAS write of the default pointer. `expectedRevision: null` means "expect no existing
   *  pointer" (initial selection); a number means "expect the pointer at exactly that
   *  revision". Returns the new record, or null when the expectation does not hold — the
   *  caller surfaces that as a conflict and the caller's transaction (if any) rolls back.
   *  Must run inside a store transaction to be atomic against concurrent switches. */
  defaultReleaseSet(
    appId: string,
    appVersion: string,
    releaseDigest: string,
    updatedBy: string,
    updatedAt: string,
    expectedRevision: number | null,
  ): AppDefaultReleaseRecord | null {
    return this.transaction(() => {
      const current = this.defaultReleaseGet(appId);
      if (current) {
        if (expectedRevision === null || current.revision !== expectedRevision) return null;
        this.db
          .prepare(
            `UPDATE app_default_releases SET app_version=?, release_digest=?, revision=revision+1,
             updated_by=?, updated_at=? WHERE app_id=? AND revision=?`,
          )
          .run(appVersion, releaseDigest, updatedBy, updatedAt, appId, expectedRevision);
      } else {
        if (expectedRevision !== null) return null;
        this.db
          .prepare(
            'INSERT INTO app_default_releases(app_id,app_version,release_digest,revision,updated_by,updated_at) VALUES(?,?,?,1,?,?)',
          )
          .run(appId, appVersion, releaseDigest, updatedBy, updatedAt);
      }
      return this.defaultReleaseGet(appId)!;
    });
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
  runList(appId: string | undefined, offset: number, limit: number, projectIds?: string[]): { items: RunRecord[]; total: number } {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (appId) { clauses.push('app_id=?'); args.push(appId); }
    // R2 (W2): project visibility is a server-side filter, applied before pagination. Runs
    // without a Work (work_id NULL) match no project and are hidden when a project filter is
    // set — fail-closed, because their ownership cannot be resolved.
    if (projectIds !== undefined) {
      if (projectIds.length === 0) return { total: 0, items: [] };
      clauses.push(`work_id IN (SELECT work_id FROM works WHERE project_id IN (${projectIds.map(() => '?').join(',')}))`);
      args.push(...projectIds);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM runs ${where} ORDER BY updated_at DESC, run_id LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as Array<Record<string, unknown>>;
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS count FROM runs ${where}`).get(...args) as { count: number }).count,
    );
    return { total, items: rows.map((row) => this.decodeRun(row)) };
  }

  // ── E4-3 server-side filtering + keyset pagination ─────────────────────────
  /** Works matching a filter, newest first, keyed on (updated_at, work_id). The cursor is opaque
   *  to clients; a null nextCursor means the end of the result set. */
  workQuery(
    filter: { projectId?: string; projectIds?: string[]; appId?: string; state?: WorkState; q?: string },
    cursor: string | null,
    limit: number,
  ): { items: WorkRecord[]; nextCursor: string | null } {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (filter.projectId !== undefined) { clauses.push('project_id=?'); args.push(filter.projectId); }
    if (filter.projectIds !== undefined) {
      if (filter.projectIds.length === 0) return { items: [], nextCursor: null };
      clauses.push(`project_id IN (${filter.projectIds.map(() => '?').join(',')})`);
      args.push(...filter.projectIds);
    }
    if (filter.appId !== undefined) { clauses.push('app_id=?'); args.push(filter.appId); }
    if (filter.state !== undefined) { clauses.push('state=?'); args.push(filter.state); }
    if (filter.q !== undefined) {
      // Title search only (the title lives in the work's JSON body, not a column): the goal body
      // can be 100k chars and is not a search index.
      clauses.push("json_extract(body, '$.title') LIKE ? ESCAPE '\\'");
      args.push(`%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    }
    const key = cursor ? decodeCursor(cursor) : null;
    if (cursor && !key) throw new PlatformError('WORK_PAGE_INVALID', 'cursor');
    if (key) {
      clauses.push('(updated_at < ? OR (updated_at = ? AND work_id > ?))');
      args.push(key.t, key.t, key.id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    // Lookahead by one row so a full page that is also the last page ends the walk with
    // nextCursor=null instead of emitting a trailing empty page.
    const rows = this.db
      .prepare(`SELECT body FROM works ${where} ORDER BY updated_at DESC, work_id LIMIT ?`)
      .all(...args, limit + 1) as Array<{ body: string }>;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((row) => JSON.parse(row.body) as WorkRecord);
    const last = hasMore ? items.at(-1) : undefined;
    return { items, nextCursor: last ? encodeCursor(last.updatedAt, last.workId) : null };
  }
  /** Runs matching a filter, newest first, keyed on (updated_at, run_id). The optional q matches
   *  the run's input goal via SQLite JSON — a real server-side filter, not a client shortcut. */
  runQuery(
    filter: { appId?: string; workId?: string; projectId?: string; projectIds?: string[]; state?: string; q?: string },
    cursor: string | null,
    limit: number,
  ): { items: RunRecord[]; nextCursor: string | null } {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (filter.appId !== undefined) { clauses.push('app_id=?'); args.push(filter.appId); }
    if (filter.workId !== undefined) { clauses.push('work_id=?'); args.push(filter.workId); }
    if (filter.projectId !== undefined) {
      clauses.push('work_id IN (SELECT work_id FROM works WHERE project_id=?)');
      args.push(filter.projectId);
    }
    // R2 (W2): server-resolved project visibility, intersected with any explicit filter.
    // Work-less runs match no project and are hidden when a filter is set (fail-closed).
    if (filter.projectIds !== undefined) {
      if (filter.projectIds.length === 0) return { items: [], nextCursor: null };
      clauses.push(
        `work_id IN (SELECT work_id FROM works WHERE project_id IN (${filter.projectIds.map(() => '?').join(',')}))`,
      );
      args.push(...filter.projectIds);
    }
    if (filter.state !== undefined) { clauses.push('state=?'); args.push(filter.state); }
    if (filter.q !== undefined) {
      clauses.push("json_extract(input_body, '$.goal') LIKE ? ESCAPE '\\'");
      args.push(`%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    }
    const key = cursor ? decodeCursor(cursor) : null;
    if (cursor && !key) throw new PlatformError('RUN_PAGE_INVALID', 'cursor');
    if (key) {
      clauses.push('(updated_at < ? OR (updated_at = ? AND run_id > ?))');
      args.push(key.t, key.t, key.id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    // Same one-row lookahead as workQuery: the last full page ends the walk.
    const rows = this.db
      .prepare(`SELECT * FROM runs ${where} ORDER BY updated_at DESC, run_id LIMIT ?`)
      .all(...args, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((row) => this.decodeRun(row));
    const last = hasMore ? items.at(-1) : undefined;
    return { items, nextCursor: last ? encodeCursor(last.updatedAt, last.runId) : null };
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
      .prepare(
        'INSERT INTO launch_attempts(launch_id,run_id,fencing_token,state,started_at,lease_owner,lease_expires_at,heartbeat_at,pid,process_identity,process_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        attempt.launchId,
        attempt.runId,
        attempt.fencingToken,
        attempt.state,
        attempt.startedAt,
        attempt.leaseOwner ?? null,
        attempt.leaseExpiresAt ?? null,
        attempt.heartbeatAt ?? null,
        attempt.pid ?? null,
        attempt.processIdentity ?? null,
        attempt.processMode ?? null,
      );
  }
  /** Record the host process that actually runs a launch; identity is never just a reusable pid. */
  attemptSetProcess(launchId: string, process: {
    pid?: number;
    identity?: string;
    mode?: 'in-process' | 'child-process';
  }): void {
    this.db
      .prepare('UPDATE launch_attempts SET pid=?, process_identity=?, process_mode=? WHERE launch_id=?')
      .run(process.pid ?? null, process.identity ?? null, process.mode ?? null, launchId);
  }
  attemptGet(launchId: string): LaunchAttempt | undefined {
    const row = this.db.prepare('SELECT * FROM launch_attempts WHERE launch_id=?').get(launchId) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeAttempt(row) : undefined;
  }
  attemptUpdate(launchId: string, state: AttemptState, detail?: string): void {
    const terminal = state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED' || state === 'UNKNOWN';
    this.db
      .prepare('UPDATE launch_attempts SET state=?, ended_at=?, detail=? WHERE launch_id=?')
      .run(state, terminal ? new Date().toISOString() : null, detail ?? null, launchId);
  }
  /** Take or replace the supervision lease for an open launch. */
  attemptSetLease(launchId: string, owner: string, expiresAt: string): boolean {
    const result = this.db
      .prepare('UPDATE launch_attempts SET lease_owner=?, lease_expires_at=?, heartbeat_at=? WHERE launch_id=?')
      .run(owner, expiresAt, new Date().toISOString(), launchId);
    return Number(result.changes) === 1;
  }
  /** Renew only when this owner still holds the lease; a stolen/expired lease is not silently kept. */
  attemptHeartbeat(launchId: string, owner: string, expiresAt: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE launch_attempts SET lease_expires_at=?, heartbeat_at=? WHERE launch_id=? AND lease_owner=? AND state IN (\'STARTING\',\'RUNNING\')',
      )
      .run(expiresAt, new Date().toISOString(), launchId, owner);
    return Number(result.changes) === 1;
  }
  attemptClearLease(launchId: string): void {
    this.db.prepare('UPDATE launch_attempts SET lease_owner=NULL, lease_expires_at=NULL WHERE launch_id=?').run(launchId);
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
    return rows.map(decodeAttempt);
  }
  /** Open launches whose lease has expired; these need reconciliation before anything restarts. */
  expiredAttempts(now: string, limit = 100): LaunchAttempt[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM launch_attempts WHERE state IN ('STARTING','RUNNING') AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY started_at LIMIT ?",
      )
      .all(now, limit) as Array<Record<string, unknown>>;
    return rows.map(decodeAttempt);
  }
  openAttempts(limit = 100): LaunchAttempt[] {
    const rows = this.db
      .prepare("SELECT * FROM launch_attempts WHERE state IN ('STARTING','RUNNING') ORDER BY started_at LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(decodeAttempt);
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
  /** Replace one run's contributed findings wholesale (E1-4): the outcome arrives once, and a
   *  re-observation must not double-insert. Runs inside one transaction so a partial set never
   *  becomes readable. */
  findingsReplace(runId: string, findings: RunFinding[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM run_findings WHERE run_id=?').run(runId);
      const insert = this.db.prepare(
        'INSERT INTO run_findings(run_id,finding_key,kind,severity,summary,fields,created_at) VALUES(?,?,?,?,?,?,?)',
      );
      const now = new Date().toISOString();
      for (const finding of findings) {
        insert.run(
          runId,
          finding.key,
          finding.kind,
          finding.severity ?? null,
          finding.summary ?? null,
          finding.fields !== undefined ? canonical(finding.fields) : null,
          now,
        );
      }
    });
  }
  findings(runId: string): RunFinding[] {
    const rows = this.db
      .prepare('SELECT * FROM run_findings WHERE run_id=? ORDER BY kind ASC, finding_key ASC')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const fields = row.fields ? JSON.parse(String(row.fields)) as Record<string, string | number | boolean> : undefined;
      return {
        key: String(row.finding_key),
        kind: String(row.kind),
        ...(row.severity ? { severity: row.severity as RunFinding['severity'] } : {}),
        ...(row.summary ? { summary: String(row.summary) } : {}),
        ...(fields !== undefined ? { fields } : {}),
      };
    });
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
  workList(state: WorkState | undefined, offset: number, limit: number, projectIds?: string[]): { items: WorkRecord[]; total: number } {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (state) { clauses.push('state=?'); args.push(state); }
    // R2 (W2): visibility filter applied before pagination, not after.
    if (projectIds !== undefined) {
      if (projectIds.length === 0) return { total: 0, items: [] };
      clauses.push(`project_id IN (${projectIds.map(() => '?').join(',')})`);
      args.push(...projectIds);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
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

  // ── Durable dispatch outbox ────────────────────────────────────────────────
  outboxEnqueue(runId: string, at: string): OutboxMessage {
    const message: OutboxMessage = {
      messageId: `dispatch-${runId}`,
      runId,
      kind: 'run.dispatch',
      state: 'PENDING',
      attempts: 0,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        'INSERT INTO outbox_messages(message_id,run_id,kind,state,attempts,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(message.messageId, message.runId, message.kind, message.state, message.attempts, message.nextAttemptAt, at, at);
    return message;
  }
  outboxGet(messageId: string): OutboxMessage | undefined {
    const row = this.db.prepare('SELECT * FROM outbox_messages WHERE message_id=?').get(messageId) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeOutbox(row) : undefined;
  }
  outboxForRun(runId: string): OutboxMessage | undefined {
    const row = this.db
      .prepare('SELECT * FROM outbox_messages WHERE run_id=? ORDER BY created_at DESC LIMIT 1')
      .get(runId) as Record<string, unknown> | undefined;
    return row ? decodeOutbox(row) : undefined;
  }
  /** Atomic claim: stale claims return to the pool, then due PENDING rows are leased to one owner. */
  outboxClaim(owner: string, nowIso: string, limit: number, claimTtlMs: number): OutboxMessage[] {
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE outbox_messages SET state='PENDING', claimed_by=NULL, claim_expires_at=NULL, updated_at=? WHERE state='CLAIMED' AND claim_expires_at IS NOT NULL AND claim_expires_at<=?",
        )
        .run(nowIso, nowIso);
      const due = this.db
        .prepare(
          "SELECT * FROM outbox_messages WHERE state='PENDING' AND next_attempt_at<=? ORDER BY next_attempt_at, created_at LIMIT ?",
        )
        .all(nowIso, limit) as Array<Record<string, unknown>>;
      const expires = new Date(Date.parse(nowIso) + claimTtlMs).toISOString();
      const claimed: OutboxMessage[] = [];
      const claim = this.db.prepare(
        "UPDATE outbox_messages SET state='CLAIMED', claimed_by=?, claim_expires_at=?, attempts=attempts+1, updated_at=? WHERE message_id=? AND state='PENDING'",
      );
      for (const row of due) {
        const result = claim.run(owner, expires, nowIso, String(row.message_id));
        if (Number(result.changes) === 1) {
          const claimedRow = this.db.prepare('SELECT * FROM outbox_messages WHERE message_id=?').get(String(row.message_id));
          if (claimedRow) claimed.push(decodeOutbox(claimedRow as Record<string, unknown>));
        }
      }
      return claimed;
    });
  }
  outboxComplete(messageId: string): void {
    this.db
      .prepare(
        "UPDATE outbox_messages SET state='DONE', claimed_by=NULL, claim_expires_at=NULL, updated_at=? WHERE message_id=?",
      )
      .run(new Date().toISOString(), messageId);
  }
  outboxRetry(messageId: string, error: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        "UPDATE outbox_messages SET state='PENDING', claimed_by=NULL, claim_expires_at=NULL, last_error=?, next_attempt_at=?, updated_at=? WHERE message_id=?",
      )
      .run(error.slice(0, 2000), nextAttemptAt, new Date().toISOString(), messageId);
  }
  /** Return a claimed message to the pool WITHOUT spending its attempt budget, recording why it
   *  cannot start. A run whose registered artifact has no executor must stay due and visible
   *  (last_error names the missing bundle) instead of retrying into a dead letter. */
  outboxRelease(messageId: string, reason: string): void {
    // Returning the claim refunds the attempt the claim charged (claim does attempts+1): a run
    // whose registered artifact is missing must stay due and visible WITHOUT marching toward the
    // dead letter while its executor is not configured yet.
    this.db
      .prepare(
        "UPDATE outbox_messages SET state='PENDING', claimed_by=NULL, claim_expires_at=NULL, attempts=CASE WHEN attempts>0 THEN attempts-1 ELSE 0 END, last_error=?, updated_at=? WHERE message_id=?",
      )
      .run(reason.slice(0, 2000), new Date().toISOString(), messageId);
  }
  outboxDeadLetter(messageId: string, error: string): void {
    this.db
      .prepare(
        "UPDATE outbox_messages SET state='DEAD', claimed_by=NULL, claim_expires_at=NULL, last_error=?, updated_at=? WHERE message_id=?",
      )
      .run(error.slice(0, 2000), new Date().toISOString(), messageId);
  }
  /** A run that can no longer be dispatched (cancelled, terminal, archived) leaves the queue. */
  outboxCancelRun(runId: string, reason: string): number {
    const result = this.db
      .prepare(
        "UPDATE outbox_messages SET state='DONE', claimed_by=NULL, claim_expires_at=NULL, last_error=?, updated_at=? WHERE run_id=? AND state IN ('PENDING','CLAIMED')",
      )
      .run(reason.slice(0, 2000), new Date().toISOString(), runId);
    return Number(result.changes);
  }
  outboxCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT state, COUNT(*) AS count FROM outbox_messages GROUP BY state').all() as Array<{
      state: string;
      count: number;
    }>;
    return Object.fromEntries(rows.map((row) => [String(row.state), Number(row.count)]));
  }

  // ── Release approvals ──────────────────────────────────────────────────────
  approvalGet(appId: string, appVersion: string): ReleaseApprovalRecord | undefined {
    const row = this.db
      .prepare('SELECT body FROM release_approvals WHERE app_id=? AND app_version=?')
      .get(appId, appVersion) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as ReleaseApprovalRecord) : undefined;
  }
  approvalList(): ReleaseApprovalRecord[] {
    return this.db.prepare('SELECT body FROM release_approvals ORDER BY created_at DESC').all()
      .map((row) => JSON.parse(String((row as { body: string }).body)) as ReleaseApprovalRecord);
  }
  approvalPut(record: ReleaseApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO release_approvals(app_id,app_version,approval_id,release_digest,state,body,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(app_id,app_version) DO UPDATE SET
           approval_id=excluded.approval_id,
           release_digest=excluded.release_digest,
           state=excluded.state,
           body=excluded.body,
           updated_at=excluded.updated_at`,
      )
      .run(
        record.appId,
        record.appVersion,
        record.approvalId,
        record.releaseDigest,
        record.state,
        canonical(record),
        record.approvedAt,
        record.revokedAt ?? record.approvedAt,
      );
  }

  // ── Model approvals (E2-4) ─────────────────────────────────────────────────
  modelApprovalGet(selectionId: string): ModelApprovalRecord | undefined {
    const row = this.db
      .prepare('SELECT body FROM model_approvals WHERE selection_id=?')
      .get(selectionId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as ModelApprovalRecord) : undefined;
  }
  modelApprovalList(): ModelApprovalRecord[] {
    return this.db.prepare('SELECT body FROM model_approvals ORDER BY created_at DESC').all()
      .map((row) => JSON.parse(String((row as { body: string }).body)) as ModelApprovalRecord);
  }
  modelApprovalPut(record: ModelApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO model_approvals(selection_id,approval_id,state,body,created_at,updated_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(selection_id) DO UPDATE SET
           approval_id=excluded.approval_id,
           state=excluded.state,
           body=excluded.body,
           updated_at=excluded.updated_at`,
      )
      .run(
        record.selectionId,
        record.approvalId,
        record.state,
        canonical(record),
        record.approvedAt,
        record.revokedAt ?? record.approvedAt,
      );
  }

  // ── Quota counting (E2-3) ──────────────────────────────────────────────────
  /** Runs created for one project on one UTC day (YYYY-MM-DD prefix). Quota counts every run
   *  attempt — a failed run consumed the budget just like a succeeded one. */
  runCountForProjectDay(projectId: string, dayPrefix: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM runs JOIN works ON runs.work_id=works.work_id
         WHERE works.project_id=? AND runs.created_at LIKE ?`,
      )
      .get(projectId, `${dayPrefix}%`) as { count: number };
    return Number(row.count);
  }
  /** Non-terminal runs of one project, for the concurrency quota. */
  activeRunCountForProject(projectId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM runs JOIN works ON runs.work_id=works.work_id
         WHERE works.project_id=? AND runs.state IN ('QUEUED','STARTING','RUNNING')`,
      )
      .get(projectId) as { count: number };
    return Number(row.count);
  }

  // ── Model health facts ─────────────────────────────────────────────────────
  modelHealthGet(selectionId: string): ModelHealthRecord | undefined {
    const row = this.db.prepare('SELECT * FROM model_health WHERE selection_id=?').get(selectionId) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeModelHealth(row) : undefined;
  }
  modelHealthList(): ModelHealthRecord[] {
    const rows = this.db.prepare('SELECT * FROM model_health ORDER BY selection_id').all() as Array<Record<string, unknown>>;
    return rows.map(decodeModelHealth);
  }
  modelHealthPut(record: ModelHealthRecord): void {
    this.db
      .prepare(
        `INSERT INTO model_health(selection_id,state,reason,checked_at,catalog_digest,revision) VALUES(?,?,?,?,?,?)
         ON CONFLICT(selection_id) DO UPDATE SET
           state=excluded.state,
           reason=excluded.reason,
           checked_at=excluded.checked_at,
           catalog_digest=excluded.catalog_digest,
           revision=excluded.revision`,
      )
      .run(
        record.selectionId,
        record.state,
        record.reason ?? null,
        record.checkedAt,
        record.catalogDigest ?? null,
        record.revision,
      );
  }

  // ── Delivery reviews ───────────────────────────────────────────────────────
  reviewGet(reviewId: string): ReviewRecord | undefined {
    const row = this.db.prepare('SELECT body FROM delivery_reviews WHERE review_id=?').get(reviewId) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as ReviewRecord) : undefined;
  }
  reviewsForRun(runId: string): ReviewRecord[] {
    return this.db.prepare('SELECT body FROM delivery_reviews WHERE run_id=? ORDER BY created_at').all(runId)
      .map((row) => JSON.parse(String((row as { body: string }).body)) as ReviewRecord);
  }
  openReviewForRun(runId: string): ReviewRecord | undefined {
    const row = this.db
      .prepare("SELECT body FROM delivery_reviews WHERE run_id=? AND state='REQUESTED' ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as ReviewRecord) : undefined;
  }
  /** Every open (REQUESTED) review, oldest first — the E3-4 unified-todo scan. */
  openReviews(limit = 200): ReviewRecord[] {
    return this.db
      .prepare("SELECT body FROM delivery_reviews WHERE state='REQUESTED' ORDER BY created_at LIMIT ?")
      .all(limit)
      .map((row) => JSON.parse(String((row as { body: string }).body)) as ReviewRecord);
  }
  reviewInsert(record: ReviewRecord): void {
    this.db
      .prepare(
        'INSERT INTO delivery_reviews(review_id,run_id,state,manifest_digest,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        record.reviewId,
        record.runId,
        record.state,
        record.deliverable?.manifestDigest ?? null,
        canonical(record),
        record.createdAt,
        record.updatedAt,
      );
  }
  /** CAS on revision so two reviewers cannot silently overwrite each other's decision. The
   *  manifest digest column follows the record body: legacy run-only records stay NULL — a
   *  decision never retrofits a manifest onto a record that has none. */
  reviewUpdate(record: ReviewRecord, expectedRevision: number): boolean {
    return this.transaction(() => {
      const current = this.reviewGet(record.reviewId);
      if (!current || current.state !== 'REQUESTED' || current.revision !== expectedRevision) return false;
      const result = this.db
        .prepare('UPDATE delivery_reviews SET state=?, manifest_digest=?, body=?, updated_at=? WHERE review_id=?')
        .run(record.state, record.deliverable?.manifestDigest ?? null, canonical(record), record.updatedAt, record.reviewId);
      return Number(result.changes) === 1;
    });
  }

  // ── Delivery packages ──────────────────────────────────────────────────────
  packageGet(packageId: string): DeliveryPackageRecord | undefined {
    const row = this.db.prepare('SELECT body FROM delivery_packages WHERE package_id=?').get(packageId) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as DeliveryPackageRecord) : undefined;
  }
  packagesForWork(workId: string): DeliveryPackageRecord[] {
    return this.db.prepare('SELECT body FROM delivery_packages WHERE work_id=? ORDER BY created_at DESC, package_id')
      .all(workId)
      .map((row) => JSON.parse(String((row as { body: string }).body)) as DeliveryPackageRecord);
  }
  /** Packages in one state, oldest first — the E3-4 delivery-receipt todo scan. */
  packagesByState(state: DeliveryPackageRecord['state'], limit = 200): DeliveryPackageRecord[] {
    return this.db.prepare('SELECT body FROM delivery_packages WHERE state=? ORDER BY created_at LIMIT ?')
      .all(state, limit)
      .map((row) => JSON.parse(String((row as { body: string }).body)) as DeliveryPackageRecord);
  }
  packageInsert(record: DeliveryPackageRecord): void {
    this.db
      .prepare(
        'INSERT INTO delivery_packages(package_id,work_id,run_id,app_id,state,package_digest,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        record.packageId, record.workId, record.runId, record.appId, record.state,
        record.packageDigest, canonical(record), record.createdAt, record.updatedAt,
      );
  }
  /** CAS on revision so two operators cannot silently overwrite each other's delivery act. */
  packageUpdate(record: DeliveryPackageRecord, expectedRevision: number): boolean {
    return this.transaction(() => {
      const current = this.packageGet(record.packageId);
      if (!current || current.revision !== expectedRevision) return false;
      const result = this.db
        .prepare('UPDATE delivery_packages SET state=?, package_digest=?, body=?, updated_at=? WHERE package_id=?')
        .run(record.state, record.packageDigest, canonical(record), record.updatedAt, record.packageId);
      return Number(result.changes) === 1;
    });
  }

  // ── Deterministic evaluation harness (E2-1 fallback) ──────────────────────
  evaluationSetGet(evaluationSetId: string): EvaluationSetRecord | undefined {
    const row = this.db.prepare('SELECT body FROM evaluation_sets WHERE evaluation_set_id=?').get(evaluationSetId) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as EvaluationSetRecord) : undefined;
  }
  evaluationSetsByApp(appId: string | undefined): EvaluationSetRecord[] {
    const rows = (appId === undefined
      ? this.db.prepare('SELECT body FROM evaluation_sets ORDER BY created_at').all()
      : this.db.prepare('SELECT body FROM evaluation_sets WHERE app_id=? ORDER BY created_at').all(appId)) as
      Array<{ body: string }>;
    return rows.map((row) => JSON.parse(row.body) as EvaluationSetRecord);
  }
  evaluationSetInsert(record: EvaluationSetRecord): void {
    this.db
      .prepare('INSERT INTO evaluation_sets(evaluation_set_id,app_id,state,body,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(record.evaluationSetId, record.appId, record.state, canonical(record), record.createdAt, record.updatedAt);
  }
  evaluationSetUpdate(record: EvaluationSetRecord): void {
    this.db
      .prepare('UPDATE evaluation_sets SET state=?, body=?, updated_at=? WHERE evaluation_set_id=?')
      .run(record.state, canonical(record), record.updatedAt, record.evaluationSetId);
  }
  evaluationRunGet(evaluationRunId: string): EvaluationRunRecord | undefined {
    const row = this.db.prepare('SELECT body FROM evaluation_runs WHERE evaluation_run_id=?').get(evaluationRunId) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as EvaluationRunRecord) : undefined;
  }
  evaluationRunsBySet(evaluationSetId: string): EvaluationRunRecord[] {
    return this.db
      .prepare('SELECT body FROM evaluation_runs WHERE evaluation_set_id=? ORDER BY created_at DESC, evaluation_run_id')
      .all(evaluationSetId)
      .map((row) => JSON.parse(String((row as { body: string }).body)) as EvaluationRunRecord);
  }
  evaluationRunInsert(record: EvaluationRunRecord): void {
    this.db
      .prepare('INSERT INTO evaluation_runs(evaluation_run_id,evaluation_set_id,run_id,app_id,body,created_at) VALUES(?,?,?,?,?,?)')
      .run(record.evaluationRunId, record.evaluationSetId, record.runId, record.appId, canonical(record), record.createdAt);
  }
}
