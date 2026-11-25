/**
 * 把设计稿图表编译成可保存的规格与布局：baked 规格 + 标签文字静态化。
 * 这是通用能力：任何设计稿提取结果都能编译，不需要为单张图写补丁。
 */
import { catalogOf } from './catalog.js';
import type { DesignChart, DesignLabelTexts } from './design.js';
import type { ChartSpec, Layout } from './spec.js';

type Json = Record<string, unknown>;

const NUMERIC_TEXT = /^-?\d+(\.\d+)?%?$/;

/** 把函数标签的可求值结果落成静态文本：纯数字用 {c}，文字用 data.name + '{b}'，不可靠则跳过。 */
export function applyDesignLabels(option: Json, labelTexts: DesignLabelTexts[] | undefined): Json {
  const copy = JSON.parse(JSON.stringify(option)) as Json;
  for (const entry of labelTexts ?? []) {
    if (entry.key !== 'label') continue;
    const seriesList = Array.isArray(copy.series) ? (copy.series as Json[]) : [];
    const series = seriesList[entry.series];
    if (!series) continue;
    const texts = entry.texts ?? [];
    const seriesType = String(series.type);
    const data = Array.isArray(series.data) ? (series.data as unknown[]) : [];
    const scalar = data.every((item) => item === null || typeof item !== 'object');
    if (['bar', 'line'].includes(seriesType) && scalar) {
      if (texts.length && texts.every((text) => NUMERIC_TEXT.test(String(text).trim()))) {
        series.label = { ...(series.label as Json), show: true, formatter: '{c}' };
        continue;
      }
      if (!texts.length || texts.some((text) => !text || /undefined|NaN/.test(String(text)))) continue;
      series.data = data.map((item, index) => ({ value: item, name: texts[index] ?? '' }));
      series.label = { ...(series.label as Json), show: true, formatter: '{b}' };
      continue;
    }
    // 热力图等对象项：设计里的 value 常是归一化值，真实文字在 raw/rawText/text 或已求值的 texts。
    if (data.some((item) => item && typeof item === 'object')) {
      series.data = data.map((item, index) => {
        const record = (item ?? {}) as Json;
        const fromTexts = texts[index];
        const usable = fromTexts && !/undefined|NaN/.test(String(fromTexts)) ? String(fromTexts) : undefined;
        const raw = typeof record.raw === 'number' ? record.raw : record.rawText !== undefined ? record.rawText : record.text !== undefined ? record.text : undefined;
        const name = usable ?? (raw === undefined || raw === null || raw === '' ? '—' : String(raw));
        return { ...record, name };
      });
      series.label = { ...(series.label as Json), show: true, formatter: '{b}' };
    }
  }
  copy.backgroundColor = 'transparent';
  copy.animation = false;
  // 设计里热力图的 visualMap 可能是空数组，渲染器会直接报错；补一个最小映射。
  const seriesList = Array.isArray(copy.series) ? (copy.series as Json[]) : [];
  const heatmap = seriesList.find((series) => series.type === 'heatmap');
  if (heatmap && (!Array.isArray(copy.visualMap) || (copy.visualMap as unknown[]).length === 0)) {
    const values = (Array.isArray(heatmap.data) ? (heatmap.data as Json[]) : [])
      .map((item) => (typeof item.raw === 'number' ? item.raw : Array.isArray(item.value) ? Number(item.value[2]) : 0))
      .filter((value) => Number.isFinite(value));
    copy.visualMap = [{ type: 'continuous', min: 0, max: Math.max(1, ...values), show: false, inRange: { color: ['#f3f6f8', '#a8c3d6', '#587d9f'] } }];
  }
  return copy;
}

export interface CompiledDesign {
  specs: ChartSpec[];
  layout: Layout;
  skipped: Array<{ card: string; reason: string }>;
}

export function compileDesignCharts(charts: DesignChart[], pageId: string): CompiledDesign {
  const specs: ChartSpec[] = [];
  const skipped: Array<{ card: string; reason: string }> = [];
  const items: Layout['items'] = [];
  charts.forEach((chart, index) => {
    const key = chart.card || `o${chart.order}`;
    const series = Array.isArray(chart.option.series) ? (chart.option.series as Json[]) : [];
    const type = String((series[0] && series[0].type) || 'bar');
    try {
      catalogOf(type);
    } catch {
      skipped.push({ card: key, reason: `CHART_TYPE_UNSUPPORTED:${type}` });
      return;
    }
    const spec: ChartSpec = {
      id: `viz_${key}`,
      title: chart.title || key,
      mode: 'baked',
      type,
      option: applyDesignLabels(chart.option, chart.labelTexts),
      note: `design ${key}`,
    };
    specs.push(spec);
    items.push({ kind: 'chart', i: `viz_${key}`, specId: spec.id, x: (index % 3) * 8, y: Math.floor(index / 3) * 10, w: 8, h: 10 });
  });
  return { specs, layout: { pageId, columns: 24, rowHeight: 36, items }, skipped };
}
