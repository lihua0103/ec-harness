/**
 * 工作表 → Dataset：只读 platform-workbook 的公开导出，不复制 OOXML 解析。
 * 列类型按实际取值推断；推断不出的列保持 text，数值槽绑定时会明确报错而不是静默转 0。
 */
import { readFile } from 'node:fs/promises';
import { Workbook, type AlsSheetCell } from '../../platform-workbook/src/index.js';
import { VizError } from './errors.js';
import type { CellValue, ColumnType, Dataset, DatasetColumn } from './spec.js';

const MAX_ROWS = 5000;
const MAX_COLUMNS = 200;
const DATE_TEXT = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/;

export interface GridOptions {
  id: string;
  name: string;
  /** 原始文本网格；headerRowIndex 指向表头行。 */
  rows: string[][];
  headerRowIndex?: number;
  /** 按列 key 或表头文字覆盖推断类型。 */
  columnTypes?: Record<string, ColumnType>;
  maxRows?: number;
}

function isNumericText(text: string): boolean {
  return text.trim() !== '' && Number.isFinite(Number(text));
}

function keyOf(label: string, index: number, used: Set<string>): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '') || `col_${index + 1}`;
  let key = base;
  let suffix = 2;
  while (used.has(key)) key = `${base}_${suffix++}`;
  used.add(key);
  return key;
}

function inferType(values: string[]): ColumnType {
  if (values.length === 0) return 'text';
  if (values.every(isNumericText)) return 'number';
  if (values.every((value) => DATE_TEXT.test(value))) return 'date';
  return 'text';
}

function convert(text: string, type: ColumnType): CellValue {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (type === 'number') return isNumericText(trimmed) ? Number(trimmed) : null;
  return text;
}

export function datasetFromGrid(options: GridOptions): Dataset {
  const headerIndex = options.headerRowIndex ?? 0;
  const maxRows = options.maxRows ?? MAX_ROWS;
  if (headerIndex < 0 || headerIndex >= options.rows.length) throw new VizError('XLSX_HEADER_ROW_MISSING');
  const header = options.rows[headerIndex] ?? [];
  if (header.length === 0) throw new VizError('XLSX_EMPTY_SHEET');
  if (header.length > MAX_COLUMNS) throw new VizError('XLSX_COLUMN_LIMIT', `${header.length}>${MAX_COLUMNS}`);

  const dataRows = options.rows
    .slice(headerIndex + 1)
    .filter((row) => row.some((cell) => (cell ?? '').trim() !== ''));
  if (dataRows.length > maxRows) throw new VizError('XLSX_ROW_LIMIT', `${dataRows.length}>${maxRows}`);

  const used = new Set<string>();
  const columns: DatasetColumn[] = header.map((label, index) => {
    const text = String(label ?? '').trim();
    const key = keyOf(text, index, used);
    const values = dataRows.map((row) => String(row[index] ?? '').trim()).filter((value) => value !== '');
    const override = options.columnTypes?.[key] ?? options.columnTypes?.[text];
    return { key, label: text || key, type: override ?? inferType(values) };
  });

  const rows: CellValue[][] = dataRows.map((row) =>
    columns.map((column, index) => convert(String(row[index] ?? ''), column.type)),
  );

  return { id: options.id, name: options.name, columns, rows };
}

export interface ImportOptions {
  path: string;
  datasetId: string;
  name?: string;
  sheetId?: string;
  headerRow?: number;
  columnTypes?: Record<string, ColumnType>;
  maxRows?: number;
}

interface CellGrid {
  rows: string[][];
  firstRow: number;
  formulaCells: number;
}

function gridFromCells(cells: AlsSheetCell[]): CellGrid {
  const map = new Map<string, string>();
  let firstRow = Number.POSITIVE_INFINITY;
  let lastRow = 0;
  let lastColumn = 0;
  let formulaCells = 0;
  for (const cell of cells) {
    const match = /^([A-Z]+)(\d+)$/.exec(cell.ref);
    if (!match) continue;
    const column = [...match[1]!].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
    const row = Number(match[2]);
    if (cell.formula) {
      formulaCells++;
      continue;
    }
    map.set(`${row}:${column}`, cell.value);
    firstRow = Math.min(firstRow, row);
    lastRow = Math.max(lastRow, row);
    lastColumn = Math.max(lastColumn, column);
  }
  if (!Number.isFinite(firstRow) || lastRow === 0) return { rows: [], firstRow: 1, formulaCells };
  const rows: string[][] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    const line: string[] = [];
    for (let column = 1; column <= lastColumn; column++) line.push(map.get(`${row}:${column}`) ?? '');
    rows.push(line);
  }
  return { rows, firstRow, formulaCells };
}

export async function importWorkbookSheet(
  options: ImportOptions,
): Promise<{ dataset: Dataset; sheet: { id: string; name: string }; warnings: string[] }> {
  const buffer = await readFile(options.path);
  const workbook = await Workbook.open(buffer);
  const warnings: string[] = [];
  try {
    const sheets = await workbook.listSheets();
    const sheet = options.sheetId ? sheets.find((item) => item.id === options.sheetId) : sheets.find((item) => item.visibility === 'visible');
    if (!sheet) throw new VizError('XLSX_SHEET_NOT_FOUND', options.sheetId ?? '(first visible)');
    if (sheet.visibility !== 'visible') throw new VizError('XLSX_SHEET_HIDDEN', sheet.name);
    const content = await workbook.readWorksheet(sheet.id);
    const grid = gridFromCells(content.cells);
    if (grid.rows.length === 0) throw new VizError('XLSX_EMPTY_SHEET');
    if (grid.formulaCells > 0) warnings.push(`FORMULA_CELLS_SKIPPED:${grid.formulaCells}`);
    if (content.hiddenRows.length > 0) warnings.push(`HIDDEN_ROWS_INCLUDED:${content.hiddenRows.length}`);
    if (content.hiddenColumns.length > 0) warnings.push(`HIDDEN_COLUMNS_INCLUDED:${content.hiddenColumns.length}`);
    if (content.mergedRanges.length > 0) warnings.push(`MERGED_RANGES_IGNORED:${content.mergedRanges.length}`);
    const headerRowNumber = options.headerRow ?? grid.firstRow;
    const dataset = datasetFromGrid({
      id: options.datasetId,
      name: options.name ?? sheet.name,
      rows: grid.rows,
      headerRowIndex: Math.max(0, headerRowNumber - grid.firstRow),
      columnTypes: options.columnTypes,
      maxRows: options.maxRows,
    });
    return { dataset, sheet: { id: sheet.id, name: sheet.name }, warnings };
  } finally {
    workbook.close();
  }
}
