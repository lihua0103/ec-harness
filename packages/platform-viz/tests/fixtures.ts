import type { Bundle, ChartSpec, Dataset, Layout } from '../src/spec.js';

export function sitesDataset(): Dataset {
  return {
    id: 'ds_sites',
    name: '中心监测',
    columns: [
      { key: 'site', label: '中心', type: 'text' },
      { key: 'pages', label: '页面数', type: 'number' },
      { key: 'visits', label: '访视数', type: 'number' },
      { key: 'quarter', label: '季度', type: 'text' },
      { key: 'country', label: '国家', type: 'text' },
    ],
    rows: [
      ['S001', 10, 4, 'Q1', 'China'],
      ['S001', 6, 2, 'Q2', 'China'],
      ['S002', 8, 3, 'Q1', 'Japan'],
      ['S002', 2, 1, 'Q2', 'Japan'],
      ['S003', 5, 5, 'Q1', 'Korea'],
    ],
  };
}

export function heatDataset(): Dataset {
  return {
    id: 'ds_heat',
    name: '矩阵',
    columns: [
      { key: 'site', label: '中心', type: 'text' },
      { key: 'metric', label: '指标', type: 'text' },
      { key: 'value', label: '值', type: 'number' },
    ],
    rows: [
      ['S1', 'ALT', 3],
      ['S1', 'AST', 1],
      ['S2', 'ALT', 5],
      ['S2', 'AST', 2],
    ],
  };
}

export function boxDataset(): Dataset {
  return {
    id: 'ds_box',
    name: '箱线',
    columns: [
      { key: 'site', label: '中心', type: 'text' },
      { key: 'q0', label: 'min', type: 'number' },
      { key: 'q1', label: 'q1', type: 'number' },
      { key: 'q2', label: 'med', type: 'number' },
      { key: 'q3', label: 'q3', type: 'number' },
      { key: 'q4', label: 'max', type: 'number' },
    ],
    rows: [
      ['S1', 1, 2, 3, 4, 5],
      ['S2', 2, 3, 4, 5, 6],
    ],
  };
}

export function flowDataset(): Dataset {
  return {
    id: 'ds_flow',
    name: '流转',
    columns: [
      { key: 'source', label: '来源', type: 'text' },
      { key: 'target', label: '去向', type: 'text' },
      { key: 'value', label: '人数', type: 'number' },
    ],
    rows: [
      ['Screening', 'Randomized', 120],
      ['Screening', 'Screen fail', 30],
      ['Randomized', 'Completed', 100],
    ],
  };
}

export function scatterDataset(): Dataset {
  return {
    id: 'ds_scatter',
    name: '散点',
    columns: [
      { key: 'x', label: 'X', type: 'number' },
      { key: 'y', label: 'Y', type: 'number' },
      { key: 'size', label: '大小', type: 'number' },
      { key: 'group', label: '分组', type: 'text' },
    ],
    rows: [
      [1, 2, 10, 'A'],
      [2, 4, 20, 'A'],
      [3, 3, 15, 'B'],
      [4, 5, 25, 'B'],
      [null, 1, 5, 'A'],
    ],
  };
}

export function cardsDataset(): Dataset {
  return {
    id: 'ds_cards',
    name: '指标卡',
    columns: [
      { key: 'title', label: '指标', type: 'text' },
      { key: 'main', label: '当前', type: 'number' },
      { key: 'target', label: '目标', type: 'number' },
      { key: 'badge', label: '状态', type: 'text' },
      { key: 'sub', label: '说明', type: 'text' },
    ],
    rows: [
      ['Enrollment', 3268, 3968, 'On track', '+82% of plan'],
      ['Sites active', 120, null, 'High', '12 countries'],
    ],
  };
}

export function tableDataset(): Dataset {
  return {
    id: 'ds_table',
    name: '表格',
    columns: [
      { key: 'country', label: '国家', type: 'text' },
      { key: 'sites', label: '中心数', type: 'number' },
      { key: 'rate', label: '录入率', type: 'number' },
    ],
    rows: [
      ['China', 12, 0.42],
      ['Japan', 8, 0.31],
      ['Korea', 5, 0.27],
    ],
  };
}

export function emptyDataset(): Dataset {
  return {
    id: 'ds_empty',
    name: '空数据',
    columns: [
      { key: 'site', label: '中心', type: 'text' },
      { key: 'pages', label: '页面数', type: 'number' },
    ],
    rows: [],
  };
}

export function allDatasets(): Dataset[] {
  return [
    sitesDataset(),
    heatDataset(),
    boxDataset(),
    flowDataset(),
    scatterDataset(),
    cardsDataset(),
    tableDataset(),
    emptyDataset(),
  ];
}

export function bundleOf(specs: ChartSpec[], layout: Layout, datasets: Dataset[] = allDatasets()): Bundle {
  return { datasets, specs, layout };
}

export function spec(overrides: Partial<ChartSpec> & { id: string; title: string; type: string }): ChartSpec {
  return { mode: 'data', ...overrides } as ChartSpec;
}

export function layout(items: Layout['items'], pageId = 'page1'): Layout {
  return { pageId, title: '验收页', columns: 24, rowHeight: 36, items };
}
