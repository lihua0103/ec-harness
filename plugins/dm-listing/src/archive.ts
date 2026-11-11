/** Data-archive intake: password-protected zip extraction for real-project SAS deliveries.
 *  Password derivation mirrors the delivered HXN6005 program (which itself aligns with the
 *  listing toolchain's archive_passwords.py candidate order): explicit password -> project
 *  directory name and its token combinations -> *.txt sidecar lines next to the zip -> zip
 *  file name tokens -> project .txt/.xlsx/.xls stems -> empty password. Traditional ZipCrypto
 *  decrypts in-process so passwords never appear in argv or logs; AES/strong-encrypted
 *  archives fall back to the operator's 7z (password visible in argv there, same as the
 *  delivered R programs). Extraction is inert: entries are written to a fresh caller-owned
 *  directory and never executed; the source zip is only read. */
import yauzl from 'yauzl';
import {createInflateRaw} from 'node:zlib';
import {spawn,spawnSync} from 'node:child_process';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {basename,dirname,join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createWriteStream,readdirSync,readFileSync,statSync,existsSync,constants} from 'node:fs';
import {mkdir,open,rm,readdir,lstat,copyFile,mkdtemp,unlink} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {ListingError} from './workbook.js';

// Operator-supplied data archives are the same trust level as the sas7bdat files this plugin
// already reads directly; the declared sizes are validated here and every extracted byte is
// CRC-32 verified while streaming to disk, so declared-size bombs cannot amplify silently.
const ARCHIVE_MAX_ENTRIES=2048,ARCHIVE_MAX_ENTRY=2*1024**3,ARCHIVE_MAX_TOTAL=8*1024**3;
const SIDEcar_LIMIT=64*1024,STEM_WALK_LIMIT=400;

const CRC_TABLE=new Uint32Array(256);
for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;CRC_TABLE[n]=c;}
/** Pre-finalized CRC-32 step; the ZipCrypto key schedule uses the same primitive. */
function crcStep(crc:number,byte:number):number{return CRC_TABLE[(crc^byte)&0xff]^(crc>>>8);}
function crcChunk(crc:number,chunk:Buffer):number{let c=crc;for(let i=0;i<chunk.length;i++)c=crcStep(c,chunk[i]);return c;}
function crcFinal(crc:number):number{return (crc^0xFFFFFFFF)>>>0;}

/** Traditional PKWARE (ZipCrypto) stream decryption; mirrors APPNOTE 6.0. */
class ZipCryptoDecode extends Transform {
  private k0=0x12345678;
  private k1=0x23456789;
  private k2=0x34567890;
  filled=0;
  readonly header=Buffer.alloc(12);
  constructor(password:string){super();for(const byte of Buffer.from(password,'utf8'))this.update(byte);}
  private update(byte:number){this.k0=crcStep(this.k0,byte);this.k1=(this.k1+(this.k0&0xff))>>>0;this.k1=(Math.imul(this.k1,134775813)+1)>>>0;this.k2=crcStep(this.k2,this.k1>>>24);}
  private keystream():number{const t=(this.k2|2)&0xffff;return (Math.imul(t,t^1)>>>8)&0xff;}
  /** Synchronous one-shot decode (used for the 12-byte password probe). */
  decodeBuffer(chunk:Buffer):Buffer{const out=Buffer.allocUnsafe(chunk.length);this.transformChunk(chunk,out);return out;}
  private transformChunk(chunk:Buffer,out:Buffer):void{
    for(let i=0;i<chunk.length;i++){
      const plain=chunk[i]^this.keystream();this.update(plain);out[i]=plain;
      if(this.filled<12)this.header[this.filled++]=plain;
    }
  }
  _transform(chunk:Buffer,_enc:string,cb:(e?:Error|null,data?:Buffer)=>void):void{
    try{const out=Buffer.allocUnsafe(chunk.length);this.transformChunk(chunk,out);cb(null,out);}
    catch(error){cb(error as Error);}
  }
}
/** Counts uncompressed bytes and CRC-32; over-limit output aborts the pipeline early. */
class VerifyTransform extends Transform {
  private crc=0xFFFFFFFF;bytes=0;
  constructor(private readonly limit:number){super();}
  _transform(chunk:Buffer,_enc:string,cb:(e?:Error|null,data?:Buffer)=>void):void{
    this.bytes+=chunk.length;
    if(this.bytes>this.limit){cb(new Error('inflated size exceeds declared entry size'));return;}
    this.crc=crcChunk(this.crc,chunk);cb(null,chunk);
  }
  finalCrc():number{return crcFinal(this.crc);}
}

