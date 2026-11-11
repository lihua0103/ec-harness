/** Persistent runs: every transition is CAS-checked, evented and audited. */
import { createHash, randomUUID } from 'node:crypto';
import { RunLedger, type RunEvent } from '../../platform-runtime/src/run.js';
import { PlatformError } from './registry.js';
import { PlatformStore, type AppRecord, type InputCommit, type RunRecord } from './store.js';

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
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const MAX_INPUT_BYTES = 1024 * 1024;

export class RunRepository {
  constructor(private readonly store: PlatformStore) {}

  create(app: AppRecord, input: unknown, actor: string): RunRecord {
    const inputBody = canonical(input);
    if (Buffer.byteLength(inputBody, 'utf8') > MAX_INPUT_BYTES) throw new PlatformError('RUN_INPUT_TOO_LARGE');
    const runId = randomUUID();
    const ledger = new RunLedger(runId);
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId,
      appId: app.appId,
      appVersion: app.appVersion,
      releaseDigest: app.releaseDigest,
      planDigest: app.plan.planDigest,
      inputDigest: digest(input),
      input: JSON.parse(inputBody),
      snapshot: ledger.snapshot(),
      createdAt: now,
      updatedAt: now,
    };
    return this.store.transaction(() => {
      this.store.runInsert(record);
      this.store.inputInsert({
        commitId: randomUUID(),
        runId,
        sequence: 1,
        contentDigest: record.inputDigest,
        body: record.input,
        state: 'PENDING',
        createdAt: now,
      });
      this.store.audit(actor, 'RUN_CREATED', runId, {
        appId: app.appId,
        appVersion: app.appVersion,
        releaseDigest: app.releaseDigest,
        planDigest: app.plan.planDigest,
        inputDigest: record.inputDigest,
      });
      return record;
    });
  }

  get(runId: string): RunRecord {
    const record = this.store.runGet(runId);
    if (!record) throw new PlatformError('RUN_NOT_FOUND', runId);
    return record;
  }

  list(appId: string | undefined, offset: number, limit: number): { items: RunRecord[]; total: number } {
    if (offset < 0 || limit < 1 || limit > 100) throw new PlatformError('RUN_PAGE_INVALID');
    return this.store.runList(appId, offset, limit);
  }

  apply(runId: string, event: RunEvent, expectedRevision: number, actor: string): RunRecord {
    return this.store.transaction(() => {
      const current = this.get(runId);
      const ledger = RunLedger.fromSnapshot(current.snapshot);
      const snapshot = ledger.apply(event, expectedRevision);
      const next = this.store.runUpdate(snapshot, expectedRevision, event, actor);
      if (event.type === 'dispatch' && snapshot.launchId) {
        this.store.attemptInsert({
          launchId: snapshot.launchId,
          runId,
          fencingToken: snapshot.fencingToken,
          state: 'STARTING',
          startedAt: next.updatedAt,
        });
      } else if (snapshot.launchId) {
        if (event.type === 'started') this.store.attemptUpdate(snapshot.launchId, 'RUNNING');
        else if (event.type === 'finish') this.store.attemptUpdate(snapshot.launchId, 'SUCCEEDED');
        else if (event.type === 'fail')
          this.store.attemptUpdate(snapshot.launchId, 'FAILED', (event as { reason?: string }).reason);
        else if (event.type === 'cancel-settled') this.store.attemptUpdate(snapshot.launchId, 'CANCELLED');
      }
      this.store.audit(actor, `RUN_${event.type.replaceAll('-', '_').toUpperCase()}`, runId, {
        from: current.snapshot.state,
        to: snapshot.state,
        revision: snapshot.revision,
      });
      return next;
    });
  }

  events(runId: string, offset: number, limit: number) {
    this.get(runId);
    if (offset < 0 || limit < 1 || limit > 100) throw new PlatformError('RUN_PAGE_INVALID');
    return this.store.runEvents(runId, offset, limit);
  }
  appendInput(runId: string, input: unknown, actor: string): InputCommit {
    const inputBody = canonical(input);
    if (Buffer.byteLength(inputBody, 'utf8') > MAX_INPUT_BYTES) throw new PlatformError('RUN_INPUT_TOO_LARGE');
    return this.store.transaction(() => {
      const run = this.get(runId);
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.snapshot.state)) {
        throw new PlatformError('RUN_TERMINAL', run.snapshot.state);
      }
      if (run.snapshot.cancelRequested) throw new PlatformError('RUN_CANCEL_REQUESTED');
      const sequence = this.store.inputNextSequence(runId);
      const commit: InputCommit = {
        commitId: randomUUID(),
        runId,
        sequence,
        contentDigest: digest(input),
        body: JSON.parse(inputBody),
        state: 'PENDING',
        createdAt: new Date().toISOString(),
      };
      this.store.inputInsert(commit);
      this.store.audit(actor, 'RUN_INPUT_APPENDED', runId, {
        commitId: commit.commitId,
        sequence: commit.sequence,
        contentDigest: commit.contentDigest,
      });
      return commit;
    });
  }
  inputs(runId: string, offset: number, limit: number) {
    this.get(runId);
    if (offset < 0 || limit < 1 || limit > 100) throw new PlatformError('RUN_PAGE_INVALID');
    return this.store.inputs(runId, offset, limit);
  }
}
