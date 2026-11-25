// M3-02 门禁自测：合成插件树验证分母对账、缺项阻断与 --release 语义（不是业务验收）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const gate = join(here, 'verify-knowledge-coverage.mjs');

const manifest = (overrides = {}) => ({
  schemaVersion: 2,
  pluginId: 'good',
  owner: 'Good 维护者',
  source: 'src/knowledge-seeds.ts',
  taxonomy: { topics: ['t'] },
  seeds: [{ knowledgeId: 'good.one', topics: ['t'] }],
  validators: [],
  capabilities: [{ tool: 'good_status', topics: ['t'] }],
  noMethodKnowledge: [],
  agent: {
    id: 'good.agent',
    version: '1.0.0',
    owner: 'Good 维护者',
    topics: ['t'],
    tools: [{ tool: 'good_status', topics: ['t'] }],
    noMethodTools: [],
  },
  feedback: { events: ['run.failed'], projectionVersion: '1' },
  goldenSet: { id: 'good.golden', version: '1', cases: [{ query: 'q', expect: ['good.one'] }] },
  scope: { projects: 'all' },
  ...overrides,
});

const fixture = ({ assembly, plugins = {}, packages = {} }) => {
  const root = mkdtempSync(join(tmpdir(), 'pk-coverage-'));
  writeFileSync(join(root, 'knowledge-assembly.json'), JSON.stringify({ schemaVersion: 1, entries: assembly }));
  for (const [name, value] of Object.entries(plugins)) {
    mkdirSync(join(root, 'plugins', name, 'knowledge'), { recursive: true });
    if (value !== undefined) writeFileSync(join(root, 'plugins', name, 'knowledge', 'manifest.json'), JSON.stringify(value));
  }
  for (const name of Object.keys(packages)) mkdirSync(join(root, 'packages', name), { recursive: true });
  return root;
};

const run = (root, args = []) => {
  const report = join(root, 'report.json');
  const result = spawnSync(process.execPath, [gate, '--root', root, '--json', '--report', report, ...args], {
    encoding: 'utf8',
  });
  const parsed = readFileSync(report, 'utf8');
  return { status: result.status, stderr: result.stderr, report: JSON.parse(parsed) };
};

test('a complete managed assembly passes with full coverage', () => {
  const root = fixture({
    assembly: [{ path: 'plugins/good', pluginId: 'good', class: 'managed', owner: 'Good 维护者' }],
    plugins: { good: manifest() },
  });
  try {
    const { status, report, stderr } = run(root);
    assert.equal(status, 0, stderr);
    assert.deepEqual(report.coverage, { passed: 1, total: 1 });
    assert.equal(report.managed[0].agent, 'good.agent@1.0.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an undeclared plugin directory and a missing manifest both block the gate', () => {
  const unlisted = fixture({
    assembly: [{ path: 'plugins/good', pluginId: 'good', class: 'managed' }],
    plugins: { good: manifest(), newcomer: undefined },
  });
  try {
    const { status, report } = run(unlisted);
    assert.equal(status, 1);
    assert.ok(report.failures.some((failure) => failure.includes('KNOWLEDGE_ASSEMBLY_UNLISTED')));
  } finally {
    rmSync(unlisted, { recursive: true, force: true });
  }

  const missing = fixture({
    assembly: [
      { path: 'plugins/good', pluginId: 'good', class: 'managed' },
      { path: 'plugins/newbie', pluginId: 'newbie', class: 'managed' },
    ],
    plugins: { good: manifest(), newbie: undefined },
  });
  try {
    const { status, report } = run(missing);
    assert.equal(status, 1);
    assert.equal(report.coverage.passed, 1);
    assert.equal(report.coverage.total, 2);
    assert.ok(report.failures.some((failure) => failure.startsWith('plugins/newbie: KNOWLEDGE_MANIFEST_MISSING')));
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }
});

test('dangling golden evidence and plugin identity mismatches are rejected', () => {
  const dangling = fixture({
    assembly: [{ path: 'plugins/good', pluginId: 'good', class: 'managed' }],
    plugins: {
      good: manifest({ goldenSet: { id: 'g', version: '1', cases: [{ query: 'q', expect: ['good.missing'] }] } }),
    },
  });
  try {
    const { status, report } = run(dangling);
    assert.equal(status, 1);
    assert.ok(report.failures.some((failure) => failure.includes('KNOWLEDGE_GOLDEN_TARGET_UNDECLARED')));
  } finally {
    rmSync(dangling, { recursive: true, force: true });
  }

  const mismatch = fixture({
    assembly: [{ path: 'plugins/good', pluginId: 'other', class: 'managed' }],
    plugins: { good: manifest() },
  });
  try {
    const { status, report } = run(mismatch);
    assert.equal(status, 1);
    assert.ok(report.failures.some((failure) => failure.includes('KNOWLEDGE_MANIFEST_PLUGIN_MISMATCH')));
  } finally {
    rmSync(mismatch, { recursive: true, force: true });
  }
});

test('a managed manifest must actually ship in the package files list', () => {
  const root = fixture({
    assembly: [{ path: 'plugins/good', pluginId: 'good', class: 'managed' }],
    plugins: { good: manifest() },
  });
  try {
    writeFileSync(join(root, 'plugins', 'good', 'package.json'), JSON.stringify({ name: 'good', files: ['lib'] }));
    const { status, report } = run(root);
    assert.equal(status, 1);
    assert.ok(report.failures.some((failure) => failure.includes('KNOWLEDGE_MANIFEST_NOT_PACKAGED')));

    writeFileSync(join(root, 'plugins', 'good', 'package.json'), JSON.stringify({ name: 'good', files: ['lib', 'knowledge'] }));
    const fixed = run(root);
    assert.equal(fixed.status, 0, fixed.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pending platform plugins are reported in repo mode and block only the release gate', () => {
  const root = fixture({
    assembly: [
      { path: 'plugins/good', pluginId: 'good', class: 'managed' },
      { path: 'packages/platform-thing', class: 'platform-pending', owner: '平台负责人', reason: '待补齐技术知识' },
    ],
    plugins: { good: manifest() },
    packages: { 'platform-thing': true },
  });
  try {
    const repo = run(root);
    assert.equal(repo.status, 0, repo.stderr);
    assert.equal(repo.report.blockers.length, 1);

    const release = run(root, ['--release']);
    assert.equal(release.status, 1);
    assert.ok(release.report.blockers[0].includes('KNOWLEDGE_AGENT_PENDING'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});