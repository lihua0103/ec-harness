import {test} from 'node:test';
import assert from 'node:assert/strict';
import {manualMethods,suggestManualColumnRoles,MANUAL_METHODS_VERSION} from '../src/manual-methods.ts';
import {clinicalMethods,listingWorkflow} from '../src/knowledge.ts';
test('manual title hints distinguish source/scope/row/column/review/output and preserve every original header',()=>{
  const headers=['Listing Seq.','Form\nName','Visits Applied To','Related Fields','Condition ( For internal use)',
    'Column Heading (For internal use)','Report Description','Discrepancy Text Message','Output Format','Unknown business annotation'];
  const result=suggestManualColumnRoles(headers);
  assert.deepEqual(result.map(r=>r.header),headers);assert.deepEqual(result.map(r=>r.index),headers.map((_,i)=>i));
  assert(result[1].roles.includes('source'));assert(result[2].roles.includes('scope'));assert(result[3].roles.includes('scope'));
  assert(result[4].roles.includes('row-or-derivation'));assert(result[5].roles.includes('output-columns'));
  assert(result[6].roles.includes('review-description'));assert(result[7].roles.includes('review-description'));
  assert(result[8].roles.includes('delivery'));assert.deepEqual(result[9].roles,['interpret-from-content']);
});
test('Chinese and combined headings retain multiple non-authoritative roles, not fixed six-column schema',()=>{
  const hints=suggestManualColumnRoles(['数据来源/表单名称','适用访视','行条件/输出列','输出方式及排序','备注/未知要求']);
  assert(hints[0].roles.includes('source'));assert(hints[1].roles.includes('scope'));
  assert.deepEqual(hints[2].roles,['row-or-derivation','output-columns']);assert(hints[3].roles.includes('delivery'));
  assert(hints[4].roles.includes('context'));assert.equal(suggestManualColumnRoles([]).length,0);
});
test('registered method text contains correction distinctions without carrying old security or project defaults',()=>{
  assert.match(MANUAL_METHODS_VERSION,/^2026\./);
  for(const required of ['Output if','flag=duplicated','Column Heading','Report Description','NA','class/label','单文件自包含'])assert(manualMethods.includes(required),required);
  assert(manualMethods.includes('不属于所有Manual项目默认'));assert(manualMethods.includes('当前spec'));
  // 2026-11-23 批次比对备忘：占位FLAG与空表守卫进入方法与反例。
  assert(manualMethods.includes('(vs旧批次)'));assert(manualMethods.includes("object 'SUBJID' not found"));
  assert(manualMethods.includes('被占用'));
  assert(listingWorkflow.includes('dm-listing-manual-methods'));assert(listingWorkflow.includes('(vs旧批次)'));assert(listingWorkflow.includes('退出码'));
  assert(clinicalMethods.includes('Cover也可按需读取'));assert(!listingWorkflow.includes('Cover 内容禁读'));
});
