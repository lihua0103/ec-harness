/** Local workbench server: platform-control API + static workbench assets.
 *
 *  Intended for local development and review only. It binds to loopback and installs a fixed
 *  local operator principal; production deployments must terminate identity and authorization
 *  before this server. `--seed` registers a clearly synthetic application and model catalog so
 *  the UI can be exercised without claiming a real business release or model call.
 */
import { resolve } from 'node:path';
import { PlatformControlService } from './service.js';
import { LocalOperatorPolicy, type Principal } from './policy.js';
import { startWorkbenchServer } from './http.js';
import { runDoctor } from './doctor.js';
import type { AppReleaseDraft } from './store.js';
import { readDeployment } from './deployment.js';
import { defaultControlStorePath, resolveControlHome, resolveStorePath, type Config } from './config.js';
import { configureControlService, startControlRuntime } from './bootstrap.js';

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
const home = resolveControlHome();
const deploymentPath = arg('deployment') ?? process.env.PLATFORM_WORKBENCH_DEPLOYMENT;
const deployment = deploymentPath ? await readDeployment(resolve(deploymentPath)) : null;
if (deployment && flag('seed')) throw new Error('真实执行配置不能与合成演示目录同时启用。');
// E0d: one canonical fallback store name. An old `workbench.sqlite` from before the unification
// stays on disk untouched (no data migration) — it is simply no longer the default entry point.
const storePath = resolve(arg('store') ?? (deployment ? resolveStorePath(deployment.config) : defaultControlStorePath(home)));
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
      description: '锁定 DSH 0.2.2-rc.5 内置清单中的模型；本地演示不发起模型调用。',
      adapter: 'dsh-llm-deepseek',
      adapterVersion: '0.2.2-rc.5',
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
      description: '锁定 DSH 0.2.2-rc.5 内置清单中的模型；本地演示不发起模型调用。',
      adapter: 'dsh-llm-deepseek',
      adapterVersion: '0.2.2-rc.5',
      enabled: true,
      verification: 'provider-declared',
      capabilities: { contextWindow: 1048576, modalities: ['text'], reasoning: 'unknown' },
      parameters: { maxTokens: true },
    },
  ],
};

const deploymentConfig: Config = deployment?.config ?? {};
const service = new PlatformControlService(storePath, null, new LocalOperatorPolicy(), {
  requireArtifacts: deploymentConfig.requireArtifacts ?? true,
  requireReleaseApproval: deploymentConfig.requireReleaseApproval ?? false,
  requireModelHealth: deploymentConfig.requireModelHealth ?? false,
  requireModelApproval: deploymentConfig.requireModelApproval ?? false,
  ...(deploymentConfig.quotas !== undefined ? { quotas: deploymentConfig.quotas } : {}),
  ...(deploymentConfig.maxConcurrentRuns !== undefined
    ? { maxConcurrentRuns: deploymentConfig.maxConcurrentRuns }
    : {}),
});
// WP4: shared assembly with the DSH bundle entry — executor registration, knowledge tenant scope
// and the read-only Run knowledge snapshot source are wired identically for both entries.
configureControlService(service, deploymentConfig);
if (deployment) {
  for (const application of deployment.applications) service.registerApp(application, principal);
  service.registerModelCatalog(deployment.catalog, principal);
}
// WP4: reconcile-before-schedule, identical to the bundle entry; scheduler-disabled or
// worker-less configurations start zero dispatch loops.
const runtime = startControlRuntime(service, deploymentConfig);
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
  doctor: async () => runDoctor({
    storePath,
    ...(deployment?.config.worker ? { worker: deployment.config.worker } : {}),
  }),
  port,
});

console.log(`Workbench ready: ${running.url} (store: ${storePath}, app: ${appDir ?? 'api-only'})`);

const shutdown = async () => {
  runtime.stop();
  try {
    await running.close();
  } finally {
    service.close();
  }
  process.exit(0);
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown());
