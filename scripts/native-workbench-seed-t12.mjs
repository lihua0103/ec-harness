// Synthetic seed for the T10/T11 native-workbench verification round.
//
// It creates a clearly synthetic project, workspace, two applications, three Works, two execution
// domains, append-only input batches, a first and a second run on the same Work, and one run that
// leaves a real pending question for the answer flow. It is demo data for UI/API verification —
// not a business release, a model call or an acceptance record.
//
// Usage: node scripts/native-workbench-seed-t12.mjs [--home <dir>] [--reset]
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  LocalOperatorPolicy,
  PlatformControlService,
} from '../packages/platform-control/lib/index.js';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const home = resolve(value('home') ?? '.runtime/nw-web-home');
const storePath = join(home, 'platform', 'native-workbench.sqlite');
const demoDir = join(home, 'demo-artifacts');
if (resolve(home) === resolve('/') || resolve(home).length < 8) throw new Error('refusing a suspicious home path');
if (args.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) await rm(`${storePath}${suffix}`, { force: true });
}
await mkdir(join(home, 'platform'), { recursive: true });
await mkdir(join(home, 'demo-workspace'), { recursive: true });
await mkdir(join(home, 'demo-workspace-question'), { recursive: true });
await rm(demoDir, { recursive: true, force: true });
await mkdir(demoDir, { recursive: true });

const operator = { actorId: 'session:t12-seed', kind: 'operator' };
const servicePrincipal = { actorId: 'service:t12-seed', kind: 'service' };
const digestOf = (text) => createHash('sha256').update(text).digest('hex');

const release = (appId, displayName, description, bundle) => ({
  descriptor: {
    appId,
    version: '1.0.0',
    displayName,
    description,
    materialRoles: ['合成资料'],
    resultTypes: ['合成成果'],
  },
  requiredCapabilities: [{ capabilityId: `${appId}.capability`, version: '1.0.0' }],
  providers: [{
    capabilityId: `${appId}.capability`,
    version: '1.0.0',
    pluginId: `${appId}-plugin`,
    pluginVersion: '1.0.0',
    artifactDigest: 'a'.repeat(64),
    protocolVersion: '1',
    inputSchemaVersion: '1',
    outputSchemaVersion: '1',
    dependencies: [],
  }],
  runtimeBundleDigest: bundle.repeat(64),
});

let artifactSerial = 0;
async function artifactsFor(tag, count) {
  const items = [];
  for (let index = 1; index <= count; index++) {
    artifactSerial += 1;
    const name = `reports/${tag}-${String(index).padStart(2, '0')}.csv`;
    const body = `batch,value\n${tag},${index}\n`;
    const file = join(demoDir, name.replace('/', '-'));
    await writeFile(file, body, 'utf8');
    items.push({ name, digest: digestOf(body), bytes: Buffer.byteLength(body), mediaType: 'text/csv', sourcePath: file });
  }
  return items;
}

const executor = {
  kind: 'synthetic-t12-seed',
  async dispatch(input) {
    const launchId = input.launchId ?? 'seed-launch-1';
    const fencingToken = input.fencingToken ?? 1;
    const modelSelections = input.model
      ? [{ provider: input.model.provider, model: input.model.model,
          ...(input.model.options?.reasoningEffort ? { reasoningEffort: input.model.options.reasoningEffort } : {}) }]
      : [];
    const ask = input.run?.input?.ask === true;
    if (ask) {
      // Ask on the first tick and settle the run only when a person answers. dispatch returns
      // before the answer, so the run is bound and the question is durably PENDING.
      const outcome = (async () => {
        const result = await input.onUserQuestion({
          requestId: 'seed-question-1',
          sessionId: 'seed-worker-session',
          questions: [{
            id: 'batch',
            question: '本次运行使用哪个数据批次？',
            header: '数据批次',
            detail: '合成问题，仅用于验证问答回复流程。',
            options: [{ label: '基线批次' }, { label: '随访批次' }],
          }],
        }, { signal: new AbortController().signal });
        return {
          status: 'succeeded',
          finishReason: 'completed',
          finalResponse: `合成运行已收到答复：${JSON.stringify(result)}`,
          exitProven: true,
          cleanedUp: true,
          descendantsDone: true,
          consumedThrough: input.inputs?.length ?? 0,
          modelSelections,
          artifacts: await artifactsFor('answered', 1),
        };
      })();
      return { launchId, fencingToken, outcome };
    }
    const tag = String(input.run?.input?.tag ?? 'run');
    const outcome = {
      status: 'succeeded',
      finishReason: 'completed',
      finalResponse: `合成演示运行 ${tag} 已完成；仅用于工作台展示，不代表业务审核。`,
      exitProven: true,
      cleanedUp: true,
      descendantsDone: true,
      consumedThrough: input.inputs?.length ?? 0,
      modelSelections,
      artifacts: await artifactsFor(tag, 2),
    };
    return { launchId, fencingToken, outcome: Promise.resolve(outcome) };
  },
  async cancel() { return true; },
};

