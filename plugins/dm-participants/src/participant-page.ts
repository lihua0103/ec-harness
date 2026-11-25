/**
 * 参与者档案页：自包含 HTML（设计稿 chrome 逐字）+ 内嵌浏览器 bundle；
 * 以及验收用的活模型（live option，供与设计稿配对）和平台 Bundle
 * （纯 JSON 配置候选：标准图取 builder option 的 JSON 净化版，custom 图取
 * 标准化重建版）。两者职责不同，不混用。
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SCOPE,
  PANEL_IDS,
  allParticipants,
  buildPtModels,
  type Participant,
  type PtModels,
} from './participant-model.js';
import { PT_CHART_IDS, ptOption } from './participant-charts.js';
import { rebuildCustomOption } from './participant-rebuild.js';
import type { Bundle, ChartSpec, Layout, RenderItem, RenderModel } from '../../../packages/platform-viz/src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PAGE_ID = 'pt-participants';
export const CUSTOM_IDS = ['pt1p4', 'pt2p0', 'pt2p2', 'pt3p2', 'pt3p3', 'pt4p0', 'pt4p1'];
const WIDE = new Set(['pt1p0', 'pt2p0', 'pt3p4', 'pt4p0']);
/** 1680 视口：正文 1624，普通卡 .ec-chart≈504，wide 卡≈1596。 */
export const CARD_WIDTH = (id: string): number => (WIDE.has(id) ? 1596 : 504);

/** 页面数据来源标记：徽章、review-notice 与 HTML 注释按此渲染，不冒充数据来源。 */
export interface PtPageSource {
  mode: 'fixture' | 'imported';
  /** 展示标签：fixture 为设计稿夹具说明；imported 为源工作簿文件名。 */
  label: string;
  /** imported 模式的源工作簿 sha256（页面徽章展示前 12 位）。 */
  sha256?: string;
}

/** 渲染进页面的数据通道结果（window.PT_DATA）；页面不回退到 fixtures。 */
export interface PtPageData {
  participants: Participant[];
  /** 策展观察面板与矩阵钉选；缺省按负担 top-12 数据驱动。 */
  panel?: string[];
  matrixPins?: string[];
  source: PtPageSource;
}

/** 设计稿策展（PANEL_IDS 观察面板 + P-005 矩阵钉选）；仅 fixture 构建使用。 */
export const PT_FIXTURE_CURATION = { panel: PANEL_IDS, matrixPins: ['P-005'] };

/** 设计稿数据来源标记（fixture 构建的页面 chrome 用）。 */
export const FIXTURE_SOURCE: PtPageSource = { mode: 'fixture', label: 'Synthetic fixture · design preview' };

export function ptCtx(): { M: PtModels; P: ReturnType<typeof allParticipants> } {
  const P = allParticipants();
  const M = buildPtModels(P, DEFAULT_SCOPE, { pt1p0: 'egfr', pt1p1: 'egfr' }, PT_FIXTURE_CURATION);
  return { M, P };
}

/** fixture 页面数据（设计稿配对验收专用；真实数据走 pt_viz_import_xlsx 通道）。 */
export function fixturePageData(): PtPageData {
  const P = allParticipants();
  return { participants: P, panel: PT_FIXTURE_CURATION.panel, matrixPins: PT_FIXTURE_CURATION.matrixPins, source: FIXTURE_SOURCE };
}

/** 与设计稿配对用：builder 原样 option（含 renderItem 闭包）。 */
export function buildPtLiveModel(ctx = ptCtx()): RenderModel {
  const items: RenderItem[] = [];
  let y = 0;
  for (const id of PT_CHART_IDS) {
    const wide = WIDE.has(id);
    const option = ptOption(id, ctx, CARD_WIDTH(id)) as Record<string, unknown>;
    const series = Array.isArray(option.series) ? (option.series as Record<string, unknown>[]) : [];
    const points = series.reduce((sum, s) => sum + (Array.isArray(s.data) ? (s.data as unknown[]).filter((d) => d != null).length : 0), 0);
    items.push({ i: id, kind: 'chart', specId: id, title: id, x: 0, y, w: wide ? 24 : 8, h: 10, points, option });
    y += 10;
  }
  return { pageId: PAGE_ID, title: 'Participant risk analysis', columns: 24, rowHeight: 36, heightPx: y * 36, items, digest: 'live' };
}

