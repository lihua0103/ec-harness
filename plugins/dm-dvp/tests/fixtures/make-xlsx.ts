/** 测试专用合成 xlsx 构造器。vendored 自 dm-listing demo.ts 的 makeWorkbook 并独立维护
 *  （刻意不 import demo.ts：那条 import 会把 dm-listing 的 knowledge 模块图拉进测试）。
 *  只产 inlineStr 单元格；行列数无 26 列限制。内容全部人工合成，禁止来自临床数据。 */
import { zipSync, strToU8 } from 'fflate';

const escape = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function colRef(col: number): string {
  let text = '';
  let n = col;
  while (n > 0) { text = String.fromCharCode(65 + ((n - 1) % 26)) + text; n = Math.floor((n - 1) / 26); }
  return text;
}

export function makeWorkbook(sheets: Array<{ name: string; rows: string[][]; state?: 'visible' | 'hidden' }>): Buffer {
  const files: Record<string, Uint8Array> = {};
  files['[Content_Types].xml'] = strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>');
  files['_rels/.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  files['xl/workbook.xml'] = strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => `<sheet name="${escape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.state && s.state !== 'visible' ? ` state="${s.state}"` : ''}/>`).join('') + '</sheets></workbook>');
  files['xl/_rels/workbook.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + '</Relationships>');
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + s.rows.map((row, r) => `<row r="${r + 1}">` + row.map((v, c) => `<c r="${colRef(c + 1)}${r + 1}" t="inlineStr"><is><t>${escape(v)}</t></is></c>`).join('') + '</row>').join('') + '</sheetData></worksheet>');
  });
  return Buffer.from(zipSync(files, { mtime: new Date('2020-01-01T00:00:00Z') }));
}
