import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IdentityError,
  InMemoryAccessDirectory,
  derivePrincipal,
  deriveServicePrincipal,
  validateAssertion,
  type IdentityAssertion,
} from '../src/index.ts';

const NOW = Date.parse('2026-11-11T10:00:00Z');
const assertion = (overrides: Partial<IdentityAssertion> = {}): IdentityAssertion => ({
  subject: 'user-001',
  orgId: 'org-a',
  issuedAt: '2026-11-11T09:00:00Z',
  expiresAt: '2026-11-11T11:00:00Z',
  assertionDigest: 'a'.repeat(64),
  ...overrides,
});
const code = (error: unknown): string => (error instanceof IdentityError ? error.code : 'NOT_IDENTITY_ERROR');

test('I01: malformed, not-yet-valid and expired assertions never yield a principal', () => {
  assert.throws(() => derivePrincipal(assertion({ subject: '' }), NOW), (e: unknown) => code(e) === 'IDENTITY_ASSERTION_INVALID');
  assert.throws(() => derivePrincipal(assertion({ orgId: '' }), NOW), (e: unknown) => code(e) === 'IDENTITY_ASSERTION_INVALID');
  assert.throws(() => derivePrincipal(assertion({ assertionDigest: 'not-a-digest' }), NOW), (e: unknown) => code(e) === 'IDENTITY_ASSERTION_INVALID');
  assert.throws(() => derivePrincipal(assertion({ expiresAt: '2026-11-11T08:00:00Z' }), NOW), (e: unknown) => code(e) === 'IDENTITY_ASSERTION_INVALID');
  assert.throws(() => derivePrincipal(assertion(), Date.parse('2026-11-11T08:00:00Z')), (e: unknown) => code(e) === 'IDENTITY_ASSERTION_NOT_YET_VALID');
  assert.throws(() => derivePrincipal(assertion(), Date.parse('2026-11-11T11:00:00Z')), (e: unknown) => code(e) === 'IDENTITY_ASSERTION_EXPIRED');
  assert.throws(() => validateAssertion(null as never, NOW), (e: unknown) => code(e) === 'IDENTITY_ASSERTION_INVALID');
});

test('I04: the principal comes from the assertion subject, never from a caller-supplied actor', () => {
  const forged = { ...assertion(), actor: 'user:admin', actorId: 'user:admin' } as IdentityAssertion;
  const principal = derivePrincipal(forged, NOW);
  assert.equal(principal.actorId, 'user:user-001');
  assert.equal(principal.kind, 'operator');
  assert.equal(principal.orgId, 'org-a');
});

test('I05: a worker service principal is run-scoped and distinct from any operator', () => {
  const service = deriveServicePrincipal('run-42', 'org-a');
  assert.equal(service.actorId, 'service:run:run-42');
  assert.equal(service.kind, 'service');
  assert.notEqual(service.actorId, derivePrincipal(assertion(), NOW).actorId);
  assert.throws(() => deriveServicePrincipal('../escape', 'org-a'), (e: unknown) => code(e) === 'IDENTITY_RUN_ID_INVALID');
});

const directoryWithMember = (): InMemoryAccessDirectory => {
  const directory = new InMemoryAccessDirectory();
  directory.addMembership('project-a', { subject: 'user-001', orgId: 'org-a' });
  directory.addGrant('org-a', {
    projectId: 'project-a',
    roots: [{ kind: 'filesystem', location: '/data/project-a' }],
    grantsDigest: 'b'.repeat(64),
    expiresAt: '2026-11-11T12:00:00Z',
  });
  return directory;
};

