/**
 * 浏览器端入口（IIFE，全局 PT）：模型 + 18 构建器 + 页面生命周期。
 * 由 participant-page 生成的自包含 HTML 内嵌本 bundle 并自动 mount。
 * 交互逻辑与设计稿 participant-charts.js 逐字对应（工具栏/抽屉/自检）。
 */
import {
  CRIT,
  DEFAULT_SCOPE,
  DOMAIN,
  LABS,
  PT_THEME,
  SITES,
  VISITS,
  baseG,
  buildPtModels,
  cellState,
  filterParticipants,
  flagOf,
  labByKey,
  worstG,
  worstVal,
  type Participant,
  type PtModels,
  type PtScope,
} from './participant-model.js';
import { META, PT_CHART_IDS, ptOption, type PtMetaCtx } from './participant-charts.js';

declare const echarts: any;

/** 页面数据（渲染时由 participant-page 以 window.PT_DATA 注入；无夹具回退）。 */
interface PtPageSource {
  mode: 'fixture' | 'imported';
  label: string;
  sha256?: string;
}
interface PtData {
  participants: Participant[];
  panel?: string[] | null;
  matrixPins?: string[] | null;
  source: PtPageSource;
}
const DATA = (window as unknown as { PT_DATA?: PtData }).PT_DATA;
const P0: Participant[] = DATA?.participants ?? [];
const CUR = { panel: DATA?.panel ?? undefined, matrixPins: DATA?.matrixPins ?? undefined };
const synthetic = DATA?.source.mode !== 'imported';

const C = PT_THEME;
const byId = new Map<string, Participant>(P0.map((p) => [p.id, p]));
const reg = new Map<string, { chart: any; el: HTMLElement }>();
let scope: PtScope = { ...DEFAULT_SCOPE };
let labSel: Record<string, string> = { pt1p0: 'egfr', pt1p1: 'egfr' };
let P: Participant[] = P0;
let M: PtModels;

const filtered = (): Participant[] => filterParticipants(P, scope);
const buildModels = (): void => {
  P = filtered();
  M = buildPtModels(P, scope, labSel, CUR);
};
const ctx = (): PtMetaCtx => ({ M, P });
buildModels();

function statusChip(card: Element | null, state: string): void {
  const el = card?.querySelector('[data-status]');
  if (!el) return;
  const map: Record<string, [string, string]> = {
    high: ['status-high', '! High signal'],
    warning: ['status-warning', '△ Warning'],
    normal: ['status-normal', '✓ Assessed normal'],
    unknown: ['status-unknown', '? Unknown'],
  };
  const m = map[state] ?? map.unknown!;
  el.className = 'chart-status ' + m[0];
  el.textContent = m[1];
}

function buildEvidence(id: string, m: PtModels[keyof PtModels]): void {
  const card = document.querySelector(`[data-chart-card="${id}"]`);
  const host = card?.querySelector('[data-evidence]');
  if (!host) return;
  const meta = (META as Record<string, { ev: (mm: any, c: PtMetaCtx) => { h: string[]; rows: unknown[][] } }>)[id];
  if (!meta) return;
  const detail = document.createElement('details');
  const sum = document.createElement('summary');
  sum.textContent = 'View aggregate values & review context';
  detail.append(sum);
  const { h, rows } = meta.ev(m, ctx());
  const scroll = document.createElement('div');
  scroll.className = 'review-table-scroll';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  h.forEach((x) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = x;
    hr.append(th);
  });
  thead.append(hr);
  table.append(thead);
  const tb = document.createElement('tbody');
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    r.forEach((v) => {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.append(td);
    });
    tb.append(tr);
  });
  table.append(tb);
  scroll.append(table);
  detail.append(scroll);
  const note = document.createElement('p');
  note.textContent = synthetic
    ? 'Synthetic aggregate values. Demo grading and triage rules are illustrative; production thresholds await project approval.'
    : 'Aggregate values from the imported study workbook. Demo grading and triage rules are illustrative; production thresholds await project approval.';
  detail.append(note);
  host.replaceChildren(detail);
}

