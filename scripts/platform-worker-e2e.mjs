// Real-model worker E2E: platform-control registers a synthetic app, dispatches a DSH SDK/profile
// worker, and verifies the worker's artifact manifest is registered before the run completes.
// Requires ZAI_CODING_CN_API_KEY and the generated worker profile/.runtime/worker-home.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PlatformControlService } from '../packages/platform-control/src/service.ts';
import { DshProfileExecutor } from '../packages/platform-control/src/worker.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerHome = path.join(root, '.runtime', 'worker-home');
const sdk = await import(pathToFileURL(path.join(root, 'upstream', 'deepseek-harness-git', 'packages', 'sdk', 'client', 'lib', 'index.js')).href);
const temp = await mkdtemp(path.join(tmpdir(), 'platform-worker-e2e-'));
const workspace = path.join(temp, 'work');
const overlay = path.join(temp, 'worker-model.patch.yml');
await mkdir(workspace, { recursive: true });
await writeFile(
  overlay,
  [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      zai-coding-cn:',
    '        api: anthropic-messages',
    '        baseURL: https://open.bigmodel.cn/api/anthropic',
    '        apiKeyEnv: ZAI_CODING_CN_API_KEY',
    '        models:',
    '          - id: glm-5.3-flash',
    '            name: GLM-5.3-Flash',
    '            contextWindow: 1000000',
    '            maxTokens: 32768',
    '            input: [text]',
    '- id: agent-default-model',
    '  config:',
    '    provider: zai-coding-cn',
    '    model: glm-5.3-flash',
    '',
  ].join('\n'),
);
const factory = {
  async create(config, runId) {
    const harness = new sdk.DeepSeekHarness({
      profile: config.profile,
      dshHome: config.dshHome,
      cwd: path.join(config.workspace, runId),
      patches: config.patches,
      provider: 'zai-coding-cn',
      model: 'glm-5.3-flash',
      maxTokens: 2048,
      initializeTimeoutMs: config.initializeTimeoutMs,
    });
    return {
      run: (prompt, options) => harness.run(prompt, options),
      close: () => harness.close(),
    };
  },
};
const executor = new DshProfileExecutor(
  {
    profile: 'worker', dshHome: workerHome, workspace, patches: [overlay], timeoutMs: 240000,
    initializeTimeoutMs: 60000,
  },
  factory,
);
const service = new PlatformControlService(path.join(temp, 'control.sqlite'), executor, undefined, {
  requireArtifacts: true,
});
const operator = { actorId: 'session:e2e', kind: 'operator' };
const supervisor = { actorId: 'service:e2e', kind: 'service' };
const provider = {
  capabilityId: 'synthetic.worker', version: '1.0.0',
  pluginId: 'synthetic-worker', pluginVersion: '1.0.0', artifactDigest: 'a'.repeat(64),
  protocolVersion: '1', inputSchemaVersion: '1', outputSchemaVersion: '1', dependencies: [],
};
service.registerApp({
  descriptor: {
    appId: 'synthetic-worker', version: '1.0.0', displayName: 'Synthetic worker',
    description: 'E2E only; worker writes a file and a result manifest.', resultTypes: ['text', 'file'],
  },
  requiredCapabilities: [{ capabilityId: 'synthetic.worker', version: '1.0.0' }],
  providers: [provider],
  runtimeBundleDigest: 'b'.repeat(64),
}, operator);
let run = service.createRun('synthetic-worker', '1.0.0', {
  task: 'Create a file named out.txt in the current working directory containing exactly: hello-platform-worker',
}, operator);
console.log(`run=${run.runId} temp=${temp}`);
run = await service.dispatchRun(run.runId, run.snapshot.revision, supervisor);
for (let attempt = 0; attempt < 210; attempt++) {
  run = service.getRun(run.runId, operator);
  if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.snapshot.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.snapshot.state)) {
  console.error(`run ${run.runId} did not terminate in 210s; cancelling and retaining ${temp}`);
  try {
    await service.cancelRun(run.runId, service.getRun(run.runId, operator).snapshot.revision, operator);
  } catch (error) {
    console.error(`cancel failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  run = service.getRun(run.runId, operator);
}
console.log(JSON.stringify({
  state: run.snapshot.state,
  reason: run.snapshot.reason ?? null,
  attempts: service.attempts(run.runId, operator),
  artifacts: service.artifacts(run.runId, operator),
}, null, 2));
service.close();
if (run.snapshot.state !== 'SUCCEEDED') {
  console.error(`E2E failed; artifacts retained at ${temp}`);
  process.exitCode = 1;
} else {
  await rm(temp, { recursive: true, force: true });
}