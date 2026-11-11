import test from 'node:test';
import assert from 'node:assert/strict';
import { renderChecks } from '../src/render.js';
import { coerceRuleInput } from '../src/rules.js';

const rule = (over: Record<string, unknown>) => coerceRuleInput({ id: 'R', queryType: 'Custom', formName: 'F', targetField: 'A', discrepancyText: 'd', ...over });

test('rave-steps：比较步骤与 Rave 算子映射', () => {
  const result = renderChecks([rule({ logic: 'fire when VSRES > 3' })], 'rave-steps');
  assert.equal(result.totals.rendered, 1);
  const [step] = result.rules[0].steps;
  assert.deepEqual(step, { step: 1, joiner: '', variable: 'VSRES', operator: 'GreaterThan', value: 3 });
});

test('rave-steps：AND 链 joiner、无混合标记', () => {
  const result = renderChecks([rule({ logic: 'fire when AE End Date < AE Start Date AND Age > 17 AND Sex = "F"' })], 'rave-steps');
  const steps = result.rules[0].steps;
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((s) => s.joiner), ['', 'And', 'And']);
  assert.equal(steps[0].rightVariable, 'AE Start Date');
  assert.equal(steps[2].operator, 'Equal');
  assert.equal(result.rules[0].warnings.includes('NEEDS_MANUAL_GROUPING'), false);
});

test('rave-steps：AND/OR 混合嵌套标记 NEEDS_MANUAL_GROUPING', () => {
  const result = renderChecks([rule({ logic: 'fire when (A > 1 OR B < 2) AND C = 3' })], 'rave-steps');
  assert.equal(result.totals.flagged, 1);
  assert.equal(result.rules[0].warnings.includes('NEEDS_MANUAL_GROUPING'), true);
});

test('rave-steps：is missing / is not missing → IsMissing / IsPopulated', () => {
  const result = renderChecks([
    rule({ logic: 'fire when DMSTDTC is missing' }),
    rule({ logic: 'fire when AETERM is not missing' }),
  ], 'rave-steps');
  assert.equal(result.rules[0].steps[0].operator, 'IsMissing');
  assert.equal(result.rules[1].steps[0].operator, 'IsPopulated');
});

test('rave-steps：NOT(比较) 翻转算子并留痕', () => {
  const result = renderChecks([rule({ logic: 'fire when NOT (Age > 17)' })], 'rave-steps');
  const [step] = result.rules[0].steps;
  assert.equal(step.operator, 'LessThanOrEqual');
  assert.equal(step.note?.includes('inversion'), true);
});

test('rave-steps：复合 NOT 标记 NEEDS_MANUAL_REWRITE；freeform 不渲染', () => {
  const compound = renderChecks([rule({ logic: 'fire when NOT (A > 1 AND B < 2)' })], 'rave-steps');
  assert.equal(compound.rules[0].warnings.includes('NEEDS_MANUAL_REWRITE'), true);
  assert.equal(compound.rules[0].steps.length, 0);

  const freeform = renderChecks([rule({ logic: 'fire when review per manual process' })], 'rave-steps');
  assert.equal(freeform.rules[0].status, 'freeform');
  assert.equal(freeform.rules[0].warnings.includes('FREEFORM_LOGIC_NOT_RENDERED'), true);
  assert.equal(freeform.totals.freeform, 1);
});

test('generic-expression：结构化给归一化文本，absent 给 NO_LOGIC', () => {
  const structured = renderChecks([rule({ logic: 'FIRE WHEN age>=18 AND weight<90' })], 'generic-expression');
  assert.equal(structured.rules[0].status, 'structured');
  assert.equal(structured.rules[0].expression, 'age>=18 AND weight<90');

  const absent = renderChecks([rule({ logic: '' })], 'rave-steps');
  assert.equal(absent.rules[0].status, 'absent');
  assert.equal(absent.rules[0].warnings.includes('NO_LOGIC_PROVIDED'), true);
  assert.equal(absent.totals.absent, 1);
});

test('totals 汇总与固定 notices', () => {
  const result = renderChecks([
    rule({ logic: 'fire when A > 1' }),
    rule({ logic: 'fire when narrate per manual' }),
    rule({ logic: '' }),
  ], 'rave-steps');
  assert.deepEqual(result.totals, { rules: 3, rendered: 1, freeform: 1, absent: 1, flagged: 0 });
  assert.ok(result.notices.some((n) => n.startsWith('RENDER_REFERENCE_ONLY')));
});
