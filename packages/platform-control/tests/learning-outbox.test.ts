/** L3/T04：知识捕获持久 outbox——重复投递幂等、消费者崩溃恢复、显式 CONFLICT/RETRY_REQUIRED
 *  结局的处置、死信与人工重放；知识投影失败永不改业务 Run 状态。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type KnowledgeCaptureEvent, type RunExecutor, type RunOutcome } from '../src/service.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:outbox', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:outbox', kind: 'service' };

const failed: RunOutcome = { status: 'failed', error: 'WORKER_FAILED', exitProven: true, cleanedUp: true };

class OutcomeExecutor implements RunExecutor {
  readonly kind = 'outcome';
  constructor(private readonly outcome: RunOutcome) {}
  async dispatch(input: { launchId?: string; fencingToken?: number }) {
    return {
      launchId: input.launchId ?? 'launch-outbox',
      fencingToken: input.fencingToken ?? 1,
      outcome: Promise.resolve(this.outcome),
    };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
}

const waitFor = async (service: PlatformControlService, runId: string): Promise<string> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = service.getRun(runId, operator).snapshot.state;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not reach a terminal state');
};

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-learning-'));
  const service = new PlatformControlService(join(root, 'control.sqlite'), new OutcomeExecutor(failed), undefined, {
    requireArtifacts: false,
  });
  service.registerApp(draft(), operator);
  return { root, service };
};

const terminalRun = async (service: PlatformControlService) => {
  const run = service.createRun('listing', '1.0.0', { goal: 'learning-outbox' }, operator);
  await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
  assert.equal(await waitFor(service, run.runId), 'FAILED');
  return run;
};

test('重复投递幂等：一次终态只占一条消息，重复泵不重复交付（T04）', async () => {
  const { root, service } = await setup();
  try {
    const delivered: KnowledgeCaptureEvent[] = [];
    service.setKnowledgeCaptureSink((event) => {
      delivered.push(event);
    });
    const run = await terminalRun(service);
    const first = await service.drainKnowledgeCaptureOutbox();
    assert.equal(first.claimed, 1);
    assert.equal(first.done, 1);
    const second = await service.drainKnowledgeCaptureOutbox();
    assert.equal(second.claimed, 0, 'DONE 消息不复活');
    assert.equal(delivered.length, 1);
    // 同一终态再次观测（重启后重放 capture）也是幂等入队
    const runRecord = service.getRun(run.runId, operator);
    assert.equal(runRecord.snapshot.state, 'FAILED');
    const counts = service.knowledgeCaptureOutboxStatus();
    assert.equal(counts.DONE, 1);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('消费者崩溃恢复：sink 抛错退避重试，恢复后无丢失；Run 状态不变（T04）', async () => {
  const { root, service } = await setup();
  try {
    let attempts = 0;
    const delivered: KnowledgeCaptureEvent[] = [];
    service.setKnowledgeCaptureSink((event) => {
      attempts++;
      if (attempts === 1) throw new Error('sink-down');
      delivered.push(event);
    });
    const run = await terminalRun(service);
    const first = await service.drainKnowledgeCaptureOutbox({ now: new Date(Date.now() + 60_000) });
    assert.equal(first.retried, 1, '第一次投递失败进入退避');
    assert.equal(delivered.length, 0);
    // 退避窗口过后成功交付——事件没有丢失
    const second = await service.drainKnowledgeCaptureOutbox({ now: new Date(Date.now() + 5 * 60_000) });
    assert.equal(second.done, 1);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].kind, 'run.failed');
    assert.equal(delivered[0].runId, run.runId);
    assert.equal(service.getRun(run.runId, operator).snapshot.state, 'FAILED', '知识投影失败不改业务 Run 状态');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('显式结局：CONFLICT 是已交付（不重试）；RETRY_REQUIRED 触发退避；超预算死信可人工重放', async () => {
  const { root, service } = await setup();
  try {
    const run = await terminalRun(service);
    // 有人同时改修订 → 知识服务返回显式 CONFLICT：已记录的裁决结局，泵交付完成
    service.setKnowledgeCaptureSink(() => ({ outcome: 'CONFLICT' }));
    const conflictDrain = await service.drainKnowledgeCaptureOutbox();
    assert.equal(conflictDrain.done, 1);
    assert.equal(service.knowledgeCaptureOutboxStatus().DONE, 1);

    // 第二个 Run：知识服务显式要求重试（RETRY_REQUIRED），随后一直失败 → 死信
    const run2 = await terminalRun(service);
    service.setKnowledgeCaptureSink(() => ({ outcome: 'RETRY_REQUIRED' }));
    let last = { claimed: 0, done: 0, retried: 0, dead: 0 };
    for (let attempt = 0; attempt < 5; attempt++) {
      last = await service.drainKnowledgeCaptureOutbox({ now: new Date(Date.now() + (attempt + 1) * 60_000) });
    }
    assert.equal(last.dead, 1, 'RETRY_REQUIRED 超预算后死信');
    assert.ok(
      service.audit(0, 50, operator).items.some((entry) => entry.action === 'KNOWLEDGE_CAPTURE_DEAD_LETTERED'),
      '死信审计留痕',
    );
    assert.equal(service.getRun(run2.runId, operator).snapshot.state, 'FAILED');
    // 人工重放：死信回到队列，换一个正常的 sink 后无丢失交付
    const replayed = service.replayKnowledgeCaptureDeadLetters();
    assert.equal(replayed.replayed, 1);
    const delivered: KnowledgeCaptureEvent[] = [];
    service.setKnowledgeCaptureSink((event) => {
      delivered.push(event);
    });
    const finalDrain = await service.drainKnowledgeCaptureOutbox();
    assert.equal(finalDrain.done, 1);
    assert.equal(delivered[0].runId, run2.runId);
    void run;
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('未配置 sink 时泵如实返回零投递，事件保留在队列不丢弃（§5 故障语义）', async () => {
  const { root, service } = await setup();
  try {
    await terminalRun(service);
    const idle = await service.drainKnowledgeCaptureOutbox();
    assert.deepEqual(idle, { claimed: 0, done: 0, retried: 0, dead: 0 });
    assert.equal(service.knowledgeCaptureOutboxStatus().PENDING, 1, '事件持久保留，等待 sink 装配后补投');
    // 后装配 sink 也能拿到错过的观测
    const delivered: KnowledgeCaptureEvent[] = [];
    service.setKnowledgeCaptureSink((event) => {
      delivered.push(event);
    });
    const drained = await service.drainKnowledgeCaptureOutbox();
    assert.equal(drained.done, 1);
    assert.equal(delivered.length, 1);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