function updateScopeBadge(): void {
  const b = document.getElementById('pt-scope-badge');
  if (!b) return;
  const n = filtered().length;
  const bits: string[] = [];
  if (scope.site !== 'all') bits.push(typeof scope.site === 'number' ? (SITES[scope.site] ?? String(scope.site)) : scope.site);
  if (scope.cohort !== 'all') bits.push('Cohort ' + scope.cohort);
  if (scope.status !== 'all') bits.push(scope.status);
  if (scope.domain !== 'all') bits.push(DOMAIN[Number(scope.domain)] ?? '');
  if (scope.highOnly) bits.push('high-signal only');
  if (scope.q) bits.push('“' + scope.q + '”');
  b.textContent = `${n} of ${P0.length} shown` + (bits.length ? ' · ' + bits.join(' · ') : ' · whole study');
  const roster = document.getElementById('pt-roster');
  if (roster instanceof HTMLSelectElement) {
    const cur = roster.value;
    roster.replaceChildren(...filtered().map((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = `${p.id} · ${p.total} signals`;
      return o;
    }));
    if ([...roster.options].some((o) => o.value === cur)) roster.value = cur;
  }
}

function rerender(): void {
  buildModels();
  const c = ctx();
  reg.forEach((s, id) => {
    const w = s.el.clientWidth;
    if (w > 0) s.chart.setOption(ptOption(id, c, w), { notMerge: true });
    const card = document.querySelector(`[data-chart-card="${id}"]`);
    if (card) {
      const cap = card.querySelector('[data-caption]');
      const meta = META[id as keyof typeof META];
      if (cap && meta) cap.textContent = meta.cap(c);
      statusChip(card, meta ? meta.state(c) : 'unknown');
    }
    buildEvidence(id, M[id as keyof PtModels]);
  });
  updateScopeBadge();
}

function setScope(patch: Partial<PtScope>): void {
  Object.assign(scope, patch);
  rerender();
}

function initToolbar(): void {
  const bind = (id: string, key: string, ev = 'change', parse: (v: string) => string = (v) => v) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(ev, () => setScope({ [key]: parse((el as HTMLInputElement).value) } as Partial<PtScope>));
  };
  bind('pt-q', 'q', 'input', (v) => v.trim());
  bind('pt-site', 'site');
  bind('pt-cohort', 'cohort');
  bind('pt-status', 'status');
  bind('pt-domain', 'domain');
  bind('pt-sort', 'sort');
  for (const [elId, chartId] of [['pt-an-0', 'pt1p0'], ['pt-an-1', 'pt1p1']] as const) {
    const el = document.getElementById(elId);
    if (el) el.addEventListener('change', () => {
      labSel[chartId] = (el as HTMLSelectElement).value;
      rerender();
    });
  }
  const hi = document.getElementById('pt-high');
  if (hi) hi.addEventListener('change', () => setScope({ highOnly: (hi as HTMLInputElement).checked }));
  const reset = document.getElementById('pt-reset');
  if (reset) reset.addEventListener('click', () => {
    Object.assign(scope, { site: 'all', cohort: 'all', status: 'all', domain: 'all', q: '', sort: 'burden', highOnly: false });
    for (const [id, v] of [['pt-q', ''], ['pt-site', 'all'], ['pt-cohort', 'all'], ['pt-status', 'all'], ['pt-domain', 'all'], ['pt-sort', 'burden']] as const) {
      const e = document.getElementById(id);
      if (e) (e as HTMLInputElement).value = v;
    }
    if (hi) (hi as HTMLInputElement).checked = false;
    rerender();
  });
  const roster = document.getElementById('pt-roster');
  if (roster) roster.addEventListener('change', () => {
    const v = (roster as HTMLSelectElement).value;
    if (v) openParticipant(v);
  });
}

const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

