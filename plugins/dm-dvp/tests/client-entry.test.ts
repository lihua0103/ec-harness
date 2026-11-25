/** 员工入口（客户端）与宿主的一致性（2026-11-24）：入口按"当前会话所属应用"显隐；入口插入的提示词只点名
 *  真实注册的工具（此前模型猜的 dm_dvp_scan 等并不存在）；dm_dvp_status 上报的工具清单与版本同注册、
 *  随包 package.json 一致。客户端模块依赖浏览器端原语，规则直接测纯函数，结构按源码合同锁定。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { entryApplies } from '../src/client/entry-visibility.js';
import * as Plugin from '../src/index.ts';

const root = new URL('../', import.meta.url);
const client = readFileSync(new URL('src/client/index.ts', root), 'utf8');
const host = readFileSync(new URL('src/index.ts', root), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  version: string;
  exports: Record<string, string>;
  dsh?: { client?: unknown };
};
const application = JSON.parse(readFileSync(new URL('application.json', root), 'utf8')) as { appId: string };

/** Every tool the host registers, in registration order. */
const registered = [...host.matchAll(/ctx\.tools\.register\(\s*defineTool\(\{\s*name: '(dm_dvp_[a-z_]+)'/g)]
  .map((match) => match[1] ?? '');
const statusBlock = host.slice(host.indexOf("name: 'dm_dvp_status'"), host.indexOf("name: 'dm_dvp_overview'"));
const statusTools = [...statusBlock.slice(statusBlock.indexOf('tools: ['), statusBlock.indexOf(']', statusBlock.indexOf('tools: [')))
  .matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
const skill = host.slice(host.indexOf('const SKILL_CONTENT'), host.indexOf('export function apply'));

test('the entry shows without a bound application, for its own application, and hides for another one', () => {
  const dvp = { appId: 'ec.dvp', appVersion: '0.3.9', displayName: 'DVP 数据核查计划' };
  assert.equal(entryApplies(null, 'ec.dvp'), true, 'a history or standalone conversation has no bound application');
  assert.equal(entryApplies(undefined, 'ec.dvp'), true, 'outside the workbench the platform fact does not exist');
  assert.equal(entryApplies(dvp, 'ec.dvp'), true, 'a DVP Work keeps the entry');
  assert.equal(entryApplies({ ...dvp, appVersion: '0.3.8' }, 'ec.dvp'), true, 'another release of the same application is still the same application');
  assert.equal(entryApplies({ appId: 'ec.listing', appVersion: '0.2.4', displayName: 'Listing' }, 'ec.dvp'), false, 'a Listing Work does not show the DVP entry');
});

test('the entry belongs to the application this plugin ships and lives on the composer control list', () => {
  assert.equal(application.appId, 'ec.dvp');
  assert.match(client, /const APPLICATION_ID = 'ec\.dvp';/, 'the client must compare against its own application id');
  assert.match(client, /ctx\.slots\.inject\('conversation\.input\.right', \(\) =>/, 'the entry registers on the public list seat, not on the single-occupant activity seat');
  assert.match(client, /\{\s*name: 'conversation\.input\.right',\s*id: '[a-z0-9.-]+',/, 'a list entry carries a stable id');
  assert.match(client, /locale: 'ecDmDvp'/);
  assert.match(client, /ctx\.locale\.register\('ecDmDvp', \{ zh, en \}\)/, 'interface text goes through the locale in both languages');
  const decision = client.indexOf('if (!entryApplies(application, APPLICATION_ID)) return null;');
  const hooks = [...client.matchAll(/useState[<(]/g)].map((match) => match.index ?? -1);
  assert.ok(decision > 0);
  assert.equal(hooks.length, 1);
  for (const index of hooks) assert.ok(index < decision, 'no hook may follow the conditional return');
});

test('the inserted prompt names only tools that really exist, and names the input capabilities', () => {
  const prompts = [...client.matchAll(/prompt:\s*((?:'[^'\n]*'\s*\+?\s*)+),/g)].map((match) => match[1] ?? '');
  assert.equal(prompts.length, 2, 'one prompt per language (zh, en)');
  for (const prompt of prompts) {
    const named = [...new Set([...prompt.matchAll(/dm_dvp_[a-z_]+/g)].map((match) => match[0]))].sort();
    assert.ok(named.length >= 8);
    for (const name of named) assert.ok(registered.includes(name), `the prompt names ${name}, which the host does not register`);
    for (const required of ['dm_dvp_scan', 'dm_dvp_read_workbook', 'dm_dvp_read_protocol', 'dm_dvp_overview', 'dm_dvp_parse_workbook', 'dm_dvp_write_workbook']) {
      assert.ok(named.includes(required), `the prompt must name ${required}`);
    }
    assert.match(prompt, /CANDIDATE/, 'the prompt keeps the candidate discipline');
  }
});

test('dm_dvp_status reports exactly the registered tools and the shipped version', () => {
  // Every tool except the status tool itself: the list is what a caller can use, not a self-reference.
  const usable = registered.filter((name) => name !== 'dm_dvp_status');
  assert.ok(usable.length >= 13, `expected the host to register its tools, found ${usable.length}`);
  assert.equal(new Set(registered).size, registered.length, 'no tool is registered twice');
  assert.equal([...statusTools].sort().join(','), [...usable].sort().join(','), 'the status tool list is the registration list');
  assert.equal(Plugin.DVP_PLUGIN_VERSION, pkg.version, 'the reported version follows package.json');
  assert.match(statusBlock, /version: DVP_PLUGIN_VERSION,/, 'status must not carry a hand-written copy of the version');
});

test('the skill text describes the input capabilities together with their boundaries (selected per deployment data-boundary mode)', () => {
  assert.match(skill, /dm_dvp_scan/, 'directory discovery is part of the advertised capabilities');
  assert.match(skill, /dm_dvp_read_workbook/, 'non-template workbook reading is part of the advertised capabilities');
  // 边界文案随部署模式在注册时选定（data-boundary.ts）：skill 引用片段，两种文案都在源码里定义
  assert.match(skill, /\$\{SKILL_BOUNDARY_READ\}/, 'the generic reader boundary is selected per data-boundary mode');
  assert.match(skill, /\$\{SKILL_BOUNDARY_SECTION\}/, 'the boundary section is selected per data-boundary mode');
  assert.match(host, /DVP 模板工作簿不能用该工具/, 'redacted deployments keep the template refusal');
  assert.match(host, /Cover \/ Approval 的 sheet 都不读/, 'redacted deployments keep the name boundary');
  assert.match(host, /本部署为全量模式/, 'full deployments announce full access');
  assert.match(skill, /\.xls（二进制）不能直接读取/, 'the legacy-format limit is announced');
});

test('the package ships the browser half the web shell loads', () => {
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(JSON.stringify(pkg.dsh?.client), JSON.stringify({ platform: 'web' }));
});
