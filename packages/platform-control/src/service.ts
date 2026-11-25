/** Control-plane service: application registry + persistent runs + supervisor-facing transitions.
 *  It never imports or executes application code; a worker executor is an external dependency. */
import type { ExecutionPlan } from '../../platform-runtime/src/plan.js';
import type { RunEvent, RunSnapshot } from '../../platform-runtime/src/run.js';
import { RunError } from '../../platform-runtime/src/run.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  AuthorizationError,
  LocalOperatorPolicy,
  type KnowledgeDeploymentScope,
  type KnowledgeTenantScope,
  type PlatformAction,
  type PlatformPolicy,
  type Principal,
} from './policy.js';
import { ApplicationRegistry, PlatformError } from './registry.js';
import { RunRepository, runInputDigest } from './runs.js';
import { WorkRepository, type WorkDraft } from './works.js';
import { ProjectRepository, type ProjectDraft, type WorkspaceDraft } from './projects.js';
import {
  ExecutionDomainRepository,
  WorkSessionBindingRepository,
  type BindWorkSessionDraft,
  type ExecutionDomainDraft,
} from './session-bindings.js';
import { SubmissionRepository, type SubmissionDraft } from './submissions.js';
import { InputBaselineRepository, type InputBaselineDraft } from './input-baselines.js';
import { DeliveryPackageRepository, deliveryPackageDigest } from './delivery.js';
import type { DeliveryPackageRecord, DeterministicCheck, EvaluationCheckResult, EvaluationRunRecord, EvaluationSetRecord } from './store.js';
import type { ExecutionDomainRecord, ExecutionDomainState, InputBaselineRecord, WorkSessionBindingRecord } from './store.js';
// 学习平台 L1/L2/L3：知识权威服务访问面（进程内或 HTTP 实现共用同一合同）与数据合同类型。
import type { KnowledgeAccess } from '../../platform-knowledge/src/access.js';
import type { KnowledgePrincipal } from '../../platform-knowledge/src/identity-scope.js';
import type { KnowledgeContext } from '../../platform-knowledge/src/schema.js';
import type { KnowledgeReleaseRecord, LearningCaseSourceEvent, LearningCaseStatus } from '../../platform-knowledge/src/learning.js';
import type { PersonalDraftRecord, PersonalSettingRecord } from '../../platform-knowledge/src/preferences.js';
import {
  findCatalogEntry,
  modelCatalogDigest,
  normalizeSelectionOptions,
  requireAvailableEntry,
  retrySnapshot,
  snapshotSelection,
  validateModelCatalog,
  type ModelCatalogRecord,
  type ModelCatalogEntry,
  type ModelConfigSnapshot,
  type ModelPreferenceView,
  type ModelSelectionSource,
} from './models.js';
import {
  decodeCursor,
  encodeCursor,
  PlatformStore,
  type AppDefaultReleaseRecord,
  type AppRecord,
  type AppState,
  type AppReleaseDraft,
  type ArtifactRecord,
  type AuditEntry,
  type InputCommit,
  type InteractionRecord,
  type InteractionState,
  type LaunchAttempt,
  type ModelApprovalRecord,
  type ModelHealthRecord,
  type ModelHealthState,
  type OutboxMessage,
  type ReleaseApprovalRecord,
  type ReviewRecord,
  reviewDeliverableDigest,
  type RunRecord,
  type WorkRecord,
  type WorkState,
} from './store.js';
import { logger, metrics } from './observability.js';

const MAX_SEALED_BYTES = 64 * 1024 * 1024;
const MAX_SEALED_TOTAL_BYTES = 256 * 1024 * 1024;
const OUTBOX_MAX_ATTEMPTS = 5;
const OUTBOX_CLAIM_TTL_MS = 5 * 60 * 1000;
const OUTBOX_RETRY_BASE_MS = 15 * 1000;
// 知识捕获 outbox（T04）：先入队再投递；有限重试 + 死信 + 人工重放。
const KNOWLEDGE_OUTBOX_MAX_ATTEMPTS = 5;
const KNOWLEDGE_OUTBOX_CLAIM_TTL_MS = 5 * 60 * 1000;
const KNOWLEDGE_OUTBOX_RETRY_BASE_MS = 2 * 1000;
const KNOWLEDGE_OUTBOX_RETRY_MAX_MS = 60 * 1000;
const OUTBOX_RETRY_MAX_MS = 10 * 60 * 1000;
const LAUNCH_LEASE_TTL_MS = 2 * 60 * 1000;

export interface ServiceOptions {
  requireArtifacts?: boolean;
  /** Every run's release must have an ACTIVE deployment approval matching its release digest. */
  requireReleaseApproval?: boolean;
  /** A catalog entry whose last recorded health is `unavailable` cannot start a run. */
  requireModelHealth?: boolean;
  /** Every run's model selection must carry an ACTIVE model approval (E2-4). Default off: the
   *  mechanism ships, each deployment decides. */
  requireModelApproval?: boolean;
  /** Per-project run quotas (E2-3). 0/undefined disables that cap. Runs not bound to a Work
   *  carry no project and are deliberately NOT counted — that fact is surfaced, never hidden. */
  quotas?: {
    maxConcurrentRunsPerProject?: number;
    maxRunsPerDayPerProject?: number;
  };
  /** Global cap on concurrently open launches; 0/undefined means no cap. */
  maxConcurrentRuns?: number;
}

export interface RunArtifact {
  name: string;
  digest: string;
  bytes: number;
  mediaType?: string;
  /** Worker-workspace path the executor validated; the control plane seals the bytes itself. */
  sourcePath?: string;
}
/** One app-contributed result fact with a stable business key (E1-4). Cross-run alignment is by
 *  `key` within a `kind` — never by row order or line number. `fields` feeds declarative result
 *  views (E1-5); the platform renders whatever the descriptor declares and knows no app by name. */
export interface RunFinding {
  key: string;
  kind: string;
  severity?: 'info' | 'warning' | 'error';
  summary?: string;
  fields?: Record<string, string | number | boolean>;
}

const MAX_FINDINGS = 2000;
const FINDING_FIELD_VALUES = new Set(['string', 'number', 'boolean']);
/** Strict shape check for app-contributed findings (E1-4). A malformed contribution fails the run
 *  instead of being silently trimmed: declared facts must survive validation or not land at all. */
export function validateFindings(value: unknown): RunFinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    throw new PlatformError('RUN_FINDING_INVALID', 'findings');
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PlatformError('RUN_FINDING_INVALID', 'entry');
    }
    const finding = entry as Record<string, unknown>;
    if (typeof finding.key !== 'string' || !finding.key.trim() || finding.key.length > 256) {
      throw new PlatformError('RUN_FINDING_INVALID', 'key');
    }
    const key = finding.key.trim();
    if (seen.has(key)) throw new PlatformError('RUN_FINDING_INVALID', `duplicate key ${key}`);
    seen.add(key);
    if (typeof finding.kind !== 'string' || !finding.kind.trim() || finding.kind.length > 64) {
      throw new PlatformError('RUN_FINDING_INVALID', 'kind');
    }
    if (finding.severity !== undefined && finding.severity !== 'info' && finding.severity !== 'warning' && finding.severity !== 'error') {
      throw new PlatformError('RUN_FINDING_INVALID', 'severity');
    }
    if (finding.summary !== undefined && (typeof finding.summary !== 'string' || finding.summary.length > 2000)) {
      throw new PlatformError('RUN_FINDING_INVALID', 'summary');
    }
    let fields: RunFinding['fields'];
    if (finding.fields !== undefined) {
      if (!finding.fields || typeof finding.fields !== 'object' || Array.isArray(finding.fields)) {
        throw new PlatformError('RUN_FINDING_INVALID', 'fields');
      }
      const entries = Object.entries(finding.fields as Record<string, unknown>);
      if (entries.length > 32) throw new PlatformError('RUN_FINDING_INVALID', 'fields size');
      fields = {};
      for (const [field, fieldValue] of entries) {
        if (!field.trim() || field.length > 100 || !FINDING_FIELD_VALUES.has(typeof fieldValue)) {
          throw new PlatformError('RUN_FINDING_INVALID', `field ${field}`);
        }
        if (typeof fieldValue === 'number' && !Number.isFinite(fieldValue)) {
          throw new PlatformError('RUN_FINDING_INVALID', `field ${field}`);
        }
        fields[field] = fieldValue as string | number | boolean;
      }
    }
    return {
      key,
      kind: finding.kind.trim(),
      ...(finding.severity !== undefined ? { severity: finding.severity } : {}),
      ...(finding.summary !== undefined && finding.summary.trim() ? { summary: finding.summary.trim() } : {}),
      ...(fields !== undefined ? { fields } : {}),
    };
  });
}
/** One piece of live model activity, projected from public session events. */
export interface RunActivity {
  kind: 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'status';
  text: string;
  detail?: string;
  sessionId: string;
  /** Source session-event sequence, used to dedupe live and final projections. */
  seq?: number;
  createdAt: string;
}
export interface RunOutcome {
  status: 'succeeded' | 'failed' | 'cancelled';
  finalResponse?: string;
  error?: string;
  sessionId?: string;
  /** Digests reported by the executor; the control plane records them as run artifacts. */
  artifacts?: RunArtifact[];
  /** App-contributed result facts with stable business keys; recorded once for a succeeded run. */
  findings?: RunFinding[];
  /** SDK turn finish reason; success requires `completed`, not merely a returned run. */
  finishReason?: string | null;
  /** Latest assistant response and durable activity projection for the employee conversation view. */
  activities?: RunActivity[];
  /** True only when no unobserved descendant activity remains (worker-observed notifications). */
  descendantsDone?: boolean;
  /** Exact dispatched input prefix whose inbox admission and claim were observed. */
  consumedThrough?: number;
  /** Public root-session model/selection facts, not proof of adapter network traffic. */
  modelSelections?: Array<{ provider: string; model: string; reasoningEffort?: string }>;
  /** Explicit teardown settlement; never inferred from an assistant response. */
  cleanedUp?: boolean;
  /** Only true proves worker exit; absent evidence fails closed to UNKNOWN. */
  exitProven?: boolean;
}
export interface UserQuestionItem {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}
export interface UserQuestionRequest {
  requestId: string;
  sessionId: string;
  questions: UserQuestionItem[];
}
export type UserQuestionResult =
  | { answers: Array<{ id: string; selected: string[]; custom?: string }> }
  | { cancelled: true };
export interface RunLaunch {
  launchId: string;
  fencingToken: number;
  /** Present when the executor can report the worker's eventual outcome. */
  outcome?: Promise<RunOutcome>;
  /** Host process that runs the launch, when the executor knows it. */
  process?: {
    pid?: number;
    identity?: string;
    mode?: 'in-process' | 'child-process';
  };
}
export interface RunExecutor {
  readonly kind: string;
  dispatch(input: {
    run: RunRecord;
    plan: ExecutionPlan;
    inputs?: InputCommit[];
    /** Frozen model route for this run; null means the run predates the model catalog. */
    model?: ModelConfigSnapshot | null;
    launchId?: string;
    fencingToken?: number;
    /** SDK-native user questions are persisted and answered through the platform inbox. */
    onUserQuestion?: (request: UserQuestionRequest, context: { signal: AbortSignal }) => Promise<UserQuestionResult>;
    /** Called once the worker runtime is actually starting, so the run leaves STARTING early. */
    onStarted?: () => void;
    /** Live assistant/tool activity from public SDK notifications, before the run settles. */
    onActivity?: (activity: RunActivity) => void;
  }): Promise<RunLaunch>;
  cancel(launchId: string): Promise<boolean>;
}
export interface ControlStatus {
  apps: { active: number; revoked: number };
  runs: { total: number; queued: number; running: number; terminal: number };
  artifacts: number;
  executor: string;
  auditEntries: number;
  outbox?: Record<string, number>;
  approvals?: { active: number; revoked: number };
}
export interface CancelResult {
  record: RunRecord;
  cancelSettled: boolean;
}

/** Trusted run facts handed to a deployment-owned knowledge sink for candidate capture. The sink
 *  must bind runId/inputDigest/artifact digests itself; a model cannot supply them. */
export interface KnowledgeCaptureEvent {
  kind: 'run.failed' | 'run.unknown' | 'run.succeeded' | 'run.cancelled' | 'qc.completed';
  runId: string;
  workId: string | null;
  appId: string;
  appVersion: string;
  projectId?: string;
  /** 该 Run 绑定的知识域（插件 identity）；未绑定时缺省，sink 不得猜测。 */
  pluginId?: string;
  inputDigest: string;
  artifactDigests: string[];
  reason?: string;
  /** 复核决定（kind=qc.completed）：reviewId 与决定本身都是可信事实，决定不回写、不可重复投递。 */
  review?: { reviewId: string; decision: 'APPROVED' | 'REJECTED'; note?: string };
  at: string;
}

export class PlatformControlService {
  private readonly store: PlatformStore;
  private readonly registry: ApplicationRegistry;
  private readonly runs: RunRepository;
  private readonly works: WorkRepository;
  private readonly projects: ProjectRepository;
  private readonly domains: ExecutionDomainRepository;
  private readonly bindings: WorkSessionBindingRepository;
  private readonly submissions: SubmissionRepository;
  private readonly inputBaselines: InputBaselineRepository;
  private readonly deliveryPackages: DeliveryPackageRepository;
  private policy: PlatformPolicy;
  private readonly requireArtifacts: boolean;
  private readonly requireReleaseApproval: boolean;
  private readonly requireModelHealth: boolean;
  private readonly requireModelApproval: boolean;
  private readonly quotaMaxConcurrentRunsPerProject: number;
  private readonly quotaMaxRunsPerDayPerProject: number;
  private readonly maxConcurrentRuns: number;
  private executor: RunExecutor | null;
  /** W3/R6: executors registered for one exact runtime bundle digest. Dispatch resolves the
   *  worker by the RUN's frozen bundle — never by the app's default release — so two different
   *  artifacts drain under their original locks and a run whose artifact is missing never
   *  starts, never falls back to another version's worker. */
  private readonly executorsByDigest = new Map<string, RunExecutor>();
  private knowledgeSource?: (
    app: AppRecord,
    projectId: string,
    scope: KnowledgeTenantScope,
    options?: { actorId?: string },
  ) => RunRecord['knowledge'] | undefined;
  private knowledgeScope?: KnowledgeDeploymentScope;
  private knowledgeCaptureSink?: (event: KnowledgeCaptureEvent) => { outcome?: string } | void | Promise<{ outcome?: string } | void>;
  /** L1/L2/L3 知识权威服务访问面（进程内或 HTTP）；未装配时交互端点 503 降级（§5 故障语义）。 */
  private knowledgeAccess?: KnowledgeAccess;
  private closed = false;
  private readonly conversationActivities = new Map<string, NonNullable<RunOutcome['activities']>>();
  /** Live activity feed (E4-7): cursor-tagged entries so SSE can resume without re-reading the run. */
  private readonly activityLog = new Map<string, Array<{ cursor: number; activity: RunActivity }>>();
  private readonly activityCursor = new Map<string, number>();
  private readonly activityWaiters = new Map<string, Set<(entry: { cursor: number; activity: RunActivity }) => void>>();
  private readonly conversationInputs = new Map<string, Array<{ role: 'user'; text: string; createdAt: string }>>();
  /** Live waiters for SDK user questions; persistence is the durable inbox the UI reads. */
  private readonly interactionWaiters = new Map<string, (result: UserQuestionResult) => void>();
  private readonly sealRoot: string;
  constructor(
    path: string,
    executor: RunExecutor | null = null,
    policy: PlatformPolicy = new LocalOperatorPolicy(),
    options: ServiceOptions = {},
  ) {
    this.store = new PlatformStore(path);
    this.sealRoot = join(dirname(path), 'artifacts');
    this.registry = new ApplicationRegistry(this.store);
    this.runs = new RunRepository(this.store);
    this.works = new WorkRepository(this.store);
    this.projects = new ProjectRepository(this.store);
    this.domains = new ExecutionDomainRepository(this.store);
    this.bindings = new WorkSessionBindingRepository(this.store);
    this.submissions = new SubmissionRepository(this.store);
    this.inputBaselines = new InputBaselineRepository(this.store);
    this.deliveryPackages = new DeliveryPackageRepository(this.store);
    this.policy = policy;
    this.executor = executor;
    this.requireArtifacts = options.requireArtifacts ?? true;
    this.requireReleaseApproval = options.requireReleaseApproval ?? false;
    this.requireModelHealth = options.requireModelHealth ?? false;
    this.requireModelApproval = options.requireModelApproval ?? false;
    this.quotaMaxConcurrentRunsPerProject = options.quotas?.maxConcurrentRunsPerProject ?? 0;
    this.quotaMaxRunsPerDayPerProject = options.quotas?.maxRunsPerDayPerProject ?? 0;
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 0;
  }
  setExecutor(executor: RunExecutor): void {
    this.executor = executor;
  }
  /** Register an executor for one exact runtime bundle digest (W3/R6). The digest must be a
   *  real bundle digest: a typo or placeholder would strand every run queued without an
   *  honest reason. */
  registerExecutor(runtimeBundleDigest: string, executor: RunExecutor): void {
    if (typeof runtimeBundleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(runtimeBundleDigest)) {
      throw new PlatformError('WORKER_CONFIG_INVALID', 'runtimeBundleDigest 必须是 64 位十六进制摘要');
    }
    this.executorsByDigest.set(runtimeBundleDigest, executor);
  }
  /** The executor registered for this exact bundle; a deployment configured with a single
   *  worker (constructor/setExecutor) keeps its prior behavior — that executor's own dispatch
   *  re-checks digest equality (WORKER_RUNTIME_MISMATCH) as the second exactness gate. */
  private executorFor(runtimeBundleDigest: string): RunExecutor | null {
    return this.executorsByDigest.get(runtimeBundleDigest) ?? this.executor;
  }
  /** Deployment seam: an enterprise identity/project-authorization plugin replaces the local policy. */
  setPolicy(policy: PlatformPolicy): void {
    this.policy = policy;
  }
  /** Deployment seam (KA11): knowledge snapshot source, read-only against the knowledge store.
   *  Bound at run creation so in-flight runs do not drift when knowledge changes; the control
   *  plane never writes the knowledge store (single-writer stays with KnowledgeService). */
  setKnowledgeSnapshotSource(
    source:
      | ((
          app: AppRecord,
          projectId: string,
          scope: KnowledgeTenantScope,
          options?: { actorId?: string },
        ) => RunRecord['knowledge'] | undefined)
      | null,
  ): void {
    this.knowledgeSource = source ?? undefined;
  }
  /** Deployment seam (WP2): the trusted knowledge tenant scope from the assembly/identity channel.
   *  Business callers can only narrow it; the scope is never accepted from run input. */
  setKnowledgeScope(scope: KnowledgeDeploymentScope | undefined): void {
    this.knowledgeScope = scope;
  }
  /** WP2: derive the trusted tenant scope for a run creator. Enterprise deployments may only
   *  narrow the configured ceiling — a principal claiming a different org/region is refused as
   *  an escalation. When neither the deployment nor the identity supplies an org/region, run
   *  creation for a knowledge-declaring app fails with a diagnosable state instead of binding
   *  records across tenants. Local mode binds the explicit standalone (unscoped) snapshot. */
  private effectiveKnowledgeScope(principal: Principal): KnowledgeTenantScope {
    const scope = this.knowledgeScope;
    if (!scope || scope.mode === 'local') return {};
    if (scope.orgId !== undefined && principal.orgId !== undefined && principal.orgId !== scope.orgId) {
      throw new PlatformError('KNOWLEDGE_SCOPE_ESCALATION', principal.orgId);
    }
    if (scope.region !== undefined && principal.region !== undefined && principal.region !== scope.region) {
      throw new PlatformError('KNOWLEDGE_SCOPE_ESCALATION', principal.region);
    }
    const orgId = scope.orgId ?? principal.orgId;
    const region = scope.region ?? principal.region;
    if (orgId === undefined && region === undefined) {
      throw new PlatformError('KNOWLEDGE_SCOPE_UNAVAILABLE', '无可信组织/区域：部署与身份均未提供企业范围');
    }
    return {
      ...(orgId !== undefined ? { orgId } : {}),
      ...(region !== undefined ? { region } : {}),
    };
  }
  /** Deployment seam: a sink may create CANDIDATE knowledge from trusted terminal run facts. It
   *  receives digests and identifiers only; it never receives run input text, and it can never
   *  activate knowledge (activation stays with KnowledgeService and its validation receipts). */
  setKnowledgeCaptureSink(
    sink: ((event: KnowledgeCaptureEvent) => { outcome?: string } | void | Promise<{ outcome?: string } | void>) | null,
  ): void {
    this.knowledgeCaptureSink = sink ?? undefined;
  }
  /** L1/L2/L3：装配知识权威服务访问面（InProcessKnowledgeAccess 或 HttpKnowledgeAccess）。
   *  未装配时偏好/学习/发布交互端点 503 降级——工作台可按标准呈现继续工作（§5）。 */
  setKnowledgeAccess(access: KnowledgeAccess | null): void {
    this.knowledgeAccess = access ?? undefined;
  }
  /** Persist worker process-exit evidence so cancels remain settleable across control restarts. */
  recordExitEvidence(launchId: string, proven: boolean): void {
    this.store.attemptSetExitProven(launchId, proven);
    this.store.attemptClearLease(launchId);
  }
  readExitEvidence(launchId: string): boolean | null {
    return this.store.attemptExitProven(launchId);
  }

