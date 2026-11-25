// Generate a non-secret local workbench deployment: worker profile binding, app releases,
// and a model catalog for the provider route the worker environment actually mounts.
// It never writes credentials; provider keys stay in the execution environment.
//
// Release drafts come from the shared manifest conversion in platform-control
// (release-manifest.ts): this script does not pick descriptor fields itself. Bundle facts are
// deployment inputs (worker profile + locked DSH base) and stay computed here.
const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** 引擎 commit：锁定上游 DSH 的 git 提交，纳入 runtimeBundleDigest（P0-2）。 */
function upstreamEngineCommit() {
  try {
    const { execFileSync } = require('node:child_process');
    return execFileSync('git', ['-C', path.join(root, 'upstream'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const outDir = path.resolve(option('--out', path.join(root, '.runtime', 'workbench')));
const workerHome = path.resolve(option('--worker-home', path.join(root, '.runtime', 'worker-home')));
const runRoot = path.resolve(option('--runs', path.join(outDir, 'runs')));
mkdirSync(outDir, { recursive: true });
mkdirSync(runRoot, { recursive: true });

// 装配所有声明了 application.json 的插件（与 verify-applications 同一扫描口径）：
// 平台面向几十到上百插件，部署面不硬编码任何具体应用。
const plugins = readdirSync(path.join(root, 'plugins'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({ dir: path.join(root, 'plugins', entry.name), appDir: entry.name }))
  .filter(({ dir }) => existsSync(path.join(dir, 'application.json')) && existsSync(path.join(dir, 'package.json')))
  .sort((a, b) => a.appDir.localeCompare(b.appDir));
if (plugins.length === 0) {
  console.error('No plugin declares application.json — nothing to assemble.');
  process.exit(1);
}

async function main() {
  const control = await import(
    pathToFileURL(path.join(root, 'packages', 'platform-control', 'lib', 'index.js')).href
  );
  const { buildAppReleaseDraft, pluginIdFrom, directoryDigest } = control;

  const profileManifest = JSON.parse(
    readFileSync(path.join(workerHome, 'profiles', 'worker', 'package.json'), 'utf8'),
  );
  const pluginData = plugins.map(({ dir, appDir }) => {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const app = JSON.parse(readFileSync(path.join(dir, 'application.json'), 'utf8'));
    if (!existsSync(path.join(dir, 'lib', 'index.js'))) {
      throw new Error(`${appDir}: lib/index.js missing — build the plugin before assembling a deployment`);
    }
    const patchPath = path.join(dir, 'cordis.patch.yml');
    return {
      dir,
      appDir,
      pkg,
      app,
      digest: directoryDigest(path.join(dir, 'lib')),
      pluginId: pluginIdFrom(pkg, existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : undefined),
    };
  });
  const engineCommit = upstreamEngineCommit();
  const runtimeBundleDigest = createHash('sha256')
    .update(
      JSON.stringify({
        base: '0.2.2-rc.5',
        // P0-2：纳入引擎 commit、worker profile 实际补丁字节、业务包安装字节与 lock。
        engine: engineCommit,
        profile: profileManifest.name,
        bundles: profileManifest.dsh.profile.bundles,
        profilePatch: existsSync(path.join(workerHome, 'profiles', 'worker', 'cordis.patch.yml'))
          ? readFileSync(path.join(workerHome, 'profiles', 'worker', 'cordis.patch.yml'), 'utf8')
          : '',
        plugins: pluginData.map(({ pkg, dir }) => ({
          id: `${pkg.name}@${pkg.version}`,
          lib: directoryDigest(path.join(dir, 'lib')),
        })),
      }),
    )
    .digest('hex');

  const provider = option('--provider', process.env.PLATFORM_LLM_PROVIDER ?? 'zai-coding-cn');
  const model = option('--model', process.env.PLATFORM_LLM_MODEL ?? 'glm-5.3-flash');
  const modelName = option('--model-name', process.env.PLATFORM_LLM_MODEL_NAME ?? 'GLM-5.3-Flash');
  const credentialEnv = option('--key-env', 'ZAI_CODING_CN_API_KEY');
  const baseURL = option('--base-url', 'https://open.bigmodel.cn/api/anthropic');
  const adapter = option('--adapter', 'pi-ai');

  // 可选的第二条路由：本地 Anthropic 兼容桥接（例如 WuXi WorkMate → 127.0.0.1:8787）。
  // 只新增目录条目与 provider 路由，不改动原有条目与默认选择。
  const extraProvider = option('--extra-provider', '');
  const extraModel = option('--extra-model', '');
  const extraModelName = option('--extra-model-name', extraModel);
  const extraBaseURL = option('--extra-base-url', '');
  const extraKeyEnv = option('--extra-key-env', 'WM_BRIDGE_API_KEY');
  // reasoning effort 是显式 opt-in：桥接/代理路由是否接受 effort 参数只有部署者知道，
  // 默认不声明（2026-11-23：默认 'off,low,medium,high' 让 wuxigpt-bridge 拒绝运行——
  // 运行时按目录声明发送 effort，路由端返回 does-not-support）。
  const extraEfforts = option('--extra-reasoning-efforts', '')
    .split(',').map((item) => item.trim()).filter(Boolean);
  const extraEnabled = Boolean(extraProvider && extraModel && extraBaseURL);
  // 默认选中项：默认仍是主路由；可显式指定任一条目（--default-model <modelId>）。
  const defaultModel = option('--default-model', '');
  const defaultSelectionId = defaultModel ? `model.${defaultModel}` : `model.${model}`;
  if (defaultModel && defaultModel !== model && !(extraEnabled && defaultModel === extraModel)) {
    throw new Error(`--default-model ${defaultModel} 不是本部署的条目（可选：${model}${extraEnabled ? ` / ${extraModel}` : ''}）`);
  }

  const providers = {
    [provider]: {
      api: 'anthropic-messages',
      baseURL,
      apiKeyEnv: credentialEnv,
      models: [{
        id: model,
        name: modelName,
        contextWindow: 1000000,
        maxTokens: 32768,
        input: ['text'],
      }],
    },
    ...(extraEnabled ? {
      [extraProvider]: {
        api: 'anthropic-messages',
        baseURL: extraBaseURL,
        apiKeyEnv: extraKeyEnv,
        models: [{
          id: extraModel,
          name: extraModelName,
          contextWindow: 200000,
          maxTokens: 32768,
          input: ['text'],
        }],
      },
    } : {}),
  };

  const applications = pluginData.map(({ pkg, app, digest, pluginId }) =>
    buildAppReleaseDraft({
      application: app,
      manifest: pkg,
      pluginId,
      artifactDigest: digest,
      runtimeBundleDigest,
    }).draft,
  );

  for (const [index, application] of applications.entries()) {
    writeFileSync(path.join(outDir, `release-${pluginData[index].appDir}.json`), `${JSON.stringify(application, null, 2)}\n`);
  }
  writeFileSync(path.join(outDir, 'model-route.patch.yml'), [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    ...Object.entries(providers).flatMap(([name, route]) => [
      `      ${name}:`,
      `        api: ${route.api}`,
      `        baseURL: ${route.baseURL}`,
      `        apiKeyEnv: ${route.apiKeyEnv}`,
      '        models:',
      ...route.models.flatMap((item) => [
        `          - id: ${item.id}`,
        `            name: ${item.name}`,
        `            contextWindow: ${item.contextWindow}`,
        `            maxTokens: ${item.maxTokens}`,
        `            input: [${item.input.join(', ')}]`,
      ]),
    ]),
    '- id: agent-default-model',
    '  config:',
    `    provider: ${provider}`,
    `    model: ${model}`,
    '',
  ].join('\n'));
  writeFileSync(path.join(outDir, 'deployment.json'), `${JSON.stringify({
    config: {
      storePath: path.join(outDir, 'workbench.sqlite'),
      requireArtifacts: false,
      scheduler: { intervalMs: 1000 },
      worker: {
        profile: 'worker',
        dshHome: workerHome,
        workspace: runRoot,
        patches: [path.join(outDir, 'model-route.patch.yml')],
        runtimeBundleDigest,
        // WP1: consumption-time artifact verification — the worker re-verifies these installed
        // bytes against each plan's approved digests before consuming any business input.
        pluginArtifactPaths: Object.fromEntries(pluginData.map(({ pluginId, dir }) => [pluginId, path.join(dir, 'lib')])),
        timeoutMs: 900000,
        initializeTimeoutMs: 120000,
      },
    },
    applications: applications.map((_, index) => `release-${pluginData[index].appDir}.json`),
    catalog: {
      catalogId: `local.${provider}`,
      runtimeBundleDigest,
      defaultSelectionId,
      entries: [{
        selectionId: `model.${model}`,
        provider,
        model,
        displayName: modelName,
        description: '部署配置的模型路由；可用性以实际运行结果为准。',
        adapter,
        adapterVersion: '0.2.2-rc.5',
        enabled: true,
        verification: 'provider-declared',
        capabilities: { contextWindow: 1000000, modalities: ['text'] },
        parameters: { maxTokens: true },
      },
      ...(extraEnabled ? [{
        selectionId: `model.${extraModel}`,
        provider: extraProvider,
        model: extraModel,
        displayName: extraModelName,
        description: '本机桥接路由（anthropic-messages）；可用性以实际运行结果为准。',
        adapter,
        adapterVersion: '0.2.2-rc.5',
        enabled: true,
        verification: 'provider-declared',
        capabilities: { contextWindow: 200000, modalities: ['text'], toolUse: 'unknown', reasoning: 'yes' },
        parameters: { maxTokens: true, ...(extraEfforts.length ? { reasoningEffort: extraEfforts } : {}) },
        ...(extraEfforts.length ? { modelOptions: { reasoningEffort: extraEfforts.includes('high') ? 'high' : extraEfforts[0] } } : {}),
      }] : [])],
    },
  }, null, 2)}\n`);
  console.log(`Deployment written to ${path.join(outDir, 'deployment.json')}`);
  console.log(`Provider ${provider}/${model}; credential env ${credentialEnv} (not written).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
