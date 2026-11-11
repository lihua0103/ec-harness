import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {unzipSync,zipSync,strToU8} from 'fflate';
import {runLocalSynthetic,type RuntimeSpec} from '../src/runner.ts';
import {verifyExcel} from '../src/artifacts.ts';
import {outputContract,OUTPUT_CONTRACT_VERSION} from '../src/output-contract.ts';
import {demo} from '../src/demo.ts';
import {referenceProgram} from './fixtures/reference-programs.ts';
import {ListingService} from '../src/service.ts';
const runtime:RuntimeSpec={executable:process.env.DSH_LISTING_R_EXECUTABLE??'D:/package/R-4.5.0/bin/x64/Rterm.exe',
  home:process.env.DSH_LISTING_R_HOME??'D:/package/R-4.5.0',kind:process.env.DSH_LISTING_R_KIND==='Rscript'?'Rscript':'Rterm'};

test('CSV alone, RDS type/class/missing/trailing changes and Excel value changes cannot pass',async()=>{
  const root=await mkdtemp(join(tmpdir(),'listing-artifact-negative-'));
  const base=referenceProgram('manual');
  const cases=[
    {name:'csv-only',code:base.slice(0,base.indexOf('openxlsx::'))},
    {name:'xlsx-values',code:base+'o$Value[1] <- "wrong"\nopenxlsx::write.xlsx(list(Listing=o), "output.xlsx", overwrite=TRUE)\n'},
    {name:'rds-logical-type',code:base+'o$DuplicateFlag <- as.character(o$DuplicateFlag)\nsaveRDS(o,"output.rds",version=2,compress=FALSE)\n'},
    {name:'rds-custom-class',code:base+'class(o) <- c("unreviewed", "data.frame")\nsaveRDS(o,"output.rds",version=2,compress=FALSE)\n'},
    {name:'rds-column-attributes',code:base+'attr(o$Value,"label") <- "unreviewed"\nsaveRDS(o,"output.rds",version=2,compress=FALSE)\n'},
    {name:'rds-empty-not-na',code:base+'o$Value[is.na(o$Value)] <- ""\nsaveRDS(o,"output.rds",version=2,compress=FALSE)\n'},
    {name:'rds-trailing',code:base+'con <- file("output.rds","ab"); writeBin(as.raw(1),con); close(con)\n'},
    {name:'rds-compressed',code:base+'saveRDS(o,"output.rds",version=2,compress=TRUE)\n'},
    {name:'rds-value',code:base+'o$Value[1] <- "wrong"\nsaveRDS(o,"output.rds",version=2,compress=FALSE)\n'},
  ];
  try {
    for(const c of cases){
      const directory=join(root,c.name);await mkdir(directory);
      const receipt=await runLocalSynthetic({runId:randomUUID(),directory,code:c.code,input:demo('manual').data,scenario:'manual',runtime});
      assert.equal(receipt.status,'FAILED',c.name+': '+JSON.stringify(receipt));
      assert.equal(receipt.check?.passed,false,c.name);assert.equal(receipt.artifacts,undefined,c.name);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Excel rejects formulas, extra/hidden cells, external references, wrong cell types and unsupported parts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'listing-excel-negative-'));
  try {
    const receipt=await runLocalSynthetic({runId:randomUUID(),directory:root,code:referenceProgram('manual'),input:demo('manual').data,scenario:'manual',runtime});
    assert.equal(receipt.status,'PASSED');assert.equal(receipt.artifacts?.version,OUTPUT_CONTRACT_VERSION);
    const csv=await readFile(join(root,'output.csv'),'utf8'),xlsx=await readFile(join(root,'output.xlsx'));
    const original=unzipSync(xlsx);
    const sheet='xl/worksheets/sheet1.xml',rels='xl/_rels/workbook.xml.rels';
    const text=(path:string)=>Buffer.from(original[path]).toString('utf8');
    const mutations:Array<Record<string,Uint8Array>>=[
      {[sheet]:strToU8(text(sheet).replace('<c r="A2" t="s">','<c r="A2" t="s"><f>Cover!A1</f>'))},
      {[sheet]:strToU8(text(sheet).replace('</sheetData>','<row r="20"><c r="A20" t="n"><v>999</v></c></row></sheetData>'))},
      {[sheet]:strToU8(text(sheet).replace('<row r="2">','<row r="2" hidden="1">'))},
      {[sheet]:strToU8(text(sheet).replace('<c r="E2" t="b">','<c r="E2" t="n">'))},
      {[rels]:strToU8(text(rels).replace('Target="worksheets/sheet1.xml"','TargetMode="External" Target="https://example.invalid/data"'))},
      {'xl/embeddings/oleObject1.bin':new Uint8Array([1,2,3])},
    ];
    for(const change of mutations)await assert.rejects(verifyExcel('manual',undefined,csv,Buffer.from(zipSync({...original,...change}))));
    const numericStrings=unzipSync(xlsx);
    numericStrings['xl/sharedStrings.xml']=strToU8(Buffer.from(numericStrings['xl/sharedStrings.xml']).toString().replace('SYN001','=HYPERLINK("https://example.invalid")'));
    await assert.rejects(verifyExcel('manual',undefined,csv,Buffer.from(zipSync(numericStrings))),/OUTPUT_XLSX_UNSAFE_TEXT/);
    assert.equal(outputContract('pk','be').columns.find(c=>c.name==='Concentration')!.type,'character');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('delivery binds Excel/RDS snapshots and refuses altered or missing format evidence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'listing-artifact-delivery-'));const service=new ListingService(root,'owner');
  try{
    const w=await service.open('manual');await service.readRequirements(w.workspaceId,async()=>[]);
    await service.saveRequirements(w.workspaceId,[{id:'1',meaning:'synthetic',condition:'all',columns:['Subject'],mapping:'schema',validation:'QC',unresolved:[]}]);
    const saved=await service.saveProgram(w.workspaceId,referenceProgram('manual'));
    assert.equal(saved.executionContract.version,OUTPUT_CONTRACT_VERSION);
    const receipt=await service.validateSynthetic(w.workspaceId,runtime,async()=>true);assert.equal(receipt.status,'PASSED');
    const d=await service.delivery(w.workspaceId),z=unzipSync(await readFile(join(d.outputDirectory,d.archiveFile)));
    assert(z['output.xlsx']);assert(z['output.rds']);assert(z['output-contract.json']);
    for(const name of ['output.xlsx','output.rds']) {
      const path=join(w.outputDirectory,`run-${receipt.runId}`,name),before=await readFile(path);
      await writeFile(path,'tampered');await assert.rejects(service.delivery(w.workspaceId),/OUTPUT_ARTIFACT_CHANGED/);
      await writeFile(path,before);
    }
    assert.equal((await service.delivery(w.workspaceId)).status,'SYNTHETIC_VALIDATED');
  }finally{service.close();await rm(root,{recursive:true,force:true});}
});