/** Strips the 12-byte ZipCrypto encryption header after decryption and before inflation;
 *  the decrypted header is password evidence (its check byte) but not entry content. */
class EncryptionHeaderSkip extends Transform {
  private pending:Buffer=Buffer.alloc(0);
  _transform(chunk:Buffer,_enc:string,cb:(e?:Error|null,data?:Buffer)=>void):void{
    const buffer=this.pending.length?Buffer.concat([this.pending,chunk]):chunk;
    if(buffer.length<=12){this.pending=Buffer.from(buffer);cb(null,Buffer.alloc(0));return;}
    cb(null,buffer.subarray(12));
  }
}

class WrongPasswordError extends Error {}

// ---------------------------------------------------------------- passwords
/** R split_tokens: split on [_/.\s-]+, trim, drop empty. */
export function splitTokens(value:string):string[]{return value.split(/[_/.\s-]+/).map(t=>t.trim()).filter(t=>t.length>0);}
/** R token_pw: whole value, extension-stripped form, tokens (>=2 chars), consecutive-token
 *  combinations joined by '', '_' and '-', plus every run of >=2 digits. */
export function tokenCandidates(value:string):string[]{
  const out:string[]=[];const add=(v:string)=>{if(v&&!out.includes(v))out.push(v);};
  add(value);
  add(value.replace(/\.[^.]+$/,'')); // tools::file_path_sans_ext
  const tokens=splitTokens(value);
  for(const t of tokens)if(t.length>=2)add(t);
  if(tokens.length>=2)for(let s=0;s<tokens.length;s++)for(let e=s+1;e<tokens.length;e++)
    for(const glue of ['','_','-'])add(tokens.slice(s,e+1).join(glue));
  for(const n of value.match(/\d{2,}/g)??[])add(n);
  return out;
}
function walkFiles(root:string,limit:number):string[]{
  const out:string[]=[];const stack=[root];
  while(stack.length&&out.length<limit){
    const dir=stack.pop()!;let items;
    try{items=readdirSync(dir,{withFileTypes:true});}catch{continue;}
    for(const item of items){
      const path=join(dir,item.name);
      if(item.isDirectory())stack.push(path);else if(item.isFile())out.push(path);
      if(out.length>=limit)break;
    }
  }
  return out;
}
export interface ArchivePasswordSource {explicitPassword?:string;projectDir:string;dataDir?:string;}
/** Candidate order identical to the delivered program: explicit -> project dir tokens ->
 *  sidecar txt lines -> zip name tokens -> project doc stems -> empty. */
export function passwordCandidates(source:ArchivePasswordSource):string[]{
  const out:string[]=[];const add=(v:string)=>{if(v&&!out.includes(v))out.push(v);};
  add(source.explicitPassword??'');
  for(const v of tokenCandidates(basename(source.projectDir)))add(v);
  const dataDir=source.dataDir??source.projectDir;
  if(existsSync(dataDir)){
    for(const name of readdirSync(dataDir))if(/\.txt$/i.test(name)){
      let text='';try{
        const bytes=readFileSync(join(dataDir,name));
        text=(bytes.length>SIDEcar_LIMIT?bytes.subarray(0,SIDEcar_LIMIT):bytes).toString('utf8');
      }catch{continue;}
      // RBQM variant: each trimmed line is a candidate; HXN variant: the whole file collapsed.
      for(const line of text.split(/\r?\n/))add(line.trim());
      const collapsed=text.trim().replace(/\s+/g,' ');
      if(collapsed&&collapsed.length<=256)add(collapsed);
    }
    for(const name of readdirSync(dataDir))if(/\.zip$/i.test(name))for(const v of tokenCandidates(name))add(v);
  }
  for(const path of walkFiles(source.projectDir,STEM_WALK_LIMIT))
    if(/\.(txt|xlsx|xls)$/i.test(basename(path)))add(basename(path).replace(/\.[^.]+$/,''));
  out.push('');
  return out;
}

