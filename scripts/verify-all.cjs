// Root verification entry. Package owners declare the complete applicable check set in verify;
// this runner does not infer compliance from a single typecheck, test or build command.
const { readdirSync, readFileSync, existsSync, statSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function supportedNode(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 9);
}

function discover(root) {
  const failures = [];
  const targets = [];
  const isFile = (file) => existsSync(file) && statSync(file).isFile();
  const directories = (directory) => existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    : [];
  for (const group of ['packages', 'plugins', 'apps']) {
    for (const name of directories(path.join(root, group))) {
      const directory = path.join(root, group, name);
      const manifestPath = path.join(directory, 'package.json');
      if (!isFile(manifestPath)) {
        failures.push(`${group}/${name}: package.json missing`);
        continue;
      }
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('expected an object');
      } catch (error) {
        failures.push(`${group}/${name}: invalid package.json (${error.message})`);
        continue;
      }
      const label = manifest.name || `${group}/${name}`;
      const fail = (message) => failures.push(`${label}: ${message}`);
      if (!manifest.name || !manifest.version) fail('package.json needs name and version');
      if (manifest.type !== 'module') fail('package.json type must be module');
      // Configuration-only bundles need not expose code, or have src/ or a compiler.
      if (!manifest.main && !manifest.exports && !manifest.dsh?.bundle) fail('package.json needs main or exports');
      if (!manifest.engines?.node) fail('package.json needs engines.node');
      if (!isFile(path.join(directory, 'README.md'))) fail('README.md missing');
      if (manifest.dsh?.bundle) {
        const patch = manifest.dsh.bundle.patch;
        if (typeof patch !== 'string' || !patch.trim()) {
          fail('dsh.bundle.patch must name the shipped patch');
        } else {
          const resolved = path.resolve(directory, patch);
          const relative = path.relative(directory, resolved);
          if (path.isAbsolute(patch) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            fail('dsh.bundle.patch must be inside the package');
          } else if (!isFile(resolved)) fail(`dsh.bundle.patch missing: ${patch}`);
        }
      }
      if (typeof manifest.scripts?.verify !== 'string' || !manifest.scripts.verify.trim()) {
        fail('explicit aggregate scripts.verify required; no typecheck/test/build fallback');
      } else {
        targets.push({ name: label, directory, kind: 'package', command: 'verify' });
      }
      // Declared scripts may use tsc, a shared build, inline checks, or other layouts.
      // Execute verify rather than pretending to parse arbitrary shell commands here.
    }
  }
  for (const [file, args, name] of [
    ['scripts/check-development-standard.mjs', [], 'development standard check'],
    ['scripts/check-development-standard.mjs', ['--self-test'], 'development standard checker self-test'],
    ['scripts/verify-applications.mjs', [], 'application registration check'],
    ['scripts/verify-knowledge-golden.mjs', [], 'knowledge golden retrieval check'],
    ['scripts/verify-knowledge-coverage.mjs', [], 'knowledge agent coverage check'],
    ['scripts/verify-knowledge-coverage.test.mjs', [], 'knowledge coverage gate self-test'],
    ['scripts/accept-knowledge-roles.mjs', [], 'knowledge acceptance by real roles'],
    ['scripts/verify-all.test.cjs', [], 'verification aggregator self-test'],
  ]) {
    const entry = path.join(root, file);
    if (!isFile(entry)) failures.push(`${file} missing (required check)`);
    else targets.push({ name, directory: root, kind: 'node', args: file.endsWith('.test.cjs') || file.endsWith('.test.mjs') ? ['--test', entry] : [entry, ...args] });
  }
  for (const name of directories(path.join(root, 'prototypes'))) {
    const directory = path.join(root, 'prototypes', name);
    const entry = path.join(directory, 'verify.mjs');
    if (!isFile(entry)) failures.push(`prototype ${name}: verify.mjs missing`);
    else targets.push({ name: `prototype ${name} (not product acceptance)`, directory, kind: 'node', args: [entry] });
  }
  return { failures, targets };
}

function runVerification(root, { execute = spawnSync, log = console.log, error = console.error } = {}) {
  const { failures, targets } = discover(root);
  const nodeDir = path.dirname(process.execPath);
  const env = {
    ...process.env,
    PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}`,
    Path: `${nodeDir}${path.delimiter}${process.env.Path ?? ''}`,
  };
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const useNpmCli = existsSync(npmCli);
  let failedCommands = 0;
  for (const target of targets) {
    log(`\n== ${target.name}${target.kind === 'package' ? ' (npm run verify)' : ''} ==`);
    const executable = target.kind === 'node' || useNpmCli ? process.execPath : npm;
    const args = target.kind === 'node' ? target.args : useNpmCli ? [npmCli, 'run', 'verify'] : ['run', 'verify'];
    let result;
    try {
      result = execute(executable, args, {
        cwd: target.directory, stdio: 'inherit', env,
        shell: target.kind === 'package' && !useNpmCli && process.platform === 'win32',
      });
    } catch (cause) {
      result = { status: null, error: cause };
    }
    if (result.status !== 0 || result.error || result.signal) {
      failedCommands++;
      failures.push(`${target.name}: check failed${result.error ? ` (${result.error.message})` : result.signal ? ` (${result.signal})` : ` (exit ${result.status})`}`);
    }
  }
  log(`\n${targets.length - failedCommands}/${targets.length} verification commands passed (packages, tooling and prototypes are distinct checks).`);
  if (failures.length) {
    error('\nFAILED:');
    for (const failure of failures) error(`- ${failure}`);
  }
  return { failures, targets, failedCommands };
}

module.exports = { discover, runVerification, supportedNode };
if (require.main === module) {
  if (!supportedNode(process.versions.node)) {
    console.error(`Node ${process.versions.node} is unsupported; require >=24.9.0.`);
    process.exitCode = 1;
  } else {
    try {
      const result = runVerification(path.resolve(__dirname, '..'));
      if (result.failures.length) process.exitCode = 1;
    } catch (error) {
      console.error(`Verification discovery failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
