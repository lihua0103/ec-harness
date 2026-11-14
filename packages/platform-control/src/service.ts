/** Control-plane service: application registry + persistent runs + supervisor-facing transitions.
 *  It never imports or executes application code; a worker executor is an external dependency. */
import type { ExecutionPlan } from '../../platform-runtime/src/plan.js';
import type { RunEvent, RunSnapshot } from '../../platform-runtime/src/run.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { AuthorizationError, LocalOperatorPolicy, type PlatformPolicy, type Principal } from './policy.js';
import { ApplicationRegistry, PlatformError } from './registry.js';
import { RunRepository } from './runs.js';
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
import type { ExecutionDomainRecord, ExecutionDomainState, InputBaselineRecord, WorkSessionBindingRecord } from './store.js';
import {
  findCatalogEntry,
  modelCatalogDigest,
  normalizeSelectionOptions,
  requireAvailableEntry,
  retrySnapshot,
  snapshotSelection,
  validateModelCatalog,
  type ModelCatalogRecord,
  type ModelConfigSnapshot,
  type ModelPreferenceView,
  type ModelSelectionSource,
} from './models.js';
import {
  PlatformStore,
  type AppRecord,
  type AppState,
  type AppReleaseDraft,
  type ArtifactRecord,
  type AuditEntry,
  type InputCommit,
  type InteractionRecord,
  type InteractionState,
  type RunRecord,
  type WorkRecord,
  type WorkState,
} from './store.js';

const MAX_SEALED_BYTES = 64 * 1024 * 1024;
const MAX_SEALED_TOTAL_BYTES = 256 * 1024 * 1024;

