/** 最小 xlsx 序列化器：inlineStr 单元格，文件骨架与 dm-listing Workbook.open 实证可读的形状一致。
 *  全文本单元格（DVP 内容为文本语义）；固定 zip mtime 保证同输入产出字节一致（sha256 可复现）。 */
import { zipSync, strToU8 } from 'fflate';

function escapeXml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function colRef(col: number): string {
  let text = '';
  let n = col;
  while (n > 0) { text = String.fromCharCode(65 + ((n - 1) % 26)) + text; n = Math.floor((n - 1) / 26); }
  return text;
}

/** 单元格宽度：内容宽度启发式，上限 58（模板长头如 Discrepancy Text Message）。 */
function widthOf(rows: string[][], colIndex: number): number {
  let widest = 0;
  for (const row of rows) {
    let width = 0;
    for (const ch of row[colIndex] ?? '') width += ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
    if (width > widest) widest = width;
    if (widest > 58) return 58;
  }
  return Math.min(58, Math.max(8, widest + 2));
}

export interface XlsxSheet { name: string; rows: string[][]; }

/** 序列化为 xlsx Buffer。固定 mtime；sheet 顺序即数组顺序。 */
export function serializeXlsx(sheets: XlsxSheet[]): Buffer {
  const files: Record<string, Uint8Array> = {};
  files['[Content_Types].xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>',
  );
  files['_rels/.rels'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>',
  );
  files['xl/workbook.xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets>'
    + sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>',
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + '</Relationships>',
  );
  sheets.forEach((sheet, i) => {
    const body = sheet.rows.map((row, r) => {
      const cells = row
        .map((value, c) => ({ value, ref: `${colRef(c + 1)}${r + 1}` }))
        .filter((cell) => cell.value !== '')
        .map((cell) => `<c r="${cell.ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.value)}</t></is></c>`)
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    const cols = `<cols>${sheet.rows[0]?.map((_, c) => `<col min="${c + 1}" max="${c + 1}" width="${widthOf(sheet.rows, c)}" customWidth="1"/>`).join('') ?? ''}</cols>`;
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`,
    );
  });
  return Buffer.from(zipSync(files, { mtime: new Date('2020-01-01T00:00:00Z') }));
}
