/** Persistent Work records: the employee's continuous task, with Runs as attempts under it. */
import { randomUUID } from 'node:crypto';
import { PlatformError } from './registry.js';
import { PlatformStore, type RunRecord, type WorkRecord, type WorkState } from './store.js';

export interface WorkDraft {
  projectId: string;
  appId: string;
  appVersion: string;
  title: string;
  workspaceId?: string;
  goal?: string;
}
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

const text = (value: unknown, max: number, field: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new PlatformError('WORK_INVALID', field);
  }
  return value.trim();
};

export class WorkRepository {
  constructor(private readonly store: PlatformStore) {}

  create(draft: WorkDraft, actor: string): WorkRecord {
    if (!draft || typeof draft !== 'object') throw new PlatformError('WORK_INVALID');
    if (typeof draft.projectId !== 'string' || !PROJECT.test(draft.projectId)) {
      throw new PlatformError('WORK_INVALID', 'projectId');
    }
    if (typeof draft.appId !== 'string' || !IDENTIFIER.test(draft.appId)) {
      throw new PlatformError('WORK_INVALID', 'appId');
    }
    if (typeof draft.appVersion !== 'string' || !IDENTIFIER.test(draft.appVersion)) {
      throw new PlatformError('WORK_INVALID', 'appVersion');
    }
    const title = text(draft.title, 200, 'title');
    const goal = draft.goal === undefined ? undefined : text(draft.goal, 100_000, 'goal');
    if (draft.workspaceId !== undefined) {
      const workspace = this.store.workspaceGet(draft.workspaceId);
      if (!workspace || workspace.projectId !== draft.projectId) {
        throw new PlatformError('WORKSPACE_PROJECT_MISMATCH');
      }
    }
    const now = new Date().toISOString();
    const record: WorkRecord = {
      workId: randomUUID(),
      projectId: draft.projectId,
      ...(draft.workspaceId !== undefined ? { workspaceId: draft.workspaceId } : {}),
      ...(goal !== undefined ? { goal } : {}),
      appId: draft.appId,
      appVersion: draft.appVersion,
      title,
      createdBy: actor,
      state: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    return this.store.transaction(() => {
      this.store.workInsert(record);
      this.store.audit(actor, 'WORK_CREATED', record.workId, {
        projectId: record.projectId,
        appId: record.appId,
        appVersion: record.appVersion,
      });
      return record;
    });
  }

  get(workId: string): WorkRecord {
    const record = this.store.workGet(workId);
    if (!record) throw new PlatformError('WORK_NOT_FOUND', workId);
    return record;
  }

  list(state: WorkState | undefined, offset: number, limit: number, projectIds?: string[]): { items: WorkRecord[]; total: number } {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new PlatformError('WORK_PAGE_INVALID');
    }
    if (state !== undefined && state !== 'ACTIVE' && state !== 'ARCHIVED') {
      throw new PlatformError('WORK_STATE_INVALID', String(state));
    }
    return this.store.workList(state, offset, limit, projectIds);
  }

  archive(workId: string, actor: string): WorkRecord {
    return this.store.transaction(() => {
      const current = this.get(workId);
      if (current.state === 'ARCHIVED') return current;
      const next: WorkRecord = { ...current, state: 'ARCHIVED', updatedAt: new Date().toISOString() };
      this.store.workUpdate(next);
      this.store.audit(actor, 'WORK_ARCHIVED', workId, { from: current.state, to: next.state });
      return next;
    });
  }

  /** Same-Work admission rule: one active Run at a time. */
  requireNoActiveRun(workId: string): void {
    const active = this.store.activeRunForWork(workId);
    if (active) throw new PlatformError('WORK_ACTIVE_RUN_EXISTS', `${active.runId}:${active.snapshot.state}`);
  }

  activeRun(workId: string): RunRecord | undefined {
    return this.store.activeRunForWork(workId);
  }
}
