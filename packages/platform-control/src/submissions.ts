/** Trusted submission intents (T05).
 *
 *  A Submission records the *enterprise intent* to prompt one already-bound native Session.
 *  It is keyed by the native `requestId`, so a retry of the same click collapses onto the same
 *  intent instead of creating a second one (§3.1 uniqueness). Admission/consumption stay native
 *  facts: the repository only records what the trusted Host entry observed, at the documented
 *  fault cut points (§3.3). It never claims a prompt executed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { PlatformError } from './registry.js';
import { PlatformStore, type SubmissionRecord, type SubmissionState } from './store.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const STATES: SubmissionState[] = ['RECORDED', 'ACCEPTED', 'CONSUMED', 'UNKNOWN', 'REJECTED'];

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]]));
    }
    return item;
  });

const requireIdentifier = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new PlatformError('SUBMISSION_INVALID', field);
  return value;
};

export interface SubmissionDraft {
  workId: string;
  domainId: string;
  sessionId: string;
  requestId: string;
  /** Trusted submitter already resolved by the transport; never a client/model-supplied actor. */
  submittedBy: string;
  orgId?: string;
  /** The prompt body the employee submitted; hashed, never echoed in projections. */
  input: unknown;
}

export class SubmissionRepository {
  constructor(private readonly store: PlatformStore) {}

  /**
   * Record one submission intent, idempotent on (domainId, sessionId, requestId).
   * Returns the existing intent when this click is a retry, so a duplicate UI action cannot
   * produce two executions.
   */
  record(draft: SubmissionDraft, actor: string): SubmissionRecord {
    if (!draft || typeof draft !== 'object') throw new PlatformError('SUBMISSION_INVALID');
    const workId = requireIdentifier(draft.workId, 'workId');
    const domainId = requireIdentifier(draft.domainId, 'domainId');
    const sessionId = requireIdentifier(draft.sessionId, 'sessionId');
    if (typeof draft.requestId !== 'string' || !REQUEST_ID.test(draft.requestId)) {
      throw new PlatformError('SUBMISSION_INVALID', 'requestId');
    }
    const submittedBy = requireIdentifier(draft.submittedBy, 'submittedBy');
    if (draft.orgId !== undefined) requireIdentifier(draft.orgId, 'orgId');
    const inputDigest = createHash('sha256').update(canonical(draft.input ?? null)).digest('hex');
    return this.store.transaction(() => {
      const existing = this.store.submissionByRequest(domainId, sessionId, draft.requestId);
      if (existing) {
        if (existing.inputDigest !== inputDigest) {
          // Same requestId, different content is a client defect: refuse rather than fork the intent.
          throw new PlatformError('SUBMISSION_REQUEST_REUSED', draft.requestId);
        }
        return existing;
      }
      const now = new Date().toISOString();
      const record: SubmissionRecord = {
        submissionId: randomUUID(),
        workId,
        domainId,
        sessionId,
        requestId: draft.requestId,
        inputDigest,
        submittedBy,
        ...(draft.orgId !== undefined ? { orgId: draft.orgId } : {}),
        state: 'RECORDED',
        createdAt: now,
        updatedAt: now,
      };
      this.store.submissionInsert(record);
      this.store.audit(actor, 'SUBMISSION_RECORDED', workId, {
        submissionId: record.submissionId, domainId, sessionId, requestId: record.requestId,
      });
      return record;
    });
  }

  /** Cut point 2→3: the native Host accepted the prompt; admission evidence is recorded. */
  markAccepted(submissionId: string, admission: string, actor: string): SubmissionRecord {
    if (typeof admission !== 'string' || !admission) throw new PlatformError('SUBMISSION_INVALID', 'admission');
    return this.advance(submissionId, 'RECORDED', { state: 'ACCEPTED', admission }, actor, 'SUBMISSION_ACCEPTED');
  }

  /** Cut point 4: a native event proves the prompt was consumed; not merely accepted. */
  markConsumed(submissionId: string, actor: string): SubmissionRecord {
    return this.advance(submissionId, 'ACCEPTED', { state: 'CONSUMED', consumedAt: new Date().toISOString() }, actor, 'SUBMISSION_CONSUMED');
  }

  /** Receipt lost: keep it honestly UNKNOWN, never auto-replay. Reconciliation is explicit. */
  markUnknown(submissionId: string, note: string, actor: string): SubmissionRecord {
    const record = this.require(submissionId);
    if (record.state === 'CONSUMED' || record.state === 'REJECTED') return record;
    return this.advance(submissionId, record.state, { state: 'UNKNOWN' }, actor, 'SUBMISSION_UNKNOWN', note);
  }

  get(submissionId: string): SubmissionRecord | undefined {
    return this.store.submissionGet(submissionId);
  }

  forRequest(domainId: string, sessionId: string, requestId: string): SubmissionRecord | undefined {
    return this.store.submissionByRequest(domainId, sessionId, requestId);
  }

  forWork(workId: string): SubmissionRecord[] {
    return this.store.submissionsForWork(workId);
  }

  private require(submissionId: string): SubmissionRecord {
    const record = this.store.submissionGet(submissionId);
    if (!record) throw new PlatformError('SUBMISSION_NOT_FOUND', submissionId);
    return record;
  }

  private advance(
    submissionId: string,
    expectedState: SubmissionState,
    patch: Partial<SubmissionRecord>,
    actor: string,
    action: string,
    detail?: string,
  ): SubmissionRecord {
    return this.store.transaction(() => {
      const current = this.require(submissionId);
      if (!STATES.includes(expectedState)) throw new PlatformError('SUBMISSION_INVALID', 'state');
      const next: SubmissionRecord = {
        ...current,
        ...patch,
        state: (patch.state ?? current.state) as SubmissionState,
        updatedAt: new Date().toISOString(),
      };
      if (!this.store.submissionUpdate(next, expectedState)) {
        throw new PlatformError('SUBMISSION_STATE_STALE', `${submissionId}:${current.state}`);
      }
      this.store.audit(actor, action, current.workId, {
        submissionId, from: current.state, to: next.state, ...(detail ? { note: detail } : {}),
      });
      return next;
    });
  }
}
