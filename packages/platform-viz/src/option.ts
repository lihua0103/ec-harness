/**
 * 规格 → ECharts option / 表格 / 卡片模型。
 * 纯函数：不依赖浏览器、DOM 或 ECharts 运行时；产出可直接 JSON 序列化。
 */
import { catalogOf, presetOf, type CatalogEntry, type Preset } from './catalog.js';
import { fail } from './errors.js';
import {
  columnOf,
  datasetOf,
  normalizeAggregate,
  validateSpec,
  type Aggregate,
  type Bundle,
  type CellValue,
  type ChartSpec,
  type Dataset,
} from './spec.js';
import { applyStyle } from './style.js';

type Json = Record<string, unknown>;

export interface BuildResult {
  kind: 'chart' | 'table' | 'cards';
  shape: string;
  option: Json;
  seriesCount: number;
  /** 非空数据点数（表格行数 / 卡片数）；0 即"会渲染成空白"。 */
  points: number;
}

interface CategoryTable {
  categories: string[];
  series: Array<{ name: string; data: Array<number | null> }>;
}

function cellIndex(dataset: Dataset, key: string): number {
  const index = dataset.columns.findIndex((column) => column.key === key);
  if (index < 0) fail('COLUMN_NOT_FOUND', `${dataset.id}/${key}`);
  return index;
}

