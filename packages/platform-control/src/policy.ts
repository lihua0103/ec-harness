/** Local single-operator policy. A deployment replaces this with its identity and project authorization
 *  service; plugin/tool arguments never carry an actor. */
export interface Principal {
  actorId: string;
  kind: 'operator' | 'service';
  /** Owning organization when the identity source supplies one; used to reject cross-org scope. */
  orgId?: string;
  /** Owning region when the identity source supplies one; bound into knowledge snapshots. */
  region?: string;
}
export type PlatformAction =
  | 'app.register'
  | 'app.approve'
  | 'app.revoke'
  | 'app.default.set'
  | 'app.read'
  | 'run.create'
  | 'run.input'
  | 'run.cancel'
  | 'run.answer'
  | 'run.read'
  | 'run.reconcile'
  | 'run.review'
  | 'work.delivery'
  | 'delivery.read'
  | 'conversation.read'
  | 'run.dispatch'
  | 'run.started'
  | 'run.barrier'
  | 'run.finish'
  | 'run.fail'
  | 'run.cancel-settled'
  | 'model.read'
  | 'model.register'
  | 'model.preference'
  | 'model.approve'
  | 'work.create'
  | 'work.read'
  | 'work.input'
  | 'work.archive'
  | 'project.read'
  | 'project.create'
  | 'workspace.read'
  | 'workspace.create'
  | 'work.draft'
  | 'fs.pick'
  | 'audit.read'
  | 'metrics.read'
  | 'domain.register'
  | 'domain.read'
  | 'binding.bind'
  | 'binding.read'
  | 'submission.record'
  | 'submission.read'
  | 'evaluation.manage'
  | 'evaluation.read'
  // 学习平台（开发设计 §5）：个人偏好读写、学习个案/提案、知识发布清单治理。
  | 'preference.read'
  | 'preference.write'
  | 'learning.case.read'
  | 'learning.case.propose'
  | 'knowledge.release.read'
  | 'knowledge.release.publish'
  | 'knowledge.release.withdraw'
  | 'knowledge.release.rollback';
export interface ResourceScope {
  appId?: string;
  modelSelectionId?: string;
  projectId?: string;
  workspaceId?: string;
  workId?: string;
  domainId?: string;
  sessionId?: string;
  orgId?: string;
}
/** WP2: the deployment-level knowledge tenant scope, provided by the assembly/identity channel —
 *  never by a model or browser payload. `local` is the explicit standalone scope (single-machine
 *  deployments bind snapshots without tenant columns). `enterprise` declares the deployment's
 *  org/region ceiling; a run for a knowledge-declaring app without any resolvable trusted
 *  org/region fails diagnosably instead of silently binding cross-tenant records. */
export type KnowledgeDeploymentScope =
  | { mode: 'local' }
  | { mode: 'enterprise'; orgId?: string; region?: string };
/** The trusted tenant scope actually bound into a Run knowledge snapshot. */
export interface KnowledgeTenantScope {
  orgId?: string;
  region?: string;
}
export interface PlatformPolicy {
  authorize(principal: Principal, action: PlatformAction, resource?: ResourceScope): void;
  /** R2 (W2): the exact set of project ids this principal may see, or null when the policy
   *  imposes no project restriction. List, search and pagination filters apply it server-side
   *  before any page is built; a policy that omits this is probed per project via authorize. */
  visibleProjects?(principal: Principal): string[] | null;
}
const operatorActions = new Set<PlatformAction>([
  'app.register',
  'app.approve',
  'app.revoke',
  // Default-pointer management (W2/R6): a distinct action from 'app.revoke' so an ordinary
  // default switch or rollback can never ride the security-revocation write path.
  'app.default.set',
  'app.read',
  'run.create',
  'run.input',
  'run.cancel',
  'run.answer',
  'run.read',
  'run.reconcile',
  'run.review',
  'work.delivery',
  'delivery.read',
  'conversation.read',
  'model.read',
  'model.register',
  'model.preference',
  'model.approve',
  'work.create',
  'work.read',
  'work.input',
  'work.archive',
  'project.read',
  'project.create',
  'workspace.read',
  'workspace.create',
  'work.draft',
  'fs.pick',
  'audit.read',
  'metrics.read',
  'domain.register',
  'domain.read',
  'binding.bind',
  'binding.read',
  'submission.record',
  'submission.read',
  'evaluation.manage',
  'evaluation.read',
  'preference.read',
  'preference.write',
  'learning.case.read',
  'learning.case.propose',
  'knowledge.release.read',
  'knowledge.release.publish',
  'knowledge.release.withdraw',
  'knowledge.release.rollback',
]);
const serviceActions = new Set<PlatformAction>([
  'run.read',
  'run.input',
  'run.dispatch',
  'run.started',
  'run.barrier',
  'run.finish',
  'run.fail',
  'run.cancel',
  'run.cancel-settled',
  'model.read',
  'work.read',
  'binding.read',
]);

export class AuthorizationError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export class LocalOperatorPolicy implements PlatformPolicy {
  private readonly allowedApps?: Set<string>;
  private readonly allowedModels?: Set<string>;
  private readonly allowedProjects?: Set<string>;
  constructor(
    options: { allowedApps?: string[]; allowedModels?: string[]; allowedProjects?: string[] } = {},
  ) {
    this.allowedApps = options.allowedApps ? new Set(options.allowedApps) : undefined;
    this.allowedModels = options.allowedModels ? new Set(options.allowedModels) : undefined;
    this.allowedProjects = options.allowedProjects ? new Set(options.allowedProjects) : undefined;
  }
  authorize(principal: Principal, action: PlatformAction, resource?: ResourceScope): void {
    const allowed = principal.kind === 'operator' ? operatorActions : serviceActions;
    if (!allowed.has(action)) throw new AuthorizationError('PLATFORM_AUTHORIZATION_DENIED', action);
    if (this.allowedModels && resource?.modelSelectionId && !this.allowedModels.has(resource.modelSelectionId)) {
      throw new AuthorizationError('MODEL_SELECTION_UNKNOWN');
    }
    if (this.allowedApps && resource?.appId && !this.allowedApps.has(resource.appId)) {
      throw new AuthorizationError('PLATFORM_APP_ACCESS_DENIED', resource.appId);
    }
    // R2 (W2): project membership is resolved server-side from resource ownership. Any scope
    // carrying a projectId outside the allowed set is denied — including workspace-less Works,
    // whose projectId is looked up from the Work row, never from browser parameters.
    if (this.allowedProjects && resource?.projectId !== undefined && !this.allowedProjects.has(resource.projectId)) {
      throw new AuthorizationError('PLATFORM_PROJECT_ACCESS_DENIED', resource.projectId);
    }
    // A principal with an organization may not act on another organization's scope.
    if (principal.orgId !== undefined && resource?.orgId !== undefined && principal.orgId !== resource.orgId) {
      throw new AuthorizationError('PLATFORM_ORG_ACCESS_DENIED', resource.orgId);
    }
  }
  visibleProjects(_principal: Principal): string[] | null {
    return this.allowedProjects ? [...this.allowedProjects] : null;
  }
}
