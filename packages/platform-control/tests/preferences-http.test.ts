/** L2 偏好 HTTP 面：owner 从认证主体派生（无 owner 参数可传）、修订冲突 409、
 *  访问面未装配时 503 如实降级、服务主体无偏好写权限（403）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import { InProcessKnowledgeAccess } from '../../platform-knowledge/src/access.js';
import { KnowledgeService } from '../../platform-knowledge/src/index.js';
import type { Principal } from '../src/policy.js';

const jia: Principal = { actorId: 'user:jia', kind: 'operator', orgId: 'acme', region: 'eu' };
const yi: Principal = { actorId: 'user:yi', kind: 'operator', orgId: 'acme', region: 'eu' };
const serviceActor: Principal = { actorId: 'service:worker', kind: 'service' };

interface Ctx {
  root: string;
  service: PlatformControlService;
  knowledge: KnowledgeService;
  api?: RunningWorkbenchApi;
}

const setup = async (wireAccess = true): Promise<Ctx> => {
  const root = await mkdtemp(join(tmpdir(), 'platform-pref-http-'));
  const knowledge = new KnowledgeService(join(root, 'knowledge.sqlite'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), null, undefined, { requireArtifacts: false });
  if (wireAccess) service.setKnowledgeAccess(new InProcessKnowledgeAccess(knowledge));
  const api = await startWorkbenchServer({ service, authenticate: () => jia });
  return { root, service, knowledge, api };
};

const teardown = async (ctx: Ctx) => {
  await ctx.api?.close();
  ctx.service.close();
  ctx.knowledge.close();
  await rm(ctx.root, { recursive: true, force: true });
};

test('偏好经 HTTP 全生命周期：保存→读取→暂停→删除；主体来自认证（T01）', async () => {
  const ctx = await setup();
  try {
    const url = ctx.api!.url;
    const put = await fetch(`${url}/api/preferences/review.summaryOrder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'exceptionsFirst', expectedRevision: 0 }),
    });
    assert.equal(put.status, 200);
    const saved = (await put.json()) as { revision: number; owner: string; pluginKey: string };
    assert.equal(saved.revision, 1);
    assert.equal(saved.owner, 'user:jia');
    assert.equal(saved.pluginKey, '');
    const list = await fetch(`${url}/api/preferences`).then((res) => res.json()) as { items: Array<{ key: string }> };
    assert.deepEqual(list.items.map((item) => item.key), ['review.summaryOrder']);
    // 伪造 owner 无效：owner 永远来自已验证身份
    const forged = await fetch(`${url}/api/preferences/output.locale`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'zh-CN', expectedRevision: 0, owner: 'user:yi' }),
    });
    assert.equal(((await forged.json()) as { owner: string }).owner, 'user:jia');
    // 修订冲突 → 409 + 代码（不用最后写入覆盖）
    const stale = await fetch(`${url}/api/preferences/review.summaryOrder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'asIs', expectedRevision: 0 }),
    });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { code: string }).code, 'PREFERENCE_REVISION_STALE');
    const paused = await fetch(`${url}/api/preferences/review.summaryOrder/pause`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(((await paused.json()) as { state: string }).state, 'PAUSED');
    const removed = await fetch(`${url}/api/preferences/review.summaryOrder`, { method: 'DELETE' });
    assert.equal(((await removed.json()) as { state: string }).state, 'DELETED');
    const after = await fetch(`${url}/api/preferences`).then((res) => res.json()) as { items: Array<{ key: string }> };
    assert.deepEqual(after.items.map((item) => item.key), ['output.locale'], '只删除了 review.summaryOrder；伪造 PUT 的 output.locale 归属仍是甲');
  } finally {
    await teardown(ctx);
  }
});

test('乙得不到甲的偏好：清单为空、未知键拒绝、越权掩蔽', async () => {
  const ctx = await setup();
  try {
    const url = ctx.api!.url;
    await fetch(`${url}/api/preferences/output.locale`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'zh-CN', expectedRevision: 0 }),
    });
    // 乙调用（换 authenticator 的返回值验证需要另一个服务实例；这里直接验证服务端按主体派生）
    const other = new PlatformControlService(join(ctx.root, 'control-b.sqlite'), null, undefined, { requireArtifacts: false });
    other.setKnowledgeAccess(new InProcessKnowledgeAccess(ctx.knowledge));
    try {
      assert.deepEqual(await other.preferencesGetMine(yi), []);
      const asYi = await other.preferencesSetMine(yi, { key: 'output.locale', value: 'en-US', expectedRevision: 0 });
      assert.equal(asYi.owner, 'user:yi');
      assert.equal((await other.preferencesGetMine(yi)).length, 1);
      assert.equal((await ctx.service.preferencesGetMine(jia))[0].value, 'zh-CN', '甲不受影响');
    } finally {
      other.close();
    }
    // 未知键 400
    const unknown = await fetch(`${url}/api/preferences/system.prompt`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x', expectedRevision: 0 }),
    });
    assert.equal(unknown.status, 400);
    assert.equal(((await unknown.json()) as { code: string }).code, 'PREFERENCE_KEY_UNKNOWN');
    // 合法但从未设置过的键删除 → 404（掩蔽语义：与不存在不可区分）；无效键是 400（键校验先于存在性）
    const missing = await fetch(`${url}/api/preferences/review.summaryOrder`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { code: string }).code, 'PREFERENCE_NOT_FOUND');
    const invalid = await fetch(`${url}/api/preferences/system.prompt`, { method: 'DELETE' });
    assert.equal(invalid.status, 400);
  } finally {
    await teardown(ctx);
  }
});

test('服务主体无偏好写权限（403）；访问面未装配时 503 降级（§5 故障语义）', async () => {
  const ctx = await setup();
  try {
    // 服务主体（worker/scheduler）不在偏好授权集内：kind 门禁在服务层强制（authorize 同步抛错）
    await assert.rejects(
      async () => {
        await ctx.service.preferencesSetMine(serviceActor, { key: 'output.locale', value: 'zh-CN', expectedRevision: 0 });
      },
      (error: unknown) => (error as { code?: string }).code === 'PLATFORM_AUTHORIZATION_DENIED',
    );
  } finally {
    await teardown(ctx);
  }

  const bare = await mkdtemp(join(tmpdir(), 'platform-pref-bare-'));
  const bareService = new PlatformControlService(join(bare, 'control.sqlite'), null, undefined, { requireArtifacts: false });
  const bareApi = await startWorkbenchServer({ service: bareService, authenticate: () => jia });
  try {
    const response = await fetch(`${bareApi.url}/api/preferences`);
    assert.equal(response.status, 503, '偏好服务不可用 → 503（工作台按标准呈现继续工作）');
    assert.equal(((await response.json()) as { code: string }).code, 'KNOWLEDGE_SERVICE_UNAVAILABLE');
  } finally {
    await bareApi.close();
    bareService.close();
    await rm(bare, { recursive: true, force: true });
  }
});
