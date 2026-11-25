// R1/R3 补强：声明的封闭参数合同必须在 Run 冻结入口真正生效（创建与换批共用 runs.create）。
// 登记时拒绝封闭子集外的关键字（不存在被静默忽略的校验语义）；提交值非法 → RUN_INPUT_INVALID
// 且零写入（无 Run、无 baseline、无派发）；场景归属独立于 schema 校验；未声明 schema 的应用
// 保持 opaque 透传（诚实的现状合同，不追溯强加）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor, type RunLaunch } from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import type { Principal } from '../src/policy.js';
import type { ExecutionPlan } from '../../platform-runtime/src/plan.js';
import type { InputCommit, RunRecord } from '../src/store.js';
import { draft, dvpDraft } from './helpers.js';

const operator: Principal = { actorId: 'session:schema-root', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:schema', kind: 'service' };
const BUNDLE = 'b'.repeat(64);
const code = (expected: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === expected;

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

const open = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-input-schema-'));
  const executor = new RecordingExecutor();
  const service = new PlatformControlService(join(root, 'control.sqlite'), null);
  service.registerExecutor(BUNDLE, executor);
  return { root, executor, service };
};

const schemaApp = () => {
  const base = draft('schema-app');
  return {
    ...base,
    descriptor: {
      ...base.descriptor,
      inputSchema: {
        type: 'object',
        properties: {
          listingType: { type: 'string', enum: ['Manual', 'Medical', 'PK', 'Report'] },
          batch: { type: 'string', minLength: 1, maxLength: 64 },
        },
        required: ['batch'],
        additionalProperties: false,
      },
      inputSchemaVersion: '1',
    },
  };
};

const newWork = (service: PlatformControlService, appId = 'schema-app') =>
  service.createWork({ projectId: 'SYN-001', appId, appVersion: '1.0.0', title: '合同校验工作' }, operator);

const assertZeroWrites = async (service: PlatformControlService, workId: string) => {
  assert.equal(service.listRuns(undefined, 0, 100, operator).total, 0, '没有 Run 落库');
  assert.equal(service.inputBaselinesForWork(workId, 0, 10, operator).total, 0, '没有 baseline 落库');
  const tick = await service.dispatchOutbox(supervisor, { limit: 5 });
  assert.equal(tick.dispatched, 0, '没有派发');
};

test('registration rejects schema keywords outside the declared closed subset — nothing is silently ignored', async () => {
  const { root, service } = await open();
  try {
    for (const unsupported of [
      { type: 'object', patternProperties: { '^x': { type: 'string' } } },
      { $ref: '#/definitions/x' },
      { anyOf: [{ type: 'string' }, { type: 'number' }] },
      { type: ['string', 'null'] },
      { type: 'object', additionalProperties: { type: 'string' } },
    ]) {
      const base = draft('bad-schema');
      assert.throws(
        () => service.registerApp({ ...base, descriptor: { ...base.descriptor, inputSchema: unsupported } }, operator),
        code('APP_DESCRIPTOR_INVALID'),
        `unsupported schema must be refused: ${JSON.stringify(unsupported)}`,
      );
    }
    // 封闭子集内的良构 schema 正常登记，并进入计划身份。
    const record = service.registerApp(schemaApp(), operator);
    assert.equal(record.plan.planContractVersion, '2');
    assert.ok(record.plan.input && /^[a-f0-9]{64}$/.test(record.plan.input.digest));
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a declared input schema is enforced at the freeze entry: invalid values produce no Run, no baseline, no dispatch', async () => {
  const { root, service } = await open();
  try {
    service.registerApp(schemaApp(), operator);
    service.setDefaultRelease('schema-app', '1.0.0', { expectedRevision: null }, operator);
    const work = newWork(service);
    for (const invalid of [
      { goal: '缺 required', applicationOptions: { listingType: 'Manual' } },
      { goal: 'enum 外值', applicationOptions: { listingType: 'Gamma', batch: 'b1' } },
      { goal: '未知键', applicationOptions: { batch: 'b1', extra: true } },
      { goal: '类型不符', applicationOptions: { batch: 42 } },
      { goal: '声明了 schema 却无 applicationOptions' },
    ]) {
      assert.throws(() => service.createWorkRun(work.workId, invalid, operator), code('RUN_INPUT_INVALID'), JSON.stringify(invalid));
    }
    await assertZeroWrites(service, work.workId);
    // 合法提交正常冻结并派发，Worker 实收载荷与提交一致。
    const run = service.createWorkRun(work.workId, { goal: '合法运行', applicationOptions: { listingType: 'Medical', batch: 'b1' } }, operator);
    const tick = await service.dispatchOutbox(supervisor, { limit: 5 });
    assert.equal(tick.dispatched, 1);
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'STARTING');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario membership is enforced even without a schema; an app that declares no scenarios refuses listingType', async () => {
  const { root, service } = await open();
  try {
    service.registerApp(draft(), operator);
    service.registerApp(dvpDraft(), operator);
    service.registerExecutor('c'.repeat(64), new RecordingExecutor());
    service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
    service.setDefaultRelease('dm-dvp', '1.0.0', { expectedRevision: null }, operator);
    const listingWork = newWork(service, 'listing');
    assert.throws(
      () => service.createWorkRun(listingWork.workId, { goal: '未声明场景', applicationOptions: { listingType: 'Gamma' } }, operator),
      code('RUN_INPUT_INVALID'),
    );
    const dvpWork = newWork(service, 'dm-dvp');
    assert.throws(
      () => service.createWorkRun(dvpWork.workId, { goal: 'DVP 不接受 Listing 参数', applicationOptions: { listingType: 'Manual' } }, operator),
      code('RUN_INPUT_INVALID'),
    );
    assert.equal(service.listRuns(undefined, 0, 100, operator).total, 0);
    // 未声明 schema 的应用：不含 listingType 的 applicationOptions 保持 opaque 透传（现状合同）。
    const run = service.createWorkRun(listingWork.workId, { goal: '透传运行', applicationOptions: { custom: 'value' } }, operator);
    assert.equal((await service.dispatchOutbox(supervisor, { limit: 5 })).dispatched, 1);
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'STARTING');
    // DVP 自己的输入照常冻结派发，不带任何 Listing 字段。
    const dvpRun = service.createWorkRun(dvpWork.workId, { goal: 'DVP 运行' }, operator);
    assert.equal((await service.dispatchOutbox(supervisor, { limit: 5 })).dispatched, 1);
    assert.equal(service.getRun(dvpRun.runId, operator).snapshot.state, 'STARTING');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a rejected submission leaves no trace: the next valid freeze is revision 1 and dispatches exactly once', async () => {
  const { root, executor, service } = await open();
  try {
    service.registerApp(schemaApp(), operator);
    service.setDefaultRelease('schema-app', '1.0.0', { expectedRevision: null }, operator);
    const work = newWork(service);
    assert.throws(
      () => service.createWorkRun(work.workId, { goal: '非法', applicationOptions: { batch: '' } }, operator),
      code('RUN_INPUT_INVALID'),
    );
    await assertZeroWrites(service, work.workId);
    const run = service.createWorkRun(work.workId, { goal: '合法', applicationOptions: { batch: 'b1' } }, operator);
    const baselines = service.inputBaselinesForWork(work.workId, 0, 10, operator);
    assert.equal(baselines.total, 1, '被拒提交不占用修订号');
    assert.equal(baselines.items[0].revision, 1);
    assert.equal((await service.dispatchOutbox(supervisor, { limit: 5 })).dispatched, 1);
    assert.deepEqual(executor.received.map((seen) => seen.run.runId), [run.runId]);
    assert.ok(JSON.stringify(executor.received[0].inputs).includes('"b1"'), 'Worker 实收冻结后载荷');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
