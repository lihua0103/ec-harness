/**
 * 系统图表页的渲染模型与验收用渲染壳。
 * 渲染壳是验收面：打开即按配置渲染，不依赖后端接口。
 */
import { buildOption } from './option.js';
import { VizError } from './errors.js';
import {
  columnOf,
  datasetOf,
  orderedItems,
  pageDigest,
  type Bundle,
  type ChartSpec,
  type DividerStyle,
  type LayoutItem,
} from './spec.js';

type Json = Record<string, unknown>;

export interface RenderItem {
  i: string;
  kind: 'chart' | 'table' | 'cards' | 'divider';
  specId?: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  points: number;
  option?: Json;
  style?: DividerStyle;
}

export interface RenderModel {
  pageId: string;
  title: string;
  columns: 24;
  rowHeight: 36;
  heightPx: number;
  items: RenderItem[];
  digest: string;
}

function specOf(bundle: Bundle, specId: string): ChartSpec {
  const spec = bundle.specs.find((item) => item.id === specId);
  if (!spec) throw new VizError('SPEC_NOT_FOUND', specId);
  return spec;
}

export function buildItem(bundle: Bundle, item: LayoutItem): RenderItem {
  if (item.kind === 'divider') {
    return {
      i: item.i,
      kind: 'divider',
      title: item.title,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      points: 1,
      style: item.style,
    };
  }
  const spec = specOf(bundle, item.specId);
  const built = buildOption(bundle, spec);
  return {
    i: item.i,
    kind: built.kind,
    specId: spec.id,
    title: spec.title,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    points: built.points,
    option: built.option,
  };
}

export function buildModel(bundle: Bundle): RenderModel {
  const items = orderedItems(bundle.layout).map((item) => buildItem(bundle, item));
  const bottom = items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  return {
    pageId: bundle.layout.pageId,
    title: bundle.layout.title ?? bundle.layout.pageId,
    columns: 24,
    rowHeight: 36,
    heightPx: bottom * 36,
    items,
    digest: pageDigest(bundle),
  };
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function position(item: RenderItem): string {
  const left = (item.x / 24) * 100;
  const width = (item.w / 24) * 100;
  return `left:${left}%;top:${item.y * 36}px;width:${width}%;height:${item.h * 36}px`;
}

function dividerHtml(item: RenderItem): string {
  const style = item.style ?? {};
  const title = `color:${style.titleColor ?? '#24485a'};font-size:${style.titleSize ?? 14}px;font-weight:600`;
  const sub = `color:${style.subTitleColor ?? '#536d78'};font-size:${style.subTitleSize ?? 11}px`;
  const subtitle = style.subTitle ? `<span class="viz-divider-sub" style="${sub}">${escapeHtml(style.subTitle)}</span>` : '';
  const line = style.showLine === false ? 'border-bottom:0' : '';
  const align = style.align ?? 'left';
  return `<div class="viz-divider" style="${position(item)};${line};text-align:${align}">
  <span style="${title}">${escapeHtml(item.title)}</span>${subtitle}
</div>`;
}

function tableHtml(item: RenderItem): string {
  const table = (item.option?.table ?? {}) as { columns?: Array<{ label: string }>; rows?: unknown[][] };
  const columns = table.columns ?? [];
  const rows = table.rows ?? [];
  const head = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell ?? '')}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="viz-card" style="${position(item)}" data-kind="table">
  <div class="viz-card-title">${escapeHtml(item.title)}</div>
  <div class="viz-card-body viz-table-wrap"><table class="viz-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
</div>`;
}

function cardsHtml(item: RenderItem): string {
  const cards = (item.option?.cards ?? {}) as { items?: Array<Record<string, unknown>> };
  const cardsHtmlValue = (cards.items ?? [])
    .map((card) => {
      const badge = card.badge ? `<span class="viz-badge">${escapeHtml(card.badge)}</span>` : '';
      const target = card.target === null || card.target === undefined ? '' : ` / ${escapeHtml(card.target)}`;
      const sub = card.sub ? `<div class="viz-card-sub">${escapeHtml(card.sub)}</div>` : '';
      return `<div class="viz-kpi">${badge}<div class="viz-kpi-title">${escapeHtml(card.title)}</div>
  <div class="viz-kpi-value">${escapeHtml(card.main ?? '')}${target}</div>${sub}</div>`;
    })
    .join('');
  return `<div class="viz-card" style="${position(item)}" data-kind="cards">
  <div class="viz-card-title">${escapeHtml(item.title)}</div>
  <div class="viz-card-body viz-cards">${cardsHtmlValue}</div>
</div>`;
}

function chartHtml(item: RenderItem): string {
  return `<div class="viz-card" style="${position(item)}" data-kind="chart">
  <div class="viz-card-title">${escapeHtml(item.title)}</div>
  <div class="viz-card-body" data-chart="${escapeHtml(item.i)}"></div>
