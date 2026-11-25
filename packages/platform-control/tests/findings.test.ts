import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PlatformControlService,
  type RunExecutor,
  type RunFinding,
  type RunOutcome,
} from '../src/service.js';
import { PlatformError } from '../src/registry.js';
import { startWorkbenchServer, type RunningWorkbenchApi } from '../src/http.js';
import type { Principal } from '../src/policy.js';
import { draft } from './helpers.js';

const operator: Principal = { actorId: 'session:findings', kind: 'operator' };
const supervisor: Principal = { actorId: 'service:findings', kind: 'service' };
const isPlatformError = (code: string) => (error: unknown) =>
  error instanceof PlatformError && error.code === code;

class OutcomeExecutor implements RunExecutor {
  readonly kind = 'outcome';
  constructor(private readonly outcome: RunOutcome) {}
  async dispatch(input: { launchId?: string; fencingToken?: number }) {
    return {
      launchId: input.launchId ?? 'launch-findings',
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

const artifactFor = async (dir: string, name: string, content: string) => {
  const sourcePath = join(dir, name);
  await writeFile(sourcePath, content);
  return {
    name,
    digest: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    sourcePath,
  };
};

/** A service whose every run succeeds with the given findings; artifacts come from real files. */
const setup = async (findingsFor: (goal: string) => RunFinding[] = () => []) => {
  const root = await mkdtemp(join(tmpdir(), 'platform-findings-'));
  const filesDir = join(root, 'worker-out');
  await mkdir(filesDir, { recursive: true });
  let next = 0;
  const service = new PlatformControlService(
    join(root, 'control.sqlite'),
    {
      kind: 'outcome',
      async dispatch(input: { launchId?: string; fencingToken?: number }) {
        const index = next++;
        const outcome: RunOutcome = {
          status: 'succeeded',
          exitProven: true,
          cleanedUp: true,
          finishReason: 'completed',
          descendantsDone: true,
          consumedThrough: 1,
          artifacts: [await artifactFor(filesDir, `out-${index}.csv`, 'k,v\n1,2')],
          findings: findingsFor(`run-${index}`),
        };
        return {
          launchId: input.launchId ?? `launch-${index}`,
          fencingToken: input.fencingToken ?? 1,
          outcome: Promise.resolve(outcome),
        };
      },
      async cancel(): Promise<boolean> {
        return true;
      },
    } as unknown as RunExecutor,
    undefined,
    { requireArtifacts: true },
  );
  const app = draft();
  app.descriptor.resultViews = [
    {
      viewId: 'issues-table',
      title: '问题清单',
      kind: 'table',
      findingKind: 'issue',
      columns: [
        { field: 'subject', label: '对象' },
        { field: 'domain', label: '域' },
      ],
    },
    {
      viewId: 'coverage',
      title: '覆盖统计',
      kind: 'metrics',
      findingKind: 'metric',
      metrics: [{ field: 'value', label: '覆盖数', stat: 'sum', unit: '条' }],
    },
  ];
  service.registerApp(app, operator);
  service.setDefaultRelease('listing', '1.0.0', { expectedRevision: null }, operator);
  const work = service.createWork(
    { projectId: 'SYN-001', appId: 'listing', appVersion: '1.0.0', title: '差异视图工作' },
    operator,
  );
  return { root, service, work };
};

const runOnce = async (service: PlatformControlService, workId: string, goal: string): Promise<string> => {
  const run = service.createWorkRun(workId, { goal }, operator);
  await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
  await waitFor(service, run.runId);
  return run.runId;
};

const issue = (key: string, summary: string, fields: RunFinding['fields']): RunFinding => ({
  key,
  kind: 'issue',
  severity: 'warning',
  summary,
  fields,
});
const metric = (key: string, value: number): RunFinding => ({ key, kind: 'metric', fields: { value } });

test('app-contributed findings persist with stable keys and drive key-aligned diffs (E1-4)', async () => {
  const batches = new Map<string, RunFinding[]>();
  const { root, service, work } = await setup((goal) => batches.get(goal) ?? []);
  try {
    batches.set('run-0', [
      issue('AE.S01', '受试者 01 年龄越界', { subject: '01', domain: 'AE' }),
      issue('LB.S07', '受试者 07 缺基线', { subject: '07', domain: 'LB' }),
      metric('coverage.total', 12),
    ]);
    batches.set('run-1', [
      issue('AE.S01', '受试者 01 年龄越界（复核后仍成立）', { subject: '01', domain: 'AE' }),
      issue('AE.S09', '受试者 09 新增疑问', { subject: '09', domain: 'AE' }),
      metric('coverage.total', 15),
    ]);
    const first = await runOnce(service, work.workId, 'run-0');
    const second = await runOnce(service, work.workId, 'run-1');

    const findings = service.findings(second, operator);
    assert.equal(findings.length, 3);

    const diff = service.diffRunFindings(first, second, operator);
    assert.equal(diff.comparable, true);
    const issueDiff = diff.kinds.find((kind) => kind.kind === 'issue')!;
    // Aligned by the app's business key, not by row position: AE.S01 changed, AE.S09 added, LB.S07 resolved.
    assert.deepEqual(
      issueDiff.items.map((item) => `${item.key}:${item.state}`),
      ['AE.S01:changed', 'AE.S09:added', 'LB.S07:resolved'],
    );
    const metricDiff = diff.kinds.find((kind) => kind.kind === 'metric')!;
    assert.equal(metricDiff.items[0].state, 'changed');
    assert.equal(metricDiff.items[0].after?.fields?.value, 15);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a malformed findings contribution fails the run instead of being silently trimmed', async () => {
  const { root, service, work } = await setup(() => [
    issue('DUP', '第一次', {}),
    issue('DUP', '重复键', {}),
  ]);
  try {
    const run = service.createWorkRun(work.workId, { goal: '坏发现' }, operator);
    await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
    assert.equal(await waitFor(service, run.runId), 'FAILED');
    assert.match(service.getRun(run.runId, operator).snapshot.reason ?? '', /WORKER_FINDINGS_INVALID/);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a descriptor with malformed result views is refused at registration (E1-5)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-findings-'));
  try {
    const service = new PlatformControlService(join(root, 'control.sqlite'), null, undefined, { requireArtifacts: false });
    const bad = draft();
    (bad.descriptor as unknown as Record<string, unknown>).resultViews = [
      { viewId: 'v1', title: '视图', kind: 'pivot', findingKind: 'issue' },
    ];
    assert.throws(() => service.registerApp(bad, operator), isPlatformError('APP_DESCRIPTOR_INVALID'));
    const duplicate = draft();
    (duplicate.descriptor as unknown as Record<string, unknown>).resultViews = [
      { viewId: 'v1', title: '视图', kind: 'table', findingKind: 'issue', columns: [{ field: 'a', label: 'A' }] },
      { viewId: 'v1', title: '视图', kind: 'table', findingKind: 'issue', columns: [{ field: 'a', label: 'A' }] },
    ];
    assert.throws(() => service.registerApp(duplicate, operator), isPlatformError('APP_DESCRIPTOR_INVALID'));
    service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cross-app and cross-version diffs are declared incomparable, not guessed', async () => {
  const { root, service, work } = await setup(() => [issue('K1', '一条', {})]);
  try {
    const first = await runOnce(service, work.workId, 'run-0');
    // Same app, different release: the keys may not mean the same thing anymore.
    const otherApp = draft();
    otherApp.descriptor.appId = 'dvp';
    service.registerApp(otherApp, operator);
    service.setDefaultRelease('dvp', '1.0.0', { expectedRevision: null }, operator);
    const otherWork = service.createWork(
      { projectId: 'SYN-001', appId: 'dvp', appVersion: '1.0.0', title: '另一个应用' },
      operator,
    );
    const foreign = await runOnce(service, otherWork.workId, 'run-1');
    const crossApp = service.diffRunFindings(first, foreign, operator);
    assert.deepEqual(crossApp, { comparable: false, reason: 'APP_MISMATCH', fromRunId: first, toRunId: foreign });
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the HTTP surface exposes findings and the key-aligned diff', async () => {
  const batches = new Map<string, RunFinding[]>();
  const { root, service, work } = await setup((goal) => batches.get(goal) ?? []);
  const api = await startWorkbenchServer({ service, authenticate: () => operator });
  try {
    batches.set('run-0', [issue('K1', '一条', { subject: '01' })]);
    batches.set('run-1', [issue('K1', '一条', { subject: '01' }), issue('K2', '新增', {})]);
    const first = await runOnce(service, work.workId, 'run-0');
    const second = await runOnce(service, work.workId, 'run-1');

    const findingsResponse = await fetch(`${api.url}/api/runs/${second}/findings`);
    assert.equal(findingsResponse.status, 200);
    const findingsBody = await findingsResponse.json() as { items: RunFinding[] };
    assert.equal(findingsBody.items.length, 2);

    const diffResponse = await fetch(`${api.url}/api/runs/${first}/findings-diff?against=${second}`);
    assert.equal(diffResponse.status, 200);
    const diffBody = await diffResponse.json() as { comparable: boolean; kinds: Array<{ kind: string; added: number; resolved: number; changed: number; unchanged: number }> };
    assert.equal(diffBody.comparable, true);
    const issueDiff = diffBody.kinds.find((kind) => kind.kind === 'issue')!;
    assert.deepEqual({ added: issueDiff.added, resolved: issueDiff.resolved, changed: issueDiff.changed, unchanged: issueDiff.unchanged }, { added: 1, resolved: 0, changed: 0, unchanged: 1 });

    const missing = await fetch(`${api.url}/api/runs/${first}/findings-diff`);
    assert.equal(missing.status, 400);
  } finally {
    await api.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
