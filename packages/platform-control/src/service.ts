/** Control-plane service: application registry + persistent runs + supervisor-facing transitions.
 *  It never imports or executes application code; a worker executor is an external dependency. */
import type { ExecutionPlan } from '../../platform-runtime/src/plan.js';
import type { RunEvent, RunSnapshot } from '../../platform-runtime/src/run.js';
import { LocalOperatorPolicy, type PlatformPolicy, type Principal } from './policy.js';
import { ApplicationRegistry, PlatformError } from './registry.js';
import { RunRepository } from './runs.js';
import {
  PlatformStore,
  type AppRecord,
  type AppState,
  type AppReleaseDraft,
  type ArtifactRecord,
  type AuditEntry,
  type InputCommit,
  type RunRecord,
} from './store.js';

export interface RunArtifact {
  name: string;
  digest: string;
  bytes: number;
  mediaType?: string;
}
export interface RunOutcome {
  status: 'succeeded' | 'failed' | 'cancelled';
  finalResponse?: string;
  error?: string;
  sessionId?: string;
  /** Digests reported by the executor; the control plane records them as run artifacts. */
  artifacts?: RunArtifact[];
}
export interface RunLaunch {
  launchId: string;
  fencingToken: number;
  /** Present when the executor can report the worker's eventual outcome. */
  outcome?: Promise<RunOutcome>;
}
export interface RunExecutor {
  readonly kind: string;
  dispatch(input: { run: RunRecord; plan: ExecutionPlan; inputs?: InputCommit[] }): Promise<RunLaunch>;
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
  private readonly policy: PlatformPolicy;
  private readonly requireArtifacts: boolean;
  private executor: RunExecutor | null;
  private closed = false;
  constructor(
    path: string,
    executor: RunExecutor | null = null,
    policy: PlatformPolicy = new LocalOperatorPolicy(),
    options: { requireArtifacts?: boolean } = {},
  ) {
    this.store = new PlatformStore(path);
    this.registry = new ApplicationRegistry(this.store);
    this.runs = new RunRepository(this.store);
    this.policy = policy;
    this.executor = executor;
    this.requireArtifacts = options.requireArtifacts ?? true;
  }
  setExecutor(executor: RunExecutor): void {
    this.executor = executor;
  }
  close(): void {
    this.closed = true;
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
  revokeApp(appId: string, appVersion: string, reason: string, principal: Principal): AppRecord {
    this.policy.authorize(principal, 'app.revoke', { appId });
    return this.registry.revoke(appId, appVersion, reason, principal.actorId);
  }
  createRun(appId: string, appVersion: string, input: unknown, principal: Principal): RunRecord {
    this.policy.authorize(principal, 'run.create', { appId });
    const app = this.registry.active(appId, appVersion);
    return this.runs.create(app, input, principal.actorId);
  }
  /** Retry never reuses the old Run/session: it creates a new Run with a fresh home and input marker. */
  retryRun(runId: string, principal: Principal): RunRecord {
    const previous = this.runs.get(runId);
    if (previous.snapshot.state !== 'FAILED' && previous.snapshot.state !== 'CANCELLED') {
      throw new PlatformError('RUN_RETRY_NOT_TERMINAL_FAILURE', previous.snapshot.state);
    }
    this.policy.authorize(principal, 'run.create', { appId: previous.appId });
    const app = this.registry.active(previous.appId, previous.appVersion);
    const created = this.runs.create(
      app,
      { retryOf: previous.runId, input: previous.input, inputDigest: previous.inputDigest },
      principal.actorId,
    );
    this.store.audit(principal.actorId, 'RUN_RETRY_CREATED', created.runId, {
      retryOf: previous.runId,
      appId: created.appId,
      appVersion: created.appVersion,
    });
    return created;
  }
  appendInput(runId: string, input: unknown, principal: Principal): InputCommit {
    const record = this.runs.get(runId);
    this.policy.authorize(principal, 'run.input', { appId: record.appId });
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
  getRun(runId: string, principal: Principal): RunRecord {
    const record = this.runs.get(runId);
    this.policy.authorize(principal, 'run.read', { appId: record.appId });
    return record;
  }
  listRuns(appId: string | undefined, offset: number, limit: number, principal: Principal) {
    this.policy.authorize(principal, 'run.read', appId ? { appId } : undefined);
    return this.runs.list(appId, offset, limit);
  }
  runEvents(runId: string, offset: number, limit: number, principal: Principal) {
    this.getRun(runId, principal);
    return this.runs.events(runId, offset, limit);
  }
  artifacts(runId: string, principal: Principal): ArtifactRecord[] {
    this.getRun(runId, principal);
    return this.store.artifacts(runId);
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
      record.snapshot.state === 'CANCELLED'
    ) {
      throw new PlatformError('RUN_TERMINAL', record.snapshot.state);
    }
    const cancelled = this.runs.apply(runId, { type: 'cancel' }, expectedRevision, principal.actorId);
    if (cancelled.snapshot.state === 'CANCELLED') return { record: cancelled, cancelSettled: true };
    const launchId = cancelled.snapshot.launchId;
    if (!launchId || !this.executor) return { record: cancelled, cancelSettled: false };
    const settled = await this.executor.cancel(launchId);
    if (!settled) return { record: cancelled, cancelSettled: false };
    const latest = this.runs.get(runId);
    return {
      record: this.runs.apply(runId, { type: 'cancel-settled' }, latest.snapshot.revision, whichService(principal)),
      cancelSettled: true,
    };
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
    const inputs = this.runs.inputs(runId, 0, 100).items;
    const launch = await this.executor.dispatch({ run: record, plan: app.plan, inputs });
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
      throw error;
    }
    if (launch.outcome) {
      void this.observeOutcome(runId, launch.outcome).catch((error: unknown) => {
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
    const queued = this.runs
      .list(undefined, 0, 100)
      .items.filter((run) => run.snapshot.state === 'QUEUED' && !run.snapshot.cancelRequested)
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
          { type: 'fail', reason: 'HOST_RESTARTED_RECONCILIATION_REQUIRED' },
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
        terminal: (counts.SUCCEEDED ?? 0) + (counts.FAILED ?? 0) + (counts.CANCELLED ?? 0),
      },
      executor: this.executor?.kind ?? 'not-configured',
      artifacts: this.store.artifactCount(),
      auditEntries: this.store.auditList(0, 1).total,
    };
  }
  private async observeOutcome(runId: string, promise: Promise<RunOutcome>): Promise<void> {
    let outcome: RunOutcome;
    try {
      outcome = await promise;
    } catch (error) {
      outcome = { status: 'failed', error: error instanceof Error ? error.message : 'UNKNOWN' };
    }
    if (this.closed) return;
    const actor = 'service:worker';
    const current = this.runs.get(runId);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(current.snapshot.state)) return;
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
    let latest = current;
    if (latest.snapshot.state === 'STARTING') {
      latest = this.runs.apply(runId, { type: 'started' }, latest.snapshot.revision, actor);
    }
    if (latest.snapshot.state !== 'RUNNING') return;
    let artifacts: ArtifactRecord[];
    try {
      artifacts = this.recordArtifacts(runId, outcome.artifacts ?? []);
    } catch (error) {
      this.runs.apply(
        runId,
        {
          type: 'fail',
          reason: `WORKER_RESULT_INVALID:${error instanceof Error ? error.message.slice(0, 1800) : 'UNKNOWN'}`,
        },
        latest.snapshot.revision,
        actor,
      );
      return;
    }
    const artifactsRegistered = artifacts.length > 0 || !this.requireArtifacts;
    const barrier = {
      inputsSettled: true,
      descendantsDone: true,
      artifactsRegistered,
      cleanedUp: true,
    };
    latest = this.runs.apply(runId, { type: 'barrier', barrier }, latest.snapshot.revision, actor);
    if (Object.values(barrier).every(Boolean)) {
      this.runs.apply(runId, { type: 'finish' }, latest.snapshot.revision, actor);
      return;
    }
    this.store.audit(actor, 'RUN_AWAITING_ARTIFACTS', runId, {
      finalResponse: outcome.finalResponse?.slice(0, 2000) ?? null,
      sessionId: outcome.sessionId ?? null,
    });
  }
  private recordArtifacts(runId: string, artifacts: RunArtifact[]): ArtifactRecord[] {
    if (!Array.isArray(artifacts) || artifacts.length > 100) throw new PlatformError('RUN_ARTIFACTS_INVALID');
    return this.store.transaction(() => {
      const seen = new Set<string>();
      const now = new Date().toISOString();
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
        try {
          this.store.artifactInsert(runId, { ...artifact, createdAt: now });
        } catch {
          throw new PlatformError('RUN_ARTIFACT_CONFLICT', artifact.name);
        }
        this.store.audit('service:worker', 'RUN_ARTIFACT_REGISTERED', runId, {
          name: artifact.name,
          digest: artifact.digest,
          bytes: artifact.bytes,
        });
      }
      return this.store.artifacts(runId);
    });
  }
  private supervisorEvent(
    runId: string,
    event: RunEvent,
    expectedRevision: number,
    principal: Principal,
    action: 'run.started' | 'run.barrier' | 'run.finish' | 'run.fail',
  ): RunRecord {
    this.policy.authorize(principal, action);
    return this.runs.apply(runId, event, expectedRevision, principal.actorId);
  }
}
const whichService = (principal: Principal): string =>
  principal.kind === 'service' ? principal.actorId : `service:platform-control(${principal.actorId})`;