/** 平台配置候选：纯 JSON；custom 图用标准化重建并在 note 标注。 */
export function buildPtBundle(ctx = ptCtx()): Bundle {
  const specs: ChartSpec[] = PT_CHART_IDS.map((id) => {
    const json = JSON.parse(JSON.stringify(id && CUSTOM_IDS.includes(id) ? rebuildCustomOption(id, ctx.M[id as keyof PtModels]) : ptOption(id, ctx, CARD_WIDTH(id)))) as Record<string, unknown>;
    return {
      id,
      title: id,
      mode: 'baked' as const,
      type: Array.isArray(json.series) && (json.series as Record<string, unknown>[])[0]?.type === 'heatmap' ? 'heatmap' : 'bar',
      option: json,
      note: CUSTOM_IDS.includes(id) ? 'rebuilt from custom renderItem; platform JSON config, live bundle keeps the original custom form' : 'JSON-clean builder output (display-only callbacks dropped)',
    };
  });
  const layout: Layout = {
    pageId: PAGE_ID,
    title: 'Participant risk analysis',
    columns: 24,
    rowHeight: 36,
    items: PT_CHART_IDS.map((id, i) => ({ kind: 'chart' as const, i: id, specId: id, x: 0, y: i * 10, w: WIDE.has(id) ? 24 : 8, h: 10 })),
  };
  return { datasets: [], specs, layout };
}

