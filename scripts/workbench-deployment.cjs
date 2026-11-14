// Generate a non-secret local workbench deployment: worker profile binding, app releases,
// and a model catalog for the provider route the worker environment actually mounts.
// It never writes credentials; provider keys stay in the execution environment.
const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const path = require('node:path');

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

const plugins = [
  { dir: path.join(root, 'plugins', 'dm-listing'), appDir: 'dm-listing' },
  { dir: path.join(root, 'plugins', 'dm-dvp'), appDir: 'dm-dvp' },
];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
function directoryDigest(dir) {
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else files.push([path.relative(dir, full).replaceAll('\\', '/'), sha256(readFileSync(full))]);
    }
  };
  if (existsSync(dir)) walk(dir);
  return sha256(JSON.stringify(files));
}

const manifest = JSON.parse(readFileSync(path.join(workerHome, 'profiles', 'worker', 'package.json'), 'utf8'));
const pluginData = plugins.map(({ dir, appDir }) => {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const app = JSON.parse(readFileSync(path.join(dir, 'application.json'), 'utf8'));
  return { dir, appDir, pkg, app, digest: directoryDigest(path.join(dir, 'lib')) };
});
const runtimeBundleDigest = sha256(JSON.stringify({
  base: '0.2.2-rc.1',
  profile: manifest.name,
  bundles: manifest.dsh.profile.bundles,
  plugins: pluginData.map(({ pkg }) => `${pkg.name}@${pkg.version}`),
}));

const provider = option('--provider', process.env.PLATFORM_LLM_PROVIDER ?? 'zai-coding-cn');
const model = option('--model', process.env.PLATFORM_LLM_MODEL ?? 'glm-5.3-flash');
const modelName = option('--model-name', process.env.PLATFORM_LLM_MODEL_NAME ?? 'GLM-5.3-Flash');
const credentialEnv = option('--key-env', 'ZAI_CODING_CN_API_KEY');
const baseURL = option('--base-url', 'https://open.bigmodel.cn/api/anthropic');
const adapter = option('--adapter', 'pi-ai');

const applications = pluginData.map(({ appDir, pkg, app, digest }) => ({
  descriptor: {
    appId: app.appId,
    version: pkg.version,
    displayName: app.displayName,
    description: app.description,
    ...(app.listingTypes ? { listingTypes: app.listingTypes } : {}),
    ...(app.materialRoles ? { materialRoles: app.materialRoles } : {}),
    ...(app.resultTypes ? { resultTypes: app.resultTypes } : {}),
  },
  requiredCapabilities: [{ capabilityId: app.capabilityId, version: pkg.version }],
  providers: [{
    capabilityId: app.capabilityId,
    version: pkg.version,
    pluginId: pkg.name.split('/').pop(),
    pluginVersion: pkg.version,
    artifactDigest: digest,
    protocolVersion: '1',
    inputSchemaVersion: '1',
    outputSchemaVersion: '1',
    dependencies: [],
  }],
  runtimeBundleDigest,
}));

for (const [index, application] of applications.entries()) {
  writeFileSync(path.join(outDir, `release-${pluginData[index].appDir}.json`), `${JSON.stringify(application, null, 2)}\n`);
}
writeFileSync(path.join(outDir, 'model-route.patch.yml'), [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  `      ${provider}:`,
  '        api: anthropic-messages',
  `        baseURL: ${baseURL}`,
  `        apiKeyEnv: ${credentialEnv}`,
  '        models:',
  `          - id: ${model}`,
  `            name: ${modelName}`,
  '            contextWindow: 1000000',
  '            maxTokens: 32768',
  '            input: [text]',
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
      timeoutMs: 900000,
      initializeTimeoutMs: 120000,
    },
  },
  applications: applications.map((_, index) => `release-${pluginData[index].appDir}.json`),
  catalog: {
    catalogId: `local.${provider}`,
    runtimeBundleDigest,
    defaultSelectionId: `model.${model}`,
    entries: [{
      selectionId: `model.${model}`,
      provider,
      model,
      displayName: modelName,
      description: '部署配置的模型路由；可用性以实际运行结果为准。',
      adapter,
      adapterVersion: '0.2.2-rc.1',
      enabled: true,
      verification: 'provider-declared',
      capabilities: { contextWindow: 1000000, modalities: ['text'] },
      parameters: { maxTokens: true },
    }],
  },
}, null, 2)}\n`);
console.log(`Deployment written to ${path.join(outDir, 'deployment.json')}`);
console.log(`Provider ${provider}/${model}; credential env ${credentialEnv} (not written).`);
