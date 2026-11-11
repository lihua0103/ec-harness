/** Enterprise identity and project data-access resolution.
 *
 *  Implements docs/ENTERPRISE-IDENTITY-AND-DATA-CONTRACT.md sections 2-3: an authenticated
 *  assertion becomes a Principal, and a Principal plus project membership becomes a
 *  data-access grant. Nothing here reads tool arguments: callers pass the assertion the
 *  transport boundary authenticated, never an actor or project supplied by a model.
 *
 *  This package does not implement the control plane's policy interface. A deployment
 *  writes a thin adapter that calls these functions and passes it to
 *  platformControl.setPolicy(...); keeping the packages decoupled lets the identity
 *  source be replaced without touching run state.
 *
 *  InMemoryAccessDirectory stands in for the IT/API source. It is a real, testable
 *  implementation of the resolution rules, not a claim that SSO or the project API is
 *  integrated; a deployment supplies its own directory backed by those services. */

export interface IdentityAssertion {
  subject: string;
  orgId: string;
  issuedAt: string;
  expiresAt: string;
  assertionDigest: string;
}

export interface Principal {
  actorId: string;
  kind: 'operator' | 'service';
  orgId: string;
}

export interface DataLocation {
  kind: 'filesystem' | 'api';
  location: string;
}

export interface DataAccessGrant {
  projectId: string;
  roots: DataLocation[];
  grantsDigest: string;
  expiresAt: string;
}

export class IdentityError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? code + ': ' + detail : code);
    this.name = 'IdentityError';
  }
}

const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

function instant(value: unknown, field: string): number {
  if (typeof value !== 'string') throw new IdentityError('IDENTITY_ASSERTION_INVALID', field);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new IdentityError('IDENTITY_ASSERTION_INVALID', field);
  return parsed;
}

/** Reject malformed, mis-ordered or expired assertions before any principal exists. */
export function validateAssertion(assertion: IdentityAssertion, now: number = Date.now()): void {
  if (!assertion || typeof assertion !== 'object') throw new IdentityError('IDENTITY_ASSERTION_INVALID');
  if (typeof assertion.subject !== 'string' || !IDENTIFIER.test(assertion.subject))
    throw new IdentityError('IDENTITY_ASSERTION_INVALID', 'subject');
  if (typeof assertion.orgId !== 'string' || !IDENTIFIER.test(assertion.orgId))
    throw new IdentityError('IDENTITY_ASSERTION_INVALID', 'orgId');
  if (typeof assertion.assertionDigest !== 'string' || !DIGEST.test(assertion.assertionDigest))
    throw new IdentityError('IDENTITY_ASSERTION_INVALID', 'assertionDigest');
  const issuedAt = instant(assertion.issuedAt, 'issuedAt');
  const expiresAt = instant(assertion.expiresAt, 'expiresAt');
  if (expiresAt <= issuedAt) throw new IdentityError('IDENTITY_ASSERTION_INVALID', 'expiresAt<=issuedAt');
  if (now < issuedAt) throw new IdentityError('IDENTITY_ASSERTION_NOT_YET_VALID');
  if (now >= expiresAt) throw new IdentityError('IDENTITY_ASSERTION_EXPIRED');
}

/** Derive the operator principal from the authenticated assertion only. */
export function derivePrincipal(assertion: IdentityAssertion, now: number = Date.now()): Principal {
  validateAssertion(assertion, now);
  return { actorId: 'user:' + assertion.subject, kind: 'operator', orgId: assertion.orgId };
}

/** Run-scoped service principal for a worker; never an operator, and it dies with the run. */
export function deriveServicePrincipal(runId: string, orgId: string): Principal {
  if (!IDENTIFIER.test(runId)) throw new IdentityError('IDENTITY_RUN_ID_INVALID');
  if (!IDENTIFIER.test(orgId)) throw new IdentityError('IDENTITY_ORG_INVALID');
  return { actorId: 'service:run:' + runId, kind: 'service', orgId };
}

interface Membership {
  subject: string;
  orgId: string;
  expiresAt?: string;
}

const memberKey = (orgId: string, projectId: string, subject: string): string =>
  [orgId, projectId, subject].join('|');
const grantKey = (orgId: string, projectId: string): string => [orgId, projectId].join('|');

/** Resolution rules for project membership and data locations, independent of their source. */
export class InMemoryAccessDirectory {
  private readonly members = new Map<string, Membership>();
  private readonly grants = new Map<string, DataAccessGrant>();

  addMembership(projectId: string, membership: Membership): void {
    if (!IDENTIFIER.test(projectId)) throw new IdentityError('IDENTITY_PROJECT_INVALID');
    if (!IDENTIFIER.test(membership.subject) || !IDENTIFIER.test(membership.orgId))
      throw new IdentityError('IDENTITY_MEMBERSHIP_INVALID');
    if (membership.expiresAt !== undefined) instant(membership.expiresAt, 'membership.expiresAt');
    this.members.set(memberKey(membership.orgId, projectId, membership.subject), { ...membership });
  }

  revokeMembership(projectId: string, orgId: string, subject: string): void {
    this.members.delete(memberKey(orgId, projectId, subject));
  }

  addGrant(orgId: string, grant: DataAccessGrant): void {
    if (!IDENTIFIER.test(orgId) || !IDENTIFIER.test(grant.projectId))
      throw new IdentityError('IDENTITY_GRANT_INVALID');
    if (!DIGEST.test(grant.grantsDigest)) throw new IdentityError('IDENTITY_GRANT_INVALID', 'grantsDigest');
    instant(grant.expiresAt, 'grant.expiresAt');
    if (!Array.isArray(grant.roots) || grant.roots.length === 0)
      throw new IdentityError('IDENTITY_GRANT_INVALID', 'roots');
    for (const root of grant.roots) {
      if ((root.kind !== 'filesystem' && root.kind !== 'api') || !root.location?.trim())
        throw new IdentityError('IDENTITY_GRANT_INVALID', 'root');
    }
    this.grants.set(grantKey(orgId, grant.projectId), { ...grant, roots: grant.roots.map((r) => ({ ...r })) });
  }

  revokeGrant(orgId: string, projectId: string): void {
    this.grants.delete(grantKey(orgId, projectId));
  }

  /** A service principal is scoped to its run and never inherits operator project access. */
  resolve(principal: Principal, projectId: string, now: number = Date.now()): DataAccessGrant {
    if (!IDENTIFIER.test(projectId)) throw new IdentityError('IDENTITY_PROJECT_INVALID');
    if (principal.kind !== 'operator') throw new IdentityError('IDENTITY_PROJECT_DENIED', 'service principal');
    const subject = principal.actorId.startsWith('user:') ? principal.actorId.slice(5) : '';
    const membership = this.members.get(memberKey(principal.orgId, projectId, subject));
    if (!membership) throw new IdentityError('IDENTITY_PROJECT_DENIED', projectId);
    if (membership.expiresAt !== undefined && now >= instant(membership.expiresAt, 'membership.expiresAt'))
      throw new IdentityError('IDENTITY_MEMBERSHIP_EXPIRED', projectId);
    const grant = this.grants.get(grantKey(principal.orgId, projectId));
    if (!grant) throw new IdentityError('IDENTITY_GRANT_MISSING', projectId);
    if (now >= instant(grant.expiresAt, 'grant.expiresAt'))
      throw new IdentityError('IDENTITY_GRANT_EXPIRED', projectId);
    return { ...grant, roots: grant.roots.map((root) => ({ ...root })) };
  }
}
