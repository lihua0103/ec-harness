// Create an isolated DSH worker profile for platform-control's DshProfileExecutor.
// The worker home is separate from the control/UI home; model credentials stay in the deployment's
// environment and are not written here.
const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const root = path.resolve(__dirname, '..');
const home = path.resolve(option('--home', path.join(root, '.runtime', 'worker-home')));
const profile = path.join(home, 'profiles', 'worker');
const link = (target) => `link:${target.replaceAll('\\', '/')}`;

if (existsSync(profile)) {
  throw new Error(`Profile already exists; refusing to overwrite configuration: ${profile}. Choose a new --home.`);
}
mkdirSync(profile, { recursive: true });
const manifest = {
  name: 'dsh-profile-worker',
  private: true,
  dependencies: {
    '@ec-clinical/platform-knowledge': link(path.join(root, 'packages', 'platform-knowledge')),
    '@ec-clinical/dsh-dm-listing': link(path.join(root, 'plugins', 'dm-listing')),
    '@ec-clinical/dsh-dm-dvp': link(path.join(root, 'plugins', 'dm-dvp')),
  },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-sdk-app',
        '@ec-clinical/platform-knowledge',
        '@ec-clinical/dsh-dm-listing',
        '@ec-clinical/dsh-dm-dvp',
      ],
    },
  },
};
writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  path.join(profile, 'pnpm-workspace.yaml'),
  'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
);
writeFileSync(
  path.join(profile, 'cordis.yml'),
  '# Worker profile root: composed from dsh.profile.bundles, cordis.patch.yml, and overlays.\n[]\n',
);
writeFileSync(
  path.join(profile, 'cordis.patch.yml'),
  [
    '# Worker governance: runtime plugin installation and native schedule auto-resume are disabled.',
    '# The model/provider route and credentials are deployment inputs; add the llm patch used by the',
    '# worker environment here. Do not commit credentials.',
    '- id: tool-plugin-manager',
    '  disabled: true',
    '- id: schedule',
    '  disabled: true',
    '- id: tool-schedule',
    '  disabled: true',
    '- id: hmr',
    '  disabled: true',
    '',
  ].join('\n'),
);
console.log(`Worker profile written to ${profile}`);
console.log('Next: add the deployment model/provider patch, run pnpm install in that directory,');
console.log('then configure platform-control worker.profile=worker, worker.dshHome=<home>,');
console.log('worker.workspace=<absolute run workspace>, and install @deepseek-ai/dsh-sdk-client.');
if (args.includes('--install')) {
  const result = spawnSync('pnpm', ['install'], { cwd: profile, stdio: 'inherit', shell: true });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}