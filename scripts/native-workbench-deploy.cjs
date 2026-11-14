'use strict';
// Parameterized native-workbench deployment assembly (T08).
//
// Emits a validated, non-secret deployment descriptor for one of two shapes:
//   local  — single-owner process with explicit home/workspace/port.
//   hosted — one authoritative control service plus allow-listed execution domains and browser
//            origins; the browser entry only admits those origins and proxies only allow-listed
//            services (never a user-supplied URL).
//
// It never writes credentials: providers are referenced only by the environment-variable name the
// adapter reads, and a control/domain URL with embedded credentials or a query is refused.
//
// Usage:
//   node scripts/native-workbench-deploy.cjs --mode local  --home <abs> --workspace <abs> --port 3083 [--out <dir>]
//   node scripts/native-workbench-deploy.cjs --mode hosted --control-url https://control.internal:8443 \
//        --origin https://workbench.internal --domain domain-a=https://domain-a.internal:9000 --port 8443 [--out <dir>]

const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : undefined;
};
const values = (name) => {
  const out = [];
  args.forEach((entry, index) => {
    if (entry === `--${name}` && args[index + 1]) out.push(args[index + 1]);
  });
  return out;
};

async function main() {
  // Load the compiled validator so the script and the control plane share one rule set.
  const module = await import(pathToFileURL(path.join(root, 'packages', 'platform-control', 'lib', 'index.js')).href);
  if (typeof module.validateDeployment !== 'function') {
    throw new Error('platform-control bundle missing workbench-deploy; run its build first.');
  }

  const mode = value('mode');
  const port = Number(value('port'));
  let draft;
  if (mode === 'local') {
    draft = { mode: 'local', home: value('home'), workspace: value('workspace'), port };
  } else if (mode === 'hosted') {
    draft = {
      mode: 'hosted',
      controlUrl: value('control-url'),
      allowedOrigins: values('origin'),
      domains: values('domain').map((entry) => {
        const index = entry.indexOf('=');
        if (index <= 0) throw new Error(`--domain must be <id>=<url>, got "${entry}"`);
        return { domainId: entry.slice(0, index), controlUrl: entry.slice(index + 1) };
      }),
      port,
    };
  } else {
    throw new Error('--mode must be "local" or "hosted"');
  }

  const validated = module.validateDeployment(draft);
  const outDir = path.resolve(value('out') ?? path.join(root, '.runtime', `native-workbench-${validated.mode}`));
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'native-workbench.deployment.json');
  writeFileSync(file, `${JSON.stringify(validated, null, 2)}\n`);
  console.log(`Validated ${validated.mode} deployment written to ${file}`);
  if (validated.mode === 'local') {
    console.log(`Start: node scripts/native-workbench-start.cjs --deployment "${file}"`);
    console.log('Local mode uses the operator principal as its trust boundary; it is not enterprise SSO.');
  } else {
    console.log('Hosted mode: run one authoritative control service; execution domains attach to it.');
    console.log('The browser entry admits only the listed origins and proxies only allow-listed services.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
