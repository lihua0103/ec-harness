/** L1 权威服务 HTTP 面：认证失败关闭、两客户端同服务、主体/租户来自连接而非请求体、
 *  越权与不存在对无权限方不可区分（404 掩蔽）、错误日志不含正文。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { KnowledgeService, createKnowledgeServiceServer, headerIdentityAuthenticator } from '../lib/index.js';

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-http-'));
  const service = new KnowledgeService(join(root, 'knowledge.sqlite'));
  const server = createKnowledgeServiceServer({
    service,
    authenticator: headerIdentityAuthenticator({ token: 'secret-token' }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const call = async (path, { subject, orgId, region, token = 'secret-token', body } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (subject !== undefined) headers['x-dsh-subject'] = subject;
    if (orgId !== undefined) headers['x-dsh-org'] = orgId;
    if (region !== undefined) headers['x-dsh-region'] = region;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, payload: await response.json() };
  };
  return { root, service, server, call, url: `http://127.0.0.1:${port}` };
};

const teardown = ({ root, service, server }) => {
  server.close();
  service.close();
  rmSync(root, { recursive: true, force: true });
};

test('健康检查、认证失败关闭、未知路由 404', async () => {
  const ctx = await setup();
  try {
    const health = await fetch(`${ctx.url}/health`);
    assert.equal(health.status, 200);
    const noToken = await ctx.call('/preferences/get', { token: null, subject: 'user:a' });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.payload.error, 'KNOWLEDGE_AUTH_REQUIRED');
    const wrongToken = await ctx.call('/preferences/get', { token: 'wrong', subject: 'user:a' });
    assert.equal(wrongToken.status, 401);
    const missingSubject = await ctx.call('/preferences/get', {});
    assert.equal(missingSubject.status, 401);
    assert.equal(missingSubject.payload.error, 'KNOWLEDGE_AUTH_REQUIRED', '认证错误统一掩蔽：没有主体断言就没有身份');
    const unknown = await ctx.call('/no/such/route', { subject: 'user:a' });
    assert.equal(unknown.status, 404);
  } finally {
    teardown(ctx);
  }
});

test('两台客户端（两个主体）经同一服务：甲的偏好乙不可见', async () => {
  const ctx = await setup();
  try {
    const jia = { subject: 'user:jia', orgId: 'acme', region: 'eu' };
    const set = await ctx.call('/preferences/set', {
      ...jia, body: { key: 'review.summaryOrder', value: 'exceptionsFirst', expectedRevision: 0 },
    });
    assert.equal(set.status, 200);
    assert.equal(set.payload.result.revision, 1);
    const mine = await ctx.call('/preferences/get', { ...jia });
    assert.equal(mine.payload.result.length, 1, '/preferences/get 直接返回本人条目数组');
    const yi = await ctx.call('/preferences/get', { subject: 'user:yi', orgId: 'acme', region: 'eu' });
    assert.deepEqual(yi.payload.result, [], '乙得不到甲的条目、计数或正文');
    // 请求体伪造身份无效：owner 来自连接头
    const forged = await ctx.call('/preferences/set', {
      subject: 'user:yi', orgId: 'acme', region: 'eu',
      body: { key: 'review.summaryOrder', value: 'chronological', expectedRevision: 0, owner: 'user:jia' },
    });
    assert.equal(forged.status, 200);
    assert.equal(forged.payload.result.owner, 'user:yi', 'body 里的 owner 字段被忽略');
    assert.deepEqual((await ctx.call('/preferences/get', { ...jia })).payload.result[0].value, 'exceptionsFirst');
    // 版本冲突经 HTTP 如实映射 409
    const stale = await ctx.call('/preferences/set', {
      ...jia, body: { key: 'review.summaryOrder', value: 'asIs', expectedRevision: 0 },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.payload.error, 'PREFERENCE_REVISION_STALE');
  } finally {
    teardown(ctx);
  }
});

test('私人草稿经服务隔离；快照解析按连接租户过滤；租户越权上下文被拒', async () => {
  const ctx = await setup();
  try {
    // 预置 acme 组织的一条 ACTIVE 知识（快照只绑 ACTIVE；claims/coverage 最小套件）
    const context = { pluginId: 'demo', projectId: 'P-1', orgId: 'acme', region: 'eu' };
    const captured = ctx.service.capture(context, {
      knowledgeId: 'demo.k1', scope: 'plugin', pluginId: 'demo', kind: 'technical_method',
      title: 't', problemSignal: 's', cause: 'c', method: 'm', scenarios: [], edc: [], topics: [],
      preconditions: ['p'], notApplicable: ['n'], counterexamples: ['c'], sources: ['s'], claims: ['claim k1'],
    });
    ctx.service.registerValidator('demo', {
      id: 'suite-k1', version: '1', knowledgeIds: ['demo.k1'],
      coverage: [{ knowledgeId: 'demo.k1', candidateDigest: captured.contentDigest, claims: ['claim k1'] }],
      cases: [
        { id: 'pos', group: 'positive', input: 1, expected: 1 },
        { id: 'neg', group: 'negative', input: 2, expected: 2 },
        { id: 'bnd', group: 'boundary', input: 3, expected: 3 },
      ],
      execute: async (_record, testCase) => testCase.input,
    });
    await ctx.service.validate(context, 'demo.k1', captured.revision, 'suite-k1');
    const created = await ctx.call('/drafts/create', {
      subject: 'user:jia', orgId: 'acme', region: 'eu',
      body: { pluginId: 'demo', title: '我的排查习惯', body: '先看异常清单' },
    });
    assert.equal(created.status, 200);
    const yiList = await ctx.call('/drafts/list', { subject: 'user:yi', orgId: 'acme', region: 'eu' });
    assert.deepEqual(yiList.payload.result, [], '乙看不到甲的私人草稿');
    const yiUpdate = await ctx.call('/drafts/update', {
      subject: 'user:yi', orgId: 'acme', region: 'eu',
      body: { draftId: created.payload.result.draftId, expectedRevision: 1, body: '篡改' },
    });
    assert.equal(yiUpdate.status, 404, '越权与不存在对无权限方不可区分');
    // 快照解析：租户来自连接（x-dsh-org），请求体携带的 orgId 必须一致否则拒绝
    const snapshot = await ctx.call('/snapshot/resolve', {
      subject: 'user:jia', orgId: 'acme', region: 'eu',
      body: { pluginId: 'demo', projectId: 'P-1' },
    });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.payload.result.total, 1);
    const escalated = await ctx.call('/snapshot/resolve', {
      subject: 'user:jia', orgId: 'acme', region: 'eu',
      body: { pluginId: 'demo', projectId: 'P-1', orgId: 'other' },
    });
    assert.equal(escalated.status, 400, '请求体不能改写租户');
  } finally {
    teardown(ctx);
  }
});

test('学习个案与发布面经服务：身份派生租户、错误掩蔽', async () => {
  const ctx = await setup();
  try {
    const context = { pluginId: 'demo', projectId: 'P-1', orgId: 'acme', region: 'eu' };
    const opened = await ctx.call('/learning/cases/open', {
      subject: 'user:agent', orgId: 'acme', region: 'eu',
      body: {
        context,
        sourceEvent: {
          eventId: 'run-9', contributor: 'platform-control', projectionVersion: '1',
          kind: 'run.failed', runId: 'run-9',
        },
        hypothesisKey: 'h1',
      },
    });
    assert.equal(opened.status, 200);
    assert.equal(opened.payload.result.case.orgId, 'acme');
    // 另一组织的清单看不到
    const otherList = await ctx.call('/learning/cases/list', {
      subject: 'user:agent', orgId: 'other', region: 'eu',
      body: { context: { ...context, orgId: 'other' } },
    });
    assert.deepEqual(otherList.payload.result, []);
    // 不存在的发布掩蔽为 404（代码级）
    const missing = await ctx.call('/releases/withdraw', {
      subject: 'release:manager', orgId: 'acme', region: 'eu',
      body: { releaseId: 'release:missing', reason: 'x' },
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.payload.error, 'RELEASE_NOT_FOUND');
  } finally {
    teardown(ctx);
  }
});