  // ── L1/L2/L3 知识权威服务交互面（开发设计 §5 行为合同） ──────────────────────────
  /** owner/租户一律从已验证身份派生；未装配访问面时 503 降级（偏好服务不可用→按标准呈现继续工作）。 */
  private requireKnowledgeAccess(): KnowledgeAccess {
    if (!this.knowledgeAccess) throw new PlatformError('KNOWLEDGE_SERVICE_UNAVAILABLE', '知识权威服务未装配');
    return this.knowledgeAccess;
  }
  private toKnowledgePrincipal(principal: Principal): KnowledgePrincipal {
    return {
      actorId: principal.actorId,
      ...(principal.orgId !== undefined ? { orgId: principal.orgId } : {}),
      ...(principal.region !== undefined ? { region: principal.region } : {}),
    };
  }
  /** 学习个案的检索上下文：插件/项目来自调用参数，租户来自可信部署范围（企业模式缺失可诊断失败）。 */
  private learningContext(principal: Principal, input: { pluginId: string; projectId?: string }): KnowledgeContext {
    const scope = this.effectiveKnowledgeScope(principal);
    return {
      pluginId: input.pluginId,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...scope,
    };
  }
  preferencesGetMine(principal: Principal, options: { pluginId?: string } = {}): Promise<PersonalSettingRecord[]> {
    this.policy.authorize(principal, 'preference.read');
    return this.requireKnowledgeAccess().preferencesGetMine(this.toKnowledgePrincipal(principal), options);
  }
  preferencesSetMine(
    principal: Principal,
    input: { key: string; value: unknown; pluginId?: string; expectedRevision: number },
  ): Promise<PersonalSettingRecord> {
    this.policy.authorize(principal, 'preference.write');
    return this.requireKnowledgeAccess().preferencesSetMine(this.toKnowledgePrincipal(principal), input);
  }
  preferencesPauseMine(principal: Principal, key: string, pluginId?: string): Promise<PersonalSettingRecord> {
    this.policy.authorize(principal, 'preference.write');
    return this.requireKnowledgeAccess().preferencesPauseMine(this.toKnowledgePrincipal(principal), key, pluginId);
  }
  preferencesDeleteMine(principal: Principal, key: string, pluginId?: string): Promise<PersonalSettingRecord> {
    this.policy.authorize(principal, 'preference.write');
    return this.requireKnowledgeAccess().preferencesDeleteMine(this.toKnowledgePrincipal(principal), key, pluginId);
  }
  personalDraftCreate(
    principal: Principal,
    input: { pluginId?: string; title: string; body: string },
  ): Promise<PersonalDraftRecord> {
    this.policy.authorize(principal, 'preference.write');
    return this.requireKnowledgeAccess().personalDraftCreate(this.toKnowledgePrincipal(principal), input);
  }
  personalDraftListMine(principal: Principal): Promise<PersonalDraftRecord[]> {
    this.policy.authorize(principal, 'preference.read');
    return this.requireKnowledgeAccess().personalDraftListMine(this.toKnowledgePrincipal(principal));
  }
  personalDraftUpdateMine(
    principal: Principal,
    draftId: string,
    expectedRevision: number,
    patch: { title?: string; body?: string },
  ): Promise<PersonalDraftRecord> {
    this.policy.authorize(principal, 'preference.write');
    return this.requireKnowledgeAccess().personalDraftUpdateMine(this.toKnowledgePrincipal(principal), draftId, expectedRevision, patch);
  }
  personalDraftDeleteMine(principal: Principal, draftId: string): Promise<PersonalDraftRecord> {
    this.policy.authorize(principal, 'preference.write');
    return this.requireKnowledgeAccess().personalDraftDeleteMine(this.toKnowledgePrincipal(principal), draftId);
  }
  learningCasesList(
    principal: Principal,
    input: { pluginId: string; projectId?: string; status?: LearningCaseStatus; limit?: number },
  ) {
    this.policy.authorize(principal, 'learning.case.read');
    return this.requireKnowledgeAccess().learningCases(this.learningContext(principal, input), {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }
  learningCaseOpen(
    principal: Principal,
    input: { pluginId: string; projectId?: string; sourceEvent: LearningCaseSourceEvent; hypothesisKey: string; category?: string },
  ) {
    this.policy.authorize(principal, 'learning.case.propose');
    return this.requireKnowledgeAccess().learningCaseOpen(this.learningContext(principal, input), {
      sourceEvent: input.sourceEvent,
      hypothesisKey: input.hypothesisKey,
      ...(input.category !== undefined ? { category: input.category } : {}),
    });
  }
  learningCaseDispose(
    principal: Principal,
    input: { pluginId: string; projectId?: string; caseId: string; disposition: 'NO_REUSABLE' | 'PENDING' | 'CONFLICT'; reason?: string },
  ) {
    this.policy.authorize(principal, 'learning.case.propose');
    return this.requireKnowledgeAccess().learningCaseDispose(
      this.learningContext(principal, input),
      input.caseId,
      input.disposition,
      input.reason,
    );
  }
  learningProposeFromCase(
    principal: Principal,
    input: {
      pluginId: string;
      projectId?: string;
      caseId: string;
      contributionConfirmed: boolean;
      idempotencyKey: string;
      draft: Record<string, unknown>;
    },
  ) {
    this.policy.authorize(principal, 'learning.case.propose');
    return this.requireKnowledgeAccess().proposeFromCase(this.learningContext(principal, input), this.toKnowledgePrincipal(principal), {
      caseId: input.caseId,
      contributionConfirmed: input.contributionConfirmed,
      idempotencyKey: input.idempotencyKey,
      draft: input.draft,
    });
  }
  releasesList(principal: Principal, input: { pluginId: string; state?: KnowledgeReleaseRecord['state']; limit?: number }) {
    this.policy.authorize(principal, 'knowledge.release.read');
    return this.requireKnowledgeAccess().releasesList(this.toKnowledgePrincipal(principal), input);
  }
  knowledgeReleasePublish(
    principal: Principal,
    input: {
      pluginId: string;
      audience: string;
      entries: Array<{ knowledgeId: string; revision: number }>;
      evalReportRef?: string;
      expectedVersion: number;
    },
  ) {
    this.policy.authorize(principal, 'knowledge.release.publish');
    return this.requireKnowledgeAccess().publishRelease(this.toKnowledgePrincipal(principal), input);
  }
  knowledgeReleaseWithdraw(principal: Principal, releaseId: string, reason: string) {
    this.policy.authorize(principal, 'knowledge.release.withdraw');
    return this.requireKnowledgeAccess().withdrawRelease(this.toKnowledgePrincipal(principal), releaseId, reason);
  }
  knowledgeReleaseRollback(
    principal: Principal,
    input: { pluginId: string; expectedVersion: number; toReleaseId?: string; reason: string },
  ) {
    this.policy.authorize(principal, 'knowledge.release.rollback');
    return this.requireKnowledgeAccess().rollbackRelease(this.toKnowledgePrincipal(principal), input);
  }
  knowledgeReleasePointer(principal: Principal, pluginId: string) {
    this.policy.authorize(principal, 'knowledge.release.read');
    return this.requireKnowledgeAccess().releasePointerInfo(this.toKnowledgePrincipal(principal), pluginId);
  }
  /** 发布撤回影响面（T06）：受影响 Run 待复核清单；不重写运行事实。 */
  knowledgeReleaseImpact(principal: Principal, releaseId: string): { runs: string[] } {
    this.policy.authorize(principal, 'knowledge.release.read');
    return { runs: this.store.runsBoundToRelease(releaseId) };
  }

  // ── Release approvals ──────────────────────────────────────────────────────
  /** Record a deployment approval bound to the exact current release digest. An approval for a
   *  different digest is refused: approving "version 1.0.0" after the package changed would
   *  silently approve different bytes. */
  approveRelease(
    draft: {
      appId: string;
      appVersion: string;
      releaseDigest: string;
      approvedBy: string;
      evidence?: string;
      rollbackTarget?: string;
      expiresAt?: string;
    },
    principal: Principal,
  ): ReleaseApprovalRecord {
    this.policy.authorize(principal, 'app.approve', { appId: draft?.appId });
    const app = this.registry.get(draft?.appId, draft?.appVersion);
    if (app.state !== 'ACTIVE') throw new PlatformError('APP_RELEASE_NOT_ACTIVE', `${app.appId}@${app.appVersion}`);
    if (typeof draft.releaseDigest !== 'string' || draft.releaseDigest !== app.releaseDigest) {
      throw new PlatformError('APP_APPROVAL_DIGEST_MISMATCH', `${draft.releaseDigest} != ${app.releaseDigest}`);
    }
    const approvedBy = typeof draft.approvedBy === 'string' ? draft.approvedBy.trim() : '';
    if (!approvedBy || approvedBy.length > 200) throw new PlatformError('APP_APPROVAL_INVALID', 'approvedBy');
    for (const key of ['evidence', 'rollbackTarget'] as const) {
      const value = draft[key];
      if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 2000)) {
        throw new PlatformError('APP_APPROVAL_INVALID', key);
      }
    }
    if (draft.expiresAt !== undefined && Number.isNaN(Date.parse(draft.expiresAt))) {
      throw new PlatformError('APP_APPROVAL_INVALID', 'expiresAt');
    }
    const existing = this.store.approvalGet(app.appId, app.appVersion);
    const now = new Date().toISOString();
    const record: ReleaseApprovalRecord = {
      approvalId: existing?.approvalId ?? `approval-${randomUUID()}`,
      appId: app.appId,
      appVersion: app.appVersion,
      releaseDigest: app.releaseDigest,
      state: 'ACTIVE',
      approvedBy,
      approvedAt: now,
      ...(draft.evidence !== undefined ? { evidence: draft.evidence } : {}),
      ...(draft.rollbackTarget !== undefined ? { rollbackTarget: draft.rollbackTarget } : {}),
      ...(draft.expiresAt !== undefined ? { expiresAt: draft.expiresAt } : {}),
      revision: (existing?.revision ?? 0) + 1,
    };
    this.store.transaction(() => {
      this.store.approvalPut(record);
      this.store.audit(principal.actorId, 'APP_RELEASE_APPROVED', `${app.appId}@${app.appVersion}`, {
        approvalId: record.approvalId,
        releaseDigest: record.releaseDigest,
        approvedBy,
        ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      });
    });
    return record;
  }
  revokeReleaseApproval(appId: string, appVersion: string, reason: string, principal: Principal): ReleaseApprovalRecord {
    this.policy.authorize(principal, 'app.approve', { appId });
    const record = this.store.approvalGet(appId, appVersion);
    if (!record) throw new PlatformError('APP_APPROVAL_NOT_FOUND', `${appId}@${appVersion}`);
    if (record.state === 'REVOKED') return record;
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (!trimmed) throw new PlatformError('APP_APPROVAL_INVALID', 'reason');
    const now = new Date().toISOString();
    const next: ReleaseApprovalRecord = {
      ...record,
      state: 'REVOKED',
      revokedAt: now,
      revokeReason: trimmed,
      revision: record.revision + 1,
    };
    this.store.transaction(() => {
      this.store.approvalPut(next);
      this.store.audit(principal.actorId, 'APP_RELEASE_APPROVAL_REVOKED', `${appId}@${appVersion}`, {
        approvalId: record.approvalId,
        reason: trimmed,
      });
    });
    return next;
  }
  releaseApproval(appId: string, appVersion: string, principal: Principal): ReleaseApprovalRecord | null {
    this.policy.authorize(principal, 'app.read', { appId });
    return this.store.approvalGet(appId, appVersion) ?? null;
  }
  listReleaseApprovals(principal: Principal): ReleaseApprovalRecord[] {
    this.policy.authorize(principal, 'app.read');
    return this.store.approvalList();
  }
  /** A run may only start on a release whose exact digest has an active, unexpired approval. */
  private requireApproval(app: AppRecord): void {
    if (!this.requireReleaseApproval) return;
    const approval = this.store.approvalGet(app.appId, app.appVersion);
    if (!approval || approval.state !== 'ACTIVE') {
      throw new PlatformError('APP_RELEASE_NOT_APPROVED', `${app.appId}@${app.appVersion}`);
    }
    if (approval.releaseDigest !== app.releaseDigest) {
      throw new PlatformError('APP_APPROVAL_DIGEST_MISMATCH', `${app.appId}@${app.appVersion}`);
    }
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) {
      throw new PlatformError('APP_RELEASE_APPROVAL_EXPIRED', `${app.appId}@${app.appVersion}`);
    }
  }

  // ── Model approvals (E2-4) ─────────────────────────────────────────────────
  /** Grant a model approval bound to an exact catalog selection. A selectionId that is not in the
   *  registered catalog cannot be approved: approving "whatever resolves later" would silently
   *  approve a route nobody registered. Lifecycle mirrors release approvals. */
  approveModel(
    draft: { selectionId: string; approvedBy: string; evidence?: string; expiresAt?: string },
    principal: Principal,
  ): ModelApprovalRecord {
    this.policy.authorize(principal, 'model.approve', { modelSelectionId: draft?.selectionId });
    const selectionId = typeof draft?.selectionId === 'string' ? draft.selectionId.trim() : '';
    if (!selectionId || selectionId.length > 128) throw new PlatformError('MODEL_APPROVAL_INVALID', 'selectionId');
    const approvedBy = typeof draft?.approvedBy === 'string' ? draft.approvedBy.trim() : '';
    if (!approvedBy || approvedBy.length > 200) throw new PlatformError('MODEL_APPROVAL_INVALID', 'approvedBy');
    for (const key of ['evidence'] as const) {
      const value = draft[key];
      if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 2000)) {
        throw new PlatformError('MODEL_APPROVAL_INVALID', key);
      }
    }
    if (draft.expiresAt !== undefined && (typeof draft.expiresAt !== 'string' || Number.isNaN(Date.parse(draft.expiresAt)))) {
      throw new PlatformError('MODEL_APPROVAL_INVALID', 'expiresAt');
    }
    const catalog = this.store.modelCatalogGet();
    if (!catalog) throw new PlatformError('MODEL_CATALOG_UNAVAILABLE', selectionId);
    const entry = catalog.entries.find((candidate) => candidate.selectionId === selectionId);
    if (!entry) throw new PlatformError('MODEL_APPROVAL_SELECTION_UNKNOWN', selectionId);
    const existing = this.store.modelApprovalGet(selectionId);
    const now = new Date().toISOString();
    const record: ModelApprovalRecord = {
      approvalId: existing?.approvalId ?? `model-approval-${randomUUID()}`,
      selectionId,
      state: 'ACTIVE',
      approvedBy,
      approvedAt: now,
      ...(draft.evidence !== undefined ? { evidence: draft.evidence } : {}),
      ...(draft.expiresAt !== undefined ? { expiresAt: draft.expiresAt } : {}),
      revision: (existing?.revision ?? 0) + 1,
    };
    this.store.transaction(() => {
      this.store.modelApprovalPut(record);
      this.store.audit(principal.actorId, 'MODEL_APPROVAL_GRANTED', selectionId, {
        approvalId: record.approvalId,
        approvedBy,
        ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      });
    });
    return record;
  }
  revokeModelApproval(selectionId: string, reason: string, principal: Principal): ModelApprovalRecord {
    this.policy.authorize(principal, 'model.approve', { modelSelectionId: selectionId });
    const record = this.store.modelApprovalGet(selectionId);
    if (!record) throw new PlatformError('MODEL_APPROVAL_NOT_FOUND', selectionId);
    if (record.state === 'REVOKED') return record;
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (!trimmed || trimmed.length > 2000) throw new PlatformError('MODEL_APPROVAL_INVALID', 'reason');
    const now = new Date().toISOString();
    const next: ModelApprovalRecord = {
      ...record,
      state: 'REVOKED',
      revokedAt: now,
      revokeReason: trimmed,
      revision: record.revision + 1,
    };
    this.store.transaction(() => {
      this.store.modelApprovalPut(next);
      this.store.audit(principal.actorId, 'MODEL_APPROVAL_REVOKED', selectionId, {
        approvalId: record.approvalId,
        reason: trimmed,
      });
    });
    return next;
  }
  modelApproval(selectionId: string, principal: Principal): ModelApprovalRecord | null {
    this.policy.authorize(principal, 'model.read', { modelSelectionId: selectionId });
    return this.store.modelApprovalGet(selectionId) ?? null;
  }
  listModelApprovals(principal: Principal): ModelApprovalRecord[] {
    this.policy.authorize(principal, 'model.read');
    return this.store.modelApprovalList();
  }
  /** A run may only start on a model selection with an ACTIVE, unexpired approval — and only
   *  when this deployment turned the flag on. The check fires at resolve time, so an explicit
   *  choice, a saved preference and the catalog default pass through the same gate. */
  private requireModelApprovalFor(selectionId: string): void {
    if (!this.requireModelApproval) return;
    const approval = this.store.modelApprovalGet(selectionId);
    if (!approval || approval.state !== 'ACTIVE') {
      throw new PlatformError('MODEL_APPROVAL_REQUIRED', selectionId);
    }
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) {
      throw new PlatformError('MODEL_APPROVAL_EXPIRED', selectionId);
    }
  }

  // ── Per-project run quotas (E2-3) ──────────────────────────────────────────
  /** Config-driven budget enforcement. A refused run is refused BEFORE any launch happens, and
   *  the error names the quota — the caller can budget from the message. Runs not bound to a
   *  Work have no project and are not counted; quotaFacts() states that openly. */
  private requireProjectQuota(projectId: string): void {
    if (this.quotaMaxConcurrentRunsPerProject > 0 &&
        this.store.activeRunCountForProject(projectId) >= this.quotaMaxConcurrentRunsPerProject) {
      throw new PlatformError(
        'RUN_QUOTA_CONCURRENCY_EXCEEDED',
        `project ${projectId} 已有 ${this.quotaMaxConcurrentRunsPerProject} 个进行中的运行`,
      );
    }
    if (this.quotaMaxRunsPerDayPerProject > 0) {
      const day = new Date().toISOString().slice(0, 10);
      const used = this.store.runCountForProjectDay(projectId, day);
      if (used >= this.quotaMaxRunsPerDayPerProject) {
        throw new PlatformError(
          'RUN_QUOTA_DAILY_EXCEEDED',
          `project ${projectId} 今日（${day} UTC）已创建 ${used}/${this.quotaMaxRunsPerDayPerProject} 个运行`,
        );
      }
    }
  }
  /** What the quota mechanism enforces right now — including the honest "runs without a Work
   *  are not counted" boundary and the fact that a failed run still consumed its day. */
  quotaFacts(principal: Principal) {
    this.policy.authorize(principal, 'metrics.read');
    return {
      maxConcurrentRunsPerProject: this.quotaMaxConcurrentRunsPerProject,
      maxRunsPerDayPerProject: this.quotaMaxRunsPerDayPerProject,
      scope: {
        counted: 'runs bound to a Work (by the Work project)',
        notCounted: ['runs without a Work', 'runs outside the UTC day window'],
      } as const,
      dayBoundary: 'UTC day of run creation',
    };
  }

  /**
   * Ordinary default rollback (W2/R6): switch the per-app default release pointer back to
   * another ACTIVE (and, when enforced, approved) release. Only the routing of new Work
   * changes — this never revokes the source version, never rewrites history and never touches
   * in-flight runs, and it deliberately does not share a write action with security
   * revocation ('app.default.set' here; 'app.revoke' stays with revokeApp alone). A revoked
   * version can therefore never re-enter the default route. The pointer carries a monotonic
   * revision; when the caller passes expectedRevision it must still match, so two concurrent
   * rollbacks cannot silently overwrite each other.
   */
  rollbackRelease(
    appId: string,
    fromVersion: string,
    toVersion: string,
    reason: string,
    principal: Principal,
    opts: { expectedRevision?: number | null } = {},
  ): { previous: AppDefaultReleaseRecord; current: AppDefaultReleaseRecord; target: AppRecord } {
    this.policy.authorize(principal, 'app.default.set', { appId });
    if (fromVersion === toVersion) throw new PlatformError('APP_ROLLBACK_INVALID', 'same version');
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (!trimmed || trimmed.length > 2000) throw new PlatformError('APP_ROLLBACK_INVALID', 'reason');
    const target = this.registry.get(appId, toVersion);
    if (target.state !== 'ACTIVE') throw new PlatformError('APP_RELEASE_NOT_ACTIVE', `${appId}@${toVersion}`);
    this.requireApproval(target);
    return this.store.transaction(() => {
      const pointer = this.store.defaultReleaseGet(appId);
      if (!pointer) throw new PlatformError('APP_DEFAULT_RELEASE_MISSING', appId);
      const expected = opts.expectedRevision === undefined ? pointer.revision : opts.expectedRevision;
      if (pointer.appVersion !== fromVersion || pointer.revision !== expected) {
        throw new PlatformError('APP_DEFAULT_REVISION_STALE', `${appId} 当前默认指向 ${pointer.appVersion}@${pointer.revision}`);
      }
      const current = this.store.defaultReleaseSet(
        appId,
        target.appVersion,
        target.releaseDigest,
        principal.actorId,
        new Date().toISOString(),
        pointer.revision,
      );
      if (!current) throw new PlatformError('APP_DEFAULT_REVISION_STALE', appId);
      this.store.audit(principal.actorId, 'APP_DEFAULT_RELEASE_ROLLED_BACK', `${appId}@${fromVersion}`, {
        toVersion,
        fromDigest: pointer.releaseDigest,
        targetDigest: target.releaseDigest,
        reason: trimmed,
      });
      return { previous: pointer, current, target };
    });
  }

  // ── Delivery reviews ───────────────────────────────────────────────────────
  /** Request a business review of one SUCCEEDED execution's sealed deliverables (R5). The server
   *  builds the immutable deliverable manifest from the run's own sealed artifacts at request
   *  time — without verifiable sealed facts no deliverable review may be initiated. Technical
   *  success alone never means approval; one open request per run is allowed. */
  requestReview(runId: string, principal: Principal, note?: string): ReviewRecord {
    const run = this.runs.get(runId);
    this.authorizeRunScope(principal, 'run.review', run);
    if (run.snapshot.state !== 'SUCCEEDED') throw new PlatformError('RUN_REVIEW_NOT_SUCCEEDED', run.snapshot.state);
    if (note !== undefined && (typeof note !== 'string' || note.length > 4000)) {
      throw new PlatformError('RUN_REVIEW_INVALID', 'note');
    }
    // R5: run_artifacts rows exist only after the control plane sealed a digest-verified copy —
    // artifacts.length > 0 is the verifiable sealed fact a review must stand on.
    const artifacts = this.store.artifacts(runId);
    if (artifacts.length === 0) throw new PlatformError('RUN_REVIEW_NOT_SEALED', runId);
    const manifest = {
      runId,
      artifacts: artifacts.map(({ name, digest, bytes }) => ({ name, digest, bytes })),
    };
    const trimmed = note?.trim() || undefined;
    const manifestDigest = reviewDeliverableDigest(manifest);
    const now = new Date().toISOString();
    return this.store.transaction(() => {
      if (this.store.openReviewForRun(runId)) throw new PlatformError('RUN_REVIEW_EXISTS', runId);
      const record: ReviewRecord = {
        reviewId: randomUUID(),
        runId,
        state: 'REQUESTED',
        requestedBy: principal.actorId,
        ...(trimmed ? { note: trimmed } : {}),
        deliverable: { manifestDigest, manifest },
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.store.reviewInsert(record);
      this.store.audit(principal.actorId, 'RUN_REVIEW_REQUESTED', runId, {
        reviewId: record.reviewId,
        manifestDigest,
        artifacts: manifest.artifacts.map((artifact) => ({ name: artifact.name, digest: artifact.digest })),
        note: trimmed ?? null,
      });
      return record;
    });
  }
  /** Approve or reject an open review. The decision binds the request's target manifest digest
   *  and the review revision (R5): the server re-checks current authorization, the exact target
   *  and the pending state, so a decision against a different manifest or a stale revision never
   *  takes effect, and only one concurrent decision ever wins. A decision never rewrites an
   *  earlier one. Legacy reviews bound only to the run keep deciding on revision alone — they
   *  bind no manifest and accept no digest. */
  recordReviewDecision(
    reviewId: string,
    decision: 'APPROVED' | 'REJECTED',
    note: string | undefined,
    expectedRevision: number,
    expectedManifestDigest: string | undefined,
    principal: Principal,
  ): ReviewRecord {
    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      throw new PlatformError('RUN_REVIEW_INVALID', 'decision');
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new PlatformError('RUN_REVIEW_INVALID', 'expectedRevision');
    }
    const record = this.store.reviewGet(reviewId);
    if (!record) throw new PlatformError('RUN_REVIEW_NOT_FOUND', reviewId);
    const run = this.runs.get(record.runId);
    this.authorizeRunScope(principal, 'run.review', run);
    if (record.deliverable) {
      // R5: the decision must confirm the exact manifest the request froze — same target or no effect.
      if (typeof expectedManifestDigest !== 'string' || !expectedManifestDigest) {
        throw new PlatformError('RUN_REVIEW_TARGET_REQUIRED');
      }
      if (expectedManifestDigest !== record.deliverable.manifestDigest) {
        throw new PlatformError('RUN_REVIEW_TARGET_MISMATCH', expectedManifestDigest);
      }
    } else if (expectedManifestDigest !== undefined) {
      // Old records only show existing facts: they bind no manifest, so a claimed target is refused.
      throw new PlatformError('RUN_REVIEW_TARGET_INVALID', 'run-only review');
    }
    if (record.state !== 'REQUESTED') throw new PlatformError('RUN_REVIEW_NOT_OPEN', record.state);
    const trimmed = typeof note === 'string' ? note.trim() : '';
    if (trimmed.length > 4000) throw new PlatformError('RUN_REVIEW_INVALID', 'note');
    if (decision === 'REJECTED' && !trimmed) throw new PlatformError('RUN_REVIEW_INVALID', 'rejection reason required');
    const now = new Date().toISOString();
    const next: ReviewRecord = {
      ...record,
      state: decision,
      reviewer: principal.actorId,
      ...(trimmed ? { note: trimmed } : {}),
      revision: record.revision + 1,
      updatedAt: now,
    };
    const saved = this.store.transaction(() => {
      if (!this.store.reviewUpdate(next, expectedRevision)) {
        throw new PlatformError('RUN_REVIEW_REVISION_STALE');
      }
      this.store.audit(principal.actorId, `RUN_REVIEW_${decision}`, record.runId, {
        reviewId,
        manifestDigest: record.deliverable?.manifestDigest ?? null,
        note: trimmed || null,
      });
      return next;
    });
    this.captureReviewDecision(run, saved);
    return saved;
  }
  reviewsForRun(runId: string, principal: Principal): ReviewRecord[] {
    this.getRun(runId, principal);
    return this.store.reviewsForRun(runId);
  }

  // ── Delivery packages (E1-3) ───────────────────────────────────────────────
  /** Seal one SUCCEEDED run's deliverables into an immutable package. Sealing requires the run's
   *  own sealed artifacts and honestly freezes whatever matching-target review state exists at
   *  seal time (R5) — it neither requires a review nor invents one. */
  sealDeliveryPackage(
    workId: string,
    draft: { runId: string; note?: string },
    principal: Principal,
  ): DeliveryPackageRecord {
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'work.delivery', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    if (work.state !== 'ACTIVE') throw new PlatformError('WORK_ARCHIVED', workId);
    if (!draft || typeof draft.runId !== 'string' || !draft.runId) {
      throw new PlatformError('DELIVERY_PACKAGE_INVALID', 'runId');
    }
    const note = typeof draft.note === 'string' ? draft.note.trim() : '';
    if (note.length > 4000) throw new PlatformError('DELIVERY_PACKAGE_INVALID', 'note');
    const run = this.runs.get(draft.runId);
    if ((run.workId ?? undefined) !== workId) throw new PlatformError('DELIVERY_PACKAGE_INVALID', 'run is not on this Work');
    if (run.snapshot.state !== 'SUCCEEDED') throw new PlatformError('DELIVERY_PACKAGE_NOT_SUCCEEDED', run.snapshot.state);
    const artifacts = this.store.artifacts(run.runId).map((artifact) => ({
      name: artifact.name, digest: artifact.digest, bytes: artifact.bytes,
    }));
    if (artifacts.length === 0) throw new PlatformError('DELIVERY_PACKAGE_INVALID', 'the run has no sealed artifacts to deliver');
    // R5: the package snapshots only reviews bound to these exact artifacts — a review of a
    // different manifest (another run, another batch) or a legacy run-only review never becomes
    // this package's fact. The digest excludes review state, so snapshot and decision cannot cycle.
    const deliverableDigest = reviewDeliverableDigest({ runId: run.runId, artifacts });
    const reviews = this.store.reviewsForRun(run.runId);
    const newest = reviews.filter((review) => review.deliverable?.manifestDigest === deliverableDigest).at(-1);
    const now = new Date().toISOString();
    const record: DeliveryPackageRecord = {
      packageId: randomUUID(),
      workId,
      runId: run.runId,
      appId: run.appId,
      state: 'SEALED',
      manifest: {
        runId: run.runId,
        appId: run.appId,
        appVersion: run.appVersion,
        artifacts,
        review: newest ? { reviewId: newest.reviewId, state: newest.state, updatedAt: newest.updatedAt } : null,
      },
      packageDigest: '',
      ...(note ? { note } : {}),
      sealedBy: principal.actorId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    record.packageDigest = deliveryPackageDigest(record);
    return this.deliveryPackages.append(record, principal.actorId);
  }

  private deliveryPackageScope(packageId: string, principal: Principal): DeliveryPackageRecord {
    const record = this.deliveryPackages.get(packageId);
    if (!record) throw new PlatformError('DELIVERY_PACKAGE_NOT_FOUND', packageId);
    const work = this.works.get(record.workId);
    this.policy.authorize(principal, 'work.delivery', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    return record;
  }
  /** Record the act of handing the package over. Downloading an artifact is not delivering. */
  deliverDeliveryPackage(packageId: string, note: unknown, expectedRevision: number, principal: Principal): DeliveryPackageRecord {
    this.deliveryPackageScope(packageId, principal);
    return this.deliveryPackages.deliver(packageId, note, expectedRevision, principal.actorId);
  }
  /** Record a declared counterpart receipt; the platform cannot verify the counterpart received it. */
  acknowledgeDeliveryPackage(packageId: string, note: unknown, expectedRevision: number, principal: Principal): DeliveryPackageRecord {
    this.deliveryPackageScope(packageId, principal);
    return this.deliveryPackages.acknowledge(packageId, note, expectedRevision, principal.actorId);
  }
  withdrawDeliveryPackage(packageId: string, reason: unknown, expectedRevision: number, principal: Principal): DeliveryPackageRecord {
    this.deliveryPackageScope(packageId, principal);
    return this.deliveryPackages.withdraw(packageId, reason, expectedRevision, principal.actorId);
  }
  /** Explicitly replace a package with a live newer package of the same Work; history is kept. */
  supersedeDeliveryPackage(packageId: string, supersededBy: unknown, expectedRevision: number, principal: Principal): DeliveryPackageRecord {
    const record = this.deliveryPackageScope(packageId, principal);
    const replacementScope = typeof supersededBy === 'string' ? this.deliveryPackages.get(supersededBy) : undefined;
    if (!replacementScope) throw new PlatformError('DELIVERY_PACKAGE_SUPERSEDE_INVALID', String(supersededBy ?? ''));
    const work = this.works.get(replacementScope.workId);
    this.policy.authorize(principal, 'work.delivery', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    return this.deliveryPackages.supersede(packageId, supersededBy, expectedRevision, principal.actorId);
  }
  deliveryPackagesForWork(workId: string, offset: number, limit: number, principal: Principal): { total: number; items: DeliveryPackageRecord[] } {
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'work.read', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    const history = this.deliveryPackages.history(workId);
    return { total: history.length, items: history.slice(offset, offset + limit) };
  }
  getDeliveryPackage(packageId: string, principal: Principal): DeliveryPackageRecord {
    const record = this.deliveryPackageScope(packageId, principal);
    this.policy.authorize(principal, 'delivery.read', { appId: record.appId, workId: record.workId });
    return record;
  }

  // ── Deterministic evaluation harness (E2-1 fallback) ──────────────────────
  /** Expert gold sets are deferred (plan §13 fallback): quality assurance starts with checks
   *  that need no expert judgement — artifact presence, sealed digests, byte ceilings and
   *  goal-text anchors — all recomputable from the Run's own records. The harness never
   *  invents an expectation and never claims expert equivalence. */
  private validateDeterministicCheck(value: unknown): DeterministicCheck {
    if (!value || typeof value !== 'object') throw new PlatformError('EVALUATION_SET_INVALID', 'check');
    const check = value as Record<string, unknown>;
    const text = (field: string): string => {
      const v = check[field];
      if (typeof v !== 'string' || !v.trim() || v.length > 500) throw new PlatformError('EVALUATION_SET_INVALID', field);
      return v;
    };
    switch (check.kind) {
      case 'artifact-present':
        return { kind: 'artifact-present', artifactName: text('artifactName') };
      case 'artifact-digest': {
        const digest = text('digest');
        if (!/^[0-9a-f]{64}$/.test(digest)) throw new PlatformError('EVALUATION_SET_INVALID', 'digest');
        return { kind: 'artifact-digest', artifactName: text('artifactName'), digest };
      }
      case 'artifact-bytes-max': {
        const maxBytes = check.maxBytes;
        if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
          throw new PlatformError('EVALUATION_SET_INVALID', 'maxBytes');
        }
        return { kind: 'artifact-bytes-max', artifactName: text('artifactName'), maxBytes };
      }
      case 'goal-contains':
        return { kind: 'goal-contains', text: text('text') };
      default:
        throw new PlatformError('EVALUATION_SET_INVALID', String(check.kind ?? 'kind'));
    }
  }
  createEvaluationSet(
    draft: { appId: unknown; name: unknown; description?: unknown; entries: unknown },
    principal: Principal,
  ): EvaluationSetRecord {
    if (!draft || typeof draft.appId !== 'string' || !draft.appId) throw new PlatformError('EVALUATION_SET_INVALID', 'appId');
    this.policy.authorize(principal, 'evaluation.manage', { appId: draft.appId });
    // The set targets a registered app; version is left open so a set survives normal releases.
    if (!this.registry.list().some((app) => app.draft.descriptor?.appId === draft.appId)) {
      throw new PlatformError('APP_NOT_FOUND', draft.appId);
    }
    const name = typeof draft.name === 'string' ? draft.name.trim() : '';
    if (!name || name.length > 200) throw new PlatformError('EVALUATION_SET_INVALID', 'name');
    const description = typeof draft.description === 'string' ? draft.description.trim() : '';
    if (description.length > 2000) throw new PlatformError('EVALUATION_SET_INVALID', 'description');
    if (!Array.isArray(draft.entries) || draft.entries.length === 0 || draft.entries.length > 200) {
      throw new PlatformError('EVALUATION_SET_INVALID', 'entries');
    }
    const entries = draft.entries.map((raw) => {
      const entry = raw as { label?: unknown; checks?: unknown };
      const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
      if (!label || label.length > 200) throw new PlatformError('EVALUATION_SET_INVALID', 'label');
      if (!Array.isArray(entry?.checks) || entry.checks.length === 0) {
        throw new PlatformError('EVALUATION_SET_INVALID', 'checks');
      }
      return {
        entryId: randomUUID(),
        label,
        checks: entry.checks.map((check) => this.validateDeterministicCheck(check)),
      };
    });
    const now = new Date().toISOString();
    const record: EvaluationSetRecord = {
      evaluationSetId: randomUUID(),
      appId: draft.appId,
      name,
      description,
      entries,
      state: 'ACTIVE',
      createdBy: principal.actorId,
      createdAt: now,
      updatedAt: now,
    };
    this.store.evaluationSetInsert(record);
    return record;
  }
  listEvaluationSets(appId: string | undefined, principal: Principal): EvaluationSetRecord[] {
    this.policy.authorize(principal, 'evaluation.read', appId !== undefined ? { appId } : undefined);
    return this.store.evaluationSetsByApp(appId);
  }
  private evaluationSetScope(evaluationSetId: string, principal: Principal): EvaluationSetRecord {
    const record = this.store.evaluationSetGet(evaluationSetId);
    if (!record) throw new PlatformError('EVALUATION_SET_NOT_FOUND', evaluationSetId);
    this.policy.authorize(principal, 'evaluation.read', { appId: record.appId });
    return record;
  }
  getEvaluationSet(evaluationSetId: string, principal: Principal): EvaluationSetRecord {
    return this.evaluationSetScope(evaluationSetId, principal);
  }
  archiveEvaluationSet(evaluationSetId: string, principal: Principal): EvaluationSetRecord {
    const record = this.store.evaluationSetGet(evaluationSetId);
    if (!record) throw new PlatformError('EVALUATION_SET_NOT_FOUND', evaluationSetId);
    this.policy.authorize(principal, 'evaluation.manage', { appId: record.appId });
    if (record.state === 'ARCHIVED') return record;
    const archived: EvaluationSetRecord = { ...record, state: 'ARCHIVED', updatedAt: new Date().toISOString() };
    this.store.evaluationSetUpdate(archived);
    return archived;
  }
  /** Run every deterministic check of one set against one Run. Pure recomputation over the
   *  run's own records — no model call, no fabricated expectation. */
  evaluateEvaluationSet(evaluationSetId: string, runId: string, principal: Principal): EvaluationRunRecord {
    const set = this.store.evaluationSetGet(evaluationSetId);
    if (!set) throw new PlatformError('EVALUATION_SET_NOT_FOUND', evaluationSetId);
    this.policy.authorize(principal, 'evaluation.manage', { appId: set.appId });
    if (set.state !== 'ACTIVE') throw new PlatformError('EVALUATION_SET_ARCHIVED', evaluationSetId);
    if (typeof runId !== 'string' || !runId) throw new PlatformError('EVALUATION_SET_INVALID', 'runId');
    const run = this.getRun(runId, principal);
    const artifacts = new Map(this.store.artifacts(run.runId).map((artifact) => [artifact.name, artifact]));
    const goal =
      run.input && typeof run.input === 'object' && typeof (run.input as { goal?: unknown }).goal === 'string'
        ? (run.input as { goal: string }).goal
        : '';
    const results: EvaluationCheckResult[] = [];
    for (const entry of set.entries) {
      for (const check of entry.checks) {
        const fail = (detail: string) => results.push({ entryId: entry.entryId, label: entry.label, check, pass: false, detail });
        const pass = (detail: string) => results.push({ entryId: entry.entryId, label: entry.label, check, pass: true, detail });
        switch (check.kind) {
          case 'artifact-present': {
            const artifact = artifacts.get(check.artifactName);
            if (artifact) pass(`产物 ${check.artifactName} 已封存（${artifact.bytes} 字节）`);
            else fail(`产物 ${check.artifactName} 未封存`);
            break;
          }
          case 'artifact-digest': {
            const artifact = artifacts.get(check.artifactName);
            if (!artifact) fail(`产物 ${check.artifactName} 未封存，无法核对摘要`);
            else if (artifact.digest === check.digest) pass(`产物 ${check.artifactName} 摘要与预期一致`);
            else fail(`产物 ${check.artifactName} 摘要不一致（实际 ${artifact.digest.slice(0, 12)}…）`);
            break;
          }
          case 'artifact-bytes-max': {
            const artifact = artifacts.get(check.artifactName);
            if (!artifact) fail(`产物 ${check.artifactName} 未封存，无法核对大小`);
            else if (artifact.bytes <= check.maxBytes) pass(`产物 ${check.artifactName} ${artifact.bytes} 字节 ≤ 上限 ${check.maxBytes}`);
            else fail(`产物 ${check.artifactName} ${artifact.bytes} 字节超过上限 ${check.maxBytes}`);
            break;
          }
          case 'goal-contains': {
            if (goal.includes(check.text)) pass(`运行目标包含「${check.text}」`);
            else fail(`运行目标未包含「${check.text}」`);
            break;
          }
        }
      }
    }
    const record: EvaluationRunRecord = {
      evaluationRunId: randomUUID(),
      evaluationSetId: set.evaluationSetId,
      runId: run.runId,
      appId: set.appId,
      state: 'COMPLETED',
      results,
      passed: results.filter((result) => result.pass).length,
      failed: results.filter((result) => !result.pass).length,
      createdBy: principal.actorId,
      createdAt: new Date().toISOString(),
    };
    this.store.evaluationRunInsert(record);
    return record;
  }
  listEvaluationRuns(evaluationSetId: string, principal: Principal): EvaluationRunRecord[] {
    this.evaluationSetScope(evaluationSetId, principal);
    return this.store.evaluationRunsBySet(evaluationSetId);
  }
  getEvaluationRun(evaluationRunId: string, principal: Principal): EvaluationRunRecord {
    const record = this.store.evaluationRunGet(evaluationRunId);
    if (!record) throw new PlatformError('EVALUATION_RUN_NOT_FOUND', evaluationRunId);
    this.policy.authorize(principal, 'evaluation.read', { appId: record.appId });
    return record;
  }

  // ── Launch leases ──────────────────────────────────────────────────────────
  /** Take the supervision lease for an open launch; without it the launch is not owned. */
  beginLaunchLease(launchId: string, owner: string, ttlMs = LAUNCH_LEASE_TTL_MS): boolean {
    return this.store.attemptSetLease(launchId, owner, new Date(Date.now() + ttlMs).toISOString());
  }
  /** Renew leases for open launches this owner supervises; returns the renewed launch ids. */
  heartbeatLaunches(owner: string, ttlMs = LAUNCH_LEASE_TTL_MS): string[] {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const renewed: string[] = [];
    for (const attempt of this.store.openAttempts(200)) {
      if (attempt.leaseOwner !== owner) continue;
      if (this.store.attemptHeartbeat(attempt.launchId, owner, expiresAt)) renewed.push(attempt.launchId);
    }
    return renewed;
  }
  /**
   * Renew every open launch. The control plane is a single-process, single-writer deployment
   * (SQLite WAL), so the scheduler running inside it is the supervisor of all in-process workers.
   * A multi-process deployment must replace this with a real lease owner handshake.
   */
  renewOpenLaunchLeases(ttlMs = LAUNCH_LEASE_TTL_MS): string[] {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const renewed: string[] = [];
    for (const attempt of this.store.openAttempts(500)) {
      if (this.store.attemptSetLease(attempt.launchId, attempt.leaseOwner ?? 'service:control', expiresAt)) {
        renewed.push(attempt.launchId);
      }
    }
    return renewed;
  }
  /** Expired leases are a reconciliation fact, never proof the process stopped. */
  expiredLaunches(now = new Date()): LaunchAttempt[] {
    return this.store.expiredAttempts(now.toISOString());
  }

  // ── Durable outbox dispatch ────────────────────────────────────────────────
  /**
   * One bounded outbox turn: stale claims return to the pool, due messages are claimed, and each
   * corresponding run is dispatched — by the executor registered for THAT run's exact runtime
   * bundle (W3/R6), never by the app's default release. A run whose bundle has no registered
   * executor is released without spending its attempt budget: it stays due, stays QUEUED, and
   * the outbox row records the missing bundle, so registering the artifact later resumes the
   * drain. A run already terminal is completed without dispatch; a transient failure backs off;
   * a permanent one is dead-lettered after the attempt budget.
   */
  async dispatchOutbox(
    owner: Principal,
    options: { limit?: number; now?: Date } = {},
  ): Promise<{ claimed: number; dispatched: number; retried: number; dead: number; skipped: number; noExecutor: number }> {
    this.policy.authorize(owner, 'run.dispatch');
    // Without any executor at all, claiming messages would only burn their attempt budget. Leave
    // them queued so configuring the worker later resumes dispatch instead of dead-lettering.
    if (!this.executor && this.executorsByDigest.size === 0) throw new PlatformError('EXECUTOR_NOT_CONFIGURED');
    // Capacity is checked before claiming: a capped control plane leaves messages PENDING with
    // their attempt budget intact, and resumes as soon as a launch settles.
    let capacity = Math.min(Math.max(options.limit ?? 1, 1), 100);
    if (this.maxConcurrentRuns > 0) {
      const open = this.store.openAttempts(this.maxConcurrentRuns + 1).length;
      if (open >= this.maxConcurrentRuns) {
        metrics.counter('platform_outbox_capacity_deferred');
        return { claimed: 0, dispatched: 0, retried: 0, dead: 0, skipped: 0, noExecutor: 0 };
      }
      capacity = Math.min(capacity, this.maxConcurrentRuns - open);
    }
    const limit = capacity;
    const now = options.now ?? new Date();
    const claimed = this.store.outboxClaim(owner.actorId, now.toISOString(), limit, OUTBOX_CLAIM_TTL_MS);
    const result = { claimed: claimed.length, dispatched: 0, retried: 0, dead: 0, skipped: 0, noExecutor: 0 };
    for (const message of claimed) {
      let run: RunRecord;
      try {
        run = this.runs.get(message.runId);
      } catch {
        this.store.outboxDeadLetter(message.messageId, 'RUN_NOT_FOUND');
        result.dead++;
        continue;
      }
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(run.snapshot.state) || run.snapshot.cancelRequested) {
        this.store.outboxComplete(message.messageId);
        result.skipped++;
        continue;
      }
      try {
        // W3: resolve this run's own frozen bundle and its registered executor BEFORE any attempt
        // is spent. No registered executor for this exact bundle → release without spending the
        // attempt budget: stays due, stays QUEUED, the reason is recorded on the outbox row.
        const bundle = this.registry.get(run.appId, run.appVersion).plan.runtimeBundleDigest;
        if (!this.executorFor(bundle)) {
          this.store.outboxRelease(message.messageId, `EXECUTOR_UNAVAILABLE: bundle ${bundle}`);
          metrics.counter('platform_outbox_no_executor');
          result.noExecutor++;
          continue;
        }
        await this.dispatchRun(run.runId, run.snapshot.revision, owner);
        this.store.outboxComplete(message.messageId);
        result.dispatched++;
      } catch (error) {
        const code = error instanceof PlatformError || error instanceof RunError ? error.code : 'DISPATCH_FAILED';
        const permanent =
          code === 'APP_RELEASE_NOT_ACTIVE' ||
          code === 'APP_RELEASE_NOT_APPROVED' ||
          code === 'APP_RELEASE_APPROVAL_EXPIRED' ||
          code === 'APP_APPROVAL_DIGEST_MISMATCH' ||
          code === 'WORK_ARCHIVED' ||
          code === 'RUN_CANCEL_REQUESTED' ||
          code === 'RUN_TERMINAL' ||
          code === 'RUN_NOT_FOUND';
        if (code === 'RUN_REVISION_STALE' || code === 'RUN_DISPATCH_STATE_INVALID') {
          // Another supervisor already advanced it; not a retryable delivery failure.
          this.store.outboxComplete(message.messageId);
          result.skipped++;
          continue;
        }
        if (permanent || message.attempts >= OUTBOX_MAX_ATTEMPTS) {
          this.store.outboxDeadLetter(message.messageId, `${code}: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
          this.store.audit(owner.actorId, 'RUN_DISPATCH_DEAD_LETTERED', run.runId, {
            messageId: message.messageId, code, attempts: message.attempts,
          });
          metrics.counter('platform_outbox_dead', { code });
          logger.warn('outbox.dead_letter', { runId: run.runId, code, attempts: message.attempts });
          result.dead++;
          continue;
        }
        const delay = Math.min(OUTBOX_RETRY_MAX_MS, OUTBOX_RETRY_BASE_MS * 2 ** (message.attempts - 1));
        this.store.outboxRetry(
          message.messageId,
          `${code}: ${error instanceof Error ? error.message : 'UNKNOWN'}`,
          new Date(now.getTime() + delay).toISOString(),
        );
        metrics.counter('platform_outbox_retry', { code });
        logger.warn('outbox.retry', { runId: run.runId, code, attempts: message.attempts, delayMs: delay });
        result.retried++;
      }
    }
    return result;
  }
  outboxForRun(runId: string, principal: Principal): OutboxMessage | null {
    this.getRun(runId, principal);
    return this.store.outboxForRun(runId) ?? null;
  }
  outboxStatus(principal: Principal): Record<string, number> {
    this.policy.authorize(principal, 'run.read');
    return this.store.outboxCounts();
  }
  close(): void {
    this.closed = true;
    // Resolve every waiting SDK question before the store goes away.
    for (const record of [...this.interactionWaiters.keys()]) {
      this.interactionWaiters.get(record)?.({ cancelled: true });
    }
    this.store.close();
  }
  registerApp(draft: AppReleaseDraft, principal: Principal): AppRecord {
    this.policy.authorize(principal, 'app.register', { appId: draft?.descriptor?.appId });
    return this.registry.register(draft, principal.actorId);
  }
  getApp(appId: string, appVersion: string, principal: Principal): AppRecord {
    this.policy.authorize(principal, 'app.read', { appId });
    return this.registry.get(appId, appVersion);
  }
  listApps(state: AppState | undefined, principal: Principal): AppRecord[] {
    this.policy.authorize(principal, 'app.read');
    return this.registry.list(state);
  }
  availableModels(appId: string, appVersion: string, principal: Principal) {
    const app = this.registry.active(appId, appVersion);
    this.policy.authorize(principal, 'app.read', { appId });
    const { catalog, entries } = this.availableForApp(app, principal);
    const preference = this.store.modelPreferenceGet(principal.actorId);
    const selectionId = preference?.selectionId ?? catalog?.defaultSelectionId ?? null;
    return {
      catalogId: catalog?.catalogId ?? null,
      catalogDigest: catalog?.catalogDigest ?? null,
      entries: entries.map((entry) => ({
        selectionId: entry.selectionId, provider: entry.provider, model: entry.model,
        displayName: entry.displayName, description: entry.description, enabled: entry.enabled,
        verification: entry.verification, capabilities: entry.capabilities,
        selected: entry.selectionId === selectionId,
      })),
      ready: entries.some((entry) => entry.selectionId === selectionId && entry.enabled),
    };
  }
  revokeApp(appId: string, appVersion: string, reason: string, principal: Principal): AppRecord {
    this.policy.authorize(principal, 'app.revoke', { appId });
    return this.registry.revoke(appId, appVersion, reason, principal.actorId);
  }

  // ── Default release pointer (W2/R6) ─────────────────────────────────────────
  /** Set the per-app default release new Works are created from. The target must be an ACTIVE
   *  registered release — a revoked version can never become default — and approved when
   *  approvals are enforced. `expectedRevision` is required: `null` initializes the pointer,
   *  a number CAS-switches it, so concurrent switches cannot silently overwrite each other.
   *  This never revokes anything; security revocation is revokeApp, a separate write action. */
  setDefaultRelease(
    appId: string,
    version: string,
    opts: { expectedRevision: number | null; reason?: string },
    principal: Principal,
  ): AppDefaultReleaseRecord {
    this.policy.authorize(principal, 'app.default.set', { appId });
    if (opts.expectedRevision !== null && !Number.isSafeInteger(opts.expectedRevision)) {
      throw new PlatformError('APP_DEFAULT_REVISION_INVALID', String(opts.expectedRevision));
    }
    const target = this.registry.get(appId, version);
    if (target.state !== 'ACTIVE') throw new PlatformError('APP_RELEASE_NOT_ACTIVE', `${appId}@${version}`);
    this.requireApproval(target);
    return this.store.transaction(() => {
      const next = this.store.defaultReleaseSet(
        appId,
        target.appVersion,
        target.releaseDigest,
        principal.actorId,
        new Date().toISOString(),
        opts.expectedRevision,
      );
      if (!next) throw new PlatformError('APP_DEFAULT_REVISION_STALE', `${appId} 默认指向已被并发切换，请读取当前指向后重试`);
      this.store.audit(principal.actorId, 'APP_DEFAULT_RELEASE_SET', `${appId}@${target.appVersion}`, {
        releaseDigest: target.releaseDigest,
        revision: next.revision,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      });
      return next;
    });
  }
  /** Current default pointer of one app (null before the first selection). */
  defaultRelease(appId: string, principal: Principal): AppDefaultReleaseRecord | null {
    this.policy.authorize(principal, 'app.read', { appId });
    return this.store.defaultReleaseGet(appId) ?? null;
  }

  // ── Employee catalog (W2/R2) ────────────────────────────────────────────────
  /** Per-project catalog of what new Work may actually be created from: a release with the
   *  app's default pointer on it, ACTIVE, approved when enforcement is on, and allowed to this
   *  principal. Filtering happens before pagination; pages are keyset-keyed on appId and the
   *  items are bounded summaries — identity, display name, availability digests — never the
   *  full descriptor, result views or input schema. ACTIVE alone is not approval: entries the
   *  policy or the approval gate refuses are omitted, not errored. */
  catalogSummaries(
    projectId: string,
    cursor: string | null,
    limit: number,
    principal: Principal,
  ): {
    items: Array<{
      appId: string;
      appVersion: string;
      displayName: string;
      releaseDigest: string;
      planDigest: string;
      listingTypes?: string[];
      revision: number;
      updatedAt: string;
    }>;
    nextCursor: string | null;
  } {
    // Authorization precedes existence checks so an unknown project and a forbidden one are
    // indistinguishable in what they reveal.
    this.policy.authorize(principal, 'project.read', { projectId });
    if (!this.projects.get(projectId)) throw new PlatformError('PROJECT_NOT_FOUND', projectId);
    if (limit < 1 || limit > 100) throw new PlatformError('CATALOG_PAGE_INVALID', 'limit');
    const key = cursor ? decodeCursor(cursor) : null;
    if (cursor && (!key || key.t !== key.id)) throw new PlatformError('CATALOG_PAGE_INVALID', 'cursor');
    const pointers = new Map(this.store.defaultReleaseList().map((pointer) => [pointer.appId, pointer]));
    const entries: Array<{
      appId: string;
      appVersion: string;
      displayName: string;
      releaseDigest: string;
      planDigest: string;
      listingTypes?: string[];
      revision: number;
      updatedAt: string;
    }> = [];
    for (const app of this.registry.list('ACTIVE')) {
      const pointer = pointers.get(app.appId);
      // The pointer must name exactly this ACTIVE release; a pointer at a revoked or replaced
      // version is not creatable and is honestly omitted rather than silently re-routed.
      if (!pointer || pointer.appVersion !== app.appVersion) continue;
      if (key && app.appId <= key.t) continue;
      try {
        this.policy.authorize(principal, 'app.read', { appId: app.appId });
        this.requireApproval(app);
      } catch (error) {
        const code = error instanceof PlatformError ? error.code : '';
        if (error instanceof AuthorizationError || code === 'APP_RELEASE_NOT_APPROVED' || code === 'APP_RELEASE_APPROVAL_EXPIRED') {
          continue;
        }
        throw error;
      }
      entries.push({
        appId: app.appId,
        appVersion: app.appVersion,
        displayName: app.draft.descriptor.displayName,
        releaseDigest: app.releaseDigest,
        planDigest: app.plan.planDigest,
        ...(app.draft.descriptor.listingTypes !== undefined ? { listingTypes: app.draft.descriptor.listingTypes } : {}),
        revision: pointer.revision,
        updatedAt: pointer.updatedAt,
      });
    }
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return { items: page, nextCursor: entries.length > limit && last ? encodeCursor(last.appId, last.appId) : null };
  }
  /** Full descriptor of the selected catalog entry: chosen after the project and the expected
   *  release identity, resolved through the server-owned pointer — never from a browser-supplied
   *  version. Returns the pointer facts so the creation form can carry expectedRelease. */
  catalogRelease(appId: string, projectId: string, principal: Principal): { app: AppRecord; catalog: AppDefaultReleaseRecord } {
    this.policy.authorize(principal, 'project.read', { projectId });
    if (!this.projects.get(projectId)) throw new PlatformError('PROJECT_NOT_FOUND', projectId);
    this.policy.authorize(principal, 'app.read', { appId });
    const pointer = this.store.defaultReleaseGet(appId);
    if (!pointer) throw new PlatformError('APP_DEFAULT_RELEASE_MISSING', appId);
    const app = this.registry.active(appId, pointer.appVersion);
    this.requireApproval(app);
    return { app, catalog: pointer };
  }
  /** ACTIVE releases for the employee home surface, gated per app. The HTTP layer projects a
   *  bounded summary without the full descriptor — /api/workbench no longer ships it (W2). */
  workbenchApps(principal: Principal): AppRecord[] {
    this.policy.authorize(principal, 'app.read');
    return this.registry.list('ACTIVE').filter((app) => {
      try {
        this.policy.authorize(principal, 'app.read', { appId: app.appId });
        return true;
      } catch (error) {
        if (error instanceof AuthorizationError) return false;
        throw error;
      }
    });
  }
  createProject(draft: ProjectDraft, principal: Principal) {
    this.policy.authorize(principal, 'project.create');
    return this.projects.create(draft, principal.actorId);
  }
  listProjects(principal: Principal) {
    this.policy.authorize(principal, 'project.read');
    return this.projects.list().filter((project) => {
      try {
        this.policy.authorize(principal, 'project.read', { projectId: project.projectId });
        return true;
      } catch (error) {
        if (error instanceof AuthorizationError) return false;
        throw error;
      }
    });
  }
  projectWorkspaces(projectId: string, principal: Principal) {
    this.policy.authorize(principal, 'workspace.read', { projectId });
    return this.projects.workspaces(projectId).filter((workspace) => {
      try {
        this.policy.authorize(principal, 'workspace.read', { projectId, workspaceId: workspace.workspaceId });
        return true;
      } catch (error) {
        if (error instanceof AuthorizationError) return false;
        throw error;
      }
    });
  }
  createWorkspace(draft: WorkspaceDraft, principal: Principal) {
    this.policy.authorize(principal, 'workspace.create', { projectId: draft?.projectId });
    return this.projects.createWorkspace(draft, principal.actorId);
  }

  // ── Project-scope authorization (W2/R2) ─────────────────────────────────────
  /** Server-resolved set of project ids this principal may see, or null when unrestricted.
   *  A deployment policy may answer directly (exact even for projects created later);
   *  otherwise the policy is probed per known project — the same filter listProjects applies.
   *  Scope comes from the policy and resource ownership, never from browser parameters. */
  private visibleProjectIds(principal: Principal): string[] | null {
    if (typeof this.policy.visibleProjects === 'function') {
      return this.policy.visibleProjects(principal);
    }
    const all = this.projects.list();
    const visible = all.filter((project) => {
      try {
        this.policy.authorize(principal, 'project.read', { projectId: project.projectId });
        return true;
      } catch (error) {
        if (error instanceof AuthorizationError) return false;
        throw error;
      }
    });
    return visible.length === all.length ? null : visible.map((project) => project.projectId);
  }
  /** A run's project is resolved from server-side ownership: the bound workspace when present,
   *  otherwise the Work row. A workspace-less Work still carries its project; a work-less run
   *  has none and stays visible only to principals without a project restriction. */
  private runProjectId(run: Pick<RunRecord, 'workId' | 'workspace'>): string | undefined {
    if (run.workspace?.projectId !== undefined) return run.workspace.projectId;
    if (run.workId !== null) return this.works.get(run.workId)?.projectId;
    return undefined;
  }
  /** Shared authorization for run-scoped actions: policy authorize with the server-resolved
   *  project, then the project-scope gate. Denial carries no metadata beyond the denial. */
  private authorizeRunScope(principal: Principal, action: PlatformAction, run: RunRecord): void {
    const projectId = this.runProjectId(run);
    this.policy.authorize(principal, action, {
      appId: run.appId,
      projectId,
      workspaceId: run.workspace?.workspaceId,
      workId: run.workId ?? undefined,
    });
    const scope = this.visibleProjectIds(principal);
    if (scope !== null && (projectId === undefined || !scope.includes(projectId))) {
      throw new AuthorizationError('PLATFORM_PROJECT_ACCESS_DENIED', projectId ?? '(no project)');
    }
  }
  workDraft(workId: string, principal: Principal) {
    const work = this.getWork(workId, principal);
    this.policy.authorize(principal, 'work.draft', { appId: work.appId, projectId: work.projectId, workId });
    return this.store.draftGet(workId, principal.actorId);
  }
  saveWorkDraft(workId: string, text: unknown, expectedRevision: unknown, principal: Principal) {
    const work = this.getWork(workId, principal);
    this.policy.authorize(principal, 'work.draft', { appId: work.appId, projectId: work.projectId, workId });
    if (typeof text !== 'string' || text.length > 100_000 ||
        typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new PlatformError('WORK_DRAFT_INVALID');
    }
    const saved = this.store.draftPut(workId, principal.actorId, text, expectedRevision);
    if (!saved) throw new PlatformError('WORK_DRAFT_REVISION_STALE', '草稿已在另一窗口更新，请先保留当前文字再重新加载。');
    return saved;
  }
  createWork(draft: WorkDraft, principal: Principal): WorkRecord {
    this.policy.authorize(principal, 'work.create', { appId: draft?.appId, projectId: draft?.projectId });
    if (draft.workspaceId !== undefined) {
      this.policy.authorize(principal, 'workspace.read', { projectId: draft.projectId, workspaceId: draft.workspaceId });
    }
    return this.store.transaction(() => {
      // W2/R3: the creation form carries the release identity it saw. The server compares it
      // against the current default pointer inside the write transaction, so a form loaded
      // before a default switch conflicts instead of writing a stale binding. An unregistered
      // app is APP_NOT_FOUND; an app without a pointer is not open for new Work — no version
      // is ever guessed; any other version than the pointer is a stale form (409, no write).
      this.registry.get(draft?.appId);
      const pointer = this.store.defaultReleaseGet(draft?.appId);
      if (!pointer) throw new PlatformError('APP_DEFAULT_RELEASE_MISSING', draft?.appId);
      if (draft?.appVersion !== pointer.appVersion) {
        throw new PlatformError(
          'APP_DEFAULT_RELEASE_CONFLICT',
          `表单所见 ${draft?.appId}@${draft?.appVersion}，当前默认 ${pointer.appVersion}；请刷新目录后重试`,
        );
      }
      const app = this.registry.active(pointer.appId, pointer.appVersion);
      this.requireApproval(app);
      return this.works.create(draft, principal.actorId);
    });
  }
  getWork(workId: string, principal: Principal): WorkRecord {
    const work = this.works.get(workId);
    // R2: the Work row itself is the authoritative project — including workspace-less Works,
    // whose projectId is never inferred from request parameters.
    this.policy.authorize(principal, 'work.read', { appId: work.appId, projectId: work.projectId, workId });
    return work;
  }
  listWorks(state: WorkState | undefined, offset: number, limit: number, principal: Principal): {
    items: WorkRecord[];
    total: number;
  } {
    this.policy.authorize(principal, 'work.read');
    const projectIds = this.visibleProjectIds(principal) ?? undefined;
    return this.works.list(state, offset, limit, projectIds);
  }
  /** E4-3: server-side filtered, cursor-paginated Works. The q filter matches titles only —
   *  stated here so no client assumes the goal body is searched. Project visibility is
   *  resolved server-side and applied before pagination; an explicit projectId outside the
   *  principal's scope is denied, not silently emptied. */
  queryWorks(
    filter: { projectId?: string; appId?: string; state?: WorkState; q?: string },
    cursor: string | null,
    limit: number,
    principal: Principal,
  ): { items: WorkRecord[]; nextCursor: string | null } {
    this.policy.authorize(principal, 'work.read');
    if (filter.projectId !== undefined) this.policy.authorize(principal, 'project.read', { projectId: filter.projectId });
    if (limit < 1 || limit > 100) throw new PlatformError('WORK_PAGE_INVALID', 'limit');
    if (filter.state !== undefined && filter.state !== 'ACTIVE' && filter.state !== 'ARCHIVED') {
      throw new PlatformError('WORK_STATE_INVALID', String(filter.state));
    }
    if (filter.q !== undefined && (typeof filter.q !== 'string' || filter.q.length > 200)) {
      throw new PlatformError('WORK_PAGE_INVALID', 'q');
    }
    const projectIds = this.visibleProjectIds(principal) ?? undefined;
    return this.store.workQuery({ ...filter, projectIds }, cursor, limit);
  }
  /** E4-3: server-side filtered, cursor-paginated Runs. The q filter matches the run's input
   *  goal only — run ids and digests are not substring-searched. Project visibility applies
   *  before pagination, resolved from Work ownership (work-less runs have none and are only
   *  visible to unrestricted principals). */
  queryRuns(
    filter: { appId?: string; workId?: string; projectId?: string; state?: string; q?: string },
    cursor: string | null,
    limit: number,
    principal: Principal,
  ): { items: RunRecord[]; nextCursor: string | null } {
    this.policy.authorize(principal, 'run.read', filter.appId ? { appId: filter.appId } : undefined);
    if (filter.projectId !== undefined) this.policy.authorize(principal, 'project.read', { projectId: filter.projectId });
    if (limit < 1 || limit > 100) throw new PlatformError('RUN_PAGE_INVALID', 'limit');
    if (filter.q !== undefined && (typeof filter.q !== 'string' || filter.q.length > 200)) {
      throw new PlatformError('RUN_PAGE_INVALID', 'q');
    }
    const projectIds = this.visibleProjectIds(principal) ?? undefined;
    return this.store.runQuery({ ...filter, projectIds }, cursor, limit);
  }
  /**
   * E4-6 global search: one bounded query over the four catalogues the workbench navigates —
   * works (title), runs (goal), projects (name) and apps (display name). Every hit carries the
   * kind needed to open it; authorization matches the underlying list actions, so a hit list
   * never leaks something the principal cannot read.
   */
  globalSearch(q: string, principal: Principal): Array<{
    kind: 'work' | 'run' | 'project' | 'app';
    id: string;
    title: string;
    detail: string;
    workId?: string;
    runId?: string;
  }> {
    if (typeof q !== 'string') throw new PlatformError('SEARCH_QUERY_INVALID', 'q');
    const term = q.trim();
    if (!term || term.length > 200) throw new PlatformError('SEARCH_QUERY_INVALID', 'q');
    this.policy.authorize(principal, 'work.read');
    this.policy.authorize(principal, 'run.read');
    this.policy.authorize(principal, 'project.read');
    const hits: Array<{
      kind: 'work' | 'run' | 'project' | 'app';
      id: string;
      title: string;
      detail: string;
      workId?: string;
      runId?: string;
    }> = [];
    // R2: search is filtered by the server-resolved project scope before hits are collected —
    // pagination, search and direct access share the same authorization basis.
    const projectIds = this.visibleProjectIds(principal) ?? undefined;
    for (const work of this.store.workQuery({ q: term, projectIds }, null, 5).items) {
      hits.push({ kind: 'work', id: work.workId, title: work.title, detail: `${work.appId} @ ${work.appVersion}`, workId: work.workId });
    }
    for (const run of this.store.runQuery({ q: term, projectIds }, null, 5).items) {
      hits.push({
        kind: 'run',
        id: run.runId,
        title: `运行 ${run.runId.slice(0, 8)}（${run.snapshot.state}）`,
        detail: `${run.appId} @ ${run.appVersion}`,
        workId: run.workId ?? undefined,
        runId: run.runId,
      });
    }
    const needle = term.toLowerCase();
    for (const project of this.listProjects(principal)) {
      if (!project.name.toLowerCase().includes(needle)) continue;
      hits.push({ kind: 'project', id: project.projectId, title: project.name, detail: project.projectId });
      if (hits.filter((hit) => hit.kind === 'project').length >= 5) break;
    }
    for (const app of this.workbenchApps(principal)) {
      const label = app.draft.descriptor?.displayName ?? app.draft.descriptor?.appId ?? app.appId;
      if (!label.toLowerCase().includes(needle) && !app.appId.toLowerCase().includes(needle)) continue;
      hits.push({ kind: 'app', id: `${app.appId}@${app.appVersion}`, title: label, detail: `${app.appId} @ ${app.appVersion}` });
      if (hits.filter((hit) => hit.kind === 'app').length >= 5) break;
    }
    return hits;
  }
  bindWorkWorkspace(workId: string, workspaceId: string, principal: Principal): WorkRecord {
    const work = this.getWork(workId, principal);
    this.policy.authorize(principal, 'work.create', { appId: work.appId, projectId: work.projectId, workId });
    this.policy.authorize(principal, 'workspace.read', { projectId: work.projectId, workspaceId });
    const workspace = this.projects.workspace(workspaceId);
    if (workspace.projectId !== work.projectId) throw new PlatformError('WORKSPACE_PROJECT_MISMATCH');
    if (work.state !== 'ACTIVE') throw new PlatformError('WORK_ARCHIVED');
    return this.store.transaction(() => {
      this.works.requireNoActiveRun(workId);
      const next = { ...work, workspaceId, updatedAt: new Date().toISOString() };
      this.store.workUpdate(next);
      this.store.audit(principal.actorId, 'WORK_WORKSPACE_BOUND', workId, { workspaceId });
      return next;
    });
  }
  archiveWork(workId: string, principal: Principal): WorkRecord {
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'work.archive', { appId: work.appId, projectId: work.projectId, workId });
    return this.works.archive(workId, principal.actorId);
  }
  runsForWork(workId: string, offset: number, limit: number, principal: Principal) {
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'run.read', { appId: work.appId, projectId: work.projectId, workId });
    return this.runs.forWork(workId, offset, limit);
  }

  // ── Execution domains (T03/T05) ─────────────────────────────────────────────
  registerDomain(draft: ExecutionDomainDraft, principal: Principal): ExecutionDomainRecord {
    this.policy.authorize(principal, 'domain.register', { orgId: draft?.owner });
    return this.domains.register(draft, principal.actorId);
  }
  listDomains(principal: Principal): ExecutionDomainRecord[] {
    this.policy.authorize(principal, 'domain.read', { orgId: principal.orgId });
    // A principal without an organization sees only domains it owns.
    const owner = principal.orgId ?? ('owner:' + principal.actorId);
    return this.domains.list(owner);
  }
  setDomainState(
    domainId: string,
    state: ExecutionDomainState,
    expectedRevision: number,
    principal: Principal,
  ): ExecutionDomainRecord {
    const current = this.domains.get(domainId);
    this.policy.authorize(principal, 'domain.register', { orgId: current.owner });
    return this.domains.setState(domainId, state, expectedRevision, principal.actorId);
  }

  // ── Work ↔ native Session bindings (T03/T05) ────────────────────────────────
  bindWorkSession(draft: BindWorkSessionDraft, principal: Principal): WorkSessionBindingRecord {
    const work = this.works.get(draft?.workId);
    this.policy.authorize(principal, 'binding.bind', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    const domain = this.domains.get(draft.domainId);
    this.policy.authorize(principal, 'binding.bind', { orgId: domain.owner });
    return this.bindings.bind(draft, principal.actorId);
  }
  workBinding(workId: string, principal: Principal): WorkSessionBindingRecord | undefined {
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'binding.read', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    return this.bindings.current(workId);
  }
  workBindingHistory(workId: string, principal: Principal): WorkSessionBindingRecord[] {
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'binding.read', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    return this.bindings.history(workId);
  }
  bindingForSession(domainId: string, sessionId: string, principal: Principal): WorkSessionBindingRecord | undefined {
    const binding = this.bindings.forSession(domainId, sessionId);
    if (!binding) return undefined;
    const work = this.works.get(binding.workId);
    this.policy.authorize(principal, 'binding.read', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    return binding;
  }

  /**
   * T06: resolve the Work a native Session belongs to, searching registered execution domains.
   * The native shell knows only the sessionId, so this is the reverse lookup that lets "open work"
   * work from a session. A session with no association returns null, never a fabricated Work.
   */
  workForSession(sessionId: string, principal: Principal): {
    binding: WorkSessionBindingRecord;
    work: WorkRecord;
  } | null {
    // Domains visible to this principal; a service principal cannot enumerate them.
    const domains = this.domains.list(principal.orgId ?? ('owner:' + principal.actorId));
    for (const domain of domains) {
      const binding = this.bindings.forSession(domain.domainId, sessionId);
      if (!binding) continue;
      const work = this.works.get(binding.workId);
      try {
        this.policy.authorize(principal, 'binding.read', {
          appId: work.appId, projectId: work.projectId, workId: work.workId,
        });
      } catch (error) {
        if (error instanceof AuthorizationError) continue;
        throw error;
      }
      return { binding, work };
    }
    return null;
  }

  // ── Submission intents (T05) ────────────────────────────────────────────────
  recordSubmission(draft: SubmissionDraft, principal: Principal) {
    const work = this.works.get(draft?.workId);
    // The trusted submitter must be the calling principal; never a model/browser-supplied actor.
    if (draft.submittedBy !== principal.actorId) {
      throw new PlatformError('SUBMISSION_SUBMITTER_MISMATCH', draft.submittedBy);
    }
    this.policy.authorize(principal, 'submission.record', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
      ...(principal.orgId !== undefined ? { orgId: principal.orgId } : {}),
    });
    const domain = this.domains.get(draft.domainId);
    this.policy.authorize(principal, 'submission.record', { orgId: domain.owner });
    // The session must be this Work's current binding in that domain.
    const binding = this.bindings.current(work.workId);
    if (!binding || binding.domainId !== draft.domainId || binding.sessionId !== draft.sessionId) {
      throw new PlatformError('SUBMISSION_SESSION_NOT_BOUND', `${draft.domainId}:${draft.sessionId}`);
    }
    return this.submissions.record(draft, principal.actorId);
  }
  acknowledgeSubmission(submissionId: string, admission: string, principal: Principal) {
    const record = this.submissions.get(submissionId);
    if (!record) throw new PlatformError('SUBMISSION_NOT_FOUND', submissionId);
    const work = this.works.get(record.workId);
    this.policy.authorize(principal, 'submission.record', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    return this.submissions.markAccepted(submissionId, admission, principal.actorId);
  }
  consumeSubmission(submissionId: string, principal: Principal) {
    const record = this.submissions.get(submissionId);
    if (!record) throw new PlatformError('SUBMISSION_NOT_FOUND', submissionId);
    const work = this.works.get(record.workId);
    this.policy.authorize(principal, 'submission.record', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    return this.submissions.markConsumed(submissionId, principal.actorId);
  }
  markSubmissionUnknown(submissionId: string, note: string, principal: Principal) {
    const record = this.submissions.get(submissionId);
    if (!record) throw new PlatformError('SUBMISSION_NOT_FOUND', submissionId);
    const work = this.works.get(record.workId);
    this.policy.authorize(principal, 'submission.record', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    return this.submissions.markUnknown(submissionId, note, principal.actorId);
  }
  submissionsForWork(workId: string, principal: Principal) {
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'submission.read', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    return this.submissions.forWork(workId);
  }

  /**
   * T07: Work-level input batches, newest first. A batch is append-only — a new baseline never
   * rewrites an old one — so an execution can always be traced to the exact inputs it ran on.
   * Paging happens here instead of in the UI so a long history is never loaded wholesale.
   */
  inputBaselinesForWork(
    workId: string,
    offset: number,
    limit: number,
    principal: Principal,
  ): { total: number; items: InputBaselineRecord[] } {
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'work.read', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    const history = this.inputBaselines.history(workId).slice().reverse();
    return { total: history.length, items: history.slice(offset, offset + limit) };
  }

  /** Append one input batch to an active Work; the actor is the authenticated principal. */
  appendInputBaseline(
    workId: string,
    draft: Omit<InputBaselineDraft, 'workId'>,
    principal: Principal,
  ): InputBaselineRecord {
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'work.input', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    if (work.state !== 'ACTIVE') throw new PlatformError('WORK_ARCHIVED', workId);
    return this.inputBaselines.append({ workId, ...draft }, principal.actorId);
  }

  /**
   * T06 resolveWorkContext: one authorization-checked view of everything the workbench needs to
   * open a Work into its native session — project, workspace, app release, domain and the current
   * binding. A caller-supplied sessionId/domainId is only echoed when it is actually bound to this
   * Work, so a deep link cannot address another Work's session (§2.2, T06).
   */
  resolveWorkContext(
    workId: string,
    principal: Principal,
    requested: { sessionId?: string; domainId?: string } = {},
  ): {
    work: WorkRecord;
    project: ReturnType<ProjectRepository['get']>;
    workspace: ReturnType<ProjectRepository['workspace']> | null;
    app: { appId: string; appVersion: string; releaseDigest: string; displayName: string };
    binding: WorkSessionBindingRecord | null;
    domain: ExecutionDomainRecord | null;
    sessionId: string | null;
  } {
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'work.read', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    const project = this.projects.get(work.projectId);
    const workspace = work.workspaceId ? this.projects.workspace(work.workspaceId) : null;
    const appRecord = this.registry.get(work.appId, work.appVersion);
    if (appRecord.state !== 'ACTIVE') throw new PlatformError('APP_RELEASE_NOT_ACTIVE', `${work.appId}@${work.appVersion}`);
    const binding = this.bindings.current(work.workId) ?? null;
    const domain = binding ? this.domains.get(binding.domainId) : null;
    if (requested.sessionId !== undefined || requested.domainId !== undefined) {
      if (!binding || binding.sessionId !== requested.sessionId || binding.domainId !== requested.domainId) {
        // A requested session that is not this Work's binding is refused, not silently redirected.
        throw new PlatformError('WORK_CONTEXT_NOT_BOUND', `${requested.domainId ?? '?'}:${requested.sessionId ?? '?'}`);
      }
    }
    return {
      work,
      project,
      workspace,
      app: {
        appId: appRecord.appId, appVersion: appRecord.appVersion,
        releaseDigest: appRecord.releaseDigest, displayName: appRecord.draft.descriptor.displayName,
      },
      binding,
      domain,
      sessionId: binding?.sessionId ?? null,
    };
  }
  /**
   * W3: the single server-side freeze operation. Every run-creation and rebatch entry converges
   * here: the input's immutable work-level revision (baseline), the Run row, and its durable
   * dispatch intent are committed in ONE transaction, and every mutable precondition (work
   * active, no other active run, release active+approved, project quota, model route) is checked
   * inside that same transaction — so a duplicate submission that races an admit is refused by
   * the transaction itself, a default switched after admission never reaches an already-frozen
   * run, and a crash never leaves a Run without its frozen revision or dispatch intent.
   */
  createWorkRun(
    workId: string,
    input: unknown,
    principal: Principal,
    options: { modelSelectionId?: string; modelOptions?: unknown; sourceRef?: string } = {},
  ): RunRecord {
    // Authorization resolves against the Work BEFORE any write: an identity that cannot run this
    // app, or cannot see the Work's project, is refused without opening a transaction or touching
    // the ledger. The Work row is the authoritative project (R2/R3) — never a request parameter.
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'run.create', {
      appId: work.appId, projectId: work.projectId, workId: work.workId,
    });
    const scope = this.visibleProjectIds(principal);
    if (scope !== null && (work.projectId === undefined || !scope.includes(work.projectId))) {
      throw new AuthorizationError('PLATFORM_PROJECT_ACCESS_DENIED', work.projectId ?? '(no project)');
    }
    return this.store.transaction(() => {
      if (work.state !== 'ACTIVE') throw new PlatformError('WORK_ARCHIVED', workId);
      // Fast fail before the baseline append; runs.create re-checks single-Work admission inside
      // its own savepoint, so a submission that races an in-flight admit can never dispatch twice.
      this.works.requireNoActiveRun(workId);
      const app = this.registry.active(work.appId, work.appVersion);
      this.requireApproval(app);
      // E2-3: per-project budget gate, checked before any model resolution or launch.
      this.requireProjectQuota(work.projectId);
      // Runs stay persistent when no executor is configured; the workbench must show that truth
      // and offer configuration, never imply execution has started.
      const model = this.resolveRunModel(app.plan.runtimeBundleDigest, principal, options);
      const available = this.availableForApp(app, principal);
      if (available.entries.some((entry) => entry.enabled) && !model) {
        throw new PlatformError('MODEL_SELECTION_REQUIRED', '请选择一个可用模型后再开始运行。');
      }
      const workspace = work.workspaceId ? this.projects.workspace(work.workspaceId) : undefined;
      if (workspace) this.policy.authorize(principal, 'workspace.read', {
        projectId: work.projectId, workspaceId: workspace.workspaceId,
      });
      const history = this.runs.forWork(workId, 0, 20);
      // KA11/WP2：Run 创建时绑定知识快照（只读摘要）与可信租户范围。仅当应用声明知识域时才要求
      // 企业范围：缺失时以 KNOWLEDGE_SCOPE_UNAVAILABLE 可诊断拒绝，而不是静默绑定跨租户记录；
      // 本地模式绑定显式的无租户快照（单机部署），不猜测归属。
      const knowledge = this.knowledgeSource && app.draft.descriptor.knowledgePluginId
        ? this.knowledgeSource(app, work.projectId, this.effectiveKnowledgeScope(principal), { actorId: principal.actorId })
        : undefined;
      // Freeze the input revision and the Run in one transaction: the baseline digest IS the
      // canonical digest the Run records as inputDigest, so the work ledger and the execution
      // agree on exactly what was frozen, and a rebatch appends a new revision — it never
      // mutates the revision an already-admitted run points at.
      const inputDigest = runInputDigest(input);
      const baseline = this.inputBaselines.append({
        workId,
        sourceRef: options.sourceRef ?? `input:${inputDigest}`,
        digest: inputDigest,
      }, principal.actorId);
      const run = this.runs.create(app, input, principal.actorId, model, workId, {
        ...(workspace ? { workspace } : {}),
        ...(knowledge ? { knowledge } : {}),
        context: {
          goal: work.goal ?? work.title,
          previousRuns: history.items.reverse().map((previous) => ({
            runId: previous.runId, input: previous.input, result: previous.result,
          })),
          truncated: history.total > history.items.length,
        },
      });
      if (run.inputDigest !== baseline.digest) {
        // Unreachable by construction (both derive from runInputDigest(input)); asserted so a
        // future refactor cannot silently split the ledger from the execution contract.
        throw new PlatformError('RUN_INPUT_FROZEN_MISMATCH', baseline.digest);
      }
      this.store.audit(principal.actorId, 'RUN_INPUT_FROZEN', run.runId, {
        workId,
        baselineId: baseline.baselineId,
        revision: baseline.revision,
        sourceRef: baseline.sourceRef,
        digest: baseline.digest,
        appId: app.appId,
        appVersion: app.appVersion,
        releaseDigest: app.releaseDigest,
        planDigest: app.plan.planDigest,
      });
      return run;
    });
  }
  /** Register/replace the deployment's verified model catalog snapshot (metadata only). */
  registerModelCatalog(draft: unknown, principal: Principal): ModelCatalogRecord {
    this.policy.authorize(principal, 'model.register');
    const validated = validateModelCatalog(draft);
    const catalogDigest = modelCatalogDigest(validated);
    const existing = this.store.modelCatalogGet();
    if (existing && existing.catalogId === validated.catalogId && existing.catalogDigest === catalogDigest) {
      return existing;
    }
    const now = new Date().toISOString();
    const record: ModelCatalogRecord = {
      ...validated,
      catalogDigest,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.transaction(() => {
      this.store.modelCatalogPut(record);
      this.store.audit(
        principal.actorId,
        existing ? 'MODEL_CATALOG_UPDATED' : 'MODEL_CATALOG_REGISTERED',
        record.catalogId,
        {
          catalogDigest,
          previousDigest: existing?.catalogDigest ?? null,
          entries: record.entries.length,
          runtimeBundleDigest: record.runtimeBundleDigest,
        },
      );
    });
    return record;
  }
  modelCatalog(principal: Principal): ModelCatalogRecord | null {
    this.policy.authorize(principal, 'model.read');
    const catalog = this.store.modelCatalogGet();
    if (!catalog) return null;
    const entries = catalog.entries.filter((entry) => this.modelVisible(principal, entry.selectionId));
    return {
      ...catalog,
      entries,
      defaultSelectionId: entries.some((entry) => entry.selectionId === catalog.defaultSelectionId)
        ? catalog.defaultSelectionId : undefined,
    };
  }
  private modelVisible(principal: Principal, selectionId: string): boolean {
    try {
      this.policy.authorize(principal, 'model.read', { modelSelectionId: selectionId });
      return true;
    } catch (error) {
      if (error instanceof AuthorizationError) return false;
      throw error;
    }
  }
  private requireModelVisible(principal: Principal, selectionId: string): void {
    if (!this.modelVisible(principal, selectionId)) throw new PlatformError('MODEL_SELECTION_UNKNOWN');
  }
  /** A saved preference is never silently replaced: an unavailable/unknown entry is reported. */
  modelPreference(principal: Principal): ModelPreferenceView {
    this.policy.authorize(principal, 'model.read');
    const saved = this.store.modelPreferenceGet(principal.actorId);
    if (!saved || !this.modelVisible(principal, saved.selectionId)) {
      return { selectionId: null, updatedAt: null, state: 'none', entry: null, reason: '尚未保存默认模型偏好。' };
    }
    const catalog = this.store.modelCatalogGet();
    if (!catalog) {
      return {
        selectionId: saved.selectionId,
        updatedAt: saved.updatedAt,
        state: 'unknown',
        entry: null,
        reason: '平台尚未登记模型目录；原选择不会被自动替换。',
      };
    }
    const entry = findCatalogEntry(catalog, saved.selectionId);
    if (!entry) {
      return {
        selectionId: saved.selectionId,
        updatedAt: saved.updatedAt,
        state: 'unknown',
        entry: null,
        reason: '原选择不在当前模型目录中；创建运行前需要重新选择。',
      };
    }
    if (!entry.enabled) {
      return {
        selectionId: saved.selectionId,
        updatedAt: saved.updatedAt,
        state: 'unavailable',
        entry,
        reason: entry.unavailableReason || '该模型当前不可用；创建运行前需要重新选择。',
      };
    }
    return { selectionId: saved.selectionId, updatedAt: saved.updatedAt, state: 'available', entry, reason: '' };
  }
  setModelPreference(selectionId: string, principal: Principal): ModelPreferenceView {
    this.policy.authorize(principal, 'model.preference');
    this.requireModelVisible(principal, selectionId);
    const catalog = this.store.modelCatalogGet();
    if (!catalog) throw new PlatformError('MODEL_CATALOG_UNAVAILABLE');
    const entry = requireAvailableEntry(catalog, selectionId);
    this.requireHealthy(entry);
    const updatedAt = new Date().toISOString();
    this.store.modelPreferenceSet(principal.actorId, entry.selectionId, updatedAt);
    this.store.audit(principal.actorId, 'MODEL_PREFERENCE_SET', entry.selectionId, {
      provider: entry.provider,
      model: entry.model,
      catalogDigest: catalog.catalogDigest,
    });
    return { selectionId: entry.selectionId, updatedAt, state: 'available', entry, reason: '' };
  }

  // ── Model health facts ─────────────────────────────────────────────────────
  /** Record a deployment probe result for one catalog selection. The platform never probes a
   *  provider itself; a stale or missing health fact stays `unknown`, never a guessed `healthy`. */
  recordModelHealth(
    draft: { selectionId: string; state: ModelHealthState; reason?: string },
    principal: Principal,
  ): ModelHealthRecord {
    this.policy.authorize(principal, 'model.register');
    if (!draft || typeof draft.selectionId !== 'string' || !draft.selectionId) {
      throw new PlatformError('MODEL_HEALTH_INVALID', 'selectionId');
    }
    if (!['healthy', 'degraded', 'unavailable', 'unknown'].includes(draft.state)) {
      throw new PlatformError('MODEL_HEALTH_INVALID', 'state');
    }
    if (draft.reason !== undefined && (typeof draft.reason !== 'string' || draft.reason.length > 1000)) {
      throw new PlatformError('MODEL_HEALTH_INVALID', 'reason');
    }
    if (draft.state === 'unavailable' && !draft.reason?.trim()) {
      throw new PlatformError('MODEL_HEALTH_INVALID', 'reason required for unavailable');
    }
    const catalog = this.store.modelCatalogGet();
    if (!catalog) throw new PlatformError('MODEL_CATALOG_UNAVAILABLE');
    if (!findCatalogEntry(catalog, draft.selectionId)) {
      throw new PlatformError('MODEL_SELECTION_UNKNOWN', draft.selectionId);
    }
    const previous = this.store.modelHealthGet(draft.selectionId);
    const record: ModelHealthRecord = {
      selectionId: draft.selectionId,
      state: draft.state,
      ...(draft.reason !== undefined ? { reason: draft.reason } : {}),
      checkedAt: new Date().toISOString(),
      catalogDigest: catalog.catalogDigest,
      revision: (previous?.revision ?? 0) + 1,
    };
    this.store.transaction(() => {
      this.store.modelHealthPut(record);
      this.store.audit(principal.actorId, 'MODEL_HEALTH_RECORDED', draft.selectionId, {
        state: record.state,
        reason: record.reason ?? null,
        catalogDigest: record.catalogDigest,
      });
    });
    metrics.gauge('platform_model_health', record.state === 'healthy' ? 1 : 0, { selectionId: record.selectionId });
    return record;
  }
  modelHealth(principal: Principal): ModelHealthRecord[] {
    this.policy.authorize(principal, 'model.read');
    return this.store.modelHealthList().filter((record) => this.modelVisible(principal, record.selectionId));
  }
  private requireHealthy(entry: ModelCatalogEntry): void {
    if (!this.requireModelHealth) return;
    const health = this.store.modelHealthGet(entry.selectionId);
    if (health?.state === 'unavailable') {
      throw new PlatformError('MODEL_HEALTH_UNAVAILABLE', health.reason || entry.selectionId);
    }
  }
  createRun(
    appId: string,
    appVersion: string,
    input: unknown,
    principal: Principal,
    options: { modelSelectionId?: string; modelOptions?: unknown } = {},
  ): RunRecord {
    this.policy.authorize(principal, 'run.create', { appId });
    const app = this.registry.active(appId, appVersion);
    this.requireApproval(app);
    const model = this.resolveRunModel(app.plan.runtimeBundleDigest, principal, options);
    return this.runs.create(app, input, principal.actorId, model);
  }
  /** Retry never reuses the old Run/session: it creates a new Run with a fresh home and input marker.
   *  Without an explicit new choice it keeps the original route and re-validates it. */
  retryRun(runId: string, principal: Principal): RunRecord {
    return this.createRetry(runId, principal);
  }
  /** Retry with a user-selected model: the new Run records the new choice explicitly; the old
   *  Run keeps its snapshot. This prevents a UI model change from silently reusing the old route. */
  retryRunWithModel(
    runId: string,
    principal: Principal,
    options: { modelSelectionId?: string; modelOptions?: unknown } = {},
  ): RunRecord {
    return this.createRetry(runId, principal, options);
  }
  private createRetry(
    runId: string,
    principal: Principal,
    options: { modelSelectionId?: string; modelOptions?: unknown } = {},
  ): RunRecord {
    const previous = this.runs.get(runId);
    if (previous.snapshot.state !== 'FAILED' && previous.snapshot.state !== 'CANCELLED') {
      throw new PlatformError('RUN_RETRY_NOT_TERMINAL_FAILURE', previous.snapshot.state);
    }
    this.policy.authorize(principal, 'run.create', { appId: previous.appId });
    const app = this.registry.active(previous.appId, previous.appVersion);
    this.requireApproval(app);
    const workId = previous.workId;
    if (workId) {
      const work = this.works.get(workId);
      if (work.state !== 'ACTIVE') throw new PlatformError('WORK_ARCHIVED', workId);
      this.works.requireNoActiveRun(workId);
    }
    let model: ModelConfigSnapshot | null;
    if (options.modelSelectionId !== undefined || !previous.model) {
      model = this.resolveRunModel(app.plan.runtimeBundleDigest, principal, options);
    } else {
      const catalog = this.store.modelCatalogGet();
      if (!catalog) throw new PlatformError('MODEL_CATALOG_UNAVAILABLE');
      if (catalog.runtimeBundleDigest !== app.plan.runtimeBundleDigest) {
        throw new PlatformError('MODEL_CATALOG_RUNTIME_MISMATCH');
      }
      this.requireModelVisible(principal, previous.model.selectionId);
      model = retrySnapshot(catalog, previous.model);
    }
    const created = this.runs.create(
      app,
      { retryOf: previous.runId, input: previous.input, inputDigest: previous.inputDigest },
      principal.actorId,
      model,
      workId,
    );
    this.store.audit(principal.actorId, 'RUN_RETRY_CREATED', created.runId, {
      retryOf: previous.runId,
      appId: created.appId,
      appVersion: created.appVersion,
      workId,
      modelSelectionId: model?.selectionId ?? null,
      modelSelectionSource: model?.selectionSource ?? null,
    });
    return created;
  }
  appendInput(runId: string, input: unknown, principal: Principal): InputCommit {
    const record = this.runs.get(runId);
    this.authorizeRunScope(principal, 'run.input', record);
    return this.runs.appendInput(runId, input, principal.actorId);
  }
  inputs(runId: string, offset: number, limit: number, principal: Principal) {
    this.getRun(runId, principal);
    return this.runs.inputs(runId, offset, limit);
  }
  attempts(runId: string, principal: Principal) {
    this.getRun(runId, principal);
    return this.store.attempts(runId);
  }
  workConversation(workId: string, principal: Principal) {
    const work = this.getWork(workId, principal);
    this.policy.authorize(principal, 'conversation.read', { appId: work.appId, projectId: work.projectId, workId });
    const history = this.runs.forWork(workId, 0, 100);
    const messages = history.items.flatMap((run) => {
      const inputs = this.runs.inputs(run.runId, 0, 100).items
        .map((item) => ({ role: 'user' as const, text: typeof item.body === 'string' ? item.body : JSON.stringify(item.body), createdAt: item.createdAt }));
      const activities = (this.conversationActivities.get(run.runId) ?? [])
        .map((activity) => ({ role: 'assistant' as const, ...activity }));
      const result = run.result?.finalResponse && !activities.some((item) => item.text === run.result!.finalResponse)
        ? [{ role: 'assistant' as const, kind: 'text' as const, text: run.result.finalResponse,
            sessionId: run.result.sessionId ?? '', createdAt: run.result.at }]
        : [];
      return [{ runId: run.runId, state: run.snapshot.state, model: run.model, messages: [...inputs, ...activities, ...result] }];
    });
    return { items: messages, truncated: history.total > history.items.length };
  }
  getRun(runId: string, principal: Principal): RunRecord {
    const record = this.runs.get(runId);
    this.authorizeRunScope(principal, 'run.read', record);
    return { ...record, activities: this.conversationActivities.get(runId) ?? [] };
  }
  listRuns(appId: string | undefined, offset: number, limit: number, principal: Principal) {
    this.policy.authorize(principal, 'run.read', appId ? { appId } : undefined);
    return this.runs.list(appId, offset, limit, this.visibleProjectIds(principal) ?? undefined);
  }
  runEvents(runId: string, offset: number, limit: number, principal: Principal) {
    this.getRun(runId, principal);
    return this.runs.events(runId, offset, limit);
  }
  /** Persistent inbox of SDK-native questions for this run (answers included, same principal). */
  interactions(runId: string, principal: Principal): InteractionRecord[] {
    this.getRun(runId, principal);
    return this.store.interactionsForRun(runId);
  }

  /**
   * Pending questions across the runs this principal may read, oldest first. A run the principal
   * cannot read is omitted rather than leaked; an unreadable record never becomes a count.
   */
  pendingInteractions(principal: Principal): Array<{
    interactionId: string;
    runId: string;
    workId: string | null;
    sessionId: string;
    createdAt: string;
    questions: number;
    /** Current run state so the workbench can show why a question is waiting. */
    runState: string;
  }> {
    const items: Array<{
      interactionId: string;
      runId: string;
      workId: string | null;
      sessionId: string;
      createdAt: string;
      questions: number;
      runState: string;
    }> = [];
    for (const record of this.store.pendingInteractions(200)) {
      let run: RunRecord;
      try {
        run = this.runs.get(record.runId);
        this.authorizeRunScope(principal, 'run.read', run);
      } catch (error) {
        if (error instanceof AuthorizationError) continue;
        throw error;
      }
      const questions = (record.body as { questions?: unknown[] }).questions;
      items.push({
        interactionId: record.interactionId,
        runId: record.runId,
        workId: run.workId,
        sessionId: record.sessionId,
        createdAt: record.createdAt,
        questions: Array.isArray(questions) ? questions.length : 0,
        runState: run.snapshot.state,
      });
    }
    return items;
  }

  /**
   * E3-4 unified todo list: one read surface over three distinct sources, each keeping its own
   * type and its own resolution verb — nothing is pushed into the interactions table. A source
   * item the principal cannot act on (per that source's own authorization) is omitted rather
   * than leaked; an unreadable record never becomes a count.
   */
  pendingTodos(principal: Principal): Array<{
    kind: 'question' | 'review' | 'delivery-receipt' | 'model-approval';
    id: string;
    runId: string | null;
    workId: string | null;
    createdAt: string;
    summary: string;
    /** The concrete act that resolves this item, named after its own API — never a generic "handle". */
    resolveHint: string;
  }> {
    const items: Array<{
      kind: 'question' | 'review' | 'delivery-receipt' | 'model-approval';
      id: string;
      runId: string | null;
      workId: string | null;
      createdAt: string;
      summary: string;
      resolveHint: string;
    }> = [];
    // Questions: same records pendingInteractions returns, re-typed with the answer verb.
    for (const question of this.pendingInteractions(principal)) {
      items.push({
        kind: 'question',
        id: question.interactionId,
        runId: question.runId,
        workId: question.workId,
        createdAt: question.createdAt,
        summary: `运行中有 ${question.questions} 个问题等待回答（运行状态 ${question.runState}）`,
        resolveHint: 'POST /api/interactions/:interactionId/answer',
      });
    }
    // Open delivery reviews: authorized exactly as recordReviewDecision authorizes.
    for (const review of this.store.openReviews(200)) {
      let run: RunRecord;
      try {
        run = this.runs.get(review.runId);
        this.authorizeRunScope(principal, 'run.review', run);
      } catch (error) {
        if (error instanceof AuthorizationError) continue;
        throw error;
      }
      items.push({
        kind: 'review',
        id: review.reviewId,
        runId: review.runId,
        workId: run.workId ?? null,
        createdAt: review.createdAt,
        // R5 display facts: a bound review names its frozen target manifest; a legacy run-only
        // record is marked for what it is — never given an invented manifest.
        summary: review.deliverable
          ? `交付复核待决定（由 ${review.requestedBy} 发起，目标清单 ${review.deliverable.manifestDigest.slice(0, 12)}，当前 revision ${review.revision}）`
          : `交付复核待决定（由 ${review.requestedBy} 发起，未绑定具体成果版本，当前 revision ${review.revision}）`,
        resolveHint: 'POST /api/reviews/:reviewId/decision（需 expectedRevision 与 expectedManifestDigest）',
      });
    }
    // Delivered-but-unreceived packages: authorized exactly as acknowledgeDeliveryPackage authorizes,
    // so the todo only ever lists items the principal can actually resolve.
    for (const pkg of this.store.packagesByState('DELIVERED', 200)) {
      let work: WorkRecord;
      try {
        work = this.works.get(pkg.workId);
        this.policy.authorize(principal, 'work.delivery', {
          appId: work.appId, projectId: work.projectId, workId: work.workId,
        });
      } catch (error) {
        if (error instanceof AuthorizationError) continue;
        throw error;
      }
      items.push({
        kind: 'delivery-receipt',
        id: pkg.packageId,
        runId: pkg.runId,
        workId: pkg.workId,
        createdAt: pkg.createdAt,
        summary: `交付包已送达等待接收确认（封存人 ${pkg.sealedBy}，当前 revision ${pkg.revision}）`,
        resolveHint: 'POST /api/delivery-packages/:packageId/acknowledge（需 expectedRevision）',
      });
    }
    // Model approvals (E2-4/E3-4): only when this deployment gates runs on approvals, and only
    // for principals the policy lets approve — a todo nobody can act on is not listed.
    if (this.requireModelApproval) {
      const catalog = this.store.modelCatalogGet();
      if (catalog) {
        for (const entry of catalog.entries) {
          if (!entry.enabled) continue;
          try {
            this.policy.authorize(principal, 'model.approve', { modelSelectionId: entry.selectionId });
          } catch (error) {
            if (error instanceof AuthorizationError) continue; // 该 selection 不在此主体可批准范围内
            throw error;
          }
          const approval = this.store.modelApprovalGet(entry.selectionId);
          const expired = approval?.expiresAt !== undefined && Date.parse(approval.expiresAt) <= Date.now();
          if (approval?.state === 'ACTIVE' && !expired) continue;
          items.push({
            kind: 'model-approval',
            id: entry.selectionId,
            runId: null,
            workId: null,
            createdAt: catalog.updatedAt,
            summary: approval
              ? `模型 ${entry.displayName} 的审批已过期，运行会被 MODEL_APPROVAL_EXPIRED 拒绝`
              : `模型 ${entry.displayName} 已登记但无生效审批，运行会被 MODEL_APPROVAL_REQUIRED 拒绝`,
            resolveHint: 'POST /api/models/:selectionId/approval（绑定具体 selection）',
          });
        }
      }
    }
    items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return items;
  }
  /** CAS answer from the bound operator; late, duplicate or post-terminal answers are rejected. */
  answerInteraction(interactionId: string, answer: unknown, principal: Principal): InteractionRecord {
    const record = this.store.interactionGet(interactionId);
    if (!record) throw new PlatformError('INTERACTION_NOT_FOUND');
    const run = this.runs.get(record.runId);
    this.authorizeRunScope(principal, 'run.answer', run);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(run.snapshot.state)) {
      throw new PlatformError('INTERACTION_RUN_TERMINAL', run.snapshot.state);
    }
    const normalized = this.normalizeAnswer(record, answer);
    if (!this.store.interactionResolve(interactionId, 'ANSWERED', normalized)) {
      throw new PlatformError('INTERACTION_NOT_PENDING');
    }
    this.store.audit(principal.actorId, 'RUN_QUESTION_ANSWERED', record.runId, {
      interactionId,
      requestId: record.requestId,
      sessionId: record.sessionId,
    });
    this.interactionWaiters.get(interactionId)?.(normalized);
    return this.store.interactionGet(interactionId) as InteractionRecord;
  }
  /** Durable replay cursor for a resumable stream; authorized per read. */
  eventsAfter(runId: string, after: number, principal: Principal) {
    this.getRun(runId, principal);
    return this.store.runEventsAfter(runId, after, 100);
  }
  artifacts(runId: string, principal: Principal): ArtifactRecord[] {
    this.getRun(runId, principal);
    return this.store.artifacts(runId);
  }
  /** App-contributed result facts of one succeeded run (E1-4). Empty until an app contributes. */
  findings(runId: string, principal: Principal): RunFinding[] {
    this.getRun(runId, principal);
    return this.store.findings(runId);
  }
  /** Align two runs' findings by stable business key within each kind (E1-4). Different apps or
   *  app versions are declared incomparable — the diff returns that fact instead of guessing. */
  diffRunFindings(runId: string, againstRunId: string, principal: Principal) {
    const from = this.getRun(runId, principal);
    const to = this.getRun(againstRunId, principal);
    if (from.appId !== to.appId) {
      return { comparable: false as const, reason: 'APP_MISMATCH' as const, fromRunId: runId, toRunId: againstRunId };
    }
    if (from.appVersion !== to.appVersion) {
      return { comparable: false as const, reason: 'APP_VERSION_MISMATCH' as const, fromRunId: runId, toRunId: againstRunId };
    }
    const digest = (finding: RunFinding): string =>
      JSON.stringify([finding.severity ?? null, finding.summary ?? null, finding.fields ?? null]);
    const align = (before: RunFinding[], after: RunFinding[]) => {
      const items: Array<{
        key: string;
        state: 'added' | 'resolved' | 'changed' | 'unchanged';
        before?: RunFinding;
        after?: RunFinding;
      }> = [];
      const beforeByKey = new Map(before.map((finding) => [finding.key, finding]));
      const afterByKey = new Map(after.map((finding) => [finding.key, finding]));
      for (const [key, afterFinding] of afterByKey) {
        const beforeFinding = beforeByKey.get(key);
        if (!beforeFinding) items.push({ key, state: 'added', after: afterFinding });
        else if (digest(beforeFinding) !== digest(afterFinding)) items.push({ key, state: 'changed', before: beforeFinding, after: afterFinding });
        else items.push({ key, state: 'unchanged', before: beforeFinding, after: afterFinding });
      }
      for (const [key, beforeFinding] of beforeByKey) {
        if (!afterByKey.has(key)) items.push({ key, state: 'resolved', before: beforeFinding });
      }
      items.sort((a, b) => a.key.localeCompare(b.key));
      return {
        added: items.filter((item) => item.state === 'added').length,
        resolved: items.filter((item) => item.state === 'resolved').length,
        changed: items.filter((item) => item.state === 'changed').length,
        unchanged: items.filter((item) => item.state === 'unchanged').length,
        items,
      };
    };
    const before = this.store.findings(runId);
    const after = this.store.findings(againstRunId);
    const kinds = [...new Set([...before, ...after].map((finding) => finding.kind))].sort();
    return {
      comparable: true as const,
      appId: from.appId,
      fromRunId: runId,
      toRunId: againstRunId,
      kinds: kinds.map((kind) => ({
        kind,
        ...align(before.filter((finding) => finding.kind === kind), after.filter((finding) => finding.kind === kind)),
      })),
    };
  }
  /** Open the local operator's native folder dialog; no directory contents cross the API. */
  authorizePick(principal: Principal): void {
    this.policy.authorize(principal, 'fs.pick');
  }
  authorizeMetrics(principal: Principal): void {
    this.policy.authorize(principal, 'metrics.read');
  }
  audit(offset: number, limit: number, principal: Principal): { items: AuditEntry[]; total: number } {
    this.policy.authorize(principal, 'audit.read');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new PlatformError('AUDIT_PAGE_INVALID');
    }
    return this.store.auditList(offset, limit);
  }

  /**
   * Verifiable audit export: ascending JSONL with a SHA-256 chain. Each line carries the previous
   * line's digest, so removing, reordering or editing a line breaks verification. This is an
   * integrity aid, not a signature: a deployment that needs non-repudiation signs the head digest.
   */
  auditExport(
    principal: Principal,
    options: { target?: string; after?: number; limit?: number } = {},
  ): { lines: string[]; count: number; headDigest: string; lastSequence: number } {
    this.policy.authorize(principal, 'audit.read');
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 5000);
    const rows = options.target !== undefined
      ? this.store.auditRowsForTarget(options.target, limit)
      : this.store.auditRowsAfter(Math.max(options.after ?? 0, 0), limit);
    let previous = '0'.repeat(64);
    const lines: string[] = [];
    let lastSequence = options.after ?? 0;
    for (const entry of rows) {
      const payload = canonicalJson(entry);
      const digest = createHash('sha256').update(previous).update(payload).digest('hex');
      lines.push(JSON.stringify({ ...entry, prevDigest: previous, digest }));
      previous = digest;
      lastSequence = entry.sequence;
    }
    return { lines, count: lines.length, headDigest: previous, lastSequence };
  }

  async cancelRun(runId: string, expectedRevision: number, principal: Principal): Promise<CancelResult> {
    const record = this.runs.get(runId);
    this.policy.authorize(principal, 'run.cancel', { appId: record.appId });
    if (
      record.snapshot.state === 'SUCCEEDED' ||
      record.snapshot.state === 'FAILED' ||
      record.snapshot.state === 'CANCELLED' ||
      record.snapshot.state === 'UNKNOWN'
    ) {
      throw new PlatformError('RUN_TERMINAL', record.snapshot.state);
    }
    const cancelled = this.runs.apply(runId, { type: 'cancel' }, expectedRevision, principal.actorId);
    // A stopped run no longer owns pending questions; waiting SDK calls are dismissed.
    this.settleInteractions(runId, 'CANCELLED');
    if (cancelled.snapshot.state === 'CANCELLED') return { record: cancelled, cancelSettled: true };
    const launchId = cancelled.snapshot.launchId;
    if (!launchId) return { record: cancelled, cancelSettled: false };
    // Cancel through the executor this run was dispatched under — its own bundle, never a default.
    const bundle = this.registry.get(record.appId, record.appVersion).plan.runtimeBundleDigest;
    const executor = this.executorFor(bundle);
    if (!executor) return { record: cancelled, cancelSettled: false };
    const settled = await executor.cancel(launchId);
    if (!settled) return { record: cancelled, cancelSettled: false };
    const latest = this.runs.get(runId);
    if (latest.snapshot.state === 'CANCELLED') return { record: latest, cancelSettled: true };
    if (['UNKNOWN', 'FAILED', 'SUCCEEDED'].includes(latest.snapshot.state)) {
      return { record: latest, cancelSettled: false };
    }
    return {
      record: this.runs.apply(runId, { type: 'cancel-settled' }, latest.snapshot.revision, whichService(principal)),
      cancelSettled: true,
    };
  }

  /** Operator-confirmed reconciliation: UNKNOWN stays the historical fact, but no longer reserves work. */
  reconcileUnknown(runId: string, principal: Principal): RunRecord {
    const run = this.runs.get(runId);
    this.authorizeRunScope(principal, 'run.reconcile', run);
    if (run.snapshot.state !== 'UNKNOWN') throw new PlatformError('RUN_NOT_UNKNOWN', run.snapshot.state);
    if (!run.reconciledAt) {
      this.store.runMarkReconciled(runId, new Date().toISOString());
      this.store.audit(principal.actorId, 'RUN_UNKNOWN_RECONCILED', runId, {
        note: 'operator confirmed no live execution; workspace released',
      });
    }
    return this.getRun(runId, principal);
  }

  /** Supervisor-only: launch the worker and bind its launchId/fencing token. Dispatch resolves
   *  the executor by THIS run's exact runtime bundle (never the app's default release), so a
   *  queued run always drains on the artifact it was admitted under. */
  async dispatchRun(runId: string, expectedRevision: number, principal: Principal): Promise<RunRecord> {
    this.policy.authorize(principal, 'run.dispatch');
    const record = this.runs.get(runId);
    if (record.snapshot.revision !== expectedRevision) throw new PlatformError('RUN_REVISION_STALE');
    if (record.snapshot.cancelRequested) throw new PlatformError('RUN_CANCEL_REQUESTED');
    const app = this.registry.get(record.appId, record.appVersion);
    const executor = this.executorFor(app.plan.runtimeBundleDigest);
    if (!executor) throw new PlatformError('EXECUTOR_UNAVAILABLE', app.plan.runtimeBundleDigest);
    if (app.state !== 'ACTIVE')
      throw new PlatformError('APP_RELEASE_NOT_ACTIVE', `${record.appId}@${record.appVersion}`);
    if (record.model) {
      const catalog = this.store.modelCatalogGet();
      if (!catalog) throw new PlatformError('MODEL_CATALOG_UNAVAILABLE');
      if (catalog.runtimeBundleDigest !== record.model.runtimeBundleDigest) {
        throw new PlatformError('MODEL_CATALOG_RUNTIME_MISMATCH');
      }
      // Revalidate availability, never silently refresh the frozen route/options.
      retrySnapshot(catalog, record.model);
      const entry = findCatalogEntry(catalog, record.model.selectionId);
      if (entry) this.requireHealthy(entry);
    }
    const inputs = this.runs.allInputs(runId);
    // Persist the launch intent BEFORE spawning so a crash between spawn and binding is reconcilable.
    const launchId = `worker-${runId}-${randomUUID()}`;
    const fencingToken = record.snapshot.fencingToken + 1;
    this.store.attemptInsert({
      launchId,
      runId,
      fencingToken,
      state: 'STARTING',
      startedAt: new Date().toISOString(),
      leaseOwner: principal.actorId,
      leaseExpiresAt: new Date(Date.now() + LAUNCH_LEASE_TTL_MS).toISOString(),
    });
    metrics.counter('platform_run_dispatch_started', { appId: record.appId });
    let launch;
    try {
      launch = await executor.dispatch({
        run: record,
        plan: app.plan,
        inputs,
        model: record.model,
        launchId,
        fencingToken,
        onUserQuestion: (request, context) => this.awaitQuestion(runId, request, context),
        onStarted: () => this.markStarted(runId, launchId, fencingToken),
        onActivity: (activity) => this.recordActivity(runId, activity),
      });
    } catch (error) {
      this.store.attemptUpdate(launchId, 'FAILED', error instanceof Error ? error.message.slice(0, 500) : 'UNKNOWN');
      this.store.attemptClearLease(launchId);
      metrics.counter('platform_run_dispatch_failed', {
        code: error instanceof PlatformError || error instanceof RunError ? error.code : 'UNKNOWN',
      });
      throw error;
    }
    if (launch.process) this.store.attemptSetProcess(launchId, launch.process);
    let bound: RunRecord;
    try {
      bound = this.runs.apply(
        runId,
        { type: 'dispatch', launchId: launch.launchId, fencingToken: launch.fencingToken },
        expectedRevision,
        whichService(principal),
      );
    } catch (error) {
      await executor.cancel(launch.launchId);
      this.store.attemptUpdate(launchId, 'FAILED', 'DISPATCH_BINDING_FAILED');
      throw error;
    }
    // Record the exact input prefix this dispatch carried; consumption evidence is scoped to it.
    this.runs.markDispatchedThrough(runId, inputs.at(-1)?.sequence ?? 0);
    if (launch.outcome) {
      void this.observeOutcome(runId, launch.launchId, launch.fencingToken, launch.outcome).catch((error: unknown) => {
        if (this.closed) return;
        this.store.audit('service:platform-control', 'RUN_OUTCOME_OBSERVER_FAILED', runId, {
          error: error instanceof Error ? error.message.slice(0, 2000) : 'UNKNOWN',
        });
      });
    }
    return bound;
  }
  /** Supervisor-only: one bounded scheduling turn over queued runs. Failures leave the run queued. */
  async dispatchQueued(limit: number, principal: Principal): Promise<RunRecord[]> {
    this.policy.authorize(principal, 'run.dispatch');
    if (!this.executor && this.executorsByDigest.size === 0) throw new PlatformError('EXECUTOR_NOT_CONFIGURED');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new PlatformError('RUN_BATCH_INVALID');
    const queued = this.store
      .queuedRuns(100)
      .filter((run) => !run.snapshot.cancelRequested)
      .slice(0, limit);
    const dispatched: RunRecord[] = [];
    for (const run of queued) {
      try {
        dispatched.push(await this.dispatchRun(run.runId, run.snapshot.revision, principal));
      } catch (error) {
        this.store.audit(principal.actorId, 'RUN_DISPATCH_DEFERRED', run.runId, {
          error: error instanceof Error ? error.message.slice(0, 2000) : 'UNKNOWN',
        });
      }
    }
    return dispatched;
  }
  /**
   * Reconcile launches whose supervision lease expired. An expired lease means nobody currently
   * proves the worker is alive; the run becomes UNKNOWN (never FAILED, never restarted blindly).
   * A deployment that later proves exit may reconcile the UNKNOWN and retry as a new run.
   */
  reconcileExpiredLaunches(principal: Principal, now = new Date()): { reconciled: number } {
    this.policy.authorize(principal, 'run.fail');
    let reconciled = 0;
    for (const attempt of this.store.expiredAttempts(now.toISOString())) {
      let run: RunRecord;
      try {
        run = this.runs.get(attempt.runId);
      } catch {
        this.store.attemptUpdate(attempt.launchId, 'UNKNOWN', 'RUN_NOT_FOUND');
        this.store.attemptClearLease(attempt.launchId);
        continue;
      }
      if (run.snapshot.state !== 'STARTING' && run.snapshot.state !== 'RUNNING') continue;
      if (run.snapshot.launchId !== attempt.launchId) continue;
      try {
        this.runs.apply(
          run.runId,
          { type: 'unknown', reason: 'LAUNCH_LEASE_EXPIRED' },
          run.snapshot.revision,
          principal.actorId,
        );
        this.store.attemptUpdateOpenByRun(run.runId, 'UNKNOWN', 'LAUNCH_LEASE_EXPIRED');
        reconciled++;
        metrics.counter('platform_launch_lease_expired');
        logger.warn('launch.lease_expired', { runId: run.runId, launchId: attempt.launchId });
      } catch {
        // A concurrent transition owns the run; leave it for its supervisor.
      } finally {
        this.store.attemptClearLease(attempt.launchId);
      }
    }
    return { reconciled };
  }
  /** Startup reconciliation: active runs from a previous control process have unknown worker state.
   *  Fail them rather than reporting success; a deployment that proves the worker is gone may retry as a new run. */
  reconcileOrphans(principal: Principal): { failed: number } {
    this.policy.authorize(principal, 'run.fail');
    const all: RunRecord[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = this.runs.list(undefined, offset, 100);
      all.push(...page.items);
      if (page.items.length < 100) break;
    }
    let failed = 0;
    for (const run of all) {
      if (run.snapshot.state !== 'STARTING' && run.snapshot.state !== 'RUNNING') continue;
      try {
        this.runs.apply(
          run.runId,
          { type: 'unknown', reason: 'HOST_RESTARTED_RECONCILIATION_REQUIRED' },
          run.snapshot.revision,
          principal.actorId,
        );
        this.store.attemptUpdateOpenByRun(run.runId, 'UNKNOWN', 'HOST_RESTARTED_RECONCILIATION_REQUIRED');
        if (run.snapshot.launchId) this.store.attemptClearLease(run.snapshot.launchId);
        failed++;
      } catch {
        // A concurrent transition owns the run; leave it for its supervisor.
      }
    }
    return { failed };
  }
  started(runId: string, expectedRevision: number, principal: Principal): RunRecord {
    return this.supervisorEvent(runId, { type: 'started' }, expectedRevision, principal, 'run.started');
  }
  setBarrier(
    runId: string,
    barrier: RunSnapshot['barrier'],
    expectedRevision: number,
    principal: Principal,
  ): RunRecord {
    return this.supervisorEvent(runId, { type: 'barrier', barrier }, expectedRevision, principal, 'run.barrier');
  }
  finish(runId: string, expectedRevision: number, principal: Principal): RunRecord {
    return this.supervisorEvent(runId, { type: 'finish' }, expectedRevision, principal, 'run.finish');
  }
  fail(runId: string, expectedRevision: number, reason: string, principal: Principal): RunRecord {
    return this.supervisorEvent(runId, { type: 'fail', reason }, expectedRevision, principal, 'run.fail');
  }
  status(): ControlStatus {
    const apps = this.registry.list();
    const counts = this.store.runCounts();
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const approvals = this.store.approvalList();
    return {
      apps: {
        active: apps.filter((app) => app.state === 'ACTIVE').length,
        revoked: apps.filter((app) => app.state === 'REVOKED').length,
      },
      runs: {
        total,
        queued: counts.QUEUED ?? 0,
        running: (counts.STARTING ?? 0) + (counts.RUNNING ?? 0),
        terminal:
          (counts.SUCCEEDED ?? 0) +
          (counts.FAILED ?? 0) +
          (counts.CANCELLED ?? 0) +
          (counts.UNKNOWN ?? 0),
      },
      executor:
        this.executor?.kind ??
        (this.executorsByDigest.size > 0 ? `${this.executorsByDigest.size} bundle executor(s)` : 'not-configured'),
      artifacts: this.store.artifactCount(),
      auditEntries: this.store.auditList(0, 1).total,
      outbox: this.store.outboxCounts(),
      approvals: {
        active: approvals.filter((approval) => approval.state === 'ACTIVE').length,
        revoked: approvals.filter((approval) => approval.state === 'REVOKED').length,
      },
    };
  }
  /** Honest storage/recovery topology (E0d): where the control plane persists, what the backup
   *  tooling covers — and, just as important, what it does not. The knowledge store and the
   *  native DSH session homes live outside this control plane's backup scope, and recovery
   *  restrictions are not persisted as markers today; both facts are stated, never implied. */
  storageFacts(principal: Principal) {
    this.policy.authorize(principal, 'metrics.read');
    return {
      controlStorePath: this.store.location,
      backupCoverage: {
        controlStore: true as const,
        sealedArtifacts: true as const,
        knowledgeStore: false as const,
        nativeSessionHomes: false as const,
      },
      recoveryRestrictionMarkers: false as const,
    };
  }
  /** Resolve a run's model route from the catalog, in explicit choice > saved preference >
   *  deployment default order. Every step is validated server-side; nothing is silently swapped. */
  private resolveRunModel(
    runtimeBundleDigest: string,
    principal: Principal,
    options: { modelSelectionId?: string; modelOptions?: unknown },
  ): ModelConfigSnapshot | null {
    const catalog = this.store.modelCatalogGet();
    let selectionId: string | undefined;
    let source: ModelSelectionSource = 'catalog-default';
    if (options.modelSelectionId !== undefined) {
      if (typeof options.modelSelectionId !== 'string' || !options.modelSelectionId) {
        throw new PlatformError('MODEL_SELECTION_UNKNOWN', String(options.modelSelectionId));
      }
      selectionId = options.modelSelectionId;
      source = 'explicit';
    } else {
      const preference = this.store.modelPreferenceGet(principal.actorId);
      if (preference) {
        selectionId = preference.selectionId;
        source = 'preference';
      } else if (catalog?.defaultSelectionId) {
        selectionId = catalog.defaultSelectionId;
        source = 'catalog-default';
      }
    }
    if (selectionId === undefined) {
      // A deployment with a catalog must not start a run on an unrecorded route.
      if (catalog) throw new PlatformError('MODEL_SELECTION_REQUIRED');
      return null;
    }
    if (!catalog) throw new PlatformError('MODEL_CATALOG_UNAVAILABLE');
    if (catalog.runtimeBundleDigest !== runtimeBundleDigest) {
      throw new PlatformError('MODEL_CATALOG_RUNTIME_MISMATCH');
    }
    this.requireModelVisible(principal, selectionId);
    let entry;
    try {
      entry = requireAvailableEntry(catalog, selectionId);
    } catch (error) {
      if (source === 'preference' && error instanceof PlatformError) {
        throw new PlatformError('MODEL_PREFERENCE_UNAVAILABLE', `${error.code}:${selectionId}`);
      }
      throw error;
    }
    this.requireHealthy(entry);
    // E2-4: when the deployment requires it, the resolved route must carry an ACTIVE approval —
    // whichever way the route was picked. Nothing is silently swapped to an approved model.
    this.requireModelApprovalFor(selectionId);
    // Run-level options override the catalog entry's declared defaults per key; a run that
    // passes none inherits them wholesale. The catalog stays the only option authority.
    const runOptions = options.modelOptions === undefined || options.modelOptions === null
      ? {}
      : options.modelOptions as Record<string, unknown>;
    const merged = { ...(entry.modelOptions ?? {}), ...runOptions };
    const normalized = normalizeSelectionOptions(entry, merged);
    return snapshotSelection(catalog, entry, normalized, source);
  }
  private configuredModels(runtimeBundleDigest: string): ModelCatalogRecord | null {
    const catalog = this.store.modelCatalogGet();
    return catalog?.runtimeBundleDigest === runtimeBundleDigest ? catalog : null;
  }
  private availableForApp(app: AppRecord, principal: Principal) {
    const catalog = this.configuredModels(app.plan.runtimeBundleDigest);
    return catalog ? {
      catalog,
      entries: catalog.entries.filter((entry) => {
        try {
          this.policy.authorize(principal, 'model.read', { modelSelectionId: entry.selectionId });
          return true;
        } catch (error) {
          if (error instanceof AuthorizationError) return false;
          throw error;
        }
      }),
    } : { catalog: null, entries: [] };
  }
  /** The worker runtime is starting; leave STARTING before any model request finishes. */
  private markStarted(runId: string, launchId: string, fencingToken: number): void {
    if (this.closed) return;
    try {
      const current = this.runs.get(runId);
      if (current.snapshot.state !== 'STARTING' ||
          current.snapshot.launchId !== launchId ||
          current.snapshot.fencingToken !== fencingToken) return;
      this.runs.apply(runId, { type: 'started' }, current.snapshot.revision, 'service:worker');
    } catch (error) {
      this.store.audit('service:platform-control', 'RUN_STARTED_NOT_APPLIED', runId, {
        error: error instanceof Error ? error.message.slice(0, 500) : 'UNKNOWN',
      });
    }
  }
  /** Live assistant text, deduplicated; the final result still binds to the settled outcome. */
  private recordActivity(runId: string, activity: NonNullable<RunOutcome['activities']>[number]): void {
    if (this.closed) return;
    try {
      const current = this.runs.get(runId);
      // Visible model activity is the honest "running" signal, not the dispatch call itself.
      if (current.snapshot.state === 'STARTING') {
        this.runs.apply(runId, { type: 'started' }, current.snapshot.revision, 'service:worker');
      }
    } catch {
      // A stale projection must not drop the activity below.
    }
    const seen = this.conversationActivities.get(runId) ?? [];
    if (seen.some((item) =>
      item.text === activity.text &&
      item.kind === activity.kind &&
      (item.seq === undefined || activity.seq === undefined || item.seq === activity.seq))) return;
    this.conversationActivities.set(runId, [...seen, activity].slice(-200));
    // Same dedupe above guards the live feed: a cursor-tagged copy is appended once and pushed to
    // every open stream, so the UI never needs to poll the run to see new activity.
    const cursor = (this.activityCursor.get(runId) ?? 0) + 1;
    this.activityCursor.set(runId, cursor);
    this.activityLog.set(runId, [...(this.activityLog.get(runId) ?? []), { cursor, activity }].slice(-200));
    for (const waiter of this.activityWaiters.get(runId) ?? []) {
      try {
        waiter({ cursor, activity });
      } catch {
        // A broken stream must not stop activity recording for the run.
      }
    }
  }

  /** Replay activities after `after`, then stream new ones. Authorized on subscribe and per push. */
  activityStream(
    runId: string,
    after: number,
    principal: Principal,
    deliver: (entry: { cursor: number; activity: RunActivity }) => void,
  ): () => void {
    this.getRun(runId, principal);
    for (const entry of this.activityLog.get(runId) ?? []) {
      if (entry.cursor > after) deliver(entry);
    }
    const guarded = (entry: { cursor: number; activity: RunActivity }): void => {
      // Re-authorize on every push: a stream must not outlive the caller's right to read the run.
      this.getRun(runId, principal);
      deliver(entry);
    };
    const waiters = this.activityWaiters.get(runId) ?? new Set();
    waiters.add(guarded);
    this.activityWaiters.set(runId, waiters);
    return () => {
      const current = this.activityWaiters.get(runId);
      current?.delete(guarded);
      if (current && current.size === 0) this.activityWaiters.delete(runId);
    };
  }
  private async observeOutcome(runId: string, launchId: string, fencingToken: number, promise: Promise<RunOutcome>): Promise<void> {
    try {
      await this.observeOutcomeInternal(runId, launchId, fencingToken, promise);
    } finally {
      // Any terminal outcome ends the run's right to keep asking questions.
      if (!this.closed) {
        try {
          const record = this.runs.get(runId);
          if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(record.snapshot.state)) {
            this.settleInteractions(runId);
            this.captureKnowledge(record);
          }
        } catch {
          // The run was removed; nothing left to settle.
        }
      }
    }
  }
  /** Terminal run facts are captured DURABLY: the outbox row is the dedup truth ((kind,eventId)),
   *  delivery happens via drainKnowledgeCaptureOutbox — a consumer crash loses nothing (T04) and
   *  a sink failure never changes the run or the review decision. */
  private captureKnowledge(run: RunRecord): void {
    const state = run.snapshot.state;
    const kind: KnowledgeCaptureEvent['kind'] | null =
      state === 'SUCCEEDED' ? 'run.succeeded'
        : state === 'FAILED' ? 'run.failed'
          : state === 'UNKNOWN' ? 'run.unknown'
            : state === 'CANCELLED' ? 'run.cancelled'
              : null;
    if (!kind) return;
    const event: KnowledgeCaptureEvent = {
      kind,
      runId: run.runId,
      workId: run.workId,
      appId: run.appId,
      appVersion: run.appVersion,
      ...(run.workspace?.projectId ? { projectId: run.workspace.projectId } : {}),
      ...(run.knowledge?.pluginId ? { pluginId: run.knowledge.pluginId } : {}),
      inputDigest: run.inputDigest,
      artifactDigests: this.store.artifacts(run.runId).map((artifact) => artifact.digest),
      ...(run.snapshot.reason ? { reason: run.snapshot.reason } : {}),
      at: new Date().toISOString(),
    };
    this.enqueueKnowledge(event);
  }
  /** M2-02：复核决定（QC）是可信事件。它投影为待分析事实、不直接产生候选，也不改写 Run 状态。 */
  private captureReviewDecision(run: RunRecord, review: ReviewRecord): void {
    const event: KnowledgeCaptureEvent = {
      kind: 'qc.completed',
      runId: run.runId,
      workId: run.workId,
      appId: run.appId,
      appVersion: run.appVersion,
      ...(run.workspace?.projectId ? { projectId: run.workspace.projectId } : {}),
      ...(run.knowledge?.pluginId ? { pluginId: run.knowledge.pluginId } : {}),
      inputDigest: run.inputDigest,
      artifactDigests: this.store.artifacts(run.runId).map((artifact) => artifact.digest),
      review: {
        reviewId: review.reviewId,
        decision: review.state === 'APPROVED' ? 'APPROVED' : 'REJECTED',
        ...(review.note ? { note: review.note } : {}),
      },
      at: new Date().toISOString(),
    };
    this.enqueueKnowledge(event);
  }
  /** T04：先持久入队（消费崩溃不丢失）。幂等键 (kind,eventId)：run 终态用 runId，复核决定用 review:<id>，
   *  与知识投影合同一致；重复投递由知识服务按同一键去重，业务 Run 状态不受影响。 */
  private enqueueKnowledge(event: KnowledgeCaptureEvent): void {
    if (this.closed) return;
    const eventId = event.kind === 'qc.completed' && event.review ? `review:${event.review.reviewId}` : event.runId;
    this.store.knowledgeOutboxEnqueue(event.kind, eventId, event, new Date().toISOString());
  }
  /** T04 泵：把 outbox 中的可信观测投递给知识捕获 sink。RETRY_REQUIRED（知识服务显式要求重试）
   *  与 sink 抛错按退避重试；超预算死信并审计。未配置 sink 时如实返回零投递，不丢弃事件。 */
  async drainKnowledgeCaptureOutbox(
    options: { limit?: number; now?: Date } = {},
  ): Promise<{ claimed: number; done: number; retried: number; dead: number }> {
    if (!this.knowledgeCaptureSink) return { claimed: 0, done: 0, retried: 0, dead: 0 };
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
    const now = options.now ?? new Date();
    const claimed = this.store.knowledgeOutboxClaim(now.toISOString(), limit, KNOWLEDGE_OUTBOX_CLAIM_TTL_MS);
    const result = { claimed: claimed.length, done: 0, retried: 0, dead: 0 };
    for (const message of claimed) {
      const event = message.payload as KnowledgeCaptureEvent;
      try {
        const outcome = await Promise.resolve(this.knowledgeCaptureSink(event));
        const code =
          outcome && typeof outcome === 'object' && 'outcome' in outcome ? String((outcome as { outcome?: unknown }).outcome) : 'DELIVERED';
        if (code === 'RETRY_REQUIRED') throw new PlatformError('KNOWLEDGE_PROJECTION_RETRY_REQUIRED');
        this.store.knowledgeOutboxComplete(message.messageId);
        result.done++;
      } catch (error) {
        const reason = `${error instanceof PlatformError ? error.code : 'KNOWLEDGE_DELIVERY_FAILED'}: ${
          error instanceof Error ? error.message.slice(0, 500) : 'UNKNOWN'
        }`;
        if (message.attempts >= KNOWLEDGE_OUTBOX_MAX_ATTEMPTS) {
          this.store.knowledgeOutboxDeadLetter(message.messageId, reason);
          this.store.audit('service:platform-control', 'KNOWLEDGE_CAPTURE_DEAD_LETTERED', event.runId ?? message.eventId, {
            messageId: message.messageId,
            kind: message.kind,
            attempts: message.attempts,
          });
          result.dead++;
          continue;
        }
        const delay = Math.min(KNOWLEDGE_OUTBOX_RETRY_MAX_MS, KNOWLEDGE_OUTBOX_RETRY_BASE_MS * 2 ** (message.attempts - 1));
        this.store.knowledgeOutboxRetry(message.messageId, reason, new Date(now.getTime() + delay).toISOString());
        result.retried++;
      }
    }
    return result;
  }
  /** 人工重放死信（§5：持久游标、有限重试、死信与人工重放）；证据保留，不删 last_error。 */
  replayKnowledgeCaptureDeadLetters(options: { now?: Date } = {}): { replayed: number } {
    if (this.closed) return { replayed: 0 };
    return { replayed: this.store.knowledgeOutboxReplayDead((options.now ?? new Date()).toISOString()) };
  }
  knowledgeCaptureOutboxStatus(): Record<string, number> {
    return this.store.knowledgeOutboxCounts();
  }
  private async observeOutcomeInternal(runId: string, launchId: string, fencingToken: number, promise: Promise<RunOutcome>): Promise<void> {
    let outcome: RunOutcome;
    try {
      outcome = await promise;
    } catch (error) {
      outcome = { status: 'failed', error: error instanceof Error ? error.message : 'UNKNOWN' };
    }
    if (this.closed) return;
    const actor = 'service:worker';
    const current = this.runs.get(runId);
    if (current.snapshot.launchId !== launchId || current.snapshot.fencingToken !== fencingToken) {
      this.store.audit(actor, 'RUN_STALE_OUTCOME_REJECTED', runId, { launchId, fencingToken });
      return;
    }
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(current.snapshot.state)) return;
    if (outcome.exitProven !== true) {
      // No proof the worker process exited: the outcome is unknown, not a retryable failure.
      this.runs.apply(
        runId,
        { type: 'unknown', reason: `WORKER_EXIT_UNPROVEN:${outcome.error ?? ''}`.slice(0, 2000) },
        current.snapshot.revision,
        actor,
      );
      return;
    }
    if (current.model) {
      const selections = outcome.modelSelections ?? [];
      this.store.audit(actor, 'RUN_MODEL_SELECTION_EVIDENCE', runId, {
        launchId: current.snapshot.launchId, fencingToken: current.snapshot.fencingToken,
        selectionId: current.model.selectionId, selections,
        observed: selections.length > 0,
      });
      if (outcome.status === 'succeeded' && selections.length === 0) {
        this.runs.apply(runId, { type: 'unknown', reason: 'WORKER_MODEL_SELECTION_UNOBSERVED' }, current.snapshot.revision, actor);
        return;
      }
      if (selections.some((selection) => selection.provider !== current.model!.provider ||
          selection.model !== current.model!.model || selection.reasoningEffort !== current.model!.options.reasoningEffort)) {
        this.runs.apply(runId, { type: 'fail', reason: 'WORKER_MODEL_SELECTION_MISMATCH' }, current.snapshot.revision, actor);
        return;
      }
    }
    if (current.snapshot.cancelRequested) {
      if (current.snapshot.state === 'STARTING' || current.snapshot.state === 'RUNNING') {
        this.runs.apply(runId, { type: 'cancel-settled' }, current.snapshot.revision, actor);
      }
      return;
    }
    if (outcome.status === 'cancelled') {
      this.runs.apply(
        runId,
        { type: 'fail', reason: 'WORKER_CANCELLED_WITHOUT_REQUEST' },
        current.snapshot.revision,
        actor,
      );
      return;
    }
    if (outcome.status === 'failed') {
      this.runs.apply(
        runId,
        { type: 'fail', reason: (outcome.error || 'WORKER_FAILED').slice(0, 2000) },
        current.snapshot.revision,
        actor,
      );
      return;
    }
    if (outcome.finishReason !== 'completed') {
      this.runs.apply(
        runId,
        { type: 'fail', reason: `WORKER_FINISH_${String(outcome.finishReason).toUpperCase()}`.slice(0, 2000) },
        current.snapshot.revision,
        actor,
      );
      return;
    }
    let latest = current;
    if (latest.snapshot.state === 'STARTING') {
      latest = this.runs.apply(runId, { type: 'started' }, latest.snapshot.revision, actor);
    }
    if (latest.snapshot.state !== 'RUNNING') return;
    if (outcome.finalResponse) {
      this.store.runSetResult(runId, {
        finalResponse: outcome.finalResponse.slice(0, 20_000),
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
        at: new Date().toISOString(),
      });
    }
    if (outcome.activities?.length) {
      for (const activity of outcome.activities) this.recordActivity(runId, activity);
    }
    // A returned SDK turn alone proves neither admission nor claim of the dispatched prompt.
    const dispatchedThrough = latest.dispatchedThrough ?? 0;
    if (outcome.consumedThrough === dispatchedThrough && dispatchedThrough > 0) {
      this.runs.consumeThrough(runId, dispatchedThrough, actor);
    }
    const inputsSettled = this.runs.inputsSettled(runId);
    let artifacts: ArtifactRecord[];
    try {
      artifacts = await this.recordArtifacts(runId, outcome.artifacts ?? []);
    } catch (error) {
      const detail = error instanceof PlatformError
        ? `${error.code}:${error.message}`
        : error instanceof Error
          ? error.message
          : 'UNKNOWN';
      this.runs.apply(
        runId,
        {
          type: 'fail',
          reason: `WORKER_RESULT_INVALID:${detail.slice(0, 1800)}`,
        },
        latest.snapshot.revision,
        actor,
      );
      return;
    }
    // Findings carry the app's stable business keys; a malformed contribution fails the run the
    // same way a malformed artifact does — the platform never silently drops declared facts.
    try {
      this.store.findingsReplace(runId, validateFindings(outcome.findings ?? []));
    } catch (error) {
      const detail = error instanceof PlatformError
        ? `${error.code}:${error.message}`
        : error instanceof Error
          ? error.message
          : 'UNKNOWN';
      this.runs.apply(
        runId,
        { type: 'fail', reason: `WORKER_FINDINGS_INVALID:${detail.slice(0, 1800)}` },
        latest.snapshot.revision,
        actor,
      );
      return;
    }
    // Delivery requires a sealed copy; metadata alone is not a deliverable artifact.
    const artifactsRegistered = artifacts.length > 0
      ? artifacts.every((artifact) => typeof artifact.sealedAt === 'string' && artifact.sealedPath)
      : !this.requireArtifacts;
    const barrier = {
      inputsSettled,
      descendantsDone: outcome.descendantsDone === true,
      artifactsRegistered,
      cleanedUp: outcome.cleanedUp === true,
    };
    latest = this.runs.apply(runId, { type: 'barrier', barrier }, latest.snapshot.revision, actor);
    if (Object.values(barrier).every(Boolean)) {
      this.runs.apply(runId, { type: 'finish' }, latest.snapshot.revision, actor);
      return;
    }
    const missing = Object.entries(barrier)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    this.runs.apply(
      runId,
      { type: 'unknown', reason: `COMPLETION_FACTS_INCOMPLETE:${missing.join(',')}`.slice(0, 2000) },
      latest.snapshot.revision,
      actor,
    );
    this.store.audit(actor, 'RUN_AWAITING_COMPLETION_FACTS', runId, {
      missing,
      finalResponse: outcome.finalResponse?.slice(0, 2000) ?? null,
      sessionId: outcome.sessionId ?? null,
    });
  }
  private async awaitQuestion(
    runId: string,
    request: UserQuestionRequest,
    context: { signal: AbortSignal },
  ): Promise<UserQuestionResult> {
    if (
      !request ||
      typeof request.requestId !== 'string' ||
      !request.requestId ||
      typeof request.sessionId !== 'string' ||
      !request.sessionId
    ) {
      throw new PlatformError('RUN_QUESTION_INVALID');
    }
    const questions = this.normalizeQuestionRequest(request.questions);
    const interactionId = randomUUID();
    try {
      this.store.interactionInsert({
        interactionId,
        runId,
        sessionId: request.sessionId,
        requestId: request.requestId,
        kind: 'user-question',
        body: { questions },
        state: 'PENDING',
        createdAt: new Date().toISOString(),
      });
    } catch {
      throw new PlatformError('RUN_QUESTION_DUPLICATE', request.requestId);
    }
    this.store.audit('service:worker', 'RUN_QUESTION_ASKED', runId, {
      interactionId,
      requestId: request.requestId,
      sessionId: request.sessionId,
      questions: questions.length,
    });
    return new Promise<UserQuestionResult>((resolveResult) => {
      let settled = false;
      const finish = (result: UserQuestionResult): void => {
        if (settled) return;
        settled = true;
        this.interactionWaiters.delete(interactionId);
        const cancelled = 'cancelled' in result && result.cancelled === true;
        try {
          this.store.interactionResolve(
            interactionId,
            cancelled ? 'CANCELLED' : 'ANSWERED',
            cancelled ? null : result,
          );
        } catch {
          // Persistence failure must not leave the SDK waiting forever.
        }
        resolveResult(result);
      };
      this.interactionWaiters.set(interactionId, finish);
      if (context.signal.aborted) finish({ cancelled: true });
      else context.signal.addEventListener('abort', () => finish({ cancelled: true }), { once: true });
    });
  }
  private normalizeQuestionRequest(questions: unknown): UserQuestionItem[] {
    if (!Array.isArray(questions) || questions.length === 0 || questions.length > 20) {
      throw new PlatformError('RUN_QUESTION_INVALID', 'questions');
    }
    const ids = new Set<string>();
    return questions.map((item) => {
      const value = item as Record<string, unknown> | null;
      if (!value || typeof value !== 'object') throw new PlatformError('RUN_QUESTION_INVALID', 'question');
      const id = typeof value.id === 'string' ? value.id : '';
      if (!id || id.length > 200 || ids.has(id)) throw new PlatformError('RUN_QUESTION_INVALID', 'question id');
      ids.add(id);
      if (typeof value.question !== 'string' || !value.question || value.question.length > 4000) {
        throw new PlatformError('RUN_QUESTION_INVALID', 'question text');
      }
      const options = Array.isArray(value.options)
        ? value.options.slice(0, 20).map((option) => {
            const entry = option as Record<string, unknown> | null;
            if (!entry || typeof entry.label !== 'string' || !entry.label || entry.label.length > 500) {
              throw new PlatformError('RUN_QUESTION_INVALID', 'option');
            }
            return {
              label: entry.label,
              ...(typeof entry.description === 'string' && entry.description.length <= 1000
                ? { description: entry.description }
                : {}),
            };
          })
        : undefined;
      return {
        id: id,
        question: value.question,
        ...(typeof value.header === 'string' && value.header.length <= 200 ? { header: value.header } : {}),
        ...(typeof value.detail === 'string' && value.detail.length <= 8000 ? { detail: value.detail } : {}),
        ...(options ? { options } : {}),
        ...(value.multiSelect === true ? { multiSelect: true } : {}),
      };
    });
  }
  private normalizeAnswer(record: InteractionRecord, answer: unknown): { answers: Array<{ id: string; selected: string[]; custom?: string }> } {
    const value = answer as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || !Array.isArray(value.answers)) {
      throw new PlatformError('INTERACTION_ANSWER_INVALID', 'answers');
    }
    const questions = (record.body as { questions: UserQuestionItem[] }).questions;
    const byId = new Map(questions.map((question) => [question.id, question]));
    const seen = new Set<string>();
    if (value.answers.length !== questions.length) throw new PlatformError('INTERACTION_ANSWER_INVALID', 'count');
    const normalized = value.answers.map((entry) => {
      const item = entry as Record<string, unknown> | null;
      const id = item && typeof item.id === 'string' ? item.id : '';
      const question = byId.get(id);
      if (!item || !question || seen.has(id)) throw new PlatformError('INTERACTION_ANSWER_INVALID', 'id');
      seen.add(id);
      const selected = Array.isArray(item.selected) ? item.selected : null;
      if (!selected || selected.length > 20 || selected.some((label) => typeof label !== 'string' || label.length > 500)) {
        throw new PlatformError('INTERACTION_ANSWER_INVALID', 'selected');
      }
      if (question.multiSelect !== true && selected.length > 1) {
        throw new PlatformError('INTERACTION_ANSWER_INVALID', 'multi-select');
      }
      const allowed = new Set((question.options ?? []).map((option) => option.label));
      if (allowed.size && selected.some((label) => !allowed.has(label as string))) {
        throw new PlatformError('INTERACTION_ANSWER_INVALID', 'unknown option');
      }
      const custom = typeof item.custom === 'string' ? item.custom.trim() : '';
      if (custom.length > 4000) throw new PlatformError('INTERACTION_ANSWER_INVALID', 'custom');
      if (!selected.length && !custom) throw new PlatformError('INTERACTION_ANSWER_INVALID', 'empty answer');
      return {
        id,
        selected: selected as string[],
        ...(custom ? { custom } : {}),
      };
    });
    return { answers: normalized };
  }
  /** Dismiss pending questions when the run stops waiting; persistence reflects it, not just memory. */
  private settleInteractions(runId: string, state: InteractionState = 'EXPIRED'): void {
    for (const record of this.store.interactionsForRun(runId)) {
      if (record.state !== 'PENDING') continue;
      this.store.interactionResolve(record.interactionId, state, null);
      this.interactionWaiters.get(record.interactionId)?.({ cancelled: true });
    }
  }
  private async recordArtifacts(runId: string, artifacts: RunArtifact[]): Promise<ArtifactRecord[]> {
    if (!Array.isArray(artifacts) || artifacts.length > 100) throw new PlatformError('RUN_ARTIFACTS_INVALID');
    const seen = new Set<string>();
    const prepared: ArtifactRecord[] = [];
    let totalBytes = 0;
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== 'object') throw new PlatformError('RUN_ARTIFACTS_INVALID');
      if (
        typeof artifact.name !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(artifact.name) ||
        artifact.name.split('/').includes('..')
      ) {
        throw new PlatformError('RUN_ARTIFACTS_INVALID', 'name');
      }
      if (typeof artifact.digest !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.digest)) {
        throw new PlatformError('RUN_ARTIFACTS_INVALID', 'digest');
      }
      if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) {
        throw new PlatformError('RUN_ARTIFACTS_INVALID', 'bytes');
      }
      if (
        artifact.mediaType !== undefined &&
        (typeof artifact.mediaType !== 'string' || artifact.mediaType.length > 200)
      ) {
        throw new PlatformError('RUN_ARTIFACTS_INVALID', 'mediaType');
      }
      if (seen.has(artifact.name)) throw new PlatformError('RUN_ARTIFACTS_INVALID', 'duplicate name');
      seen.add(artifact.name);
      totalBytes += artifact.bytes;
      if (artifact.bytes > MAX_SEALED_BYTES || totalBytes > MAX_SEALED_TOTAL_BYTES) {
        throw new PlatformError('RUN_ARTIFACTS_INVALID', 'too large');
      }
      // Seal before recording: a control-plane copy the worker can no longer change.
      const sealed = await this.sealArtifact(runId, artifact);
      prepared.push({
        name: artifact.name,
        digest: artifact.digest,
        bytes: artifact.bytes,
        ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
        ...sealed,
        createdAt: new Date().toISOString(),
      });
    }
    return this.store.transaction(() => {
      for (const artifact of prepared) {
        try {
          this.store.artifactInsert(runId, artifact);
        } catch {
          throw new PlatformError('RUN_ARTIFACT_CONFLICT', artifact.name);
        }
        this.store.audit('service:worker', 'RUN_ARTIFACT_REGISTERED', runId, {
          name: artifact.name,
          digest: artifact.digest,
          bytes: artifact.bytes,
          sealed: Boolean(artifact.sealedAt),
        });
      }
      return this.store.artifacts(runId);
    });
  }
  /** Copy verified bytes into the control-owned seal directory; nothing is recorded until it succeeds. */
  private async sealArtifact(
    runId: string,
    artifact: RunArtifact,
  ): Promise<{ sealedPath: string; sealedAt: string }> {
    if (typeof artifact.sourcePath !== 'string' || !isAbsolute(artifact.sourcePath)) {
      throw new PlatformError('RUN_ARTIFACT_SOURCE_INVALID');
    }
    let real: string;
    try {
      real = await realpath(artifact.sourcePath);
      if (!(await stat(real)).isFile()) throw new Error('not a file');
    } catch {
      throw new PlatformError('RUN_ARTIFACT_SOURCE_MISSING', artifact.name);
    }
    const data = await readFile(real);
    if (data.byteLength !== artifact.bytes) throw new PlatformError('RUN_ARTIFACT_DIGEST_MISMATCH', 'bytes');
    if (createHash('sha256').update(data).digest('hex') !== artifact.digest) {
      throw new PlatformError('RUN_ARTIFACT_DIGEST_MISMATCH', 'digest');
    }
    const sealedPath = join(runId, artifact.name);
    const target = join(this.sealRoot, sealedPath);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${randomUUID()}`;
    await writeFile(temporary, data);
    await rename(temporary, target);
    return { sealedPath, sealedAt: new Date().toISOString() };
  }
  /** Re-authorized read of a sealed artifact; the digest is verified again at read time. */
  async readArtifact(
    runId: string,
    name: string,
    principal: Principal,
  ): Promise<{ name: string; bytes: number; mediaType?: string; data: Buffer }> {
    this.getRun(runId, principal);
    const record = this.store.artifacts(runId).find((artifact) => artifact.name === name);
    if (!record) throw new PlatformError('RUN_ARTIFACT_NOT_FOUND');
    if (!record.sealedPath) throw new PlatformError('RUN_ARTIFACT_NOT_SEALED');
    let data: Buffer;
    try {
      data = await readFile(join(this.sealRoot, record.sealedPath));
    } catch {
      throw new PlatformError('RUN_ARTIFACT_STORAGE_MISSING', record.name);
    }
    if (
      data.byteLength !== record.bytes ||
      createHash('sha256').update(data).digest('hex') !== record.digest
    ) {
      throw new PlatformError('RUN_ARTIFACT_TAMPERED', record.name);
    }
    return {
      name: record.name,
      bytes: record.bytes,
      ...(record.mediaType ? { mediaType: record.mediaType } : {}),
      data,
    };
  }
  private supervisorEvent(
    runId: string,
    event: RunEvent,
    expectedRevision: number,
    principal: Principal,
    action: 'run.started' | 'run.barrier' | 'run.finish' | 'run.fail',
  ): RunRecord {
    this.policy.authorize(principal, action);
    const result = this.runs.apply(runId, event, expectedRevision, principal.actorId);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(result.snapshot.state)) {
      this.settleInteractions(runId);
    }
    return result;
  }
}
const whichService = (principal: Principal): string =>
  principal.kind === 'service' ? principal.actorId : `service:platform-control(${principal.actorId})`;

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, (item as Record<string, unknown>)[key]]),
      );
    }
    return item;
  });
