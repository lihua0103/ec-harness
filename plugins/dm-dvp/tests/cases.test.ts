import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestCases } from '../src/cases.js';
import type { CrossFieldRule } from '../src/rules.js';

const rule = (overrides: Partial<CrossFieldRule> = {}): CrossFieldRule => ({
  id: 'T-001', changeMark: null, visits: 'V1', formName: 'LB', targetField: 'LBVALUE',
  relatedFields: [], queryType: 'Range', discrepancyText: 'Value out of range.', logic: '', issues: [],
  ...overrides,
});

test('Range 严格大于：正/恰边界/反三候选', () => {
  const result = suggestCases([rule({ logic: 'fire when LB Value > 10' })]);
  const candidates = result.reports[0].candidates;
  assert.equal(candidates.length, 3);
  const byName = new Map(candidates.map((c) => [c.caseName, c]));
  assert.equal(byName.get('ABOVE_THRESHOLD_TRIGGER')?.assignments[0].value, '11');
  assert.equal(byName.get('AT_BOUNDARY_NO_TRIGGER')?.kind, 'boundary');
  assert.equal(byName.get('AT_BOUNDARY_NO_TRIGGER')?.assignments[0].value, '10');
  assert.equal(byName.get('BELOW_THRESHOLD_NO_TRIGGER')?.assignments[0].value, '9');
  assert.ok(candidates.every((c) => c.confidence === 'structural'));
});

test('Range 含边界 >=：边界值本身是正例', () => {
  const result = suggestCases([rule({ logic: 'fire when LB Value >= 5' })]);
  const candidates = result.reports[0].candidates;
  assert.equal(candidates[0].caseName, 'AT_THRESHOLD_TRIGGER');
  assert.equal(candidates[0].assignments[0].value, '5');
  assert.equal(candidates[1].caseName, 'BELOW_THRESHOLD_NO_TRIGGER');
  assert.equal(candidates[1].assignments[0].value, '4');
});

test('Missing：缺失触发 + 有值不触发', () => {
  const result = suggestCases([rule({ queryType: 'Missing', logic: 'fire when DMSTDTC is missing' })]);
  const [positive, negative] = result.reports[0].candidates;
  assert.equal(positive.kind, 'positive');
  assert.equal(positive.assignments[0].value, '(留空)');
  assert.equal(negative.kind, 'negative');
});

test('字段对比较：结构化识别但取值待项目数据（unresolved + structural）', () => {
  const result = suggestCases([rule({ queryType: 'Date', logic: 'fire when AE Start Date > AE End Date' })]);
  const candidate = result.reports[0].candidates[0];
  assert.equal(candidate.caseName, 'FIELD_PAIR_NEEDS_PROJECT_DATA');
  assert.equal(candidate.kind, 'unresolved');
  assert.equal(candidate.confidence, 'structural');
  assert.equal(candidate.assignments.length, 2);
  assert.deepEqual(candidate.assignments.map((a) => a.field), ['AE Start Date', 'AE End Date']);
});

test('freeform 逻辑：CUSTOM_REQUIRES_MANUAL_CASES，不硬造用例', () => {
  const result = suggestCases([rule({ queryType: 'Custom', logic: 'fire when review the pattern manually' })]);
  const candidate = result.reports[0].candidates[0];
  assert.equal(result.reports[0].logicStatus, 'freeform');
  assert.equal(candidate.caseName, 'CUSTOM_REQUIRES_MANUAL_CASES');
  assert.equal(candidate.kind, 'unresolved');
  assert.equal(candidate.confidence, 'heuristic');
});

test('缺 Logic：NO_LOGIC_PROVIDED', () => {
  const result = suggestCases([rule({ logic: '' })]);
  assert.equal(result.reports[0].logicStatus, 'absent');
  assert.equal(result.reports[0].candidates[0].caseName, 'NO_LOGIC_PROVIDED');
});

test('复合 AND/OR/NOT：不拆成单比较候选，返回整规则 unresolved', () => {
  for (const logic of ['fire when A > 1 AND B < 5', 'fire when A > 1 OR B < 5', 'fire when NOT (Age > 17)']) {
    const result = suggestCases([rule({ logic })]);
    assert.equal(result.reports[0].candidates.length, 1, logic);
    const candidate = result.reports[0].candidates[0];
    assert.equal(candidate.kind, 'unresolved', logic);
    assert.equal(candidate.caseName, 'COMPOSITE_LOGIC_NEEDS_WHOLE_RULE_CASES', logic);
    assert.deepEqual(candidate.assignments, [], logic);
  }
});

test('totals 与固定纪律声明', () => {
  const result = suggestCases([
    rule({ id: 'R1', logic: 'fire when V > 1' }),
    rule({ id: 'R2', queryType: 'Custom', logic: 'fire when manual check' }),
  ]);
  assert.equal(result.totals.rules, 2);
  assert.equal(result.totals.unresolved, 1);
  assert.ok(result.notices.some((notice) => notice.includes('CANDIDATE')));
  assert.ok(result.notices.some((notice) => notice.includes('复合 AND/OR/NOT')));
});