</div>`;
}

export interface RenderOptions {
  /** 固定版本的 ECharts 地址；与 echartsScript 二选一。 */
  echartsUrl?: string;
  /** 内联 ECharts 源码，生成完全离线可用的页面。 */
  echartsScript?: string;
}

const DEFAULT_ECHARTS_URL = 'https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js';

export function renderHtml(model: RenderModel, options: RenderOptions = {}): string {
  const body = model.items
    .map((item) => {
      if (item.kind === 'divider') return dividerHtml(item);
      if (item.kind === 'table') return tableHtml(item);
      if (item.kind === 'cards') return cardsHtml(item);
      return chartHtml(item);
    })
    .join('\n');
  const charts = model.items
    .filter((item) => item.kind === 'chart')
    .map((item) => ({ i: item.i, option: item.option }));
  const payload = JSON.stringify({ pageId: model.pageId, charts }).replaceAll('<', '\\u003c');
  const script = options.echartsScript
    ? `<script>${options.echartsScript.replaceAll('</script>', '<\\/script>')}</script>`
    : `<script src="${escapeHtml(options.echartsUrl ?? DEFAULT_ECHARTS_URL)}"></script>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f5f7f9; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f2d33; }
  .viz-page { position: relative; margin: 0 auto; max-width: 1680px; min-height: ${model.heightPx}px; }
  .viz-card { position: absolute; box-sizing: border-box; background: #fff; border: 1px solid #e6ebee; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
  .viz-card-title { flex: 0 0 auto; padding: 8px 12px 0; font-size: 12px; font-weight: 600; color: #24485a; }
  .viz-card-body { flex: 1 1 auto; min-height: 0; padding: 4px 8px 8px; }
  .viz-divider { position: absolute; box-sizing: border-box; padding: 6px 4px; border-bottom: 1px solid #dfe6ea; display: flex; align-items: baseline; gap: 8px; }
  .viz-table-wrap { overflow: auto; }
  .viz-table { border-collapse: collapse; width: 100%; font-size: 12px; }
  .viz-table th { text-align: left; padding: 4px 8px; background: #f2f6f8; color: #43585f; font-weight: 600; position: sticky; top: 0; }
  .viz-table td { padding: 4px 8px; border-top: 1px solid #eef2f4; }
  .viz-cards { display: flex; gap: 12px; flex-wrap: wrap; align-content: flex-start; }
  .viz-kpi { flex: 1 1 160px; min-width: 140px; background: #fafcfd; border: 1px solid #eef2f4; border-radius: 6px; padding: 10px 12px; }
  .viz-kpi-title { font-size: 12px; color: #536d78; }
  .viz-kpi-value { font-size: 20px; font-weight: 600; color: #16323d; margin-top: 4px; }
  .viz-card-sub { font-size: 11px; color: #6b7f88; margin-top: 4px; }
  .viz-badge { float: right; font-size: 11px; padding: 1px 6px; border-radius: 999px; background: #e8f3ff; color: #2f6fae; }
</style>
</head>
<body>
<div class="viz-page" id="viz-page">
${body}
</div>
${script}
<script>
(function () {
  var MODEL = ${payload};
  function legendWithValue(option) {
    return function (name) {
      var series = option.series || [];
      var first = series[0];
      if (first && (first.type === 'pie' || first.type === 'funnel')) {
        var item = (first.data || []).filter(function (d) { return d && d.name === name; })[0];
        if (item) return name + '  ' + item.value;
      }
      var match = series.filter(function (s) { return s && s.name === name; })[0];
      if (match && Array.isArray(match.data)) {
        var nums = match.data.filter(function (v) { return typeof v === 'number'; });
        if (nums.length) return name + '  ' + nums[nums.length - 1];
      }
      return name;
    };
  }
  var FNS = { legendWithValue: legendWithValue };
  function revive(node, option) {
    if (Array.isArray(node)) return node.map(function (n) { return revive(n, option); });
    if (node && typeof node === 'object') {
      if (typeof node.__fn === 'string' && FNS[node.__fn]) return FNS[node.__fn](option);
      var out = {};
      for (var k in node) if (Object.prototype.hasOwnProperty.call(node, k)) out[k] = revive(node[k], option);
      return out;
    }
    return node;
  }
  var charts = [];
  MODEL.charts.forEach(function (entry) {
    var el = document.querySelector('[data-chart="' + entry.i.replace(/"/g, '\\\\"') + '"]');
    if (!el) return;
    var chart = echarts.init(el, null, { renderer: 'canvas' });
    chart.setOption(revive(entry.option, entry.option), true);
    charts.push(chart);
  });
  window.addEventListener('resize', function () { charts.forEach(function (c) { c.resize(); }); });
})();
</script>
</body>
</html>
`;
}

export function datasetColumnLabel(bundle: Bundle, datasetId: string, key: string): string {
  return columnOf(datasetOf(bundle, datasetId), key).label;
}
