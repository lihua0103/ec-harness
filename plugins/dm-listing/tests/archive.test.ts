import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir,cp,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {zipSync,strToU8} from 'fflate';
import {passwordCandidates,tokenCandidates,extractArchive} from '../src/archive.ts';
import {describeDataset,runRExpression,type DatasetDescription} from '../src/datasets.ts';
import {type RuntimeSpec} from '../src/runner.ts';

const runtime:RuntimeSpec={
  executable:process.env.DSH_LISTING_R_EXECUTABLE??'D:/package/R-4.5.0/bin/x64/Rterm.exe',
  home:process.env.DSH_LISTING_R_HOME??'D:/package/R-4.5.0',
  kind:process.env.DSH_LISTING_R_KIND==='Rscript'?'Rscript':'Rterm',
};
const rPath=(p:string)=>p.replaceAll('\\','/');
const SEVENZIP='C:/Program Files/7-Zip/7z.exe';
const HAS_7Z=existsSync(SEVENZIP);

let root:string,sasBytes:Buffer;

before(async()=>{
  root=await mkdtemp(join(tmpdir(),'dm-archive-'));
  const sasPath=join(root,'sd.sas7bdat');
  // 纯合成标识与数值，不含任何真实临床数据。
  const created=await runRExpression(runtime,
    `ok <- tryCatch({haven::write_sas(data.frame(USUBJID=c('S001','S002','S003'),AVAL=c(1.5,2.5,3.5),TRT=c('A','B','A')), '${rPath(sasPath)}'); 'OK'}, error=function(e) conditionMessage(e)); cat(ok)`);
  assert.equal(created.code,0,created.stderr);
  assert.match(created.stdout,/OK/);
  sasBytes=await readFile(sasPath);
});

after(async()=>{if(root)await rm(root,{recursive:true,force:true});});

test('token derivation mirrors the delivered R program: value, sans-ext, tokens, combos, numbers',()=>{
  const out=tokenCandidates('HXN6005_A1-201.zip');
  assert.deepEqual(out.slice(0,6),['HXN6005_A1-201.zip','HXN6005_A1-201','HXN6005','A1','201','zip']);
  assert.ok(out.includes('HXN6005_A1')&&out.includes('HXN6005-A1-201')&&out.includes('A1-201'));
  assert.equal(out[out.length-1],'6005'); // 数字候选最后追加；'201' 已在 token 中去重
});

test('password candidates follow the delivered order: explicit -> project tokens -> sidecar -> zip name -> stems -> empty',async()=>{
  const proj=join(root,'pw-order','PROJ-A'),dataDir=join(proj,'data');
  await mkdir(dataDir,{recursive:true});
  await writeFile(join(dataDir,'pw.txt'),'SIDE3CRET\n');
  await writeFile(join(dataDir,'pack.zip'),'PK');
  const out=passwordCandidates({explicitPassword:'EXPL1',projectDir:proj,dataDir});
  assert.equal(out[0],'EXPL1');
  assert.deepEqual(out.slice(1,5),['PROJ-A','PROJ','PROJA','PROJ_A']);
  assert.ok(out.includes('SIDE3CRET')&&out.includes('pack')&&out.includes('pw')&&out.includes('pack-zip'));
  assert.equal(out[out.length-1],'');
});

test('ZipCrypto archive extracts with sidecar-derived password; bytes roundtrip identical',async t=>{
  if(!HAS_7Z)return t.skip('需要7-Zip构造加密fixture');
  const dir=join(root,'derive');await mkdir(dir,{recursive:true});
  await cp(join(root,'sd.sas7bdat'),join(dir,'sd.sas7bdat'));
  await writeFile(join(dir,'pw.txt'),'HXN6005\n');
  const packed=spawnSync(SEVENZIP,['a','-tzip','-mem=ZipCrypto','-pHXN6005',join(dir,'data.zip'),'sd.sas7bdat'],{cwd:dir});
  assert.equal(packed.status,0,packed.stderr.toString());
  const result=await extractArchive(join(dir,'data.zip'),join(dir,'out'),{projectDir:join(dir,'PROJ-X')});
  assert.equal(result.engine,'zipcrypto');
  assert.equal(result.usedPassword,'HXN6005');
  assert.equal(result.passwordSource,'derived');
  const extracted=await readFile(join(dir,'out','sd.sas7bdat'));
  assert.equal(createHash('sha256').update(extracted).digest('hex'),createHash('sha256').update(sasBytes).digest('hex'));
});

test('describeDataset reads synthetic sas7bdat directly through local R',async()=>{
  const d=await describeDataset(runtime,join(root,'sd.sas7bdat'));
  assert.equal(d.kind,'sas');
  assert.equal(d.tables.length,1);
  assert.deepEqual(d.tables[0].columns,['USUBJID','AVAL','TRT']);
  assert.equal(d.tables[0].rows,3);
});

