/**
 * 目标系统适配器：同一份 bundle 落到平台自身或外部系统。
 * 核心只认识 Bundle；外部差异留在适配器内，不回流成平台规则。
 *
 * 适配器输出的是"落位计划"（操作序列 + 缺口），执行由注入的 transport 完成，
 * 因此可以在没有外部系统的情况下做合同测试，也便于人工确认后再真正写入。
 */
import {
  buildOption,
  CATALOG,
  orderedItems,
  pageDigest,
  type Bundle,
  type ChartSpec,
  type Layout,
} from '../../../packages/platform-viz/src/index.js';

type Json = Record<string, unknown>;

export interface TargetCapabilities {
  runtimeTypeRegistration: boolean;
  supportedTypes: string[];
  supportsBaked: boolean;
  maxSeriesPerChart?: number;
  gridColumns: number;
}

export type OperationKind = 'upsertDataset' | 'registerChartType' | 'saveChartConfig' | 'saveChartLayout';

export interface ApplyOperation {
  op: OperationKind;
  ref: string;
  payload: Json;
}

export interface TargetPlan {
  targetId: string;
  digest: string;
  operations: ApplyOperation[];
  gaps: string[];
}

export interface TransportResult {
  ok: boolean;
  id?: string | number;
  detail?: string;
}

export interface TargetTransport {
  call(operation: ApplyOperation): Promise<TransportResult>;
}

export interface ApplyResult {
  targetId: string;
  digest: string;
  applied: number;
  gaps: string[];
  results: Array<{ ref: string; op: OperationKind; ok: boolean; id?: string | number; detail?: string }>;
}

export interface Target {
  id: string;
  kind: 'platform' | 'external';
  capabilities(): TargetCapabilities;
  plan(bundle: Bundle): TargetPlan;
  apply(bundle: Bundle, transport: TargetTransport): Promise<ApplyResult>;
}

const ALL_TYPES = CATALOG.map((entry) => entry.type);

/** 平台自身：配置直接写本插件存储，不产生外部操作。 */
export const platformTarget: Target = {
  id: 'platform',
  kind: 'platform',
  capabilities: () => ({
    runtimeTypeRegistration: false,
    supportedTypes: [...ALL_TYPES],
    supportsBaked: true,
    gridColumns: 24,
  }),
  plan(bundle) {
    return { targetId: 'platform', digest: pageDigest(bundle), operations: [], gaps: [] };
  },
  async apply(bundle) {
    return { targetId: 'platform', digest: pageDigest(bundle), applied: 0, gaps: [], results: [] };
  },
};

export interface RbqmOptions {
  supportedTypes?: string[];
  maxSeriesPerChart?: number;
  gridColumns?: number;
  supportsBaked?: boolean;
  runtimeTypeRegistration?: boolean;
}

function seriesCount(bundle: Bundle, spec: ChartSpec): number {
  return buildOption(bundle, spec).seriesCount;
}

function collectGaps(bundle: Bundle, capabilities: TargetCapabilities): string[] {
  const gaps: string[] = [];
  if (bundle.layout.columns !== capabilities.gridColumns) {
    gaps.push(`GRID_MISMATCH:${bundle.layout.columns}->${capabilities.gridColumns}`);
  }
  for (const spec of bundle.specs) {
    if (!capabilities.supportedTypes.includes(spec.type)) {
      gaps.push(`UNSUPPORTED_TYPE:${spec.type}@${spec.id}`);
      continue;
    }
    if (spec.mode === 'baked' && !capabilities.supportsBaked) {
      gaps.push(`BAKED_UNSUPPORTED:${spec.id}`);
    }
    if (spec.mode === 'baked' && !capabilities.runtimeTypeRegistration) {
      gaps.push(`BAKED_REQUIRES_REGISTRATION:${spec.id}`);
    }
    if (
      capabilities.maxSeriesPerChart !== undefined &&
      !capabilities.runtimeTypeRegistration
    ) {
      let count: number;
      try {
        count = seriesCount(bundle, spec);
      } catch {
        gaps.push(`BUILD_FAILED:${spec.id}`);
        continue;
      }
      if (count > capabilities.maxSeriesPerChart) {
        gaps.push(`SERIES_LIMIT:${spec.id}:${count}>${capabilities.maxSeriesPerChart}`);
      }
    }
  }
  return gaps;
}

/**
 * RBQM 适配器：外部系统需要运行时注册图表类型，多系列要靠注册自定义类型承载。
 * 这里只产出操作序列；真正写入由 transport（HTTP 客户端）执行。
 */
