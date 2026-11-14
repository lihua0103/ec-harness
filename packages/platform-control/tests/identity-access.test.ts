import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryAccessPolicy, type ProjectAccessDirectory } from '../src/identity-access.js';
import { AuthorizationError, LocalOperatorPolicy, type Principal } from '../src/policy.js';

const alice: Principal = { actorId: 'user:alice', kind: 'operator', orgId: 'org-acme' };
const bob: Principal = { actorId: 'user:bob', kind: 'operator', orgId: 'org-acme' };
const service: Principal = { actorId: 'service:run:r1', kind: 'service', orgId: 'org-acme' };

const directory: ProjectAccessDirectory = {
  allows(principal /** , projectId */) {
    return principal.actorId === 'user:alice';
  },
};

const isAuth = (code: string) => (error: unknown) =>
  error instanceof AuthorizationError && error.code === code;

test('a project is accessible only to principals the directory admits', () => {
  const policy = new DirectoryAccessPolicy(directory);
  assert.doesNotThrow(() => policy.authorize(alice, 'run.create', { projectId: 'P1' }));
  assert.throws(() => policy.authorize(bob, 'run.create', { projectId: 'P1' }), isAuth('PLATFORM_PROJECT_ACCESS_DENIED'));
});

test('a service principal never inherits operator project access', () => {
  const policy = new DirectoryAccessPolicy(directory);
  assert.throws(() => policy.authorize(service, 'run.read', { projectId: 'P1' }), isAuth('PLATFORM_PROJECT_ACCESS_DENIED'));
  // But a service-only action with no project scope still works through the base policy.
  assert.doesNotThrow(() => policy.authorize(service, 'run.dispatch', undefined));
});

test('cross-organization scope is refused before any directory lookup', () => {
  const policy = new DirectoryAccessPolicy(directory);
  assert.throws(
    () => policy.authorize(alice, 'run.create', { projectId: 'P1', orgId: 'org-other' }),
    isAuth('PLATFORM_ORG_ACCESS_DENIED'),
  );
});

test('a failing directory denies rather than allows', () => {
  const policy = new DirectoryAccessPolicy({
    allows() {
      throw new Error('backend down');
    },
  });
  assert.throws(() => policy.authorize(alice, 'run.create', { projectId: 'P1' }), isAuth('PLATFORM_PROJECT_ACCESS_DENIED'));
});

test('an action kind the base policy forbids is still refused for a service principal', () => {
  const policy = new DirectoryAccessPolicy(directory, { base: new LocalOperatorPolicy() });
  // run.create is operator-only; a service principal may not create runs even with a grant.
  assert.throws(() => policy.authorize(service, 'run.create', undefined), isAuth('PLATFORM_AUTHORIZATION_DENIED'));
});
