import type { Bundle, ChartSpec, Dataset, Layout } from '../../../packages/platform-viz/src/index.js';

/** dm-viz 宿主层测试本地夹具：只保留 targets 测试所需的最小数据集。 */

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

export function allDatasets(): Dataset[] {
  return [sitesDataset(), tableDataset()];
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