const settle = async (runId) => {
  for (let attempt = 0; attempt < 400; attempt++) {
    const state = service.getRun(runId, operator).snapshot.state;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(state)) return state;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return service.getRun(runId, operator).snapshot.state;
};

const service = new PlatformControlService(storePath, executor, new LocalOperatorPolicy());
let questionRunId;
let questionWorkId;
let summary;
try {
  const reports = service.registerApp(release('ec.synthetic.reports', '合成成果演示应用',
    '仅用于工作台成果/输入视图验证的合成应用；不执行任何业务代码。', 'e'), operator);
  const dvp = service.registerApp(release('ec.synthetic.dvp', '合成 DVP 修订应用',
    '仅用于工作台 DVP 修订验证的合成应用；不执行任何业务代码。', 'f'), operator);

  const project = service.createProject({ name: '临床数据项目（合成）', code: 'SYN-T12' }, operator);
  const workspace = await service.createWorkspace({
    projectId: project.projectId,
    name: '合成工作空间',
    directory: join(home, 'demo-workspace'),
  }, operator);
  // A second space keeps the intentionally-stuck question run from blocking new runs in the main
  // space (the platform admits one active run per workspace).
  const questionWorkspace = await service.createWorkspace({
    projectId: project.projectId,
    name: '合成问题空间',
    directory: join(home, 'demo-workspace-question'),
  }, operator);
  service.registerModelCatalog({
    catalogId: 'synthetic.t12',
    runtimeBundleDigest: reports.draft.runtimeBundleDigest,
    defaultSelectionId: 'model.synthetic-a',
    entries: [
      {
        selectionId: 'model.synthetic-a', provider: 'synthetic-provider', model: 'model-a',
        displayName: '合成模型 A（不可调用）', description: '仅用于界面与冻结记录验证。',
        adapter: 'synthetic-adapter', adapterVersion: '1.0.0', enabled: true,
        verification: 'provider-declared', capabilities: { contextWindow: 1000, modalities: ['text'] },
      },
      {
        selectionId: 'model.synthetic-b', provider: 'synthetic-provider', model: 'model-b',
        displayName: '合成模型 B（不可调用）', description: '仅用于界面与冻结记录验证。',
        adapter: 'synthetic-adapter', adapterVersion: '1.0.0', enabled: true,
        verification: 'provider-declared', capabilities: { contextWindow: 1000, modalities: ['text'] },
      },
    ],
  }, operator);

  const local = service.registerDomain({ owner: 'owner:session:local-workbench', kind: 'local', capabilities: ['reporting'] }, operator);
  const hosted = service.registerDomain({ owner: 'owner:session:local-workbench', kind: 'hosted', capabilities: ['reporting'] }, operator);

  const reportsWork = service.createWork({
    projectId: project.projectId, appId: reports.appId, appVersion: reports.appVersion,
    title: '季度方案整理（合成演示）', workspaceId: workspace.workspaceId,
    goal: '展示追加输入批次、两次运行与旧成果仍可查；不使用真实业务资料。',
  }, operator);
  const dvpWork = service.createWork({
    projectId: project.projectId, appId: dvp.appId, appVersion: dvp.appVersion,
    title: 'DVP 修订（合成演示）', workspaceId: workspace.workspaceId,
    goal: '展示 DVP 来源版本与独立边界；不使用真实业务资料。',
  }, operator);
  const questionWork = service.createWork({
    projectId: project.projectId, appId: reports.appId, appVersion: reports.appVersion,
    title: '等待答复的工作（合成演示）', workspaceId: questionWorkspace.workspaceId,
    goal: '展示平台执行器提出的问题与一次性答复。',
  }, operator);

  // Batch 1 then run 1, batch 2 then run 2: the older batch and older artifacts must remain readable.
  service.appendInputBaseline(reportsWork.workId, {
    sourceRef: `dir:${join(home, 'demo-workspace')}#batch-1`, digest: digestOf('batch-1'),
  }, operator);
  let firstRun = service.createWorkRun(reportsWork.workId, { tag: 'run1' }, operator, { modelSelectionId: 'model.synthetic-a' });
  service.appendInput(firstRun.runId, { text: '第一批合成输入' }, operator);
  firstRun = await service.dispatchRun(firstRun.runId, firstRun.snapshot.revision, servicePrincipal);
  const firstState = await settle(firstRun.runId);

  service.appendInputBaseline(reportsWork.workId, {
    sourceRef: `dir:${join(home, 'demo-workspace')}#batch-2`, digest: digestOf('batch-2'),
  }, operator);
  let secondRun = service.createWorkRun(reportsWork.workId, { tag: 'run2' }, operator, { modelSelectionId: 'model.synthetic-b' });
  service.appendInput(secondRun.runId, { text: '第二批合成输入' }, operator);
  secondRun = await service.dispatchRun(secondRun.runId, secondRun.snapshot.revision, servicePrincipal);
  const secondState = await settle(secondRun.runId);

  service.appendInputBaseline(dvpWork.workId, {
    sourceRef: `dir:${join(home, 'demo-workspace')}#dvp-source-1`, digest: digestOf('dvp-source-1'),
  }, operator);

  let questionRun = service.createWorkRun(questionWork.workId, { ask: true }, operator, { modelSelectionId: 'model.synthetic-a' });
  service.appendInput(questionRun.runId, { text: '合成问题运行' }, operator);
  questionRun = await service.dispatchRun(questionRun.runId, questionRun.snapshot.revision, servicePrincipal);
  // Give the ask path one tick to persist the interaction before reporting.
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  questionRunId = questionRun.runId;
  questionWorkId = questionWork.workId;

  const pending = service.pendingInteractions(operator);
  summary = {
    home,
    storePath,
    projectId: project.projectId,
    workspaceId: workspace.workspaceId,
    domains: { local: local.domainId, hosted: hosted.domainId },
    reports: { workId: reportsWork.workId, runs: [firstRun.runId, secondRun.runId], states: [firstState, secondState] },
    dvp: { workId: dvpWork.workId },
    question: { workId: questionWork.workId, runId: questionRun.runId, pending: pending.length },
    counts: {
      reportsArtifacts: service.artifacts(firstRun.runId, operator).length,
      secondArtifacts: service.artifacts(secondRun.runId, operator).length,
      reportsBaselines: service.inputBaselinesForWork(reportsWork.workId, 0, 20, operator).total,
      dvpBaselines: service.inputBaselinesForWork(dvpWork.workId, 0, 20, operator).total,
    },
  };
} finally {
  service.close();
}

// `service.close()` cancels waiters for questions the seeding process still holds. For the UI
// verification we need one genuinely PENDING question answered by a *different* process (the
// control plane), so insert it after the seeding service has closed. This is synthetic demo data,
// clearly labelled as such, and the run stays non-terminal so the answer is admissible.
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(storePath);
  try {
    const createdAt = new Date().toISOString();
    db.prepare('DELETE FROM run_interactions WHERE run_id=?').run(questionRunId);
    db.prepare(
      'INSERT INTO run_interactions(interaction_id,run_id,session_id,request_id,kind,body,state,created_at) VALUES(?,?,?,?,?,?,?,?)',
    ).run(
      'seed-pending-question',
      questionRunId,
      'seed-worker-session',
      'seed-question-1',
      'user-question',
      JSON.stringify({
        questions: [{
          id: 'batch',
          question: '本次运行使用哪个数据批次？',
          header: '数据批次',
          detail: '合成问题，仅用于验证问答回复流程。',
          options: [{ label: '基线批次' }, { label: '随访批次' }],
        }],
      }),
      'PENDING',
      createdAt,
    );
  } finally {
    db.close();
  }
  summary.question.pending = 1;
  console.log(JSON.stringify({ ...summary, questionWorkId }, null, 2));
}
