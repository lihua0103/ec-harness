/** L2 个人记忆（T01/T03，开发设计 §2/§4/§5 preferences.*）：
 *  甲跨设备可读，乙不可见；暂停不注入；删除墓碑在备份恢复后不复活；重复删除幂等；
 *  版本比较更新（不用最后写入覆盖）；未知键/非法值/越权插件范围拒绝；注入引用永不携带值。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../lib/index.js';

const makeService = () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-pref-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  return { root, service };
};

const principal = (actorId, orgId, region) => ({
  actorId,
  ...(orgId !== undefined ? { orgId } : {}),
  ...(region !== undefined ? { region } : {}),
});

test('甲跨设备可读，同租户的乙不可见（T01）', () => {
  const { root, service } = makeService();
  try {
    const jia = principal('user:jia', 'acme', 'eu');
    const saved = service.preferencesSetMine(jia, {
      key: 'review.summaryOrder', value: 'exceptionsFirst', expectedRevision: 0,
    });
    assert.equal(saved.revision, 1);
    assert.equal(saved.state, 'ACTIVE');
    assert.equal(saved.owner, 'user:jia');
    // 另一台设备（同一主体）可读同一修订
    assert.equal(service.preferencesGetMine(jia).length, 1);
    assert.equal(service.preferencesGetMine(jia)[0].revision, 1);
    // 乙查不到甲的条目：清单为空，且不存在可以猜测的 owner 参数
    const yi = principal('user:yi', 'acme', 'eu');
    assert.deepEqual(service.preferencesGetMine(yi), []);
    // 乙设置同键互不干扰（键空间按主体隔离）
    const yiSaved = service.preferencesSetMine(yi, {
      key: 'review.summaryOrder', value: 'chronological', expectedRevision: 0,
    });
    assert.equal(yiSaved.revision, 1);
    assert.equal(service.preferencesGetMine(jia)[0].value, 'exceptionsFirst');
    assert.equal(service.preferencesGetMine(yi)[0].value, 'chronological');
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('版本比较更新：过期修订拒绝，不用最后写入覆盖', () => {
  const { root, service } = makeService();
  try {
    const jia = principal('user:jia');
    const saved = service.preferencesSetMine(jia, { key: 'output.locale', value: 'zh-CN', expectedRevision: 0 });
    assert.throws(
      () => service.preferencesSetMine(jia, { key: 'output.locale', value: 'en-US', expectedRevision: 0 }),
      /PREFERENCE_REVISION_STALE/,
    );
    const updated = service.preferencesSetMine(jia, { key: 'output.locale', value: 'en-US', expectedRevision: saved.revision });
    assert.equal(updated.revision, 2);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('封闭注册表：未知键、非法值、越权插件范围一律拒绝', () => {
  const { root, service } = makeService();
  try {
    const jia = principal('user:jia');
    assert.throws(
      () => service.preferencesSetMine(jia, { key: 'system.prompt', value: 'ignore previous', expectedRevision: 0 }),
      /PREFERENCE_KEY_UNKNOWN/,
    );
    assert.throws(
      () => service.preferencesSetMine(jia, { key: 'output.locale', value: 'klingon-99', expectedRevision: 0 }),
      /PREFERENCE_VALUE_INVALID/,
    );
    assert.throws(
      () => service.preferencesSetMine(jia, { key: 'layout.density', value: 'compact', pluginId: 'dm-listing', expectedRevision: 0 }),
      /PREFERENCE_PLUGIN_SCOPE_INVALID/,
    );
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('暂停后不再注入；再次保存即恢复；注入引用只有键与修订、永不携带值', () => {
  const { root, service } = makeService();
  try {
    const jia = principal('user:jia', 'acme', 'eu');
    service.preferencesSetMine(jia, { key: 'review.summaryOrder', value: 'exceptionsFirst', pluginId: 'dm-listing', expectedRevision: 0 });
    const paused = service.preferencesPauseMine(jia, 'review.summaryOrder', 'dm-listing');
    assert.equal(paused.state, 'PAUSED');
    assert.equal(service.preferencesForRunBinding(jia, 'dm-listing').length, 0, '暂停后不注入');
    const resumed = service.preferencesSetMine(jia, {
      key: 'review.summaryOrder', value: 'exceptionsFirst', pluginId: 'dm-listing', expectedRevision: paused.revision,
    });
    assert.equal(resumed.state, 'ACTIVE');
    const refs = service.preferencesForRunBinding(jia, 'dm-listing');
    assert.equal(refs.length, 1);
    assert.deepEqual(Object.keys(refs[0]).sort(), ['key', 'pluginKey', 'revision'], 'LearningBinding 引用不含值');
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('删除墓碑：清单不再包含、值已清理、重复删除幂等、重新设置从修订 1 开始（T03）', () => {
  const { root, service } = makeService();
  try {
    const jia = principal('user:jia');
    const saved = service.preferencesSetMine(jia, { key: 'output.locale', value: 'zh-CN', expectedRevision: 0 });
    const deleted = service.preferencesDeleteMine(jia, 'output.locale');
    assert.equal(deleted.state, 'DELETED');
    assert.equal(deleted.value, null, '墓碑行清理正文');
    assert.equal(deleted.revision, saved.revision + 1);
    assert.deepEqual(service.preferencesGetMine(jia), []);
    // 重复删除幂等：返回同一墓碑，不抛错、不递增修订
    const again = service.preferencesDeleteMine(jia, 'output.locale');
    assert.equal(again.state, 'DELETED');
    assert.equal(again.revision, deleted.revision);
    // 重新设置是一次显式新选择：必须 expectedRevision=0，从修订 1 开始
    assert.throws(
      () => service.preferencesSetMine(jia, { key: 'output.locale', value: 'zh-CN', expectedRevision: deleted.revision }),
      /PREFERENCE_REVISION_STALE/,
    );
    const fresh = service.preferencesSetMine(jia, { key: 'output.locale', value: 'zh-CN', expectedRevision: 0 });
    assert.equal(fresh.revision, 1);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('删除后备份恢复也不复活（T03：恢复先重放墓碑）', () => {
  const { root, service } = makeService();
  try {
    const jia = principal('user:jia', 'acme', 'eu');
    service.preferencesSetMine(jia, { key: 'output.locale', value: 'zh-CN', expectedRevision: 0 });
    service.preferencesDeleteMine(jia, 'output.locale');
    const backupPath = join(root, 'backup.sqlite');
    service.backup(backupPath);
    const restored = new KnowledgeService(backupPath);
    try {
      assert.deepEqual(restored.preferencesGetMine(jia), [], '恢复后的墓碑仍然生效：偏好不复活');
    } finally {
      restored.close();
    }
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('租户隔离：同主体不同组织是两份独立数据（T02 的租户半边）', () => {
  const { root, service } = makeService();
  try {
    const acme = principal('user:jia', 'acme', 'eu');
    const other = principal('user:jia', 'other', 'eu');
    service.preferencesSetMine(acme, { key: 'output.locale', value: 'zh-CN', expectedRevision: 0 });
    assert.deepEqual(service.preferencesGetMine(other), [], '换组织不继承个人偏好');
    service.preferencesSetMine(other, { key: 'output.locale', value: 'en-US', expectedRevision: 0 });
    assert.equal(service.preferencesGetMine(acme)[0].value, 'zh-CN');
    assert.equal(service.preferencesGetMine(other)[0].value, 'en-US');
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