export interface RunArtifact {
  name: string;
  digest: string;
  bytes: number;
  mediaType?: string;
  /** Worker-workspace path the executor validated; the control plane seals the bytes itself. */
  sourcePath?: string;
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
}
export interface CancelResult {
  record: RunRecord;
  cancelSettled: boolean;
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
  private policy: PlatformPolicy;
  private readonly requireArtifacts: boolean;
  private executor: RunExecutor | null;
  private closed = false;
  private readonly conversationActivities = new Map<string, NonNullable<RunOutcome['activities']>>();
  private readonly conversationInputs = new Map<string, Array<{ role: 'user'; text: string; createdAt: string }>>();
  /** Live waiters for SDK user questions; persistence is the durable inbox the UI reads. */
  private readonly interactionWaiters = new Map<string, (result: UserQuestionResult) => void>();
  private readonly sealRoot: string;
  constructor(
    path: string,
    executor: RunExecutor | null = null,
    policy: PlatformPolicy = new LocalOperatorPolicy(),
    options: { requireArtifacts?: boolean } = {},
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
    this.policy = policy;
    this.executor = executor;
    this.requireArtifacts = options.requireArtifacts ?? true;
  }
  setExecutor(executor: RunExecutor): void {
    this.executor = executor;
  }
  /** Deployment seam: an enterprise identity/project-authorization plugin replaces the local policy. */
  setPolicy(policy: PlatformPolicy): void {
    this.policy = policy;
  }
  /** Persist worker process-exit evidence so cancels remain settleable across control restarts. */
  recordExitEvidence(launchId: string, proven: boolean): void {
    this.store.attemptSetExitProven(launchId, proven);
  }
  readExitEvidence(launchId: string): boolean | null {
    return this.store.attemptExitProven(launchId);
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
    this.registry.active(draft?.appId, draft?.appVersion);
    return this.works.create(draft, principal.actorId);
  }
  getWork(workId: string, principal: Principal): WorkRecord {
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'work.read', { appId: work.appId });
    return work;
  }
  listWorks(state: WorkState | undefined, offset: number, limit: number, principal: Principal): {
    items: WorkRecord[];
    total: number;
  } {
    this.policy.authorize(principal, 'work.read');
    return this.works.list(state, offset, limit);
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
    this.policy.authorize(principal, 'work.archive', { appId: work.appId });
    return this.works.archive(workId, principal.actorId);
  }
  runsForWork(workId: string, offset: number, limit: number, principal: Principal) {
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'run.read', { appId: work.appId });
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
  /** A Work run is bound to the Work's app release and obeys the single-active-run rule. */
  createWorkRun(
    workId: string,
    input: unknown,
    principal: Principal,
    options: { modelSelectionId?: string; modelOptions?: unknown } = {},
  ): RunRecord {
    const work = this.works.get(workId);
    this.policy.authorize(principal, 'run.create', { appId: work.appId });
    if (work.state !== 'ACTIVE') throw new PlatformError('WORK_ARCHIVED', workId);
    this.works.requireNoActiveRun(workId);
    const app = this.registry.active(work.appId, work.appVersion);
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
    return this.runs.create(app, input, principal.actorId, model, workId, {
      ...(workspace ? { workspace } : {}),
      context: {
        goal: work.goal ?? work.title,
        previousRuns: history.items.reverse().map((previous) => ({
          runId: previous.runId, input: previous.input, result: previous.result,
        })),
        truncated: history.total > history.items.length,
      },
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
    const updatedAt = new Date().toISOString();
    this.store.modelPreferenceSet(principal.actorId, entry.selectionId, updatedAt);
    this.store.audit(principal.actorId, 'MODEL_PREFERENCE_SET', entry.selectionId, {
      provider: entry.provider,
      model: entry.model,
      catalogDigest: catalog.catalogDigest,
    });
    return { selectionId: entry.selectionId, updatedAt, state: 'available', entry, reason: '' };
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
    this.policy.authorize(principal, 'run.input', {
      appId: record.appId,
      projectId: record.workspace?.projectId,
      workspaceId: record.workspace?.workspaceId,
      workId: record.workId ?? undefined,
    });
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
    this.policy.authorize(principal, 'run.read', {
      appId: record.appId,
      projectId: record.workspace?.projectId,
      workspaceId: record.workspace?.workspaceId,
      workId: record.workId ?? undefined,
    });
    return { ...record, activities: this.conversationActivities.get(runId) ?? [] };
  }
  listRuns(appId: string | undefined, offset: number, limit: number, principal: Principal) {
    this.policy.authorize(principal, 'run.read', appId ? { appId } : undefined);
    return this.runs.list(appId, offset, limit);
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
  }> {
    const items: Array<{
      interactionId: string;
      runId: string;
      workId: string | null;
      sessionId: string;
      createdAt: string;
      questions: number;
    }> = [];
    for (const record of this.store.pendingInteractions(200)) {
      let run: RunRecord;
      try {
        run = this.runs.get(record.runId);
        this.policy.authorize(principal, 'run.read', {
          appId: run.appId,
          ...(run.workId ? { workId: run.workId } : {}),
        });
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
      });
    }
    return items;
  }
  /** CAS answer from the bound operator; late, duplicate or post-terminal answers are rejected. */
  answerInteraction(interactionId: string, answer: unknown, principal: Principal): InteractionRecord {
    const record = this.store.interactionGet(interactionId);
    if (!record) throw new PlatformError('INTERACTION_NOT_FOUND');
    const run = this.runs.get(record.runId);
    this.policy.authorize(principal, 'run.answer', {
      appId: run.appId, projectId: run.workspace?.projectId,
      workspaceId: run.workspace?.workspaceId, workId: run.workId ?? undefined,
    });
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
  /** Open the local operator's native folder dialog; no directory contents cross the API. */
  authorizePick(principal: Principal): void {
    this.policy.authorize(principal, 'fs.pick');
  }
  audit(offset: number, limit: number, principal: Principal): { items: AuditEntry[]; total: number } {
    this.policy.authorize(principal, 'audit.read');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new PlatformError('AUDIT_PAGE_INVALID');
    }
    return this.store.auditList(offset, limit);
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
    if (!launchId || !this.executor) return { record: cancelled, cancelSettled: false };
    const settled = await this.executor.cancel(launchId);
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
    this.policy.authorize(principal, 'run.reconcile', {
      appId: run.appId,
      projectId: run.workspace?.projectId,
      workspaceId: run.workspace?.workspaceId,
      workId: run.workId ?? undefined,
    });
    if (run.snapshot.state !== 'UNKNOWN') throw new PlatformError('RUN_NOT_UNKNOWN', run.snapshot.state);
    if (!run.reconciledAt) {
      this.store.runMarkReconciled(runId, new Date().toISOString());
      this.store.audit(principal.actorId, 'RUN_UNKNOWN_RECONCILED', runId, {
        note: 'operator confirmed no live execution; workspace released',
      });
    }
    return this.getRun(runId, principal);
  }

  /** Supervisor-only: launch the worker and bind its launchId/fencing token. */
  async dispatchRun(runId: string, expectedRevision: number, principal: Principal): Promise<RunRecord> {
    this.policy.authorize(principal, 'run.dispatch');
    if (!this.executor) throw new PlatformError('EXECUTOR_NOT_CONFIGURED');
    const record = this.runs.get(runId);
    if (record.snapshot.revision !== expectedRevision) throw new PlatformError('RUN_REVISION_STALE');
    if (record.snapshot.cancelRequested) throw new PlatformError('RUN_CANCEL_REQUESTED');
    const app = this.registry.get(record.appId, record.appVersion);
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
    });
    let launch;
    try {
      launch = await this.executor.dispatch({
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
      throw error;
    }
    let bound: RunRecord;
    try {
      bound = this.runs.apply(
        runId,
        { type: 'dispatch', launchId: launch.launchId, fencingToken: launch.fencingToken },
        expectedRevision,
        whichService(principal),
      );
    } catch (error) {
      await this.executor.cancel(launch.launchId);
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
    if (!this.executor) throw new PlatformError('EXECUTOR_NOT_CONFIGURED');
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
      executor: this.executor?.kind ?? 'not-configured',
      artifacts: this.store.artifactCount(),
      auditEntries: this.store.auditList(0, 1).total,
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
  }
  private async observeOutcome(runId: string, launchId: string, fencingToken: number, promise: Promise<RunOutcome>): Promise<void> {
    try {
      await this.observeOutcomeInternal(runId, launchId, fencingToken, promise);
    } finally {
      // Any terminal outcome ends the run's right to keep asking questions.
      if (!this.closed) {
        try {
          const state = this.runs.get(runId).snapshot.state;
          if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(state)) this.settleInteractions(runId);
        } catch {
          // The run was removed; nothing left to settle.
        }
      }
    }
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
