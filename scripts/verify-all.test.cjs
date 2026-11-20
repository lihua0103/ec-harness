// Synthetic-only regression tests: never executes the repository-wide gate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { discover, runVerification, supportedNode } = require('./verify-all.cjs');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'verify-all-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, content = '') => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  put('scripts/check-development-standard.mjs', 'if (process.argv.includes("--self-test")) console.log("synthetic checker self-test");');
  // Deliberately a tiny fixture, not a copy of this recursive test runner.
  put('scripts/verify-applications.mjs', 'process.exit(0);');
  put('scripts/verify-knowledge-golden.mjs', 'process.exit(0);');
  put('scripts/verify-knowledge-coverage.mjs', 'process.exit(0);');
  put('scripts/verify-knowledge-coverage.test.mjs', 'process.exit(0);');
  put('scripts/accept-knowledge-roles.mjs', 'process.exit(0);');
  put('scripts/verify-all.test.cjs', 'require("node:assert/strict").ok(true);');
  const pkg = (directory = 'packages/example', overrides = {}) => {
    const manifest = { name: '@synthetic/example', version: '1.0.0', type: 'module', exports: './index.mjs', engines: { node: '>=24.9.0' }, scripts: { verify: 'node --check index.mjs' }, ...overrides };
    put(`${directory}/package.json`, JSON.stringify(manifest));
    put(`${directory}/README.md`);
    put(`${directory}/index.mjs`);
    return manifest;
  };
  return { root, put, pkg };
}

for (const fallback of ['typecheck', 'test', 'build']) {
  test(`rejects ${fallback}-only package instead of choosing a fallback`, (t) => {
    const f = fixture(t);
    f.pkg(undefined, { scripts: { [fallback]: 'node --version' } });
    const result = discover(f.root);
    assert.ok(result.failures.some((failure) => failure.includes('scripts.verify required')));
    assert.equal(result.targets.filter((target) => target.kind === 'package').length, 0);
  });
}

test('accepts config-only bundle with manifest-selected nested patch and shared commands', (t) => {
  const f = fixture(t);
  f.pkg('plugins/config', { main: undefined, exports: undefined, dsh: { bundle: { patch: './config/install.yml' } }, scripts: { verify: 'node ../../shared/check.mjs', build: 'node ../../shared/build.mjs', test: 'node --test inline.test.mjs' } });
  f.put('plugins/config/config/install.yml', '[]');
  assert.deepEqual(discover(f.root).failures, []);
});

test('does not require src, build.mjs or tests directory for alternative script layouts', (t) => {
  const f = fixture(t);
  f.pkg(undefined, { scripts: { verify: 'npm run build && npm test', build: 'tsc', test: 'node --test index.test.mjs' } });
  assert.deepEqual(discover(f.root).failures, []);
});

for (const patch of [undefined, '', './missing.yml', '../outside.yml']) {
  test(`rejects invalid bundle patch ${JSON.stringify(patch)}`, (t) => {
    const f = fixture(t);
    f.pkg(undefined, { dsh: { bundle: { patch } } });
    assert.ok(discover(f.root).failures.some((failure) => failure.includes('dsh.bundle.patch')));
  });
}

test('does not substitute a hardcoded cordis.patch.yml for a missing declared patch', (t) => {
  const f = fixture(t);
  f.pkg(undefined, { dsh: { bundle: { patch: './another.yml' } } });
  f.put('packages/example/cordis.patch.yml', '[]');
  assert.ok(discover(f.root).failures.some((failure) => failure.includes('./another.yml')));
});

test('requires checker and aggregator self-test files', (t) => {
  const f = fixture(t);
  unlinkSync(path.join(f.root, 'scripts/check-development-standard.mjs'));
  unlinkSync(path.join(f.root, 'scripts/verify-all.test.cjs'));
  const failures = discover(f.root).failures;
  assert.equal(failures.length, 3); // Checker normal + self-test, plus aggregator self-test; golden fixture is intentionally kept present.
  assert.ok(failures.every((failure) => failure.includes('missing (required check)')));
});

test('discovers all package groups, checker self-test, and separate prototype verification', (t) => {
  const f = fixture(t);
  for (const group of ['packages', 'plugins', 'apps']) f.pkg(`${group}/example`, { name: `@synthetic/${group}` });
  f.put('prototypes/example/verify.mjs');
  const calls = [];
  const result = runVerification(f.root, { execute: (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; }, log() {}, error() {} });
  assert.deepEqual(result.failures, []);
  assert.equal(calls.length, 12);
  assert.equal(calls.filter((call) => call.args.includes('verify')).length, 3);
  assert.equal(calls.filter((call) => call.args.includes('--self-test')).length, 1);
  assert.ok(result.targets.some((target) => target.name.includes('not product acceptance')));
});

test('missing prototype verifier, malformed manifest and manifestless package fail discovery', (t) => {
  const f = fixture(t);
  f.put('prototypes/missing/index.html');
  f.put('apps/broken/package.json', '{');
  f.put('packages/missing/README.md');
  const failures = discover(f.root).failures;
  assert.ok(failures.some((failure) => failure.includes('prototype missing: verify.mjs missing')));
  assert.ok(failures.some((failure) => failure.includes('invalid package.json')));
  assert.ok(failures.some((failure) => failure.includes('package.json missing')));
});

for (const result of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { status: 0, error: new Error('spawn failed') }]) {
  test(`failed child cannot pass (${result.signal || result.error?.message || result.status})`, (t) => {
    const f = fixture(t);
    const actual = runVerification(f.root, { execute: () => result, log() {}, error() {} });
    assert.equal(actual.failedCommands, 8);
    assert.equal(actual.failures.length, 8);
  });
}

test('a thrown executor error is reported as failure', (t) => {
  const f = fixture(t);
  const result = runVerification(f.root, { execute() { throw new Error('cannot spawn'); }, log() {}, error() {} });
  assert.equal(result.failedCommands, 8);
  assert.ok(result.failures.every((failure) => failure.includes('cannot spawn')));
});

test('real subprocesses execute synthetic tooling and prototype checks without recursion', (t) => {
  const f = fixture(t);
  f.put('prototypes/example/verify.mjs', 'import assert from "node:assert/strict"; import { fileURLToPath } from "node:url"; import path from "node:path"; assert.equal(process.cwd(), path.dirname(fileURLToPath(import.meta.url)));');
  const result = runVerification(f.root, {
    execute(command, args, options) {
      // A spawned independent test runner must not inherit its parent's worker marker.
      const env = { ...options.env };
      delete env.NODE_TEST_CONTEXT;
      return require('node:child_process').spawnSync(command, args, { ...options, env });
    },
    log() {}, error() {},
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.targets.length, 9);
});

test('supported Node versions preserve minimum 24.9 gate', () => {
  for (const version of ['22.20.0', '24.8.9']) assert.equal(supportedNode(version), false);
  for (const version of ['24.9.0', '24.10.0', '25.0.0']) assert.equal(supportedNode(version), true);
});