const CSS = String.raw`*{box-sizing:border-box}body{margin:0;padding:22px 28px 40px;background:#f4f7f7;color:#153847;font:14px "Segoe UI",Arial,sans-serif}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}h1{font-size:23px;margin:0}.demo{font-size:12px;color:#536d78;background:#fff;border:1px solid #dde7e7;border-radius:12px;padding:5px 12px}.block{background:transparent;padding:14px 0;margin-bottom:12px;border-radius:0}.block-head{margin:0 0 12px}.block-head h2{font-size:16px;color:#24485a;margin:0;display:flex;align-items:center;gap:10px;flex-wrap:wrap}.role-tag{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#007b82;background:#e7f3f3;border:1px solid #bfe0e0;border-radius:10px;padding:2px 9px}.role-q{font-size:12px;color:#536d78;margin:5px 0 0;font-style:italic}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{background:#fff;border:1px solid #dce5e8;border-radius:8px;padding:14px 14px 10px;min-width:0;overflow:hidden}.card.wide{grid-column:1/-1}.card-title{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;font-weight:600;font-size:13px;color:#153847;min-height:22px}.ec-chart{height:320px;width:100%;margin-top:10px}.chart-status{font-size:11px;font-weight:400;white-space:nowrap;border-radius:10px;padding:2px 7px}.status-high{background:#fff0f1;color:#c23b45}.status-warning{background:#fff8e9;color:#9c6d1c}.status-normal{background:#eef8f3;color:#1b9161}.status-unknown{background:#edf0f4;color:#536d78}.functional-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:24px 0 16px;border-top:1px solid #dce5e8;margin-top:24px}.functional-heading h1{font-size:20px;color:#153847}.scope-badge{font-size:10px;font-weight:400;color:#536d78;background:#edf2f4;padding:2px 6px;border-radius:4px;white-space:nowrap}@media(min-width:1680px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}.card.wide{grid-column:1/-1}}@media(max-width:1000px){.grid{grid-template-columns:1fr}}@media(max-width:600px){body{padding:14px 12px}.card{padding:12px 10px}.ec-chart{height:340px}h1{font-size:19px}.top{align-items:flex-start}}
.pt-toolbar{position:sticky;top:0;z-index:40;display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 14px;margin:0 -28px 18px;padding:12px 28px;background:rgba(244,247,247,.94);backdrop-filter:blur(6px);border-bottom:1px solid #dce5e8}
.pt-field{display:flex;flex-direction:column;gap:3px}
.pt-field label{font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#536d78;font-weight:600}
.pt-field select,.pt-field input[type=search]{font:12px "Segoe UI",Arial,sans-serif;color:#153847;background:#fff;border:1px solid #dce5e8;border-radius:6px;padding:6px 8px;min-width:120px}
.pt-field input[type=search]{min-width:150px}
.pt-field select:focus,.pt-field input:focus{outline:2px solid #007b82;outline-offset:1px}
.pt-toggle{display:flex;align-items:center;gap:6px;font-size:12px;color:#153847;padding-bottom:7px;cursor:pointer}
.pt-toggle input{accent-color:#c23b45;width:15px;height:15px}
.pt-reset{font:12px "Segoe UI",Arial,sans-serif;color:#007b82;background:#fff;border:1px solid #007b82;border-radius:6px;padding:6px 12px;cursor:pointer}
.pt-reset:hover{background:#edf5f5}
.pt-hint{font-size:11px;color:#536d78;margin:0 0 14px}
.pt-inline-field{display:flex;align-items:center;gap:7px;margin:8px 0 0;font-size:11px;color:#536d78}
.pt-inline-field label{font-weight:600;letter-spacing:.03em;text-transform:uppercase;font-size:10px}
.pt-inline-field select{font:12px "Segoe UI",Arial,sans-serif;color:#153847;background:#fff;border:1px solid #dce5e8;border-radius:6px;padding:4px 7px}
.pt-inline-field select:focus{outline:2px solid #007b82;outline-offset:1px}
.pt-scrim{position:fixed;inset:0;background:rgba(21,56,71,.38);opacity:0;pointer-events:none;transition:opacity .22s;z-index:60}
.pt-scrim.open{opacity:1;pointer-events:auto}
.pt-drawer{position:fixed;top:0;right:0;height:100%;width:400px;max-width:92vw;background:#fff;border-left:3px solid #007b82;box-shadow:-8px 0 28px rgba(21,56,71,.18);transform:translateX(102%);transition:transform .26s cubic-bezier(.4,0,.2,1);z-index:70;overflow-y:auto;padding:20px 22px}
.pt-drawer.open{transform:translateX(0)}
.pt-d-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:1px solid #e6edf0;padding-bottom:12px;margin-bottom:12px}
.pt-d-id{font-size:22px;font-weight:700;color:#153847;letter-spacing:.02em}
.pt-d-sub{font-size:12px;color:#536d78;margin-top:3px}
.pt-d-close{font-size:22px;line-height:1;color:#536d78;background:#f4f7f7;border:1px solid #dce5e8;border-radius:6px;width:32px;height:32px;cursor:pointer;flex:none}
.pt-d-close:hover{color:#c23b45;border-color:#c23b45}
.pt-d-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.pt-chip{font-size:11px;border:1px solid;border-radius:12px;padding:2px 9px;background:#fff}
.pt-d-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.pt-d-grid>div{background:#f4f7f7;border:1px solid #e6edf0;border-radius:6px;padding:7px 9px;display:flex;flex-direction:column;gap:2px}
.pt-d-grid span{font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:#536d78}
.pt-d-grid b{font-size:13px;color:#153847}
.pt-drawer h4{font-size:12px;color:#24485a;margin:14px 0 5px;text-transform:uppercase;letter-spacing:.03em}
.pt-d-line{font-size:12px;color:#153847;margin:0;line-height:1.6}
.pt-d-list{margin:0;padding-left:18px;font-size:12px;color:#153847;line-height:1.7}
.pt-d-flags li{color:#a93641}
.pt-d-note{font-size:10px;color:#536d78;border-top:1px solid #e6edf0;margin-top:16px;padding-top:10px}
.pt-d-table{width:100%;border-collapse:collapse;font-size:12px;margin:2px 0 4px}
.pt-d-table th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:#536d78;font-weight:600;border-bottom:1px solid #dce5e8;padding:4px 6px}
.pt-d-table td{padding:4px 6px;border-bottom:1px solid #eef2f4;color:#153847}
.pt-d-table tbody tr:last-child td{border-bottom:none}
.review-header{display:flex;align-items:center;gap:14px;background:#153847;color:#fff;border-bottom:3px solid #007b82;padding:10px 18px;margin:-22px -28px 18px;font-size:13px}
.review-header strong{font-size:15px;letter-spacing:.02em}
.review-header small{color:#bfe0e0;font-size:11px;margin-left:auto}
.review-notice{font-size:12px;color:#24485a;background:#fff;border:1px solid #dce5e8;border-left:4px solid #007b82;border-radius:6px;padding:10px 14px;margin:0 0 12px}
.review-key{display:flex;flex-wrap:wrap;gap:10px;background:#fff;border:1px solid #dce5e8;border-radius:8px;padding:8px 12px;margin:0 0 14px;font-size:11px;color:#536d78}
.review-card{border-top:2px solid #007b82}
.review-question{font-size:12px;font-weight:650;color:#153847;margin:6px 0 0}
.review-caption,.review-note,.review-evidence{font-size:10px;color:#536d78}
.review-note{margin:8px 0 0}
.review-evidence{margin-top:6px}
.review-evidence summary{cursor:pointer;font-size:10px;color:#007b82}
.review-table-scroll{max-height:220px;overflow:auto;border:1px solid #e6edf0;border-radius:4px;margin-top:4px}
.review-table-scroll table{border-collapse:collapse;font-size:10px;min-width:100%}
.review-table-scroll th{position:sticky;top:0;background:#f4f7f7;text-align:left;padding:3px 6px;border-bottom:1px solid #dce5e8;color:#24485a}
.review-table-scroll td{padding:3px 6px;border-bottom:1px solid #eef2f4}
*{scrollbar-width:thin;scrollbar-color:#91abc2 #e6edf0}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:#e6edf0}
::-webkit-scrollbar-thumb{background:#91abc2;border-radius:6px;border:2px solid #e6edf0}
@media(max-width:600px){.pt-toolbar{margin:0 -12px 14px;padding:10px 12px}.pt-field select,.pt-field input[type=search]{min-width:0;flex:1}}`;

