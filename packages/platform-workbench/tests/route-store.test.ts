/** 单侧栏架构回归：共享路由状态的 uSES 合同（快照引用稳定）、命令总线的挂载语义，
 *  以及"主区未挂载时侧栏命令被丢弃"的首屏保证。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteStore, INITIAL_ROUTE_SNAPSHOT, type WorkbenchRouteCommand } from '../src/client/route-store.js';

test('publish keeps the snapshot reference until something really changes', () => {
  const store = createRouteStore();
  const seen: Array<unknown> = [];
  const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()));
  assert.equal(store.getSnapshot(), INITIAL_ROUTE_SNAPSHOT);

  store.publish({ page: 'works' });
  assert.equal(seen.length, 0, 'no-change publish must not notify');

  store.publish({ page: 'sessions', pendingCount: 3 });
  assert.equal(seen.length, 1);
  assert.equal(store.getSnapshot().page, 'sessions');
  assert.equal(store.getSnapshot().pendingCount, 3);
  assert.equal(store.getSnapshot().viewKind, 'page', 'unpublished fields keep their values');

  store.publish({ page: 'sessions', viewKind: 'work', activeWorkId: 'w1', activeTitle: 'T' });
  assert.equal(seen.length, 2);
  assert.notEqual(store.getSnapshot(), seen[0], 'a real change produces a new reference');
  unsubscribe();
  store.publish({ page: 'apps' });
  assert.equal(seen.length, 2, 'unsubscribed listeners stop receiving notifications');
  assert.equal(store.getSnapshot().page, 'apps');
});

test('the command bus runs only while a handler is mounted', () => {
  const store = createRouteStore();
  const received: WorkbenchRouteCommand[] = [];
  store.dispatch({ kind: 'navigate', page: 'apps' });
  // assert.deepEqual(x, []) carries `asserts actual is T` in @types/node 22 — it would narrow
  // `received` to never[] for the rest of the block. Length checks keep the element type intact.
  assert.equal(received.length, 0, 'no handler mounted: the sidebar command is dropped');

  store.setHandler((command) => received.push(command));
  store.dispatch({ kind: 'open-work', workId: 'w-9' });
  store.dispatch({ kind: 'create' });
  assert.deepEqual(received.map((command) => command.kind), ['open-work', 'create']);

  store.setHandler(null);
  store.dispatch({ kind: 'navigate', page: 'settings' });
  assert.equal(received.length, 2, 'unmount clears the handler: no late execution');
});

test('each subscriber sees every notification and unsubscribe is isolated', () => {
  const store = createRouteStore();
  let left = 0;
  let right = 0;
  const stopLeft = store.subscribe(() => { left += 1 });
  store.subscribe(() => { right += 1 });
  store.publish({ pendingCount: 1 });
  assert.equal(left, 1);
  assert.equal(right, 1);
  stopLeft();
  store.publish({ pendingCount: 2 });
  assert.equal(left, 1);
  assert.equal(right, 2);
});
