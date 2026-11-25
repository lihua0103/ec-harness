/**
 * 真实宿主 E2E：fixture 构建 → 自包含页渲染（内嵌本地 echarts）→
 * 无头 Edge 提取本页与设计稿页运行态 option → 逐图配对 → 配置级验收 → 交付封存。
 * 运行：cd plugins/dm-participants && ./node_modules/.bin/tsx scripts/render-e2e.mts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildPtBundle, buildPtLiveModel, PAGE_ID, ptCtx, fixturePageData, renderParticipantsPage } from '../src/participant-page.js';
import { acceptPage, extractDesignCharts, pairDesignCharts, sealDelivery } from '../../../packages/platform-viz/src/index.js';

const PROJECT_ROOT = 'D:/project/company/ec-clinical-dsh';
const ROOT = resolve(PROJECT_ROOT, '.runtime/dsh-home/dm-participants');
const MSEDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ECHARTS_LOCAL = 'D:/project/company/RBQM/previews/csm-central-redesign/echarts.min.js';
// 设计稿来源：默认本地文件路径（file:// 读取）；可设 PT_DESIGN_URL 覆盖为 HTTP 地址。
const DESIGN_PAGE =
  process.env.PT_DESIGN_URL ?? 'D:/project/company/RBQM/previews/csm-functions-v5-en/participants-preview.html';

const ctx = ptCtx();
const bundle = buildPtBundle(ctx);
const live = buildPtLiveModel(ctx);

const echartsScript = await readFile(ECHARTS_LOCAL, 'utf8');
const html = await renderParticipantsPage({ echartsScript, data: fixturePageData() });
await mkdir(ROOT, { recursive: true });
const pagePath = resolve(ROOT, `${PAGE_ID}.html`);
await writeFile(pagePath, html, 'utf8');
console.log('page written:', pagePath, `(${html.length} bytes)`);

const extract = (url: string) =>
  extractDesignCharts({ url, executablePath: MSEDGE, settleMs: 2500, windowSize: { width: 1680, height: 2000 } });

const ours = await extract(`file:///${pagePath.replace(/\\/g, '/')}?selftest=1`);
console.log('rendered-page charts extracted:', ours.length);

const design = await extract(DESIGN_PAGE.includes('://') ? DESIGN_PAGE : `file:///${DESIGN_PAGE.replace(/\\/g, '/')}`);
console.log('design-page charts extracted:', design.length);

const pair = pairDesignCharts(design, live);
const counts = {
  design: design.length,
  rendered: live.items.length,
  match: pair.pairs.filter((p) => p.verdict === 'match').length,
  diff: pair.pairs.filter((p) => p.verdict === 'diff').length,
  pending: pair.pairs.filter((p) => p.verdict === 'pending').length,
};
console.log('pair summary:', JSON.stringify(counts));
for (const p of pair.pairs) {
  if (p.verdict !== 'match') console.log('NOT MATCH:', JSON.stringify(p));
  else if (p.knownDiffs.length) console.log('knownDiffs:', p.specId, JSON.stringify(p.knownDiffs));
}

const record = acceptPage(bundle, pair.pairs);
const acceptancePath = resolve(ROOT, `${PAGE_ID}.acceptance.json`);
await writeFile(acceptancePath, JSON.stringify(record, null, 2), 'utf8');
console.log(
  'acceptance:',
  record.result,
  `blank=${record.structure.blank}`,
  `errors=${record.structure.errors.length}`,
  `overlaps=${record.structure.overlaps}`,
  `orphans=${record.structure.orphans}`,
  `canvases=${record.structure.canvases}`,
);

const delivery = await sealDelivery(ROOT, bundle, pair.pairs);
const deliveryPage = resolve(delivery.directory, `${PAGE_ID}.html`);
await writeFile(deliveryPage, html, 'utf8');
console.log('delivery:', delivery.directory);
console.log(delivery.manifest ? 'manifest written' : 'manifest missing!');
