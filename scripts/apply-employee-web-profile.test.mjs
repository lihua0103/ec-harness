// R3 / P0-5：员工 Web 治理基线——叠加层必须禁用 agent 侧治理工具与 HMR，不只隐藏侧栏。
// 用临时 profile 跑 apply-employee-web-profile.cjs，断言幂等合并/回滚覆盖全部治理行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, 'apply-employee-web-profile.cjs');
const GOVERNANCE_IDS = [
  'ui-sidebar',
  'tool-plugin-manager',
  'schedule',
  'tool-schedule',
  'goal',
  'command-goal',
  'tool-goal',
  'hmr',
];

function run(args) {
  const pathDir = process.env.PATH ?? '';
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${process.execPath.replace(/node\.exe$/i, '')}${delimiter}${pathDir}` },
  });
}

function disabledIds(patchPath) {
  const lines = readFileSync(patchPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const ids = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^- id: (\S+)$/.exec(lines[i].trim());
    if (m && /^\s*disabled:\s*true\s*$/.test(lines[i + 1] ?? '')) ids.add(m[1]);
  }
  return ids;
}

test('employee-web profile applies all governance disabled rows idempotently', () => {
  const home = mkdtempSync(join(tmpdir(), 'employee-web-'));
  const profile = join(home, 'profiles', 'employee');
  const patchPath = join(profile, 'cordis.patch.yml');
  try {
    const first = run(['--profile', profile]);
    assert.equal(first.status, 0, first.stderr);
    const ids = disabledIds(patchPath);
    for (const id of GOVERNANCE_IDS) assert.ok(ids.has(id), `missing disabled: ${id}`);
    assert.ok(readFileSync(patchPath, 'utf8').includes('ec-platform-workbench'), 'workbench insert present');

    // 幂等：第二次应用不改文件。
    const before = readFileSync(patchPath, 'utf8');
    const second = run(['--profile', profile]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(patchPath, 'utf8'), before, 'second apply is a no-op');
  } finally {
    run(['--profile', profile, '--rollback']);
    if (existsSync(patchPath)) {
      const ids = disabledIds(patchPath);
      for (const id of GOVERNANCE_IDS) assert.ok(!ids.has(id), `rollback left disabled: ${id}`);
      assert.ok(!readFileSync(patchPath, 'utf8').includes('ec-platform-workbench'), 'rollback removed workbench insert');
    }
  }
});

test('employee-web.patch.yml declares every governance disabled row', () => {
  const patchPath = join(import.meta.dirname, '..', 'packages', 'platform-workbench', 'employee-web.patch.yml');
  const text = readFileSync(patchPath, 'utf8');
  for (const id of GOVERNANCE_IDS) {
    assert.match(text, new RegExp(`- id: ${id}\\n  disabled: true`), `patch missing ${id}`);
  }
});