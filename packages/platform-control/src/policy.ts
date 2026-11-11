/** Local single-operator policy. A deployment replaces this with its identity and project authorization
 *  service; plugin/tool arguments never carry an actor. */
export interface Principal {
  actorId: string;
  kind: 'operator' | 'service';
}
export type PlatformAction =
  | 'app.register'
  | 'app.revoke'
  | 'app.read'
  | 'run.create'
  | 'run.input'
  | 'run.cancel'
  | 'run.read'
  | 'run.dispatch'
  | 'run.started'
  | 'run.barrier'
  | 'run.finish'
  | 'run.fail'
  | 'run.cancel-settled'
  | 'audit.read';
export interface ResourceScope {
  appId?: string;
}
export interface PlatformPolicy {
  authorize(principal: Principal, action: PlatformAction, resource?: ResourceScope): void;
}
const operatorActions = new Set<PlatformAction>([
  'app.register',
  'app.revoke',
  'app.read',
  'run.create',
  'run.input',
  'run.cancel',
  'run.read',
  'audit.read',
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
  constructor(options: { allowedApps?: string[] } = {}) {
    this.allowedApps = options.allowedApps ? new Set(options.allowedApps) : undefined;
  }
  authorize(principal: Principal, action: PlatformAction, resource?: ResourceScope): void {
    const allowed = principal.kind === 'operator' ? operatorActions : serviceActions;
    if (!allowed.has(action)) throw new AuthorizationError('PLATFORM_AUTHORIZATION_DENIED', action);
    if (this.allowedApps && resource?.appId && !this.allowedApps.has(resource.appId)) {
      throw new AuthorizationError('PLATFORM_APP_ACCESS_DENIED', resource.appId);
    }
  }
}
