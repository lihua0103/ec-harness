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

export interface RunSummary {
  runId: string;
  workId: string | null;
  appId: string;
  appVersion: string;
  createdAt: string;
  snapshot?: { state?: string; revision?: number; reason?: string; cancelRequested?: boolean };
}

export interface ArtifactItem {
  name: string;
  digest: string;
  bytes: number;
  mediaType?: string;
  sealedAt?: string;
  createdAt?: string;
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

export interface WorkbenchBootstrap {
  projects: Array<{ projectId: string; name: string; code?: string }>;
  apps: Array<{
    appId: string;
    appVersion: string;
    displayName?: string;
    state: 'ACTIVE' | 'REVOKED';
    /** The release descriptor as the control plane publishes it; Listing declares its scenarios here. */
    descriptor?: { displayName?: string; description?: string; listingTypes?: string[] };
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
  }>;
  models?: { catalog: ModelCatalog | null; preference: ModelPreference };
  status?: { executor?: string; runs?: Record<string, number> };
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

  /** Sealed and metadata-only artifacts of one execution. */
  runArtifacts(runId: string, signal?: AbortSignal): Promise<{ items: ArtifactItem[] }> {
    return this.call('GET', `/api/runs/${encodeURIComponent(runId)}/artifacts`, undefined, signal) as Promise<{ items: ArtifactItem[] }>;
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
