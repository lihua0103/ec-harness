import assert from 'node:assert/strict';
import { createDataInterceptionPolicy } from '../../src/data-interception-policy.js';

// ---------------------------------------------------------------------------
// 基础状态机与 onChange 回执
// ---------------------------------------------------------------------------
const changes = [];
const policy = createDataInterceptionPolicy(false, {
  onChange(change) { changes.push(change); },
});

assert.equal(policy.isEnabled(), false);
assert.equal(policy.setEnabled(true, { source: 'test' }), true);
assert.equal(policy.isEnabled(), true);
assert.deepEqual(changes, [{ previousEnabled: false, enabled: true, source: 'test' }]);
assert.throws(() => policy.setEnabled('false'), /must be a boolean/);

// ---------------------------------------------------------------------------
// 2026-08-25：开关切换必须触发 onSwitch，宿主据此重启进程。
// 真实故障：关闭出域开关后仍反复拦截，根因之一是拦截侧读启动期配置快照而非
// 实时策略。本段锁住"切换即通知"这条契约——回调丢失时快照永不刷新。
// ---------------------------------------------------------------------------
const switches = [];
const restartPolicy = createDataInterceptionPolicy(true, {
  onSwitch(info) { switches.push(info); },
});

restartPolicy.setEnabled(false, { source: 'settings-api' });
assert.equal(switches.length, 1, '状态变化必须触发一次 onSwitch');
assert.equal(switches[0].previousEnabled, true);
assert.equal(switches[0].enabled, false);
assert.equal(switches[0].reason, 'data_interception_switch');
assert.equal(switches[0].source, 'settings-api');
assert.equal(typeof switches[0].timestamp, 'string');

// 幂等写入不是状态变化，不得触发重启（否则每次读设置页都重启一轮）。
restartPolicy.setEnabled(false, { source: 'settings-api' });
assert.equal(switches.length, 1, '设置为相同值不得触发 onSwitch');

// 反向切换同样通知，且 previous/enabled 方向正确。
restartPolicy.setEnabled(true, { source: 'settings-api' });
assert.equal(switches.length, 2);
assert.equal(switches[1].previousEnabled, false);
assert.equal(switches[1].enabled, true);

// onSwitch 未提供时不得抛错（宿主可能不关心重启通知）。
const bare = createDataInterceptionPolicy(true);
assert.equal(bare.setEnabled(false), false);
assert.equal(bare.isEnabled(), false);

// isEnabled 必须反映最新值，供拦截侧逐次实时求值。
const live = createDataInterceptionPolicy(true);
const reads = [];
for (const next of [false, true, false]) {
  live.setEnabled(next);
  reads.push(live.isEnabled());
}
assert.deepEqual(reads, [false, true, false], 'isEnabled 必须实时反映切换结果');

process.stdout.write(JSON.stringify({
  policyState: true,
  switchNotifications: switches.length,
}));