const CARDS: Array<{ id: string; title: string; q: string; note: string; analyte?: 0 | 1 }> = [
  { id: 'pt0p0', title: 'Participant × Clinical-Domain Signal Matrix', q: 'Which participants carry open signals, and in which clinical review domain?', note: 'Four domains map to four reviewer roles: medical safety, protocol compliance, data integrity, IP exposure. Cell = open signal count; colour is a demo triage rule, not an approved score. Domains are never summed into a composite.' },
  { id: 'pt0p1', title: 'Signal Composition · Review Queue', q: 'Who should the review queue start with, and for what mix of reasons?', note: 'Stacked counts of open signals by domain, coloured to match the matrix columns. Read the composition, not a total score — each domain keeps its own definition and owner.' },
  { id: 'pt1p0', title: 'Safety Laboratory Trajectories', q: 'Whose key safety analyte is drifting out of the normal range over time?', note: 'One line per participant (8 highest-risk in scope); green band = normal range, red point = critical grade. Spaghetti form shows the individual trend a summary value hides. Demo grading, not approved thresholds.', analyte: 0 },
  { id: 'pt1p1', title: 'Laboratory Toxicity Shift · Baseline → Worst', q: 'How many participants shifted to a worse toxicity grade while on treatment?', note: 'Standard clinical shift table: upper triangle = worsening (red intensity by count), lower = improving (blue), diagonal = unchanged. Paired participants only; unpaired excluded and stated.', analyte: 1 },
  { id: 'pt1p2', title: 'Clinically Significant Lab Matrix', q: 'Which participants have which analytes at a clinically significant worst value?', note: 'Participant × analyte cross-tab of worst on-treatment flag and value. Lets the medical monitor scan all five safety analytes at once; ! = grade ≥3, △ = grade 1–2, ✓ = normal, — = not due.' },
  { id: 'pt1p3', title: 'AE Burden · Highest-Load Participants', q: 'Which participants carry accumulating high-grade or serious toxicity?', note: 'Bars stack mutually exclusive grade bands per event (G1–2 / G3 / G4); diamond marks any SAE without double-counting. Counts, not a severity score.' },
  { id: 'pt1p4', title: 'AE Onset vs Dose Timeline', q: 'Do onsets cluster after dose escalation, or recur within the same participant?', note: 'Background band = on-study period; dot size encodes grade, red ring = SAE; dashed line = demo dose-escalation week. Temporal association only, no causality inferred.' },
  { id: 'pt2p0', title: 'Consent-to-Randomization Interval', q: 'Are consent timing and the consent→randomization interval plausible for every participant?', note: 'Dumbbell: consent point → randomization diamond (aligned at 0); line length = interval. Demo flags: same-day, procedure-before-consent (red, GCP red flag), or >28 d re-consent review (amber). Not approved GCP rules.' },
  { id: 'pt2p1', title: 'Eligibility Deviation Matrix', q: 'Which participants entered the study with which eligibility exceptions?', note: 'Participant × criterion cross-tab. Violated = enrolled without meeting the criterion (red); Waiver = prospectively approved exception (amber). Waived ≠ violated — the distinction is the whole point.' },
  { id: 'pt2p2', title: 'Participant Visit Journey', q: 'Whose visit pattern is drifting toward loss to follow-up?', note: 'Swimlane: completed visits (amber = out of window), × missed, hollow = upcoming; track ends at withdrawal. The accumulating pattern — not a single point — is the early warning.' },
  { id: 'pt3p0', title: 'Key Assessment Completion Matrix', q: 'Where is a key assessment actually missing, versus not yet due?', note: 'Participant × key visit cross-tab. Done / Missing / Not due / Unknown are distinct states; not due is never counted as missing, unknown is excluded from denominators.' },
  { id: 'pt3p1', title: 'Missing Key Labs · Analyte × Visit', q: 'Which safety labs are systematically missing at which visits?', note: 'Cell = missing / due (denominator shown); amber intensity = missing burden. A genuine analyte × visit cross-tab, not a disguised bar chart. Not-due participants are excluded from the denominator.' },
  { id: 'pt3p2', title: 'Open Query Burden & Aging', q: 'Whose data is least reliable right now, and how old is the oldest query?', note: 'Lollipop length = open queries; colour = oldest age band (>30 d red, 15–30 amber). A sorted single measure uses a lollipop, not a single-column heatmap. Aging alone is not clinical risk; no production SLA.' },
  { id: 'pt3p3', title: 'ePRO Diary Completion · Last 12 Weeks', q: 'Whose patient-reported endpoint has gaps that threaten evaluability?', note: 'One square per due week: filled = complete, amber = partial, red-outlined empty = missed, grey = not due. Countable marks, no averaged score.' },
  { id: 'pt3p4', title: 'Lab Variance Anomaly · Inlier / Outlier', q: 'Does any participant’s eGFR look statistically implausible — too variable, or suspiciously flat?', note: 'Central statistical monitoring: mean vs within-participant SD. Unusually low variance (left of the demo inlier limit) can flag fabricated/templated data; high variance flags instability. A statistical signal for source review, not proof of misconduct.' },
  { id: 'pt4p0', title: 'Adherence vs Acceptance Band', q: 'Who falls outside the plausible adherence range — in either direction?', note: 'Bullet: acceptance band + adherence bar + value tick. Demo band 80–120%; below = under-exposure (red), above = accounting error or pill-dumping review (amber). Band is illustrative, not approved.' },
  { id: 'pt4p1', title: 'Dose Modification History', q: 'Is dose intensity eroding, and for which participants?', note: 'Segmented Gantt of mutually exclusive dose states (full / reduced / held). A held segment is not a discontinuation unless the track ends — sustained state, not an event point.' },
  { id: 'pt4p2', title: 'Pill Accountability Reconciliation', q: 'Does the pill count agree with the dosing diary for each participant?', note: 'Identity line = perfect agreement; demo ±10% band. Off-diagonal points trigger a reconciliation query, not an accusation — the classic accountability cross-check.' },
];

