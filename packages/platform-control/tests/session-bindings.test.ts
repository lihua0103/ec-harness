import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExecutionDomainRepository,
  WorkSessionBindingRepository,
} from '../src/session-bindings.js';
import { PlatformStore } from '../src/store.js';
import { PlatformError } from '../src/registry.js';

const operator = 'session:binding-test';
const digest = 'a'.repeat(64);

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-binding-'));
  const path = join(root, 'control.sqlite');
  const store = new PlatformStore(path);
  const domains = new ExecutionDomainRepository(store);
  const bindings = new WorkSessionBindingRepository(store);
  return { root, path, store, domains, bindings };
};

const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

test('a domain registers with public metadata only and starts UNKNOWN', async () => {
  const { root, store, domains } = await setup();
  try {
    const domain = domains.register({ owner: 'org:acme', kind: 'hosted', deploymentRef: 'deploy-a', capabilities: ['listing'] }, operator);
    assert.equal(domain.kind, 'hosted');
    assert.equal(domain.state, 'UNKNOWN');
    assert.equal(domain.revision, 1);
    assert.equal(domains.list('org:acme').length, 1);
    assert.equal(domains.get(domain.domainId).capabilities[0], 'listing');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('domain health is a CAS transition; a stale revision is rejected', async () => {
  const { root, store, domains } = await setup();
  try {
    const domain = domains.register({ owner: 'org:acme', kind: 'local', capabilities: [] }, operator);
    const healthy = domains.setState(domain.domainId, 'HEALTHY', 1, operator);
    assert.equal(healthy.state, 'HEALTHY');
    assert.equal(healthy.revision, 2);
    assert.throws(() => domains.setState(domain.domainId, 'DEGRADED', 1, operator), isPlatformError('DOMAIN_REVISION_STALE'));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the first binding for a Work is primary and a second primary demotes the old one', async () => {
  const { root, store, bindings } = await setup();
  try {
    const first = bindings.bind({ workId: 'work-1', domainId: 'domain-a', sessionId: 'session-1', releaseDigest: digest }, operator);
    assert.equal(first.relation, 'primary');
    assert.equal(bindings.current('work-1')?.sessionId, 'session-1');
    const second = bindings.bind({ workId: 'work-1', domainId: 'domain-a', sessionId: 'session-2', releaseDigest: digest }, operator);
    assert.equal(second.relation, 'primary');
    assert.equal(bindings.current('work-1')?.sessionId, 'session-2');
    const history = bindings.history('work-1');
    assert.equal(history.length, 2);
    assert.equal(history.find((row) => row.sessionId === 'session-1')?.relation, 'reopened');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a fork binding is explicit, requires a source Work, and does not displace primary', async () => {
  const { root, store, bindings } = await setup();
  try {
    bindings.bind({ workId: 'work-1', domainId: 'domain-a', sessionId: 'session-1', releaseDigest: digest }, operator);
    assert.throws(
      () => bindings.bind({ workId: 'work-2', domainId: 'domain-a', sessionId: 'session-fork', releaseDigest: digest, relation: 'fork' }, operator),
      isPlatformError('BINDING_INVALID'),
    );
    bindings.bind({
      workId: 'work-2', domainId: 'domain-a', sessionId: 'session-fork', releaseDigest: digest,
      relation: 'fork', sourceWorkId: 'work-1',
    }, operator);
    assert.equal(bindings.current('work-1')?.sessionId, 'session-1');
    assert.equal(bindings.history('work-2')[0].relation, 'fork');
    assert.equal(bindings.history('work-2')[0].sourceWorkId, 'work-1');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('two domains may use the same session id, but a domain-local session binds to one Work', async () => {
  const { root, store, bindings } = await setup();
  try {
    bindings.bind({ workId: 'work-1', domainId: 'domain-a', sessionId: 'session-x', releaseDigest: digest }, operator);
    // Same session id in a different domain is a distinct association.
    bindings.bind({ workId: 'work-2', domainId: 'domain-b', sessionId: 'session-x', releaseDigest: digest }, operator);
    assert.equal(bindings.forSession('domain-b', 'session-x')?.workId, 'work-2');
    // Same session id in the same domain cannot be claimed by another Work.
    assert.throws(
      () => bindings.bind({ workId: 'work-3', domainId: 'domain-a', sessionId: 'session-x', releaseDigest: digest }, operator),
      isPlatformError('BINDING_SESSION_CONFLICT'),
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('bindings and domains survive a control restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-binding-restart-'));
  const path = join(root, 'control.sqlite');
  let store = new PlatformStore(path);
  try {
    const domains = new ExecutionDomainRepository(store);
    const bindings = new WorkSessionBindingRepository(store);
    const domain = domains.register({ owner: 'org:acme', kind: 'hosted', capabilities: [] }, operator);
    bindings.bind({ workId: 'work-1', domainId: domain.domainId, sessionId: 'session-1', releaseDigest: digest }, operator);
    store.close();
    store = new PlatformStore(path);
    const reopenedDomains = new ExecutionDomainRepository(store);
    const reopenedBindings = new WorkSessionBindingRepository(store);
    assert.equal(reopenedDomains.get(domain.domainId).owner, 'org:acme');
    assert.equal(reopenedBindings.current('work-1')?.sessionId, 'session-1');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
