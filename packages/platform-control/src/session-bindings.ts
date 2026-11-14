/** Execution domains and Work↔Session bindings (T03).
 *
 *  These are enterprise relationships the native Session log does not own: which controlled
 *  execution domain a Work runs in, and which native Session the Work is currently associated
 *  with. Invariants enforced here (docs/NATIVE-WEBUI-ENTERPRISE-WORKBENCH-IMPLEMENTATION.md §3.1):
 *  - one current primary binding per Work;
 *  - a domain-local Session association is unique across Works;
 *  - fork/reopen bindings are explicit and never overwrite the original;
 *  - session facts are authoritative: the caller passes the real sessionId the native create
 *    returned, never a request id.
 */
import { randomUUID } from 'node:crypto';
import { PlatformError } from './registry.js';
import {
  PlatformStore,
  type BindingRelation,
  type ExecutionDomainKind,
  type ExecutionDomainRecord,
  type ExecutionDomainState,
  type WorkSessionBindingRecord,
} from './store.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const DOMAIN_STATES: ExecutionDomainState[] = ['HEALTHY', 'DEGRADED', 'UNKNOWN'];
const RELATIONS: BindingRelation[] = ['primary', 'fork', 'reopened'];

const requireIdentifier = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new PlatformError('DOMAIN_INVALID', field);
  return value;
};

export interface ExecutionDomainDraft {
  owner: string;
  kind: ExecutionDomainKind;
  deploymentRef?: string;
  capabilities: string[];
}

export class ExecutionDomainRepository {
  constructor(private readonly store: PlatformStore) {}

  /** Public metadata only: never accepts credentials or arbitrary proxy addresses. */
  register(draft: ExecutionDomainDraft, actor: string): ExecutionDomainRecord {
    if (!draft || typeof draft !== 'object') throw new PlatformError('DOMAIN_INVALID');
    if (draft.kind !== 'local' && draft.kind !== 'hosted') throw new PlatformError('DOMAIN_INVALID', 'kind');
    const owner = requireIdentifier(draft.owner, 'owner');
    if (draft.deploymentRef !== undefined && (typeof draft.deploymentRef !== 'string' ||
        draft.deploymentRef.length > 400 || /[\u0000-\u001f]/.test(draft.deploymentRef))) {
      throw new PlatformError('DOMAIN_INVALID', 'deploymentRef');
    }
    const capabilities = Array.isArray(draft.capabilities)
      ? draft.capabilities.map((capability) => requireIdentifier(capability, 'capability'))
      : [];
    if (new Set(capabilities).size !== capabilities.length) throw new PlatformError('DOMAIN_INVALID', 'duplicate capability');
    const now = new Date().toISOString();
    const record: ExecutionDomainRecord = {
      domainId: randomUUID(),
      owner,
      kind: draft.kind,
      ...(draft.deploymentRef !== undefined ? { deploymentRef: draft.deploymentRef } : {}),
      capabilities,
      state: 'UNKNOWN',
      revision: 1,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.transaction(() => {
      this.store.domainInsert(record);
      this.store.audit(actor, 'EXECUTION_DOMAIN_REGISTERED', record.domainId, {
        owner: record.owner, kind: record.kind, capabilities: record.capabilities.length,
      });
      return record;
    });
  }

  get(domainId: string): ExecutionDomainRecord {
    const record = this.store.domainGet(domainId);
    if (!record) throw new PlatformError('DOMAIN_NOT_FOUND', domainId);
    return record;
  }

  list(owner: string): ExecutionDomainRecord[] {
    return this.store.domainList(owner);
  }

  /** Health is a deployment observation, never inferred from a request. */
  setState(domainId: string, state: ExecutionDomainState, expectedRevision: number, actor: string): ExecutionDomainRecord {
    if (!DOMAIN_STATES.includes(state)) throw new PlatformError('DOMAIN_INVALID', 'state');
    return this.store.transaction(() => {
      const current = this.get(domainId);
      const next: ExecutionDomainRecord = {
        ...current, state, revision: current.revision + 1, updatedAt: new Date().toISOString(),
      };
      if (!this.store.domainUpdate(next, expectedRevision)) throw new PlatformError('DOMAIN_REVISION_STALE', domainId);
      this.store.audit(actor, 'EXECUTION_DOMAIN_HEALTH', domainId, { from: current.state, to: state, revision: next.revision });
      return next;
    });
  }
}

export interface BindWorkSessionDraft {
  workId: string;
  domainId: string;
  /** The real native session id returned by the native create; never a request id. */
  sessionId: string;
  releaseDigest: string;
  workspaceId?: string;
  relation?: BindingRelation;
  sourceWorkId?: string;
}

export class WorkSessionBindingRepository {
  constructor(private readonly store: PlatformStore) {}

