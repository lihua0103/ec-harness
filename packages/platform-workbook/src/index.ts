/** Entry-oriented OOXML reader: discovery never opens worksheet or shared-string entries. */
import yauzl from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { posix } from 'node:path';

const MAX_ARCHIVE = 16 * 1024 * 1024;
// Real spec/ALS workbooks routinely carry single worksheets above 4MB uncompressed (measured 5.8-7.2MB);
// these bounds stay far below decompression-bomb territory while accepting real clinical spec files.
const MAX_ENTRY = 32 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
export class WorkbookError extends Error { constructor(readonly code: string) { super(code); } }
export interface Sheet { id: string; name: string; path: string; visibility: 'visible' | 'hidden' | 'veryHidden'; }
export interface Region { startRow: number; endRow: number; startColumn: number; endColumn: number; }
export function validateRegion(region: Region): void {
  if (!region || ['startRow','endRow','startColumn','endColumn'].some(k=>!Number.isSafeInteger(region[k as keyof Region]))
    || region.startRow<1 || region.endRow<region.startRow || region.endRow>1048576
    || region.startColumn<1 || region.endColumn<region.startColumn || region.endColumn>16384
    || (region.endRow-region.startRow+1)*(region.endColumn-region.startColumn+1)>10000) throw new WorkbookError('PROJECTION_REGION_INVALID');
}
function coordinate(ref: string): {row:number; column:number} {
  const match=/^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  if(!match)throw new WorkbookError('CELL_REFERENCE_INVALID');
  const column=[...match[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0),row=Number(match[2]);
  if(column>16384||row>1048576)throw new WorkbookError('CELL_REFERENCE_INVALID');
  return {row,column};
}
export interface Cell { ref: string; value: string; }
export interface AlsSheetCell extends Cell {
  type: string; formula?: {text:string; attributes:Record<string,string>};
}
export interface AlsSheetContent {
  sheet: Sheet; cells: AlsSheetCell[];
  mergedRanges: string[]; hiddenRows: number[]; hiddenColumns: Array<{min:number;max:number}>;
  warnings: string[];
}
const asArray = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
function xml(text: string): any {
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new WorkbookError('UNSUPPORTED_XML');
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, parseAttributeValue: false, removeNSPrefix: true, processEntities: false }).parse(text);
}
function decodeXml(value: string): string {
  // One pass only: &amp;lt; means literal &lt;, never recursively decoded markup.
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,entity=>{
    const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
    if(Object.hasOwn(named,entity))return named[entity];
    const hex=entity.startsWith('&#x'),cp=Number.parseInt(entity.slice(hex?3:2,-1),hex?16:10);
    if(!Number.isSafeInteger(cp)||!(cp===9||cp===10||cp===13||cp>=32&&cp<=0xD7FF||cp>=0xE000&&cp<=0xFFFD||cp>=0x10000&&cp<=0x10FFFF))throw new WorkbookError('INVALID_XML_CHARACTER');
    return String.fromCodePoint(cp);
  });
}
function text(value: any): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'object') return decodeXml(String(value));
  if ('#text' in value) return text(value['#text']);
  return asArray(value.r).map((r: any) => text(r.t)).join('');
}
export class Workbook {
  private constructor(private readonly zip: yauzl.ZipFile, private readonly entries: Map<string, yauzl.Entry>, private readonly observe: (path: string) => void) {}
  static async open(buffer: Buffer, observe: (path: string) => void = () => {}): Promise<Workbook> {
    if (buffer.length > MAX_ARCHIVE) throw new WorkbookError('ARCHIVE_TOO_LARGE');
    return new Promise((resolve, reject) => {
      yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zip) => {
        if (error || !zip) { reject(new WorkbookError('INVALID_XLSX')); return; }
        const entries = new Map<string, yauzl.Entry>();
        let total = 0;
        const fail = () => { zip.close(); reject(new WorkbookError('UNSAFE_ARCHIVE')); };
        zip.on('error', fail);
        zip.on('entry', (entry: yauzl.Entry) => {
          const p = entry.fileName;
          total += entry.uncompressedSize;
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (p.includes('\\') || p.startsWith('/') || p.includes(':') || p.split('/').includes('..') || entries.has(p.toLowerCase()) || mode === 0o120000 || entry.isEncrypted() || entries.size > 2048 || entry.uncompressedSize > MAX_ENTRY || total > MAX_TOTAL || /vbaProject\.bin$/i.test(p)) { fail(); return; }
          entries.set(p.toLowerCase(), entry);
          zip.readEntry();
        });
        zip.once('end', () => resolve(new Workbook(zip, entries, observe)));
        zip.readEntry();
      });
    });
  }
  close(): void { this.zip.close(); }
  private async read(path: string): Promise<string> {
    const entry = this.entries.get(path.toLowerCase());
    if (!entry) throw new WorkbookError('XLSX_ENTRY_MISSING');
    this.observe(path);
    return new Promise((resolve, reject) => {
      this.zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { reject(new WorkbookError('XLSX_READ_FAILED')); return; }
        const chunks: Buffer[] = []; let length = 0;
        stream.on('data', (chunk: Buffer) => { length += chunk.length; if (length > MAX_ENTRY) { stream.destroy(); reject(new WorkbookError('ENTRY_TOO_LARGE')); } else chunks.push(chunk); });
        stream.on('error', () => reject(new WorkbookError('XLSX_READ_FAILED')));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
    });
  }
  async listSheets(): Promise<Sheet[]> {
    const workbook = xml(await this.read('xl/workbook.xml'));
    const relationships = xml(await this.read('xl/_rels/workbook.xml.rels'));
    const rels = asArray<any>(relationships.Relationships?.Relationship);
    return asArray<any>(workbook.workbook?.sheets?.sheet).map((s, index) => {
      const relationship = rels.find(r => r['@Id'] === s['@id']);
      if (!relationship || relationship['@TargetMode'] === 'External') throw new WorkbookError('INVALID_SHEET_RELATIONSHIP');
      const target = String(relationship['@Target']);
      if (target.includes('\\') || target.includes(':') || target.split('/').includes('..')) throw new WorkbookError('INVALID_SHEET_PATH');
      const p = target.startsWith('/') ? target.slice(1) : posix.join('xl', target);
      if (!/^xl\/worksheets\/[^/]+\.xml$/.test(p)) throw new WorkbookError('INVALID_SHEET_PATH');
      const name = decodeXml(String(s['@name'] ?? ''));
      if (!name || name.length > 128) throw new WorkbookError('INVALID_SHEET_NAME');
      const visibility=s['@state'] ?? 'visible';
      if(!['visible','hidden','veryHidden'].includes(visibility))throw new WorkbookError('INVALID_SHEET_VISIBILITY');
      return { id: `sheet-${index + 1}`, name, path: p, visibility };
    });
  }
  /** Strict single-table output profile. Never used to classify clinical input workbooks. */
  async readOutputTable(): Promise<Array<{ref:string;value:string;type:'character'|'numeric'|'logical'|'blank'}>> {
    const allowed = /^(?:\[content_types\]\.xml|_rels\/\.rels|docprops\/(?:app|core)\.xml|xl\/(?:workbook\.xml|sharedstrings\.xml|styles\.xml|theme\/theme1\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet1\.xml|worksheets\/_rels\/sheet1\.xml\.rels|printersettings\/printersettings1\.bin))$/;
    for (const [name] of this.entries) {
      if (!allowed.test(name)) throw new WorkbookError('OUTPUT_XLSX_UNSUPPORTED_PART');
      if (name.endsWith('.rels')) {
        const rels = asArray<any>(xml(await this.read(name)).Relationships?.Relationship);
        if (rels.some(r => r['@TargetMode'] === 'External' || /(?:hyperlink|oleObject|externalLink|attachedTemplate)/i.test(String(r['@Type'])))) throw new WorkbookError('OUTPUT_XLSX_EXTERNAL_REFERENCE');
      }
    }
    const sheets = await this.listSheets();
    if (sheets.length !== 1 || sheets[0].name !== 'Listing' || sheets[0].path !== 'xl/worksheets/sheet1.xml') throw new WorkbookError('OUTPUT_XLSX_SHEET_CONTRACT');
    const meta = xml(await this.read('xl/workbook.xml'));
    if (asArray<any>(meta.workbook?.sheets?.sheet).some(s=>s['@state'] && s['@state']!=='visible')) throw new WorkbookError('OUTPUT_XLSX_HIDDEN_CONTENT');
    const document = xml(await this.read(sheets[0].path));
    const worksheet=document.worksheet;
    if (worksheet.hyperlinks || worksheet.oleObjects || worksheet.controls || worksheet.drawing || worksheet.legacyDrawing) throw new WorkbookError('OUTPUT_XLSX_ACTIVE_CONTENT');
    if (asArray<any>(worksheet.cols?.col).some(c=>['1','true'].includes(c['@hidden']))) throw new WorkbookError('OUTPUT_XLSX_HIDDEN_CONTENT');
    const rows=asArray<any>(worksheet.sheetData?.row);
    if (rows.some(r=>['1','true'].includes(r['@hidden']))) throw new WorkbookError('OUTPUT_XLSX_HIDDEN_CONTENT');
    const cells=rows.flatMap(r=>asArray<any>(r.c));
    if (cells.length>10000) throw new WorkbookError('TOO_MANY_CELLS');
    if (cells.some(c=>c.f!==undefined || (c['@s'] && c['@s']!=='0'))) throw new WorkbookError('OUTPUT_XLSX_FORMULA_OR_STYLE');
    const strings=cells.some(c=>c['@t']==='s') ? asArray<any>(xml(await this.read('xl/sharedStrings.xml')).sst?.si) : [];
    const seen=new Set<string>();
    return cells.map(c=>{
      const ref=String(c['@r']);
      if (!/^[A-Z]{1,3}[1-9][0-9]{0,4}$/.test(ref)||seen.has(ref)) throw new WorkbookError('OUTPUT_XLSX_CELL_REFERENCE');
      seen.add(ref);
      const t=c['@t'];
      let value=text(c.v),type:'character'|'numeric'|'logical'|'blank';
      if(c.v===undefined && c.is===undefined) {value='';type='blank';}
      else if(t==='s') {
        const i=Number(value);
        if(!Number.isSafeInteger(i)||i<0||i>=strings.length)throw new WorkbookError('INVALID_STRING_REFERENCE');
        value=text(strings[i].t??strings[i]);type='character';
      } else if(t==='inlineStr') {value=text(c.is?.t??c.is);type='character';}
      else if(t==='b'&&['0','1'].includes(value)){value=value==='1'?'TRUE':'FALSE';type='logical';}
      else if((t===undefined||t==='n')&&value.trim()&&Number.isFinite(Number(value)))type='numeric';
      else throw new WorkbookError('OUTPUT_XLSX_CELL_TYPE');
      if(value.length>12000 || (type==='character'&&/^[\s]*[=+@\t\r]/.test(value)))throw new WorkbookError('OUTPUT_XLSX_UNSAFE_TEXT');
      return {ref,value,type};
    });
  }
  /** Legacy regional reader retained for existing synthetic fixtures and old approvals. */
  async readRegion(sheetId: string, region: Region): Promise<{sheet:Sheet;cells:Cell[]}> {
    validateRegion(region);
    const sheets=await this.listSheets(),sheet=sheets.find(s=>s.id===sheetId);
    if(!sheet)throw new WorkbookError('UNKNOWN_SHEET');
    if(sheet.visibility!=='visible')throw new WorkbookError('PROJECTION_HIDDEN_SHEET');
    const worksheet=xml(await this.read(sheet.path)).worksheet;
    if(!worksheet || worksheet.mergeCells || worksheet.hyperlinks || worksheet.oleObjects || worksheet.controls || worksheet.drawing || worksheet.legacyDrawing)throw new WorkbookError('PROJECTION_UNSUPPORTED_LAYOUT');
    const inside=(p:{row:number;column:number})=>p.row>=region.startRow&&p.row<=region.endRow&&p.column>=region.startColumn&&p.column<=region.endColumn;
    const rows=asArray<any>(worksheet.sheetData?.row);
    if(asArray<any>(worksheet.cols?.col).some(c=>['1','true'].includes(c['@hidden'])&&Number(c['@min'])<=region.endColumn&&Number(c['@max'])>=region.startColumn))throw new WorkbookError('PROJECTION_HIDDEN_CONTENT');
    const seen=new Set<string>();const selected:any[]=[];
    for(const row of rows)for(const cell of asArray<any>(row.c)) {
      const ref=String(cell['@r']),p=coordinate(ref);
      if(seen.has(ref))throw new WorkbookError('CELL_REFERENCE_DUPLICATE');seen.add(ref);
      if(!inside(p))continue;
      if(Number(row['@r'])!==p.row)throw new WorkbookError('CELL_REFERENCE_INVALID');
      if(['1','true'].includes(row['@hidden']))throw new WorkbookError('PROJECTION_HIDDEN_CONTENT');
      if(cell.f!==undefined)throw new WorkbookError('FORMULA_REQUIRES_LOCAL_REVIEW');
      if(cell['@t']!==undefined&&!['s','inlineStr','n','b'].includes(cell['@t']))throw new WorkbookError('PROJECTION_CELL_TYPE_UNSUPPORTED');
      selected.push(cell);
    }
    let strings:any[]=[];
    if(selected.some(c=>c['@t']==='s'))strings=asArray<any>(xml(await this.read('xl/sharedStrings.xml')).sst?.si);
    const cells=selected.map(c=>{
      let value=c['@t']==='inlineStr'?text(c.is?.t??c.is):text(c.v);
      if(c['@t']==='s'){
        const i=Number(value);
        if(!Number.isSafeInteger(i)||i<0||i>=strings.length)throw new WorkbookError('INVALID_STRING_REFERENCE');
        value=text(strings[i].t??strings[i]);
      }
      if(value.length>12000)throw new WorkbookError('CELL_TOO_LARGE');
      return {ref:String(c['@r']),value};
    });
    return {sheet,cells};
  }
  /** General whole-sheet reader for any task-selected sheet (no name-based denials in the new flow).
   * Formula expressions are inert text: no cached values, cross-sheet reads or link refresh. */
  async readWorksheet(sheetId:string,window?:{startRow:number;endRow:number}):Promise<AlsSheetContent> {
    const sheets=await this.listSheets(),sheet=sheets.find(s=>s.id===sheetId);
    if(!sheet)throw new WorkbookError('UNKNOWN_SHEET');
    const worksheet=xml(await this.read(sheet.path)).worksheet;
    if(!worksheet)throw new WorkbookError('INVALID_WORKSHEET');
    const rows=asArray<any>(worksheet.sheetData?.row);
    const sourceCells=rows.flatMap(r=>asArray<any>(r.c));
    // Parse bound keeps work bounded while accepting large real spec sheets; the returned-cell
    // bound below applies after window filtering, so a large sheet stays readable through windows.
    if(sourceCells.length>500000)throw new WorkbookError('TOO_MANY_CELLS');
    if(window&&(!Number.isSafeInteger(window.startRow)||!Number.isSafeInteger(window.endRow)||window.startRow<1||window.endRow<window.startRow))throw new WorkbookError('PROJECTION_REGION_INVALID');
    const strings=sourceCells.some(c=>c.f===undefined&&c['@t']==='s')
      ?asArray<any>(xml(await this.read('xl/sharedStrings.xml')).sst?.si):[];
    const hiddenRows:number[]=[],seen=new Set<string>(),cells:AlsSheetCell[]=[];
    for(const row of rows){
      const rowNumber=Number(row['@r']);
      if(!Number.isSafeInteger(rowNumber)||rowNumber<1||rowNumber>1048576)throw new WorkbookError('CELL_REFERENCE_INVALID');
      const inWindow=!window||rowNumber>=window.startRow&&rowNumber<=window.endRow;
      if(['1','true'].includes(row['@hidden']))hiddenRows.push(rowNumber);
      if(!inWindow)continue;
      for(const c of asArray<any>(row.c)){
        const ref=String(c['@r']),position=coordinate(ref);
        if(position.row!==rowNumber)throw new WorkbookError('CELL_REFERENCE_INVALID');
        if(seen.has(ref))throw new WorkbookError('CELL_REFERENCE_DUPLICATE');seen.add(ref);
        const type=String(c['@t']??'n');
        if(c.f!==undefined){
          const attributes:Record<string,string>={};
          if(c.f&&typeof c.f==='object')for(const [key,value] of Object.entries(c.f))if(key.startsWith('@'))attributes[key.slice(1)]=decodeXml(String(value));
          const expression=text(c.f);
          if(expression.length>32767)throw new WorkbookError('CELL_TOO_LARGE');
          cells.push({ref,value:'',type,formula:{text:expression,attributes}});
          continue;
        }
        let value=type==='inlineStr'?text(c.is?.t??c.is):text(c.v);
        if(type==='s'){
          const i=Number(value);
          if(!Number.isSafeInteger(i)||i<0||i>=strings.length)throw new WorkbookError('INVALID_STRING_REFERENCE');
          value=text(strings[i].t??strings[i]);
        }
        if(value.length>32767)throw new WorkbookError('CELL_TOO_LARGE');
        cells.push({ref,value,type});
      }
    }
    // Returned-cell bound: judged after window filtering, so windowed reads of a big sheet stay
    // bounded per call; an unwindowed over-cap sheet still fails explicitly, never truncating.
    if(cells.length>100000)throw new WorkbookError('TOO_MANY_CELLS');
    cells.sort((a,b)=>{const x=coordinate(a.ref),y=coordinate(b.ref);return x.row-y.row||x.column-y.column;});
    const mergedRanges=asArray<any>(worksheet.mergeCells?.mergeCell).map(m=>{
      const ref=String(m['@ref']),parts=ref.split(':');
      if(parts.length!==2)throw new WorkbookError('CELL_REFERENCE_INVALID');
      const a=coordinate(parts[0]),b=coordinate(parts[1]);
      if(a.row>b.row||a.column>b.column)throw new WorkbookError('CELL_REFERENCE_INVALID');
      return ref;
    });
    const hiddenColumns=asArray<any>(worksheet.cols?.col).filter(c=>['1','true'].includes(c['@hidden'])).map(c=>{
      const min=Number(c['@min']),max=Number(c['@max']);
      if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||min<1||max<min||max>16384)throw new WorkbookError('CELL_REFERENCE_INVALID');
      return {min,max};
    });
    const warnings:string[]=[];
    if(cells.some(c=>c.formula))warnings.push('FORMULAS_TEXT_ONLY_CACHED_VALUES_WITHHELD');
    if(worksheet.hyperlinks)warnings.push('HYPERLINK_TARGETS_NOT_FOLLOWED');
    if(worksheet.oleObjects||worksheet.controls||worksheet.drawing||worksheet.legacyDrawing)warnings.push('EMBEDDED_CONTENT_NOT_DECODED');
    if(worksheet.extLst)warnings.push('WORKSHEET_EXTENSIONS_NOT_DECODED');
    // Do not open related comments, binary objects, other sheets, or external resources implicitly.
    if(this.entries.has(sheet.path.replace('worksheets/','worksheets/_rels/')+'.rels'))warnings.push('RELATED_PARTS_NOT_EXPANDED');
    return {sheet,cells,mergedRanges,hiddenRows,hiddenColumns,warnings};
  }
  /** Caller supplies the selected sheet ID; sheet names never gate content reads. */
  async readSheet(sheetId: string): Promise<{ sheet: Sheet; cells: Cell[] }> {
    const sheets = await this.listSheets();
    const sheet = sheets.find(s => s.id === sheetId);
    if (!sheet) throw new WorkbookError('UNKNOWN_SHEET');
    const document = xml(await this.read(sheet.path));
    const rows = asArray<any>(document.worksheet?.sheetData?.row);
    const sourceCells = rows.flatMap(r => asArray<any>(r.c));
    if (sourceCells.length > 10000) throw new WorkbookError('TOO_MANY_CELLS');
    // First reject formulas completely: neither cross-sheet content nor cached values are released.
    if (sourceCells.some(c => c.f !== undefined)) throw new WorkbookError('FORMULA_REQUIRES_LOCAL_REVIEW');
    let strings: any[] = [];
    if (sourceCells.some(c => c['@t'] === 's')) strings = asArray<any>(xml(await this.read('xl/sharedStrings.xml')).sst?.si);
    const cells = sourceCells.map(c => {
      let value = c['@t'] === 'inlineStr' ? text(c.is?.t ?? c.is) : text(c.v);
      if (c['@t'] === 's') {
        const index = Number(value);
        if (!Number.isSafeInteger(index) || index < 0 || index >= strings.length) throw new WorkbookError('INVALID_STRING_REFERENCE');
        value = text(strings[index].t ?? strings[index]);
      }
      if (value.length > 12000) throw new WorkbookError('CELL_TOO_LARGE');
      return { ref: String(c['@r']), value };
    });
    return { sheet, cells };
  }
}
