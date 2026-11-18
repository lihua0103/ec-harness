/** Same-origin HTTP client for the platform control plane (T02/T06/T07).
 *
 *  The browser half talks only to `/api/*` on its own origin; the deployment's identity-aware
 *  proxy authenticates the request, so no token or actor travels in the URL or body. A failed
 *  response surfaces the control plane's own public code instead of being collapsed to "unknown".
 */
import { parseWorkContext, type WorkContext } from './work-context.js';

export interface WorkbenchItem {
  workId: string;
  title: string;
  projectId: string;
  appId: string;
  appVersion: string;
  state: 'ACTIVE' | 'ARCHIVED';
  updatedAt?: string;
}

/** The model route frozen into a run at creation (control-plane ModelConfigSnapshot subset). */
export interface RunModelSnapshot {
  selectionId: string;
  provider: string;
  model: string;
}

export interface RunSummary {
  runId: string;
  workId: string | null;
  appId: string;
  appVersion: string;
  createdAt: string;
  snapshot?: { state?: string; revision?: number; reason?: string; cancelRequested?: boolean };
  model?: RunModelSnapshot | null;
}

export interface ArtifactItem {
  name: string;
  digest: string;
  bytes: number;
  mediaType?: string;
  sealedAt?: string;
  createdAt?: string;
}

/** One live assistant message observed through public SDK notifications while a run executed.
 *  These are projections: the control plane keeps them only for the current attempt and they
 *  are absent after a control-plane restart. */
export interface RunActivity {
  kind: 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'status';
  text: string;
  detail?: string;
  createdAt: string;
}

/** One deterministic check result (E2-1): recomputable from run records, no expert judgement. */
export interface EvaluationRunItem {
  evaluationRunId: string;
  evaluationSetId: string;
  runId: string;
  state: 'COMPLETED';
  results: Array<{ entryId: string; label: string; check: { kind: string }; pass: boolean; detail: string }>;
  passed: number;
  failed: number;
  createdAt: string;
}

/** The transcript-shaped slice of one run record: last root-session assistant text plus the
 *  observed activity window. Never a fabricated summary — absent fields stay absent. */
export interface RunDetail {
  result: { finalResponse: string; sessionId?: string; at: string } | null;
  activities?: RunActivity[];
}

export interface InputCommitItem {
  commitId: string;
  runId: string;
  sequence: number;
  contentDigest: string;
  state: 'PENDING' | 'CONSUMED' | 'UNKNOWN' | 'NOT_SENT' | 'DEFERRED';
  createdAt: string;
}

export interface InputBaselineItem {
  baselineId: string;
  workId: string;
  revision: number;
  sourceRef: string;
  digest: string;
  createdBy: string;
  createdAt: string;
}

/** One delivery package (E1-3): a frozen manifest of a run's sealed artifacts plus the review
 *  snapshot taken at seal time. 封存(SEAL) ≠ 交付(DELIVER) ≠ 接收(RECEIVED) are three separate,
 *  separately audited facts; WITHDRAWN and SUPERSEDED are explicit operator acts, never silent. */
