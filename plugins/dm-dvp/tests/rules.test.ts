import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChangeMark, parseBool, splitList, validateCrossFieldRule, withLogicParse,
  parseRulesJson, coerceRuleInput, RulesInputError, validateDynamic, DYNAMIC_TYPES,
  type CrossFieldRule, type DynamicSpec,
} from '../src/rules.js';

const baseRule = (): CrossFieldRule => ({
  id: 'EC-001', changeMark: null, visits: 'V1', formName: 'AE', targetField: 'AESTDT',
  relatedFields: ['AEENDT'], queryType: 'Date', discrepancyText: 'Start date precedes end date.',
  logic: 'fire when AESTDT > AEENDT', issues: [],
});

test('parseChangeMark：动作/版本与裸版本', () => {
  assert.deepEqual(parseChangeMark('Add/V2.0'), { action: 'Add', version: 'V2.0' });
  assert.deepEqual(parseChangeMark('Delete/V1.0'), { action: 'Delete', version: 'V1.0' });
  assert.deepEqual(parseChangeMark('V2.1'), { action: 'Update', version: 'V2.1' });
  assert.equal(parseChangeMark(''), null);
  assert.equal(parseChangeMark('Foo/1'), null);
});

test('parseBool：模板布尔写法', () => {
  for (const value of ['TRUE', 'true', '1', 'Yes']) assert.equal(parseBool(value), true, value);
  for (const value of ['FALSE', 'false', '0', 'No']) assert.equal(parseBool(value), false, value);
  assert.equal(parseBool(''), null);
  assert.equal(parseBool('maybe'), null);
});

test('splitList：换行/分号/逗号，不按斜杠拆', () => {
  assert.deepEqual(splitList('A, B\nC;D'), ['A', 'B', 'C', 'D']);
  assert.deepEqual(splitList('Headache/Fever'), ['Headache/Fever']);
  assert.deepEqual(splitList(''), []);
});

test('validateCrossFieldRule：完整规则无 issue，缺列逐项报', () => {
  assert.deepEqual(validateCrossFieldRule(baseRule()), []);
  const empty = validateCrossFieldRule({ ...baseRule(), id: '', formName: '', targetField: '', queryType: '', discrepancyText: '', logic: '' });
  for (const expected of ['MISSING_UNIQUE_ID', 'MISSING_FORM_NAME', 'MISSING_TARGET_FIELD', 'QUERY_TYPE_UNRECOGNIZED:(empty)', 'MISSING_DISCREPANCY_TEXT', 'MISSING_LOGIC']) {
    assert.ok(empty.includes(expected), expected);
  }
  const numeric = validateCrossFieldRule({ ...baseRule(), queryType: 'Numeric' });
  assert.ok(numeric.includes('QUERY_TYPE_UNRECOGNIZED:Numeric'));
});

test('withLogicParse：合并 LOGIC 诊断前缀', () => {
  const enriched = withLogicParse({ ...baseRule(), logic: 'fire when please check dates carefully' });
  assert.equal(enriched.logicParse?.status, 'freeform');
  assert.ok(enriched.issues.some((issue) => issue.startsWith('LOGIC:')));
  // 原 issues 保留
  const withPreexisting = withLogicParse({ ...baseRule(), issues: ['MISSING_TARGET_FIELD'] });
  assert.ok(withPreexisting.issues.includes('MISSING_TARGET_FIELD'));
});

test('coerceRuleInput：宽容归一 + 拒绝非对象', () => {
  const rule = coerceRuleInput({ id: 'R1', changeMark: 'Add/V2.0', queryType: 'Range', relatedFields: 'A,B', logic: 'fire when V > 1' });
  assert.deepEqual(rule.changeMark, { action: 'Add', version: 'V2.0' });
  assert.deepEqual(rule.relatedFields, ['A', 'B']);
  assert.throws(() => coerceRuleInput('nope'), (error: unknown) => error instanceof RulesInputError && error.code === 'RULE_NOT_OBJECT');
  // 未知动作不抛错：降级为 null（诊断层负责提示），与 parseChangeMark('Foo/1') 行为一致。
  assert.deepEqual(coerceRuleInput({ changeMark: { action: 'Move', version: '1' } }).changeMark, null);
});

test('withLogicParse：完整校验必填项并去重已有诊断', () => {
  const incomplete = coerceRuleInput({});
  const enriched = withLogicParse(incomplete);
  for (const expected of ['MISSING_UNIQUE_ID', 'MISSING_FORM_NAME', 'MISSING_TARGET_FIELD', 'QUERY_TYPE_UNRECOGNIZED:(empty)', 'MISSING_DISCREPANCY_TEXT', 'MISSING_LOGIC']) {
    assert.ok(enriched.issues.includes(expected), expected);
  }
  const duplicate = withLogicParse({ ...baseRule(), issues: ['MISSING_FORM_NAME', 'MISSING_FORM_NAME'] });
  assert.equal(duplicate.issues.filter((issue) => issue === 'MISSING_FORM_NAME').length, 1);
});

test('parseRulesJson：数组与 {crossField} 两种形态，垃圾输入显式报错', () => {
  const asArray = parseRulesJson('[{"id":"R1","queryType":"Date"}]');
  assert.equal(asArray.length, 1);
  assert.equal(asArray[0].id, 'R1');
  assert.ok(asArray[0].issues.includes('MISSING_FORM_NAME'));
  const asObject = parseRulesJson('{"crossField":[{"id":"R2"}]}');
  assert.equal(asObject.length, 1);
  assert.equal(asObject[0].id, 'R2');
  assert.throws(() => parseRulesJson('{"x":1}'), (error: unknown) => error instanceof RulesInputError && error.code === 'RULES_SHAPE_UNSUPPORTED');
  assert.throws(() => parseRulesJson('not json'), (error: unknown) => error instanceof RulesInputError && error.code === 'INVALID_RULES_JSON');
  assert.throws(() => parseRulesJson('"' + 'x'.repeat(1_000_001) + '"'), (error: unknown) => error instanceof RulesInputError && error.code === 'RULES_PAYLOAD_TOO_LARGE');
});

const baseDynamic = (): DynamicSpec => ({
  id: 'DY-001', changeMark: null, formName: 'VS', fieldName: 'VSPOS', type: 'Dynamic Field',
  visits: 'All', discrepancyText: '', condition: '', issues: [],
});

test('validateDynamic：8 枚举全通过，越枚举/缺项记诊断不硬拒', () => {
  for (const type of DYNAMIC_TYPES) {
    assert.deepEqual(validateDynamic({ ...baseDynamic(), type }), [], `合法枚举 ${type} 不应带诊断`);
  }
  assert.ok(validateDynamic({ ...baseDynamic(), type: 'Require' }).includes('DYNAMIC_TYPE_UNRECOGNIZED:Require'));
  assert.ok(validateDynamic({ ...baseDynamic(), type: 'Show' }).includes('DYNAMIC_TYPE_UNRECOGNIZED:Show'));
  assert.ok(validateDynamic({ ...baseDynamic(), type: '' }).includes('MISSING_TYPE'));
  assert.ok(validateDynamic({ ...baseDynamic(), id: '' }).includes('MISSING_UNIQUE_ID'));
  // 大小写/拼写漂移不静默归一，如实上报（与 Query Type 对称）。
  assert.ok(validateDynamic({ ...baseDynamic(), type: 'dynamic field' }).includes('DYNAMIC_TYPE_UNRECOGNIZED:dynamic field'));
});
