import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {overviewProject,readWorkflowSheet,describeWorkflowDataset} from '../src/workflow.ts';
import {makeWorkbook} from '../src/demo.ts';
import {resolveRuntime,describeDataset} from '../src/datasets.ts';
import type {RuntimeSpec} from '../src/runner.ts';

const runtime:RuntimeSpec={executable:process.env.DSH_LISTING_R_EXECUTABLE??'D:/package/R-4.5.0/bin/x64/Rterm.exe',
  home:process.env.DSH_LISTING_R_HOME??'D:/package/R-4.5.0',kind:process.env.DSH_LISTING_R_KIND==='Rscript'?'Rscript':'Rterm'};

test('workflow overview inventories every workbook sheet without reading cells; errors surface per workbook',async()=>{
  const root=await mkdtemp(join(tmpdir(),'listing-workflow-'));
  try{
    await mkdir(join(root,'docs'),{recursive:true});
    await writeFile(join(root,'docs','spec.xlsx'),makeWorkbook([{name:'Cover',rows:[['COVER_BODY']]},{name:'Manual Review',rows:[['ID','Rule'],['1','x']]}]));
    await writeFile(join(root,'docs','ALS.xlsx'),makeWorkbook([{name:'Forms',rows:[['Form']]}]));
    await writeFile(join(root,'broken.xlsx'),Buffer.from('not an xlsx'));
    const overview=await overviewProject(root);
    // Windows 8.3 short path vs realpath can differ; only assert it points at the same temp root.
    assert.ok(overview.directory.toLowerCase().replace(/\/|\\/g,'/').includes('listing-workflow-'));
    assert.equal(overview.workbooks.length,3);
    const spec=overview.workbooks.find(w=>w.path==='docs/spec.xlsx');
    assert(spec&&!spec.error);
    assert.deepEqual(spec.sheets.map(s=>s.name),['Cover','Manual Review']);
    assert(spec.sheets.every(s=>s.sheetId&&s.visibility));
    assert(overview.workbooks.find(w=>w.path==='broken.xlsx')?.error);
    assert(overview.notice.includes('候选仅为名称线索'));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('workflow sheet read returns full content including hidden/merged; unknown sheet fails with real code',async()=>{
  const root=await mkdtemp(join(tmpdir(),'listing-workflow-'));
  try{
    await writeFile(join(root,'spec.xlsx'),makeWorkbook([{name:'Manual Review',rows:[['ID','Rule'],['1','x'],['2','y']]}]));
    const overview=await overviewProject(root);
    const sheetId=overview.workbooks[0].sheets[0].sheetId;
    const content=await readWorkflowSheet(root,'spec.xlsx',sheetId);
    assert.equal(content.cells.length,6);
    await assert.rejects(readWorkflowSheet(root,'spec.xlsx','sheet-99'),/UNKNOWN_SHEET|INVALID_SHEET/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('workflow dataset description reads real CSV through local R',async()=>{
  const root=await mkdtemp(join(tmpdir(),'listing-workflow-'));
  try{
    await writeFile(join(root,'data.csv'),'Subject,Visit,Value\nSYN001,V1,10\n');
    const described=await describeWorkflowDataset(runtime,join(root,'data.csv'));
    assert.equal(described.tables.length,1);
    assert.deepEqual(described.tables[0].columns,['Subject','Visit','Value']);
  }finally{await rm(root,{recursive:true,force:true});}
});
