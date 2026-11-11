import test from 'node:test';
import assert from 'node:assert/strict';
import { RunError, RunLedger } from '../src/run.js';

const code = (fn: () => unknown, expected: string): void => {
  assert.throws(fn, (error: unknown) => error instanceof RunError && error.code === expected);
};

test('cancel before dispatch wins and dispatch cannot start afterwards', () => {
  const ledger = new RunLedger('run-1');
  const cancelled = ledger.apply({ type: 'cancel' }, 1);
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.cancelRequested, true);
  code(() => ledger.apply({ type: 'dispatch', launchId: 'launch-1', fencingToken: 1 }, cancelled.revision), 'RUN_TERMINAL');
});

test('cancel after dispatch persists intent; completion is blocked until the launch is settled', () => {
  const ledger = new RunLedger('run-2');
  let snapshot = ledger.apply({ type: 'dispatch', launchId: 'launch-2', fencingToken: 1 }, 1);
  assert.equal(snapshot.state, 'STARTING');
  snapshot = ledger.apply({ type: 'cancel' }, snapshot.revision);
  assert.equal(snapshot.state, 'STARTING');
  assert.equal(snapshot.cancelRequested, true);
  code(() => ledger.apply({ type: 'finish' }, snapshot.revision), 'RUN_FINISH_STATE_INVALID');
  snapshot = ledger.apply({ type: 'started' }, snapshot.revision);
  code(() => ledger.apply({ type: 'finish' }, snapshot.revision), 'RUN_CANCEL_PENDING');
  snapshot = ledger.apply({ type: 'cancel-settled' }, snapshot.revision);
  assert.equal(snapshot.state, 'CANCELLED');
});

test('completion requires every barrier fact and stale writers are rejected', () => {
  const ledger = new RunLedger('run-3');
  let snapshot = ledger.apply({ type: 'dispatch', launchId: 'launch-3', fencingToken: 7 }, 1);
  snapshot = ledger.apply({ type: 'started' }, snapshot.revision);
  code(() => ledger.apply({ type: 'finish' }, snapshot.revision), 'RUN_COMPLETION_BARRIER_INCOMPLETE');
  snapshot = ledger.apply({ type: 'barrier', barrier: { inputsSettled: true, descendantsDone: true, artifactsRegistered: true, cleanedUp: true } }, snapshot.revision);
  const stale = snapshot.revision;
  snapshot = ledger.apply({ type: 'finish' }, snapshot.revision);
  assert.equal(snapshot.state, 'SUCCEEDED');
  code(() => ledger.apply({ type: 'cancel' }, stale), 'RUN_REVISION_STALE');
  code(() => ledger.apply({ type: 'cancel' }, snapshot.revision), 'RUN_TERMINAL');
});

test('fencing token must strictly increase per run', () => {
  const ledger = new RunLedger('run-4');
  code(() => ledger.apply({ type: 'dispatch', launchId: 'launch-4', fencingToken: 0 }, 1), 'RUN_FENCING_TOKEN_STALE');
  const snapshot = ledger.apply({ type: 'dispatch', launchId: 'launch-4', fencingToken: 1 }, 1);
  assert.equal(snapshot.fencingToken, 1);
});

test('a persisted snapshot can be restored and continues with the same revision', () => {
  const original = new RunLedger('run-5');
  const dispatched = original.apply({ type: 'dispatch', launchId: 'launch-5', fencingToken: 1 }, 1);
  const restored = RunLedger.fromSnapshot(dispatched);
  assert.deepEqual(restored.snapshot(), dispatched);
  const running = restored.apply({ type: 'started' }, dispatched.revision);
  assert.equal(running.state, 'RUNNING');
  assert.throws(() => new RunLedger('other-run', dispatched), /RUN_SNAPSHOT_RUN_ID_MISMATCH/);
});