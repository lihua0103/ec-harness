import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8} from 'fflate';
import {Workbook} from '../src/workbook.ts';

const COLN=(c:number)=>String.fromCharCode(65+c);
/** Minimal xlsx whose single worksheet XML exceeds the old 4MB per-entry cap. */
function bigWorkbook(rows:number,cols:number):{buffer:Buffer;sheetXml:string}{
  const rowsXml=Array.from({length:rows},(_,r)=>{
    const cells=Array.from({length:cols},(_,c)=>`<c r="${COLN(c)}${r+1}" t="inlineStr"><is><t>pad${r}_${c}0000000000</t></is></c>`).join('');
    return `<row r="${r+1}">${cells}</row>`;
  }).join('');
  const sheetXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
  const buffer=Buffer.from(zipSync({
    '[content_types].xml':strToU8('<?xml version="1.0" ?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels':strToU8('<?xml version="1.0" ?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml':strToU8('<?xml version="1.0" ?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Big" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels':strToU8('<?xml version="1.0" ?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml':strToU8(sheetXml),
  }));
  return {buffer,sheetXml};
}

test('real-size large worksheet entries (>4MB, seen in HXN6005/YL202 spec workbooks) open and read through windows',async()=>{
  const {buffer,sheetXml}=bigWorkbook(10050,10); // 100500 cells ≈ 5MB uncompressed
  assert.ok(sheetXml.length>4*1024*1024,'fixture必须超过旧的单条目4MB上限');
  const wb=await Workbook.open(buffer);
  try{
    const sheets=await wb.listSheets();
    assert.equal(sheets.length,1);
    // 无窗口整体读取仍然显式拒绝，不静默截断。
    await assert.rejects(wb.readWorksheet(sheets[0].id),/TOO_MANY_CELLS/);
    // 窗口读取在窗口过滤后判定返回层边界，大sheet可分窗口完整读取。
    const content=await wb.readWorksheet(sheets[0].id,{startRow:1,endRow:100});
    assert.equal(content.cells.length,1000);
    assert.equal(content.sheet.id,sheets[0].id);
  }finally{wb.close();}
});
