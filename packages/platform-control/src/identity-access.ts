/** Identity/project-access policy seam (T04).
 *
 *  The control plane never trusts an actor, organization or project supplied by a model or a
 *  browser payload: the transport authenticates and passes a Principal, and this policy asks an
 *  injected directory whether that Principal may touch a project's data. The directory port is
 *  implemented by the deployment (an adapter over the existing identity/project API, or an
 *  in-memory test double); platform-identity owns the resolution rules and is not duplicated here.
 *
 *  A service principal never inherits operator project access; orgIds must agree. Missing real
 *  identity APIs means the deployment supplies a clearly-labelled test adapter, never a default
 *  allow-all that could be mistaken for production authentication.
 */
import {
  AuthorizationError,
  LocalOperatorPolicy,
  type PlatformAction,
  type PlatformPolicy,
  type Principal,
  type ResourceScope,
} from './policy.js';

/** The deployment-supplied project authorization source (IT/API directory in production). */
export interface ProjectAccessDirectory {
  /** Throws (or returns false) when this principal may not access this project. */
  allows(principal: Principal, projectId: string): boolean | void;
}

export interface DirectoryAccessPolicyOptions {
  /** Action-kind baseline; defaults to the local single-operator policy. */
  base?: PlatformPolicy;
  /** True for a test-only directory so a deployment cannot accidentally present it as SSO. */
  testAdapter?: boolean;
}

export class DirectoryAccessPolicy implements PlatformPolicy {
  private readonly base: PlatformPolicy;
  constructor(
    private readonly directory: ProjectAccessDirectory,
    options: DirectoryAccessPolicyOptions = {},
  ) {
    this.base = options.base ?? new LocalOperatorPolicy();
    // A test adapter is allowed, but its provenance is surfaced on the object, not hidden.
    this.testAdapter = options.testAdapter === true;
  }
  /** Set only when this policy is backed by a test directory, never real SSO. */
  readonly testAdapter: boolean;

  authorize(principal: Principal, action: PlatformAction, resource?: ResourceScope): void {
    // 1) Action kind baseline (operator vs service); a service principal cannot act for a user.
    this.base.authorize(principal, action, resource);
    // 2) Cross-organization collision is always refused, even for an otherwise-allowed action.
    if (principal.orgId !== undefined && resource?.orgId !== undefined && principal.orgId !== resource.orgId) {
      throw new AuthorizationError('PLATFORM_ORG_ACCESS_DENIED', resource.orgId);
    }
    // 3) Project-scoped actions consult the deployment directory. A service principal is scoped to
    //    its run and never inherits operator project access.
    const projectId = resource?.projectId;
    if (projectId === undefined) return;
    if (principal.kind !== 'operator') {
      throw new AuthorizationError('PLATFORM_PROJECT_ACCESS_DENIED', 'service principal');
    }
    let allowed: boolean | void;
    try {
      allowed = this.directory.allows(principal, projectId);
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
      // A directory failure is a denial, never a silent allow.
      throw new AuthorizationError('PLATFORM_PROJECT_ACCESS_DENIED', projectId);
    }
    if (allowed === false) throw new AuthorizationError('PLATFORM_PROJECT_ACCESS_DENIED', projectId);
  }
}
