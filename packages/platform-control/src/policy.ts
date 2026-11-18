/** Local single-operator policy. A deployment replaces this with its identity and project authorization
 *  service; plugin/tool arguments never carry an actor. */
export interface Principal {
  actorId: string;
  kind: 'operator' | 'service';
  /** Owning organization when the identity source supplies one; used to reject cross-org scope. */
  orgId?: string;
}
export type PlatformAction =
  | 'app.register'
  | 'app.approve'
  | 'app.revoke'
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
  | 'evaluation.read';
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
export interface PlatformPolicy {
  authorize(principal: Principal, action: PlatformAction, resource?: ResourceScope): void;
}
const operatorActions = new Set<PlatformAction>([
  'app.register',
  'app.approve',
  'app.revoke',
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
  constructor(options: { allowedApps?: string[]; allowedModels?: string[] } = {}) {
    this.allowedApps = options.allowedApps ? new Set(options.allowedApps) : undefined;
    this.allowedModels = options.allowedModels ? new Set(options.allowedModels) : undefined;
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
    // A principal with an organization may not act on another organization's scope.
    if (principal.orgId !== undefined && resource?.orgId !== undefined && principal.orgId !== resource.orgId) {
      throw new AuthorizationError('PLATFORM_ORG_ACCESS_DENIED', resource.orgId);
    }
  }
}
