/** Local workbench server: platform-control API + static workbench assets.
 *
 *  Intended for local development and review only. It binds to loopback and installs a fixed
 *  local operator principal; production deployments must terminate identity and authorization
 *  before this server. `--seed` registers a clearly synthetic application and model catalog so
 *  the UI can be exercised without claiming a real business release or model call.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlatformControlService } from './service.js';
import { LocalOperatorPolicy, type Principal } from './policy.js';
import { startWorkbenchServer } from './http.js';
import type { AppReleaseDraft } from './store.js';
import { readDeployment } from './deployment.js';
import { resolveStorePath } from './config.js';
import { DshProfileExecutor } from './worker.js';
import { RunScheduler } from './scheduler.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '../../..');

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name: string): boolean => args.includes(`--${name}`);

const port = Number(arg('port') ?? process.env.PORT ?? 3083);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  console.error('Invalid port.');
  process.exit(1);
}
// Retirement (2026-11-12): the old static front end is no longer served by default. The native
// DSH plugin page is the product entry; `--app <dir>` remains an explicit, reversible rollback.
const appArg = arg('app');
const appDir = appArg ? resolve(appArg) : undefined;
const home = process.env.DSH_HOME ?? resolve(repoRoot, '.runtime', 'dsh-home');
const deploymentPath = arg('deployment') ?? process.env.PLATFORM_WORKBENCH_DEPLOYMENT;
const deployment = deploymentPath ? await readDeployment(resolve(deploymentPath)) : null;
if (deployment && flag('seed')) throw new Error('真实执行配置不能与合成演示目录同时启用。');
const storePath = resolve(arg('store') ?? (deployment ? resolveStorePath(deployment.config) : resolve(home, 'platform', 'workbench.sqlite')));
const principal: Principal = {
  actorId: process.env.PLATFORM_DEV_PRINCIPAL ?? 'session:local-workbench',
  kind: 'operator',
};

const RUNTIME_DIGEST = 'd'.repeat(64);
const syntheticRelease: AppReleaseDraft = {
  descriptor: {
    appId: 'ec.synthetic.probe',
    version: '1.0.0',
    displayName: '合成探针应用',
    description: '本地工作台演示用合成应用；不执行任何业务代码，不代表真实发布。',
    materialRoles: ['合成资料'],
    resultTypes: ['合成结果'],
  },
  requiredCapabilities: [{ capabilityId: 'synthetic.probe', version: '1.0.0' }],
  providers: [
    {
      capabilityId: 'synthetic.probe',
      version: '1.0.0',
      pluginId: 'synthetic-probe',
      pluginVersion: '1.0.0',
      artifactDigest: 'a'.repeat(64),
      protocolVersion: '1',
      inputSchemaVersion: '1',
      outputSchemaVersion: '1',
      dependencies: [],
    },
  ],
  runtimeBundleDigest: RUNTIME_DIGEST,
};
const syntheticCatalog = {
  catalogId: 'local.development',
  runtimeBundleDigest: RUNTIME_DIGEST,
  defaultSelectionId: 'model.deepseek-flash',
  entries: [
    {
      selectionId: 'model.deepseek-flash',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      displayName: 'DeepSeek-V4.1-Flash',
      description: '锁定 DSH 0.2.2-rc.1 内置清单中的模型；本地演示不发起模型调用。',
      adapter: 'dsh-llm-deepseek',
      adapterVersion: '0.2.2-rc.1',
      enabled: true,
      verification: 'provider-declared',
      capabilities: { contextWindow: 1048576, modalities: ['text', 'image'], reasoning: 'unknown' },
      parameters: { maxTokens: true },
    },
    {
      selectionId: 'model.deepseek-pro',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      displayName: 'DeepSeek-V4-Pro',
      description: '锁定 DSH 0.2.2-rc.1 内置清单中的模型；本地演示不发起模型调用。',
      adapter: 'dsh-llm-deepseek',
      adapterVersion: '0.2.2-rc.1',
      enabled: true,
      verification: 'provider-declared',
      capabilities: { contextWindow: 1048576, modalities: ['text'], reasoning: 'unknown' },
      parameters: { maxTokens: true },
    },
  ],
};

const service = new PlatformControlService(storePath, null, new LocalOperatorPolicy(), {
  requireArtifacts: deployment?.config.requireArtifacts ?? true,
});
let stopScheduler: (() => void) | undefined;
if (deployment?.config.worker) {
  for (const application of deployment.applications) service.registerApp(application, principal);
  service.registerModelCatalog(deployment.catalog, principal);
  service.setExecutor(new DshProfileExecutor(deployment.config.worker, undefined, {
    record: (launchId, proven) => service.recordExitEvidence(launchId, proven),
    read: (launchId) => service.readExitEvidence(launchId),
  }));
  stopScheduler = new RunScheduler(service, deployment.config.scheduler?.intervalMs ?? 1000, {
    actorId: 'service:workbench-scheduler', kind: 'service',
  }).start();
}
if (flag('seed')) {
  try {
    service.registerApp(syntheticRelease, principal);
    service.registerModelCatalog(syntheticCatalog, principal);
  } catch (error) {
    console.error(`Seed failed: ${error instanceof Error ? error.message : 'unknown'}`);
    service.close();
    process.exit(1);
  }
}

const running = await startWorkbenchServer({
  service,
  appDir,
  authenticate: () => principal,
  workspace: {
    name: process.env.PLATFORM_WORKSPACE_NAME ?? '本地工作区',
    note: deployment ? '本地操作者模式：使用真实 DeepSeek Harness 执行，尚未接入企业身份服务。' : '本地设置模式：尚未配置执行环境，请先完成环境配置。',
  },
  configuration: {
    mode: 'local-operator',
    worker: { configured: !!deployment?.config.worker, ...(deployment?.config.worker ? {
      profile: deployment.config.worker.profile, workspace: deployment.config.worker.workspace,
    } : {}) },
    instructions: deployment ? ['运行将使用已配置的 Harness profile；实际可用性以本次执行结果为准。'] : [
      '登记项目和执行主机上可访问的工作空间。',
      '通过 --deployment 指定非秘密运行配置，绑定已安装的应用、模型目录与 Harness profile。',
      '模型凭据由执行环境提供，不需要员工在工作目标中填写密钥。',
    ],
  },
  port,
});

console.log(`Workbench ready: ${running.url} (store: ${storePath}, app: ${appDir ?? 'api-only'})`);

const shutdown = async () => {
  stopScheduler?.();
  try {
    await running.close();
  } finally {
    service.close();
  }
  process.exit(0);
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown());
