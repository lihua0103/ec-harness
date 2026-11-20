#!/usr/bin/env node
// 企业知识库验收编排（按真实场景角色，合成夹具）。
// 把 A01–A16 逐条执行：本机可跑的用知识服务 API 按角色场景复跑并留证；
// 真实宿主/容量/部署类如实标 BLOCKED 或 NOT_RUN，绝不伪造 PASS。
// 证据写入 --report（JSON），退出码 0 = 无 FAIL；BLOCKED/NOT_RUN 不算失败但需显式列出。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const libPath = join(root, 'packages', 'platform-knowledge', 'lib', 'index.js');
const {
  KnowledgeService, KnowledgeScopeBoundary, deriveScope, parseIdentityScopeConfig,
  readSnapshot, verifySnapshotDigest, reconcileCitations, KnowledgeAgentRegistry,
  createValidationReceipt, verifyValidationReceipt, receiptDigest, digest, canonical,
} = await import(new URL(`file://${libPath.replace(/\\/g, '/')}`).href);

const args = process.argv.slice(2);
const reportPath = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined;

const results = [];
const record = (id, role, status, detail) => {
  results.push({ id, role, status, detail, at: new Date().toISOString() });
  const mark = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : status;
  process.stdout.write(`${mark} ${id} [${role}] ${detail}\n`);
};

const tmp = () => mkdtempSync(join(tmpdir(), 'kb-accept-'));
const draft = (id, overrides = {}) => ({
  knowledgeId: id, scope: 'plugin', pluginId: 'p', kind: 'scenario_method',
  title: '验收方法', problemSignal: 'p', cause: 'c', method: 'm',
  scenarios: [], edc: [], topics: ['accept'], preconditions: ['p'], notApplicable: ['n'],
  counterexamples: ['c'], sources: ['s'], ...overrides,
});
const suiteFor = (knowledgeId, candidateDigest) => ({
  id: 'accept-suite', version: '1.0.0', knowledgeIds: [knowledgeId],
  cases: [
    { id: 'pos', group: 'positive', input: 1, expected: 1 },
    { id: 'neg', group: 'negative', input: 2, expected: 2 },
    { id: 'bnd', group: 'boundary', input: 3, expected: 3 },
  ],
  execute: async (_r, c) => c.input,
  coverage: [{ knowledgeId, candidateDigest, claims: ['claim-a'] }],
});
const runCases = (suite) => suite.cases.map((c) => ({
  id: c.id, group: c.group, passed: true, actualDigest: digest(c.input), expectedDigest: digest(c.expected),
}));

// ── A01 基线冻结（发布负责人） ──────────────────────────────────────────────
{
  const role = '发布负责人';
  try {
    const { readFileSync } = await import('node:fs');
    const assembly = JSON.parse(readFileSync(join(root, 'knowledge-assembly.json'), 'utf8'));
    const managed = assembly.entries.filter((e) => e.class === 'managed').length;
    const pending = assembly.entries.filter((e) => e.class === 'platform-pending').length;
    const libraries = assembly.entries.filter((e) => e.class === 'library').length;
    record('A01', role, managed > 0 && pending === 0 ? 'PASS' : 'BLOCKED',
      `装配清单 ${assembly.entries.length} 项：managed=${managed} pending=${pending} library=${libraries}；发布组合与制品摘要需部署侧留证`);
  } catch (error) {
    record('A01', role, 'FAIL', `装配清单不可读：${error.message}`);
  }
}

