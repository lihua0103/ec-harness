import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,access} from 'node:fs/promises';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describeDataset,runRExpression} from '../src/datasets.ts';
import {type RuntimeSpec} from '../src/runner.ts';

const runtime:RuntimeSpec={
  executable:process.env.DSH_LISTING_R_EXECUTABLE??'D:/package/R-4.5.0/bin/x64/Rterm.exe',
  home:process.env.DSH_LISTING_R_HOME??'D:/package/R-4.5.0',
  kind:process.env.DSH_LISTING_R_KIND==='Rscript'?'Rscript':'Rterm',
};
const rPath=(p:string)=>p.replaceAll('\\','/');

test('pre-cancelled R work does not spawn and its owned temporary directory is cleaned',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-cancel-r-'));
  const executable=join(root,'synthetic-r');
  await writeFile(executable,'fixture');
  const original=childProcess.spawn;let spawned=0;
  // child_process.spawn is overloaded; a test double cannot express every overload without this cast.
  childProcess.spawn=((..._args:Parameters<typeof original>)=>{spawned++;throw new Error('must not spawn');}) as unknown as typeof original;
  syncBuiltinESMExports();
  const controller=new AbortController();controller.abort();
  try{
    await assert.rejects(runRExpression({...runtime,executable},'cat(1)',controller.signal),/CANCELLED/);
    assert.equal(spawned,0);
  }finally{childProcess.spawn=original;syncBuiltinESMExports();await rm(root,{recursive:true,force:true});}
});

test('cancelled R run settles only after child close and removes its owned temporary directory',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-cancel-r-'));
  const executable=join(root,'synthetic-r');
  await writeFile(executable,'fixture');
  const original=childProcess.spawn;
  const child=new EventEmitter() as EventEmitter&{pid:number;stdout:PassThrough;stderr:PassThrough;kill:(signal?:NodeJS.Signals)=>boolean;exitCode:number|null;signalCode:NodeJS.Signals|null};
  Object.assign(child,{pid:43210,stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,signalCode:null,kill:()=>true});
  let workingDir='';
  let spawnSeen!: ()=>void;
  const spawned=new Promise<void>(resolve=>{spawnSeen=resolve;});
  // Same overloaded-spawn test-double exception as above.
  childProcess.spawn=((...args:Parameters<typeof original>)=>{workingDir=(args[2] as {cwd:string}).cwd;spawnSeen();return child;}) as unknown as typeof original;
  syncBuiltinESMExports();
  const controller=new AbortController();
  try{
    const pending=runRExpression({...runtime,executable},'cat(1)',controller.signal);
    void pending.catch(()=>{}); // handle rejection from creation; still assert it below
    await spawned;
    assert(workingDir,'child should have started');
    controller.abort();
    let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false,'must not reject before the owned child closes');
    child.emit('close',null);
    await assert.rejects(pending,/CANCELLED/);
    await assert.rejects(access(workingDir));
  }finally{
    childProcess.spawn=original;syncBuiltinESMExports();await rm(root,{recursive:true,force:true});
  }
});

test('single-column CSV keeps columns as a one-element array after jsonlite normalization',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-datasets-'));
  try{
    const csv=join(root,'single.csv');
    await writeFile(csv,'A\n1\n2\n3\n');
    const d=await describeDataset(runtime,csv);
    assert.equal(d.tables.length,1);
    assert.deepEqual(d.tables[0].columns,['A']);
    assert.equal(d.tables[0].rows,3);
    assert.deepEqual(d.warnings,[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('RDS named listing lists expose one table per data.frame under its own name',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-datasets-'));
  try{
    const rds=join(root,'listing.rds');
    const create=await runRExpression(runtime,
      `saveRDS(list(AE=data.frame(USUBJID=c('01','02'),AESEQ=1:2),DM=data.frame(USUBJID='01',ARM='A')), file='${rPath(rds)}')`);
    assert.equal(create.code,0,create.stderr);
    const d=await describeDataset(runtime,rds);
    assert.deepEqual(d.tables.map(t=>t.name),['AE','DM']);
    assert.deepEqual(d.tables[0].columns,['USUBJID','AESEQ']);
    assert.equal(d.tables[0].rows,2);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('RDS unnamed lists fall back to positional labels and non-frame leaves become skipped warnings',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-datasets-'));
  try{
    const rds=join(root,'mixed.rds');
    const create=await runRExpression(runtime,
      `saveRDS(list(data.frame(A=1), data.frame(B='x'), 'text-leaf'), file='${rPath(rds)}')`);
    assert.equal(create.code,0,create.stderr);
    const d=await describeDataset(runtime,rds);
    assert.deepEqual(d.tables.map(t=>t.name),['[[1]]','[[2]]']);
    assert(d.warnings.some(w=>w.includes('skipped non-data.frame')&&w.includes('[[3]]')),JSON.stringify(d.warnings));
  }finally{await rm(root,{recursive:true,force:true});}
});
