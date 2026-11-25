import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, type RunExecutor, type RunOutcome } from '../src/service.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:eval', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:eval', kind: 'service' };

class OutcomeExecutor implements RunExecutor {
  readonly kind = 'outcome';
  constructor(private readonly outcome: RunOutcome) {}
  async dispatch(input: { launchId?: string; fencingToken?: number }) {
    return {
      launchId: input.launchId ?? 'launch-eval',
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

const ARTIFACT_CONTENT = 'A,G,nh,po';
const succeededWithArtifacts = async (dir: string): Promise<RunOutcome> => {
  const name = 'listing.xlsx';
  const sourcePath = join(dir, name);
  await writeFile(sourcePath, ARTIFACT_CONTENT);
  return {
    status: 'succeeded',
    exitProven: true,
    cleanedUp: true,
    finishReason: 'completed',
    descendantsDone: true,
    consumedThrough: 1,
    artifacts: [{
      name,
      digest: createHash('sha256').update(ARTIFACT_CONTENT).digest('hex'),
      bytes: Buffer.byteLength(ARTIFACT_CONTENT),
      sourcePath,
    }],
  };
};

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-eval-'));
  const filesDir = join(root, 'worker-out');
  await mkdir(filesDir, { recursive: true });
  const service = new PlatformControlService(
    join(root, 'control.sqlite'),
    new OutcomeExecutor(await succeededWithArtifacts(filesDir)),
    undefined,
    { requireArtifacts: true },
  );
  service.registerApp(draft(), operator);
  service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
  const work = service.createWork(
    { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '评测工作' },
    operator,
  );
  const run = service.createWorkRun(work.workId, { goal: '产出基线指标清单' }, operator);
  await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
  assert.equal(await waitFor(service, run.runId), 'SUCCEEDED');
  const goodDigest = createHash('sha256').update(ARTIFACT_CONTENT).digest('hex');
  return { root, service, work, run, goodDigest };
};

test('deterministic checks evaluate from run records only, with no expert gold set (E2-1)', async () => {
  const { root, service, run, goodDigest } = await setup();
  try {
    const set = service.createEvaluationSet(
      {
        appId: 'listing',
        name: 'Listing 确定性验证（首批代表集）',
        description: '无专家金标的确定性检查：产物存在/摘要/大小上限/目标锚点。',
        entries: [
          {
            label: '产物完整',
            checks: [
              { kind: 'artifact-present', artifactName: 'listing.xlsx' },
              { kind: 'artifact-digest', artifactName: 'listing.xlsx', digest: goodDigest },
              { kind: 'artifact-bytes-max', artifactName: 'listing.xlsx', maxBytes: 1024 * 1024 },
            ],
          },
          {
            label: '目标锚点',
            checks: [{ kind: 'goal-contains', text: '基线指标' }],
          },
        ],
      },
      operator,
    );
    assert.equal(set.state, 'ACTIVE');
    assert.equal(set.entries.length, 2);

    const evaluation = service.evaluateEvaluationSet(set.evaluationSetId, run.runId, operator);
    assert.equal(evaluation.state, 'COMPLETED');
    assert.equal(evaluation.failed, 0, 'every deterministic check passes on the real run records');
    assert.equal(evaluation.passed, 4);
    assert.ok(evaluation.results.every((result) => result.pass));

    // The same set catches a wrong digest and a missing artifact — deterministic, not lucky.
    const strict = service.createEvaluationSet(
      {
        appId: 'listing',
        name: '严格集',
        entries: [
          { label: '坏摘要', checks: [{ kind: 'artifact-digest', artifactName: 'listing.xlsx', digest: 'f'.repeat(64) }] },
          { label: '缺产物', checks: [{ kind: 'artifact-present', artifactName: 'missing.csv' }] },
          { label: '目标不含', checks: [{ kind: 'goal-contains', text: '不存在的词' }] },
        ],
      },
      operator,
    );
    const failedEvaluation = service.evaluateEvaluationSet(strict.evaluationSetId, run.runId, operator);
    assert.equal(failedEvaluation.failed, 3);
    assert.equal(failedEvaluation.passed, 0);
    assert.ok(failedEvaluation.results.every((result) => !result.pass));

    // Runs are recorded and readable per set.
    const history = service.listEvaluationRuns(set.evaluationSetId, operator);
    assert.equal(history.length, 1);
    assert.equal(history[0].evaluationRunId, evaluation.evaluationRunId);
    assert.equal(service.getEvaluationRun(evaluation.evaluationRunId, operator).passed, 4);

    // Archiving a set freezes it: no further evaluations.
    service.archiveEvaluationSet(set.evaluationSetId, operator);
    assert.equal(service.getEvaluationSet(set.evaluationSetId, operator).state, 'ARCHIVED');
    assert.throws(
      () => service.evaluateEvaluationSet(set.evaluationSetId, run.runId, operator),
      (error: { code?: string }) => error?.code === 'EVALUATION_SET_ARCHIVED',
    );

    // Invalid check shapes are rejected at creation, before they can silently pass.
    const codeOf = (error: unknown) => (error as { code?: string }).code;
    assert.throws(
      () => service.createEvaluationSet(
        { appId: 'listing', name: '坏摘要格式', entries: [{ label: 'x', checks: [{ kind: 'artifact-digest', artifactName: 'a', digest: 'nothex' }] }] },
        operator,
      ),
      (error: unknown) => codeOf(error) === 'EVALUATION_SET_INVALID',
    );
    assert.throws(
      () => service.createEvaluationSet(
        { appId: 'listing', name: '未知检查', entries: [{ label: 'x', checks: [{ kind: 'row-count', table: 't' }] }] },
        operator,
      ),
      (error: unknown) => codeOf(error) === 'EVALUATION_SET_INVALID',
    );
    assert.throws(
      () => service.createEvaluationSet(
        { appId: 'no-such-app', name: '未注册应用', entries: [{ label: 'x', checks: [{ kind: 'goal-contains', text: 'y' }] }] },
        operator,
      ),
      (error: unknown) => codeOf(error) === 'APP_NOT_FOUND',
    );
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('evaluation sets and runs are served over HTTP (E2-1)', async () => {
  const { root, service, run, goodDigest } = await setup();
  let api: RunningWorkbenchApi | undefined;
  try {
    api = await startWorkbenchServer({ service, authenticate: () => operator });

    const created = await fetch(`${api.url}/api/evaluations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appId: 'listing',
        name: 'HTTP 确定性集',
        entries: [{ label: '产物摘要', checks: [{ kind: 'artifact-digest', artifactName: 'listing.xlsx', digest: goodDigest }] }],
      }),
    }).then((res) => res.json()) as { evaluationSetId: string; entries: unknown[] };
    assert.ok(created.evaluationSetId);

    const listed = await fetch(`${api.url}/api/evaluations?appId=listing`).then((res) => res.json()) as {
      items: Array<{ evaluationSetId: string }>;
    };
    assert.ok(listed.items.some((item) => item.evaluationSetId === created.evaluationSetId));

    const evaluation = await fetch(`${api.url}/api/evaluations/${created.evaluationSetId}/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: run.runId }),
    }).then((res) => res.json()) as { evaluationRunId: string; passed: number; failed: number };
    assert.equal(evaluation.passed, 1);
    assert.equal(evaluation.failed, 0);

    const history = await fetch(`${api.url}/api/evaluations/${created.evaluationSetId}/runs`)
      .then((res) => res.json()) as { items: Array<{ evaluationRunId: string }> };
    assert.deepEqual(history.items.map((item) => item.evaluationRunId), [evaluation.evaluationRunId]);

    const single = await fetch(`${api.url}/api/evaluation-runs/${evaluation.evaluationRunId}`)
      .then((res) => res.json()) as { evaluationRunId: string };
    assert.equal(single.evaluationRunId, evaluation.evaluationRunId);

    const missing = await fetch(`${api.url}/api/evaluation-runs/does-not-exist`);
    assert.equal(missing.status, 404);
  } finally {
    await api?.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
