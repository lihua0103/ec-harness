/** Pure workbench contracts shared by the Host and browser halves (T02/T06).
 *
 *  Nothing here touches React, the DOM or a concrete transport: it validates the control-plane
 *  `resolveWorkContext` payload and decides which native Session an "open work" action should
 *  select. Keeping it dependency-free makes the selection rules unit-testable without a browser,
 *  and keeps the client half from inventing a second conversation state machine.
 */

export interface WorkContextApp {
  appId: string;
  appVersion: string;
  releaseDigest: string;
  displayName: string;
}

export interface WorkContextBinding {
  bindingId: string;
  workId: string;
  domainId: string;
  sessionId: string;
  workspaceId?: string;
  releaseDigest: string;
  relation: 'primary' | 'fork' | 'reopened';
  revision: number;
  createdBy: string;
  createdAt: string;
}

export interface WorkContextDomain {
  domainId: string;
  owner: string;
  kind: 'local' | 'hosted';
  state: 'HEALTHY' | 'DEGRADED' | 'UNKNOWN';
  revision: number;
}

/** Validated shape of `GET /api/works/:id/context`. */
export interface WorkContext {
  work: { workId: string; title: string; state: 'ACTIVE' | 'ARCHIVED'; projectId: string; appId: string };
  project: { projectId: string; name: string };
  workspace: { workspaceId: string; name: string; directory: string } | null;
  app: WorkContextApp;
  binding: WorkContextBinding | null;
  domain: WorkContextDomain | null;
  sessionId: string | null;
}

