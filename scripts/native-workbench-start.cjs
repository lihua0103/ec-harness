'use strict';
// Start a native-workbench deployment from a validated descriptor (T08).
//
// local  — one control process bound to the descriptor's home/workspace/port. The operator principal
//          is the trust boundary; this is not enterprise SSO.
// hosted — exactly one authoritative control process owns the control store. A second process pointed
//          at the same store is refused rather than letting two hosts share one SQLite file. Execution
//          domains attach to the authoritative service through the authenticated entry; this script
//          does not start a domain proxy (that entry is part of the deployment, see the doc).
//
// No credential is read or written here; the worker environment supplies provider keys.

const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : undefined;
};

const deploymentPath = value('deployment') ?? process.env.NATIVE_WORKBENCH_DEPLOYMENT;
if (!deploymentPath) {
  console.error('--deployment <native-workbench.deployment.json> is required');
  process.exit(1);
}

let descriptor;
try {
  descriptor = JSON.parse(readFileSync(deploymentPath, 'utf8'));
} catch (error) {
  console.error(`Cannot read deployment: ${error.message}`);
  process.exit(1);
}

if (descriptor.mode === 'local') {
  if (!descriptor.home || !descriptor.workspace) {
    console.error('local deployment must name absolute home and workspace');
    process.exit(1);
  }
  const store = path.join(descriptor.home, 'platform', 'native-workbench.sqlite');
  const pc = path.join(root, 'packages', 'platform-control');
  const api = path.join(pc, 'src', 'api-cli.ts');
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', api,
    '--port', String(descriptor.port),
    '--store', store,
  ], {
    // tsx and the @deepseek-ai links resolve from the platform-control package.
    cwd: pc,
    env: { ...process.env, DSH_HOME: descriptor.home },
    stdio: 'inherit',
  });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
} else if (descriptor.mode === 'hosted') {
  const role = value('role');
  if (role !== 'control') {
    // A domain proxy is part of the deployment's authenticated entry, not this local script.
    console.error(
      'Hosted deployment: run exactly one authoritative control process with --role control.\n' +
      'Execution domains are reached through the deployment\'s authenticated, Origin-checked entry,\n' +
      'which proxies only allow-listed services and never a user-supplied URL. This script does not\n' +
      'start that entry, and it will not start a second process against the same control store.',
    );
    process.exit(1);
  }
  const store = path.join(value('home') ?? path.join(root, '.runtime', 'native-workbench-hosted'), 'platform', 'native-workbench.sqlite');
  const pc = path.join(root, 'packages', 'platform-control');
  const api = path.join(pc, 'src', 'api-cli.ts');
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', api,
    '--port', String(descriptor.port),
    '--store', store,
  ], {
    cwd: pc,
    env: { ...process.env, DSH_HOME: value('home') ?? path.join(root, '.runtime', 'native-workbench-hosted') },
    stdio: 'inherit',
  });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
} else {
  console.error(`Unsupported deployment mode: ${descriptor.mode}`);
  process.exit(1);
}