export interface DeliveryPackageItem {
  packageId: string;
  workId: string;
  runId: string;
  state: 'SEALED' | 'DELIVERED' | 'RECEIVED' | 'WITHDRAWN' | 'SUPERSEDED';
  manifest: {
    runId: string;
    appId: string;
    appVersion: string;
    artifacts: Array<{ name: string; digest: string; bytes: number }>;
    review: { reviewId: string; state: ReviewItem['state']; updatedAt: string } | null;
  };
  packageDigest: string;
  note?: string;
  deliveredAt?: string;
  deliveredNote?: string;
  receivedAt?: string;
  receivedNote?: string;
  withdrawnAt?: string;
  withdrawReason?: string;
  supersededBy?: string;
  sealedBy: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** One app-contributed result fact with a stable business key (E1-4). */
export interface FindingItem {
  key: string;
  kind: string;
  severity?: 'info' | 'warning' | 'error';
  summary?: string;
  fields?: Record<string, string | number | boolean>;
}

/** Key-aligned finding diff between two runs (E1-4). Different apps or app versions answer
 *  `comparable: false` — the platform declares that instead of guessing an alignment. */
export interface FindingsDiff {
  comparable: boolean;
  reason?: string;
  appId?: string;
  fromRunId: string;
  toRunId: string;
  kinds?: Array<{
    kind: string;
    added: number;
    resolved: number;
    changed: number;
    unchanged: number;
    items: Array<{ key: string; state: 'added' | 'resolved' | 'changed' | 'unchanged'; before?: FindingItem; after?: FindingItem }>;
  }>;
}

/** Declarative result view (E1-5) contributed by the app descriptor; the platform renders it
 *  generically and never branches on which application it is. */
export interface ResultViewDecl {
  viewId: string;
  title: string;
  kind: 'table' | 'metrics';
  findingKind: string;
  columns?: Array<{ field: string; label: string }>;
  metrics?: Array<{ field: string; label: string; unit?: string; stat: 'count' | 'sum' | 'avg' }>;
}

/** One durable audit entry; the export adds the SHA-256 chain links (prevDigest/digest) per line. */
export interface AuditEntryItem {
  sequence: number;
  actor: string;
  action: string;
  target: string;
  details?: unknown;
  createdAt: string;
  correlationId?: string;
  prevDigest?: string;
  digest?: string;
}

export interface AuditExportResult {
  entries: AuditEntryItem[];
  headDigest: string;
  lastSequence: number;
  count: number;
}

/** One durable run-ledger event (state transition), distinct from the live activity window. */
export interface RunEventItem {
  sequence: number;
  revision: number;
  event: { type: string; [key: string]: unknown };
  actor: string;
  createdAt: string;
}

export interface Page<T> {
  total: number;
  items: T[];
}

/** One platform model-catalog entry, as the control plane publishes it (never a free-form id). */
export interface ModelEntry {
  selectionId: string;
  provider: string;
  model: string;
  displayName?: string;
  description?: string;
  enabled: boolean;
  available?: boolean;
  unavailableReason?: string | null;
  capabilities?: { contextWindow?: number; modalities?: string[]; reasoning?: string };
}

export interface ModelCatalog {
  catalogId: string;
  catalogDigest?: string;
  runtimeBundleDigest: string;
  defaultSelectionId: string | null;
  entries: ModelEntry[];
}

/** Saved default model preference of the authenticated employee. */
export interface ModelPreference {
  selectionId: string | null;
  updatedAt: string | null;
  state: 'none' | 'available' | 'unavailable' | 'unknown';
  entry?: ModelEntry | null;
  reason?: string;
}

export interface WorkspaceItem {
  workspaceId: string;
  projectId: string;
  name: string;
  directory: string;
  executionDirectory?: string;
  outputDirectory?: string;
}

/** One execution domain as the control plane publishes it (metadata only, never a proxy address). */
export interface ExecutionDomainItem {
  domainId: string;
  owner?: string;
  kind: 'local' | 'hosted';
  state: 'HEALTHY' | 'DEGRADED' | 'UNKNOWN';
  revision?: number;
}

/** One Work↔Session association; a Work keeps exactly one `primary`. */
export interface WorkSessionBindingItem {
  bindingId: string;
  workId: string;
  domainId: string;
  sessionId: string;
  workspaceId?: string;
  releaseDigest: string;
  relation: 'primary' | 'fork' | 'reopened';
  revision: number;
  createdBy?: string;
  createdAt?: string;
}

export interface WorkDraft {
  workId: string;
  text: string;
  revision: number;
  updatedAt?: string;
}

export interface InteractionItem {
  interactionId: string;
  runId: string;
  sessionId: string;
  requestId: string;
  kind: 'user-question';
  body: {
    questions?: Array<{
      id: string;
      question: string;
      detail?: string;
      options?: Array<{ label: string; description?: string } | string>;
      multiSelect?: boolean;
    }>;
  };
  state: 'PENDING' | 'ANSWERED' | 'CANCELLED' | 'EXPIRED';
  createdAt: string;
  resolvedAt?: string;
  answer?: unknown;
}

/** Business review of one succeeded execution. Technical success, sealed artifacts and this
 *  review are independent facts. */
export interface ReviewItem {
  reviewId: string;
  runId: string;
  state: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';
  requestedBy: string;
  reviewer?: string;
  note?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Last recorded model health fact for one catalog selection. Absence means "not probed", never
 *  "healthy". */
export interface ModelHealthItem {
  selectionId: string;
  state: 'healthy' | 'degraded' | 'unavailable' | 'unknown';
  reason?: string;
  checkedAt: string;
  revision: number;
}

/** Honest storage/recovery topology (E0d): what the control plane persists and what backup
 *  covers — explicitly including what it does NOT cover. `false` never means "unknown". */
export interface StorageFacts {
  controlStorePath: string;
  backupCoverage: {
    controlStore: boolean;
    sealedArtifacts: boolean;
    knowledgeStore: boolean;
    nativeSessionHomes: boolean;
  };
  /** Whether recovery restrictions persist as machine-readable markers. False today. */
  recoveryRestrictionMarkers: boolean;
}

/** Model-governance record (E2-4): one catalog selection's approval lifecycle. */
export interface ModelApprovalItem {
  approvalId: string;
  selectionId: string;
  state: 'ACTIVE' | 'REVOKED';
  approvedBy: string;
  approvedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  revokeReason?: string;
  revision: number;
}

/** Per-project run budget facts (E2-3). A cap of 0 means "not enforced", never "unlimited
 *  headroom"; the counting boundary is stated so the panel cannot imply full coverage. */
export interface QuotaFacts {
  maxConcurrentRunsPerProject: number;
  maxRunsPerDayPerProject: number;
  scope: { counted: string; notCounted: string[] };
  dayBoundary: string;
}

/** E3-1 operations panel payload: measurements plus the deployment's doctor probe. `slo.targets`
 *  is null until the deployment defines targets — the panel says so instead of implying success. */
export interface OpsPanel {
  generatedAt: string;
  metrics: {
    startedAt: string;
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, { count: number; p50: number; p95: number; p99: number; max: number }>;
  };
  status?: { executor?: string; runs?: Record<string, number>; outbox?: Record<string, number>; approvals?: { active: number; revoked: number } };
  storage?: StorageFacts;
  quotas?: QuotaFacts;
  doctor: {
    ok: boolean;
    generatedAt: string;
    checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }>;
  } | null;
  doctorNote: string;
  slo: { targets: null; note: string };
}

export interface WorkbenchBootstrap {
  projects: Array<{ projectId: string; name: string; code?: string }>;
  apps: Array<{
    appId: string;
    appVersion: string;
    displayName?: string;
    state: 'ACTIVE' | 'REVOKED';
    /** The release descriptor as the control plane publishes it; Listing declares its scenarios here. */
    descriptor?: { displayName?: string; description?: string; listingTypes?: string[]; resultViews?: ResultViewDecl[] };
  }>;
  works: { total: number; items: WorkbenchItem[] };
  runs?: { total: number; items: RunSummary[] };
  /** Questions still waiting for this employee's answer, authorized per run. */
  pending?: Array<{
    interactionId: string;
    runId: string;
    workId: string | null;
    sessionId: string;
    createdAt: string;
    questions: number;
    runState?: string;
  }>;
  models?: {
    catalog: ModelCatalog | null;
    preference: ModelPreference;
    health?: ModelHealthItem[];
    approvals?: ModelApprovalItem[];
  };
  /** E3-4 unified todos: three sources on one read surface, each keeping its own kind and verb. */
  todos?: Array<{
    kind: 'question' | 'review' | 'delivery-receipt';
    id: string;
    runId: string | null;
    workId: string | null;
    createdAt: string;
    summary: string;
    resolveHint: string;
  }>;
  status?: { executor?: string; runs?: Record<string, number>; outbox?: Record<string, number>; approvals?: { active: number; revoked: number } };
  storage?: StorageFacts;
  quotas?: QuotaFacts;
}

export class PlatformApiError extends Error {
  constructor(readonly code: string, readonly status: number, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PlatformApiError';
  }
}

export interface FetchLike {
  (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

export class WorkbenchApi {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike

  constructor(baseUrl = '', fetchImpl?: FetchLike) {
    this.baseUrl = baseUrl
    const globalFetch = (globalThis as unknown as { fetch?: FetchLike }).fetch
    // `fetch` must be invoked with its global receiver; calling a bare reference throws
    // "Illegal invocation" in browsers. Bind once here instead of at every call site.
    this.fetchImpl = fetchImpl ?? (globalFetch ? globalFetch.bind(globalThis) : (() => {
      throw new Error('FETCH_UNAVAILABLE')
    }) as unknown as FetchLike)
  }

  private async call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = payload as { code?: string; detail?: string } | null;
      throw new PlatformApiError(error?.code ?? 'PLATFORM_OPERATION_FAILED', response.status, error?.detail);
    }
    return payload;
  }

