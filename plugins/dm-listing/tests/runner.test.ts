import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { ListingService, type Item } from '../src/service.ts';
import { probeRuntime, runLocalSynthetic, sha256, type RuntimeSpec } from '../src/runner.ts';
import { TaskStore } from '../src/storage.ts';
import { CHECKER_VERSION, checkSynthetic, parseCsv } from '../src/checker.ts';
import { demo } from '../src/demo.ts';
import { referenceProgram } from './fixtures/reference-programs.ts';
import type { Scenario, PkType } from '../src/knowledge.ts';

const runtime: RuntimeSpec = {
  executable: process.env.DSH_LISTING_R_EXECUTABLE ?? 'D:/package/R-4.5.0/bin/x64/Rterm.exe',
  home: process.env.DSH_LISTING_R_HOME ?? 'D:/package/R-4.5.0',
  kind: process.env.DSH_LISTING_R_KIND === 'Rscript' ? 'Rscript' : 'Rterm',
};
const item: Item = {id:'synthetic-acceptance',meaning:'Follow the artificial specification',condition:'all',columns:['specified columns'],mapping:'synthetic schema',validation:'independent checker',unresolved:[]};

// These tests execute only reviewed, hand-authored fixtures, never model output or clinical project code.
test('installed R runs a version probe through the configured executable',async()=>{
  const result=await probeRuntime(runtime);
  assert.match(result.version,/^R version \d+\.\d+\.\d+/);
  assert.match(result.digest,/^[a-f0-9]{64}$/);
});
for(const [scenario,pkType] of [['medical',undefined],['manual',undefined],['report',undefined],['pk','be'],['pk','sad-mad']] as [Scenario,PkType|undefined][]){
  test(`actual R execution, independent check and portable ZIP: ${scenario}/${pkType??'-'}`,async()=>{
    const root=await mkdtemp(join(tmpdir(),'dm-r-e2e-'));let s=new ListingService(root,'r-acceptance');
    try{
      const w=await s.open(scenario,pkType);
      await s.readRequirements(w.workspaceId,async q=>[q.options[0].label]);
      await s.saveRequirements(w.workspaceId,[item]);
      const program=await s.saveProgram(w.workspaceId,referenceProgram(scenario,pkType));
      const receipt=await s.validateSynthetic(w.workspaceId,runtime,async details=>{
        assert.equal(details.programDigest,program.programDigest); return true;
      });
      assert.equal(receipt.status,'PASSED',JSON.stringify(receipt));
      assert.equal(receipt.exitCode,0);
      assert.equal(receipt.check?.passed,true);
      assert.equal(receipt.enforcement,'UNCONFINED_SYNTHETIC');
      assert.equal(receipt.artifacts?.passed,true);
      assert.equal(s.inspect(w.workspaceId).execution.current,true);
      assert.equal(s.list()[0].execution.result,'PASSED');
      s.close();s=new ListingService(root,'r-acceptance');
      assert.equal(s.inspect(w.workspaceId).execution.result,'PASSED');
      const delivery=await s.delivery(w.workspaceId);
      assert.equal(delivery.status,'SYNTHETIC_VALIDATED');
      assert.equal(delivery.realDataQC,'NOT_RUN');
      assert.equal(delivery.productionDataEnabled,false);
      const zip=unzipSync(await readFile(join(w.outputDirectory,delivery.archiveFile)));
      for(const name of ['main.R','input.csv','requirements.json','manifest.json','runtime.json','execution-receipt.json','output.csv','output.xlsx','output.rds','output-contract.json','check-rds.R','checksums.json','README.md']) assert(zip[name],name);
      const checksums=JSON.parse(strFromU8(zip['checksums.json']));
      for(const [name,hash] of Object.entries(checksums))assert.equal(sha256(Buffer.from(zip[name])),hash,name);
      assert(!zip['execution.local.log']);assert(!Object.keys(zip).some(n=>n.includes('spec.synthetic')));
      assert.equal(checkSynthetic(scenario,pkType,strFromU8(zip['input.csv']),strFromU8(zip['output.csv'])).passed,true);
      assert(!Buffer.from(await readFile(join(w.outputDirectory,delivery.archiveFile))).includes(Buffer.from('COVER_SYNTHETIC_CANARY')));
      await writeFile(join(w.outputDirectory,`run-${receipt.runId}`,'output.csv'),'tampered');
      await assert.rejects(s.delivery(w.workspaceId),/OUTPUT_ARTIFACT_CHANGED/);
    }finally{s.close();await rm(root,{recursive:true,force:true});}
  });
}

test('denied human approval does not create a run or execute code',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-denied-'));const s=new ListingService(root,'owner');
  try{
    const w=await s.open('manual');await s.saveProgram(w.workspaceId,'stop("must not run")');
    await assert.rejects(s.validateSynthetic(w.workspaceId,runtime,async()=>false),/EXECUTION_NOT_APPROVED/);
    assert(!(await readdir(w.outputDirectory)).some(n=>n.startsWith('run-')));
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});

