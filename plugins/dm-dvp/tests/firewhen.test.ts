import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLogic, collectComparisons } from '../src/firewhen.js';

test('structured：多词字段名 + 比较 + AND', () => {
  const result = parseLogic('fire when AE Start Date > AE End Date AND Age > 17');
  assert.equal(result.status, 'structured');
  assert.deepEqual(result.fields, ['AE Start Date', 'AE End Date', 'Age']);
  const comparisons = collectComparisons(result.ast!);
  assert.equal(comparisons.length, 2);
  assert.equal(comparisons[0].left.kind, 'field');
  assert.equal(comparisons[0].op, '>');
});

test('structured：is missing / is not missing 归一为 NULL 比较', () => {
  const missing = parseLogic('fire when DMSTDTC is missing');
  assert.equal(missing.status, 'structured');
  const [first] = collectComparisons(missing.ast!);
  assert.equal(first.op, '=');
  assert.equal(first.right?.kind, 'null');

  const populated = parseLogic('fire when AETERM is not missing AND AESTDT is not missing');
  assert.equal(populated.status, 'structured');
  assert.equal(collectComparisons(populated.ast!).every((c) => c.op === '!=' && c.right?.kind === 'null'), true);
});

test('structured：x not null、大小写不敏感、无空格紧排', () => {
  const notNull = parseLogic('fire when LBRES not null');
  assert.equal(notNull.status, 'structured');
  const [comparison] = collectComparisons(notNull.ast!);
  assert.equal(comparison.op, '!=');

  const tight = parseLogic('FIRE WHEN age>=18 and weight<90');
  assert.equal(tight.status, 'structured');
  assert.deepEqual(collectComparisons(tight.ast!).map((c) => (c.left.kind === 'field' ? c.left.text : '?')), ['age', 'weight']);
});

test('structured：引号字符串与括号组、NOT (...)', () => {
  const quoted = parseLogic('fire when SEX = "F"');
  assert.equal(quoted.status, 'structured');
  const [comparison] = collectComparisons(quoted.ast!);
  assert.equal(comparison.right?.kind, 'string');
  assert.equal(comparison.right?.text, 'F');

  const grouped = parseLogic('fire when (A > 1 OR B < 2) AND NOT (C = 3)');
  assert.equal(grouped.status, 'structured');
  assert.equal(grouped.ast?.kind, 'logical');
  assert.equal(grouped.ast?.op, 'and');
});

test('字段名 "Not Done"：词首 Not 按字段名处理而非逻辑非', () => {
  const result = parseLogic('fire when Not Done = "Y"');
  assert.equal(result.status, 'structured');
  assert.deepEqual(result.fields, ['Not Done']);
  const [comparison] = collectComparisons(result.ast!);
  assert.equal(comparison.left.kind, 'field');
  assert.equal(comparison.left.kind === 'field' ? comparison.left.text : '', 'Not Done');
});

test('数值 token 保留负号并识别前导小数点', () => {
  for (const [logic, expected] of [['X > -17', '-17'], ['X >= .5', '.5'], ['X < -.25', '-.25']]) {
    const result = parseLogic(`fire when ${logic}`);
    assert.equal(result.status, 'structured', logic);
    const comparison = collectComparisons(result.ast!)[0];
    assert.equal(comparison.right?.kind, 'number', logic);
    assert.equal(comparison.right?.text, expected, logic);
  }
});

test('freeform：叙述式文本降级并给诊断，不硬拒', () => {
  const result = parseLogic('fire when review the date consistency per manual process');
  assert.equal(result.status, 'freeform');
  assert.ok(result.diagnostics.some((d) => d.code === 'NO_COMPARISON'));
});

test('freeform：单字段无比较降级', () => {
  const result = parseLogic('fire when AE Term');
  assert.equal(result.status, 'freeform');
});

test('空逻辑与未闭合引号给出明确诊断', () => {
  assert.equal(parseLogic('   ').diagnostics.some((d) => d.code === 'EMPTY_LOGIC'), true);
  const unclosed = parseLogic('fire when A = "open');
  assert.equal(unclosed.status, 'freeform');
  assert.ok(unclosed.diagnostics.some((d) => d.code === 'UNCLOSED_STRING'));
});
