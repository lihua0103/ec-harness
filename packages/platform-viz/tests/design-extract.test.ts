/**
 * 提取链路的条件测试：需要真实浏览器；设置 DM_VIZ_CHROME 才运行，设置 DM_VIZ_ECHARTS 才跑真实 ECharts 端到端。
 * 未设置时跳过，不伪装通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { extractDesignCharts, pairDesignCharts } from '../src/design.js';
import { buildModel } from '../src/render.js';
import { allDatasets, bundleOf, layout, spec } from './fixtures.js';

const CHROME = process.env.DM_VIZ_CHROME ?? '';
const ECHARTS = process.env.DM_VIZ_ECHARTS ?? '';
const skipChrome = CHROME ? false : 'DM_VIZ_CHROME not set';
const skipReal = CHROME && ECHARTS ? false : 'DM_VIZ_CHROME / DM_VIZ_ECHARTS not set';

async function serve(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const MOCK_PAGE = `<!doctype html><html><body>
<article data-chart-card="b0p1"><div class="card-title"><span>中心页面数</span></div><div data-chart-id="b0p1"></div></article>
<article data-chart-card="b0p2"><div class="card-title"><span>国家占比</span></div><div data-chart-id="b0p2"></div></article>
<script>
var OPTIONS = {
  b0p1: { series: [{ type: 'bar', name: '页面数', data: [16, 10, 5] }], xAxis: { type: 'category', data: ['S001', 'S002', 'S003'] }, yAxis: { type: 'value' } },
  b0p2: { series: [{ type: 'pie', data: [{ name: 'China', value: 12 }, { name: 'Japan', value: 8 }] }] }
};
window.echarts = {
  getInstanceByDom: function (el) {
    var id = el && el.getAttribute ? el.getAttribute('data-chart-id') : null;
    return id && OPTIONS[id] ? { getOption: function () { return OPTIONS[id]; } } : null;
  }
};
</script>
</body></html>`;

function designHtml(echartsSource: string): string {
  const options = {
    p1: {
      xAxis: { type: 'category', data: ['S001', 'S002', 'S003'] },
      yAxis: { type: 'value' },
      series: [{ name: '页面数', type: 'bar', data: [16, 10, 5] }],
    },
    p2: {
      series: [
        {
          type: 'pie',
          data: [
            { name: 'China', value: 12 },
            { name: 'Japan', value: 8 },
            { name: 'Korea', value: 5 },
          ],
        },
      ],
    },
    p3: {
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: ['S001', 'S002', 'S003'] },
      series: [
        { name: '页面数', type: 'bar', stack: 'total', data: [16, 10, 5] },
        { name: '访视数', type: 'bar', stack: 'total', data: [6, 4, 5] },
      ],
    },
  };
  return `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;font-family:sans-serif}.block{padding:8px}.plot{width:520px;height:320px}</style></head><body>
<div class="block">
  <article data-chart-card="b0p1"><div class="card-title"><span>各中心页面数</span></div><div class="plot" id="plot1" data-chart-id="p1"></div></article>
  <article data-chart-card="b0p2"><div class="card-title"><span>国家中心占比</span></div><div class="plot" id="plot2" data-chart-id="p2"></div></article>
  <article data-chart-card="b0p3"><div class="card-title"><span>中心工作量</span></div><div class="plot" id="plot3" data-chart-id="p3"></div></article>
</div>
<script>${echartsSource.replaceAll('</script>', '<\\/script>')}</script>
<script>
var OPTIONS = ${JSON.stringify(options)};
['p1', 'p2', 'p3'].forEach(function (id, index) {
  var el = document.getElementById('plot' + (index + 1));
  echarts.init(el).setOption(OPTIONS[id]);
});
</script>
</body></html>`;
}

test('extracts runtime options in DOM order', { skip: skipChrome }, async () => {
  const page = await serve(MOCK_PAGE);
  try {
    const charts = await extractDesignCharts({ url: page.url, executablePath: CHROME, settleMs: 200 });
    assert.equal(charts.length, 2);
    assert.equal(charts[0]!.card, 'b0p1');
    assert.equal(charts[0]!.title, '中心页面数');
    assert.equal(charts[1]!.card, 'b0p2');
    assert.equal((charts[0]!.option.series as unknown[]).length, 1);
  } finally {
    await page.close();
  }
});

test('self-authored design page matches the configured bundle 100%', { skip: skipReal }, async () => {
  const page = await serve(designHtml(readFileSync(ECHARTS, 'utf8')));
  try {
    const design = await extractDesignCharts({ url: page.url, executablePath: CHROME, settleMs: 800 });
    assert.equal(design.length, 3);
    assert.deepEqual(
      design.map((chart) => chart.card),
      ['b0p1', 'b0p2', 'b0p3'],
    );
    const specs = [
      spec({
        id: 'e1',
        title: '各中心页面数',
        type: 'bar',
        datasetId: 'ds_sites',
        slots: { category: 'site', values: [{ column: 'pages' }] },
      }),
      spec({
        id: 'e2',
        title: '国家中心占比',
        type: 'pie',
        datasetId: 'ds_table',
        slots: { category: 'country', values: [{ column: 'sites' }] },
      }),
      spec({
        id: 'e3',
        title: '中心工作量',
        type: 'horizontalbar',
        preset: 'stacked',
        datasetId: 'ds_sites',
        slots: { category: 'site', values: [{ column: 'pages' }, { column: 'visits' }] },
      }),
    ];
    const bundle = bundleOf(
      specs,
      layout([
        { kind: 'chart', i: 'c1', specId: 'e1', x: 0, y: 0, w: 8, h: 10 },
        { kind: 'chart', i: 'c2', specId: 'e2', x: 8, y: 0, w: 8, h: 10 },
        { kind: 'chart', i: 'c3', specId: 'e3', x: 16, y: 0, w: 8, h: 10 },
      ]),
      allDatasets(),
    );
    const result = pairDesignCharts(design, buildModel(bundle));
    assert.deepEqual(
      result.pairs.map((pair) => pair.verdict),
      ['match', 'match', 'match'],
    );
    assert.deepEqual(
      result.details.flatMap((detail) => detail.diffs),
      [],
    );
  } finally {
    await page.close();
  }
});