// ---------------------------------------------------------------- archive walking
interface OpenedArchive {zip:yauzl.ZipFile;fd:FileHandle;entries:yauzl.Entry[];}
async function openArchive(zipPath:string):Promise<OpenedArchive> {
  const fd=await open(zipPath,'r');
  return await new Promise<OpenedArchive>((resolve,reject)=>{
    yauzl.fromFd(fd.fd,{lazyEntries:true,autoClose:false,validateEntrySizes:true},(error,zip)=>{
      if(error||!zip){void fd.close().catch(()=>{});reject(new ListingError('ARCHIVE_OPEN_FAILED'));return;}
      const entries:yauzl.Entry[]=[];const seen=new Set<string>();let total=0;
      const fail=(code:string)=>{zip.close();void fd.close().catch(()=>{});reject(new ListingError(code));};
      // yauzl rejects traversal/absolute/backslash names during central-directory parsing,
      // before any entry event; map those to the same unsafe-entry code as the checks below.
      zip.on('error',(error:Error)=>{
        if(/invalid characters in fileName|absolute path|invalid relative path/.test(error.message))fail('ARCHIVE_ENTRY_UNSAFE');
        else fail('ARCHIVE_OPEN_FAILED');
      });
      zip.on('entry',(entry:yauzl.Entry)=>{
        const p=entry.fileName;
        total+=entry.uncompressedSize;
        const mode=(entry.externalFileAttributes>>>16)&0o170000;
        if(p.includes('\\')||p.startsWith('/')||p.includes(':')||p.split('/').includes('..')
          ||seen.has(p.toLowerCase())||mode===0o120000||entries.length>=ARCHIVE_MAX_ENTRIES
          ||entry.uncompressedSize>ARCHIVE_MAX_ENTRY||total>ARCHIVE_MAX_TOTAL||/vbaProject\.bin$/i.test(p)){fail('ARCHIVE_ENTRY_UNSAFE');return;}
        seen.add(p.toLowerCase());entries.push(entry);zip.readEntry();
      });
      zip.once('end',()=>resolve({zip,fd,entries}));
      zip.readEntry();
    });
  });
}
function openRawStream(zip:yauzl.ZipFile,entry:yauzl.Entry,start?:number,end?:number):Promise<Readable> {
  return new Promise((resolve,reject)=>{
    // decodeFileData:false yields the raw (still encrypted / still deflated) bytes; decryption
    // and inflation are performed here because yauzl cannot decode encrypted entries at all.
    // The runtime yauzl 3.4.0 accepts decodeFileData; bundled typings lag behind, hence the cast.
    zip.openReadStream(entry,{decodeFileData:false,start,end} as any, (error,stream)=>{
      if(error||!stream){reject(new ListingError('ARCHIVE_READ_FAILED'));return;}
      resolve(stream as Readable);
    });
  });
}
async function readRawRange(zip:yauzl.ZipFile,entry:yauzl.Entry,start:number,end:number):Promise<Buffer> {
  const stream=await openRawStream(zip,entry,start,end);
  return await new Promise<Buffer>((resolve,reject)=>{
    const chunks:Buffer[]=[];
    stream.on('data',(chunk:Buffer)=>chunks.push(chunk));
    stream.on('error',()=>reject(new ListingError('ARCHIVE_READ_FAILED')));
    stream.on('end',()=>resolve(Buffer.concat(chunks)));
  });
}
/** With a data descriptor the header check byte carries the time high byte instead of CRC. */
function headerCheckByte(entry:yauzl.Entry):number {
  return (entry.generalPurposeBitFlag&0x8)!==0?(entry.lastModFileTime>>>8)&0xff:(entry.crc32>>>24)&0xff;
}