function openParticipant(id: string): void {
  const p = byId.get(id);
  if (!p) return;
  const drawer = document.getElementById('pt-drawer');
  const scrim = document.getElementById('pt-scrim');
  const body = document.getElementById('pt-drawer-body');
  if (!drawer || !body) return;
  const stColor: Record<string, string> = { high: C.red, warning: C.amber, normal: C.green, unknown: C.secondary, notdue: C.secondary };
  const chips = DOMAIN.map((d, i) => {
    const st = cellState(p, i);
    return `<span class="pt-chip" style="border-color:${stColor[st]};color:${stColor[st]}">${esc(d)} · ${st === 'unknown' ? '?' : p.sig[i]}</span>`;
  }).join('');
  const labRows = LABS.map((l) => {
    const wg = worstG(p, l.key);
    const wv = worstVal(p, l.key);
    const st = flagOf(wg);
    return `<tr><td>${esc(l.name)}</td><td>${p.lab[l.key][0]?.v ?? '—'}</td><td style="color:${stColor[st]}">${wv ?? '—'} ${wv == null ? '' : esc(l.unit)}</td><td style="color:${stColor[st]}">${wg == null ? '?' : 'G' + wg + (wg >= 3 ? ' !' : wg >= 1 ? ' △' : ' ✓')}</td></tr>`;
  }).join('');
  const flags: string[] = [];
  LABS.forEach((l) => {
    const wg = worstG(p, l.key);
    if (wg >= 3) flags.push(`${l.name} critical (worst grade ${wg})`);
    else if (wg >= 1) flags.push(`${l.name} abnormal (grade ${wg})`);
  });
  p.aes.filter((a) => a.grade >= 3 || a.serious).forEach((a) => flags.push(`AE wk${a.wk} G${a.grade}${a.serious ? ' SAE' : ''} — ${a.term}`));
  if (p.procBefore) flags.push('Procedure before consent');
  if (p.consentGap === 0) flags.push('Same-day consent→randomization');
  if (p.consentGap > 28) flags.push(`Consent interval ${p.consentGap} d (>28)`);
  p.elig.forEach((e) => flags.push(`${CRIT[e.c]}: ${e.s}`));
  VISITS.forEach((w) => {
    if (p.endpoint[w] === 'missing' || p.visits[w]!.state === 'missed') flags.push(`Week ${w} key assessment missing`);
    else if (p.visits[w]!.state === 'done' && Math.abs(p.visits[w]!.dev ?? 0) > 7) flags.push(`Week ${w} visit ${(p.visits[w]!.dev ?? 0) > 0 ? '+' : ''}${p.visits[w]!.dev} d out of window`);
  });
  if (p.queries.oldest > 30) flags.push(`Oldest query ${p.queries.oldest} d`);
  if (p.adherence < 80) flags.push(`Adherence ${p.adherence}% (under-exposure)`);
  if (p.adherence > 120) flags.push(`Adherence ${p.adherence}% (above band)`);
  const taken = p.pills.dispensed - p.pills.returned;
  const mm = Math.round((Math.abs(taken - p.pills.diary) / taken) * 100);
  if (mm > 10) flags.push(`Pill count vs diary ${mm}% discrepancy`);
  if (p.doseSegs.some((s) => s.state === 'held')) flags.push('Dose held period recorded');
  const aes = p.aes.length
    ? p.aes.map((a) => `<li>wk${a.wk} · Grade ${a.grade}${a.serious ? ` · <b style="color:${C.red}">SAE</b>` : ''} · ${esc(a.term)}</li>`).join('')
    : '<li>None reported</li>';
  body.innerHTML = `
      <div class="pt-d-head"><div><div class="pt-d-id">${esc(p.id)}</div><div class="pt-d-sub">${esc(typeof p.site === 'number' ? (SITES[p.site] ?? String(p.site)) : p.site)} · Cohort ${esc(p.cohort)} · ${esc(p.arm)} · <b>${esc(p.status)}</b></div></div><button class="pt-d-close" id="pt-d-close" aria-label="Close profile">×</button></div>
      <div class="pt-d-chips">${chips}</div>
      <h4>Safety laboratory · baseline → worst</h4>
      <table class="pt-d-table"><thead><tr><th>Analyte</th><th>Base</th><th>Worst</th><th>Grade</th></tr></thead><tbody>${labRows}</tbody></table>
      <div class="pt-d-grid"><div><span>Adherence</span><b>${p.adherence}%</b></div><div><span>Open queries</span><b>${p.queries.open} · oldest ${p.queries.oldest} d</b></div><div><span>Pill count / diary</span><b>${taken} / ${p.pills.diary}</b></div><div><span>Weeks on study</span><b>${p.weeks}</b></div></div>
      <h4>Adverse events</h4><ul class="pt-d-list">${aes}</ul>
      <h4>Dose history</h4><p class="pt-d-line">${esc(p.doseSegs.map((s) => `${s.state} wk${s.from}–${s.to}`).join(' · '))}</p>
      <h4>Review flags (${flags.length})</h4>${flags.length ? '<ul class="pt-d-list pt-d-flags">' + flags.map((f) => '<li>' + esc(f) + '</li>').join('') + '</ul>' : '<p class="pt-d-line">No demo flags triggered.</p>'}
      <p class="pt-d-note">${synthetic ? 'Synthetic profile. Demo grading and flags are illustrative, not approved clinical thresholds.' : 'Profile from imported study data. Demo grading and flags are illustrative, not approved clinical thresholds.'}</p>`;
  drawer.classList.add('open');
  scrim?.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  const cb = document.getElementById('pt-d-close');
  cb?.addEventListener('click', closeDrawer);
  cb?.focus();
}