  bootstrap(signal?: AbortSignal): Promise<WorkbenchBootstrap> {
    return this.call('GET', '/api/workbench', undefined, signal) as Promise<WorkbenchBootstrap>;
  }

  /** Resolve a Work into its native Session. A requested deep link is validated server-side. */
  async workContext(
    workId: string,
    requested: { sessionId?: string; domainId?: string } = {},
    signal?: AbortSignal,
  ): Promise<WorkContext> {
    const query = new URLSearchParams();
    if (requested.sessionId) query.set('sessionId', requested.sessionId);
    if (requested.domainId) query.set('domainId', requested.domainId);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const raw = await this.call('GET', `/api/works/${encodeURIComponent(workId)}/context${suffix}`, undefined, signal);
    return parseWorkContext(raw);
  }

  /** Works visible to the caller. Paging is explicit so a large catalogue is never silently cut. */
  listWorks(
    state?: 'ACTIVE' | 'ARCHIVED',
    page?: { offset: number; limit: number },
    signal?: AbortSignal,
  ): Promise<{ total: number; items: WorkbenchItem[] }> {
    const query = new URLSearchParams();
    if (state) query.set('state', state);
    if (page) {
      query.set('offset', String(page.offset));
      query.set('limit', String(page.limit));
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.call('GET', `/api/works${suffix}`, undefined, signal) as Promise<{ total: number; items: WorkbenchItem[] }>;
  }

  /** E4-3 server-side filtered, cursor-paginated Works. The q filter matches titles server-side. */
  queryWorks(
    params: { projectId?: string; appId?: string; state?: 'ACTIVE' | 'ARCHIVED'; q?: string; cursor?: string | null },
    signal?: AbortSignal,
  ): Promise<{ items: WorkbenchItem[]; nextCursor: string | null }> {
    const query = new URLSearchParams();
    if (params.projectId) query.set('projectId', params.projectId);
    if (params.appId) query.set('appId', params.appId);
    if (params.state) query.set('state', params.state);
    if (params.q) query.set('q', params.q);
    if (params.cursor) query.set('cursor', params.cursor);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.call('GET', `/api/works/query${suffix}`, undefined, signal) as Promise<{ items: WorkbenchItem[]; nextCursor: string | null }>;
  }

  /** E4-3 server-side filtered, cursor-paginated Runs. The q filter matches the input goal server-side. */
  queryRuns(
    params: { appId?: string; workId?: string; projectId?: string; state?: string; q?: string; cursor?: string | null },
    signal?: AbortSignal,
  ): Promise<{ items: RunSummary[]; nextCursor: string | null }> {
    const query = new URLSearchParams();
    if (params.appId) query.set('appId', params.appId);
    if (params.workId) query.set('workId', params.workId);
    if (params.projectId) query.set('projectId', params.projectId);
    if (params.state) query.set('state', params.state);
    if (params.q) query.set('q', params.q);
    if (params.cursor) query.set('cursor', params.cursor);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.call('GET', `/api/runs/query${suffix}`, undefined, signal) as Promise<{ items: RunSummary[]; nextCursor: string | null }>;
  }

  /** E4-6 global search: one query across works, runs, projects and apps. */
  search(q: string, signal?: AbortSignal): Promise<Array<{
    kind: 'work' | 'run' | 'project' | 'app';
    id: string;
    title: string;
    detail: string;
    workId?: string;
    runId?: string;
  }>> {
    return this.call('GET', `/api/search?q=${encodeURIComponent(q)}`, undefined, signal) as Promise<Array<{
      kind: 'work' | 'run' | 'project' | 'app';
      id: string;
      title: string;
      detail: string;
      workId?: string;
      runId?: string;
    }>>;
  }

  /** E2-1 deterministic evaluation sets: checks that need no expert gold set. */
  listEvaluationSets(appId?: string, signal?: AbortSignal): Promise<Array<{
    evaluationSetId: string;
    appId: string;
    name: string;
    description: string;
    state: 'ACTIVE' | 'ARCHIVED';
    entries: Array<{ entryId: string; label: string; checks: Array<{ kind: string }> }>;
  }>> {
    const suffix = appId ? `?appId=${encodeURIComponent(appId)}` : '';
    return this.call('GET', `/api/evaluations${suffix}`, undefined, signal) as Promise<Array<{
      evaluationSetId: string;
      appId: string;
      name: string;
      description: string;
      state: 'ACTIVE' | 'ARCHIVED';
      entries: Array<{ entryId: string; label: string; checks: Array<{ kind: string }> }>;
    }>>;
  }

  /** Run every deterministic check of one set against one run; pure recomputation, no model. */
  evaluateSet(evaluationSetId: string, runId: string, signal?: AbortSignal): Promise<EvaluationRunItem> {
    return this.call(
      'POST',
      `/api/evaluations/${encodeURIComponent(evaluationSetId)}/evaluate`,
      { runId },
      signal,
    ) as Promise<EvaluationRunItem>;
  }

  /** Recorded evaluation runs of one set, newest first. */
  evaluationRuns(evaluationSetId: string, signal?: AbortSignal): Promise<{ items: EvaluationRunItem[] }> {
    return this.call(
      'GET',
      `/api/evaluations/${encodeURIComponent(evaluationSetId)}/runs`,
      undefined,
      signal,
    ) as Promise<{ items: EvaluationRunItem[] }>;
  }

  /** Durable execution records for one Work, newest first as the control plane orders them. */
  workRuns(workId: string, page: { offset: number; limit: number }, signal?: AbortSignal): Promise<Page<RunSummary>> {
    return this.call(
      'GET',
      `/api/works/${encodeURIComponent(workId)}/runs?offset=${page.offset}&limit=${page.limit}`,
      undefined,
      signal,
    ) as Promise<Page<RunSummary>>;
  }

  /** Append-only input batches for one Work; a newer batch never rewrites an older one. */
  workInputBaselines(workId: string, page: { offset: number; limit: number }, signal?: AbortSignal): Promise<Page<InputBaselineItem>> {
    return this.call(
      'GET',
      `/api/works/${encodeURIComponent(workId)}/input-baselines?offset=${page.offset}&limit=${page.limit}`,
      undefined,
      signal,
    ) as Promise<Page<InputBaselineItem>>;
  }

  /** Append one input batch (SC-03): the actor is the server-side principal, never a body field. */
  appendInputBaseline(workId: string, draft: { sourceRef: string; digest: string }, signal?: AbortSignal): Promise<InputBaselineItem> {
    return this.call(
      'POST',
      `/api/works/${encodeURIComponent(workId)}/input-baselines`,
      { sourceRef: draft.sourceRef, digest: draft.digest },
      signal,
    ) as Promise<InputBaselineItem>;
  }

  /** Delivery packages of one Work, newest first; every lifecycle state stays visible. */
  workDeliveryPackages(workId: string, page: { offset: number; limit: number }, signal?: AbortSignal): Promise<Page<DeliveryPackageItem>> {
    return this.call(
      'GET',
      `/api/works/${encodeURIComponent(workId)}/delivery-packages?offset=${page.offset}&limit=${page.limit}`,
      undefined,
      signal,
    ) as Promise<Page<DeliveryPackageItem>>;
  }

  /** Seal a SUCCEEDED run's artifacts into a delivery package (review snapshot frozen at seal). */
  sealDeliveryPackage(workId: string, draft: { runId: string; note?: string }, signal?: AbortSignal): Promise<DeliveryPackageItem> {
    return this.call(
      'POST',
      `/api/works/${encodeURIComponent(workId)}/delivery-packages`,
      draft.note ? draft : { runId: draft.runId },
      signal,
    ) as Promise<DeliveryPackageItem>;
  }

  /** SEALED → DELIVERED: record the handover. CAS on revision keeps concurrent edits honest. */
  deliverDeliveryPackage(packageId: string, body: { note?: string; expectedRevision: number }, signal?: AbortSignal): Promise<DeliveryPackageItem> {
    return this.call('POST', `/api/delivery-packages/${encodeURIComponent(packageId)}/deliver`, body, signal) as Promise<DeliveryPackageItem>;
  }

  /** DELIVERED → RECEIVED: a declared counterpart fact; the platform does not verify receipt. */
  acknowledgeDeliveryPackage(packageId: string, body: { note?: string; expectedRevision: number }, signal?: AbortSignal): Promise<DeliveryPackageItem> {
    return this.call('POST', `/api/delivery-packages/${encodeURIComponent(packageId)}/acknowledge`, body, signal) as Promise<DeliveryPackageItem>;
  }

  /** SEALED/DELIVERED → WITHDRAWN with a mandatory reason; history stays. */
  withdrawDeliveryPackage(packageId: string, body: { reason: string; expectedRevision: number }, signal?: AbortSignal): Promise<DeliveryPackageItem> {
    return this.call('POST', `/api/delivery-packages/${encodeURIComponent(packageId)}/withdraw`, body, signal) as Promise<DeliveryPackageItem>;
  }

  /** Active → SUPERSEDED by another live package of the same Work; never automatic. */
  supersedeDeliveryPackage(packageId: string, body: { supersededBy: string; expectedRevision: number }, signal?: AbortSignal): Promise<DeliveryPackageItem> {
    return this.call('POST', `/api/delivery-packages/${encodeURIComponent(packageId)}/supersede`, body, signal) as Promise<DeliveryPackageItem>;
  }

  /** Sealed and metadata-only artifacts of one execution. */
  runArtifacts(runId: string, signal?: AbortSignal): Promise<{ items: ArtifactItem[] }> {
    return this.call('GET', `/api/runs/${encodeURIComponent(runId)}/artifacts`, undefined, signal) as Promise<{ items: ArtifactItem[] }>;
  }

  /** App-contributed result facts of one succeeded run (E1-4); empty until an app contributes. */
  runFindings(runId: string, signal?: AbortSignal): Promise<{ items: FindingItem[] }> {
    return this.call('GET', `/api/runs/${encodeURIComponent(runId)}/findings`, undefined, signal) as Promise<{ items: FindingItem[] }>;
  }

  /** Key-aligned finding diff, `from = runId`, `to = against` (E1-4). */
  runFindingsDiff(runId: string, against: string, signal?: AbortSignal): Promise<FindingsDiff> {
    return this.call(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/findings-diff?against=${encodeURIComponent(against)}`,
      undefined,
      signal,
    ) as Promise<FindingsDiff>;
  }

  /** The transcript-shaped slice of one run record (result text + observed activities). */
  runDetail(runId: string, signal?: AbortSignal): Promise<RunDetail> {
    return this.call('GET', `/api/runs/${encodeURIComponent(runId)}`, undefined, signal).then((record) => {
      const source = record as { result?: RunDetail['result']; activities?: RunActivity[] };
      return {
        ...(source.result !== undefined ? { result: source.result } : { result: null }),
        ...(source.activities !== undefined ? { activities: source.activities } : {}),
      };
    }) as Promise<RunDetail>;
  }

  /** Input commits accepted for one execution, paged by the control plane. */
  runInputs(runId: string, page: { offset: number; limit: number }, signal?: AbortSignal): Promise<Page<InputCommitItem>> {
    return this.call(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/inputs?offset=${page.offset}&limit=${page.limit}`,
      undefined,
      signal,
    ) as Promise<Page<InputCommitItem>>;
  }

  /** Durable run-ledger events (state transitions), newest first; survives a control-plane restart. */
  runEvents(runId: string, page: { offset: number; limit: number }, signal?: AbortSignal): Promise<Page<RunEventItem>> {
    return this.call(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/events?offset=${page.offset}&limit=${page.limit}`,
      undefined,
      signal,
    ) as Promise<Page<RunEventItem>>;
  }

  /** Verifiable audit export (NDJSON with a SHA-256 chain). The body is newline-delimited JSON, not
   *  one JSON document, so it is parsed line by line; the chain head/last sequence come from the
   *  lines themselves (the proxy does not forward the X-Audit response headers). */
  async auditExport(
    options: { target?: string; after?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<AuditExportResult> {
    const query = new URLSearchParams();
    if (options.target) query.set('target', options.target);
    if (options.after !== undefined) query.set('after', String(options.after));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const response = await this.fetchImpl(`${this.baseUrl}/api/audit/export${suffix}`, {
      method: 'GET',
      headers: { accept: 'application/x-ndjson' },
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      let code = 'PLATFORM_OPERATION_FAILED';
      try { code = (JSON.parse(text) as { code?: string }).code ?? code; } catch { /* non-JSON error body */ }
      throw new PlatformApiError(code, response.status);
    }
    const entries = text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as AuditEntryItem);
    const last = entries[entries.length - 1];
    return {
      entries,
      headDigest: last?.digest ?? '0'.repeat(64),
      lastSequence: last?.sequence ?? (options.after ?? 0),
      count: entries.length,
    };
  }

  /** E3-1 operations panel: measured latency distribution (p50/p95/p99), outbox depth, run
   *  counts, doctor probe and the honest "no SLO targets defined yet" statement. */
  opsPanel(signal?: AbortSignal): Promise<OpsPanel> {
    return this.call('GET', '/api/ops/panel', undefined, signal) as Promise<OpsPanel>;
  }

  /** Record one enterprise submission intent for an already-bound native Session.
   *  The submitter is the authenticated principal on the server; the body never carries it. */
  recordSubmission(
    input: { workId: string; domainId: string; sessionId: string; requestId: string; input: unknown },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.call('POST', '/api/submissions', input, signal);
  }

  /** Acknowledge a recorded intent with the native admission evidence the observer saw. */
  acknowledgeSubmission(submissionId: string, admission: string, signal?: AbortSignal): Promise<SubmissionItem> {
    return this.call(
      'POST',
      `/api/submissions/${encodeURIComponent(submissionId)}/acknowledge`,
      { admission },
      signal,
    ) as Promise<SubmissionItem>;
  }

  /** Mark a recorded intent consumed by a durable native event. */
  consumeSubmission(submissionId: string, signal?: AbortSignal): Promise<SubmissionItem> {
    return this.call('POST', `/api/submissions/${encodeURIComponent(submissionId)}/consume`, {}, signal) as Promise<SubmissionItem>;
  }

  workSubmissions(workId: string, signal?: AbortSignal): Promise<{ items: SubmissionItem[] }> {
    return this.call('GET', `/api/works/${encodeURIComponent(workId)}/submissions`, undefined, signal) as Promise<{ items: SubmissionItem[] }>;
  }

  /** Model catalog and the signed-in employee's saved default preference. */
  models(signal?: AbortSignal): Promise<{ catalog: ModelCatalog | null; preference: ModelPreference }> {
    return this.call('GET', '/api/models', undefined, signal) as Promise<{ catalog: ModelCatalog | null; preference: ModelPreference }>;
  }

  /** Persist the caller's own default model; it never changes another employee's default. */
  setModelPreference(selectionId: string, signal?: AbortSignal): Promise<ModelPreference> {
    return this.call('PUT', '/api/models/preference', { selectionId }, signal) as Promise<ModelPreference>;
  }

  projectWorkspaces(projectId: string, signal?: AbortSignal): Promise<{ items: WorkspaceItem[] }> {
    return this.call('GET', `/api/projects/${encodeURIComponent(projectId)}/workspaces`, undefined, signal) as Promise<{ items: WorkspaceItem[] }>;
  }

  /** Create a project; the control plane authorizes `project.create` for the caller. */
  createProject(input: { name: string; code?: string }, signal?: AbortSignal): Promise<{ projectId: string; name: string; code?: string }> {
    return this.call('POST', '/api/projects', input, signal) as Promise<{ projectId: string; name: string; code?: string }>;
  }

  /** Register a workspace on the execution host (name + directory). */
  createWorkspace(
    projectId: string,
    input: { name: string; directory: string; outputDirectory?: string },
    signal?: AbortSignal,
  ): Promise<WorkspaceItem> {
    return this.call('POST', `/api/projects/${encodeURIComponent(projectId)}/workspaces`, input, signal) as Promise<WorkspaceItem>;
  }

  /** Archive a Work; archived Works stay readable but refuse new runs. */
  archiveWork(workId: string, signal?: AbortSignal): Promise<WorkbenchItem> {
    return this.call('POST', `/api/works/${encodeURIComponent(workId)}/archive`, {}, signal) as Promise<WorkbenchItem>;
  }

  /** Request a run stop through the native/control-plane cancel path; never writes a terminal state. */
  cancelRun(runId: string, expectedRevision: number, signal?: AbortSignal): Promise<{ record: RunSummary; cancelSettled: boolean }> {
    return this.call(
      'POST',
      `/api/runs/${encodeURIComponent(runId)}/cancel`,
      { expectedRevision },
      signal,
    ) as Promise<{ record: RunSummary; cancelSettled: boolean }>;
  }

  /** Retry a terminal run as a new run on the same Work, optionally with a new model. */
  retryRun(runId: string, modelSelectionId?: string, signal?: AbortSignal): Promise<RunSummary> {
    return this.call(
      'POST',
      `/api/runs/${encodeURIComponent(runId)}/retry`,
      modelSelectionId ? { modelSelectionId } : {},
      signal,
    ) as Promise<RunSummary>;
  }

  /** Operator-confirmed reconciliation of an UNKNOWN run; it releases the workspace only. */
  reconcileRun(runId: string, signal?: AbortSignal): Promise<RunSummary> {
    return this.call('POST', `/api/runs/${encodeURIComponent(runId)}/reconcile`, {}, signal) as Promise<RunSummary>;
  }

  createWork(
    input: { projectId: string; workspaceId?: string; appId: string; appVersion: string; title: string; goal?: string },
    signal?: AbortSignal,
  ): Promise<WorkbenchItem> {
    return this.call('POST', '/api/works', input, signal) as Promise<WorkbenchItem>;
  }

  workDraft(workId: string, signal?: AbortSignal): Promise<WorkDraft> {
    return this.call('GET', `/api/works/${encodeURIComponent(workId)}/draft`, undefined, signal) as Promise<WorkDraft>;
  }

  saveWorkDraft(workId: string, text: string, expectedRevision: number, signal?: AbortSignal): Promise<WorkDraft> {
    return this.call(
      'PUT',
      `/api/works/${encodeURIComponent(workId)}/draft`,
      { text, expectedRevision },
      signal,
    ) as Promise<WorkDraft>;
  }

  /** Start one enterprise execution on this Work; the control plane freezes the model snapshot. */
  createRun(
    workId: string,
    input: { input: unknown; modelSelectionId?: string },
    signal?: AbortSignal,
  ): Promise<RunSummary> {
    return this.call('POST', `/api/works/${encodeURIComponent(workId)}/runs`, input, signal) as Promise<RunSummary>;
  }

  /** Pending and settled questions for one execution (answers included, same principal). */
  runInteractions(runId: string, signal?: AbortSignal): Promise<{ total: number; items: InteractionItem[] }> {
    return this.call('GET', `/api/runs/${encodeURIComponent(runId)}/interactions`, undefined, signal) as Promise<{
      total: number;
      items: InteractionItem[];
    }>;
  }

  /** Business review records for one execution. */
  runReviews(runId: string, signal?: AbortSignal): Promise<{ items: ReviewItem[] }> {
    return this.call('GET', `/api/runs/${encodeURIComponent(runId)}/reviews`, undefined, signal) as Promise<{
      items: ReviewItem[];
    }>;
  }

  /** Request a business review of a succeeded run; the server refuses anything else. */
  requestReview(runId: string, note?: string, signal?: AbortSignal): Promise<ReviewItem> {
    return this.call('POST', `/api/runs/${encodeURIComponent(runId)}/reviews`, note ? { note } : {}, signal) as Promise<ReviewItem>;
  }

  /** Record a review decision with CAS on the review revision. */
  decideReview(
    reviewId: string,
    decision: 'APPROVED' | 'REJECTED',
    expectedRevision: number,
    note?: string,
    signal?: AbortSignal,
  ): Promise<ReviewItem> {
    return this.call('POST', `/api/reviews/${encodeURIComponent(reviewId)}/decision`, {
      decision,
      expectedRevision,
      ...(note ? { note } : {}),
    }, signal) as Promise<ReviewItem>;
  }

  /** Answer one native question. A late, duplicate or post-terminal answer is rejected by the server. */
  answerInteraction(interactionId: string, answers: Array<{ id: string; selected: string[]; custom?: string }>): Promise<InteractionItem> {
    return this.call(
      'POST',
      `/api/interactions/${encodeURIComponent(interactionId)}/answer`,
      { answer: { answers } },
    ) as Promise<InteractionItem>;
  }

  /** Execution domains visible to this principal; empty means a binding must register one first. */
  domains(signal?: AbortSignal): Promise<{ items: ExecutionDomainItem[] }> {
    return this.call('GET', '/api/domains', undefined, signal) as Promise<{ items: ExecutionDomainItem[] }>;
  }

  /** Register an execution domain. For the local deployment this is the operator's own machine. */
  createDomain(
    input: { kind?: 'local' | 'hosted'; owner?: string; capabilities?: string[] },
    signal?: AbortSignal,
  ): Promise<ExecutionDomainItem> {
    return this.call('POST', '/api/domains', input, signal) as Promise<ExecutionDomainItem>;
  }

  /** Bind a Work to the real native Session id the native create returned. */
  bindWorkSession(
    workId: string,
    input: { domainId: string; sessionId: string; releaseDigest: string; workspaceId?: string; relation?: 'primary' | 'fork' | 'reopened'; sourceWorkId?: string },
    signal?: AbortSignal,
  ): Promise<WorkSessionBindingItem> {
    return this.call('POST', `/api/works/${encodeURIComponent(workId)}/bindings`, input, signal) as Promise<WorkSessionBindingItem>;
  }
}

export interface SubmissionItem {
  submissionId: string;
  workId: string;
  domainId: string;
  sessionId: string;
  requestId: string;
  inputDigest: string;
  submittedBy: string;
  state: 'RECORDED' | 'ACCEPTED' | 'CONSUMED' | 'UNKNOWN' | 'REJECTED';
  admission?: string;
  consumedAt?: string;
  createdAt: string;
  updatedAt: string;
}
