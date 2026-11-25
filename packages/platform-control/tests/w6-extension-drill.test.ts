// W6 验收（R1–R6 扩展演练）：迁移业务与演练。
// 扩展 —— 第三个合成应用只凭 application 声明经共享转换接入：登记、批准、默认指向、员工目录、
//         Work/Run 创建与实际派发全链路走通，工作台源码零改动（本演练只调用控制面公开 API，
//         不触碰任何 workbench 文件；渲染由 W5 的声明驱动通道承接）。
// R6 —— 新版本先写入记录并产生在途 Run，再切回默认：仅新 Work 路由改变；既有 Work 创建新 Run
//       按原绑定重验；在途 Run 保持原制品锁；回退不是撤权，历史事实不改写。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor, type RunLaunch } from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import { buildAppReleaseDraft } from '../src/release-manifest.js';
import type { Principal } from '../src/policy.js';
import type { ExecutionPlan } from '../../platform-runtime/src/plan.js';
import type { InputCommit, RunRecord } from '../src/store.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:w6-root', kind: 'operator' };
const approver: Principal = { actorId: 'user:qa-lead', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:w6', kind: 'service' };
const code = (expected: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === expected;

/** 记录执行器实际收到的派发载荷（Run/计划/输入），断言真实派发而非仅请求或库表。 */
class RecordingExecutor implements RunExecutor {
  readonly kind = 'recording';
  readonly received: Array<{ run: RunRecord; plan: ExecutionPlan; inputs?: InputCommit[] }> = [];
  async dispatch(input: { run: RunRecord; plan: ExecutionPlan; inputs?: InputCommit[]; launchId?: string; fencingToken?: number }): Promise<RunLaunch> {
    this.received.push({ run: input.run, plan: input.plan, inputs: input.inputs });
    return { launchId: input.launchId ?? `launch-${this.received.length}`, fencingToken: input.fencingToken ?? this.received.length };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

test('W6/R1+R3: a third synthetic app onboards purely by declaration — catalog, work, run and real dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-w6-third-'));
  const bundle = 'd'.repeat(64);
  const executor = new RecordingExecutor();
  const service = new PlatformControlService(join(root, 'control.sqlite'), null, undefined, { requireReleaseApproval: true });
  try {
    service.registerExecutor(bundle, executor);
    // 第三个应用：自己的场景（非 Listing 四类）、自己的结果视图与输入合同，全部来自声明。
    const application = {
      appId: 'ec.synthetic',
      displayName: '合成扩展应用',
      description: 'W6 drill: a third application onboarded purely by declaration.',
      listingTypes: ['Alpha', 'Beta'],
      materialRoles: ['需求说明'],
      resultTypes: ['结果表'],
      resultViews: [
        { viewId: 'issues', title: '问题清单', kind: 'table' as const, findingKind: 'issue', columns: [{ field: 'key', label: '键' }, { field: 'summary', label: '摘要' }] },
        { viewId: 'counts', title: '问题计数', kind: 'metrics' as const, findingKind: 'issue', metrics: [{ field: 'key', label: '问题数', stat: 'count' as const }] },
      ],
      inputSchema: { type: 'object', properties: { listingType: { type: 'string', enum: ['Alpha', 'Beta'] } } },
      inputSchemaVersion: '1',
      capabilityId: 'ec.synthetic.run',
      capabilityVersion: '2.0.0',
      knowledgePluginId: 'synthetic-plugin',
    };
    const { draft: synthetic, versions } = buildAppReleaseDraft({
      application,
      manifest: { name: '@ec-clinical/synthetic', version: '0.1.0' },
      pluginId: 'synthetic-plugin',
      artifactDigest: 'e'.repeat(64),
      runtimeBundleDigest: bundle,
    });
    assert.notEqual(versions.appVersion, versions.capabilityVersion, '能力版本独立于应用/包版本');

    const record = service.registerApp(synthetic, operator);
    // 声明进入合同身份：视图与输入合同都有摘要，缺失不再被静默丢弃（W6 修复的映射缺口）。
    assert.equal(record.plan.planContractVersion, '2');
    assert.ok(record.plan.view && /^[a-f0-9]{64}$/.test(record.plan.view.digest), '声明的视图进入计划身份');
    assert.ok(record.plan.input && /^[a-f0-9]{64}$/.test(record.plan.input.digest), '声明的输入合同进入计划身份');
    assert.deepEqual(record.draft.descriptor.resultViews, application.resultViews);

    service.approveRelease({ appId: record.appId, appVersion: record.appVersion, releaseDigest: record.releaseDigest }, approver);
    service.setDefaultRelease('ec.synthetic', '0.1.0', { expectedRevision: null }, operator);

    const project = service.createProject({ name: '扩展演练项目' }, operator);
    const page = service.catalogSummaries(project.projectId, null, 10, operator);
    const summary = page.items.find((item) => item.appId === 'ec.synthetic');
    assert.ok(summary, '第三应用出现在员工目录');
    assert.deepEqual(summary.listingTypes, ['Alpha', 'Beta'], '目录摘要携带应用自己的场景声明');
    assert.equal('resultViews' in summary, false, '有界摘要不下发未选中的视图声明');

    const work = service.createWork({ projectId: project.projectId, appId: 'ec.synthetic', appVersion: '0.1.0', title: '合成工作' }, operator);
    const run = service.createWorkRun(work.workId, { goal: '合成运行', applicationOptions: { listingType: 'Alpha' } }, operator);
    const tick = await service.dispatchOutbox(supervisor, { limit: 5 });
    assert.equal(tick.dispatched, 1);
    assert.equal(tick.noExecutor, 0);

    assert.equal(executor.received.length, 1);
    const seen = executor.received[0];
    assert.equal(seen.run.appId, 'ec.synthetic');
    assert.equal(seen.plan.appVersion, '0.1.0');
    assert.equal(seen.plan.runtimeBundleDigest, bundle);
    const payload = JSON.stringify(seen.inputs);
    assert.ok(payload.includes('"Alpha"'), 'Worker 实收应用自己的场景');
    for (const foreign of ['Manual', 'Medical', 'PK', 'Report']) {
      assert.equal(payload.includes(foreign), false, `不得注入 Listing 语义：${foreign}`);
    }
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'STARTING');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('W6/R6: default switch then rollback with in-flight runs — only new Work routing changes, original locks hold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-w6-rollback-'));
  const bundleA = 'a'.repeat(64);
  const bundleB = 'b'.repeat(64);
  const execA = new RecordingExecutor();
  const execB = new RecordingExecutor();
  const service = new PlatformControlService(join(root, 'control.sqlite'), null, undefined, { requireReleaseApproval: true });
  try {
    service.registerExecutor(bundleA, execA);
    service.registerExecutor(bundleB, execB);
    const v1 = { ...draft('listing', '1.0.0'), runtimeBundleDigest: bundleA };
    const v2 = { ...draft('listing', '2.0.0'), runtimeBundleDigest: bundleB };
    for (const release of [v1, v2]) {
      const record = service.registerApp(release, operator);
      service.approveRelease({ appId: record.appId, appVersion: record.appVersion, releaseDigest: record.releaseDigest }, approver);
    }
    const first = service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    const project = service.createProject({ name: '回退演练项目' }, operator);
    const newWork = (version: string, title: string) =>
      service.createWork({ projectId: project.projectId, appId: 'listing', appVersion: version, title }, operator);

    // 旧版本先产生在途 Run（原制品锁 A）。
    const work1 = newWork('1.0.0', 'v1 在途工作');
    const run1 = service.createWorkRun(work1.workId, { goal: 'v1 在途运行' }, operator);
    assert.equal((await service.dispatchOutbox(supervisor, { limit: 5 })).dispatched, 1);
    assert.deepEqual(execA.received.map((seen) => seen.run.runId), [run1.runId]);

    // 切到新版本：过期表单冲突且零写入；新 Work 路由到 v2（制品锁 B）。
    const second = service.setDefaultRelease('listing', '2.0.0', { expectedRevision: first.revision }, operator);
    const worksBefore = service.listWorks(undefined, 0, 100, operator).total;
    assert.throws(() => newWork('1.0.0', '过期表单'), code('APP_DEFAULT_RELEASE_CONFLICT'));
    assert.equal(service.listWorks(undefined, 0, 100, operator).total, worksBefore, '冲突不产生任何写入');
    const work2 = newWork('2.0.0', 'v2 工作');
    const run2 = service.createWorkRun(work2.workId, { goal: 'v2 运行' }, operator);
    assert.equal((await service.dispatchOutbox(supervisor, { limit: 5 })).dispatched, 1);
    const work3 = newWork('2.0.0', 'v2 未启动工作');

    // 回退默认指向 v1：普通写入动作，不是撤权。
    const rolled = service.rollbackRelease('listing', '2.0.0', '1.0.0', '演练回退', operator, { expectedRevision: second.revision });
    assert.equal(rolled.current.appVersion, '1.0.0');
    assert.equal(service.getApp('listing', '2.0.0', operator).state, 'ACTIVE', '回退不改发布状态');
    const work4 = newWork('1.0.0', '回退后新工作');
    assert.equal(work4.appVersion, '1.0.0', '仅新 Work 路由改变');

    // 既有 v2 Work 在回退后创建新 Run：按原绑定重验，仍走制品锁 B，不被新默认劫持。
    const run3 = service.createWorkRun(work3.workId, { goal: '回退后既有工作新运行' }, operator);
    assert.equal((await service.dispatchOutbox(supervisor, { limit: 5 })).dispatched, 1);
    assert.deepEqual(execA.received.map((seen) => seen.run.runId), [run1.runId], '制品 A 只收到原锁 Run');
    assert.deepEqual(execB.received.map((seen) => seen.run.runId), [run2.runId, run3.runId], '制品 B 收到 v2 绑定的全部 Run');
    assert.equal(execB.received[1].plan.appVersion, '2.0.0');
    assert.equal(execB.received[1].plan.runtimeBundleDigest, bundleB);
    assert.equal(service.getRun(run1.runId, operator).snapshot.state, 'STARTING', '在途 Run 保持原锁，不被回退改写');
    assert.equal(service.getRun(run2.runId, operator).snapshot.state, 'STARTING');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
