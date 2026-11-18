import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryPointer, workPointers } from '../src/client/pointers.js';
import type { RunSummary, ReviewItem } from '../src/api.js';

const run = (runId: string, state?: string, createdAt = '2026-11-18T10:00:00Z'): RunSummary => ({
  runId, workId: 'w1', appId: 'listing', appVersion: '1.0.0', createdAt,
  snapshot: { state },
});
const review = (state: ReviewItem['state'], runId = 'r-ok'): ReviewItem => ({
  reviewId: `${runId}-${state}`, runId, state, requestedBy: 'op',
  revision: 1, createdAt: '2026-11-18T11:00:00Z', updatedAt: '2026-11-18T12:00:00Z',
});
const baseline = (revision: number, digest: string, sourceRef = 'D:/data/batch', createdAt = '2026-11-18T09:00:00Z') =>
  ({ revision, sourceRef, digest, createdAt });

test('an empty work has no baseline or run pointer and honestly shows no recognised delivery', () => {
  const pointers = workPointers([], [], null);
  assert.equal(pointers.baseline, null);
  assert.equal(pointers.run, null);
  assert.equal(pointers.delivery.runId, null);
  assert.equal(pointers.delivery.label, '无认可交付');
});

test('the baseline pointer reports whether the newest batch differs from the previous one', () => {
  const changed = workPointers(
    [baseline(2, 'b'.repeat(64)), baseline(1, 'a'.repeat(64))], [], null,
  );
  assert.equal(changed.baseline?.digestChanged, true);

  const identical = workPointers(
    [baseline(2, 'a'.repeat(64)), baseline(1, 'a'.repeat(64))], [], null,
  );
  assert.equal(identical.baseline?.digestChanged, false);

  const first = workPointers([baseline(1, 'a'.repeat(64))], [], null);
  assert.equal(first.baseline?.digestChanged, null);
});

test('a succeeded run without readable reviews is never shown as approved', () => {
  const unread = deliveryPointer([run('r-ok', 'SUCCEEDED')], null);
  assert.equal(unread.label, '认可待查');
  assert.equal(unread.approved, null);

  const none = deliveryPointer([run('r-ok', 'SUCCEEDED')], []);
  assert.equal(none.label, '尚未复核');
  assert.equal(none.approved, null);
  assert.match(none.detail, /复核认可 ≠ 正式交付/);
});

test('the delivery pointer follows the newest succeeded run\'s actual review outcome', () => {
  const approved = deliveryPointer([run('r-ok', 'SUCCEEDED')], [review('APPROVED')]);
  assert.equal(approved.label, '已复核认可');
  assert.equal(approved.approved?.state, 'APPROVED');

  const rejected = deliveryPointer([run('r-ok', 'SUCCEEDED')], [review('REJECTED')]);
  assert.equal(rejected.label, '复核未通过');
  assert.equal(rejected.approved, null);

  const pending = deliveryPointer([run('r-ok', 'SUCCEEDED')], [review('REQUESTED')]);
  assert.equal(pending.label, '复核进行中');
  assert.equal(pending.approved, null);
});

test('a failed or queued run never becomes the recognition candidate', () => {
  const pointer = deliveryPointer([run('r-bad', 'FAILED'), run('r-old', 'SUCCEEDED')], [review('APPROVED', 'r-old')]);
  // The newest run is FAILED, so it is not recognised; the older succeeded run is not the
  // newest either — the pointer reports the newest succeeded run (r-old) with its approval.
  assert.equal(pointer.runId, 'r-old');
  assert.equal(pointer.label, '已复核认可');

  const queuedOnly = deliveryPointer([run('r-live', 'RUNNING')], null);
  assert.equal(queuedOnly.runId, null);
  assert.equal(queuedOnly.label, '无认可交付');
});

test('a superseded decision does not silently approve the run', () => {
  const pointer = deliveryPointer([run('r-ok', 'SUCCEEDED')], [review('SUPERSEDED')]);
  assert.equal(pointer.label, '尚未复核');
  assert.equal(pointer.approved, null);
});
