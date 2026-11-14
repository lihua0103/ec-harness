/** Immutable input baselines for a Work (T07).
 *
 *  A new batch appends a new baseline; an old baseline is never rewritten. That keeps the inputs a
 *  given execution ran against reproducible even after the employee supplies newer material.
 */
import { randomUUID } from 'node:crypto';
import { PlatformError } from './registry.js';
import { PlatformStore, type InputBaselineRecord } from './store.js';

const DIGEST = /^[a-f0-9]{64}$/;

export interface InputBaselineDraft {
  workId: string;
  /** A stable source reference (directory digest, imported file set, etc.). */
  sourceRef: string;
  /** SHA-256 of the exact inputs this baseline covers. */
  digest: string;
}

export class InputBaselineRepository {
  constructor(private readonly store: PlatformStore) {}

  append(draft: InputBaselineDraft, actor: string): InputBaselineRecord {
    if (!draft || typeof draft !== 'object') throw new PlatformError('INPUT_BASELINE_INVALID');
    if (typeof draft.workId !== 'string' || !draft.workId) throw new PlatformError('INPUT_BASELINE_INVALID', 'workId');
    if (typeof draft.sourceRef !== 'string' || !draft.sourceRef || draft.sourceRef.length > 2000) {
      throw new PlatformError('INPUT_BASELINE_INVALID', 'sourceRef');
    }
    if (typeof draft.digest !== 'string' || !DIGEST.test(draft.digest)) {
      throw new PlatformError('INPUT_BASELINE_INVALID', 'digest');
    }
    return this.store.transaction(() => {
      const revision = this.store.baselineLatestRevision(draft.workId) + 1;
      const record: InputBaselineRecord = {
        baselineId: randomUUID(),
        workId: draft.workId,
        revision,
        sourceRef: draft.sourceRef,
        digest: draft.digest,
        createdBy: actor,
        createdAt: new Date().toISOString(),
      };
      this.store.baselineInsert(record);
      this.store.audit(actor, 'INPUT_BASELINE_APPENDED', draft.workId, { baselineId: record.baselineId, revision, digest: record.digest });
      return record;
    });
  }

  history(workId: string): InputBaselineRecord[] {
    return this.store.baselinesForWork(workId);
  }

  latest(workId: string): InputBaselineRecord | undefined {
    return this.store.baselinesForWork(workId).at(-1);
  }
}
