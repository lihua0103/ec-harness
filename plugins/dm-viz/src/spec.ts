/**
 * 规格模型：Dataset / ChartSpec / Layout / Bundle。
 * 全部为结构化 JSON，可整体序列化、整体替换、可哈希；校验失败整单拒绝。
 */
import { createHash } from 'node:crypto';
import { VizError, fail } from './errors.js';
import { catalogOf, presetOf, requiredSlots, usesSeries } from './catalog.js';

export type CellValue = string | number | null;
export type Aggregate = 'SUM' | 'AVG' | 'COUNT' | 'MIN' | 'MAX';
export type ColumnType = 'number' | 'text' | 'date';

export interface DatasetColumn {
  key: string;
  label: string;
  type: ColumnType;
  /** 语义提示；校验不使用，渲染也不依赖。 */
  role?: 'category' | 'value' | 'series' | 'detail';
}

export interface Dataset {
  id: string;
  name: string;
  columns: DatasetColumn[];
  rows: CellValue[][];
}

export interface ValueSlot {
  column: string;
  aggregate?: Aggregate;
  label?: string;
}

export interface SpecSlots {
  category?: string;
  values?: ValueSlot[];
  series?: string;
  x?: string;
  y?: string;
  size?: string;
  source?: string;
  target?: string;
  detail?: string[];
}

export type ChartMode = 'data' | 'baked';

export interface ChartStyle {
  palette?: string[];
  itemColors?: string[];
  seriesColors?: string[];
  stackAll?: boolean;
  seriesDash?: number[];
  valueLabels?: boolean;
  endLabels?: boolean;
  hideLabels?: boolean;
  legendWithValue?: boolean;
  centerText?: string;
  centerSubText?: string;
  centerTop?: string;
  seriesBarWidth?: number | string;
  yAxisInverse?: boolean;
  legend?: boolean;
  legendPosition?: 'top' | 'bottom' | 'left' | 'right';
  minHeight?: number | string;
}

export interface ChartSpec {
  id: string;
  title: string;
  mode: ChartMode;
  type: string;
  preset?: string;
  datasetId?: string;
  slots?: SpecSlots;
  option?: Record<string, unknown>;
  style?: ChartStyle;
  note?: string;
}

export interface DividerStyle {
  titleColor?: string;
  titleSize?: number;
  subTitle?: string;
  subTitleColor?: string;
  subTitleSize?: number;
  showLine?: boolean;
  align?: 'left' | 'center' | 'right';
}

