import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeService} from '../../../packages/platform-knowledge/src/service.ts';
import {type KnowledgeDraft,type ValidationSuite,digest,normalizeDraft} from '../../../packages/platform-knowledge/src/schema.ts';
import {listingSeeds,listingKnowledgeContribution,LISTING_PLUGIN_ID,LISTING_SEED_VERSION} from '../src/knowledge-seeds.ts';
import {METHOD_TOPICS,type MethodTopic} from '../src/scenario-methods.ts';
const context={pluginId:'dm-listing',projectId:'project-a',scenario:'manual'};
function draft(id='duplicate-marker'):KnowledgeDraft {
  return {knowledgeId:id,scope:'plugin',pluginId:'dm-listing',kind:'technical_method',title:'重复标记保留所有行',problemSignal:'标记被当作筛选',cause:'混淆行条件与标记',method:'按明确键标记每个重复成员，不筛除其他行',scenarios:['review'],edc:[],topics:['row-logic'],preconditions:['需求明确要求重复标记'],notApplicable:['仅输出重复行的筛选需求'],counterexamples:['只保留重复行'],sources:['historical-method/manual'],claims:['duplicate marker keeps all rows']};
}
function suite(ids=['duplicate-marker']):ValidationSuite {
  return {id:'duplicate-check',version:'1',knowledgeIds:ids,
    coverage:ids.map(knowledgeId=>({knowledgeId,candidateDigest:digest(normalizeDraft(draft(knowledgeId))),claims:['duplicate marker keeps all rows']})),
    cases:[
    {id:'pair-and-single',group:'positive',input:['A','A','B'],expected:[true,true,false]},
    {id:'no-duplicates',group:'negative',input:['A','B'],expected:[false,false]},
    {id:'empty',group:'boundary',input:[],expected:[]},
  ],execute:async(_r,c)=>{const rows=c.input as string[];return rows.map(v=>rows.filter(x=>x===v).length>1);}};
}
function register(s:KnowledgeService){return s.registerContribution({pluginId:'dm-listing',scenarioAliases:{manual:['review'],medical:['review'],be:['pk-common']}});}
test('platform stores candidates, runs actual cases and retrieves shared/plugin/current-project scope with Unicode search',async()=>{
  const root=await mkdtemp(join(tmpdir(),'platform-knowledge-'));const s=new KnowledgeService(join(root,'knowledge.sqlite'));
  try{
    register(s);s.registerValidator('dm-listing',suite());
    s.capture(context,draft());assert.equal(s.search(context).total,0);
    const receipt=await s.validate(context,'duplicate-marker',1,'duplicate-check');assert.equal(receipt.passed,true);assert.equal(receipt.state,'ACTIVE');
    assert.equal(s.search(context,{query:'重复 标记'}).total,1);
    assert.equal(s.search({...context,scenario:'medical'}).total,1);
    assert.equal(s.search({...context,scenario:'be'}).total,0);
    assert.equal(s.search({pluginId:'other-plugin',projectId:'project-a'}).total,0);
    const project={...draft('project-decision'),scope:'project' as const,projectId:'project-a',kind:'project_decision' as const};
    s.capture(context,project);
    assert.equal(s.search({...context,projectId:'project-b'},{states:['CANDIDATE']}).total,0);
    assert.throws(()=>s.get({...context,projectId:'project-b'},'project-decision'),/NOT_FOUND/);
    await assert.rejects(s.validate(context,'project-decision',1,'duplicate-check'),/NOT_TECHNICAL/);
    const shared={...draft('shared-method'),scope:'shared' as const};delete shared.pluginId;
    s.capture(context,shared);assert.equal(s.search({pluginId:'other-plugin'},{states:['CANDIDATE']}).total,1);
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});
test('seed imports are atomic and idempotent; new package versions create revisions, dynamic edits are never overwritten',async()=>{
  const root=await mkdtemp(join(tmpdir(),'knowledge-seeds-'));const s=new KnowledgeService(join(root,'knowledge.sqlite'));
  try{
    assert.equal(s.importSeeds('dm-listing','1',[draft()]).imported,1);
    assert.equal(s.importSeeds('dm-listing','1',[draft()]).imported,0);
    assert.throws(()=>s.importSeeds('dm-listing','1',[{...draft(),method:'changed'}]),/SEED_VERSION_CHANGED/);
    // A new package version with changed content for an un-edited seed becomes a new revision, not a startup failure.
    const revised=s.importSeeds('dm-listing','2',[{...draft(),method:'revised seed text'}]);
    assert.equal(revised.revised,1);assert.equal(revised.conflicts.length,0);
    assert.equal(s.get(context,'duplicate-marker').revision,2);
    // A dynamically captured edit is preserved; the same seed id in a newer package becomes a recorded conflict.
    s.capture(context,{...draft(),method:'human edit'},2);
    const mixed=s.importSeeds('dm-listing','3',[draft('new-first'),{...draft(),method:'revised seed text'}]);
    assert.equal(mixed.imported,1);assert.equal(mixed.revised,0);
    assert.deepEqual(mixed.conflicts,[{knowledgeId:'duplicate-marker',reason:'DYNAMICALLY_REVISED'}]);
    assert.equal(s.get(context,'new-first').revision,1);
    assert.equal(s.get(context,'duplicate-marker').method,'human edit');
    assert.throws(()=>s.capture(context,{...draft(),method:'stale'},2),/REVISION_STALE/);
    assert.throws(()=>s.capture(context,{...draft(),scope:'shared',pluginId:undefined},3),/PROMOTION_REQUIRES_NEW_ID/);
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});
test('failed cases cannot activate; validator is bound to target and candidate revision changing mid-validation stays inactive',async()=>{
  const root=await mkdtemp(join(tmpdir(),'knowledge-validation-'));const s=new KnowledgeService(join(root,'knowledge.sqlite'));
  try{
    register(s);s.capture(context,draft());
    const bad={...suite(),execute:async()=>true};const unregister=s.registerValidator('dm-listing',bad);
    const receipt=await s.validate(context,'duplicate-marker',1,'duplicate-check');assert.equal(receipt.passed,false);assert.equal(receipt.state,'CANDIDATE');
    unregister();s.capture(context,draft('unrelated'));
    s.registerValidator('dm-listing',{...suite(),execute:async(_r,c)=>{
      if(c.id==='pair-and-single')s.capture(context,{...draft(),method:'corrected while checking'},1);
      return suite().execute(_r,c);
    }});
    await assert.rejects(s.validate(context,'unrelated',1,'duplicate-check'),/TARGET_MISMATCH/);
    const stale=await s.validate(context,'duplicate-marker',1,'duplicate-check');assert.equal(stale.passed,true);assert.equal(stale.state,'CANDIDATE');
    assert.equal(s.get(context,'duplicate-marker').revision,2);assert.equal(s.search(context).total,0);
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});
test('new candidate does not mask active revision; snapshots persist across restart and revocation does not rewrite history',async()=>{
  const root=await mkdtemp(join(tmpdir(),'knowledge-snapshot-'));const path=join(root,'knowledge.sqlite');let s=new KnowledgeService(path);
  try{
    register(s);s.registerValidator('dm-listing',suite());s.capture(context,draft());await s.validate(context,'duplicate-marker',1,'duplicate-check');
    const snapshot=s.snapshot(context,'run-1');
    s.capture(context,{...draft(),method:'new unverified revision'},1);
    assert.equal(s.search(context).items[0].revision,1);
    assert.deepEqual(s.snapshot(context,'run-1'),snapshot);
    s.close();s=new KnowledgeService(path);register(s);
    assert.deepEqual(s.readSnapshot(context,'run-1'),snapshot);
    s.setState(context,'duplicate-marker',2,'REVOKED','bad applicability');assert.equal(s.search(context).total,0);
    assert.deepEqual(s.readSnapshot(context,'run-1'),snapshot);
    assert.throws(()=>s.snapshot(context,'run-1'),/SNAPSHOT_IMMUTABLE/);
    assert.throws(()=>s.readSnapshot({...context,projectId:'other'},'run-1'),/SNAPSHOT_NOT_FOUND/);
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});
test('every dm_listing_scenario_methods topic resolves at least one shipped seed through the same mapping the tool uses',async()=>{
  const root=await mkdtemp(join(tmpdir(),'scenario-topics-'));const s=new KnowledgeService(join(root,'knowledge.sqlite'));
  try{
    s.registerContribution(listingKnowledgeContribution);
    s.importSeeds(LISTING_PLUGIN_ID,LISTING_SEED_VERSION,listingSeeds);
    const scenarioName:Record<MethodTopic,string|undefined>={intake:undefined,manual:'manual',medical:'medical',pk:'pk','pk-be':'be','pk-sad-mad':'sad-mad'};
    for(const topic of METHOD_TOPICS){
      const topics=topic==='intake'?['intake']:topic==='pk-be'?['pk','pk-be']:topic==='pk-sad-mad'?['pk','pk-sad-mad']:topic==='pk'?['pk']:[topic];
      const result=s.search({pluginId:LISTING_PLUGIN_ID,scenario:scenarioName[topic]},{states:['ACTIVE','CANDIDATE'],topics,limit:100});
      assert(result.items.length>=1,`topic ${topic} returned no methods`);
    }
    // The shared review seed must surface for both manual and medical (regression: medical topic mapping).
    const medical=s.search({pluginId:LISTING_PLUGIN_ID,scenario:'medical'},{states:['ACTIVE','CANDIDATE'],topics:['medical'],limit:100});
    assert(medical.items.some(i=>i.knowledgeId==='dm-listing.review.methods'));
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});
test('event totals stay exact past 1000 events and paging beyond the old cap is complete',async()=>{
  const root=await mkdtemp(join(tmpdir(),'knowledge-events-count-'));const s=new KnowledgeService(join(root,'knowledge.sqlite'));
  try{
    // Each capture revision (content varies) appends one CANDIDATE_CAPTURED event.
    let revision=0;
    for(let i=0;i<1005;i++){
      const record=s.capture(context,{...draft(),method:`revision ${i}`},revision);
      revision=record.revision;
    }
    const feed=s.events(context,'duplicate-marker',0,50);
    assert.equal(feed.total,1005,'total must be the SQL COUNT, not a fetched-length cap');
    const tail=s.events(context,'duplicate-marker',1000,10);
    assert.equal(tail.items.length,5,'paging beyond the old 1000 cap must return the remaining events');
    let seen=0,offset=0;
    for(;;){
      const page=s.events(context,'duplicate-marker',offset,100);
      seen+=page.items.length;offset+=page.items.length;
      if(offset>=page.total)break;
    }
    assert.equal(seen,1005,'page concatenation must cover the whole feed without duplicates or gaps');
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});