const SECTIONS: Array<{ id: string; h2: string; tag: string; q: string; cards: string[] }> = [
  { id: 'pt0', h2: 'Central monitor · cross-domain triage', tag: 'Central monitor / RBQM lead', q: '“Where do I start, and which discipline owns each open signal?” — one participant × domain view that routes work to the right reviewer.', cards: ['pt0p0', 'pt0p1'] },
  { id: 'pt1', h2: 'Medical monitor · participant safety', tag: 'Medical monitor / clinical scientist', q: '“Is anyone accumulating clinically significant laboratory toxicity or serious adverse events, and is it worsening on treatment?”', cards: ['pt1p0', 'pt1p1', 'pt1p2', 'pt1p3', 'pt1p4'] },
  { id: 'pt2', h2: 'CRA / site monitor · protocol compliance', tag: 'CRA / site monitor', q: '“Did consent, eligibility and visit conduct follow the protocol — and whose pattern is drifting toward loss to follow-up?”', cards: ['pt2p0', 'pt2p1', 'pt2p2'] },
  { id: 'pt3', h2: 'Data manager &amp; central statistical monitor · data integrity', tag: 'Data manager / central statistical monitor', q: '“Is the data complete, clean and statistically plausible — where is it missing versus merely not due, and does anything look too tidy?”', cards: ['pt3p0', 'pt3p1', 'pt3p2', 'pt3p3', 'pt3p4'] },
  { id: 'pt4', h2: 'Pharmacy / IP manager · exposure &amp; adherence', tag: 'Pharmacy / IP manager', q: '“Is actual drug exposure what the protocol intends — and does the pill count agree with the diary?”', cards: ['pt4p0', 'pt4p1', 'pt4p2'] },
];

