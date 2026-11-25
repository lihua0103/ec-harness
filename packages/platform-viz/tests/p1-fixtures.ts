import { layout, spec } from './fixtures.js';
import type { ChartSpec, Layout } from '../src/spec.js';

/** P1 合成页：12+ 类型、分隔符、堆叠/多系列、表格与指标卡。 */
export function p1Specs(): ChartSpec[] {
  return [
    spec({
      id: 'p_wide_stacked',
      title: '中心工作量（堆叠多系列）',
      type: 'horizontalbar',
      preset: 'stacked',
      datasetId: 'ds_sites',
      slots: { category: 'site', values: [{ column: 'pages' }, { column: 'visits' }] },
      style: { seriesColors: ['#3b82f6', '#f59e0b'], seriesBarWidth: 18 },
    }),
    spec({
      id: 'p_bar',
      title: '各中心页面数',
      type: 'bar',
      datasetId: 'ds_sites',
      slots: { category: 'site', values: [{ column: 'pages' }] },
      style: { valueLabels: true },
    }),
    spec({
      id: 'p_line',
      title: '页面与访视趋势',
      type: 'line',
      preset: 'smooth',
      datasetId: 'ds_sites',
      slots: { category: 'site', values: [{ column: 'pages' }, { column: 'visits' }] },
      style: { endLabels: true },
    }),
    spec({
      id: 'p_pie',
      title: '国家中心占比',
      type: 'pie',
      datasetId: 'ds_table',
      slots: { category: 'country', values: [{ column: 'sites' }] },
      style: { itemColors: ['#3b82f6', '#22c55e', '#f97316'] },
    }),
    spec({
      id: 'p_donut',
      title: '录入率构成',
      type: 'pie',
      preset: 'donut',
      datasetId: 'ds_table',
      slots: { category: 'country', values: [{ column: 'rate' }] },
      style: { centerText: '100%', centerSubText: '合计' },
    }),
    spec({
      id: 'p_scatter',
      title: '页面 / 访视散点',
      type: 'scatter',
      datasetId: 'ds_scatter',
      slots: { x: 'x', y: 'y', size: 'size', series: 'group' },
    }),
    spec({
      id: 'p_heat',
      title: '中心 × 指标',
      type: 'heatmap',
      datasetId: 'ds_heat',
      slots: { category: 'site', series: 'metric', values: [{ column: 'value' }] },
    }),
    spec({
      id: 'p_box',
      title: '分布箱线',
      type: 'boxplot',
      datasetId: 'ds_box',
      slots: {
        category: 'site',
        values: [{ column: 'q0' }, { column: 'q1' }, { column: 'q2' }, { column: 'q3' }, { column: 'q4' }],
      },
    }),
    spec({
      id: 'p_sankey',
      title: '受试者流转',
      type: 'sankey',
      datasetId: 'ds_flow',
      slots: { source: 'source', target: 'target', values: [{ column: 'value' }] },
    }),
    spec({
      id: 'p_radar',
      title: '中心能力雷达',
      type: 'radar',
      datasetId: 'ds_sites',
      slots: { category: 'site', values: [{ column: 'pages' }, { column: 'visits' }] },
    }),
    spec({
      id: 'p_funnel',
      title: '国家漏斗',
      type: 'funnel',
      datasetId: 'ds_table',
      slots: { category: 'country', values: [{ column: 'sites' }] },
    }),
    spec({
      id: 'p_gauge',
      title: '中心总量',
      type: 'gauge',
      datasetId: 'ds_table',
      slots: { category: 'country', values: [{ column: 'sites' }] },
    }),
    spec({ id: 'p_table', title: '国家明细', type: 'table', datasetId: 'ds_table' }),
    spec({
      id: 'p_cards',
      title: '关键指标卡',
      type: 'cards',
      datasetId: 'ds_cards',
      slots: { category: 'title', values: [{ column: 'main' }, { column: 'target' }], detail: ['badge', 'sub'] },
    }),
  ];
}

export function p1Layout(specs: ChartSpec[]): Layout {
  const items: Layout['items'] = [
    { kind: 'divider', i: 'd0', title: 'IG-NIDDK 中央总览', x: 0, y: 0, w: 24, h: 1, style: { subTitle: '合成数据' } },
  ];
  specs.forEach((chart, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    items.push({ kind: 'chart', i: `c${index}`, specId: chart.id, x: column * 8, y: 1 + row * 10, w: 8, h: 10 });
  });
  return layout(items, 'p1_page');
}