test('I02: non-members, other orgs and missing grants are denied without leaking locations', () => {
  const directory = directoryWithMember();
  const operator = derivePrincipal(assertion(), NOW);
  const grant = directory.resolve(operator, 'project-a', NOW);
  assert.deepEqual(grant.roots, [{ kind: 'filesystem', location: '/data/project-a' }]);

  const stranger = derivePrincipal(assertion({ subject: 'user-999' }), NOW);
  assert.throws(() => directory.resolve(stranger, 'project-a', NOW), (e: unknown) => code(e) === 'IDENTITY_PROJECT_DENIED');
  const otherOrg = derivePrincipal(assertion({ orgId: 'org-b' }), NOW);
  assert.throws(() => directory.resolve(otherOrg, 'project-a', NOW), (e: unknown) => code(e) === 'IDENTITY_PROJECT_DENIED');

  const noGrant = new InMemoryAccessDirectory();
  noGrant.addMembership('project-a', { subject: 'user-001', orgId: 'org-a' });
  assert.throws(() => noGrant.resolve(operator, 'project-a', NOW), (e: unknown) => code(e) === 'IDENTITY_GRANT_MISSING');
});

test('I03: revoking membership or grant takes effect on the next resolution', () => {
  const directory = directoryWithMember();
  const operator = derivePrincipal(assertion(), NOW);
  directory.revokeMembership('project-a', 'org-a', 'user-001');
  assert.throws(() => directory.resolve(operator, 'project-a', NOW), (e: unknown) => code(e) === 'IDENTITY_PROJECT_DENIED');

  const second = directoryWithMember();
  second.revokeGrant('org-a', 'project-a');
  assert.throws(() => second.resolve(operator, 'project-a', NOW), (e: unknown) => code(e) === 'IDENTITY_GRANT_MISSING');
});

test('membership and grant expiry are enforced, and service principals get no project access', () => {
  const expiringMember = new InMemoryAccessDirectory();
  expiringMember.addMembership('project-a', { subject: 'user-001', orgId: 'org-a', expiresAt: '2026-11-11T10:30:00Z' });
  expiringMember.addGrant('org-a', {
    projectId: 'project-a',
    roots: [{ kind: 'api', location: 'https://data.example/project-a' }],
    grantsDigest: 'c'.repeat(64),
    expiresAt: '2026-11-11T12:00:00Z',
  });
  const operator = derivePrincipal(assertion(), NOW);
  assert.throws(
    () => expiringMember.resolve(operator, 'project-a', Date.parse('2026-11-11T10:30:00Z')),
    (e: unknown) => code(e) === 'IDENTITY_MEMBERSHIP_EXPIRED',
  );

  // Membership outlives the grant here, so the grant-expiry branch is reached on its own.
  const expiringGrant = directoryWithMember();
  assert.throws(
    () => expiringGrant.resolve(operator, 'project-a', Date.parse('2026-11-11T12:00:00Z')),
    (e: unknown) => code(e) === 'IDENTITY_GRANT_EXPIRED',
  );
  assert.throws(
    () => expiringGrant.resolve(deriveServicePrincipal('run-42', 'org-a'), 'project-a', NOW),
    (e: unknown) => code(e) === 'IDENTITY_PROJECT_DENIED',
  );
});

test('grants are validated on entry and returned as copies callers cannot mutate', () => {
  const directory = new InMemoryAccessDirectory();
  const base = {
    projectId: 'project-a',
    roots: [{ kind: 'filesystem' as const, location: '/data/project-a' }],
    grantsDigest: 'd'.repeat(64),
    expiresAt: '2026-11-11T12:00:00Z',
  };
  assert.throws(() => directory.addGrant('org-a', { ...base, roots: [] }), (e: unknown) => code(e) === 'IDENTITY_GRANT_INVALID');
  assert.throws(() => directory.addGrant('org-a', { ...base, grantsDigest: 'x' }), (e: unknown) => code(e) === 'IDENTITY_GRANT_INVALID');
  directory.addMembership('project-a', { subject: 'user-001', orgId: 'org-a' });
  directory.addGrant('org-a', base);
  const operator = derivePrincipal(assertion(), NOW);
  const first = directory.resolve(operator, 'project-a', NOW);
  first.roots[0].location = '/tampered';
  assert.equal(directory.resolve(operator, 'project-a', NOW).roots[0].location, '/data/project-a');
});