test('describeDataset opens an encrypted zip data package end-to-end (derive password -> extract -> R describe)',async t=>{
  if(!HAS_7Z)return t.skip('需要7-Zip构造加密fixture');
  const dir=join(root,'derive'); // 复用上一用例构造的 data.zip（含 sidecar 密码 HXN6005）
  const d=await describeDataset(runtime,join(dir,'data.zip'),5,undefined,{projectDir:join(dir,'PROJ-X')});
  assert.equal(d.kind,'zip');
  assert.deepEqual(d.tables.map(tb=>tb.name),['sd']);
  assert.deepEqual(d.tables[0].columns,['USUBJID','AVAL','TRT']);
  assert.equal(d.tables[0].rows,3);
  assert.equal((d.tables[0].sample as Array<Record<string,unknown>>)[0].USUBJID,'S001');
});

test('unresolvable password fails explicitly with the tried-candidate count',async t=>{
  if(!HAS_7Z)return t.skip('需要7-Zip构造加密fixture');
  const dir=join(root,'wrongpw');await mkdir(dir,{recursive:true});
  await cp(join(root,'sd.sas7bdat'),join(dir,'sd.sas7bdat'));
  const packed=spawnSync(SEVENZIP,['a','-tzip','-mem=ZipCrypto','-pHXN6005',join(dir,'enc2.zip'),'sd.sas7bdat'],{cwd:dir});
  assert.equal(packed.status,0,packed.stderr.toString());
  await assert.rejects(
    extractArchive(join(dir,'enc2.zip'),join(dir,'out'),{password:'totally-wrong',projectDir:join(dir,'PROJ-Y')}),
    /ARCHIVE_PASSWORD_NOT_RESOLVED/);
});

test('AES-encrypted archives fall back to the operator 7z with derived password',async t=>{
  if(!HAS_7Z)return t.skip('需要7-Zip构造AES fixture');
  const dir=join(root,'aes');await mkdir(dir,{recursive:true});
  await cp(join(root,'sd.sas7bdat'),join(dir,'sd.sas7bdat'));
  await writeFile(join(dir,'pw.txt'),'AESPW99\n');
  const packed=spawnSync(SEVENZIP,['a','-tzip','-mem=AES256','-pAESPW99',join(dir,'aes.zip'),'sd.sas7bdat'],{cwd:dir});
  assert.equal(packed.status,0,packed.stderr.toString());
  const result=await extractArchive(join(dir,'aes.zip'),join(dir,'out'),{projectDir:join(dir,'PROJ-Z')});
  assert.equal(result.engine,'7z');
  assert.equal(result.usedPassword,'AESPW99');
  const extracted=await readFile(join(dir,'out','sd.sas7bdat'));
  assert.equal(createHash('sha256').update(extracted).digest('hex'),createHash('sha256').update(sasBytes).digest('hex'));
});

test('non-empty destinations are rejected without removing caller content',async()=>{
  const dir=join(root,'nonempty');await mkdir(join(dir,'out'),{recursive:true});
  const archive=join(dir,'data.zip'),marker=join(dir,'out','keep.txt');
  await writeFile(archive,Buffer.from(zipSync({'safe.csv':strToU8('A\\n1\\n')})));
  await writeFile(marker,'caller-owned');
  await assert.rejects(extractArchive(archive,join(dir,'out'),{projectDir:dir}),/ARCHIVE_DESTINATION_NOT_EMPTY/);
  assert.equal(await readFile(marker,'utf8'),'caller-owned');
});

test('invalid archives do not damage an existing empty destination',async()=>{
  const dir=join(root,'invalid');await mkdir(join(dir,'out'),{recursive:true});
  const archive=join(dir,'broken.zip');await writeFile(archive,'not a zip');
  await assert.rejects(extractArchive(archive,join(dir,'out'),{projectDir:dir}),/ARCHIVE_OPEN_FAILED/);
  assert.deepEqual(await readdir(join(dir,'out')),[]);
});

test('plain unencrypted zip extracts without decryption',async()=>{
  const dir=join(root,'plain');await mkdir(dir,{recursive:true});
  const archive=join(dir,'data.zip');
  await writeFile(archive,Buffer.from(zipSync({'nested/synthetic.csv':strToU8('A\n1\n2\n')})));
  const result=await extractArchive(archive,join(dir,'out'),{projectDir:dir});
  assert.equal(result.passwordSource,'none');
  assert.deepEqual(result.files,['nested/synthetic.csv']);
  assert.equal(await readFile(join(dir,'out','nested','synthetic.csv'),'utf8'),'A\n1\n2\n');
});

test('path-traversal entries are rejected before any byte is written',async()=>{
  const dir=join(root,'evil');await mkdir(dir,{recursive:true});
  const archive=join(dir,'data.zip');
  await writeFile(archive,Buffer.from(zipSync({'../evil.txt':strToU8('nope')})));
  await assert.rejects(extractArchive(archive,join(dir,'out'),{projectDir:dir}),/ARCHIVE_ENTRY_UNSAFE/);
  assert(!existsSync(join(dir,'evil.txt')));
});