test('R errors, false output, timeout, cancellation and output flooding never produce PASS',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-r-negative-'));
  try{
    const cases=[
      {name:'error',code:'stop("SYNTHETIC_LOCAL_ERROR")',status:'FAILED'},
      {name:'missing-output',code:'cat("no output")',status:'FAILED'},
      {name:'wrong-values',code:referenceProgram('manual').replace('write.csv(o,','o$Value <- "wrong"\nwrite.csv(o,'),status:'FAILED'},
      {name:'timeout',code:'Sys.sleep(30)',status:'TIMED_OUT',timeout:250},
      {name:'flood',code:'cat(strrep("x", 300000))',status:'OUTPUT_LIMIT'},
      {name:'cancel',code:'writeLines("ready", "cancel-ready.txt"); Sys.sleep(30)',status:'CANCELLED',cancel:true},
    ];
    for(const c of cases){
      const directory=join(root,c.name);await mkdir(directory);
      const controller=new AbortController();
      let pending:ReturnType<typeof runLocalSynthetic>|undefined;
      try{
        pending=runLocalSynthetic({runId:randomUUID(),directory,code:c.code,input:demo('manual').data,scenario:'manual',runtime,timeoutMs:c.timeout,signal:controller.signal});
        // Observe an actual R-side readiness marker, not a guessed startup duration.
        let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});
        if(c.cancel){
          const deadline=Date.now()+20000;let ready=false;
          while(!settled&&Date.now()<deadline){
            try{ready=(await readFile(join(directory,'cancel-ready.txt'),'utf8')).trim()==='ready';}
            catch(e){if(!(e instanceof Error&&'code' in e&&e.code==='ENOENT'))throw e;}
            if(ready)break;
            await new Promise(r=>setTimeout(r,20));
          }
          assert(ready,'R must confirm execution started before cancellation');controller.abort();
        }
        const receipt=await pending;
        assert.equal(receipt.status,c.status,JSON.stringify(receipt));
        assert.equal(receipt.check?.passed??false,false);
        // Fixed contract: bounded execution diagnostics travel on the receipt so the Harness can debug R failures;
        // the full log stays local and stays bounded at 256 KiB.
        const d=receipt.diagnostics;assert(d,`diagnostics missing: ${JSON.stringify(receipt)}`);
        assert.equal(d.logFile,'execution.local.log');
        assert(d.tail.length<=4000,`tail too long: ${d.tail.length}`);
        if(c.name==='error')assert(d.tail.includes('SYNTHETIC_LOCAL_ERROR'),'R stop message must surface in diagnostics.tail');
        assert((await readFile(join(directory,'execution.local.log'))).length<=256*1024);
      }finally{controller.abort();await pending?.catch(()=>{});}
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('confirmed requirement reads do not invalidate an in-flight execution',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-r-concurrent-'));const s=new ListingService(root,'owner');
  let pending: ReturnType<ListingService['validateSynthetic']> | undefined;
  try{
    const w=await s.open('manual');
    await s.readRequirements(w.workspaceId,async()=>[]);
    await s.saveRequirements(w.workspaceId,[item]);
    await s.saveProgram(w.workspaceId,`Sys.sleep(1)\n${referenceProgram('manual')}`);
    pending=s.validateSynthetic(w.workspaceId,runtime,async()=>true);
    // The service commits RUNNING before probing/spawning R. Observe state, not a guessed delay.
    for(let i=0;i<200&&s.inspect(w.workspaceId).execution.status!=='RUNNING';i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(s.inspect(w.workspaceId).execution.status,'RUNNING');
    const revision=s.inspect(w.workspaceId).revision;
    await s.readRequirements(w.workspaceId,async()=>{throw new Error('must reuse confirmed selection');});
    assert.equal(s.inspect(w.workspaceId).revision,revision);
    await assert.rejects(s.saveProgram(w.workspaceId,'# concurrent draft'),/EXECUTION_IN_PROGRESS/);
    await assert.rejects(s.saveRequirements(w.workspaceId,[item]),/EXECUTION_IN_PROGRESS/);
    await assert.rejects(s.delivery(w.workspaceId),/EXECUTION_IN_PROGRESS/);
    assert.equal((await pending).status,'PASSED');
    const before=s.inspect(w.workspaceId).revision;
    await s.readRequirements(w.workspaceId,async()=>[]);
    assert.equal(s.inspect(w.workspaceId).revision,before);
    assert.equal((await s.delivery(w.workspaceId)).status,'SYNTHETIC_VALIDATED');
    await s.saveRequirements(w.workspaceId,[{...item,meaning:'revised'}]);
    assert.equal(s.inspect(w.workspaceId).execution.current,false);
    await s.saveProgram(w.workspaceId,referenceProgram('manual'));
    assert.equal((await s.delivery(w.workspaceId)).syntheticValidation,'NOT_RUN');
  }finally{await pending?.catch(()=>{});s.close();await rm(root,{recursive:true,force:true});}
});

test('a program change during human approval cannot execute the old revision',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-r-approval-'));const s=new ListingService(root,'owner');
  try{
    const w=await s.open('manual');await s.saveProgram(w.workspaceId,'# original');
    await assert.rejects(s.validateSynthetic(w.workspaceId,runtime,async()=>{
      await s.saveProgram(w.workspaceId,'# replacement');return true;
    }),/TASK_VERSION_STALE/);
    assert(!(await readdir(w.outputDirectory)).some(n=>n.startsWith('run-')));
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});

test('delivery rejects mismatched receipts and independently rechecks claimed PASS output',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-r-evidence-'));const s=new ListingService(root,'owner');
  const store=new TaskStore(root,'owner');
  try{
    const w=await s.open('manual');await s.readRequirements(w.workspaceId,async()=>[]);
    await s.saveRequirements(w.workspaceId,[item]);await s.saveProgram(w.workspaceId,referenceProgram('manual'));
    const original=await s.validateSynthetic(w.workspaceId,runtime,async()=>true);
    assert.equal(original.status,'PASSED');
    const row=store.get(w.workspaceId)!;const state=JSON.parse(row.payload);
    const outputPath=join(w.outputDirectory,`run-${original.runId}`,'output.csv');
    const validOutput=await readFile(outputPath);
    const cases=[
      {code:'EXECUTION_RECEIPT_CHANGED',patch:{programDigest:'0'.repeat(64)}},
      {code:'EXECUTION_RECEIPT_CHANGED',patch:{inputDigest:'0'.repeat(64)}},
      {code:'EXECUTION_RECEIPT_CHANGED',patch:{runId:randomUUID()}},
      {code:'EXECUTION_EVIDENCE_INVALID',patch:{exitCode:1}},
      {code:'EXECUTION_EVIDENCE_INVALID',patch:{check:{...original.check,passed:false}}},
      {code:'CHECKER_VERSION_STALE',patch:{check:{...original.check,checkerVersion:'old-checker'}}},
      {code:'EXECUTION_EVIDENCE_INVALID',patch:{outputDigest:sha256('Subject,Visit,Value,Unit,DuplicateFlag\n')},output:'Subject,Visit,Value,Unit,DuplicateFlag\n'},
    ];
    for(const c of cases){
      const receipt={...original,...c.patch};
      state.execution.receipt=receipt;
      await writeFile(outputPath,c.output??validOutput);
      await writeFile(join(w.outputDirectory,state.execution.receiptFile),JSON.stringify(receipt,null,2));
      store.save(w.workspaceId,store.get(w.workspaceId)!.revision,JSON.stringify(state),'TEST_CORRUPT_EVIDENCE');
      await assert.rejects(s.delivery(w.workspaceId),new RegExp(c.code));
    }
    // Path validation happens before reading a receipt, even if the local database was edited.
    state.execution.receipt=original;state.execution.receiptFile='../outside.json';
    store.save(w.workspaceId,store.get(w.workspaceId)!.revision,JSON.stringify(state),'TEST_CORRUPT_PATH');
    await assert.rejects(s.delivery(w.workspaceId),/EXECUTION_RECEIPT_CHANGED/);
  }finally{store.close();s.close();await rm(root,{recursive:true,force:true});}
});

