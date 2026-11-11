// Root verification entry: Node version, package structure, then every package's declared checks.
// A discovered package without a verification command is a failure, never a silent skip.
const { readdirSync, readFileSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 9)) {
  console.error(`Node ${process.versions.node} is unsupported; require >=24.9.0.`);
  process.exit(1);
}
const nodeDir = path.dirname(process.execPath);
const env = {
  ...process.env,
  PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}`,
  Path: `${nodeDir}${path.delimiter}${process.env.Path ?? ''}`,
};
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const useNpmCli = existsSync(npmCli);

const failures = [];
const checkStructure = (manifest, directory, name) => {
  const fail = (message) => failures.push(`${name}: ${message}`);
  if (!manifest.name || !manifest.version) fail('package.json needs name and version');
  if (manifest.type !== 'module') fail('package.json type must be module');
  if (!manifest.main && !manifest.exports) fail('package.json needs main or exports');
  if (!manifest.engines?.node) fail('package.json needs engines.node');
  if (!existsSync(path.join(directory, 'README.md'))) fail('README.md missing');
  if (!existsSync(path.join(directory, 'src'))) fail('src/ missing');
  if (manifest.dsh?.bundle) {
    if (!existsSync(path.join(directory, 'cordis.patch.yml'))) fail('dsh.bundle patch missing');
    if (!existsSync(path.join(directory, 'build.mjs'))) fail('bundle build.mjs missing');
  }
  if (manifest.scripts?.build && !existsSync(path.join(directory, 'build.mjs'))) fail('build script without build.mjs');
  if (manifest.scripts?.test && !existsSync(path.join(directory, 'tests'))) fail('test script without tests/');
};

const targets = [];
for (const group of ['packages', 'plugins']) {
  const groupRoot = path.join(root, group);
  if (!existsSync(groupRoot)) continue;
  for (const name of readdirSync(groupRoot).sort()) {
    const directory = path.join(groupRoot, name);
    const manifestPath = path.join(directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const label = manifest.name ?? `${group}/${name}`;
    checkStructure(manifest, directory, label);
    const scripts = manifest.scripts ?? {};
    const command = scripts.verify ? 'verify' : scripts.typecheck ? 'typecheck' : scripts.test ? 'test' : scripts.build ? 'build' : null;
    if (!command) {
      failures.push(`${label}: no verify/typecheck/test/build script`);
      continue;
    }
    targets.push({ name: label, directory, command });
  }
}

const standardCheck = path.join(root, 'scripts', 'check-development-standard.mjs');
if (existsSync(standardCheck)) {
  console.log('\n== development standard check ==');
  const result = spawnSync(process.execPath, [standardCheck], { cwd: root, stdio: 'inherit', env });
  if (result.status !== 0) failures.push('check-development-standard.mjs');
} else {
  console.log(`\n== package structure checks (inline; ${targets.length} packages) ==`);
  console.log('scripts/check-development-standard.mjs is not present; inline structure checks ran instead.');
}

let failedCommands = 0;
for (const target of targets) {
  console.log(`\n== ${target.name} (npm run ${target.command}) ==`);
  const args = useNpmCli ? [npmCli, 'run', target.command] : ['run', target.command];
  const result = spawnSync(useNpmCli ? process.execPath : npm, args, {
    cwd: target.directory,
    stdio: 'inherit',
    env,
    shell: !useNpmCli && process.platform === 'win32',
  });
  if (result.status !== 0) {
    failedCommands++;
    failures.push(`${target.name}: npm run ${target.command}`);
  }
}
console.log(`\n${targets.length - failedCommands}/${targets.length} package verification commands passed.`);
if (failures.length) {
  console.error('\nFAILED:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}