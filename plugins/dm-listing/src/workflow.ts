/** Real-project workflow orchestration: scan → identify spec/ALS → sheet inventory → dataset description.
 *  Harness AI drives interpretation; this layer only chains read-only project tools with resource bounds. */
import {join,dirname} from 'node:path';
import {scanProject,readProjectArtifact,type ProjectScan} from './project.js';
import {Workbook,ListingError} from './workbook.js';
import {readRegularFile,sha256} from './runner.js';
import {resolveRuntime,describeDataset,type DatasetDescription} from './datasets.js';
import type {RuntimeSpec} from './runner.js';

const MAX_READ=16*1024*1024;
export interface WorkbookSheetEntry {sheetId:string;name:string;visibility:string;rowsHint:'unknown';}
export interface ProjectOverview {
  directory:string;scan:ProjectScan;
  workbooks:Array<{path:string;sha256:string;sheets:WorkbookSheetEntry[];error?:string}>;
  notice:string;
}
/** Enumerate every workbook's sheet names without reading cell content. */
async function inventoryWorkbook(root:string,path:string):Promise<{path:string;sha256:string;sheets:WorkbookSheetEntry[];error?:string}> {
  try{
    const absolute=join(root,path);
    const bytes=await readRegularFile(absolute,MAX_READ);
    const digest=sha256(bytes);
    const wb=await Workbook.open(bytes);
    try{
      const sheets=await wb.listSheets();
      return {path,sha256:digest,sheets:sheets.map(s=>({sheetId:s.id,name:s.name,visibility:s.visibility,rowsHint:'unknown' as const}))};
    }finally{wb.close();}
  }catch(error){
    const detail=error instanceof ListingError?error.code:(error instanceof Error?error.message.slice(0,200):'UNKNOWN');
    return {path,sha256:'',sheets:[],error:detail};
  }
}
/** One read-only pass: scan the project and list sheets of every Excel candidate (spec/ALS or any workbook). */
export async function overviewProject(directory:string):Promise<ProjectOverview> {
  const scan=await scanProject(directory);
  const workbookPaths=scan.files.filter(f=>f.kind==='excel').map(f=>f.path);
  const workbooks=[] as Awaited<ReturnType<typeof inventoryWorkbook>>[];
  for(const path of workbookPaths)workbooks.push(await inventoryWorkbook(scan.directory,path));
  return {directory:scan.directory,scan,workbooks,
    notice:'候选仅为名称线索；AI 必须打开实际 sheet 确认角色，完整读取需求内容。'};
}
/** Read a workbook sheet discovered through overviewProject; passthrough with integrity metadata. */
export async function readWorkflowSheet(directory:string,workbookPath:string,sheetId:string,window?:{startRow:number;endRow:number}) {
  const {readProjectWorksheet}=await import('./project.js');
  return readProjectWorksheet(directory,workbookPath,sheetId,window);
}
/** Describe a dataset via local R; requires operator R configuration. zip 数据包走密码推导解密后描述。 */
export async function describeWorkflowDataset(runtime:RuntimeSpec|undefined,path:string,maxRows=5,signal?:AbortSignal,context?:{projectDir?:string;password?:string}):Promise<DatasetDescription> {
  const resolved=runtime??await resolveRuntime();
  return describeDataset(resolved,path,maxRows,signal,context);
}