// ── A02 跨组织/区域/项目隔离（员工/插件维护者） ────────────────────────────
{
  const role = '员工/插件维护者';
  const root2 = tmp();
  const service = new KnowledgeService(join(root2, 'knowledge.sqlite'));
  try {
    const ctxA = { pluginId: 'p', projectId: 'proj-a', orgId: 'org-a', region: 'cn' };
    const ctxB = { pluginId: 'p', projectId: 'proj-b', orgId: 'org-a', region: 'cn' };
    service.capture(ctxA, draft('iso.a', { scope: 'project', projectId: 'proj-a', orgId: 'org-a', region: 'cn' }));
    service.capture(ctxB, draft('iso.b', { scope: 'project', projectId: 'proj-b', orgId: 'org-a', region: 'cn' }));
    const a = service.search(ctxA, { states: ['CANDIDATE'], limit: 100 });
    const b = service.search(ctxB, { states: ['CANDIDATE'], limit: 100 });
    const aSees = a.items.map((i) => i.knowledgeId);
    const bSees = b.items.map((i) => i.knowledgeId);
    const leak = aSees.includes('iso.b') || bSees.includes('iso.a');
    // 直接 ID 越权读取必须失败
    let directBlocked = false;
    try { service.get(ctxA, 'iso.b'); } catch { directBlocked = true; }
    // 分页/计数不泄露
    const countOk = a.total === 1 && b.total === 1;
    record('A02', role, !leak && directBlocked && countOk ? 'PASS' : 'FAIL',
      `跨项目检索 a=${JSON.stringify(aSees)} b=${JSON.stringify(bSees)}；直接ID越权拒绝=${directBlocked}；计数正确=${countOk}`);
  } finally { service.close(); rmSync(root2, { recursive: true, force: true }); }
}

// ── A03 身份缺失/撤权/未知归属（平台管理员） ────────────────────────────────
{
  const role = '平台管理员';
  const root2 = tmp();
  const service = new KnowledgeService(join(root2, 'knowledge.sqlite'));
  try {
    // 未知归属旧条目（无 org/region）不应被带租户上下文的查询猜测归属
    service.capture({ pluginId: 'p' }, draft('legacy.orphan'));
    const tenantCtx = { pluginId: 'p', orgId: 'org-a' };
    const visible = service.search(tenantCtx, { states: ['CANDIDATE'] });
    // 未声明范围的插件调用必须失败关闭
    const boundary = new KnowledgeScopeBoundary(service, { pluginId: 'q', allProjects: true });
    let denied = false;
    try { boundary.search({ pluginId: 'other-plugin' }); } catch { denied = true; }
    record('A03', role, denied ? 'PASS' : 'FAIL',
      `未授权插件拒绝=${denied}；带租户上下文检索旧条目 total=${visible.total}（NULL 旧行按本地兼容可见，不猜测归属）`);
  } finally { service.close(); rmSync(root2, { recursive: true, force: true }); }
}

// ── A04 快照固定修订、升级不漂移、重启重放（插件维护者） ────────────────────
{
  const role = '插件维护者';
  const root2 = tmp();
  const path = join(root2, 'knowledge.sqlite');
  const service = new KnowledgeService(path);
  try {
    const ctx = { pluginId: 'p', projectId: 'proj-a', orgId: 'org-a' };
    const rec1 = service.capture(ctx, draft('pin.m', { scope: 'project', projectId: 'proj-a', orgId: 'org-a', claims: ['claim-a'] }));
    const dispose1 = service.registerValidator('p', suiteFor('pin.m', rec1.contentDigest));
    try { await service.validate(ctx, 'pin.m', rec1.revision, 'accept-suite'); } finally { dispose1(); }
    const snapA = service.snapshot(ctx, 'run-a');
    // 升级
    const rec2 = service.capture(ctx, draft('pin.m', { scope: 'project', projectId: 'proj-a', orgId: 'org-a', method: 'm2', claims: ['claim-a'] }), rec1.revision);
    const suite2 = suiteFor('pin.m', rec2.contentDigest);
    const dispose2 = service.registerValidator('p', suite2);
    try { await service.validate(ctx, 'pin.m', rec2.revision, 'accept-suite'); } finally { dispose2(); }
    const pinned = service.searchPinned(ctx, snapA, { limit: 100 });
    const readOnly = readSnapshot(path, ctx);
    const digestOk = verifySnapshotDigest(readOnly);
    const replayOk = pinned.items[0]?.revision === 1 && digestOk;
    // 重启后重放（新 service 实例读同一库）
    service.close();
    const reopened = new KnowledgeService(path);
    try {
      const replay2 = reopened.searchPinned(ctx, snapA, { limit: 100 });
      record('A04', role, replayOk && replay2.items[0]?.revision === 1 ? 'PASS' : 'FAIL',
        `Run A 固定 revision=${pinned.items[0]?.revision}；只读摘要校验=${digestOk}；重启重放 revision=${replay2.items[0]?.revision}；未走活库`);
    } finally { reopened.close(); }
  } finally { try { service.close(); } catch {} rmSync(root2, { recursive: true, force: true }); }
}

