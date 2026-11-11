import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { Workbook } from '../src/workbook.ts';
import { makeWorkbook } from '../src/demo.ts';
import { ListingService } from '../src/service.ts';
import { profiles, isCover, SCENARIOS } from '../src/knowledge.ts';

test('four scenarios share exactly three material channels; PK is explicit',()=>{
  assert.equal(profiles.medical.channel,profiles.manual.channel);
  assert.equal(new Set(Object.values(profiles).map(x=>x.channel)).size,3);
  assert(isCover(' CoVeR '));
});
test('sheet discovery is metadata-only; Cover reads like any sheet and reads stay per-sheet',async()=>{
  const opened:string[]=[];
  const w=await Workbook.open(makeWorkbook([{name:'Cover',rows:[['COVER_SYNTHETIC_CANARY']]},{name:'Manual Review',rows:[['Allowed requirement']]}]),p=>opened.push(p));
  try {
    const list=await w.listSheets(); assert.equal(list.length,2);
    assert.deepEqual(opened,['xl/workbook.xml','xl/_rels/workbook.xml.rels']);
    const result=await w.readSheet('sheet-2');
    assert.equal(result.cells[0].value,'Allowed requirement');
    assert(!JSON.stringify(result).includes('COVER_SYNTHETIC_CANARY'));
    assert(!opened.includes('xl/worksheets/sheet1.xml'));
    const cover=await w.readSheet('sheet-1');
    assert(cover.cells.some(c=>c.value.includes('COVER_SYNTHETIC_CANARY')));
  }finally{w.close();}
});
test('a worksheet alias resolves identically for both sheet names; no name-based denial',async()=>{
  const reads:string[]=[];
  const w=await Workbook.open(Buffer.from(zipSync({
    'xl/workbook.xml':strToU8('<workbook xmlns:r="r"><sheets><sheet name="Cover" r:id="r1"/><sheet name="Manual Review" r:id="r2"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels':strToU8('<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml':strToU8('<worksheet><sheetData><row><c r="A1"><v>ALIAS_SHARED_CELL</v></c></row></sheetData></worksheet>'),
  })),p=>reads.push(p));
  try{const a=await w.readSheet('sheet-1');const b=await w.readSheet('sheet-2');
    assert.equal(a.cells[0].value,'ALIAS_SHARED_CELL');assert.equal(b.cells[0].value,'ALIAS_SHARED_CELL');
    assert(reads.some(p=>p.includes('worksheets')));}finally{w.close();}
});
test('archive rejects traversal and XML entities without returning content',async()=>{
  await assert.rejects(Workbook.open(Buffer.from(zipSync({'../escape':strToU8('x')}))),/UNSAFE_ARCHIVE|INVALID_XLSX/);
  const w=await Workbook.open(Buffer.from(zipSync({'xl/workbook.xml':strToU8('<!DOCTYPE x [<!ENTITY e "SECRET">]><workbook/>'),'xl/_rels/workbook.xml.rels':strToU8('<Relationships/>')})));
  try{await assert.rejects(w.listSheets(),/UNSUPPORTED_XML/);}finally{w.close();}
});
test('shared strings release only selected cell references; formulas are never evaluated',async()=>{
  const base={
    'xl/workbook.xml':strToU8('<workbook xmlns:r="r"><sheets><sheet name="Cover" r:id="r1"/><sheet name="Manual Review" r:id="r2"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels':strToU8('<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml':strToU8('INVALID_XML_COVER_MUST_NOT_PARSE'),
    'xl/sharedStrings.xml':strToU8('<sst><si><t>SHARED_SECRET_CANARY</t></si><si><t>allowed</t></si></sst>'),
    'xl/worksheets/sheet2.xml':strToU8('<worksheet><sheetData><row><c r="A1" t="s"><v>1</v></c></row></sheetData></worksheet>'),
  };
  const w=await Workbook.open(Buffer.from(zipSync(base)));
  try{assert.deepEqual((await w.readSheet('sheet-2')).cells,[{ref:'A1',value:'allowed'}]);}finally{w.close();}
  base['xl/worksheets/sheet2.xml']=strToU8('<worksheet><sheetData><row><c r="A1"><f>Cover!A1</f><v>SECRET</v></c></row></sheetData></worksheet>');
  const f=await Workbook.open(Buffer.from(zipSync(base)));
  try{await assert.rejects(f.readSheet('sheet-2'),/FORMULA_REQUIRES_LOCAL_REVIEW/);}finally{f.close();}
});
test('ambiguity waits for human; unknown choices and cancellation do not authorize reads',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-listing-'));
  const s=new ListingService(root,'owner-a');
  const other=new ListingService(root,'owner-b');
  try{
    const w=await s.open('manual',undefined,true);
    // New contract: every sheet (Cover included) is offered; no name-based denial.
    let offered:string[]=[];
    await assert.rejects(s.readRequirements(w.workspaceId,async q=>{offered=q.options.map(o=>o.label);return [];}),/SHEET_SELECTION_REQUIRED/);
    assert(offered.some(l=>l.includes('Cover')),'Cover offered as a readable option');
    assert.deepEqual(s.inspect(w.workspaceId).selection,[]);
    await assert.rejects(s.readRequirements(w.workspaceId,async()=>['sheet-99: Nope']),/SHEET_SELECTION_REQUIRED/);
    const abort=new AbortController();
    await assert.rejects(s.readRequirements(w.workspaceId,async q=>{abort.abort();return [q.options[0].label];},abort.signal),/CANCELLED/);
    assert.deepEqual(s.inspect(w.workspaceId).selection,[]);
    const result=await s.readRequirements(w.workspaceId,async q=>[q.options.find(o=>o.label.includes('Manual Review')&&!o.label.includes('New'))!.label]);
    assert.equal(result.sheets.length,1);
    assert(!JSON.stringify(result).includes('CANARY'));
    await assert.rejects(other.readRequirements(w.workspaceId,async()=>[]),/UNKNOWN_WORKSPACE/);
  }finally{s.close();other.close();await rm(root,{recursive:true,force:true});}
});
test('all scenario paths deliver drafts with NOT_RUN status and no original data',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dm-listing-'));
  const s=new ListingService(root);
  try{
    await assert.rejects(s.open('pk'),/PK_SUBTYPE_REQUIRED/);
    for(const kind of SCENARIOS){
      const w=await s.open(kind,kind==='pk'?'be':undefined);
      let asks=0;
      await s.readRequirements(w.workspaceId,async q=>{asks++;return [q.options[0].label];});
      assert.equal(asks,kind==='medical'||kind==='pk'?1:0);
      await s.saveRequirements(w.workspaceId,[{id:'1',meaning:'Synthetic rule',condition:'all',columns:['Subject'],mapping:'schema',validation:'assert rows',unresolved:[]}]);
      await s.saveProgram(w.workspaceId,'# Synthetic draft\nprint("synthetic")\n');
      const d=await s.delivery(w.workspaceId);
      assert.equal(d.status,'CODE_DRAFT'); assert.equal(d.realDataQC,'NOT_RUN'); assert.equal(d.syntheticValidation,'NOT_RUN');
      assert((await readdir(d.outputDirectory)).some(n=>n.endsWith('.R')));
    }
    const sad=await s.open('pk','sad-mad');assert.equal(sad.pkType,'sad-mad');
    assert.throws(()=>s.inspect('../outside'),/UNKNOWN_WORKSPACE/);
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});