const cardHtml = (c: (typeof CARDS)[number]): string => {
  const analyte = c.analyte !== undefined
    ? `<div class="pt-inline-field"><label for="pt-an-${c.analyte}">Analyte</label><select id="pt-an-${c.analyte}"><option value="egfr">eGFR</option><option value="k">Serum K</option><option value="hb">Haemoglobin</option><option value="alt">ALT</option><option value="uacr">UACR</option></select></div>`
    : '';
  return `<article class="card review-card${c.id === 'pt1p0' || c.id === 'pt2p0' || c.id === 'pt3p4' || c.id === 'pt4p0' ? ' wide' : ''}" data-chart-card="${c.id}"><div class="card-title"><span>${c.title}</span><span class="chart-status" data-status></span></div><p class="review-question">${c.q}</p>${analyte}<p class="review-caption" data-caption></p><div class="ec-chart" data-chart-id="${c.id}"></div><p class="review-note">${c.note}</p><div class="review-evidence" data-evidence="${c.id}"></div></article>`;
};

const TOOLBAR = `<div class="pt-toolbar" role="region" aria-label="Participant triage filters">
<div class="pt-field"><label for="pt-q">Search ID</label><input type="search" id="pt-q" placeholder="P-014…" autocomplete="off"></div>
<div class="pt-field"><label for="pt-site">Site</label><select id="pt-site"><option value="all">All sites</option><option value="0">Site 101</option><option value="1">Site 102</option><option value="2">Site 103</option><option value="3">Site 104</option><option value="4">Site 105</option><option value="5">Site 106</option></select></div>
<div class="pt-field"><label for="pt-cohort">Cohort</label><select id="pt-cohort"><option value="all">All cohorts</option><option value="1">Cohort 1</option><option value="2">Cohort 2</option><option value="3">Cohort 3</option><option value="4">Cohort 4</option></select></div>
<div class="pt-field"><label for="pt-status">Status</label><select id="pt-status"><option value="all">All statuses</option><option value="active">Active</option><option value="completed">Completed</option><option value="withdrawn">Withdrawn</option></select></div>
<div class="pt-field"><label for="pt-domain">Has signal in</label><select id="pt-domain"><option value="all">Any domain</option><option value="0">Medical safety</option><option value="1">Protocol compliance</option><option value="2">Data integrity</option><option value="3">IP exposure</option></select></div>
<div class="pt-field"><label for="pt-sort">Sort by</label><select id="pt-sort"><option value="burden">Signal burden</option><option value="id">Participant ID</option><option value="site">Site</option><option value="adherence">Adherence (low→high)</option><option value="lab">Lab severity (eGFR)</option></select></div>
<div class="pt-field"><label for="pt-roster">Open profile</label><select id="pt-roster"><option value="">Select participant…</option></select></div>
<label class="pt-toggle"><input type="checkbox" id="pt-high"> High-signal only (≥2)</label>
<button class="pt-reset" id="pt-reset" type="button">Reset filters</button>
</div>`;

