/**
 * 样式键适配：全部是显式契约，未声明时零差异。
 * 函数型 formatter 不能进 JSON，因此用 {__fn:name} 标记，由渲染壳还原。
 */
import type { ChartStyle } from './spec.js';

export const DEFAULT_PALETTE = [
  '#409eff',
  '#67c23a',
  '#e6a23c',
  '#f56c6c',
  '#909399',
  '#5470c6',
  '#91cc75',
  '#fac858',
  '#ee6666',
  '#73c0de',
  '#3ba272',
  '#fc8452',
];

type Json = Record<string, unknown>;

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

function seriesOf(option: Json): Json[] {
  return asArray(option.series);
}

function axisOf(option: Json, key: 'xAxis' | 'yAxis'): Json | undefined {
  const value = option[key];
  if (Array.isArray(value)) return (value[0] as Json) ?? undefined;
  return value && typeof value === 'object' ? (value as Json) : undefined;
}

export interface StyleContext {
  shape: string;
  horizontal?: boolean;
}

/** Mutates `option` in place; safe to call on both data-driven and baked options. */
export function applyStyle(option: Json, style: ChartStyle | undefined, context: StyleContext): void {
  if (!style) return;
  if (style.palette?.length) option.color = [...style.palette];
  else if (!option.color) option.color = [...DEFAULT_PALETTE];

  const legend = option.legend && typeof option.legend === 'object' ? (option.legend as Json) : {};
  if (style.legend === false) {
    legend.show = false;
    option.legend = legend;
  } else if (option.legend !== undefined || style.legendWithValue || style.legendPosition) {
    if (style.legendPosition) {
      for (const key of ['top', 'bottom', 'left', 'right']) delete legend[key];
      legend[style.legendPosition] = 0;
    }
    if (style.legendWithValue) legend.formatter = { __fn: 'legendWithValue' };
    option.legend = legend;
  }

  const series = seriesOf(option);
  if (style.stackAll) {
    if (['category'].includes(context.shape)) {
      for (const item of series) item.stack = 'total';
    }
  }
  if (style.seriesColors?.length) {
    series.forEach((item, index) => {
      const color = style.seriesColors![index % style.seriesColors!.length]!;
      item.itemStyle = { ...(item.itemStyle as Json), color };
      if (item.type === 'line') item.lineStyle = { ...(item.lineStyle as Json), color };
    });
  }
  if (style.seriesDash?.length) {
    for (const index of style.seriesDash) {
      const item = series[index];
      if (!item) continue;
      item.lineStyle = { ...(item.lineStyle as Json), type: 'dashed' };
    }
  }
  if (typeof style.seriesBarWidth === 'number' || typeof style.seriesBarWidth === 'string') {
    for (const item of series) if (item.type === 'bar') item.barWidth = style.seriesBarWidth;
  }
  if (style.itemColors?.length && series.length === 1) {
    const item = series[0]!;
    if (item.type === 'pie' || item.type === 'funnel') {
      const data = asArray(item.data);
      item.data = data.map((entry, index) => ({
        ...entry,
        itemStyle: { ...(entry.itemStyle as Json), color: style.itemColors![index % style.itemColors!.length] },
      }));
    } else if (Array.isArray(item.data)) {
      item.data = (item.data as unknown[]).map((value, index) =>
        value && typeof value === 'object'
          ? value
          : { value, itemStyle: { color: style.itemColors![index % style.itemColors!.length] } },
      );
    }
  }
  if (style.valueLabels) {
    for (const item of series) {
      const position = context.horizontal ? 'right' : 'top';
      item.label = { show: true, position, ...(item.label as Json) };
    }
  }
  if (style.endLabels) {
    for (const item of series) {
      if (item.type !== 'line') continue;
      item.label = { show: true, position: 'right', formatter: '{c}', ...(item.label as Json) };
      item.endLabel = { show: true, formatter: '{c}' };
    }
  }
  if (style.hideLabels) {
    for (const item of series) {
      item.label = { ...(item.label as Json), show: false };
    }
  }
  if (style.yAxisInverse) {
    const axis = axisOf(option, 'yAxis');
    if (axis) axis.inverse = true;
  }
  if (context.shape === 'pie' && (style.centerText || style.centerSubText || style.centerTop)) {
    const graphic = asArray(option.graphic);
    if (style.centerText) {
      graphic.push({
        type: 'text',
        left: 'center',
        top: style.centerTop ?? '42%',
        silent: true,
        style: { text: style.centerText, textAlign: 'center', fontSize: 18, fontWeight: 600 },
      });
    }
    if (style.centerSubText) {
      graphic.push({
        type: 'text',
        left: 'center',
        top: style.centerTop ? `${Number.parseFloat(String(style.centerTop)) + 6}%` : '54%',
        silent: true,
        style: { text: style.centerSubText, textAlign: 'center', fontSize: 11 },
      });
    }
    option.graphic = graphic;
  }
}
