/**
 * 图表目录：平台内置、只读。新增形态＝改本文件并补回归，不是运行时注册。
 * 这里只描述语义（shape/preset/series 类型），不依赖 ECharts 运行时。
 */
import { VizError } from './errors.js';

export type DataShape =
  | 'category'
  | 'pie'
  | 'scatter'
  | 'heatmap'
  | 'boxplot'
  | 'graph'
  | 'radar'
  | 'funnel'
  | 'gauge'
  | 'table'
  | 'cards';

export type SlotName = 'category' | 'values' | 'series' | 'x' | 'y' | 'size' | 'source' | 'target';

export interface Preset {
  label: string;
  /** 合并进每个 series 的字段 */
  series?: Record<string, unknown>;
  /** 深合并进 option 的字段（数组替换） */
  option?: Record<string, unknown>;
}

export interface CatalogEntry {
  type: string;
  group: string;
  label: string;
  shape: DataShape;
  /** ECharts series.type；table/cards 不使用 */
  seriesType: string;
  presets?: Record<string, Preset>;
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    type: 'bar',
    group: '柱线',
    label: '纵条',
    shape: 'category',
    seriesType: 'bar',
    presets: {
      stacked: { label: '堆叠', series: { stack: 'total' } },
    },
  },
  {
    type: 'horizontalbar',
    group: '柱线',
    label: '横条',
    shape: 'category',
    seriesType: 'bar',
    presets: {
      stacked: { label: '堆叠', series: { stack: 'total' } },
    },
  },
  {
    type: 'line',
    group: '柱线',
    label: '折线',
    shape: 'category',
    seriesType: 'line',
    presets: {
      smooth: { label: '平滑', series: { smooth: true } },
      step: { label: '阶梯', series: { step: 'middle' } },
      area: { label: '面积', series: { areaStyle: { opacity: 0.35 } } },
      stacked: { label: '堆叠', series: { stack: 'total' } },
      stackedarea: { label: '堆叠面积', series: { stack: 'total', areaStyle: { opacity: 0.35 } } },
    },
  },
  {
    type: 'pie',
    group: '占比',
    label: '饼图',
    shape: 'pie',
    seriesType: 'pie',
    presets: {
      donut: { label: '环图', series: { radius: ['52%', '72%'] } },
      rose: { label: '南丁格尔玫瑰', series: { roseType: 'radius' } },
    },
  },
  {
    type: 'scatter',
    group: '散点',
    label: '散点',
    shape: 'scatter',
    seriesType: 'scatter',
  },
  {
    type: 'effectscatter',
    group: '散点',
    label: '涟漪散点',
    shape: 'scatter',
    seriesType: 'effectScatter',
    presets: {
      ripple: { label: '涟漪', series: { showEffectOn: 'render', rippleEffect: { scale: 3 } } },
    },
  },
  {
    type: 'heatmap',
    group: '矩阵',
    label: '热力图',
    shape: 'heatmap',
    seriesType: 'heatmap',
  },
  {
    type: 'boxplot',
    group: '分布',
    label: '箱线图',
    shape: 'boxplot',
    seriesType: 'boxplot',
  },
  {
    type: 'sankey',
    group: '关系',
    label: '桑基图',
    shape: 'graph',
    seriesType: 'sankey',
  },
  {
    type: 'graph',
    group: '关系',
    label: '关系图',
    shape: 'graph',
    seriesType: 'graph',
    presets: {
      force: { label: '力导向', series: { layout: 'force', roam: true } },
    },
  },
  {
    type: 'radar',
    group: '对比',
    label: '雷达图',
    shape: 'radar',
    seriesType: 'radar',
  },
  {
    type: 'funnel',
    group: '流程',
    label: '漏斗图',
    shape: 'funnel',
    seriesType: 'funnel',
  },
  {
    type: 'gauge',
    group: '指标',
    label: '仪表盘',
    shape: 'gauge',
    seriesType: 'gauge',
  },
  {
    type: 'table',
    group: '表格',
    label: '表格',
    shape: 'table',
    seriesType: '',
  },
  {
    type: 'cards',
    group: '指标',
    label: '指标卡行',
    shape: 'cards',
    seriesType: '',
  },
];

const BY_TYPE = new Map(CATALOG.map((entry) => [entry.type, entry]));

export function catalogOf(type: string): CatalogEntry {
  const entry = BY_TYPE.get(type);
  if (!entry) throw new VizError('CHART_TYPE_UNKNOWN', type);
  return entry;
}

export function presetOf(entry: CatalogEntry, preset: string | undefined): Preset | undefined {
  if (!preset) return undefined;
  const found = entry.presets?.[preset];
  if (!found) throw new VizError('CHART_PRESET_UNKNOWN', `${entry.type}/${preset}`);
  return found;
}

/** 该形态必需的槽位；用于 plan/build 的缺口诊断。 */
export function requiredSlots(entry: CatalogEntry): SlotName[] {
  switch (entry.shape) {
    case 'category':
    case 'pie':
    case 'funnel':
    case 'gauge':
    case 'radar':
    case 'cards':
      return ['category', 'values'];
    case 'heatmap':
      return ['category', 'series', 'values'];
    case 'boxplot':
      return ['values'];
    case 'scatter':
      return ['x', 'y'];
    case 'graph':
      return ['source', 'target', 'values'];
    case 'table':
      return [];
  }
}

/** 该形态是否消费 ECharts series。 */
export function usesSeries(entry: CatalogEntry): boolean {
  return entry.shape !== 'table' && entry.shape !== 'cards';
}
