import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskStore} from '../src/storage.ts';
import {ListingService} from '../src/service.ts';

test('TaskStore enforces CAS revisions and owner isolation, and survives restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-store-'));
  const a=new TaskStore(root,'owner-a');const b=new TaskStore(root,'owner-b');
  try{
    assert.equal(a.save('task-1',0,'v1','CREATE'),1);
    assert.throws(()=>a.save('task-1',0,'duplicate-insert','CREATE'),/UNIQUE/);
    assert.equal(a.save('task-1',1,'v2','UPDATE'),2);
    assert.throws(()=>a.save('task-1',1,'stale-write','UPDATE'),/TASK_VERSION_STALE/);
    assert.equal(a.get('task-1')?.payload,'v2');
    assert.equal(a.get('task-1')?.revision,2);
    assert.equal(b.get('task-1'),undefined);
    assert.deepEqual(b.list(),[]);
    assert.deepEqual(a.list(),[{id:'task-1',revision:2}]);
    assert.equal(a.save('task-1',2,'v3','UPDATE'),3);
    a.close();b.close();
    const again=new TaskStore(root,'owner-a');
    try{
      assert.deepEqual(again.list(),[{id:'task-1',revision:3}]);
      assert.equal(again.get('task-1')?.payload,'v3');
    }finally{again.close();}
  }finally{a.close();b.close();await rm(root,{recursive:true,force:true});}
});

test('ListingService restores requirements/program bindings across restart, isolates owners and detects tampered program artifacts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-persist-'));
  const s=new ListingService(root,'owner-a');
  try{
    const w=await s.open('manual');
    await s.readRequirements(w.workspaceId,async()=>{throw new Error('ASK_MUST_NOT_RUN');});
    const req=await s.saveRequirements(w.workspaceId,[{id:'r1',meaning:'输出全部行',condition:'无筛选',columns:['USUBJID'],mapping:'直接取值',validation:'行数一致',unresolved:[]}]);
    assert.equal(req.count,1);
    const prog=await s.saveProgram(w.workspaceId,'cat("persistence-probe")\n');
    const before=s.inspect(w.workspaceId);
    assert.equal(before.hasRequirements,true);assert.equal(before.hasProgram,true);
    s.close();
    const resumed=new ListingService(root,'owner-a');
    const other=new ListingService(root,'owner-b');
    try{
      assert(resumed.list().some(t=>t.workspaceId===w.workspaceId));
      assert(!other.list().some(t=>t.workspaceId===w.workspaceId));
      assert.throws(()=>other.inspect(w.workspaceId),/UNKNOWN_WORKSPACE/);
      const after=resumed.inspect(w.workspaceId);
      assert.equal(after.hasRequirements,true);assert.equal(after.hasProgram,true);
      const reread=await resumed.readRequirements(w.workspaceId,async()=>{throw new Error('ASK_MUST_NOT_RUN');});
      assert(reread.sheets.length>=1);
      await writeFile(join(w.outputDirectory,prog.programFile),
        (await readFile(join(w.outputDirectory,prog.programFile),'utf8'))+'\n# tampered after restart\n');
      await assert.rejects(
        resumed.validateSynthetic(w.workspaceId,{executable:'unused',home:'unused',kind:'Rterm'},async()=>{throw new Error('APPROVE_MUST_NOT_RUN');}),
        /PROGRAM_ARTIFACT_CHANGED/);
    }finally{other.close();resumed.close();}
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});
