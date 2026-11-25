// W2 验收（R2/R6）：员工入口与默认路由。
// R2 —— 项目作用域由服务端从资源归属解析，在分页、搜索和直达之前生效（含无 workspace 的
//       Work 与无 Work 的 Run）；目录只分页下发可创建发布的有界摘要，不下发未选中视图。
// R6 —— 普通默认切换/回退与安全撤权是不同写入动作；已撤权版本不能成为默认；无有效指向
//       不开放新 Work、不猜版本；过期表单与过期指向版本都在事务内被拒，不产生任何写入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService } from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import {
  AuthorizationError,
  LocalOperatorPolicy,
  type PlatformAction,
  type PlatformPolicy,
  type Principal,
  type ResourceScope,
} from '../src/policy.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:w2-root', kind: 'operator' };
const approver: Principal = { actorId: 'user:qa-lead', kind: 'operator' };
const alice: Principal = { actorId: 'session:w2-alice', kind: 'operator' };
const bob: Principal = { actorId: 'session:w2-bob', kind: 'operator' };
const code = (expected: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === expected;
const denied = (expected: string) => (error: unknown) =>
  error instanceof AuthorizationError && error.code === expected;

/** Two identities with different project scopes. Deliberately omits visibleProjects so the
 *  service resolves the scope by probing authorize per project (the R2 fallback path). */
class DualIdentityPolicy implements PlatformPolicy {
  private readonly base = new LocalOperatorPolicy();
  constructor(private readonly scope: Map<string, string[]>) {}
  authorize(principal: Principal, action: PlatformAction, resource?: ResourceScope): void {
    this.base.authorize(principal, action, resource);
    const projects = this.scope.get(principal.actorId);
    if (projects && resource?.projectId !== undefined && !projects.includes(resource.projectId)) {
      throw new AuthorizationError('PLATFORM_PROJECT_ACCESS_DENIED', resource.projectId);
    }
  }
}

test('R2: two projects, two identities — scope resolved server-side before lists, cross-page queries, search and direct access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-w2-scope-'));
  // The scope map is filled after the projects exist; the policy reads it by reference.
  const scope = new Map<string, string[]>();
  const service = new PlatformControlService(join(root, 'control.sqlite'), null, new DualIdentityPolicy(scope));
  try {
    service.registerApp(draft(), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    const prjA = service.createProject({ name: '项目A' }, operator);
    const prjB = service.createProject({ name: '项目B' }, operator);
    scope.set(alice.actorId, [prjA.projectId]);
    scope.set(bob.actorId, [prjB.projectId]);

    // Workspace-less Works: projectId lives on the Work row, never inferred from parameters.
    const workA1 = service.createWork({ projectId: prjA.projectId, appId: 'listing', appVersion: '1.0.0', title: '阿尔法一' }, alice);
    const workA2 = service.createWork({ projectId: prjA.projectId, appId: 'listing', appVersion: '1.0.0', title: '阿尔法二' }, alice);
    const workA3 = service.createWork({ projectId: prjA.projectId, appId: 'listing', appVersion: '1.0.0', title: '阿尔法三' }, alice);
    const workB1 = service.createWork({ projectId: prjB.projectId, appId: 'listing', appVersion: '1.0.0', title: '贝塔一' }, bob);
    const runB = service.createWorkRun(workB1.workId, { goal: '贝塔运行' }, bob);
    const runBare = service.createRun('listing', '1.0.0', { goal: '无工作运行' }, operator);

    const aIds = () => service.listWorks(undefined, 0, 50, alice).items.map((work) => work.workId);
    assert.deepEqual(new Set(aIds()), new Set([workA1.workId, workA2.workId, workA3.workId]), '列表只含本人项目的 Work');

    // Cross-page cursor query stays inside the scope: 3 in-scope works, limit 2 → exactly 2 pages.
    const page1 = service.queryWorks({}, null, 2, alice);
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor, '有下一页游标');
    const page2 = service.queryWorks({}, page1.nextCursor, 2, alice);
    assert.equal(page2.items.length, 1);
    assert.equal(page2.nextCursor, null);
    const seen = [...page1.items, ...page2.items].map((work) => work.workId).sort();
    assert.deepEqual(seen, [workA1.workId, workA2.workId, workA3.workId].sort(), '分页并集恰好是作用域内全部 Work');

    // An explicit out-of-scope projectId filter is denied, not silently emptied.
    assert.throws(
      () => service.queryWorks({ projectId: prjB.projectId }, null, 50, alice),
      denied('PLATFORM_PROJECT_ACCESS_DENIED'),
    );
    assert.throws(
      () => service.queryRuns({ projectId: prjB.projectId }, null, 50, alice),
      denied('PLATFORM_PROJECT_ACCESS_DENIED'),
    );

    // Direct access to another project's rows — including workspace-less Works — is denied.
    assert.throws(() => service.getWork(workB1.workId, alice), denied('PLATFORM_PROJECT_ACCESS_DENIED'));
    assert.throws(() => service.archiveWork(workB1.workId, alice), denied('PLATFORM_PROJECT_ACCESS_DENIED'));
    assert.throws(() => service.runsForWork(workB1.workId, 0, 10, alice), denied('PLATFORM_PROJECT_ACCESS_DENIED'));

    // Search never leaks the other project; the owning identity does see its own hit.
    const hitsA = service.globalSearch('贝塔', alice);
    assert.equal(hitsA.some((hit) => hit.kind === 'work' && hit.id === workB1.workId), false, '搜索不泄露他项目 Work');
    const hitsB = service.globalSearch('贝塔', bob);
    assert.ok(hitsB.some((hit) => hit.kind === 'work' && hit.id === workB1.workId), '属主身份能搜到自己的 Work');

    // Run scope is resolved from server-side ownership (the Work row), not request parameters.
    const runsA = service.queryRuns({}, null, 50, alice).items.map((run) => run.runId);
    assert.equal(runsA.includes(runB.runId), false, '他项目 Work 的运行不可见');

    // A work-less run has no project at all: hidden from every scoped identity, visible to
    // the unrestricted deployment identity — fail-closed, never guessed into a scope.
    assert.equal(service.queryRuns({}, null, 50, alice).items.some((run) => run.runId === runBare.runId), false);
    assert.equal(service.queryRuns({}, null, 50, bob).items.some((run) => run.runId === runBare.runId), false);
    assert.throws(() => service.getRun(runBare.runId, alice), denied('PLATFORM_PROJECT_ACCESS_DENIED'));
    assert.ok(
      service.queryRuns({}, null, 50, operator).items.some((run) => run.runId === runBare.runId),
      '无项目限制的部署身份可见无 Work 的运行',
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('R2: per-project catalog paginates only creatable releases and ships bounded summaries, never unselected views', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-w2-catalog-'));
  const path = join(root, 'control.sqlite');
  const service = new PlatformControlService(path, null, new LocalOperatorPolicy(), { requireReleaseApproval: true });
  try {
    const project = service.createProject({ name: '目录项目' }, operator);
    const other = service.createProject({ name: '其他项目' }, operator);
    // Before any policy restriction: an unknown project is a plain existence failure.
    assert.throws(() => service.catalogSummaries('PRJ-UNKNOWN', null, 10, operator), code('PROJECT_NOT_FOUND'));

    const pointered: string[] = [];
    for (let i = 1; i <= 100; i++) {
      const id = `app-${String(i).padStart(3, '0')}`;
      const app = draft(id);
      service.registerApp(app, operator);
      const record = service.getApp(id, '1.0.0', operator);
      service.approveRelease({
        appId: record.appId,
        appVersion: record.appVersion,
        releaseDigest: record.releaseDigest,
      }, approver);
      // Mixed eligibility: app-001 never gets a pointer (not creatable — the detail endpoint
      // must refuse honestly); app-002 gets one and is then security-revoked (a pointer at a
      // revoked release is honestly omitted); app-005 stays pointered but is denied by policy.
      if (id !== 'app-001') {
        service.setDefaultRelease(id, '1.0.0', { expectedRevision: null }, operator);
        pointered.push(id);
      }
      if (id === 'app-002') service.revokeApp(id, '1.0.0', '安全撤权', operator);
    }

    // Now restrict the deployment identity to one project; app-001 (no pointer) stays allowed
    // so the missing-pointer refusal is reachable, app-005 is denied outright.
    const policy = new LocalOperatorPolicy({
      allowedProjects: [project.projectId],
      allowedApps: [...pointered, 'app-001'].filter((id) => id !== 'app-005'),
    });
    service.setPolicy(policy);

    // Authorization precedes existence: unknown vs forbidden are indistinguishable in what they reveal.
    assert.throws(() => service.catalogSummaries('PRJ-UNKNOWN', null, 10, operator), denied('PLATFORM_PROJECT_ACCESS_DENIED'));
    assert.throws(() => service.catalogSummaries(other.projectId, null, 10, operator), denied('PLATFORM_PROJECT_ACCESS_DENIED'));

    assert.throws(() => service.catalogSummaries(project.projectId, null, 0, operator), code('CATALOG_PAGE_INVALID'));
    assert.throws(() => service.catalogSummaries(project.projectId, null, 101, operator), code('CATALOG_PAGE_INVALID'));
    assert.throws(
      () => service.catalogSummaries(project.projectId, 'tampered!!', 10, operator),
      code('CATALOG_PAGE_INVALID'),
    );

    // Walk every page: keyset pagination over exactly the creatable set, in ascending order.
    const expected = pointered.filter((id) => id !== 'app-002' && id !== 'app-005').sort();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = service.catalogSummaries(project.projectId, cursor, 10, operator);
      pages += 1;
      seen.push(...page.items.map((item) => item.appId));
      cursor = page.nextCursor;
      assert.ok(pages <= 20, '分页必须收敛');
    } while (cursor);
    assert.equal(pages, 10, '97 个可创建应用按 limit=10 恰好 10 页');
    assert.deepEqual(seen, expected, '只返回可创建发布：无指向、已撤权、策略拒绝者均被省略');

    // Bounded summaries: identity + display name + availability digests + pointer facts. No
    // descriptor, no result views, no input schema — the unselected view is never shipped.
    const first = service.catalogSummaries(project.projectId, null, 1, operator).items[0];
    assert.deepEqual(Object.keys(first).sort(), [
      'appId', 'appVersion', 'displayName', 'listingTypes', 'planDigest', 'releaseDigest', 'revision', 'updatedAt',
    ]);

    // Detail is resolved through the server-owned pointer, never a browser-supplied version.
    const detail = service.catalogRelease('app-006', project.projectId, operator);
    assert.equal(detail.app.appVersion, '1.0.0');
    assert.equal(detail.catalog.appId, 'app-006');
    assert.throws(() => service.catalogRelease('app-001', project.projectId, operator), code('APP_DEFAULT_RELEASE_MISSING'), '允许但无指向：如实拒绝，不猜版本');
    assert.throws(() => service.catalogRelease('app-002', project.projectId, operator), code('APP_RELEASE_NOT_ACTIVE'), '指针指向已撤权版本时详情如实拒绝');
    assert.throws(() => service.catalogRelease('app-005', project.projectId, operator), denied('PLATFORM_APP_ACCESS_DENIED'));
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('R6: a revoked version can never become default; revocation, default switch and rollback are distinct writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-w2-revoke-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), null, new LocalOperatorPolicy(), {
    requireReleaseApproval: true,
  });
  try {
    const project = service.createProject({ name: '回退项目' }, operator);
    service.registerApp(draft('listing', '0.9.0'), operator);
    service.registerApp(draft('listing', '1.0.0'), operator);
    for (const version of ['0.9.0', '1.0.0']) {
      const record = service.getApp('listing', version, operator);
      service.approveRelease({
        appId: record.appId,
        appVersion: record.appVersion,
        releaseDigest: record.releaseDigest,
      }, approver);
    }
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);

    // CAS: a switcher carrying a stale pointer revision cannot commit.
    assert.throws(
      () => service.setDefaultRelease('listing', '0.9.0', { expectedRevision: 99 }, operator),
      code('APP_DEFAULT_REVISION_STALE'),
    );

    // Security revocation ('app.revoke') withdraws the running default.
    service.revokeApp('listing', '1.0.0', '安全撤权', operator);

    // The pointer still names the revoked version: new Work is refused, never silently re-routed.
    assert.throws(
      () => service.createWork({ projectId: project.projectId, appId: 'listing', appVersion: '1.0.0', title: '撤权后' }, operator),
      code('APP_RELEASE_NOT_ACTIVE'),
    );
    // The revoked version cannot be re-selected as default (R6) and cannot be a rollback target.
    assert.throws(
      () => service.setDefaultRelease('listing', '1.0.0', { expectedRevision: 1 }, operator),
      code('APP_RELEASE_NOT_ACTIVE'),
    );
    assert.throws(() => service.rollbackRelease('listing', '1.0.0', '1.0.0', '同版本', operator), code('APP_ROLLBACK_INVALID'));
    assert.throws(() => service.rollbackRelease('listing', '1.0.0', '9.9.9', '无此版本', operator), code('APP_NOT_FOUND'));
    // The catalog honestly omits the app; detail refuses instead of re-routing.
    assert.equal(
      service.catalogSummaries(project.projectId, null, 50, operator).items.some((item) => item.appId === 'listing'),
      false,
    );
    assert.throws(() => service.catalogRelease('listing', project.projectId, operator), code('APP_RELEASE_NOT_ACTIVE'));

    // Ordinary rollback switches the pointer to the approved ACTIVE 0.9.0 and touches neither
    // release's security state.
    const result = service.rollbackRelease('listing', '1.0.0', '0.9.0', '回退', operator);
    assert.equal(result.current.appVersion, '0.9.0');
    assert.equal(service.getApp('listing', '1.0.0', operator).state, 'REVOKED', '回退不改撤权状态');
    assert.equal(service.getApp('listing', '0.9.0', operator).state, 'ACTIVE');

    // New Work now routes through the pointer to 0.9.0; a form still carrying 1.0.0 writes nothing.
    const before = service.listWorks(undefined, 0, 50, operator).total;
    assert.throws(
      () => service.createWork({ projectId: project.projectId, appId: 'listing', appVersion: '1.0.0', title: '旧表单' }, operator),
      code('APP_DEFAULT_RELEASE_CONFLICT'),
    );
    assert.equal(service.listWorks(undefined, 0, 50, operator).total, before, '过期表单不产生 Work');
    const work = service.createWork({ projectId: project.projectId, appId: 'listing', appVersion: '0.9.0', title: '回退后工作' }, operator);
    assert.equal(work.appVersion, '0.9.0');

    // Audit trail keeps the two write paths distinct and named.
    const actions = service.audit(0, 100, operator).items.map((entry) => entry.action);
    assert.ok(actions.includes('APP_DEFAULT_RELEASE_SET'), '指向初始化有审计');
    assert.ok(actions.includes('APP_DEFAULT_RELEASE_ROLLED_BACK'), '普通回退有自己的审计动作');
    assert.ok(actions.includes('APP_RELEASE_REVOKED'), '安全撤权有自己的审计动作');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W2: a form seen before a concurrent default switch conflicts and writes nothing; pointer persists across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-w2-race-'));
  const path = join(root, 'control.sqlite');
  const service = new PlatformControlService(path);
  try {
    const project = service.createProject({ name: '并发项目' }, operator);
    service.registerApp(draft('listing', '0.9.0'), operator);
    service.registerApp(draft('listing', '1.0.0'), operator);
    const initialized = service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    assert.equal(initialized.revision, 1);

    // Another deployment session switches the default with the revision it saw.
    const switched = service.setDefaultRelease('listing', '0.9.0', { expectedRevision: 1 }, operator);
    assert.equal(switched.revision, 2);

    // A form loaded before that switch now conflicts — inside the write transaction, no Work.
    const before = service.listWorks(undefined, 0, 50, operator).total;
    assert.throws(
      () => service.createWork({ projectId: project.projectId, appId: 'listing', appVersion: '1.0.0', title: '并发表单' }, operator),
      code('APP_DEFAULT_RELEASE_CONFLICT'),
    );
    assert.equal(service.listWorks(undefined, 0, 50, operator).total, before);
    const fresh = service.createWork({ projectId: project.projectId, appId: 'listing', appVersion: '0.9.0', title: '刷新后' }, operator);
    assert.equal(fresh.appVersion, '0.9.0');

    // No valid selection → new Work is not open, and no version is ever guessed.
    service.registerApp(draft('dvp'), operator);
    assert.throws(
      () => service.createWork({ projectId: project.projectId, appId: 'dvp', appVersion: '1.0.0', title: '无指向' }, operator),
      code('APP_DEFAULT_RELEASE_MISSING'),
    );
    assert.throws(
      () => service.createWork({ projectId: project.projectId, appId: 'ghost', appVersion: '1.0.0', title: '未注册' }, operator),
      code('APP_NOT_FOUND'),
    );

    // The pointer and its revision survive close/reopen.
    service.close();
    const reopened = new PlatformControlService(path);
    try {
      const pointer = reopened.defaultRelease('listing', operator);
      assert.equal(pointer?.appVersion, '0.9.0');
      assert.equal(pointer?.revision, 2);
      // Catalog detail resolves through the server-owned pointer.
      const detail = reopened.catalogRelease('listing', project.projectId, operator);
      assert.equal(detail.app.appVersion, '0.9.0');
      assert.equal(detail.catalog.revision, 2);
    } finally {
      reopened.close();
    }
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W2: /api/workbench ships bounded app summaries; catalog and default-release are first-class routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-w2-http-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'));
  let api: RunningWorkbenchApi | undefined;
  try {
    const project = service.createProject({ name: 'HTTP项目' }, operator);
    service.registerApp(draft('listing', '0.9.0'), operator);
    service.registerApp(draft('listing', '1.0.0'), operator);
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    api = await startWorkbenchServer({ service, authenticate: () => operator });

    // The employee home no longer ships full declarations — bounded summaries only.
    const home = await fetch(`${api.url}/api/workbench`).then((res) => res.json()) as { apps: Array<Record<string, unknown>> };
    assert.equal(home.apps.length, 2, 'ACTIVE 发布都在员工首页');
    for (const app of home.apps) {
      assert.equal('descriptor' in app, false, '不下发完整声明');
      assert.deepEqual(Object.keys(app).sort(), ['appId', 'appVersion', 'displayName', 'listingTypes', 'planDigest', 'releaseDigest', 'state']);
    }

    const catalog = await fetch(`${api.url}/api/catalog?projectId=${project.projectId}`).then((res) => res.json()) as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    assert.equal(catalog.items.length, 1);
    assert.deepEqual(Object.keys(catalog.items[0]).sort(), [
      'appId', 'appVersion', 'displayName', 'listingTypes', 'planDigest', 'releaseDigest', 'revision', 'updatedAt',
    ]);

    const detail = await fetch(`${api.url}/api/catalog/listing?projectId=${project.projectId}`).then((res) => res.json()) as {
      app: { appVersion: string };
      catalog: { appVersion: string; revision: number };
    };
    assert.equal(detail.app.appVersion, '1.0.0');
    assert.equal(detail.catalog.appVersion, '1.0.0');

    // Default release: read, CAS switch, stale switch refused.
    const pointer = await fetch(`${api.url}/api/apps/listing/default-release`).then((res) => res.json()) as {
      default: { appVersion: string; revision: number };
    };
    assert.equal(pointer.default.appVersion, '1.0.0');
    assert.equal(pointer.default.revision, 1);
    const switched = await fetch(`${api.url}/api/apps/listing/default-release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.9.0', expectedRevision: 1 }),
    });
    assert.equal(switched.status, 200);
    assert.equal(((await switched.json()) as { appVersion: string }).appVersion, '0.9.0');
    const stale = await fetch(`${api.url}/api/apps/listing/default-release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.0.0', expectedRevision: 1 }),
    });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { code: string }).code, 'APP_DEFAULT_REVISION_STALE');

    // A stale Work form (loaded while the default was 1.0.0) is a 409 conflict and writes nothing.
    const worksBefore = await fetch(`${api.url}/api/works`).then((res) => res.json()) as { total: number };
    const conflict = await fetch(`${api.url}/api/works`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.projectId, appId: 'listing', appVersion: '1.0.0', title: 'HTTP 旧表单' }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { code: string }).code, 'APP_DEFAULT_RELEASE_CONFLICT');
    const worksAfter = await fetch(`${api.url}/api/works`).then((res) => res.json()) as { total: number };
    assert.equal(worksAfter.total, worksBefore.total);
    const created = await fetch(`${api.url}/api/works`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.projectId, appId: 'listing', appVersion: '0.9.0', title: 'HTTP 新表单' }),
    });
    assert.equal(created.status, 201);
    assert.equal(((await created.json()) as { appVersion: string }).appVersion, '0.9.0');
  } finally {
    await api?.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