// ---------------------------------------------------------------- extraction
async function ensureEmptyDestination(destination:string):Promise<void> {
  try {
    const info=await lstat(destination);
    if(!info.isDirectory()||info.isSymbolicLink()||(await readdir(destination)).length)
      throw new ListingError('ARCHIVE_DESTINATION_NOT_EMPTY');
  } catch(error) {
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    await mkdir(destination,{recursive:true});
  }
}
/** Commit only verified files; rollback removes exclusively files created by this commit.
 *  A collision never removes the caller's file. Rollback failure is reported explicitly. */
async function copyExtractedFiles(source:string,destination:string,files:string[]):Promise<void> {
  const created:string[]=[];
  try {
    for(const file of files){
      const from=join(source,file),to=join(destination,file);
      await mkdir(dirname(to),{recursive:true});
      await copyFile(from,to,constants.COPYFILE_EXCL);
      created.push(to);
    }
  } catch(error) {
    const cleanup=await Promise.allSettled(created.map(file=>unlink(file)));
    if(cleanup.some(result=>result.status==='rejected'))
      throw new ListingError('ARCHIVE_COMMIT_CLEANUP_FAILED');
    throw new ListingError(`ARCHIVE_COMMIT_FAILED: ${(error as NodeJS.ErrnoException).code??'UNKNOWN'}`);
  }
}
async function extractWithZipCrypto(opened:OpenedArchive,password:string|null,destination:string):Promise<string[]> {
  const files:string[]=[];
  for(const entry of opened.entries){
    if(entry.fileName.endsWith('/')){await mkdir(join(destination,entry.fileName),{recursive:true});continue;}
    const target=join(destination,entry.fileName);
    await mkdir(dirname(target),{recursive:true});
    const decode=password===null?null:new ZipCryptoDecode(password);
    const verify=new VerifyTransform(entry.uncompressedSize);
    const parts:Transform[]=[];
    if(decode){parts.push(decode,new EncryptionHeaderSkip());}
    if(entry.compressionMethod===8)parts.push(createInflateRaw());
    parts.push(verify);
    const stream=await openRawStream(opened.zip,entry);
    try{await pipeline([stream,...parts,createWriteStream(target,{flags:'wx'})]);}
    catch(error){throw new WrongPasswordError(String((error as Error)?.message??error).slice(0,200));}
    if(decode&&decode.filled===12&&decode.header[11]!==headerCheckByte(entry))throw new WrongPasswordError('header check byte mismatch');
    if(verify.bytes!==entry.uncompressedSize||verify.finalCrc()!==entry.crc32)throw new WrongPasswordError('crc32 mismatch');
    files.push(entry.fileName);
  }
  return files;
}
function findSevenZip():string|null {
  const roots=[process.env['ProgramFiles'],process.env['ProgramFiles(x86)'],'C:\\Program Files'].filter(Boolean) as string[];
  for(const root of roots){const candidate=join(root,'7-Zip','7z.exe');try{if(statSync(candidate).isFile())return candidate;}catch{/* keep looking */}}
  for(const name of ['7z','7za','7zz']){const probe=spawnSync(name,['-h'],{timeout:5000,windowsHide:true});if(!probe.error)return name;}
  return null;
}
// 7z receives the password through argv: the only channel it offers. This mirrors the delivered
// R programs and is reached solely for AES/strong-encrypted archives; ZipCrypto never shells out.
function runSevenZip(exe:string,args:string[]):Promise<number> {
  return new Promise(resolve=>{
    const child=spawn(exe,args,{windowsHide:true});
    const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
    child.once('error',()=>{clearTimeout(timer);resolve(1);});
    child.once('close',code=>{clearTimeout(timer);resolve(code??1);});
  });
}
async function listExtractedFiles(root:string):Promise<string[]> {
  const out:string[]=[];const stack=[root];
  while(stack.length&&out.length<ARCHIVE_MAX_ENTRIES){
    const dir=stack.pop()!;
    let items;try{items=readdirSync(dir,{withFileTypes:true});}catch{continue;}
    for(const item of items){
      const path=join(dir,item.name);
      if(item.isDirectory())stack.push(path);else if(item.isFile())out.push(path);
    }
  }
  return out.sort();
}
export interface ExtractOptions {password?:string;projectDir:string;}
export interface ExtractResult {usedPassword:string;passwordSource:'explicit'|'derived'|'none';engine:'zipcrypto'|'7z';files:string[];}
/** Extract into an absent or empty directory. Caller content is never removed; failed password/
 *  integrity attempts are cleaned only inside a private staging directory owned by this call. */
