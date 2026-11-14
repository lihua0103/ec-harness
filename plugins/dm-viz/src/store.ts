/** 会话内配置存储：数据集、规格、布局。写入是整单事务，失败不留下半成品。 */
import { fail } from './errors.js';
import {
  digestOf,
  validateDataset,
  validateLayout,
  validateSpec,
  type Bundle,
  type ChartItem,
  type ChartSpec,
  type Dataset,
  type Layout,
} from './spec.js';

export interface DatasetSummary {
  id: string;
  name: string;
  rowCount: number;
  columns: Array<{ key: string; label: string; type: string }>;
}

export class VizStore {
  private readonly datasets = new Map<string, Dataset>();
  private readonly specs = new Map<string, ChartSpec>();
  private readonly layouts = new Map<string, Layout>();

  putDataset(input: Dataset): Dataset {
    const dataset = validateDataset(input);
    this.datasets.set(dataset.id, dataset);
    return dataset;
  }

  getDataset(id: string): Dataset {
    const dataset = this.datasets.get(id);
    if (!dataset) fail('DATASET_NOT_FOUND', id);
    return dataset;
  }

  listDatasets(): DatasetSummary[] {
    return [...this.datasets.values()].map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      rowCount: dataset.rows.length,
      columns: dataset.columns.map((column) => ({ key: column.key, label: column.label, type: column.type })),
    }));
  }

  allDatasets(): Dataset[] {
    return [...this.datasets.values()];
  }

  datasetDigest(id: string): string {
    const dataset = this.getDataset(id);
    return digestOf({ columns: dataset.columns, rows: dataset.rows });
  }

  putSpecs(input: ChartSpec[]): ChartSpec[] {
    const datasets = [...this.datasets.values()];
    for (const spec of input) validateSpec(spec, datasets);
    for (const spec of input) this.specs.set(spec.id, spec);
    return input;
  }

  putLayout(layout: Layout): Layout {
    const issues = validateLayout(layout, [...this.specs.values()]);
    if (issues.length) {
      fail('LAYOUT_INVALID', issues.map((issue) => `${issue.code}@${issue.i}`).join(','));
    }
    this.layouts.set(layout.pageId, layout);
    return layout;
  }

  bundle(pageId: string): Bundle {
    const layout = this.layouts.get(pageId);
    if (!layout) fail('PAGE_NOT_FOUND', pageId);
    const ids = new Set<string>();
    for (const item of layout.items) {
      if (item.kind === 'chart') ids.add((item as ChartItem).specId);
    }
    const specs = [...ids].map((id) => {
      const spec = this.specs.get(id);
      if (!spec) fail('SPEC_NOT_FOUND', id);
      return spec;
    });
    return { datasets: [...this.datasets.values()], specs, layout };
  }

  describe(): {
    datasets: DatasetSummary[];
    specs: Array<{ id: string; title: string; type: string; mode: string }>;
    pages: Array<{ pageId: string; title?: string; items: number }>;
  } {
    return {
      datasets: this.listDatasets(),
      specs: [...this.specs.values()].map((spec) => ({
        id: spec.id,
        title: spec.title,
        type: spec.type,
        mode: spec.mode,
      })),
      pages: [...this.layouts.values()].map((layout) => ({
        pageId: layout.pageId,
        title: layout.title,
        items: layout.items.length,
      })),
    };
  }
}
