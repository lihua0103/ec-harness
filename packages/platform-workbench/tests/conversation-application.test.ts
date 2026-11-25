/** 「当前会话所属应用」平台事实的 uSES 合同：快照引用稳定、同值不通知、null 表示非工作会话。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationApplicationSource } from '../src/client/conversation-application.js';

const dvp = { appId: 'ec.dvp', appVersion: '0.3.9', displayName: 'DVP 数据核查计划' };
const listing = { appId: 'ec.listing', appVersion: '0.2.4', displayName: 'Listing 开发与复跑' };

test('starts as "no Work conversation": null until something is published', () => {
  const source = createConversationApplicationSource();
  assert.equal(source.observable.getSnapshot(), null);
});

test('a real change publishes a new snapshot to every subscriber', () => {
  const source = createConversationApplicationSource();
  const seen: unknown[] = [];
  source.observable.subscribe(() => seen.push(source.observable.getSnapshot()));
  source.publish(dvp);
  source.publish(null);
  source.publish(listing);
  assert.equal(seen.length, 3);
  // The very objects that were published, never copies.
  assert.equal(seen[0], dvp);
  assert.equal(seen[1], null);
  assert.equal(seen[2], listing);
});

test('an unchanged application keeps the snapshot reference and stays silent', () => {
  const source = createConversationApplicationSource();
  source.publish(dvp);
  const first = source.observable.getSnapshot();
  let notifications = 0;
  source.observable.subscribe(() => { notifications += 1; });
  // The page re-publishes on every reload with a fresh equal object: that is not a change.
  source.publish({ ...dvp });
  assert.equal(source.observable.getSnapshot(), first, 'same value must keep the same reference (uSES)');
  source.publish(null);
  source.publish(null);
  assert.equal(notifications, 1, 'null → null is not a change either');
});

test('a different version or name of the same appId is a different application', () => {
  const source = createConversationApplicationSource();
  source.publish(dvp);
  let notifications = 0;
  source.observable.subscribe(() => { notifications += 1; });
  source.publish({ ...dvp, appVersion: '0.4.0' });
  source.publish({ ...dvp, displayName: 'renamed' });
  assert.equal(notifications, 2);
  assert.equal(source.observable.getSnapshot()?.displayName, 'renamed');
});

test('unsubscribe stops delivery and does not affect other subscribers', () => {
  const source = createConversationApplicationSource();
  let left = 0;
  let right = 0;
  const stopLeft = source.observable.subscribe(() => { left += 1; });
  source.observable.subscribe(() => { right += 1; });
  source.publish(dvp);
  stopLeft();
  source.publish(null);
  assert.equal(left, 1);
  assert.equal(right, 2);
});

// 接线合同：事实经上游公开的根标准工具包（slots.provideRoot + GlobalStandardProps 声明合并）发布，
// 由页面在进入/离开工作会话时喂入；平台侧不出现任何具体应用或插件的名字（开发规范 §3.1/§3.3）。
test('the fact is published through the public root standard kit and fed from the Work on screen', async () => {
  const { readFile } = await import('node:fs/promises');
  const entry = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8');
  assert.match(entry, /interface GlobalStandardProps \{[\s\S]{0,900}?useConversationApplication\?: SnapshotSelectorHook<ConversationApplication \| null>/, 'every slot component can read the fact as a standard hook');
  assert.match(entry, /ctx\.slots\.provideRoot\(\{ hooks: \{ conversationApplication: conversationApplication\.observable \} \}\)/, 'the bare source is contributed through the public root seat');
  const page = await readFile(new URL('../src/client/WorkbenchPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /useLayoutEffect\(\(\) => \{\s*publishConversationApplication\(sessionWork\?\.application \?\? null\)/, 'the page publishes the Work on screen, and null when it is not a Work conversation');
  assert.match(page, /application: \{ appId: context\.app\.appId, appVersion: context\.app\.appVersion, displayName: context\.app\.displayName \}/, 'opening a Work carries its release coordinates');
  for (const [name, text] of [['index.ts', entry], ['WorkbenchPage.tsx', page]] as const) {
    assert.doesNotMatch(text, /ec\.(?:dvp|listing)|dm[-_]dvp|dm[-_]listing|DM Listing/i, `${name} must not name an application or a plugin`);
  }
});