function closeDrawer(): void {
  const d = document.getElementById('pt-drawer');
  const s = document.getElementById('pt-scrim');
  if (d) {
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
  }
  s?.classList.remove('open');
}

const clickMap: Record<string, (prm: any) => string | undefined> = {
  pt0p0: (prm) => M.pt0p0.rows[prm.value && prm.value[1]]?.id,
  pt0p1: (prm) => M.pt0p1.rows[prm.dataIndex]?.id,
  pt1p2: (prm) => M.pt1p2.rows[prm.value && prm.value[1]]?.id,
  pt4p0: (prm) => M.pt4p0.rows[prm.dataIndex]?.id,
  pt3p2: (prm) => M.pt3p2.rows[prm.dataIndex]?.id,
};

function mount(): void {
  if (typeof echarts === 'undefined') return;
  if (!P0.length) {
    // 页面数据为空：显式无数据状态，不回退到 fixtures。
    document.documentElement.dataset.chartsRendered = '0';
    const main = document.getElementById('participant-analysis');
    const empty = document.createElement('p');
    empty.className = 'pt-hint';
    empty.textContent = 'No participant data on this page. Import a canonical workbook and rebuild — this page does not fall back to fixtures.';
    main?.prepend(empty);
    if (location.search.includes('selftest=1')) {
      const pre = document.createElement('pre');
      pre.id = 'ptcheck';
      pre.textContent = 'no-data 0/18';
      document.body.append(pre);
    }
    return;
  }
  let rendered = 0;
  const types: string[] = [];
  const c = ctx();
  for (const id of PT_CHART_IDS) {
    const el = document.querySelector<HTMLElement>(`[data-chart-id="${id}"]`);
    if (!el) continue;
    const card = document.querySelector(`[data-chart-card="${id}"]`);
    try {
      const chart = echarts.init(el, null, { renderer: 'canvas' });
      const o = ptOption(id, c, el.clientWidth);
      if (!o) continue;
      chart.setOption(o, true);
      reg.set(id, { chart, el });
      rendered++;
      types.push(id + ':' + [...new Set<string>((o.series ?? []).map((s: any) => s.type))].join('+'));
      if (card) {
        const cap = card.querySelector('[data-caption]');
        const meta = META[id];
        if (cap && meta) cap.textContent = meta.cap(c);
        statusChip(card, meta.state(c));
      }
      buildEvidence(id, M[id]);
      if (clickMap[id]) chart.on('click', (prm: any) => {
        const pid = clickMap[id]!(prm);
        if (pid) openParticipant(pid);
      });
    } catch {
      el.dataset.chartError = 'configuration';
    }
  }
  document.documentElement.dataset.chartsRendered = String(rendered);
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const id = (e.target as HTMLElement).dataset.chartId;
      const s = id ? reg.get(id) : undefined;
      if (!s) continue;
      const w = e.contentRect.width;
      const h = e.contentRect.height;
      if (w > 0 && h > 0) {
        s.chart.resize({ width: w, height: h });
        s.chart.setOption(ptOption(id!, ctx(), w), { notMerge: true });
      }
    }
  });
  reg.forEach((s) => ro.observe(s.el));
  initToolbar();
  updateScopeBadge();
  const scrim = document.getElementById('pt-scrim');
  if (scrim) scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
  if (location.search.includes('selftest=1')) {
    const pre = document.createElement('pre');
    pre.id = 'ptcheck';
    pre.textContent =
      'mounted ' + rendered + '/18\n' +
      'data ' + P0.length + ' · ' + (DATA?.source.mode ?? 'unknown') + ' · ' + (DATA?.source.label ?? 'unknown source') + '\n' +
      types.join('\n');
    document.body.append(pre);
  }
}

;(window as any).PT = { mount, setScope, openParticipant, closeDrawer, filtered, labSel, models: () => M, participants: () => P, option: (id: string, w: number) => ptOption(id, ctx(), w) };

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