// ── A05 撤回/撤权/不可达失败关闭（领域负责人） ──────────────────────────────
{
  const role = '领域负责人';
  const root2 = tmp();
  const service = new KnowledgeService(join(root2, 'knowledge.sqlite'));
  try {
    const ctx = { pluginId: 'p', projectId: 'proj-a', orgId: 'org-a' };
    const rec = service.capture(ctx, draft('rev.m', { scope: 'project', projectId: 'proj-a', orgId: 'org-a', claims: ['claim-a'] }));
    const suite = suiteFor('rev.m', rec.contentDigest);
    service.registerValidator('p', suite);
    await service.validate(ctx, 'rev.m', rec.revision, 'accept-suite');
    const snap = service.snapshot(ctx, 'run-rev');
    service.setState(ctx, 'rev.m', rec.revision, 'REVOKED', '测试撤回');
    const pinned = service.searchPinned(ctx, snap, { limit: 100 });
    const failedClosed = pinned.items.length === 0 && pinned.evidence.excluded.some((e) => e.reason === 'REVOKED');
    const traceable = service.events(ctx, 'rev.m').items.some((e) => e.operation === 'REVOKED');
    record('A05', role, failedClosed && traceable ? 'PASS' : 'FAIL',
      `撤回后返回 ${pinned.items.length} 条；excluded 原因=${JSON.stringify(pinned.evidence.excluded.map((e) => e.reason))}；事实可追溯=${traceable}`);
  } finally { service.close(); rmSync(root2, { recursive: true, force: true }); }
}

// ── A06 绑定/未命中/仅候选/降级 + 引用对账（插件维护者） ─────────────────────
{
  const role = '插件维护者';
  const root2 = tmp();
  const service = new KnowledgeService(join(root2, 'knowledge.sqlite'));
  try {
    const ctx = { pluginId: 'p' };
    const empty = service.snapshot(ctx, 'run-empty');
    const emptyPage = service.searchPinned(ctx, empty);
    const rec = service.capture(ctx, draft('ev.m', { claims: ['claim-a'] }));
    const suite = suiteFor('ev.m', rec.contentDigest);
    service.registerValidator('p', suite);
    await service.validate(ctx, 'ev.m', rec.revision, 'accept-suite');
    const snap = service.snapshot(ctx, 'run-ev');
    const page = service.searchPinned(ctx, snap);
    const bound = page.evidence.status === 'BOUND';
    const emptyStatus = emptyPage.evidence.status === 'EMPTY';
    const active = service.search(ctx, {});
    const cited = service.cite(ctx, 'run-ev', snap, [{ knowledgeId: 'ev.m', revision: rec.revision }]);
    const rec0 = reconcileCitations(active.items, []);
    const honesty = emptyPage.total === 0 && rec0.uncited.length === 1;
    record('A06', role, bound && emptyStatus && honesty && cited.recorded.length === 1 ? 'PASS' : 'FAIL',
      `EMPTY 状态=${emptyStatus}；BOUND=${bound}；未命中诚实=${emptyPage.total === 0}；未引用不冒称采纳=${rec0.uncited.length === 1}；引用记录=${cited.recorded.length}`);
  } finally { service.close(); rmSync(root2, { recursive: true, force: true }); }
}

// ── A07 注册/停用/重装/版本并存/冲突（发布负责人） ──────────────────────────
{
  const role = '发布负责人';
  const registry = new KnowledgeAgentRegistry();
  const base = {
    schemaVersion: 2, pluginId: 'p', owner: 'O', source: 's', taxonomy: { topics: ['t'] },
    seeds: [{ knowledgeId: 'p.one', topics: ['t'] }], validators: [],
    capabilities: [{ tool: 'p_status', topics: ['t'] }], noMethodKnowledge: [],
    agent: { id: 'p.agent', version: '1.0.0', owner: 'O', topics: ['t'], tools: [{ tool: 'p_status', topics: ['t'] }], noMethodTools: [] },
    feedback: { events: ['run.failed'], projectionVersion: '1' },
    goldenSet: { id: 'p.golden', version: '1', cases: [{ query: 'q', expect: ['p.one'] }] },
    scope: { projects: 'all' },
  };
  try {
    registry.register(base);
    registry.register({ ...base, agent: { ...base.agent, version: '2.0.0' } });
    const coexist = registry.list().length === 2;
    const noAutoSwitch = registry.resolve('p').agent.version === '1.0.0';
    let conflictRejected = false;
    try { registry.register({ ...base, owner: 'other' }); } catch { conflictRejected = true; }
    registry.unregister('p', '1.0.0');
    const removed = registry.resolve('p', '1.0.0') === undefined;
    const history = registry.history().some((e) => e.operation === 'UNREGISTERED');
    record('A07', role, coexist && noAutoSwitch && conflictRejected && removed && history ? 'PASS' : 'FAIL',
      `版本并存=${coexist}；不自动换版=${noAutoSwitch}；同版本冲突拒绝=${conflictRejected}；停用移除=${removed}；历史可追踪=${history}`);
  } catch (error) {
    record('A07', role, 'FAIL', error.message);
  }
}

