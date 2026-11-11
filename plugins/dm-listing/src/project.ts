/** Project directory discovery and reading. Resource bounds only; no name-based data-security denial. */
import {readdir,lstat,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep,dirname} from 'node:path';
import {Workbook,ListingError,type AlsSheetContent} from './workbook.js';
import {readRegularFile,sha256} from './runner.js';

const MAX_FILES=5000,MAX_DEPTH=8,MAX_READ=16*1024*1024;
const LOCK=/^~\$/;
const EXCEL=/\.(xlsx|xlsm|xls)$/i,SAS=/\.(sas7bdat|xpt)$/i,TEXT=/\.(csv|txt|json|md|r|sas)$/i,RDS=/\.(rds|rdata|rda)$/i,ARCHIVE=/\.zip$/i,PROGRAM=/\.r$/i;
const KIND=(name:string)=>EXCEL.test(name)?'excel':SAS.test(name)?'sas':PROGRAM.test(name)?'program':TEXT.test(name)?'text':RDS.test(name)?'r-object':ARCHIVE.test(name)?'archive':'other';
export interface ProjectFile {path:string;name:string;kind:string;bytes:number;sha256:string;sha256Skipped?:string;}
export interface ProjectScan {
  directory:string;files:ProjectFile[];total:number;
  candidates:{specWorkbook:string[];alsWorkbook:string[];dataDirectories:string[];programs:string[]};
}
async function walk(root:string,current:string,depth:number,seenReal:Set<string>,files:ProjectFile[],
  digestLimit:number,inventoryLimit:number):Promise<void> {
  if(depth>MAX_DEPTH)throw new ListingError('PROJECT_DEPTH_LIMIT');
  const real=await realpath(current);
  if(seenReal.has(real))return;seenReal.add(real);
  for(const name of (await readdir(current)).sort()){
    if(LOCK.test(name)||name.startsWith('.'))continue;
    const path=join(current,name);
    const info=await lstat(path);
    if(info.isSymbolicLink())continue;
    if(info.isDirectory()){await walk(root,path,depth+1,seenReal,files,digestLimit,inventoryLimit);continue;}
    if(!info.isFile())continue;
    // Oversized files stay in the inventory with name/size/kind; only their content read is skipped,
    // so the listing never silently omits a large clinical data file.
    const relativePath=relative(root,path).split(sep).join('/');
    if(info.size>inventoryLimit){
      files.push({path:relativePath,name,kind:KIND(name),bytes:info.size,sha256:'',sha256Skipped:'INVENTORY_SIZE_LIMIT'});
      if(files.length>MAX_FILES)throw new ListingError('PROJECT_FILE_LIMIT');
      continue;
    }
    const bytes=info.size<=digestLimit?await readRegularFile(path,digestLimit):undefined;
    files.push({path:relativePath,name,kind:KIND(name),bytes:info.size,sha256:bytes?sha256(bytes):'',
      ...(bytes?{}:{sha256Skipped:'DIGEST_SIZE_LIMIT'})});
    if(files.length>MAX_FILES)throw new ListingError('PROJECT_FILE_LIMIT');
  }
}
/** Full inventory of a project directory. No security classification; limited by file/depth bounds only. */
export async function scanProject(directory:string,limits?:{digestLimit?:number;inventoryLimit?:number}):Promise<ProjectScan> {
  if(!directory||typeof directory!=='string'||directory.length>1024)throw new ListingError('PROJECT_DIRECTORY_INVALID');
  const digestLimit=limits?.digestLimit??8*1024*1024,inventoryLimit=limits?.inventoryLimit??256*1024*1024;
  if(!Number.isSafeInteger(digestLimit)||digestLimit<0||!Number.isSafeInteger(inventoryLimit)||inventoryLimit<digestLimit)throw new ListingError('PROJECT_DIRECTORY_INVALID');
  const root=await realpath(resolve(directory));
  if(!(await lstat(root)).isDirectory())throw new ListingError('PROJECT_DIRECTORY_INVALID');
  const files:ProjectFile[]=[];
  await walk(root,root,0,new Set(),files,digestLimit,inventoryLimit);
  const directories=new Set<string>();
  for(const file of files){let dir=dirname(file.path).split(sep).join('/');if(dir!=='.')directories.add(dir);}
  const candidates={specWorkbook:[] as string[],alsWorkbook:[] as string[],dataDirectories:[] as string[],programs:[] as string[]};
  for(const file of files){
    const lower=file.name.toLowerCase();
    if(file.kind==='excel'){
      if(/spec|dvp|需求/.test(lower))candidates.specWorkbook.push(file.path);
      if(/als|数据库定义|设计/.test(lower))candidates.alsWorkbook.push(file.path);
    }
    if(file.kind==='program')candidates.programs.push(file.path);
    if(file.kind==='sas'||file.kind==='r-object'||file.kind==='archive'){
      const dir=dirname(file.path).split(sep).join('/');
      if(dir!=='.'&&/raw|data|数据/i.test(dir))candidates.dataDirectories.push(dir);
    }
  }
  const unique=(list:string[],max:number)=>[...new Set(list)].slice(0,max);
  return {directory:root,files,total:files.length,candidates:{
    specWorkbook:unique(candidates.specWorkbook,50),alsWorkbook:unique(candidates.alsWorkbook,50),
    dataDirectories:unique(candidates.dataDirectories,50),programs:unique(candidates.programs,100)}};
}
/** Resolve a project-relative path and confirm it stays under the project root. */
async function locate(directory:string,path:string):Promise<{root:string;absolute:string}> {
  if(typeof path!=='string'||!path||path.length>1024||isAbsolute(path))throw new ListingError('PROJECT_PATH_INVALID');
  const root=await realpath(resolve(directory));
  const absolute=resolve(root,path);
  if(!isWithin(root,absolute))throw new ListingError('PROJECT_PATH_OUTSIDE_ROOT');
  const info=await lstat(absolute);
  if(!info.isFile()||info.isSymbolicLink())throw new ListingError('PROJECT_FILE_INVALID');
  return {root,absolute};
}
/** Read any sheet (Cover included) of a project workbook, with optional row window and integrity metadata. */
export async function readProjectWorksheet(directory:string,workbookPath:string,sheetId:string,window?:{startRow:number;endRow:number}) {
  const {absolute}=await locate(directory,workbookPath);
  const bytes=await readRegularFile(absolute,MAX_READ);
  const digest=sha256(bytes);
  const wb=await Workbook.open(bytes);
  try{
    const content:AlsSheetContent=await wb.readWorksheet(sheetId,window);
    return {workbookPath,workbookSha256:digest,sheet:content.sheet,cells:content.cells,mergedRanges:content.mergedRanges,
      hiddenRows:content.hiddenRows,hiddenColumns:content.hiddenColumns,warnings:content.warnings};
  }finally{wb.close();}
}
/** Read a non-workbook project artifact with size bound, digest and text/二进制分级返回. */
export async function readProjectArtifact(directory:string,path:string,limit=8*1024*1024) {
  const {absolute}=await locate(directory,path);
  const bytes=await readRegularFile(absolute,Math.min(limit,MAX_READ));
  const isText=/\.(csv|txt|json|md|r|sas|xml|yaml|yml)$/i.test(path);
  return {path,bytes:bytes.length,sha256:sha256(bytes),text:isText?bytes.toString('utf8'):undefined,
    base64:isText?undefined:bytes.toString('base64')};
}
export function isWithin(root:string,candidate:string):boolean {
  const rel=relative(root,candidate);
  return !isAbsolute(rel)&&!rel.startsWith('..');
}
