import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPARISON_CONTRACT_VERSION, DEFAULT_CMP_KEY_CANDIDATES, CMP_SEQ_COLUMN,
  deriveComparisonKeyPlans, assignComparisonSeq, countDuplicateKeys, comparisonReadiness,
} from '../src/comparison.ts';
import { batchComparisonMethods, BATCH_COMPARISON_METHODS_VERSION } from '../src/comparison-methods.ts';
import { listingSeeds, LISTING_SEED_VERSION } from '../src/knowledge-seeds.ts';
import { comparisonMethodSuite, listingMethodSuites } from '../src/knowledge-validators.ts';
import { normalizeDraft, digest } from '../../../packages/platform-knowledge/src/schema.ts';

test('contract constants are exported and stable',()=>{
  assert.equal(COMPARISON_CONTRACT_VERSION,'batch-comparison-v1');
  assert.deepEqual([...DEFAULT_CMP_KEY_CANDIDATES],['SUBJID','RECORDID','SUBTRID','CSN']);
  assert.equal(CMP_SEQ_COLUMN,'CmpRowSeq');
});

test('key plans take the max common candidate subset of both sides in candidate order',()=>{
  const plans=deriveComparisonKeyPlans(
    {AE:['SUBJID','CSN','TERM'],SV:['SUBJID','VISIT']},
    {AE:['SUBJID','CSN'],SV:['VISIT','SITEID']},
  );
  assert.deepEqual(plans[0],{listing:'AE',baseKeys:['SUBJID','CSN'],fullKey:['SUBJID','CSN','CmpRowSeq'],source:'common-candidates'});
  // SV 两侧无公共候选键（新版只有 SUBJID，旧版没有）→ 回退新版受试者键。
  assert.deepEqual(plans[1],{listing:'SV',baseKeys:['SUBJID'],fullKey:['SUBJID','CmpRowSeq'],source:'fallback-subject'});
});

test('key plan degrades to subject fallback then positional, never throwing',()=>{
  const plans=deriveComparisonKeyPlans({X:['A','B'],Y:['SUBJID']},{X:['A','C']});
  assert.deepEqual(plans[0],{listing:'X',baseKeys:[],fullKey:['CmpRowSeq'],source:'positional'});
  assert.deepEqual(plans[1],{listing:'Y',baseKeys:['SUBJID'],fullKey:['SUBJID','CmpRowSeq'],source:'fallback-subject'});
});

test('empty side column lists do not crash and yield positional pairing',()=>{
  const plans=deriveComparisonKeyPlans({A:[]},{A:['SUBJID']});
  assert.equal(plans[0].source,'positional');
  assert.deepEqual(plans[0].fullKey,['CmpRowSeq']);
});

test('sequence numbers groups per base key starting at 1 and keeps twin rows distinct',()=>{
  const rows=[
    {SUBJID:'S1',RECORDID:'R1',V:'a'},{SUBJID:'S1',RECORDID:'R1',V:'b'},
    {SUBJID:'S1',RECORDID:'R2',V:'c'},
  ];
  const seq=assignComparisonSeq(rows,['SUBJID','RECORDID']);
  assert.deepEqual(seq,[1,2,1]);
});

test('missing key columns in a row are treated as NA text, not a crash',()=>{
  const seq=assignComparisonSeq([{SUBJID:'S1'},{RECORDID:'R1'}],['SUBJID','RECORDID']);
  assert.deepEqual(seq,[1,1]);
});

test('duplicate full keys abort with a positive duplicate count',()=>{
  const dup=countDuplicateKeys(
    [{SUBJID:'S1',RECORDID:'R1'},{SUBJID:'S1',RECORDID:'R1'},{SUBJID:'S1',RECORDID:'R2'}],
    ['SUBJID','RECORDID']);
  assert.equal(dup,1);
  const unique=countDuplicateKeys(
    [{SUBJID:'S1',RECORDID:'R1',CmpRowSeq:1},{SUBJID:'S1',RECORDID:'R1',CmpRowSeq:2}],
    ['SUBJID','RECORDID','CmpRowSeq']);
  assert.equal(unique,0);
});

test('readiness: missing baseline or engine skips, main listing never affected',()=>{
  assert.deepEqual(comparisonReadiness(false,true),{action:'SKIP',reason:'BASELINE_MISSING_FIRST_DELIVERY',mainListingAffected:false});
  assert.deepEqual(comparisonReadiness(true,false),{action:'SKIP',reason:'ENGINE_UNAVAILABLE',mainListingAffected:false});
  assert.deepEqual(comparisonReadiness(true,true),{action:'PRODUCE',reason:'BASELINE_AND_ENGINE_READY',mainListingAffected:false});
  // 空表不得改变就绪判定：空表单正常占位，不是错误。
  assert.equal(comparisonReadiness(true,true).mainListingAffected,false);
});

test('methods body carries the self-contained delivery contract and incident-derived rules',()=>{
  assert.match(BATCH_COMPARISON_METHODS_VERSION,/^2026\./);
  for(const required of ['单文件自包含','CmpRowSeq','占位','空表','object \'SUBJID\' not found','指纹','跨环境',
    // 2026-11-23 收口：引擎线索、退出码不证明比对件、三行日志核对口径、xlsx 占用。
    'Rcompare','compare_data','退出码','基线加载','未找到旧版','比对件生成失败','被占用',
    // 2026-11-24 集成错误复盘：展示契约与喂包命名、R 陷阱、验证须跑实装本体、安全网自证。
    'form_name','colnames','%in%','c()','list(l =','实装','subscript out of bounds','静默失效'])
    assert(batchComparisonMethods.includes(required),required);
  assert(batchComparisonMethods.includes('当前 spec')); // 项目裁定优先
});

test('comparison seed is registered with claims bound to the installed suite',()=>{
  const seed=listingSeeds.find(s=>s.knowledgeId==='dm-listing.batch-comparison.methods');
  assert.ok(seed);
  assert.equal(seed.claims?.length,5);
  const coverage=comparisonMethodSuite.coverage?.[0];
  assert.ok(coverage);
  const contentDigest=digest(normalizeDraft(seed));
  // 套件绑定的候选摘要必须与该种子声明的摘要一致，否则激活时被拒（CONTENT_BINDING_MISMATCH）。
  assert.equal(coverage.candidateDigest,contentDigest);
  assert.deepEqual(coverage.claims,[...seed.claims??[]]);
  assert.deepEqual([...new Set(comparisonMethodSuite.cases.map(c=>c.group))].sort(),['boundary','negative','positive']);
  assert.equal(listingMethodSuites.length,2);
  assert.equal(LISTING_SEED_VERSION,'2026.11.24.1');
});