export type OpenTarget =
  | { kind: 'open-session'; sessionId: string; domainId: string }
  | { kind: 'needs-binding'; workId: string; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Validate the control-plane payload into a WorkContext.
 * A malformed response is refused rather than coerced, so the UI can show an honest error
 * instead of opening a wrong or empty conversation.
 */
export function parseWorkContext(raw: unknown): WorkContext {
  if (!isObject(raw)) throw new Error('WORK_CONTEXT_INVALID');
  const work = raw.work;
  if (!isObject(work) || !isString(work.workId) || !isString(work.title)) {
    throw new Error('WORK_CONTEXT_INVALID:work');
  }
  if (work.state !== 'ACTIVE' && work.state !== 'ARCHIVED') throw new Error('WORK_CONTEXT_INVALID:work.state');
  const project = raw.project;
  if (!isObject(project) || !isString(project.projectId) || !isString(project.name)) {
    throw new Error('WORK_CONTEXT_INVALID:project');
  }
  let workspace: WorkContext['workspace'] = null;
  if (raw.workspace !== null && raw.workspace !== undefined) {
    const value = raw.workspace;
    if (!isObject(value) || !isString(value.workspaceId) || !isString(value.directory)) {
      throw new Error('WORK_CONTEXT_INVALID:workspace');
    }
    workspace = {
      workspaceId: value.workspaceId,
      name: isString(value.name) ? value.name : value.workspaceId,
      directory: value.directory,
    };
  }
  const app = raw.app;
  if (!isObject(app) || !isString(app.appId) || !isString(app.appVersion)) {
    throw new Error('WORK_CONTEXT_INVALID:app');
  }
  let binding: WorkContextBinding | null = null;
  if (raw.binding !== null && raw.binding !== undefined) {
    const value = raw.binding;
    if (!isObject(value) || !isString(value.sessionId) || !isString(value.domainId)) {
      throw new Error('WORK_CONTEXT_INVALID:binding');
    }
    const relation = value.relation;
    if (relation !== 'primary' && relation !== 'fork' && relation !== 'reopened') {
      throw new Error('WORK_CONTEXT_INVALID:binding.relation');
    }
    binding = {
      bindingId: isString(value.bindingId) ? value.bindingId : '',
      workId: isString(value.workId) ? value.workId : work.workId,
      domainId: value.domainId,
      sessionId: value.sessionId,
      ...(isString(value.workspaceId) ? { workspaceId: value.workspaceId } : {}),
      releaseDigest: isString(value.releaseDigest) ? value.releaseDigest : '',
      relation,
      revision: typeof value.revision === 'number' ? value.revision : 1,
      createdBy: isString(value.createdBy) ? value.createdBy : '',
      createdAt: isString(value.createdAt) ? value.createdAt : '',
    };
  }
  let domain: WorkContextDomain | null = null;
  if (raw.domain !== null && raw.domain !== undefined) {
    const value = raw.domain;
    if (!isObject(value) || !isString(value.domainId)) throw new Error('WORK_CONTEXT_INVALID:domain');
    const state = value.state;
    if (state !== 'HEALTHY' && state !== 'DEGRADED' && state !== 'UNKNOWN') {
      throw new Error('WORK_CONTEXT_INVALID:domain.state');
    }
    domain = {
      domainId: value.domainId,
      owner: isString(value.owner) ? value.owner : '',
      kind: value.kind === 'hosted' ? 'hosted' : 'local',
      state,
      revision: typeof value.revision === 'number' ? value.revision : 1,
    };
  }
  return {
    work: {
      workId: work.workId,
      title: work.title,
      state: work.state,
      projectId: isString(work.projectId) ? work.projectId : project.projectId,
      appId: isString(work.appId) ? work.appId : app.appId,
    },
    project: { projectId: project.projectId, name: project.name },
    workspace,
    app: {
      appId: app.appId,
      appVersion: app.appVersion,
      releaseDigest: isString(app.releaseDigest) ? app.releaseDigest : '',
      displayName: isString(app.displayName) ? app.displayName : app.appId,
    },
    binding,
    domain,
    sessionId: isString(raw.sessionId) ? raw.sessionId : (binding?.sessionId ?? null),
  };
}

/**
 * Decide the native action for "open work".
 * A Work without a binding is an honest "needs binding", not a silent new conversation.
 */
export function resolveOpenTarget(context: WorkContext): OpenTarget {
  if (context.binding && context.sessionId) {
    return { kind: 'open-session', sessionId: context.sessionId, domainId: context.binding.domainId };
  }
  return {
    kind: 'needs-binding',
    workId: context.work.workId,
    reason: context.workspace
      ? '此工作尚未关联原生会话；绑定会话后才能继续。'
      : '此工作尚未选择工作空间；请先在工作台中绑定空间与会话。',
  };
}

/** A deep link is usable only when it names this Work's own bound session. */
export function isBoundDeepLink(context: WorkContext, requested: { sessionId?: string; domainId?: string }): boolean {
  if (!context.binding) return false;
  if (requested.sessionId !== undefined && requested.sessionId !== context.binding.sessionId) return false;
  if (requested.domainId !== undefined && requested.domainId !== context.binding.domainId) return false;
  return true;
}

export interface BindingDomain {
  domainId: string;
  kind: 'local' | 'hosted';
  state: 'HEALTHY' | 'DEGRADED' | 'UNKNOWN';
}

/**
 * Pick the execution domain a new binding should use. Local and healthy wins; a missing or
 * malformed list yields null so the caller registers one instead of inventing an id.
 */
export function selectBindingDomain(items: readonly unknown[]): BindingDomain | null {
  const domains: BindingDomain[] = [];
  for (const raw of items) {
    if (!isObject(raw) || !isString(raw.domainId)) continue;
    domains.push({
      domainId: raw.domainId,
      kind: raw.kind === 'hosted' ? 'hosted' : 'local',
      state: raw.state === 'HEALTHY' || raw.state === 'DEGRADED' ? raw.state : 'UNKNOWN',
    });
  }
  return domains.find((domain) => domain.state === 'HEALTHY' && domain.kind === 'local')
    ?? domains.find((domain) => domain.state === 'HEALTHY')
    ?? domains.find((domain) => domain.kind === 'local')
    ?? domains[0]
    ?? null;
}

export interface BindingDraft {
  domainId: string;
  sessionId: string;
  releaseDigest: string;
  workspaceId: string;
}

/**
 * Build the control plane's bind request from facts the Work context actually carries.
 * A missing workspace or release digest is refused here rather than sent as a partial binding.
 */
export function bindingDraft(context: WorkContext, domainId: string, sessionId: string): BindingDraft {
  if (!context.workspace) throw new Error('BINDING_WORKSPACE_REQUIRED');
  if (!isString(sessionId)) throw new Error('BINDING_SESSION_REQUIRED');
  if (!isString(domainId)) throw new Error('BINDING_DOMAIN_REQUIRED');
  if (!/^[A-Za-z0-9._:/-]{8,200}$/.test(context.app.releaseDigest)) throw new Error('BINDING_RELEASE_DIGEST_MISSING');
  return {
    domainId,
    sessionId,
    releaseDigest: context.app.releaseDigest,
    workspaceId: context.workspace.workspaceId,
  };
}
