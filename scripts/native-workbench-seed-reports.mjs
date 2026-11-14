// Synthetic seed for the enterprise workbench artifact/input views (T07 demo only).
//
// It creates a clearly synthetic application, one bound Work with 12 input batches, 12 input
// commits and 12 sealed artifacts, plus one Work with no execution. This is demo data for UI
// verification, not a business release, a model call or an acceptance record. Everything is
// written under the --home directory (default .runtime/nw-t07-home).
//
// Usage: node scripts/native-workbench-seed-reports.mjs [--home <dir>]
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
  return index >= 0 && args[index + 1] ? args[index + 1] : undefined;
};
const home = resolve(value('home') ?? '.runtime/nw-t07-home');
const storePath = join(home, 'platform', 'native-workbench.sqlite');
const demoDir = join(home, 'demo-artifacts');
if (resolve(home) === resolve('/') || resolve(home).length < 8) throw new Error('refusing a suspicious home path');
if (args.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) await rm(`${storePath}${suffix}`, { force: true });
}
await mkdir(join(home, 'platform'), { recursive: true });
await mkdir(join(home, 'demo-workspace'), { recursive: true });
await rm(demoDir, { recursive: true, force: true });
await mkdir(demoDir, { recursive: true });

const operator = { actorId: 'session:t07-seed', kind: 'operator', orgId: 'org-synthetic' };
const servicePrincipal = { actorId: 'service:t07-seed', kind: 'service' };

const digestOf = (text) => createHash('sha256').update(text).digest('hex');
const appDraft = {
  descriptor: {
    appId: 'ec.synthetic.reports',
    version: '1.0.0',
    displayName: '合成成果演示应用',
    description: '仅用于工作台成果/输入视图验证的合成应用；不执行任何业务代码。',
    materialRoles: ['合成资料'],
    resultTypes: ['合成成果'],
  },
  requiredCapabilities: [{ capabilityId: 'synthetic.reports', version: '1.0.0' }],
  providers: [{
    capabilityId: 'synthetic.reports',
    version: '1.0.0',
    pluginId: 'synthetic-reports',
    pluginVersion: '1.0.0',
    artifactDigest: 'a'.repeat(64),
    protocolVersion: '1',
    inputSchemaVersion: '1',
    outputSchemaVersion: '1',
    dependencies: [],
  }],
  runtimeBundleDigest: 'e'.repeat(64),
};

const artifacts = [];
for (let index = 1; index <= 12; index++) {
  const name = `reports/summary-${String(index).padStart(2, '0')}.csv`;
  const body = `batch,value\n${index},${index * 7}\n`;
  const file = join(demoDir, name.replace('/', '-'));
  await writeFile(file, body, 'utf8');
  artifacts.push({
    name,
    digest: digestOf(body),
    bytes: Buffer.byteLength(body),
    mediaType: 'text/csv',
    sourcePath: file,
  });
}

const executor = {
  kind: 'synthetic-seed',
  async dispatch(input) {
    const outcome = {
      status: 'succeeded',
      finishReason: 'completed',
      finalResponse: '合成演示运行已完成；仅用于工作台展示，不代表业务审核。',
      exitProven: true,
      cleanedUp: true,
      descendantsDone: true,
      consumedThrough: input.inputs?.length ?? 0,
      artifacts,
    };
    return { launchId: input.launchId ?? 'seed-launch-1', fencingToken: input.fencingToken ?? 1, outcome: Promise.resolve(outcome) };
  },
  async cancel() { return true; },
};

const service = new PlatformControlService(storePath, executor, new LocalOperatorPolicy());
try {
  const app = service.registerApp(appDraft, operator);
  const project = service.createProject({ name: '合成成果项目', code: 'SYN-T07' }, operator);
  const workspace = await service.createWorkspace({
    projectId: project.projectId,
    name: '合成工作空间',
    directory: join(home, 'demo-workspace'),
  }, operator);
  const work = service.createWork({
    projectId: project.projectId,
    appId: app.appId,
    appVersion: app.appVersion,
    title: '季度方案整理（合成演示）',
    workspaceId: workspace.workspaceId,
    goal: '展示成果版本、输入批次与分页；不使用真实业务资料。',
  }, operator);
  const emptyWork = service.createWork({
    projectId: project.projectId,
    appId: app.appId,
    appVersion: app.appVersion,
    title: '尚未执行的工作（空状态）',
    workspaceId: workspace.workspaceId,
  }, operator);
  const domain = service.registerDomain({
    owner: operator.orgId, kind: 'local', capabilities: ['reporting'],
  }, operator);
  service.bindWorkSession({
    workId: work.workId,
    domainId: domain.domainId,
    sessionId: 'session-t07-demo',
    releaseDigest: app.releaseDigest,
    workspaceId: workspace.workspaceId,
  }, operator);

  for (let revision = 1; revision <= 12; revision++) {
    service.appendInputBaseline(work.workId, {
      sourceRef: `dir:${join(home, 'demo-workspace')}#v${revision}`,
      digest: digestOf(`baseline-${revision}`),
    }, operator);
  }

  let run = service.createWorkRun(work.workId, { requirement: '合成成果演示' }, operator);
  for (let index = 1; index <= 12; index++) {
    service.appendInput(run.runId, { text: `合成输入 ${index}` }, operator);
  }
  run = await service.dispatchRun(run.runId, run.snapshot.revision, servicePrincipal);
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = service.getRun(run.runId, operator).snapshot.state;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(state)) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  const settled = service.getRun(run.runId, operator);
  console.log(JSON.stringify({
    home,
    storePath,
    projectId: project.projectId,
    workId: work.workId,
    emptyWorkId: emptyWork.workId,
    runId: run.runId,
    runState: settled.snapshot.state,
    artifacts: service.artifacts(run.runId, operator).length,
    baselines: service.inputBaselinesForWork(work.workId, 0, 20, operator).total,
    inputs: service.inputs(run.runId, 0, 20, operator).total,
  }, null, 2));
} finally {
  service.close();
}
