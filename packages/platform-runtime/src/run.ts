/** Minimal run lifecycle kernel: CAS transitions, persistent cancel intent, fencing token,
 *  completion barrier. It is pure state; process supervision and worker startup live outside. */
export type RunState = 'QUEUED' | 'STARTING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
export interface CompletionBarrier {
  inputsSettled: boolean;
  descendantsDone: boolean;
  artifactsRegistered: boolean;
  cleanedUp: boolean;
}
export interface RunSnapshot {
  runId: string;
  state: RunState;
  revision: number;
  cancelRequested: boolean;
  launchId?: string;
  fencingToken: number;
  barrier: CompletionBarrier;
  reason?: string;
}
export type RunEvent =
  | { type: 'cancel' }
  | { type: 'dispatch'; launchId: string; fencingToken: number }
  | { type: 'started' }
  | { type: 'barrier'; barrier: CompletionBarrier }
  | { type: 'finish' }
  | { type: 'fail'; reason: string }
  | { type: 'unknown'; reason: string }
  | { type: 'cancel-settled' };
export class RunError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
  }
}
const states: readonly RunState[] = ['QUEUED', 'STARTING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'];
const terminal = (state: RunState): boolean =>
  state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED' || state === 'UNKNOWN';
const emptyBarrier = (): CompletionBarrier => ({
  inputsSettled: false,
  descendantsDone: false,
  artifactsRegistered: false,
  cleanedUp: false,
});
const validRunId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value);

/** Validate a snapshot loaded from storage before it is allowed to drive transitions. */
export function validateSnapshot(snapshot: RunSnapshot): void {
  if (!snapshot || typeof snapshot !== 'object') throw new RunError('RUN_SNAPSHOT_INVALID');
  if (!validRunId(snapshot.runId)) throw new RunError('RUN_ID_INVALID');
  if (!states.includes(snapshot.state)) throw new RunError('RUN_STATE_INVALID', String(snapshot.state));
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) throw new RunError('RUN_REVISION_INVALID');
  if (typeof snapshot.cancelRequested !== 'boolean') throw new RunError('RUN_CANCEL_FLAG_INVALID');
  if (!Number.isSafeInteger(snapshot.fencingToken) || snapshot.fencingToken < 0) {
    throw new RunError('RUN_FENCING_TOKEN_INVALID');
  }
  if (snapshot.launchId !== undefined && !validRunId(snapshot.launchId)) {
    throw new RunError('RUN_LAUNCH_ID_INVALID');
  }
  const barrier = snapshot.barrier;
  if (!barrier || typeof barrier !== 'object') throw new RunError('RUN_BARRIER_INVALID');
  for (const key of ['inputsSettled', 'descendantsDone', 'artifactsRegistered', 'cleanedUp'] as const) {
    if (typeof barrier[key] !== 'boolean') throw new RunError('RUN_BARRIER_INVALID', key);
  }
}

/** Pure transition: callers persist the returned snapshot with a matching CAS revision. */
export function transition(current: RunSnapshot, event: RunEvent): RunSnapshot {
  validateSnapshot(current);
  if (terminal(current.state)) throw new RunError('RUN_TERMINAL', current.state);
  const next: RunSnapshot = { ...current, revision: current.revision + 1, barrier: { ...current.barrier } };
  switch (event.type) {
    case 'cancel':
      next.cancelRequested = true;
      if (current.state === 'QUEUED') next.state = 'CANCELLED';
      else if (current.state === 'STARTING' && !current.launchId) next.state = 'CANCELLED';
      break;
    case 'dispatch':
      if (current.state !== 'QUEUED') throw new RunError('RUN_DISPATCH_STATE_INVALID', current.state);
      if (current.cancelRequested) throw new RunError('RUN_CANCEL_REQUESTED');
      if (!validRunId(event.launchId)) throw new RunError('RUN_LAUNCH_ID_INVALID');
      if (!Number.isSafeInteger(event.fencingToken) || event.fencingToken <= current.fencingToken) {
        throw new RunError('RUN_FENCING_TOKEN_STALE');
      }
      next.state = 'STARTING';
      next.launchId = event.launchId;
      next.fencingToken = event.fencingToken;
      break;
    case 'started':
      if (current.state !== 'STARTING') throw new RunError('RUN_START_STATE_INVALID', current.state);
      next.state = 'RUNNING';
      break;
    case 'barrier':
      if (current.state !== 'RUNNING') throw new RunError('RUN_BARRIER_STATE_INVALID', current.state);
      next.barrier = { ...event.barrier };
      break;
    case 'finish':
      if (current.state !== 'RUNNING') throw new RunError('RUN_FINISH_STATE_INVALID', current.state);
      if (current.cancelRequested) throw new RunError('RUN_CANCEL_PENDING');
      if (!Object.values(current.barrier).every(Boolean)) {
        throw new RunError('RUN_COMPLETION_BARRIER_INCOMPLETE');
      }
      next.state = 'SUCCEEDED';
      break;
    case 'fail':
      if (!event.reason.trim()) throw new RunError('RUN_FAILURE_REASON_REQUIRED');
      next.state = 'FAILED';
      next.reason = event.reason;
      break;
    case 'unknown':
      if (!event.reason.trim()) throw new RunError('RUN_UNKNOWN_REASON_REQUIRED');
      next.state = 'UNKNOWN';
      next.reason = event.reason;
      break;
    case 'cancel-settled':
      if (!current.cancelRequested) throw new RunError('RUN_CANCEL_NOT_REQUESTED');
      if (current.state !== 'STARTING' && current.state !== 'RUNNING') {
        throw new RunError('RUN_CANCEL_SETTLE_STATE_INVALID', current.state);
      }
      next.state = 'CANCELLED';
      break;
    default:
      throw new RunError('RUN_EVENT_INVALID');
  }
  return next;
}

export class RunLedger {
  private snapshotValue: RunSnapshot;
  constructor(readonly runId: string, initial?: RunSnapshot) {
    if (!validRunId(runId)) throw new RunError('RUN_ID_INVALID');
    if (initial) {
      validateSnapshot(initial);
      if (initial.runId !== runId) throw new RunError('RUN_SNAPSHOT_RUN_ID_MISMATCH');
    }
    this.snapshotValue = initial
      ? { ...initial, barrier: { ...initial.barrier } }
      : {
          runId,
          state: 'QUEUED',
          revision: 1,
          cancelRequested: false,
          fencingToken: 0,
          barrier: emptyBarrier(),
        };
  }
  static fromSnapshot(snapshot: RunSnapshot): RunLedger {
    return new RunLedger(snapshot.runId, snapshot);
  }
  snapshot(): RunSnapshot {
    return { ...this.snapshotValue, barrier: { ...this.snapshotValue.barrier } };
  }
  /** Every accepted event advances revision; stale writers never overwrite newer facts. */
  apply(event: RunEvent, expectedRevision: number): RunSnapshot {
    const current = this.snapshotValue;
    if (expectedRevision !== current.revision) {
      throw new RunError('RUN_REVISION_STALE', `${expectedRevision} != ${current.revision}`);
    }
    const next = transition(current, event);
    this.snapshotValue = next;
    return this.snapshot();
  }
}