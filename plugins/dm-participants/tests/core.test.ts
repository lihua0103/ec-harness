/** 核心验收：模型确定性、18 图 builder 结构、custom 重建、页面、配置级验收。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allParticipants, buildPtModels, DEFAULT_SCOPE, generateCohortForLabels, PANEL_IDS, PT_STATUS, VISITS, type PtModels } from '../src/participant-model.js';
import { F, PT_CHART_IDS, ptOption } from '../src/participant-charts.js';
import { REBUILD_IDS, rebuildCustomOption } from '../src/participant-rebuild.js';
import { buildPtBundle, buildPtLiveModel, CUSTOM_IDS, fixturePageData, ptCtx, renderParticipantsPage, CARD_WIDTH, PT_FIXTURE_CURATION } from '../src/participant-page.js';
import { acceptPage } from '../../../packages/platform-viz/src/accept.js';
import { pageDigest, stableStringify } from '../../../packages/platform-viz/src/spec.js';
import { pairDesignCharts, type DesignChart } from '../../../packages/platform-viz/src/design.js';

const ctx = ptCtx();

test('模型：24 参与者、字段派生、确定性', () => {
  const a = allParticipants();
  const b = allParticipants();
  assert.equal(a.length, 24);
  assert.deepEqual(stableStringify(a), stableStringify(b), 'fixtures must be deterministic');
  for (const p of a) {
    assert.equal(p.sig.length, 4);
    assert.equal(p.total, p.sig.reduce((x, y) => x + y, 0));
    assert.equal(typeof p.labCrit, 'boolean');
    for (const w of VISITS) assert.ok(p.visits[w], `visit ${w} present for ${p.id}`);
    assert.equal(p.epro.length, 12);
    for (const key of ['egfr', 'k', 'hb', 'alt', 'uacr']) assert.ok(Array.isArray(p.lab[key]));
  }
  assert.ok(a.some((p) => p.labCrit), 'at least one labCrit fixture');
  assert.ok(a.some((p) => p.unknownDomains.length > 0), 'at least one unknown-domain fixture');
  assert.ok(Object.keys(PT_STATUS).length >= 4);
});

test('builder：18 张图齐全、顺序正确、custom 类型在场', () => {
  assert.deepEqual([...PT_CHART_IDS].sort(), Object.keys(F).sort());
  assert.equal(PT_CHART_IDS.length, 18);
  for (const id of PT_CHART_IDS) {
    const o = ptOption(id, ctx, CARD_WIDTH(id));
    assert.ok(o, `${id} builds`);
    const series = (o as { series?: Array<Record<string, unknown>> }).series ?? [];
    assert.ok(series.length > 0, `${id} has series`);
    const points = series.reduce(
      (sum, s) => sum + (Array.isArray(s.data) ? (s.data as unknown[]).filter((d) => d != null).length : 0),
      0,
    );
    assert.ok(points > 0, `${id} non-blank`);
    if (CUSTOM_IDS.includes(id)) {
      assert.ok(
        series.some((s: { renderItem?: unknown }) => typeof s.renderItem === 'function'),
        `${id} keeps custom renderItem`,
      );
    }
  }
});

test('builder：宽度分支生效且配对无关（rotate/splitNumber/dataZoom）', () => {
  const rot = (id: string, w: number): number | undefined =>
    (ptOption(id, ctx, w) as { xAxis?: { axisLabel?: { rotate?: number } } })?.xAxis?.axisLabel?.rotate;
  assert.equal(rot('pt0p0', 700), 0, 'wide matrix keeps labels horizontal');
  assert.equal(rot('pt0p0', CARD_WIDTH('pt0p0')), 25, 'matrix card width (504) rotates labels');
  assert.equal(rot('pt2p1', 700), 0, 'wide eligibility keeps labels horizontal');
  assert.equal(rot('pt2p1', 500), 35, 'narrow eligibility rotates labels');

  const value3 = ptOption('pt2p0', ctx, 400) as { xAxis?: { splitNumber?: number } };
  const value5 = ptOption('pt2p0', ctx, 1600) as { xAxis?: { splitNumber?: number } };
  assert.equal(value3.xAxis?.splitNumber, 3);
  assert.equal(value5.xAxis?.splitNumber, 5);

  const zoom = ptOption('pt2p0', ctx, CARD_WIDTH('pt2p0')) as { dataZoom?: unknown[] };
  assert.ok(Array.isArray(zoom.dataZoom) && zoom.dataZoom.length >= 2, 'long category list gets dataZoom pair');

  const empty: PtModels = buildPtModels([]);
  const o = ptOption('pt0p0', { M: empty, P: [] }, 504) as { series?: unknown[]; graphic?: Array<{ style?: { text?: string } }> };
  assert.deepEqual(o.series, []);
  assert.match(o.graphic?.[0]?.style?.text ?? '', /No participants match/);
});

test('重建：7 张 custom 图的平台 JSON 等价物函数无关且数据保留', () => {
  assert.deepEqual(REBUILD_IDS.sort(), [...CUSTOM_IDS].sort());
  for (const id of CUSTOM_IDS) {
    const o = rebuildCustomOption(id, ctx.M[id as keyof PtModels]);
    const text = JSON.stringify(o);
    assert.equal(text, JSON.stringify(JSON.parse(text)), `${id} JSON round-trips`);
    assert.ok(!/'(renderItem|formatter|labelFormatters?)"?\s*:\s*(function|__fn)/.test(text), `${id} carries no functions by construction`);
    const series = (o as { series?: Array<Record<string, unknown>> }).series ?? [];
    const points = series.reduce((sum, s) => sum + (Array.isArray(s.data) ? (s.data as unknown[]).length : 0), 0);
    assert.ok(points > 0, `${id} rebuilt keeps data`);
  }
  assert.throws(() => rebuildCustomOption('pt0p0', ctx.M.pt0p0), /CUSTOM_REBUILD_UNSUPPORTED/);
});

test('模型：策展面板参数化——fixture 策展复现设计稿，缺省数据驱动且不回退', () => {
  const P = allParticipants();
  const curated = buildPtModels(P, DEFAULT_SCOPE, { pt1p0: 'egfr', pt1p1: 'egfr' }, PT_FIXTURE_CURATION);
  assert.deepEqual(
    curated.pt2p2.rows.map((p) => p.id),
    PANEL_IDS,
    'fixture curation reproduces the design panel order',
  );
  assert.ok(curated.pt0p0.rows.some((p) => p.id === 'P-005'), 'P-005 pinned into matrix by fixture curation');
  assert.deepEqual(ptCtx().M.pt2p2.rows.map((p) => p.id), PANEL_IDS, 'ptCtx carries the fixture curation');

  const plain = buildPtModels(P);
  assert.deepEqual(
    plain.pt2p2.rows.map((p) => p.id),
    [...P].sort((a, b) => b.total - a.total || a.n - b.n).slice(0, 12).map((p) => p.id),
    'default panel is the burden top-12, data-driven',
  );
  assert.ok(!plain.pt0p0.rows.some((p) => p.id === 'P-005'), 'no matrix pin without explicit curation');

  const subset = buildPtModels(P, DEFAULT_SCOPE, { pt1p0: 'egfr', pt1p1: 'egfr' }, { panel: ['P-014', 'S-9001'] });
  assert.deepEqual(subset.pt2p2.rows.map((p) => p.id), ['P-014'], 'unknown panel ids are dropped, not fabricated');
});

test('页面：PT_DATA 注入、来源标记与徽章按数据来源渲染', async () => {
  const fixtureHtml = await renderParticipantsPage({
    bundle: 'window.PT={mount(){}};',
    echartsScript: 'window.echarts={init(){}};',
    data: fixturePageData(),
  });
  for (const text of [
    'RBQM-PARTICIPANT-SYNTHETIC-PREVIEW',
    'Synthetic data · Design preview',
    '24 of 24 shown · whole study',
    'window.PT_DATA=',
    'Synthetic fixture · design preview',
    'Participant risk analysis',
    'Reset filters',
    'Central monitor · cross-domain triage',
    'Pharmacy / IP manager · exposure &amp; adherence',
  ]) {
    assert.ok(fixtureHtml.includes(text), `fixture chrome text present: ${text}`);
  }
  for (const id of PT_CHART_IDS) assert.ok(fixtureHtml.includes(`data-chart-id="${id}"`), `card ${id}`);
  assert.ok(fixtureHtml.includes('window.PT={mount(){}}'), 'bundle inlined');
  assert.ok(fixtureHtml.indexOf('window.PT_DATA=') < fixtureHtml.indexOf('window.PT={mount(){}}'), 'PT_DATA evaluated before the bundle');
  assert.ok(!fixtureHtml.includes('RBQM-PARTICIPANT-IMPORTED-PREVIEW'), 'fixture page does not claim imported');

  const importedHtml = await renderParticipantsPage({
    bundle: 'window.PT={mount(){}};',
    echartsScript: 'window.echarts={init(){}};',
    data: {
      // arm 含 </script>：验证 PT_DATA 序列化转义，防止数据字符串提前闭合脚本标签。
      participants: [{ ...ptCtx().P[0]!, arm: 'Active</script>x' }],
      source: { mode: 'imported', label: 'cohort-b.xlsx', sha256: 'a'.repeat(64) },
    },
  });
  for (const text of [
    'RBQM-PARTICIPANT-IMPORTED-PREVIEW',
    'Imported data · cohort-b.xlsx · sha256 aaaaaaaaaaaa',
    '1 of 1 shown · whole study',
    'Imported study data via the platform channel',
  ]) {
    assert.ok(importedHtml.includes(text), `imported chrome text present: ${text}`);
  }
  assert.ok(!importedHtml.includes('Synthetic data · Design preview'), 'imported page does not claim synthetic');
  assert.ok(importedHtml.includes('\\u003c/script>'), 'script-opening angle bracket escaped inside PT_DATA');
  assert.ok(!importedHtml.includes('Active</script>'), 'raw closing sequence never reaches the page');
  assert.ok(importedHtml.includes('"mode":"imported"'), 'PT_DATA carries the source mode');

  const emptyHtml = await renderParticipantsPage({
    bundle: 'window.PT={mount(){}};',
    echartsScript: 'window.echarts={init(){}};',
    data: { participants: [], source: { mode: 'imported', label: 'empty.xlsx' } },
  });
  assert.ok(emptyHtml.includes('0 of 0 shown'), 'empty dataset renders an explicit zero count');
});

test('验收：平台 Bundle 配置级全绿、digest 稳定、live 配对自洽', () => {
  const bundle = buildPtBundle(ctx);
  const record = acceptPage(bundle, []);
  assert.equal(record.structure.items, 18);
  assert.equal(record.structure.blank, 0, `blank items: ${record.structure.blankItems.join(',')}`);
  assert.equal(record.structure.errors.length, 0, record.structure.errors.join(';'));
  assert.equal(record.structure.overlaps, 0);
  assert.equal(record.structure.orphans, 0);
  assert.equal(record.structure.canvases, 18);
  assert.equal(record.result, 'pass');

  const bundle2 = buildPtBundle(ctx);
  assert.equal(pageDigest(bundle), pageDigest(bundle2), 'bundle digest stable');

  const live = buildPtLiveModel(ctx);
  const design: DesignChart[] = live.items.map((item, i) => ({
    order: i,
    id: item.i,
    card: item.i,
    title: item.i,
    option: item.option ?? {},
  }));
  const pairs = pairDesignCharts(design, live);
  assert.equal(pairs.pairs.length, 18);
  assert.equal(pairs.pairs.filter((p) => p.verdict === 'pending').length, 0);
  assert.equal(
    pairs.pairs.filter((p) => p.verdict === 'match').length,
    18,
    `live options pair 1:1: ${JSON.stringify(pairs.pairs.filter((p) => p.verdict !== 'match'))}`,
  );
  assert.equal(record.pairs.length, 0);
});

test('生成队列：按既有登记标签生成演示参与者，id 原样保留且可复现', () => {
  const labels = Array.from({ length: 24 }, (_, i) => String(10001 + i));
  const first = generateCohortForLabels(labels);
  const second = generateCohortForLabels(labels);
  assert.deepEqual(first.map((p) => p.id), labels, '标签原样成为 PATIENT 值（登记/上传/过滤三处同源）');
  assert.equal(stableStringify(first), stableStringify(second), '同一标签集生成结果可复现');
  for (const participant of first) {
    assert.ok(participant.lab.egfr?.length, '实验室轨迹已生成');
    assert.ok(Object.keys(participant.visits).length > 0, '访视已生成');
    assert.ok(Number.isFinite(participant.total), '派生量已计算');
  }
  assert.ok(first.some((p) => p.aes.length > 0), '演示队列含不良事件（AE 图有数据）');
  assert.ok(first.some((p) => p.doseSegs.length > 1), '演示队列含剂量调整（剂量图有分段的对照）');
  // 演示生成不得改动夹具：夹具 id 与数量维持原样。
  assert.equal(allParticipants().length, 24);
  assert.equal(allParticipants()[0]!.id, 'P-001');
});
