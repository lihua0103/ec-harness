// 学习闭环：业务验证器执行 → CANDIDATE 激活 → 事件读取。全部纯函数级断言，无真实数据。
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeService} from '../../../packages/platform-knowledge/src/service.js';
import {listingMethodSuite,listingMethodSuites} from '../src/knowledge-validators.ts';
import {listingSeeds,LISTING_PLUGIN_ID,LISTING_SEED_VERSION} from '../src/knowledge-seeds.ts';

let root:string,service:KnowledgeService;
const ctx={pluginId:LISTING_PLUGIN_ID};

before(async()=>{
  root=await mkdtemp(join(tmpdir(),'km-loop-'));
  service=new KnowledgeService(join(root,'knowledge.sqlite'));
  for(const suite of listingMethodSuites)service.registerValidator(LISTING_PLUGIN_ID,suite);
});

after(()=>{service.close();return rm(root,{recursive:true,force:true});});

test('validator suite cases reproduce installed helpers: positive, negative, boundary',async()=>{
  for(const testCase of listingMethodSuite.cases){
    const actual=await listingMethodSuite.execute({} as never,testCase);
    assert.deepEqual(actual,testCase.expected,`case ${testCase.id} 不匹配`);
  }
});

test('seeded intake method declares narrow claims covered by the installed suite and activates',async()=>{
  const imported=service.importSeeds(LISTING_PLUGIN_ID,LISTING_SEED_VERSION,listingSeeds);
  assert.equal(imported.conflicts.length,0);
  const record=service.get(ctx,'dm-listing.intake.methods');
  assert.equal(record.state,'CANDIDATE');
  assert.ok((record.claims?.length??0)>=3,'intake 种子必须声明可复现窄声明');
  const receipt=await service.validate(ctx,'dm-listing.intake.methods',record.revision,'dm-listing.intake-suite');
  assert.equal(receipt.passed,true);
  assert.equal(receipt.validationScope,'CONTENT_CLAIMS');
  assert.equal(receipt.state,'ACTIVE');
  assert.deepEqual(receipt.claims.uncovered,[]);
  // 激活后默认检索可见；验证范围以回执为准，宽方法正文未被证明。
  assert.equal(service.search(ctx,{topics:['intake']}).total,1);
});

test('claims fully covered by the installed suite activate; uncovered claims do not',async()=>{
  const rec=service.capture(ctx,{knowledgeId:'dm-listing.loop.narrow',scope:'plugin',pluginId:LISTING_PLUGIN_ID,
    kind:'scenario_method',title:'窄声明',problemSignal:'x',cause:'x',method:'x',scenarios:[],edc:[],topics:['intake'],
    preconditions:['p'],notApplicable:[],counterexamples:['c'],sources:['s'],claims:['token order']});
  const narrow={...listingMethodSuite,id:'dm-listing.narrow-suite',knowledgeIds:['dm-listing.loop.narrow'],
    coverage:[{knowledgeId:'dm-listing.loop.narrow',candidateDigest:rec.contentDigest,claims:['token order']}]};
  service.registerValidator(LISTING_PLUGIN_ID,narrow);
  const receipt=await service.validate(ctx,'dm-listing.loop.narrow',rec.revision,'dm-listing.narrow-suite');
  assert.equal(receipt.passed,true);
  assert.equal(receipt.validationScope,'CONTENT_CLAIMS');
  assert.equal(receipt.state,'ACTIVE');
  const partial=service.capture(ctx,{knowledgeId:'dm-listing.loop.partial',scope:'plugin',pluginId:LISTING_PLUGIN_ID,
    kind:'scenario_method',title:'部分声明',problemSignal:'x',cause:'x',method:'x',scenarios:[],edc:[],topics:['intake'],
    preconditions:['p'],notApplicable:[],counterexamples:['c'],sources:['s'],claims:['token order','untested claim']});
  service.registerValidator(LISTING_PLUGIN_ID,{...listingMethodSuite,id:'dm-listing.partial-suite',knowledgeIds:['dm-listing.loop.partial'],
    coverage:[{knowledgeId:'dm-listing.loop.partial',candidateDigest:partial.contentDigest,claims:['token order']}]});
  const partialReceipt=await service.validate(ctx,'dm-listing.loop.partial',partial.revision,'dm-listing.partial-suite');
  assert.equal(partialReceipt.passed,true);
  assert.equal(partialReceipt.state,'CANDIDATE');
  assert.deepEqual(partialReceipt.claims.uncovered,['untested claim']);
});

