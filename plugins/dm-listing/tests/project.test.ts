import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject,readProjectWorksheet,readProjectArtifact,isWithin} from '../src/project.ts';
import {datasetKind,resolveRuntime,describeDataset,runRExpression} from '../src/datasets.ts';
import type {RuntimeSpec} from '../src/runner.ts';
import {makeWorkbook} from '../src/demo.ts';
const runtime:RuntimeSpec={executable:process.env.DSH_LISTING_R_EXECUTABLE??'D:/package/R-4.5.0/bin/x64/Rterm.exe',
  home:process.env.DSH_LISTING_R_HOME??'D:/package/R-4.5.0',kind:process.env.DSH_LISTING_R_KIND==='Rscript'?'Rscript':'Rterm'};
async function project(){const root=await mkdtemp(join(tmpdir(),'listing-project-'));return root;}
test('project scan enumerates regular files, skips locks/hidden, flags candidates without name-based denial',async()=>{
  const root=await project();
  try{
    await mkdir(join(root,'docs'),{recursive:true});await mkdir(join(root,'Project_Data','01_Raw_sas','Manual Listing','2026-01-01'),{recursive:true});
    await writeFile(join(root,'docs','Manual Spec v2.xlsx'),makeWorkbook([{name:'Cover',rows:[['COVER_BODY']]},{name:'Manual Review',rows:[['A','B']]}]));
    await writeFile(join(root,'docs','database definition ALS.xlsx'),makeWorkbook([{name:'Forms',rows:[['Form']]}]));
    await writeFile(join(root,'docs','notes.txt'),'readable');
    await writeFile(join(root,'~$Manual Spec v2.xlsx'),'lock should be ignored');
    await writeFile(join(root,'.hidden'),'ignored');
    await mkdir(join(root,'SAS_Program','SAS_program','Manual Listing'),{recursive:true});
    await writeFile(join(root,'SAS_Program','SAS_program','Manual Listing','STUDY_Manual_Listing.R'),'# old accepted program');
    const scan=await scanProject(root);
    assert.equal(scan.total,4);
    assert(scan.files.some(f=>f.name==='notes.txt'&&f.kind==='text'&&f.sha256));
    assert(!scan.files.some(f=>f.name.startsWith('~$')||f.name==='.hidden'));
    assert.equal(scan.candidates.specWorkbook.length,1);
    assert.equal(scan.candidates.alsWorkbook.length,1);
    assert.equal(scan.candidates.programs.length,1);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('project workbook read includes Cover content and hidden/merged metadata; traversal rejected',async()=>{
  const root=await project();
  try{
    await mkdir(join(root,'docs'),{recursive:true});
    await writeFile(join(root,'docs','spec.xlsx'),makeWorkbook([{name:'Cover',rows:[['COVER_CONTENT_READABLE']]},{name:'Manual Review',rows:[['ID','Rule'],['1','x']]}]));
    const cover=await readProjectWorksheet(root,'docs/spec.xlsx','sheet-1');
    assert.equal(cover.cells[0]?.value,'COVER_CONTENT_READABLE');
    assert.match(cover.workbookSha256,/^[a-f0-9]{64}$/);
    await assert.rejects(readProjectWorksheet(root,'../outside.xlsx','sheet-1'),/PROJECT_PATH_OUTSIDE_ROOT|PROJECT_PATH_INVALID/);
    const text=await readProjectArtifact(root,'docs/spec.xlsx').catch(()=>undefined);
    assert.equal(text?.base64?.slice(0,2),'UE','binary returned as base64 when read as artifact');
    await writeFile(join(root,'docs','note.txt'),'hello');
    assert.equal((await readProjectArtifact(root,'docs/note.txt')).text,'hello');
    assert(isWithin(root,join(root,'docs')));assert(!isWithin(root,join(root,'..')));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('R dataset description returns real tables, columns and sample data; invalid files fail with real diagnostics',async()=>{
  assert.equal(datasetKind('a.SAS7BDAT'),'sas');assert.equal(datasetKind('a.csv'),'csv');assert.equal(datasetKind('a.RData'),'rdata');
  const root=await project();
  try{
    await writeFile(join(root,'sample.csv'),'Subject,Visit,Value\nSYN001,V1,10\nSYN001,V1,11\n');
    const described=await describeDataset(runtime,join(root,'sample.csv'));
    assert.equal(described.tables.length,1);assert.equal(described.tables[0].rows,2);
    assert.deepEqual(described.tables[0].columns,['Subject','Visit','Value']);
    assert.equal(described.tables[0].sample?.[0]?.Value,'10');
    await writeFile(join(root,'broken.rds'),'not an rds');
    await assert.rejects(describeDataset(runtime,join(root,'broken.rds')),/DATASET_READ_FAILED/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('installed R can write and read back a SAS dataset, and RData keeps named data.frames',async()=>{
  const root=await project();
  try{
    const base=join(root,'fixture');await mkdir(base,{recursive:true});
    const write=await runRExpression(runtime,`if (!requireNamespace("haven", quietly = TRUE)) quit(status = 42)
d <- data.frame(Subject=c("SYN001","SYN001"), Visit=c("V1","V1"), Value=c(10,11), stringsAsFactors = FALSE)
haven::write_sas(d, file.path(${JSON.stringify(base)}, "sample.sas7bdat"))
d2 <- data.frame(A=1:2); save(d2, file = file.path(${JSON.stringify(base)}, "cache.RData"))
cat("WROTE\\n")`);
    if(write.code===42){console.log('haven not installed; skipping SAS write/read');return;}
    assert.equal(write.code,0,write.stderr);
    const sas=await describeDataset(runtime,join(base,'sample.sas7bdat'));
    assert.equal(sas.kind,'sas');assert.equal(sas.tables[0].rows,2);
    assert.deepEqual(sas.tables[0].columns,['Subject','Visit','Value']);
    const rdata=await describeDataset(runtime,join(base,'cache.RData'));
    assert.equal(rdata.kind,'rdata');assert.equal(rdata.tables[0].name,'d2');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('dataset sample bounds are enforced and missing R configuration yields a clear code',async()=>{
  const root=await project();
  try{
    await writeFile(join(root,'x.csv'),'A\n1\n');
    await assert.rejects(describeDataset(runtime,join(root,'x.csv'),-1),/DATASET_SAMPLE_INVALID/);
    await assert.rejects(resolveRuntime({executable:undefined,home:undefined,kind:undefined}),/OPERATOR_R_CONFIG_REQUIRED/);
  }finally{await rm(root,{recursive:true,force:true});}
});
