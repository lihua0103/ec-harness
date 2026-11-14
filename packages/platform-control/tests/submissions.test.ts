import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubmissionRepository } from '../src/submissions.js';
import { PlatformStore } from '../src/store.js';
import { PlatformError } from '../src/registry.js';

const operator = 'session:submission-test';

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-submission-'));
  const store = new PlatformStore(join(root, 'control.sqlite'));
  return { root, store, submissions: new SubmissionRepository(store) };
};

const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

const base = {
  workId: 'work-1', domainId: 'domain-a', sessionId: 'session-1', requestId: 'req-1',
  submittedBy: 'user:alice', input: { text: 'hello' },
};

test('a submission is recorded once per (domain,session,requestId); a retry returns the same intent', async () => {
  const { root, store, submissions } = await setup();
  try {
    const first = submissions.record(base, operator);
    assert.equal(first.state, 'RECORDED');
    const retry = submissions.record(base, operator);
    assert.equal(retry.submissionId, first.submissionId);
    assert.equal(submissions.forWork('work-1').length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the same requestId with different content is refused, not forked', async () => {
  const { root, store, submissions } = await setup();
  try {
    submissions.record(base, operator);
    assert.throws(
      () => submissions.record({ ...base, input: { text: 'different' } }, operator),
      isPlatformError('SUBMISSION_REQUEST_REUSED'),
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance then consumption is the only proven execution path; consumption before acceptance fails', async () => {
  const { root, store, submissions } = await setup();
  try {
    const recorded = submissions.record(base, operator);
    assert.throws(() => submissions.markConsumed(recorded.submissionId, operator), isPlatformError('SUBMISSION_STATE_STALE'));
    const accepted = submissions.markAccepted(recorded.submissionId, 'native-receipt', operator);
    assert.equal(accepted.state, 'ACCEPTED');
    const consumed = submissions.markConsumed(recorded.submissionId, operator);
    assert.equal(consumed.state, 'CONSUMED');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a lost receipt stays UNKNOWN and is never auto-consumed', async () => {
  const { root, store, submissions } = await setup();
  try {
    const recorded = submissions.record(base, operator);
    const unknown = submissions.markUnknown(recorded.submissionId, 'receipt lost', operator);
    assert.equal(unknown.state, 'UNKNOWN');
    assert.throws(() => submissions.markAccepted(recorded.submissionId, 'late', operator), isPlatformError('SUBMISSION_STATE_STALE'));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('submissions survive a control restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-submission-restart-'));
  const path = join(root, 'control.sqlite');
  let store = new PlatformStore(path);
  try {
    const submissions = new SubmissionRepository(store);
    const record = submissions.record(base, operator);
    store.close();
    store = new PlatformStore(path);
    const reopened = new SubmissionRepository(store);
    assert.equal(reopened.forRequest('domain-a', 'session-1', 'req-1')?.submissionId, record.submissionId);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the pending inbox lists only PENDING questions, oldest first', async () => {
  const { root, store } = await setup();
  try {
    const insert = (interactionId: string, state: 'PENDING' | 'ANSWERED', createdAt: string) =>
      store.interactionInsert({
        interactionId, runId: 'run-1', sessionId: 'session-1', requestId: `req-${interactionId}`,
        kind: 'user-question', body: { questions: [{ id: 'q1', question: '批次？' }] }, state, createdAt,
      });
    insert('late', 'PENDING', '2026-11-12T00:00:02.000Z');
    insert('answered', 'ANSWERED', '2026-11-12T00:00:00.000Z');
    insert('early', 'PENDING', '2026-11-12T00:00:01.000Z');
    assert.deepEqual(store.pendingInteractions().map((item) => item.interactionId), ['early', 'late']);
    assert.deepEqual(store.pendingInteractions(1).map((item) => item.interactionId), ['early']);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