export async function extractArchive(zipPath:string,destination:string,options:ExtractOptions):Promise<ExtractResult> {
  await ensureEmptyDestination(destination);
  const opened=await openArchive(zipPath);
  const staging=await mkdtemp(join(tmpdir(),'listing-archive-'));
  try{
    const fileEntries=opened.entries.filter(e=>!e.fileName.endsWith('/'));
    if(!fileEntries.length)throw new ListingError('ARCHIVE_EMPTY');
    const candidates=passwordCandidates({explicitPassword:options.password,projectDir:options.projectDir,dataDir:dirname(zipPath)});
    if(!fileEntries.some(e=>e.isEncrypted())){
      const files=await extractWithZipCrypto(opened,null,staging);
      await copyExtractedFiles(staging,destination,files);
      return {usedPassword:'',passwordSource:'none',engine:'zipcrypto',files};
    }
    const strong=fileEntries.some(e=>(e.generalPurposeBitFlag&0x40)!==0||e.extraFields.some(f=>f.id===0x9901));
    if(strong){
      const exe=findSevenZip();
      if(!exe)throw new ListingError('ZIP_ENCRYPTION_UNSUPPORTED: AES/强加密zip需要本机7-Zip，或改投ZipCrypto包');
      for(const pw of candidates){
        if(!pw)continue;
        await rm(staging,{recursive:true,force:true});await mkdir(staging,{recursive:true});
        if(await runSevenZip(exe,['x','-y',`-p${pw}`,`-o${staging}`,zipPath])===0){
          const files=(await listExtractedFiles(staging)).map(path=>relative(staging,path).replaceAll('\\','/'));
          if(files.length){await copyExtractedFiles(staging,destination,files);return {usedPassword:pw,passwordSource:pw===options.password?'explicit':'derived',engine:'7z',files};}
        }
      }
      throw new ListingError(`ARCHIVE_PASSWORD_NOT_RESOLVED: 已尝试候选密码 ${candidates.filter(Boolean).length} 个(AES/7z)；可将含密码行的txt置于zip同目录后重试`);
    }
    // ZipCrypto: probe the first encrypted entry's 12-byte header to discard candidates cheaply,
    // then attempt a full CRC-verified extraction for each surviving candidate.
    const probe=fileEntries.find(e=>e.isEncrypted())!,expected=headerCheckByte(probe);
    for(const pw of candidates){
      const raw=await readRawRange(opened.zip,probe,0,12);
      if(new ZipCryptoDecode(pw).decodeBuffer(raw)[11]!==expected)continue;
      try{
        const files=await extractWithZipCrypto(opened,pw,staging);
        await copyExtractedFiles(staging,destination,files);
        return {usedPassword:pw,passwordSource:pw===''?'none':pw===options.password?'explicit':'derived',engine:'zipcrypto',files};
      }catch(error){
        if(error instanceof ListingError)throw error;
        await rm(staging,{recursive:true,force:true});await mkdir(staging,{recursive:true});
      }
    }
    throw new ListingError(`ARCHIVE_PASSWORD_NOT_RESOLVED: 已尝试候选密码 ${candidates.length} 个(含无密码)；可将含密码行的txt置于zip同目录，包损坏也会落入此错误`);
  }finally{opened.zip.close();await opened.fd.close().catch(()=>{});await rm(staging,{recursive:true,force:true});}
}