  /**
   * Bind a Work to a native Session.
   *
   * The first association for a Work is `primary` (relation input is ignored/forced to primary).
   * A subsequent `primary` binding demotes the previous primary to `reopened` so exactly one
   * primary remains, but never deletes the old association. `fork`/`reopened` are recorded as
   * additional associations and do not displace the primary.
   */
  bind(draft: BindWorkSessionDraft, actor: string): WorkSessionBindingRecord {
    if (!draft || typeof draft !== 'object') throw new PlatformError('BINDING_INVALID');
    const workId = requireIdentifier(draft.workId, 'workId');
    const domainId = requireIdentifier(draft.domainId, 'domainId');
    const sessionId = requireIdentifier(draft.sessionId, 'sessionId');
    const releaseDigest = typeof draft.releaseDigest === 'string' && /^[A-Za-z0-9._:/-]{8,200}$/.test(draft.releaseDigest)
      ? draft.releaseDigest
      : (() => { throw new PlatformError('BINDING_INVALID', 'releaseDigest'); })();
    const relation = draft.relation ?? 'primary';
    if (!RELATIONS.includes(relation)) throw new PlatformError('BINDING_INVALID', 'relation');
    if (this.store.bindingForSession(domainId, sessionId) !== undefined) {
      // Domain-local association is unique across Works (except explicit read-only reference, which
      // is not modelled as a second binding here).
      throw new PlatformError('BINDING_SESSION_CONFLICT', `${domainId}:${sessionId}`);
    }
    return this.store.transaction(() => {
      const existing = this.store.primaryBindingForWork(workId);
      // Exactly one primary per Work: a new primary demotes the previous one, but fork/reopened
      // associations are explicit and may be a Work's only (or additional) binding.
      if (relation === 'primary' && existing !== undefined) {
        // Demote the old primary to `reopened` so the Work keeps a readable history.
        const demoted: WorkSessionBindingRecord = { ...existing, relation: 'reopened', revision: existing.revision + 1 };
        if (!this.store.bindingUpdate(demoted, existing.revision)) {
          throw new PlatformError('BINDING_REVISION_STALE', existing.bindingId);
        }
        this.store.audit(actor, 'WORK_SESSION_BINDING_DEMOTED', workId, {
          bindingId: existing.bindingId, from: 'primary', to: 'reopened',
        });
      }
      if ((relation === 'fork' || relation === 'reopened') && draft.sourceWorkId === undefined) {
        throw new PlatformError('BINDING_INVALID', 'sourceWorkId');
      }
      const now = new Date().toISOString();
      const record: WorkSessionBindingRecord = {
        bindingId: randomUUID(),
        workId,
        domainId,
        sessionId,
        ...(draft.workspaceId !== undefined ? { workspaceId: requireIdentifier(draft.workspaceId, 'workspaceId') } : {}),
        releaseDigest,
        relation,
        ...(draft.sourceWorkId !== undefined ? { sourceWorkId: requireIdentifier(draft.sourceWorkId, 'sourceWorkId') } : {}),
        revision: 1,
        createdBy: actor,
        createdAt: now,
      };
      this.store.bindingInsert(record);
      this.store.audit(actor, 'WORK_SESSION_BOUND', workId, {
        bindingId: record.bindingId, domainId, sessionId, relation: record.relation,
      });
      return record;
    });
  }

  /** Current primary binding, or the most recent association when a Work has only fork/reopened rows. */
  current(workId: string): WorkSessionBindingRecord | undefined {
    return this.store.primaryBindingForWork(workId) ?? this.store.bindingsForWork(workId).at(-1);
  }

  history(workId: string): WorkSessionBindingRecord[] {
    return this.store.bindingsForWork(workId);
  }

  forSession(domainId: string, sessionId: string): WorkSessionBindingRecord | undefined {
    return this.store.bindingForSession(domainId, sessionId);
  }
}
