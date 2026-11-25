/** 员工入口（客户端）合同（2026-11-24）：入口按"当前会话所属应用"显隐，且 Listing 的全部场景模式
 *  （Manual / Medical / PK / Report，PK 再分 BE / SAD-MAD）保持可选并进入插入的提示词。
 *  客户端模块依赖浏览器端原语，这里只直接测纯规则；组件结构按源码合同锁定。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { entryApplies } from '../src/client/entry-visibility.js';

const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8');
const application = JSON.parse(readFileSync(new URL('../application.json', import.meta.url), 'utf8')) as {
  appId: string;
  listingTypes: string[];
};

test('the entry is owned by the application this plugin ships', () => {
  assert.equal(application.appId, 'ec.listing');
  assert.match(source, /const APPLICATION_ID = 'ec\.listing';/, 'the client must compare against its own application id');
});

test('the entry shows without a bound application, for its own application, and hides for another one', () => {
  const listing = { appId: 'ec.listing', appVersion: '0.2.4', displayName: 'Listing' };
  assert.equal(entryApplies(null, 'ec.listing'), true, 'a history or standalone conversation has no bound application');
  assert.equal(entryApplies(undefined, 'ec.listing'), true, 'outside the workbench the platform fact does not exist');
  assert.equal(entryApplies(listing, 'ec.listing'), true, 'a Listing Work keeps the entry');
  assert.equal(entryApplies({ ...listing, appVersion: '0.2.3' }, 'ec.listing'), true, 'another release of the same application is still the same application');
  assert.equal(entryApplies({ appId: 'ec.dvp', appVersion: '0.3.9', displayName: 'DVP' }, 'ec.listing'), false, 'a DVP Work does not show the Listing entry');
  assert.match(source, /if \(!entryApplies\(application, APPLICATION_ID\)\) return null;/, 'the component decides through the tested rule');
});

test('every declared Listing mode stays selectable and reaches the inserted prompt', () => {
  // application.json declares the employee-facing modes; the dialog must offer exactly those.
  assert.equal(JSON.stringify(application.listingTypes), JSON.stringify(['Manual', 'Medical', 'PK', 'Report']));
  assert.match(source, /\.\.\.\['medical', 'manual', 'report', 'pk'\]\.map\(\(s\) => h\('option', \{ key: s, value: s \}, s\)\)/, 'the scenario select lists all four modes');
  assert.match(source, /const \[scenario, setScenario\] = useState\('manual'\);/, 'a scenario is selected state, not a fixed prompt');
  // PK has two subtypes; they appear only once PK is chosen and both are offered.
  assert.match(source, /scenario === 'pk'\s*\?\s*h\(\s*'label',\s*null,\s*t\('subtype'\),/, 'the PK subtype select follows the scenario choice');
  assert.match(source, /h\('option', \{ value: 'be' \}, 'BE'\),\s*h\('option', \{ value: 'sad-mad' \}, 'SAD\/MAD'\),/, 'both PK subtypes are offered');
  // The inserted task names the chosen mode, and the PK subtype only for PK.
  assert.match(
    source,
    /请加载 dm-listing 技能处理 \$\{scenario\}\$\{scenario === 'pk' \? ' \(' \+ pkType \+ '\)' : ''\} Listing。/,
    'the inserted prompt carries the selected mode',
  );
});

test('the conditional return comes after every hook, so the hook order never depends on the application', () => {
  const decision = source.indexOf('if (!entryApplies(application, APPLICATION_ID)) return null;');
  const hooks = [...source.matchAll(/useState[<(]/g)].map((match) => match.index ?? -1);
  assert.equal(hooks.length, 4, 'span, scenario, PK subtype and stale state');
  for (const index of hooks) assert.ok(index < decision, 'no hook may follow the conditional return');
});