export function createRbqmTarget(options: RbqmOptions = {}): Target {
  const supportedTypes = options.supportedTypes ?? ALL_TYPES;
  const maxSeriesPerChart = options.maxSeriesPerChart ?? 1;
  const gridColumns = options.gridColumns ?? 24;
  const supportsBaked = options.supportsBaked ?? true;
  const runtimeTypeRegistration = options.runtimeTypeRegistration ?? true;
  const capabilities = (): TargetCapabilities => ({
    runtimeTypeRegistration,
    supportedTypes,
    supportsBaked,
    maxSeriesPerChart,
    gridColumns,
  });

  function plan(bundle: Bundle): TargetPlan {
    const capabilitiesValue = capabilities();
    const gaps = collectGaps(bundle, capabilitiesValue);
    const operations: ApplyOperation[] = [];
    const configRefs = new Map<string, string>();

    for (const dataset of bundle.datasets) {
      operations.push({
        op: 'upsertDataset',
        ref: `dataset:${dataset.id}`,
        payload: {
          id: dataset.id,
          name: dataset.name,
          columns: dataset.columns,
          rows: dataset.rows,
        },
      });
    }

    const specsById = new Map(bundle.specs.map((spec) => [spec.id, spec]));
    for (const spec of bundle.specs) {
      if (!supportedTypes.includes(spec.type)) continue;
      let built;
      try {
        built = buildOption(bundle, spec);
      } catch {
        continue;
      }
      const needsRegistration = capabilitiesValue.runtimeTypeRegistration;
      const typeRef = needsRegistration ? `type:${spec.id}` : `type:${spec.type}`;
      if (needsRegistration) {
        operations.push({
          op: 'registerChartType',
          ref: typeRef,
          payload: {
            chartName: spec.title,
            baseType: spec.type,
            preset: spec.preset ?? null,
            defaultOption: built.option,
            kind: built.kind,
          },
        });
      }
      configRefs.set(spec.id, `config:${spec.id}`);
      operations.push({
        op: 'saveChartConfig',
        ref: `config:${spec.id}`,
        payload: {
          specId: spec.id,
          chartType: typeRef,
          datasetId: spec.datasetId ?? null,
          slots: spec.slots ?? null,
          mode: spec.mode,
          style: spec.style ?? null,
          seriesCount: built.seriesCount,
        },
      });
    }

    const layoutItems: Json[] = [];
    for (const item of orderedItems(bundle.layout)) {
      if (item.kind === 'divider') {
        layoutItems.push({
          i: item.i,
          type: 3,
          chartName: item.title,
          style: item.style ?? null,
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
        });
        continue;
      }
      const spec = specsById.get(item.specId);
      if (!spec) continue;
      layoutItems.push({
        i: item.i,
        type: 1,
        ref: configRefs.get(item.specId) ?? null,
        chartType: `type:${item.specId}`,
        chartName: spec.title,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
      });
    }
    operations.push({
      op: 'saveChartLayout',
      ref: `layout:${bundle.layout.pageId}`,
      payload: {
        pageId: bundle.layout.pageId,
        columns: bundle.layout.columns,
        rowHeight: bundle.layout.rowHeight,
        items: layoutItems,
      },
    });

    return { targetId: 'rbqm', digest: pageDigest(bundle), operations, gaps };
  }

  return {
    id: 'rbqm',
    kind: 'external',
    capabilities,
    plan,
    async apply(bundle, transport) {
      const planned = plan(bundle);
      if (planned.gaps.length) {
        return {
          targetId: 'rbqm',
          digest: planned.digest,
          applied: 0,
          gaps: planned.gaps,
          results: [],
        };
      }
      const results: ApplyResult['results'] = [];
      for (const operation of planned.operations) {
        try {
          const result = await transport.call(operation);
          results.push({ ref: operation.ref, op: operation.op, ...result });
        } catch (error) {
          results.push({
            ref: operation.ref,
            op: operation.op,
            ok: false,
            detail: error instanceof Error ? error.message : 'TRANSPORT_FAILED',
          });
        }
      }
      return {
        targetId: 'rbqm',
        digest: planned.digest,
        applied: results.filter((result) => result.ok).length,
        gaps: [],
        results,
      };
    },
  };
}

export function targetOf(id: string): Target {
  if (id === 'platform') return platformTarget;
  if (id === 'rbqm') return createRbqmTarget();
  throw new Error(`TARGET_UNKNOWN:${id}`);
}

export function emptyLayout(pageId: string): Layout {
  return { pageId, columns: 24, rowHeight: 36, items: [] };
}
