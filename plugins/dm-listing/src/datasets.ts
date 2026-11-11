/** R runtime discovery and dataset description. Real diagnostics are returned; nothing is silently hidden. */
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,extname,dirname,basename} from 'node:path';
import {extractArchive} from './archive.js';
import {probeRuntime,type RuntimeSpec} from './runner.js';
import {ListingError} from './workbook.js';
const MAX_LOG=200*1024,MAX_STDOUT=4*1024*1024;
export async function resolveRuntime(config?:Partial<RuntimeSpec>):Promise<RuntimeSpec> {
  const executable=config?.executable??process.env.DSH_LISTING_R_EXECUTABLE;
  const home=config?.home??process.env.DSH_LISTING_R_HOME;
  const kind=config?.kind??(process.env.DSH_LISTING_R_KIND==='Rscript'?'Rscript':'Rterm');
  if(!executable||!home||(kind!=='Rterm'&&kind!=='Rscript'))throw new ListingError('OPERATOR_R_CONFIG_REQUIRED');
  const runtime:RuntimeSpec={executable,home,kind};
  await probeRuntime(runtime);return runtime;
}
function runR(runtime:RuntimeSpec,scriptPath:string,cwd:string,args:string[],signal?:AbortSignal,timeoutMs=60000):Promise<{stdout:string;stderr:string;code:number|null;truncated:boolean}> {
  if(signal?.aborted)return Promise.reject(new ListingError('CANCELLED'));
  return new Promise((resolveRun,reject)=>{
    const argv=runtime.kind==='Rterm'
      ? ['--vanilla','--slave',`--file=${scriptPath}`,'--args',...args]
      : ['--vanilla',scriptPath,...args];
    // Normal environment is inherited deliberately; only R_HOME/PATH are anchored to the chosen runtime.
    const env:NodeJS.ProcessEnv={...process.env,R_HOME:runtime.home,PATH:[join(runtime.home,'bin'),join(runtime.home,'bin','x64'),process.env.PATH??''].filter(Boolean).join(';')};
    const child=spawn(runtime.executable,argv,{cwd,env,shell:false,windowsHide:true,detached:process.platform!=='win32'});
    let stdout='',stderr='',truncated=false,done=false,closed=false;
    let stopReason: 'CANCELLED'|'R_CHECK_TIMEOUT'|null=null;
    let spawnError=false,exitCode:number|null=null;
    let killerDone:Promise<void>=Promise.resolve();
    let escalation:ReturnType<typeof setTimeout>|undefined;
    const finish=()=>{
      if(done||!closed)return;
      done=true;
      void killerDone.then(()=>{
        if(spawnError)reject(new ListingError('RUNTIME_SPAWN_FAILED'));
        else if(stopReason)reject(new ListingError(stopReason));
        else resolveRun({stdout,stderr,code:exitCode,truncated});
      });
    };
    const terminate=(reason:'CANCELLED'|'R_CHECK_TIMEOUT')=>{
      if(done||closed||stopReason)return;
      stopReason=reason;
      const kill=(force:boolean)=>{
        // Never target a PID after the owned child has exited (it could be reused).
        if(closed||child.exitCode!==null||child.signalCode!==null)return;
        if(process.platform==='win32'&&child.pid){
          killerDone=new Promise<void>(resolveKill=>{
            const killer=spawn(join(process.env.SystemRoot??'C:\\Windows','System32','taskkill.exe'),
              ['/PID',String(child.pid),'/T',...(force?['/F']:[])],{windowsHide:true,shell:false});
            killer.once('error',()=>{if(!closed)child.kill(force?'SIGKILL':'SIGTERM');});
            killer.once('close',code=>{if(code!==0&&!closed)child.kill(force?'SIGKILL':'SIGTERM');resolveKill();});
          });
        } else if(child.pid){
          try{process.kill(-child.pid,force?'SIGKILL':'SIGTERM');}catch{child.kill(force?'SIGKILL':'SIGTERM');}
        }
      };
      kill(false);
      escalation=setTimeout(()=>{void killerDone.then(()=>kill(true));},500);
    };
    const timer=setTimeout(()=>terminate('R_CHECK_TIMEOUT'),Math.min(Math.max(timeoutMs,1000),120000));
    const abort=()=>terminate('CANCELLED');
    const cleanup=()=>{clearTimeout(timer);clearTimeout(escalation);signal?.removeEventListener('abort',abort);};
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    child.stdout.on('data',(b:Buffer)=>{if(stdout.length<MAX_STDOUT)stdout+=b.toString('utf8');else truncated=true;});
    child.stderr.on('data',(b:Buffer)=>{if(stderr.length<MAX_LOG)stderr+=b.toString('utf8');else truncated=true;});
    child.once('error',()=>{spawnError=true;closed=true;cleanup();finish();});
    child.once('close',code=>{closed=true;exitCode=code;cleanup();finish();});
  });
}
/** Inspect CSV/RDS/RData files through R: object names, size, columns and typed sample rows. */
export interface DatasetTable {name:string;rows:number|null;columns:string[]|null;classes:Record<string,string>|null;sample:Array<Record<string,unknown>>|null;error?:string;}
export interface DatasetDescription {source:string;kind:string;tables:DatasetTable[];warnings:string[];stderr:string;stdoutTruncated:boolean;}
export function datasetKind(path:string):'sas'|'xpt'|'csv'|'rds'|'rdata'|'zip' {
  const ext=extname(path).toLowerCase();
  return ext==='.sas7bdat'?'sas':ext==='.xpt'?'xpt':ext==='.csv'?'csv':ext==='.rds'?'rds':ext==='.rdata'||ext==='.rda'?'rdata':ext==='.zip'?'zip':'csv';
}
const DESCRIBE_R=`
args <- commandArgs(trailingOnly = TRUE)
path <- args[[1]]; max_rows <- as.integer(args[[2]]); kind <- args[[3]]
emit <- function(tables, warnings) {
  payload <- list(tables = unname(tables), warnings = warnings)
  cat("DSH_RESULT=", jsonlite::toJSON(payload, auto_unbox = TRUE, na = "null"), "\\n", sep = "")
}
# Collect every data.frame reachable from the top object (named listing lists included);
# non-frame leaves become skipped warnings instead of aborting the whole read.
flatten <- function(value, prefix = "") {
  frames <- list(); skipped <- character(0)
  if (is.data.frame(value)) { frames[[paste0(prefix, "dataset")]] <- value; return(list(frames = frames, skipped = skipped)) }
  if (is.list(value)) {
    labels <- names(value); unnamed <- is.null(labels)
    for (i in seq_along(value)) {
      label <- if (unnamed) paste0(prefix, "[[", i, "]]") else paste0(prefix, labels[[i]])
      element <- value[[i]]
      if (is.data.frame(element)) frames[[label]] <- element
      else if (is.list(element) && !is.environment(element)) {
        nested <- flatten(element, paste0(label, if (unnamed) "" else "$"))
        frames <- c(frames, nested$frames); skipped <- c(skipped, nested$skipped)
      } else skipped <- c(skipped, paste0(label, " (", paste(class(element), collapse = "/"), ")"))
    }
  }
  list(frames = frames, skipped = skipped)
}
read_any <- function(path, kind) {
  if (kind == "csv") return(list(frames = list(dataset = utils::read.csv(path, check.names = FALSE, colClasses = "character", na.strings = NULL)), skipped = character(0)))
  if (kind == "rds") {
    v <- readRDS(path)
    result <- flatten(v)
    if (!length(result$frames)) stop(paste0("RDS object is ", paste(class(v), collapse = "/"), " with no data.frame or listing list"))
    return(result)
  }
  if (kind == "rdata") {
    env <- new.env(parent = emptyenv()); load(path, envir = env)
    frames <- list(); skipped <- character(0)
    for (name in ls(env)) {
      value <- get(name, envir = env, inherits = FALSE)
      # A variable that is itself a data.frame keeps its bare name; nested lists flatten under name$...
      if (is.data.frame(value)) { frames[[name]] <- value; next }
      result <- flatten(value, paste0(name, "$"))
      frames <- c(frames, result$frames); skipped <- c(skipped, result$skipped)
    }
    if (!length(frames)) stop("RData contains no data.frame or listing list")
    return(list(frames = frames, skipped = skipped))
  }
  if (!requireNamespace("haven", quietly = TRUE)) stop("haven package is required for SAS/XPT")
  if (kind == "xpt") return(list(frames = list(dataset = haven::read_xport(path)), skipped = character(0)))
  list(frames = list(dataset = haven::read_sas(path)), skipped = character(0))
}
tables <- list(); warnings <- character(0)
# The "<<-" operator typed directly in the top-level tryCatch expression skips the global binding and hits the
# locked base function "warnings"; appends must go through a closure so the search starts one frame up.
add_warning <- function(text) warnings <<- c(warnings, text)
tryCatch({
  result <- read_any(path, kind)
  labels <- names(result$frames)
  if (anyDuplicated(labels)) labels <- make.unique(labels)
  for (i in seq_along(result$frames)) {
    name <- labels[[i]]
    frame <- result$frames[[i]]
    cols <- names(frame); classes <- vapply(frame, function(x) paste(class(x), collapse = "/"), character(1))
    sample <- utils::head(frame, max_rows)
    tables[[name]] <- list(name = name, rows = nrow(frame), columns = cols, classes = as.list(classes), sample = sample, error = NULL)
  }
  if (length(result$skipped)) add_warning(paste0("skipped non-data.frame: ", paste(result$skipped, collapse = "; ")))
}, error = function(e) add_warning(conditionMessage(e)))
emit(tables, warnings)
`;
/** Reads through a private temp script; cwd is the temp dir so no project file is written. */
const asStringArray=(value:unknown):string[]|null=>value==null?null:Array.isArray(value)?value.map(String):[String(value)];
// jsonlite auto_unbox also collapses length-1 collections (columns, warnings); normalize the whole protocol once
// here instead of patching field by field when new single-element cases appear.
function normalizeTable(value:unknown):DatasetTable {
  const table=(value??{}) as Record<string,unknown>;
  const classes=table.classes;
  return {name:String(table.name??''),rows:table.rows==null?null:Number(table.rows),columns:asStringArray(table.columns),
    classes:classes&&typeof classes==='object'&&!Array.isArray(classes)?Object.fromEntries(Object.entries(classes).map(([k,v])=>[k,String(v)])):null,
    sample:Array.isArray(table.sample)?table.sample as Array<Record<string,unknown>>:null,
    error:table.error?String(table.error):undefined};
}
export interface DescribeContext {projectDir?:string;password?:string;}
export async function describeDataset(runtime:RuntimeSpec,path:string,maxRows=5,signal?:AbortSignal,context?:DescribeContext):Promise<DatasetDescription> {
  if(maxRows<0||maxRows>50)throw new ListingError('DATASET_SAMPLE_INVALID');
  if(datasetKind(path)==='zip')return describeZipArchive(runtime,path,maxRows,signal,context);
  return describeDatasetFile(runtime,path,maxRows,signal);
}
async function describeDatasetFile(runtime:RuntimeSpec,path:string,maxRows:number,signal?:AbortSignal):Promise<DatasetDescription> {
  const kind=datasetKind(path),dir=await mkdtemp(join(tmpdir(),'listing-dataset-'));
  try{
    const script=join(dir,'describe.R');await writeFile(script,DESCRIBE_R,{flag:'wx'});
    const {stdout,stderr,code,truncated}=await runR(runtime,script,dir,[path,String(maxRows),kind],signal);
    const line=stdout.split(/\r?\n/).find(l=>l.startsWith('DSH_RESULT='));
    if(!line){
      // No fake empty success: surface the real R failure.
      throw new ListingError(`DATASET_READ_FAILED${stderr.trim()?': '+stderr.trim().slice(0,1500):''}`);
    }
    const parsed=JSON.parse(line.slice('DSH_RESULT='.length)) as {tables:DatasetTable[];warnings:string[]|string};
    const warnings=Array.isArray(parsed.warnings)?parsed.warnings:parsed.warnings?[String(parsed.warnings)]:[];
    const tables=(Array.isArray(parsed.tables)?parsed.tables:[]).map(normalizeTable);
    if(!tables.length)throw new ListingError(`DATASET_READ_FAILED${warnings.length?': '+warnings.join('; ').slice(0,1500):stderr.trim()?': '+stderr.trim().slice(0,1500):''}`);
    return {source:path,kind,tables,warnings,stderr,stdoutTruncated:truncated||code!==0};
  }finally{await rm(dir,{recursive:true,force:true});}
}
/** zip 数据包：按已交付程序的密码推导顺序解密解包后，逐个描述包内数据文件（合成或操作者提供的项目包）。 */
async function describeZipArchive(runtime:RuntimeSpec,path:string,maxRows:number,signal?:AbortSignal,context?:DescribeContext):Promise<DatasetDescription> {
  const root=await mkdtemp(join(tmpdir(),'listing-dataset-'));
  try{
    const destination=join(root,'data');
    await mkdir(destination,{recursive:true});
    const extract=await extractArchive(path,destination,{password:context?.password,projectDir:context?.projectDir??dirname(path)});
    const {files,catalogs}=await collectDataFiles(destination);
    if(!files.length)throw new ListingError(`DATASET_READ_FAILED: zip已解包${extract.files.length}个文件(密码来源:${extract.passwordSource})但未发现sas7bdat/xpt/csv/rds/rdata`);
    const tables:DatasetTable[]=[];const warnings:string[]=[];let stderr='';let truncated=false;
    if(catalogs.length)warnings.push(`sas7bcat格式目录不作为数据表描述: ${catalogs.join(', ')}`);
    for(const file of files){
      const stem=basename(file).replace(/\.[^.]+$/,'');
      const part=await describeDatasetFile(runtime,file,maxRows,signal);
      for(const t of part.tables)tables.push({...t,name:t.name==='dataset'?stem:`${stem}::${t.name}`});
      warnings.push(...part.warnings.map(w=>`[${stem}] ${w}`));
      if(part.stderr)stderr+=`[${stem}] ${part.stderr.slice(0,2000)}\n`;
      truncated=truncated||part.stdoutTruncated;
    }
    return {source:path,kind:'zip',tables,warnings,stderr,stdoutTruncated:truncated};
  }finally{await rm(root,{recursive:true,force:true});}
}
async function collectDataFiles(root:string):Promise<{files:string[];catalogs:string[]}> {
  const files:string[]=[],catalogs:string[]=[];const stack=[root];
  while(stack.length&&files.length+catalogs.length<2048){
    const dir=stack.pop()!;
    for(const item of await readdir(dir,{withFileTypes:true})){
      const path=join(dir,item.name);
      if(item.isDirectory())stack.push(path);
      else if(/\.(sas7bdat|xpt|csv|rds|rdata|rda)$/i.test(item.name))files.push(path);
      else if(/\.sas7bcat$/i.test(item.name))catalogs.push(item.name);
    }
  }
  return {files:files.sort(),catalogs:catalogs.sort()};
}
/** Ad-hoc R expression runner for fixtures and metadata probes. */
export async function runRExpression(runtime:RuntimeSpec,expression:string,signal?:AbortSignal):Promise<{stdout:string;stderr:string;code:number|null}> {
  const dir=await mkdtemp(join(tmpdir(),'listing-rexpr-'));
  try{const script=join(dir,'expr.R');await writeFile(script,expression,{flag:'wx'});return await runR(runtime,script,dir,[],signal);}
  finally{await rm(dir,{recursive:true,force:true});}
}