export interface PageOptions {
  /** ECharts 脚本 URL；默认与平台一致的 CDN。 */
  echartsUrl?: string;
  /** 直接内嵌的 echarts.min.js 内容（file:// 验收用）。 */
  echartsScript?: string;
  /** 浏览器 bundle 内容；默认读 lib/pt-charts.js。 */
  bundle?: string;
  bundlePath?: string;
  /** 必填：页面数据（数据通道产出），以 window.PT_DATA 注入；页面无夹具回退。 */
  data: PtPageData;
}

const htmlEsc = (s: string): string => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export async function renderParticipantsPage(opts: PageOptions): Promise<string> {
  const bundle = opts.bundle ?? (await readFile(resolve(HERE, opts.bundlePath ?? '../lib/pt-charts.js'), 'utf8'));
  const echarts = opts.echartsScript ? `<script>${opts.echartsScript}</script>` : `<script src="${opts.echartsUrl ?? 'https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js'}"></script>`;
  // PT_DATA 在 bundle 之前求值；< 转义防止数据字符串提前闭合 script 标签。
  const ptData = JSON.stringify({ participants: opts.data.participants, panel: opts.data.panel ?? null, matrixPins: opts.data.matrixPins ?? null, source: opts.data.source }).replace(/</g, '\\u003c');
  const ptDataScript = `<script>window.PT_DATA=${ptData};</script>`;
  const fixture = opts.data.source.mode !== 'imported';
  const n = opts.data.participants.length;
  const marker = fixture ? '<!-- RBQM-PARTICIPANT-SYNTHETIC-PREVIEW -->' : '<!-- RBQM-PARTICIPANT-IMPORTED-PREVIEW -->';
  const notice = fixture
    ? '<p class="review-notice">Synthetic design preview. Illustrative participant scenarios only; masked synthetic IDs, no approved clinical rules or production thresholds. Sections are organised by the clinical role that owns each review question.</p>'
    : `<p class="review-notice">Imported study data via the platform channel (EDC rawdata → clean-up → Excel → dataset → chart builders). ${htmlEsc(opts.data.source.label)}${opts.data.source.sha256 ? ` · sha256 ${opts.data.source.sha256.slice(0, 12)}` : ''}. Demo grading and triage rules are illustrative; production thresholds await project approval.</p>`;
  const sourceBadge = fixture
    ? '<span class="demo">Synthetic data · Design preview</span>'
    : `<span class="demo">Imported data · ${htmlEsc(opts.data.source.label)}${opts.data.source.sha256 ? ` · sha256 ${opts.data.source.sha256.slice(0, 12)}` : ''}</span>`;
  const sections = SECTIONS.map((s) => `<section class="block" id="${s.id}"><div class="block-head"><h2>${s.h2} <span class="role-tag">${s.tag}</span></h2><p class="role-q">${s.q}</p></div><div class="grid">\n${s.cards.map((id) => cardHtml(CARDS.find((c) => c.id === id)!)).join('\n')}\n</div></section>`).join('\n\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RBQM · Participant risk monitoring</title><style>${CSS}</style><link rel="icon" href="data:,"></head><body>${marker}<header class="review-header"><strong>RBQM</strong><span>Renal study · Participant risk oversight</span><small>Review edition / participant v3 · role-driven</small></header>${notice}<div class="review-key"><span>! High signal</span><span>△ Warning</span><span>✓ Assessed normal</span><span>? Unknown</span><span>— Not due ≠ missing</span></div>
${TOOLBAR}
<main id="participant-analysis"><header class="functional-heading"><h1>Participant risk analysis</h1><div><span class="scope-badge" id="pt-scope-badge">${n} of ${n} shown · whole study</span> ${sourceBadge}</div></header><p class="pt-hint">Filters scope the participant-level charts live. Click a matrix cell, composition bar, or adherence row — or use “Open profile” — to open a participant’s cross-domain profile. Each section below is owned by a different clinical role; the same ${n} participants flow through all of them.</p>

${sections}

</main><div class="pt-scrim" id="pt-scrim"></div><aside class="pt-drawer" id="pt-drawer" aria-hidden="true" aria-label="Participant profile" role="dialog"><div id="pt-drawer-body"></div></aside>${echarts}${ptDataScript}<script>
${bundle}
</script></body></html>`;
}
