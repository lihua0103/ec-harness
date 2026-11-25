/** WP3 regression: navigation-intent gating — only the newest intent commits, host panel
 *  switches and disposal invalidate pending intents, and an unavailable host still gates. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NavigationGate } from '../src/client/navigation.js';

test('a newer intent supersedes the earlier one', () => {
  const gate = new NavigationGate();
  const first = gate.begin();
  assert.equal(first.current(), true);
  const second = gate.begin();
  assert.equal(first.current(), false, 'A→B out-of-order return must drop A');
  assert.equal(second.current(), true);
  assert.ok(second.epoch > first.epoch);
});

test('the host beginNavigation signal aborting invalidates the pending intent', () => {
  const controllers: Array<AbortController> = [];
  const gate = new NavigationGate({
    beginNavigation() {
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    },
  });
  const first = gate.begin();
  assert.equal(first.current(), true);
  const second = gate.begin();
  assert.equal(first.current(), false, 'the host aborted the first signal');
  assert.equal(second.current(), true);
  controllers[1]!.abort();
  assert.equal(second.current(), false, 'a host-level panel switch aborts the newest intent too');
});

test('dispose invalidates every intent; page-internal epochs still gate without a host', () => {
  const gate = new NavigationGate();
  const intent = gate.begin();
  assert.equal(intent.current(), true);
  gate.dispose();
  assert.equal(intent.current(), false);
  assert.equal(gate.begin().current(), false, 'no commit after unmount');
});

test('an unavailable host falls back to epoch-only gating', () => {
  const gate = new NavigationGate({
    beginNavigation(): AbortSignal {
      throw new Error('layout not published');
    },
  });
  const first = gate.begin();
  assert.equal(first.current(), true);
  const second = gate.begin();
  assert.equal(first.current(), false);
  assert.equal(second.current(), true);
});