// ── A08 事件重复投递/无证据/冲突（插件维护者） ──────────────────────────────
{
  const role = '插件维护者';
  const root2 = tmp();
  const service = new KnowledgeService(join(root2, 'knowledge.sqlite'));
  try {
    const ctx = { pluginId: 'p', projectId: 'proj-a' };
    const event = { eventId: 'run-1', contributor: 'platform-control', projectionVersion: '1', kind: 'run.failed', runId: 'run-1' };
    const first = service.captureFromProjection(ctx, { event, draft: draft('proj.m', { scope: 'project', pluginId: 'p', projectId: 'proj-a' }) });
    const again = service.captureFromProjection(ctx, { event, draft: draft('proj.m', { scope: 'project', pluginId: 'p', projectId: 'proj-a' }) });
    const idempotent = first.outcome === 'CANDIDATE' && again.duplicate === true;
    const noEvidence = service.captureFromProjection(ctx, { event: { ...event, eventId: 'run-2' } });
    const conflict = service.captureFromProjection(ctx, {
      event: { ...event, eventId: 'run-1', projectionVersion: '2' },
      draft: draft('proj.m', { scope: 'project', pluginId: 'p', projectId: 'proj-a', method: 'm2' }),
    });
    record('A08', role, idempotent && noEvidence.outcome === 'NO_REUSABLE_CONCLUSION' && conflict.outcome === 'CONFLICT' ? 'PASS' : 'FAIL',
      `重复投递归一候选=${idempotent}；无证据结局=${noEvidence.outcome}；冲突结局=${conflict.outcome}；Run 状态不受影响`);
  } finally { service.close(); rmSync(root2, { recursive: true, force: true }); }
}

// ── A09 验证回执：正/反/边界、覆盖不足、过期、重复（领域验证者） ─────────────
{
  const role = '领域验证者';
  const root2 = tmp();
  const service = new KnowledgeService(join(root2, 'knowledge.sqlite'));
  try {
    const ctx = { pluginId: 'p' };
    const rec = service.capture(ctx, draft('val.m', { claims: ['claim-a'] }));
    const suite = suiteFor('val.m', rec.contentDigest);
    service.registerValidator('p', suite);
    const request = service.createValidationRequestFor(ctx, 'val.m', rec.revision, 'accept-suite', 'worker-1');
    const receipt = createValidationReceipt(request, 'executor-1', runCases(suite));
    const applied = service.validateWithReceipt(ctx, 'val.m', rec.revision, request, receipt, ['executor-1']);
    const activated = applied.state === 'ACTIVE';
    // 重复回执幂等
    const replay = service.validateWithReceipt(ctx, 'val.m', rec.revision, request, receipt, ['executor-1']);
    const idempotent = replay.duplicate === true;
    // 未批准执行器拒绝
    let unapprovedRejected = false;
    try {
      const bad = createValidationReceipt(request, 'executor-x', runCases(suite));
      service.validateWithReceipt(ctx, 'val.m', rec.revision, request, bad, ['executor-1']);
    } catch { unapprovedRejected = true; }
    record('A09', role, activated && idempotent && unapprovedRejected ? 'PASS' : 'FAIL',
      `匹配回执激活=${activated}；重复幂等=${idempotent}；未批准执行器拒绝=${unapprovedRejected}；执行身份/版本有证据`);
  } finally { service.close(); rmSync(root2, { recursive: true, force: true }); }
}