export interface ChartItem {
  kind: 'chart';
  i: string;
  specId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DividerItem {
  kind: 'divider';
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  style?: DividerStyle;
}

export type LayoutItem = ChartItem | DividerItem;

export interface Layout {
  pageId: string;
  title?: string;
  columns: 24;
  rowHeight: 36;
  items: LayoutItem[];
}

export interface Bundle {
  datasets: Dataset[];
  specs: ChartSpec[];
  layout: Layout;
}

/** Key-sorted JSON: identical content always yields the same digest. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function nonEmpty(value: unknown, code: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(code, field);
  return value;
}

export function validateDataset(dataset: Dataset): Dataset {
  nonEmpty(dataset.id, 'DATASET_INVALID', 'id');
  nonEmpty(dataset.name, 'DATASET_INVALID', 'name');
  if (!Array.isArray(dataset.columns) || dataset.columns.length === 0) fail('DATASET_INVALID', 'columns');
  const keys = new Set<string>();
  for (const column of dataset.columns) {
    nonEmpty(column.key, 'DATASET_INVALID', 'column.key');
    nonEmpty(column.label, 'DATASET_INVALID', 'column.label');
    if (keys.has(column.key)) fail('DATASET_COLUMN_DUPLICATE', column.key);
    keys.add(column.key);
    if (!['number', 'text', 'date'].includes(column.type)) fail('DATASET_COLUMN_TYPE_INVALID', column.key);
  }
  if (!Array.isArray(dataset.rows)) fail('DATASET_INVALID', 'rows');
  for (const row of dataset.rows) {
    if (!Array.isArray(row) || row.length !== dataset.columns.length) {
      fail('DATASET_ROW_WIDTH_MISMATCH', String(dataset.columns.length));
    }
  }
  return dataset;
}

export function datasetOf(bundle: Bundle, datasetId: string): Dataset {
  const dataset = bundle.datasets.find((item) => item.id === datasetId);
  if (!dataset) fail('DATASET_NOT_FOUND', datasetId);
  return dataset;
}

export function columnOf(dataset: Dataset, key: string): DatasetColumn {
  const column = dataset.columns.find((item) => item.key === key);
  if (!column) fail('COLUMN_NOT_FOUND', `${dataset.id}/${key}`);
  return column;
}

const NUMERIC_AGGREGATES: Aggregate[] = ['SUM', 'AVG', 'MIN', 'MAX'];

function checkSlotColumn(dataset: Dataset, key: string | undefined, field: string, numeric: boolean): void {
  if (!key) return;
  const column = columnOf(dataset, key);
  if (numeric && column.type !== 'number') {
    fail('SLOT_COLUMN_NOT_NUMBER', `${field}:${key}(${column.type})`);
  }
}

export function validateSpec(spec: ChartSpec, datasets: Dataset[]): ChartSpec {
  nonEmpty(spec.id, 'SPEC_INVALID', 'id');
  nonEmpty(spec.title, 'SPEC_INVALID', 'title');
  if (spec.mode !== 'data' && spec.mode !== 'baked') fail('SPEC_MODE_REQUIRED', spec.id);
  const entry = catalogOf(spec.type);
  presetOf(entry, spec.preset);

  if (spec.mode === 'baked') {
    if (!spec.option || typeof spec.option !== 'object' || Array.isArray(spec.option)) {
      fail('SPEC_BAKED_OPTION_REQUIRED', spec.id);
    }
    return spec;
  }

  if (!spec.datasetId) fail('SPEC_DATASET_REQUIRED', spec.id);
  const dataset = datasets.find((item) => item.id === spec.datasetId);
  if (!dataset) fail('DATASET_NOT_FOUND', spec.datasetId);
  const slots = spec.slots;
  if (!slots) {
    // 表格可用数据集全部列，不强制槽位；其余形态必须声明槽位。
    if (entry.shape === 'table') return spec;
    fail('SPEC_SLOTS_REQUIRED', spec.id);
  }
  const values = slots.values ?? [];
  for (const required of requiredSlots(entry)) {
    if (required === 'values') {
      if (values.length === 0) fail('SLOT_VALUES_REQUIRED', spec.id);
    } else if (required === 'category' && !slots.category) {
      fail('SLOT_CATEGORY_REQUIRED', spec.id);
    }
  }

  checkSlotColumn(dataset, slots.category, 'category', false);
  checkSlotColumn(dataset, slots.series, 'series', false);
  checkSlotColumn(dataset, slots.x, 'x', true);
  checkSlotColumn(dataset, slots.y, 'y', true);
  checkSlotColumn(dataset, slots.size, 'size', true);
  checkSlotColumn(dataset, slots.source, 'source', false);
  checkSlotColumn(dataset, slots.target, 'target', false);
  for (const key of slots.detail ?? []) checkSlotColumn(dataset, key, 'detail', false);
  for (const value of values) {
    const aggregate = value.aggregate ?? 'SUM';
    if (!['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'].includes(aggregate)) {
      fail('AGGREGATE_UNKNOWN', `${spec.id}/${value.column}/${aggregate}`);
    }
    checkSlotColumn(dataset, value.column, 'values', NUMERIC_AGGREGATES.includes(aggregate));
  }

  switch (entry.shape) {
    case 'heatmap':
      if (!slots.series) fail('SLOT_SERIES_REQUIRED', spec.id);
      if (values.length !== 1) fail('SLOT_VALUES_SINGLE', spec.id);
      break;
    case 'boxplot':
      if (values.length < 5) fail('SLOT_VALUES_FIVE', spec.id);
      break;
    case 'scatter':
      if (!slots.x || !slots.y) fail('SLOT_XY_REQUIRED', spec.id);
      break;
    case 'graph':
      if (!slots.source || !slots.target) fail('SLOT_EDGE_REQUIRED', spec.id);
      if (values.length !== 1) fail('SLOT_VALUES_SINGLE', spec.id);
      break;
    case 'table':
      break;
    case 'cards':
      if (!slots.category) fail('SLOT_CATEGORY_REQUIRED', spec.id);
      if (values.length === 0) fail('SLOT_VALUES_REQUIRED', spec.id);
      break;
    default:
      if (usesSeries(entry) && values.length === 0) fail('SLOT_VALUES_REQUIRED', spec.id);
  }
  return spec;
}

export function itemRect(item: LayoutItem): { x: number; y: number; w: number; h: number } {
  return { x: item.x, y: item.y, w: item.w, h: item.h };
}

export function rectsOverlap(a: LayoutItem, b: LayoutItem): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export interface LayoutIssue {
  code: string;
  i: string;
  detail?: string;
}

/** Layout validation collects every issue instead of failing on the first one. */
export function validateLayout(layout: Layout, specs: ChartSpec[]): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  if (layout.columns !== 24) issues.push({ code: 'LAYOUT_COLUMNS_INVALID', i: '' });
  if (layout.rowHeight !== 36) issues.push({ code: 'LAYOUT_ROWHEIGHT_INVALID', i: '' });
  const ids = new Set(specs.map((spec) => spec.id));
  const seen = new Set<string>();
  for (const item of layout.items) {
    const i = typeof item.i === 'string' ? item.i : '';
    if (!i.trim()) issues.push({ code: 'LAYOUT_ITEM_KEY_INVALID', i });
    else if (seen.has(i)) issues.push({ code: 'LAYOUT_ITEM_KEY_DUPLICATE', i });
    seen.add(i);
    for (const field of ['x', 'y', 'w', 'h'] as const) {
      const value = item[field];
      if (!Number.isSafeInteger(value) || value < 0) issues.push({ code: 'LAYOUT_ITEM_RECT_INVALID', i, detail: field });
    }
    if (item.w <= 0 || item.h <= 0) issues.push({ code: 'LAYOUT_ITEM_RECT_INVALID', i, detail: 'w/h' });
    if (item.x + item.w > layout.columns) issues.push({ code: 'LAYOUT_ITEM_OUT_OF_GRID', i });
    if (item.kind === 'chart' && !ids.has(item.specId)) issues.push({ code: 'LAYOUT_ORPHAN_SPEC', i, detail: item.specId });
  }
  for (let a = 0; a < layout.items.length; a++) {
    for (let b = a + 1; b < layout.items.length; b++) {
      if (rectsOverlap(layout.items[a]!, layout.items[b]!)) {
        issues.push({ code: 'LAYOUT_OVERLAP', i: layout.items[a]!.i, detail: layout.items[b]!.i });
      }
    }
  }
  return issues;
}

export function validateBundle(bundle: Bundle): Bundle {
  const datasetIds = new Set<string>();
  for (const dataset of bundle.datasets) {
    validateDataset(dataset);
    if (datasetIds.has(dataset.id)) fail('DATASET_ID_DUPLICATE', dataset.id);
    datasetIds.add(dataset.id);
  }
  const specIds = new Set<string>();
  for (const spec of bundle.specs) {
    validateSpec(spec, bundle.datasets);
    if (specIds.has(spec.id)) fail('SPEC_ID_DUPLICATE', spec.id);
    specIds.add(spec.id);
  }
  const issues = validateLayout(bundle.layout, bundle.specs);
  if (issues.length) throw new VizError('LAYOUT_INVALID', issues.map((issue) => `${issue.code}@${issue.i}`).join(','));
  return bundle;
}

/** Deterministic render order: rows top-down, then left-right, then key. */
export function orderedItems(layout: Layout): LayoutItem[] {
  return [...layout.items].sort((a, b) => a.y - b.y || a.x - b.x || a.i.localeCompare(b.i));
}

export function pageDigest(bundle: Bundle): string {
  return digestOf({
    datasets: bundle.datasets,
    specs: bundle.specs,
    layout: bundle.layout,
  });
}