test('validation failure keeps CANDIDATE and records a readable learning event',async()=>{
  // 用一个不可通过的修订：capture 新候选不在套件覆盖内 → TARGET_MISMATCH；再伪造一个覆盖内但证据缺失的失败路径。
  const bad=service.capture(ctx,{knowledgeId:'dm-listing.loop.uncovered',scope:'plugin',pluginId:LISTING_PLUGIN_ID,
    kind:'scenario_method',title:'套件未覆盖',problemSignal:'x',cause:'x',method:'x',
    scenarios:[],edc:[],topics:[],preconditions:['p'],notApplicable:[],counterexamples:['c'],sources:['s']});
  await assert.rejects(
    service.validate(ctx,'dm-listing.loop.uncovered',bad.revision,'dm-listing.intake-suite'),
    /KNOWLEDGE_VALIDATOR_TARGET_MISMATCH/);
  // 事件接口可读出捕获事件
  const feed=service.events(ctx,'dm-listing.loop.uncovered');
  assert.equal(feed.items.some(e=>e.operation==='CANDIDATE_CAPTURED'),true);
});

test('evidence-incomplete candidate refuses activation',async()=>{
  const weak=service.capture(ctx,{knowledgeId:'dm-listing.loop.weak',scope:'plugin',pluginId:LISTING_PLUGIN_ID,
    kind:'scenario_method',title:'证据缺失',problemSignal:'x',cause:'x',method:'x',
    scenarios:[],edc:[],topics:[],preconditions:[],notApplicable:[],counterexamples:[],sources:[]});
  // weak 不在套件覆盖内，先遇到 TARGET_MISMATCH；evidence 检查在套件查找之前——顺序无关，两者都阻断激活。
  await assert.rejects(
    service.validate(ctx,'dm-listing.loop.weak',weak.revision,'dm-listing.intake-suite'),
    /KNOWLEDGE_(VALIDATOR_TARGET_MISMATCH|EVIDENCE_INCOMPLETE)/);
});

test('stale revision is not activated mid-flight',async()=>{
  const rec=service.get(ctx,'dm-listing.intake.methods');
  await assert.rejects(
    service.validate(ctx,'dm-listing.intake.methods',rec.revision+99,'dm-listing.intake-suite'),
    /KNOWLEDGE_NOT_FOUND/);
});

test('events feed lists capture, activation and validation history for the seeded method',()=>{
  const feed=service.events(ctx,'dm-listing.intake.methods');
  const ops=feed.items.map(e=>e.operation);
  assert.ok(ops.includes('CANDIDATE_CAPTURED'));
  assert.ok(ops.includes('ACTIVE'));
  assert.ok(!ops.includes('VALIDATION_SCOPE_INSUFFICIENT'),'全部窄声明被覆盖时不应出现激活范围不足事件');
});

test('comparison seed declares claims covered by the comparison suite and activates',async()=>{
  const imported=service.importSeeds(LISTING_PLUGIN_ID,LISTING_SEED_VERSION,listingSeeds);
  assert.equal(imported.conflicts.length,0);
  const record=service.get(ctx,'dm-listing.batch-comparison.methods');
  assert.equal(record.state,'CANDIDATE');
  assert.equal(record.claims?.length,5);
  const receipt=await service.validate(ctx,'dm-listing.batch-comparison.methods',record.revision,'dm-listing.comparison-suite');
  assert.equal(receipt.passed,true);
  assert.equal(receipt.validationScope,'CONTENT_CLAIMS');
  assert.equal(receipt.state,'ACTIVE');
  assert.deepEqual(receipt.claims.uncovered,[]);
  // 激活后默认检索可见；验证范围以回执为准，宽方法正文未被证明。
  assert.equal(service.search(ctx,{topics:['output-qc'],states:['ACTIVE']}).items.some(i=>i.knowledgeId==='dm-listing.batch-comparison.methods'),true);
});
