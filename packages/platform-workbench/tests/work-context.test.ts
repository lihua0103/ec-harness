import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingDraft, isBoundDeepLink, parseWorkContext, resolveOpenTarget, selectBindingDomain } from '../src/work-context.js';

const binding = {
  bindingId: 'b1', workId: 'w1', domainId: 'd1', sessionId: 's1',
  releaseDigest: 'a'.repeat(64), relation: 'primary' as const,
  revision: 1, createdBy: 'user:alice', createdAt: '2026-11-12T00:00:00.000Z',
};

const valid = {
  work: { workId: 'w1', title: '合成工作', state: 'ACTIVE', projectId: 'p1', appId: 'listing' },
  project: { projectId: 'p1', name: '合成项目' },
  workspace: { workspaceId: 'ws1', name: '空间', directory: '/work/study' },
  app: { appId: 'listing', appVersion: '1.0.0', releaseDigest: 'a'.repeat(64), displayName: 'Listing' },
  binding,
  domain: { domainId: 'd1', owner: 'org-acme', kind: 'hosted', state: 'HEALTHY', revision: 2 },
  sessionId: 's1',
};

test('a complete work context parses and resolves to its bound native session', () => {
  const context = parseWorkContext(valid);
  assert.equal(context.work.workId, 'w1');
  assert.equal(context.workspace?.directory, '/work/study');
  const target = resolveOpenTarget(context);
  assert.deepEqual(target, { kind: 'open-session', sessionId: 's1', domainId: 'd1' });
});

test('an unbound work is an honest needs-binding, never a silent new session', () => {
  const context = parseWorkContext({ ...valid, binding: null, domain: null, sessionId: null });
  const target = resolveOpenTarget(context);
  assert.equal(target.kind, 'needs-binding');
  assert.match((target as { reason: string }).reason, /绑定/);
});

test('an unbound work without a workspace explains the space gap', () => {
  const context = parseWorkContext({ ...valid, binding: null, domain: null, sessionId: null, workspace: null });
  const target = resolveOpenTarget(context);
  assert.equal(target.kind, 'needs-binding');
  assert.match((target as { reason: string }).reason, /空间/);
});

test('a deep link is usable only when it names this work\'s own bound session', () => {
  const context = parseWorkContext(valid);
  assert.equal(isBoundDeepLink(context, { sessionId: 's1', domainId: 'd1' }), true);
  assert.equal(isBoundDeepLink(context, { sessionId: 'other', domainId: 'd1' }), false);
  assert.equal(isBoundDeepLink(context, { sessionId: 's1', domainId: 'other' }), false);
  const unbound = parseWorkContext({ ...valid, binding: null, sessionId: null });
  assert.equal(isBoundDeepLink(unbound, { sessionId: 's1' }), false);
});

test('a malformed payload is refused rather than coerced', () => {
  assert.throws(() => parseWorkContext(null), /WORK_CONTEXT_INVALID/);
  assert.throws(() => parseWorkContext({ ...valid, work: null }), /WORK_CONTEXT_INVALID/);
  assert.throws(() => parseWorkContext({ ...valid, work: { ...valid.work, state: 'DONE' } }), /WORK_CONTEXT_INVALID/);
  assert.throws(
    () => parseWorkContext({ ...valid, binding: { ...binding, relation: 'primary-ish' } }),
    /WORK_CONTEXT_INVALID/,
  );
});

test('binding picks a healthy local domain, never an invented id', () => {
  assert.equal(selectBindingDomain([]), null);
  assert.equal(selectBindingDomain([{ domainId: '' }, null, 'x']), null);
  const chosen = selectBindingDomain([
    { domainId: 'd-hosted', kind: 'hosted', state: 'HEALTHY' },
    { domainId: 'd-local-degraded', kind: 'local', state: 'DEGRADED' },
    { domainId: 'd-local-ok', kind: 'local', state: 'HEALTHY' },
  ]);
  assert.deepEqual(chosen, { domainId: 'd-local-ok', kind: 'local', state: 'HEALTHY' });
  assert.deepEqual(selectBindingDomain([{ domainId: 'd1', kind: 'local' }]), { domainId: 'd1', kind: 'local', state: 'UNKNOWN' });
});

test('binding carries the real session id and the context release digest', () => {
  const context = parseWorkContext({ ...valid, binding: null, domain: null, sessionId: null });
  assert.deepEqual(bindingDraft(context, 'd1', 'session-1'), {
    domainId: 'd1', sessionId: 'session-1', releaseDigest: 'a'.repeat(64), workspaceId: 'ws1',
  });
  const noWorkspace = parseWorkContext({ ...valid, workspace: null, binding: null, sessionId: null });
  assert.throws(() => bindingDraft(noWorkspace, 'd1', 'session-1'), /BINDING_WORKSPACE_REQUIRED/);
  const noDigest = parseWorkContext({ ...valid, app: { ...valid.app, releaseDigest: '' }, binding: null });
  assert.throws(() => bindingDraft(noDigest, 'd1', 'session-1'), /BINDING_RELEASE_DIGEST_MISSING/);
  assert.throws(() => bindingDraft(context, 'd1', ''), /BINDING_SESSION_REQUIRED/);
});