function asNumber(value: CellValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asLabel(value: CellValue | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

export function aggregateCells(cells: CellValue[], aggregate: Aggregate): number | null {
  if (aggregate === 'COUNT') return cells.filter((cell) => cell !== null && cell !== '').length;
  const numbers = cells.map(asNumber).filter((value): value is number => value !== null);
  if (numbers.length === 0) return null;
  switch (aggregate) {
    case 'SUM':
      return numbers.reduce((sum, value) => sum + value, 0);
    case 'AVG':
      return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    case 'MIN':
      return Math.min(...numbers);
    case 'MAX':
      return Math.max(...numbers);
  }
}

/** 宽表：每个数值槽是一系列。 */
function wideTable(dataset: Dataset, spec: ChartSpec): CategoryTable {
  const slots = spec.slots!;
  const categoryIndex = cellIndex(dataset, slots.category!);
  const definitions = (slots.values ?? []).map((value) => ({
    aggregate: normalizeAggregate(value.aggregate),
    index: cellIndex(dataset, value.column),
    name: value.label ?? columnOf(dataset, value.column).label,
  }));
  const categories: string[] = [];
  const seen = new Set<string>();
  const buckets = new Map<string, CellValue[][]>();
  for (const row of dataset.rows) {
    const category = asLabel(row[categoryIndex]);
    if (!seen.has(category)) {
      seen.add(category);
      categories.push(category);
      buckets.set(category, definitions.map(() => []));
    }
    const bucket = buckets.get(category)!;
    definitions.forEach((definition, index) => {
      bucket[index]!.push(row[definition.index] ?? null);
    });
  }
  return {
    categories,
    series: definitions.map((definition, index) => ({
      name: definition.name,
      data: categories.map((category) => aggregateCells(buckets.get(category)![index]!, definition.aggregate)),
    })),
  };
}

/** 长表：单一数值槽按 series 列拆系列。 */
function longTable(dataset: Dataset, spec: ChartSpec): CategoryTable {
  const slots = spec.slots!;
  const categoryIndex = cellIndex(dataset, slots.category!);
  const seriesIndex = cellIndex(dataset, slots.series!);
  const definition = slots.values![0]!;
  const valueIndex = cellIndex(dataset, definition.column);
  const aggregate = normalizeAggregate(definition.aggregate);
  const categories: string[] = [];
  const categorySeen = new Set<string>();
  const seriesNames: string[] = [];
  const seriesSeen = new Set<string>();
  const buckets = new Map<string, CellValue[]>();
  for (const row of dataset.rows) {
    const category = asLabel(row[categoryIndex]);
    const name = asLabel(row[seriesIndex]);
    if (!categorySeen.has(category)) {
      categorySeen.add(category);
      categories.push(category);
    }
    if (!seriesSeen.has(name)) {
      seriesSeen.add(name);
      seriesNames.push(name);
    }
    const key = `${category}\u0000${name}`;
    const cells = buckets.get(key) ?? [];
    cells.push(row[valueIndex] ?? null);
    buckets.set(key, cells);
  }
  return {
    categories,
    series: seriesNames.map((name) => ({
      name,
      data: categories.map((category) => aggregateCells(buckets.get(`${category}\u0000${name}`) ?? [], aggregate)),
    })),
  };
}

function categoryTable(dataset: Dataset, spec: ChartSpec): CategoryTable {
  return spec.slots!.series ? longTable(dataset, spec) : wideTable(dataset, spec);
}

function axisBase(categories: string[], horizontal: boolean): Json {
  return {
    tooltip: { trigger: 'axis' },
    legend: { type: 'scroll', bottom: 0 },
    grid: { left: 56, right: 32, top: 40, bottom: 56, containLabel: true },
    xAxis: horizontal ? { type: 'value' } : { type: 'category', data: categories },
    yAxis: horizontal ? { type: 'category', data: categories } : { type: 'value' },
  };
}

function categoryOption(entry: CatalogEntry, table: CategoryTable, preset: Preset | undefined): Json {
  const horizontal = entry.type === 'horizontalbar';
  return {
    animation: false,
    ...axisBase(table.categories, horizontal),
    series: table.series.map((series) => ({
      ...(preset?.series ?? {}),
      name: series.name,
      type: entry.seriesType,
      data: series.data,
    })),
  };
}

function pieOption(entry: CatalogEntry, table: CategoryTable, preset: Preset | undefined): Json {
  const series = table.series[0]!;
  return {
    animation: false,
    tooltip: { trigger: 'item' },
    legend: { type: 'scroll', bottom: 0 },
    series: [
      {
        name: series.name,
        type: 'pie',
        radius: '65%',
        center: ['50%', '48%'],
        ...(preset?.series ?? {}),
        data: table.categories.map((name, index) => ({ name, value: series.data[index] })),
      },
    ],
  };
}

function scatterOption(entry: CatalogEntry, dataset: Dataset, spec: ChartSpec, preset: Preset | undefined): Json {
  const slots = spec.slots!;
  const xIndex = cellIndex(dataset, slots.x!);
  const yIndex = cellIndex(dataset, slots.y!);
  const seriesIndex = slots.series ? cellIndex(dataset, slots.series) : null;
  const sizeIndex = slots.size ? cellIndex(dataset, slots.size) : null;
  const groups = new Map<string, Array<[number, number] | [number, number, number]>>();
  for (const row of dataset.rows) {
    const x = asNumber(row[xIndex]);
    const y = asNumber(row[yIndex]);
    if (x === null || y === null) continue;
    const name = seriesIndex === null ? '数据' : asLabel(row[seriesIndex]);
    const point: [number, number] | [number, number, number] =
      sizeIndex === null ? [x, y] : [x, y, asNumber(row[sizeIndex]) ?? 0];
    const points = groups.get(name) ?? [];
    points.push(point);
    groups.set(name, points);
  }
  return {
    animation: false,
    tooltip: { trigger: 'item' },
    legend: { type: 'scroll', bottom: 0 },
    grid: { left: 56, right: 32, top: 40, bottom: 56, containLabel: true },
    xAxis: { type: 'value' },
    yAxis: { type: 'value' },
    series: [...groups].map(([name, data]) => ({
      ...(preset?.series ?? {}),
      name,
      type: entry.seriesType,
      data,
    })),
  };
}

function heatmapOption(entry: CatalogEntry, dataset: Dataset, spec: ChartSpec, preset: Preset | undefined): Json {
  const slots = spec.slots!;
  const xIndex = cellIndex(dataset, slots.category!);
  const yIndex = cellIndex(dataset, slots.series!);
  const valueIndex = cellIndex(dataset, slots.values![0]!.column);
  const aggregate = normalizeAggregate(slots.values![0]!.aggregate);
  const xs: string[] = [];
  const xSeen = new Set<string>();
  const ys: string[] = [];
  const ySeen = new Set<string>();
  const buckets = new Map<string, CellValue[]>();
  for (const row of dataset.rows) {
    const x = asLabel(row[xIndex]);
    const y = asLabel(row[yIndex]);
    if (!xSeen.has(x)) {
      xSeen.add(x);
      xs.push(x);
    }
    if (!ySeen.has(y)) {
      ySeen.add(y);
      ys.push(y);
    }
    const key = `${x}\u0000${y}`;
    const cells = buckets.get(key) ?? [];
    cells.push(row[valueIndex] ?? null);
    buckets.set(key, cells);
  }
  const data: Array<[number, number, number]> = [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  xs.forEach((x, xIndexValue) => {
    ys.forEach((y, yIndexValue) => {
      const value = aggregateCells(buckets.get(`${x}\u0000${y}`) ?? [], aggregate);
      if (value === null) return;
      min = Math.min(min, value);
      max = Math.max(max, value);
      data.push([xIndexValue, yIndexValue, value]);
    });
  });
  if (data.length === 0) {
    min = 0;
    max = 1;
  }
  return {
    animation: false,
    tooltip: { trigger: 'item' },
    grid: { left: 96, right: 32, top: 32, bottom: 72 },
    xAxis: { type: 'category', data: xs, splitArea: { show: true } },
    yAxis: { type: 'category', data: ys, splitArea: { show: true } },
    visualMap: {
      min,
      max,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      inRange: { color: ['#e8f3ff', '#409eff', '#1b4f8a'] },
    },
    series: [{ ...(preset?.series ?? {}), type: 'heatmap', data }],
  };
}

function boxplotOption(entry: CatalogEntry, dataset: Dataset, spec: ChartSpec, preset: Preset | undefined): Json {
  const slots = spec.slots!;
  const categoryIndex = slots.category ? cellIndex(dataset, slots.category) : null;
  const valueIndexes = (slots.values ?? []).slice(0, 5).map((value) => cellIndex(dataset, value.column));
  const categories: string[] = [];
  const data: number[][] = [];
  dataset.rows.forEach((row, rowIndex) => {
    const five = valueIndexes.map((index) => asNumber(row[index]));
    if (five.some((value) => value === null)) return;
    categories.push(categoryIndex === null ? String(rowIndex + 1) : asLabel(row[categoryIndex]));
    data.push(five as number[]);
  });
  return {
    animation: false,
    tooltip: { trigger: 'item' },
    grid: { left: 56, right: 32, top: 40, bottom: 56, containLabel: true },
    xAxis: { type: 'category', data: categories },
    yAxis: { type: 'value' },
    series: [{ ...(preset?.series ?? {}), type: 'boxplot', data }],
  };
}

function graphOption(entry: CatalogEntry, dataset: Dataset, spec: ChartSpec, preset: Preset | undefined): Json {
  const slots = spec.slots!;
  const sourceIndex = cellIndex(dataset, slots.source!);
  const targetIndex = cellIndex(dataset, slots.target!);
  const valueIndex = cellIndex(dataset, slots.values![0]!.column);
  const aggregate = normalizeAggregate(slots.values![0]!.aggregate);
  const nodes: string[] = [];
  const nodeSeen = new Set<string>();
  const buckets = new Map<string, CellValue[]>();
  for (const row of dataset.rows) {
    const source = asLabel(row[sourceIndex]);
    const target = asLabel(row[targetIndex]);
    if (!source || !target) continue;
    for (const node of [source, target]) {
      if (!nodeSeen.has(node)) {
        nodeSeen.add(node);
        nodes.push(node);
      }
    }
    const key = `${source}\u0000${target}`;
    const cells = buckets.get(key) ?? [];
    cells.push(row[valueIndex] ?? null);
    buckets.set(key, cells);
  }
  const links = [...buckets].map(([key, cells]) => {
    const [source, target] = key.split('\u0000') as [string, string];
    return { source, target, value: aggregateCells(cells, aggregate) ?? 0 };
  });
  const common = {
    animation: false,
    tooltip: { trigger: 'item' },
  };
  if (entry.seriesType === 'sankey') {
    return {
      ...common,
      series: [{ ...(preset?.series ?? {}), type: 'sankey', data: nodes.map((name) => ({ name })), links, emphasis: { focus: 'adjacency' } }],
    };
  }
  return {
    ...common,
    series: [
      {
        layout: 'force',
        roam: true,
        ...(preset?.series ?? {}),
        type: 'graph',
        data: nodes.map((name) => ({ name })),
        links,
      },
    ],
  };
}

function radarOption(entry: CatalogEntry, table: CategoryTable, preset: Preset | undefined): Json {
  const maxima = table.categories.map((_, index) =>
    Math.max(1, ...table.series.map((series) => series.data[index] ?? 0)),
  );
  return {
    animation: false,
    tooltip: {},
    legend: { type: 'scroll', bottom: 0 },
    radar: {
      indicator: table.categories.map((name, index) => ({ name, max: maxima[index] })),
      radius: '62%',
      center: ['50%', '52%'],
    },
    series: [
      {
        ...(preset?.series ?? {}),
        type: 'radar',
        data: table.series.map((series) => ({ name: series.name, value: series.data.map((value) => value ?? 0) })),
      },
    ],
  };
}

function funnelOption(entry: CatalogEntry, table: CategoryTable, preset: Preset | undefined): Json {
  const series = table.series[0]!;
  const items = table.categories
    .map((name, index) => ({ name, value: series.data[index] ?? 0 }))
    .sort((a, b) => b.value - a.value);
  return {
    animation: false,
    tooltip: { trigger: 'item' },
    legend: { type: 'scroll', bottom: 0 },
    series: [{ ...(preset?.series ?? {}), type: 'funnel', left: '10%', right: '10%', top: 40, bottom: 48, data: items }],
  };
}

function gaugeOption(entry: CatalogEntry, table: CategoryTable, preset: Preset | undefined): Json {
  const series = table.series[0];
  const total = series ? series.data.reduce<number>((sum, value) => sum + (value ?? 0), 0) : 0;
  return {
    animation: false,
    series: [
      {
        ...(preset?.series ?? {}),
        type: 'gauge',
        progress: { show: true },
        detail: { valueAnimation: false },
        data: [{ name: table.categories[0] ?? '', value: total }],
      },
    ],
  };
}

function tableResult(dataset: Dataset, spec: ChartSpec): BuildResult {
  const keys = spec.slots?.detail?.length ? spec.slots.detail : dataset.columns.map((column) => column.key);
  const indexes = keys.map((key) => cellIndex(dataset, key));
  const columns = keys.map((key) => {
    const column = columnOf(dataset, key);
    return { key: column.key, label: column.label, type: column.type };
  });
  const rows = dataset.rows.map((row) => indexes.map((index) => row[index] ?? null));
  return {
    kind: 'table',
    shape: 'table',
    seriesCount: 0,
    points: rows.length,
    option: { table: { columns, rows } },
  };
}

function cardsResult(dataset: Dataset, spec: ChartSpec): BuildResult {
  const slots = spec.slots!;
  const titleIndex = cellIndex(dataset, slots.category!);
  const mainIndex = cellIndex(dataset, slots.values![0]!.column);
  const targetIndex = slots.values?.[1] ? cellIndex(dataset, slots.values[1]!.column) : null;
  const badgeIndex = slots.detail?.[0] ? cellIndex(dataset, slots.detail[0]) : null;
  const subIndex = slots.detail?.[1] ? cellIndex(dataset, slots.detail[1]) : null;
  const items = dataset.rows.map((row) => ({
    title: asLabel(row[titleIndex]),
    main: row[mainIndex] ?? null,
    target: targetIndex === null ? null : (row[targetIndex] ?? null),
    badge: badgeIndex === null ? null : (row[badgeIndex] ?? null),
    sub: subIndex === null ? null : (row[subIndex] ?? null),
  }));
  return {
    kind: 'cards',
    shape: 'cards',
    seriesCount: 0,
    points: items.length,
    option: { cards: { items } },
  };
}

function countSeriesPoints(series: Json): number {
  if (Array.isArray(series.nodes) && Array.isArray(series.links)) {
    return series.nodes.length + series.links.length;
  }
  const data = series.data;
  if (Array.isArray(data)) {
    return data.filter((value) => {
      if (value === null || value === undefined) return false;
      if (Array.isArray(value)) return true;
      if (typeof value === 'object') {
        const record = value as Json;
        if ('value' in record && (record.value === null || record.value === undefined)) return false;
        return Object.keys(record).length > 0;
      }
      return true;
    }).length;
  }
  return data === undefined ? 0 : 1;
}

function bakedResult(spec: ChartSpec, entry: CatalogEntry): BuildResult {
  const option = { animation: false, ...(spec.option ?? {}) } as Json;
  const series = Array.isArray(option.series) ? (option.series as Json[]) : [];
  const points = series.length
    ? series.reduce((sum, item) => sum + countSeriesPoints(item), 0)
    : option.graphic || option.table || option.cards
      ? 1
      : 0;
  return { kind: 'chart', shape: entry.shape, option, seriesCount: series.length, points };
}

function buildDataResult(
  entry: CatalogEntry,
  dataset: Dataset,
  spec: ChartSpec,
  preset: Preset | undefined,
): BuildResult {
  switch (entry.shape) {
    case 'category': {
      const option = categoryOption(entry, categoryTable(dataset, spec), preset);
      return chartResult(option, entry.shape);
    }
    case 'pie': {
      const option = pieOption(entry, categoryTable(dataset, spec), preset);
      return chartResult(option, entry.shape);
    }
    case 'scatter': {
      const option = scatterOption(entry, dataset, spec, preset);
      return chartResult(option, entry.shape);
    }
    case 'heatmap': {
      const option = heatmapOption(entry, dataset, spec, preset);
      return chartResult(option, entry.shape);
    }
    case 'boxplot': {
      const option = boxplotOption(entry, dataset, spec, preset);
      return chartResult(option, entry.shape);
    }
    case 'graph': {
      const option = graphOption(entry, dataset, spec, preset);
      return chartResult(option, entry.shape);
    }
    case 'radar': {
      const option = radarOption(entry, categoryTable(dataset, spec), preset);
      return chartResult(option, entry.shape);
    }
    case 'funnel': {
      const option = funnelOption(entry, categoryTable(dataset, spec), preset);
      return chartResult(option, entry.shape);
    }
    case 'gauge': {
      const option = gaugeOption(entry, categoryTable(dataset, spec), preset);
      return chartResult(option, entry.shape);
    }
    case 'table':
      return tableResult(dataset, spec);
    case 'cards':
      return cardsResult(dataset, spec);
  }
}

function chartResult(option: Json, shape: string): BuildResult {
  const series = Array.isArray(option.series) ? (option.series as Json[]) : [];
  const points = series.reduce((sum, item) => sum + countSeriesPoints(item), 0);
  return { kind: 'chart', shape, option, seriesCount: series.length, points };
}

export function buildOption(bundle: Bundle, spec: ChartSpec): BuildResult {
  const entry = catalogOf(spec.type);
  const preset = presetOf(entry, spec.preset);
  validateSpec(spec, bundle.datasets);
  const result =
    spec.mode === 'baked'
      ? bakedResult(spec, entry)
      : buildDataResult(entry, datasetOf(bundle, spec.datasetId!), spec, preset);
  applyStyle(result.option, spec.style, {
    shape: entry.shape,
    horizontal: entry.type === 'horizontalbar',
  });
  return result;
}