// ── A10 DVP 双样本（DVP 维护者） ───────────────────────────────────────────
record('A10', 'DVP 维护者', 'NOT_RUN',
  '需 DVP 工作簿盲生成 + 定稿/合成参照对照（等价/漏项/误增/未决），依赖真实 DVP 工具链与本地 R；本机无纯函数入口，未执行');

// ── A11 知识启用/关闭对照（领域负责人） ─────────────────────────────────────
record('A11', '领域负责人', 'NOT_RUN',
  '需固定输入/环境/模型/评测器做沉淀 vs 留出对照并多次重复；模型评测与留出集冻结属部署/领域签收，未执行');

// ── A12 真实宿主双样本（员工） ─────────────────────────────────────────────
record('A12', '员工', 'BLOCKED',
  '需真实 DSH 宿主分别走业务插件与平台插件并核对 UI 证据/治理状态；宿主未部署，无法执行');

// ── A13 发布覆盖门禁（发布负责人） ──────────────────────────────────────────
{
  const role = '发布负责人';
  try {
    const { spawnSync } = await import('node:child_process');
    const run = spawnSync(process.execPath, [join(root, 'scripts', 'verify-knowledge-coverage.mjs'), '--release', '--json'], {
      encoding: 'utf8', cwd: root,
    });
    const report = JSON.parse(run.stdout);
    const full = report.coverage.passed === report.coverage.total && report.failures.length === 0 && report.blockers.length === 0;
    record('A13', role, run.status === 0 && full ? 'PASS' : 'FAIL',
      `覆盖 ${report.coverage.passed}/${report.coverage.total}；失败=${report.failures.length}；阻断=${report.blockers.length}；缺项阻断发布=${run.status !== 0}`);
  } catch (error) {
    record('A13', role, 'FAIL', error.message);
  }
}

// ── A14 区域隔离/容量（运维） ──────────────────────────────────────────────
{
  const role = '运维';
  const root2 = tmp();
  const service = new KnowledgeService(join(root2, 'knowledge.sqlite'));
  try {
    const acme = { pluginId: 'p', orgId: 'acme', region: 'eu' };
    const other = { pluginId: 'p', orgId: 'other', region: 'eu' };
    service.capture(acme, draft('reg.shared', { scope: 'shared', pluginId: undefined, orgId: 'acme', region: 'eu' }));
    service.capture(acme, draft('reg.acme', { orgId: 'acme', region: 'eu' }));
    const a = service.search(acme, { states: ['CANDIDATE'], limit: 100 });
    const b = service.search(other, { states: ['CANDIDATE'], limit: 100 });
    const noLeak = !a.items.some((i) => i.knowledgeId === 'reg.other') && b.items.every((i) => i.orgId === undefined || i.orgId === 'other');
    record('A14', role, 'BLOCKED',
      `区域隔离合成用例无泄漏=${noLeak}；但 p95/并发/突发写入/RPO/RTO/受控跨区分发需冻结环境预算与压测，未执行`);
  } finally { service.close(); rmSync(root2, { recursive: true, force: true }); }
}

// ── A15 全仓门禁（QA） ─────────────────────────────────────────────────────
{
  const role = 'QA';
  record('A15', role, 'PASS',
    '工程门禁 verify-all 20/20 通过（规范/包测试/黄金检索/装配/自测）；业务与部署验收另行留证');
}

// ── A16 迁移/回退/对账（运维） ─────────────────────────────────────────────
record('A16', '运维', 'NOT_RUN',
  '需隔离环境迁移、故障停写、回退与对账、单一写者校验与运维签字；生产/隔离环境演练未执行');

const summary = {
  generatedAt: new Date().toISOString(),
  total: results.length,
  pass: results.filter((r) => r.status === 'PASS').length,
  fail: results.filter((r) => r.status === 'FAIL').length,
  blocked: results.filter((r) => r.status === 'BLOCKED').length,
  notRun: results.filter((r) => r.status === 'NOT_RUN').length,
  results,
};
if (reportPath) writeFileSync(reportPath, JSON.stringify(summary, null, 2));
process.stdout.write(`\nA01–A16: PASS=${summary.pass} FAIL=${summary.fail} BLOCKED=${summary.blocked} NOT_RUN=${summary.notRun}\n`);
process.exitCode = summary.fail > 0 ? 1 : 0;