// Live local E2E: exercise the workbench HTTP API against a real DSH profile worker.
// Uses synthetic data only; never real clinical material. Requires the server started with
// --deployment and the deployment's provider credential present in the environment.
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const base = process.env.WORKBENCH_URL ?? 'http://127.0.0.1:3085';
const root = path.resolve(process.cwd(), '.runtime', 'workbench', `e2e-project-${Date.now()}`);
const task = process.env.E2E_TASK ?? '这是一次平台连通性验证。请直接用一句话回复：平台连通性测试成功。不要创建文件。';
const fileTask = process.argv.includes('--file');

async function call(method, url, body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${payload?.code ?? ''} ${payload?.detail ?? ''}`);
  return payload;
}

await mkdir(root, { recursive: true });
if (fileTask) await rm(path.join(root, 'hello.txt'), { force: true });
let project;
for (const item of (await call('GET', '/api/projects')).items) {
  if (item.code === 'E2E-001') project = item;
}
project ??= await call('POST', '/api/projects', { name: '合成验证项目', code: 'E2E-001' });
const outputDir = path.join(root, 'results');
await mkdir(outputDir, { recursive: true });
let workspace;
for (const item of (await call('GET', `/api/projects/${project.projectId}/workspaces`)).items) {
  if (item.directory === root) workspace = item;
}
workspace ??= await call('POST', `/api/projects/${project.projectId}/workspaces`, {
  name: '合成数据空间', directory: root, outputDirectory: outputDir,
});
const apps = (await call('GET', '/api/apps')).items;
const app = apps.find((item) => item.appId === process.env.E2E_APP ?? 'ec.listing') ?? apps[0];
if (!app) throw new Error('no active application release');
const models = await call('GET', `/api/apps/${encodeURIComponent(app.appId)}/models?version=${encodeURIComponent(app.appVersion)}`);
const selected = models.entries.find((entry) => entry.selected && entry.enabled) ?? models.entries.find((entry) => entry.enabled);
if (!selected) throw new Error(`no enabled model: ${JSON.stringify(models)}`);
console.log(`app=${app.appId}@${app.appVersion} model=${selected.provider}/${selected.model}`);

const work = await call('POST', '/api/works', {
  projectId: project.projectId,
  workspaceId: workspace.workspaceId,
  appId: app.appId,
  appVersion: app.appVersion,
  title: fileTask ? '合成文件产物验证' : '合成连通性验证',
  goal: fileTask
    ? '在项目目录创建 hello.txt，内容为 hello-platform；同时按运行提示把结果清单和产物登记到本次产物目录。'
    : task,
});
let run = await call('POST', `/api/works/${work.workId}/runs`, {
  input: { goal: fileTask
    ? '在项目目录创建 hello.txt，内容为 hello-platform；同时按运行提示把结果清单和产物登记到本次产物目录。'
    : task },
  modelSelectionId: selected.selectionId,
});
console.log(`work=${work.workId} run=${run.runId} cwd=${workspace.directory}`);

const started = Date.now();
let last = '';
while (!['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(run.snapshot.state)) {
  if (Date.now() - started > 15 * 60 * 1000) {
    console.error('timeout; run left active for reconciliation');
    process.exitCode = 1;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  run = await call('GET', `/api/runs/${run.runId}`);
  const live = run.activities?.length ?? 0;
  const line = `state=${run.snapshot.state} activities=${live} revision=${run.snapshot.revision}`;
  if (line !== last) {
    process.stdout.write(`\n${line}`);
    last = line;
  }
}
console.log('');
const conversation = await call('GET', `/api/works/${work.workId}/conversation`);
const artifacts = await call('GET', `/api/runs/${run.runId}/artifacts`);
console.log(JSON.stringify({
  state: run.snapshot.state,
  reason: run.snapshot.reason ?? null,
  sessionId: run.result?.sessionId ?? null,
  barrier: run.snapshot.barrier ?? null,
  finalResponse: run.result?.finalResponse ?? null,
  activities: (run.activities ?? []).map((item) => item.text.slice(0, 160)),
  conversationMessages: conversation.items.flatMap((item) => item.messages).length,
  artifacts: artifacts.items.map((item) => ({ name: item.name, bytes: item.bytes, sealed: !!item.sealedAt })),
}, null, 2));
if (run.snapshot.state !== 'SUCCEEDED') process.exitCode = 1;