test('checker rejects non-finite expectations instead of accepting arbitrary numeric output',()=>{
  const input=demo('pk','be').data.replace('2020-01-01T10:00:00Z','invalid-timestamp');
  const output='Subject,Period,NominalHour,ActualHour,Concentration\nSYN001,1,2,999,BQL\nSYN002,1,2,2.5,1.2300\n';
  const result=checkSynthetic('pk','be',input,output);
  assert.equal(result.passed,false);assert.equal(result.checkerVersion,CHECKER_VERSION);
});

test('checker preserves concentration text, flags all duplicate-key rows, and rejects malformed CSV',()=>{
  assert.deepEqual(parseCsv('\ufeff"A","B"\r\n"x,y","a""b"\r\n'),[['A','B'],['x,y','a"b']]);
  for(const csv of ['A,A\nx,y\n','A,B\n"unterminated','A,B\n"x"oops,y\n'])assert.throws(()=>parseCsv(csv));
  assert.equal(checkSynthetic('manual',undefined,demo('manual').data,'Subject,Visit,Value,Unit,DuplicateFlag\nSYN001,V1,10,mg,FALSE\nSYN001,V1,11,mg,TRUE\nSYN002,V2,,mg,FALSE\n').passed,false);
  assert.equal(checkSynthetic('pk','be',demo('pk','be').data,'Subject,Period,NominalHour,ActualHour,Concentration\nSYN001,1,2,2,BQL\nSYN002,1,2,2.5,1.23\n').passed,false);
});
