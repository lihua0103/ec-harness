/** Browser styles for the enterprise workbench shell. Every rule is scoped under `.ec-wb`, so the
 *  native conversation, sidebar and composer keep their own styling; disabling the plugin removes
 *  the whole stylesheet.
 *
 *  The 2026-11-13 visual refresh follows the reviewed concept draft
 *  (`prototypes/enterprise-workbench/design.html` + `design.css`): a jade/deep-teal palette on a
 *  cool canvas, a 56px topbar with the brand mark, a 210px navigation column with recent Works,
 *  a 13px type scale with 9–11px metadata, 5–7px radii and quiet one-pixel borders instead of the
 *  previous loose 14px/30px layout. Dark mode, narrow layouts, compact density and reduced motion
 *  stay explicit; the draft itself is light-only, so the dark palette is derived from the same hues.
 *
 *  One deliberate deviation: the draft sets 8–11px metadata in very light greys (measured
 *  2.4–4.4:1 on paper). The same cool grey-teal family is kept but unified to one readable meta ink
 *  (#5c7278 light / #93a5ab dark), so every text pairing clears 4.5:1 in both themes.
 */
export const WORKBENCH_CSS = `
.ec-wb {
  --ec-ink: #143842;
  --ec-deep: #063e4a;
  --ec-muted: #5c7278;
  --ec-secondary: #526d73;
  --ec-primary: #087b6b;
  --ec-primary-hover: #06695c;
  --ec-green: #0a6f61;
  --ec-green-weak: #e8f3f0;
  --ec-paper: #eff4f5;
  --ec-white: #ffffff;
  --ec-line: #dce7e9;
  --ec-line-strong: #d5e1e3;
  --ec-line-soft: #edf1f2;
  --ec-soft: #f6f9f9;
  --ec-amber: #8a5f22;
  --ec-amber-weak: #fff4e3;
  --ec-amber-line: #ecd9bb;
  --ec-danger: #9c5044;
  --ec-danger-weak: #fdf6f4;
  --ec-focus: #46a994;
  --ec-radius: 7px;
  --ec-radius-sm: 5px;
  --ec-font: "Aptos", "Segoe UI Variable Text", "Microsoft YaHei UI", "PingFang SC", "Segoe UI", sans-serif;
  --ec-topbar-h: 56px;
  --ec-nav-w: 210px;
  --ec-topbar-bg: #ffffff;
  --ec-shadow-1: 0 2px 5px rgba(19, 62, 73, .03);
  --ec-shadow-2: 0 2px 4px rgba(11, 90, 76, .13);
  --ec-shadow-3: 0 8px 24px rgba(19, 62, 73, .10);
  --ec-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23526d73' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  /* Host-token compatibility: the enterprise palette is authoritative here, while these aliases
     keep the page legible if a host only publishes the standard --dsw-* tokens. */
  --ec-host-label-primary: var(--dsw-alias-label-primary, #143842);
  --ec-host-label-tertiary: var(--dsw-alias-label-tertiary, #5c7278);
  --ec-host-border: var(--dsw-alias-border-l2, #dce7e9);
  --ec-host-surface: var(--dsw-alias-bg-layer-1, #ffffff);
  --ec-host-business: var(--dsw-alias-state-business-primary, #0b806e);
  --ec-host-error: var(--dsw-alias-state-error-primary, #9c5044);
  --ec-host-radius: var(--dsw-radius-md, 7px);
  --ec-gap: 13px;
  --ec-pad: 15px;
  color: var(--ec-ink);
  background: var(--ec-paper);
  color-scheme: light;
  font-family: var(--ec-font);
  font-size: 13px;
  line-height: 1.45;
  font-synthesis: none;
  box-sizing: border-box;
  height: 100%;
  overflow: auto;
}
.ec-wb *, .ec-wb *::before, .ec-wb *::after { box-sizing: border-box; }
.ec-wb { scrollbar-width: thin; scrollbar-color: #c3d2d6 transparent; }
.ec-wb ::-webkit-scrollbar { width: 9px; height: 9px; }
.ec-wb ::-webkit-scrollbar-thumb { background: #c3d2d6; border: 2px solid transparent; border-radius: 5px; background-clip: content-box; }
.ec-wb ::-webkit-scrollbar-track { background: transparent; }
.ec-wb[data-density="compact"] { --ec-gap: 10px; --ec-pad: 12px; font-size: 12px; }
/* Expert diagnostics: raw infrastructure facts (paths, session ids, digests) stay hidden from the
   business-facing view until the employee turns on expert mode. A display preference, not a gate. */
.ec-wb:not([data-expert="on"]) .ec-wb-expert-only { display: none; }
.ec-wb h1 { margin: 0; font-size: 24px; line-height: 1.2; letter-spacing: -.035em; font-weight: 700; color: #123f4a; }
.ec-wb h2 { margin: 0; font-size: 13px; line-height: 1.4; font-weight: 650; color: #1c4852; }
.ec-wb h3 { margin: 0; font-size: 12px; line-height: 1.4; font-weight: 650; color: #234a53; }
.ec-wb h4 { margin: 0; font-size: 11px; line-height: 1.4; font-weight: 650; }
.ec-wb p { margin: 0; }
.ec-wb .ec-wb-muted { color: var(--ec-muted); font-size: 10px; line-height: 1.6; }
.ec-wb .ec-wb-stack { display: flex; flex-direction: column; gap: var(--ec-gap); min-width: 0; }
/* Screen-reader-only text: keeps a table's action column labelled without drawing a header. */
.ec-wb .ec-wb-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* ── Topbar ─────────────────────────────────────────────────────────────── */
.ec-wb .ec-wb-topbar {
  height: var(--ec-topbar-h); min-height: var(--ec-topbar-h); padding: 0 26px;
  display: flex; align-items: center; gap: 12px;
  background: var(--ec-topbar-bg); border-bottom: 1px solid var(--ec-line);
  position: sticky; top: 0; z-index: 20;
}
.ec-wb .ec-wb-mark {
  width: 26px; height: 26px; flex: none; border-radius: 7px; background: var(--ec-green-weak);
  color: var(--ec-green); display: grid; place-items: center;
}
.ec-wb .ec-wb-wordmark { font-size: 12px; letter-spacing: .11em; font-weight: 800; color: #174853; white-space: nowrap; }
.ec-wb .ec-wb-top-divider { height: 18px; border-left: 1px solid var(--ec-line); margin: 0 4px; flex: none; }
.ec-wb .ec-wb-breadcrumb { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #5c7278; min-width: 0; }
.ec-wb .ec-wb-breadcrumb span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #345760; font-weight: 600; }
.ec-wb .ec-wb-top-actions { margin-left: auto; display: flex; align-items: center; gap: 10px; flex: none; }
.ec-wb .ec-wb-conn { display: inline-flex; align-items: center; gap: 7px; font-size: 11px; color: #267966; white-space: nowrap; }
.ec-wb .ec-wb-conn::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #18a37e; box-shadow: 0 0 0 3px #e4f4ee; flex: none; }
.ec-wb .ec-wb-conn.is-down { color: var(--ec-amber); }
.ec-wb .ec-wb-conn.is-down::before { background: #cf9237; box-shadow: 0 0 0 3px #fbf0dd; }
.ec-wb button.ec-wb-icon-btn {
  width: 30px; height: 30px; flex: none; display: grid; place-items: center; padding: 0;
  border: 1px solid var(--ec-line); border-radius: 6px; background: var(--ec-white); color: var(--ec-secondary);
  cursor: pointer; transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.ec-wb button.ec-wb-icon-btn:hover { background: var(--ec-soft); border-color: var(--ec-line-strong); }
.ec-wb button.ec-wb-icon-btn[aria-pressed="true"] { background: var(--ec-green-weak); border-color: #bfd7d6; color: var(--ec-primary); }

/* ── Shell and navigation ───────────────────────────────────────────────── */
.ec-wb .ec-wb-shell { display: grid; grid-template-columns: var(--ec-nav-w) minmax(0, 1fr); min-height: calc(100vh - var(--ec-topbar-h)); align-items: stretch; }
.ec-wb .ec-wb-nav {
  background: #fbfdfd; border-right: 1px solid var(--ec-line); padding: 17px 12px 13px;
  display: flex; flex-direction: column; gap: 3px; min-width: 0;
  position: sticky; top: var(--ec-topbar-h); align-self: start;
  height: calc(100vh - var(--ec-topbar-h)); overflow: hidden;
}
.ec-wb .ec-wb-nav-brand { display: flex; align-items: center; gap: 10px; padding: 2px 8px 17px; }
.ec-wb .ec-wb-nav-mark {
  width: 30px; height: 30px; flex: none; border-radius: 7px; background: #0c5360; color: #fff;
  display: grid; place-items: center;
}
.ec-wb .ec-wb-nav-brand strong { display: block; font-size: 11px; letter-spacing: .1em; color: #20505a; }
.ec-wb .ec-wb-nav-brand small { display: block; font-size: 10px; color: #5c7278; margin-top: 1px; }
.ec-wb button.ec-wb-nav-new {
  display: flex; align-items: center; gap: 7px; height: 36px; flex: none;
  border: 0; border-radius: var(--ec-radius-sm); background: var(--ec-primary); color: #fff;
  font: inherit; font-size: 12px; font-weight: 650; text-align: left; padding: 0 12px; cursor: pointer;
  box-shadow: var(--ec-shadow-2); transition: background-color .15s ease;
}
.ec-wb button.ec-wb-nav-new:hover { background: var(--ec-primary-hover); }
.ec-wb button.ec-wb-nav-new .ec-wb-nav-plus { font-size: 15px; line-height: 1; }
.ec-wb .ec-wb-nav-items { display: grid; gap: 3px; margin-top: 17px; }
.ec-wb button.ec-wb-nav-item {
  display: flex; align-items: center; gap: 0; height: 35px; padding: 0 11px; border: 0;
  border-radius: var(--ec-radius-sm); background: transparent; color: var(--ec-secondary);
  font: inherit; font-size: 12px; text-align: left; cursor: pointer;
  transition: background-color .15s ease, color .15s ease;
}
.ec-wb button.ec-wb-nav-item .ec-wb-nav-glyph { display: inline-flex; align-items: center; justify-content: center; width: 23px; flex: none; color: #82999d; }
.ec-wb button.ec-wb-nav-item:hover { background: #f0f5f5; }
.ec-wb button.ec-wb-nav-item[aria-current="page"] { background: var(--ec-green-weak); color: #086c5f; font-weight: 700; box-shadow: inset 2px 0 0 #0c8975; }
.ec-wb button.ec-wb-nav-item[aria-current="page"] .ec-wb-nav-glyph { color: var(--ec-green); }
.ec-wb .ec-wb-nav-count { margin-left: auto; font-size: 10px; font-weight: 600; color: #5c7278; font-variant-numeric: tabular-nums; }
.ec-wb .ec-wb-nav-count[data-alert="true"] { color: var(--ec-amber); }
.ec-wb .ec-wb-nav-caption { font-size: 10px; color: #5c7278; padding: 18px 11px 7px; flex: none; }
.ec-wb .ec-wb-recent { display: flex; flex-direction: column; gap: 1px; overflow: auto; min-height: 0; flex: 1; }
.ec-wb button.ec-wb-recent-item {
  display: block; width: 100%; padding: 8px 10px; border: 0; border-radius: var(--ec-radius-sm);
  text-align: left; background: transparent; font: inherit; cursor: pointer;
}
.ec-wb button.ec-wb-recent-item:hover { background: #f0f5f5; }
.ec-wb button.ec-wb-recent-item strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 600; color: #3f6067; }
.ec-wb button.ec-wb-recent-item small { display: block; margin-top: 2px; color: #5c7278; font-size: 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ec-wb button.ec-wb-recent-item.is-active { background: #eef5f3; }
.ec-wb button.ec-wb-recent-item.is-active strong { color: #0b6b5e; }
.ec-wb .ec-wb-nav-empty { padding: 4px 11px; font-size: 9px; color: #5c7278; line-height: 1.6; }
.ec-wb button.ec-wb-nav-bottom {
  margin-top: auto; flex: none; border: 0; border-top: 1px solid #e6edef; background: transparent;
  padding: 11px 9px 0; display: flex; align-items: center; gap: 8px; width: 100%;
  color: #5c7278; font: inherit; font-size: 10px; text-align: left; cursor: pointer;
}
.ec-wb button.ec-wb-nav-bottom:hover strong { color: var(--ec-primary); }
.ec-wb .ec-wb-nav-bottom-mark { width: 25px; height: 25px; flex: none; border-radius: 50%; background: #deece8; color: #21665d; display: grid; place-items: center; }
.ec-wb .ec-wb-nav-bottom strong { display: block; color: #405e64; font-size: 10px; font-weight: 600; }
.ec-wb .ec-wb-nav-bottom span.ec-wb-nav-bottom-sub { display: block; font-size: 9px; color: #5c7278; margin-top: 1px; }
.ec-wb .ec-wb-nav-bottom .ec-wb-nav-bottom-arrow { margin-left: auto; color: #9eadaf; font-size: 12px; }

/* ── Main column and page frame ─────────────────────────────────────────── */
.ec-wb .ec-wb-main { min-width: 0; background: var(--ec-paper); }
.ec-wb .ec-wb-page { padding: 23px 28px 14px; display: flex; flex-direction: column; gap: var(--ec-gap); min-width: 0; }
.ec-wb .ec-wb-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.ec-wb .ec-wb-page-head p { margin-top: 6px; max-width: 68ch; }
.ec-wb .ec-wb-page-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ec-wb .ec-wb-hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; min-height: 79px; flex-wrap: wrap; }
.ec-wb .ec-wb-eyebrow { font-size: 10px; color: #5c7278; margin-bottom: 5px; }
.ec-wb .ec-wb-hero p { margin-top: 6px; color: #5c7278; font-size: 11px; max-width: 64ch; }
.ec-wb .ec-wb-hero-actions { display: flex; align-items: center; gap: 8px; padding-bottom: 2px; flex-wrap: wrap; }
.ec-wb .ec-wb-chip { font-size: 10px; color: #5c7278; padding-right: 7px; white-space: nowrap; }
.ec-wb .ec-wb-hero-cta { min-height: 32px; padding: 0 13px; font-size: 11px; }
/* Flagship home: the attention slip is the only visually emphatic surface. */
.ec-wb .ec-wb-home-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; padding-block: 12px 17px; border-bottom: 1px solid var(--ec-line); }
.ec-wb .ec-wb-home-header h1 { font-size: clamp(24px, 3vw, 32px); }
.ec-wb .ec-wb-home-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
.ec-wb .ec-wb-home-actions select { width: auto; max-width: min(240px, 100%); }
.ec-wb .ec-wb-home-actions :is(button, select), .ec-wb .ec-wb-home-slip button { min-height: 36px; font-size: 13px; }
.ec-wb .ec-wb-home-priority, .ec-wb .ec-wb-home-context section { min-width: 0; }
.ec-wb .ec-wb-home-priority h2, .ec-wb .ec-wb-home-context h2 { font-size: 17px; margin-block: 0 9px; }
.ec-wb .ec-wb-home-slip { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; background: var(--ec-white); border: 1px solid var(--ec-line); border-inline-start: 3px solid var(--ec-primary); border-radius: 6px; padding: 14px 16px; }
.ec-wb .ec-wb-home-slip[data-failed="true"] { border-inline-start-color: var(--ec-amber); }
.ec-wb .ec-wb-home-slip > div { flex: 1 1 210px; min-width: 0; overflow-wrap: anywhere; }
.ec-wb .ec-wb-home-slip strong { display: block; color: var(--ec-ink); font-size: 17px; margin-block: 3px; }
.ec-wb .ec-wb-home-slip span { color: var(--ec-primary); font-size: 12px; font-weight: 650; }
.ec-wb .ec-wb-home-slip[data-failed="true"] span { color: var(--ec-amber); }
.ec-wb .ec-wb-home-slip p, .ec-wb .ec-wb-home-context .ec-wb-muted { color: var(--ec-muted); font-size: 13px; line-height: 1.5; }
.ec-wb .ec-wb-home-context { border-inline-start: 1px solid var(--ec-line); padding-inline-start: 16px; }
.ec-wb .ec-wb-home-context section + section { border-top: 1px solid var(--ec-line); padding-block-start: 14px; }
.ec-wb .ec-wb-page-home .ec-wb-queue { box-shadow: none; }
.ec-wb .ec-wb-page-home .ec-wb-work-row .ec-wb-work-tail .ec-wb-button { opacity: 1; white-space: normal; }
.ec-wb .ec-wb-page-home :focus-visible { outline: 2px solid var(--ec-primary); outline-offset: 2px; }
@media (max-width: 900px) {
  .ec-wb .ec-wb-page-home .ec-wb-home-grid { grid-template-columns: minmax(0, 1fr); align-items: start; }
  .ec-wb .ec-wb-home-context { border-inline-start: 0; border-top: 1px solid var(--ec-line); padding: 14px 0 0; }
}
@media (prefers-reduced-motion: reduce) {
  .ec-wb .ec-wb-page-home * { transition: none; }
}
.ec-wb .ec-wb-home-grid { display: grid; grid-template-columns: minmax(0, 1fr) 282px; gap: var(--ec-gap); align-items: start; }
/* The home canvas fills the screen like the reviewed draft: the queue and the project panel take
   the remaining height instead of leaving a dead band under a short list. */
.ec-wb .ec-wb-page-home { min-height: calc(100vh - var(--ec-topbar-h)); }
.ec-wb .ec-wb-page-home .ec-wb-home-grid { flex: 1; align-items: stretch; }
.ec-wb .ec-wb-page-home .ec-wb-home-grid > .ec-wb-stack { min-height: 0; }
.ec-wb .ec-wb-page-home .ec-wb-queue { flex: 1; }
.ec-wb .ec-wb-page-home .ec-wb-rail > .ec-wb-card:last-child { flex: 1; }
.ec-wb .ec-wb-detail { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: var(--ec-gap); align-items: start; }
.ec-wb .ec-wb-rail { display: flex; flex-direction: column; gap: var(--ec-gap); min-width: 0; }
.ec-wb .ec-wb-canvas-foot { display: flex; align-items: center; gap: 10px; padding: 2px; color: #5c7278; font-size: 9px; flex-wrap: wrap; }
.ec-wb .ec-wb-canvas-foot .ec-wb-sep { height: 10px; border-left: 1px solid #d8e2e4; }
.ec-wb button.ec-wb-foot-link { margin-left: auto; border: 0; background: transparent; padding: 0; font: inherit; font-size: 9px; color: #5c7278; cursor: pointer; }
.ec-wb button.ec-wb-foot-link:hover { color: var(--ec-primary); }

/* ── Panels ─────────────────────────────────────────────────────────────── */
.ec-wb .ec-wb-card {
  background: var(--ec-white); border: 1px solid #dbe5e7; border-radius: var(--ec-radius);
  padding: var(--ec-pad); display: flex; flex-direction: column; gap: 10px; min-width: 0;
  box-shadow: var(--ec-shadow-1);
}
.ec-wb .ec-wb-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ec-wb .ec-wb-card-head p { margin-top: 3px; }

/* ── AI launch panel ────────────────────────────────────────────────────── */
.ec-wb .ec-wb-launch { display: grid; grid-template-columns: minmax(0, 1fr) 260px; padding: 0; gap: 0; position: relative; overflow: hidden; }
.ec-wb .ec-wb-launch::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: #108b77; }
.ec-wb .ec-wb-launch-intro { padding: 18px 20px 15px 23px; display: flex; flex-direction: column; justify-content: space-between; gap: 14px; min-width: 0; }
.ec-wb .ec-wb-launch-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ec-wb .ec-wb-orb {
  width: 39px; height: 39px; flex: none; position: relative; border-radius: 10px;
  background: #e9f4f1; color: #087967; display: grid; place-items: center;
}
.ec-wb .ec-wb-orb::after { content: ""; position: absolute; width: 5px; height: 5px; border-radius: 50%; background: #1ca184; top: 7px; right: 7px; box-shadow: 0 0 0 3px #d4eee6; }
.ec-wb .ec-wb-launch-label { font-size: 10px; color: #5c7278; }
.ec-wb .ec-wb-launch-intro h2 { font-size: 17px; letter-spacing: -.02em; color: #173e49; font-weight: 680; }
.ec-wb .ec-wb-launch-desc { font-size: 11px; color: #5c7278; margin-top: 3px; }
.ec-wb .ec-wb-quick { display: flex; align-items: center; gap: 7px; margin-left: 51px; flex-wrap: wrap; }
.ec-wb .ec-wb-quick > span { font-size: 9px; color: #839397; margin-right: 2px; }
.ec-wb button.ec-wb-quick-target {
  display: inline-flex; align-items: center; gap: 4px; border: 1px solid #e0e9ea; background: #fbfdfd;
  border-radius: 4px; padding: 5px 8px; font: inherit; font-size: 9px; color: #567177; cursor: pointer;
  transition: border-color .15s ease, background-color .15s ease;
}
.ec-wb button.ec-wb-quick-target:hover { border-color: #9ac9bb; background: #f2f9f6; }
.ec-wb button.ec-wb-quick-target b { font-size: 10px; color: #46716b; }
.ec-wb .ec-wb-launch-controls {
  background: #f8fbfb; border-left: 1px solid #e8eeee; padding: 15px 17px 13px;
  display: flex; flex-direction: column; justify-content: center; gap: 9px; min-width: 0;
}
.ec-wb .ec-wb-model-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 9px; color: #5c7278; }
.ec-wb .ec-wb-model-row strong { font-size: 10px; color: #3d5c62; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ec-wb button.ec-wb-launch-go {
  height: 34px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
  margin-top: 2px; background: var(--ec-primary); border: 0; border-radius: var(--ec-radius-sm);
  color: #fff; font: inherit; font-size: 11px; font-weight: 650; cursor: pointer;
  transition: background-color .15s ease;
}
.ec-wb button.ec-wb-launch-go:hover:not(:disabled) { background: var(--ec-primary-hover); }
.ec-wb button.ec-wb-launch-go:disabled { opacity: .5; cursor: not-allowed; }

/* ── Rail: pending, readiness, projects ─────────────────────────────────── */
.ec-wb .ec-wb-pending-empty { display: flex; align-items: flex-start; gap: 9px; padding: 3px 0 1px; }
.ec-wb .ec-wb-empty-icon { width: 23px; height: 23px; border-radius: 6px; display: grid; place-items: center; background: #eff6f3; color: #30816f; flex: none; }
.ec-wb .ec-wb-pending-empty p { font-size: 10px; color: #5c7278; line-height: 1.55; }
.ec-wb .ec-wb-pending-empty small { display: block; color: #5c7278; font-size: 9px; margin-top: 2px; }
.ec-wb .ec-wb-pending-dot { width: 6px; height: 6px; border-radius: 50%; background: #cc8b2d; flex: none; }
.ec-wb .ec-wb-readiness-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ec-wb .ec-wb-state-tag { font-size: 9px; color: #8a5f22; background: #fff5e7; padding: 4px 7px; border-radius: 4px; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; }
.ec-wb .ec-wb-state-tag::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: #cf9237; flex: none; }
.ec-wb .ec-wb-state-tag[data-tone="ok"] { color: #217251; background: #e9f5ef; }
.ec-wb .ec-wb-state-tag[data-tone="ok"]::before { background: #18a37e; }
.ec-wb .ec-wb-checks { display: grid; gap: 7px; }
.ec-wb .ec-wb-checkline { display: flex; align-items: center; gap: 8px; font-size: 9px; color: #5c7278; }
.ec-wb .ec-wb-tick {
  width: 14px; height: 14px; flex: none; border: 1px solid #d7e2e4; border-radius: 4px;
  display: grid; place-items: center; font-size: 8px; color: #5c7278; background: var(--ec-white);
}
.ec-wb .ec-wb-tick[data-tone="ok"] { border-color: #c5e4d8; background: #e9f5ef; color: #0f6b55; }
.ec-wb .ec-wb-tick[data-tone="pending"] { border-color: #ead8b8; background: #fff8ec; color: #8a5f22; }
.ec-wb button.ec-wb-readiness-link {
  margin-top: 1px; padding: 9px 0 0; border: 0; border-top: 1px solid var(--ec-line-soft);
  background: transparent; width: 100%; display: flex; align-items: center; justify-content: space-between;
  color: #08796a; font: inherit; font-size: 9px; cursor: pointer;
}
.ec-wb button.ec-wb-readiness-link:hover { color: var(--ec-primary-hover); }
.ec-wb button.ec-wb-project-row, .ec-wb button.ec-wb-run-row, .ec-wb .ec-wb-artifact-row {
  width: 100%; display: flex; align-items: center; gap: 9px; padding: 9px 0;
  border: 0; border-top: 1px solid var(--ec-line-soft); background: transparent; text-align: left;
  font: inherit; color: inherit; min-width: 0;
}
.ec-wb button.ec-wb-project-row, .ec-wb button.ec-wb-run-row { cursor: pointer; }
.ec-wb button.ec-wb-project-row:hover strong, .ec-wb button.ec-wb-run-row:hover strong { color: var(--ec-primary); }
.ec-wb .ec-wb-project-row:first-of-type, .ec-wb .ec-wb-run-row:first-of-type, .ec-wb .ec-wb-artifact-row:first-of-type { border-top: 0; }
.ec-wb .ec-wb-monogram {
  width: 27px; height: 27px; flex: none; display: grid; place-items: center; background: #edf5f2;
  border-radius: 5px; color: #28766a; font-size: 10px; font-weight: 700;
}
.ec-wb .ec-wb-project-row strong, .ec-wb .ec-wb-run-row strong, .ec-wb .ec-wb-artifact-row strong { display: block; font-size: 10px; font-weight: 620; overflow-wrap: anywhere; }
.ec-wb .ec-wb-project-row small, .ec-wb .ec-wb-run-row small, .ec-wb .ec-wb-artifact-row small { display: block; font-size: 9px; color: #5c7278; margin-top: 2px; }
/* Rail rows are read at a glance, not scanned: give the run name a readable size and a
   visible selected state instead of relying on a 6px dot. */
.ec-wb .ec-wb-run-row { border-radius: 8px; padding: 10px 8px; margin: 0 -8px; }
.ec-wb .ec-wb-run-row strong { font-size: 12px; }
.ec-wb .ec-wb-run-row small { font-size: 10.5px; }
.ec-wb button.ec-wb-run-row[aria-current="true"] { background: var(--ec-green-weak); }
.ec-wb button.ec-wb-run-row[aria-current="true"] strong { color: var(--ec-primary); }
.ec-wb .ec-wb-row-tail { margin-left: auto; color: #9eadaf; font-size: 14px; flex: none; }
.ec-wb button.ec-wb-project-link {
  margin-top: 1px; padding: 8px 0 0; border: 0; border-top: 1px solid var(--ec-line-soft);
  background: transparent; width: 100%; text-align: left; color: #08796a; font: inherit; font-size: 9px; cursor: pointer;
}
.ec-wb button.ec-wb-project-link:hover { color: var(--ec-primary-hover); }

/* ── Works queue table ──────────────────────────────────────────────────── */
.ec-wb .ec-wb-queue { padding: 0; gap: 0; }
.ec-wb .ec-wb-queue-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 17px 11px; flex-wrap: wrap; }
.ec-wb .ec-wb-queue-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ec-wb .ec-wb-queue-tools .ec-wb-count { font-size: 9px; color: #5c7278; font-variant-numeric: tabular-nums; }
/* Queue toolbar: a search field and two compact selects, sized to the draft's 9–11px metadata. */
.ec-wb .ec-wb-search { position: relative; display: flex; align-items: center; min-width: 190px; }
.ec-wb .ec-wb-search-glyph { position: absolute; left: 9px; display: inline-flex; color: #5c7278; pointer-events: none; }
.ec-wb .ec-wb-input.ec-wb-search-input {
  min-height: 31px; padding: 0 26px 0 28px; font-size: 10px; border-radius: var(--ec-radius-sm);
}
.ec-wb .ec-wb-search-input::-webkit-search-cancel-button { display: none; }
.ec-wb button.ec-wb-search-clear {
  position: absolute; right: 5px; width: 18px; height: 18px; display: grid; place-items: center;
  border: 0; border-radius: 4px; background: transparent; color: #5c7278; font: inherit; font-size: 13px;
  line-height: 1; cursor: pointer;
}
.ec-wb button.ec-wb-search-clear:hover { background: var(--ec-soft); color: var(--ec-primary); }
.ec-wb .ec-wb-select.ec-wb-queue-select { width: auto; min-width: 92px; min-height: 31px; font-size: 10px; padding: 0 24px 0 9px; }
.ec-wb .ec-wb-queue-empty { padding: 4px 17px 14px; }
.ec-wb .ec-wb-queue-note { padding: 0 17px 8px; }
.ec-wb .ec-wb-queue-foot button.ec-wb-text-link:disabled { opacity: .6; cursor: default; }
.ec-wb .ec-wb-table { min-width: 0; }
.ec-wb .ec-wb-table-head, .ec-wb .ec-wb-work-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.6fr) minmax(100px, .95fr) minmax(74px, .7fr) minmax(92px, .8fr) 62px;
  align-items: center; gap: 10px; padding: 0 17px;
}
.ec-wb .ec-wb-table-head { height: 28px; background: #f7f9fa; border-top: 1px solid #e8eeee; border-bottom: 1px solid #e8eeee; font-size: 9px; color: #5c7278; }
.ec-wb .ec-wb-work-row { min-height: 49px; border-bottom: 1px solid var(--ec-line-soft); background: var(--ec-white); transition: background-color .15s ease; }
.ec-wb .ec-wb-work-row:hover { background: #f7faf9; }
.ec-wb .ec-wb-work-name { display: flex; align-items: center; gap: 9px; min-width: 0; }
.ec-wb .ec-wb-work-icon {
  width: 27px; height: 27px; flex: none; border: 1px solid #e2eaea; background: #f3f7f6; border-radius: 5px;
  display: grid; place-items: center; color: #347166; font-size: 10px; font-weight: 700;
}
.ec-wb button.ec-wb-work-open { border: 0; background: transparent; padding: 0; text-align: left; font: inherit; color: inherit; cursor: pointer; min-width: 0; }
.ec-wb .ec-wb-work-name strong { display: block; font-size: 10px; color: #244951; font-weight: 640; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
.ec-wb button.ec-wb-work-open:hover strong { color: var(--ec-primary); }
.ec-wb .ec-wb-work-name small { font-size: 8px; color: #5c7278; display: block; margin-top: 2px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
.ec-wb .ec-wb-app-cell { font-size: 9px; color: #5c7278; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ec-wb .ec-wb-state { display: inline-flex; align-items: center; gap: 5px; font-size: 9px; color: #58777a; white-space: nowrap; }
.ec-wb .ec-wb-state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #1a987a; flex: none; }
.ec-wb .ec-wb-state[data-tone="warn"]::before { background: #cd8b30; }
.ec-wb .ec-wb-state[data-tone="error"]::before { background: #c0574c; }
.ec-wb .ec-wb-state[data-tone="muted"]::before { background: #a8b6b9; }
.ec-wb .ec-wb-updated { font-size: 9px; color: #5c7278; white-space: nowrap; }
.ec-wb .ec-wb-work-tail { display: flex; justify-content: flex-end; }
.ec-wb .ec-wb-queue-foot {
  min-height: 27px; margin-top: auto; padding: 6px 16px; display: flex; align-items: center; gap: 7px;
  background: #fafcfc; border-top: 1px solid var(--ec-line-soft); font-size: 8px; color: #5c7278;
}
.ec-wb .ec-wb-queue-foot i { width: 5px; height: 5px; border-radius: 50%; background: #1a987a; flex: none; }
.ec-wb .ec-wb-queue-foot .ec-wb-foot-right { margin-left: auto; }

/* ── Rows, badges, buttons ──────────────────────────────────────────────── */
.ec-wb .ec-wb-row-button {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 10px 4px; border-top: 1px solid var(--ec-line-soft); background: transparent;
  border-left: 0; border-right: 0; border-bottom: 0; color: inherit; font: inherit; width: 100%; min-width: 0;
}
.ec-wb .ec-wb-rows .ec-wb-row-button:first-of-type { border-top: 0; }
.ec-wb .ec-wb-row-button:hover { background: #fbfdfc; }
.ec-wb .ec-wb-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ec-wb .ec-wb-row-main strong { font-size: 11px; font-weight: 620; color: var(--ec-ink); overflow-wrap: anywhere; }
/* The rail's run rows carry the primary label the employee reads; the generic row-main size
   (used by dense tables elsewhere) is too small there. */
.ec-wb .ec-wb-run-row .ec-wb-row-main strong { font-size: 12px; }
.ec-wb .ec-wb-run-row .ec-wb-row-main small { font-size: 10.5px; }
.ec-wb .ec-wb-row-actions { display: flex; align-items: center; gap: 8px; flex: none; flex-wrap: wrap; }
/* Works-list rows answer hover with their 详情 action; the state badge stays visible. Touch
   devices (no hover) and keyboard focus always keep the action reachable. */
@media (hover: hover) {
  .ec-wb .ec-wb-row-button .ec-wb-row-actions .ec-wb-button,
  .ec-wb .ec-wb-work-row .ec-wb-work-tail .ec-wb-button { opacity: 0; transition: opacity .15s ease; }
  .ec-wb .ec-wb-row-button:hover .ec-wb-row-actions .ec-wb-button,
  .ec-wb .ec-wb-work-row:hover .ec-wb-work-tail .ec-wb-button { opacity: 1; }
}
.ec-wb .ec-wb-row-button:focus-within .ec-wb-row-actions .ec-wb-button,
.ec-wb .ec-wb-work-row:focus-within .ec-wb-work-tail .ec-wb-button { opacity: 1; }
.ec-wb .ec-wb-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 2px; border-top: 1px solid var(--ec-line-soft); }
.ec-wb .ec-wb-row:first-of-type { border-top: 0; }
.ec-wb .ec-wb-rows { display: flex; flex-direction: column; }
/* Inline action form inside a delivery-package row (E1-3): wraps under the row head and keeps
   labels, inputs and confirm/cancel readable at rail width. */
.ec-wb .ec-wb-row:has(.ec-wb-action-form) { flex-wrap: wrap; }
.ec-wb .ec-wb-action-form { display: flex; flex-direction: column; gap: 6px; flex: 1 1 100%; padding: 8px 0 2px; }
.ec-wb .ec-wb-action-form label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; font-weight: 600; color: var(--ec-ink); }
.ec-wb .ec-wb-action-form input,
.ec-wb .ec-wb-action-form select { font: inherit; font-size: 11px; padding: 5px 8px; border: 1px solid var(--ec-line-strong); border-radius: var(--ec-radius-sm); background: var(--ec-white); color: var(--ec-ink); min-width: 0; }
/* Declarative result views and key-aligned diffs (E1-4/E1-5): compact tables and diff blocks
   readable at rail width. */
.ec-wb .ec-wb-inline-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; font-weight: 600; color: var(--ec-ink); padding-bottom: 6px; }
.ec-wb .ec-wb-inline-field select { font: inherit; font-size: 11px; padding: 5px 8px; border: 1px solid var(--ec-line-strong); border-radius: var(--ec-radius-sm); background: var(--ec-white); color: var(--ec-ink); min-width: 0; }
.ec-wb .ec-wb-diff-block, .ec-wb .ec-wb-view-block { display: flex; flex-direction: column; gap: 4px; padding: 6px 0; border-top: 1px solid var(--ec-line-soft); }
.ec-wb .ec-wb-diff-kind { font-size: 11px; font-weight: 620; color: var(--ec-ink); }
.ec-wb .ec-wb-finding-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.ec-wb .ec-wb-finding-table th { text-align: left; font-weight: 600; color: #5d7579; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--ec-line-soft); }
.ec-wb .ec-wb-finding-table td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--ec-line-soft); color: var(--ec-ink); overflow-wrap: anywhere; }
.ec-wb .ec-wb-metric-list { margin: 0; padding: 0 0 0 16px; font-size: 11px; color: var(--ec-ink); }
.ec-wb button.ec-wb-button {
  border: 1px solid var(--ec-line-strong); background: var(--ec-white); color: #47666c;
  font: inherit; font-size: 10px; font-weight: 600; line-height: 1.3; border-radius: var(--ec-radius-sm);
  padding: 0 11px; cursor: pointer; white-space: nowrap; min-height: 31px;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.ec-wb button.ec-wb-button:hover:not(:disabled) { background: #f4faf7; border-color: #95bcb7; color: var(--ec-primary); }
.ec-wb button.ec-wb-button:disabled { opacity: .5; cursor: not-allowed; }
.ec-wb button.ec-wb-primary { color: #fff; background: var(--ec-primary); border-color: var(--ec-primary); font-weight: 650; }
.ec-wb button.ec-wb-primary:hover:not(:disabled) { background: var(--ec-primary-hover); border-color: var(--ec-primary-hover); color: #fff; }
.ec-wb button.ec-wb-stop { border-color: #e5cdc6; color: var(--ec-danger); }
.ec-wb button.ec-wb-stop:hover:not(:disabled) { background: var(--ec-danger-weak); border-color: #d9b3a9; color: var(--ec-danger); }
.ec-wb a.ec-wb-link, .ec-wb .ec-wb-text-link { color: var(--ec-primary); text-decoration: none; font-size: 9px; font-weight: 600; }
.ec-wb a.ec-wb-link:hover { text-decoration: underline; }
.ec-wb button.ec-wb-text-link { border: 0; background: transparent; padding: 0; font: inherit; font-size: 9px; font-weight: 600; color: var(--ec-primary); cursor: pointer; }
.ec-wb button.ec-wb-text-link:hover { text-decoration: underline; }
.ec-wb .ec-wb-badge {
  display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; font-size: 9px; font-weight: 500;
  line-height: 1.4; padding: 3px 7px; border-radius: 4px; background: #eef3f4; color: #4f676d;
  font-variant-numeric: tabular-nums;
}
.ec-wb .ec-wb-badge[data-tone="ok"] { background: #e8f5ed; color: #217251; }
.ec-wb .ec-wb-badge[data-tone="ok"]::before, .ec-wb .ec-wb-badge[data-tone="warn"]::before, .ec-wb .ec-wb-badge[data-tone="error"]::before {
  content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentcolor; flex: none;
}
.ec-wb .ec-wb-badge[data-tone="warn"] { background: var(--ec-amber-weak); color: var(--ec-amber); }
.ec-wb .ec-wb-badge[data-tone="error"] { background: #fbeaea; color: var(--ec-danger); }
.ec-wb .ec-wb-badge[data-tone="muted"] { background: #f0f1f3; color: #5b6570; }
.ec-wb .ec-wb-empty { color: var(--ec-muted); font-size: 10px; padding: 12px 2px; line-height: 1.7; }
.ec-wb .ec-wb-status { min-height: 1px; color: var(--ec-muted); font-size: 10px; }
.ec-wb .ec-wb-error {
  border: 1px solid #e8c9cc; border-left: 3px solid var(--ec-danger); border-radius: var(--ec-radius-sm);
  padding: 9px 11px; display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap;
}
.ec-wb .ec-wb-error p { color: var(--ec-danger); font-size: 10px; overflow-wrap: anywhere; }
.ec-wb .ec-wb-error-text { color: var(--ec-danger); font-size: 10px; overflow-wrap: anywhere; }
.ec-wb .ec-wb-facts { display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 6px 12px; font-size: 10px; margin: 0; }
.ec-wb .ec-wb-facts dt { color: #5c7278; }
.ec-wb .ec-wb-facts dd { margin: 0; color: #40606a; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.ec-wb .ec-wb-digest { font-family: "Cascadia Mono", Consolas, monospace; font-size: 10px; }

/* ── Forms ──────────────────────────────────────────────────────────────── */
.ec-wb .ec-wb-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.ec-wb .ec-wb-field { display: flex; flex-direction: column; gap: 5px; font-size: 10px; color: var(--ec-secondary); min-width: 0; }
.ec-wb .ec-wb-field-label { color: #5c7278; font-size: 9px; font-weight: 600; }
.ec-wb .ec-wb-form-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 4px; }
.ec-wb .ec-wb-subform { border-top: 1px dashed var(--ec-line); margin-top: 4px; padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.ec-wb .ec-wb-input, .ec-wb .ec-wb-select, .ec-wb .ec-wb-textarea {
  font: inherit; font-size: 11px; color: #2c4a52; background: var(--ec-white);
  border: 1px solid #d8e3e5; border-radius: var(--ec-radius-sm); padding: 7px 9px; width: 100%; min-width: 0;
}
.ec-wb .ec-wb-textarea { resize: vertical; line-height: 1.6; }
.ec-wb .ec-wb-select {
  appearance: none; -webkit-appearance: none; min-height: 32px;
  background-image: var(--ec-chevron); background-repeat: no-repeat; background-position: right 9px center;
  padding-right: 26px; cursor: pointer;
}
.ec-wb .ec-wb-input::placeholder, .ec-wb .ec-wb-textarea::placeholder { color: #5c7278; }
.ec-wb .ec-wb-input:focus-visible, .ec-wb .ec-wb-select:focus-visible, .ec-wb .ec-wb-textarea:focus-visible,
.ec-wb button:focus-visible, .ec-wb a:focus-visible, .ec-wb summary:focus-visible, .ec-wb [tabindex]:focus-visible {
  outline: var(--dsw-focus-ring-width, 3px) solid var(--dsw-focus-ring-color, var(--ec-focus)); outline-offset: 2px;
}
.ec-wb .ec-wb-project-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 13px; }
.ec-wb .ec-wb-project-card {
  background: var(--ec-white); border: 1px solid var(--ec-line); border-radius: var(--ec-radius);
  padding: 16px; display: flex; flex-direction: column; gap: 6px; text-align: left; font: inherit; color: inherit; cursor: pointer;
  box-shadow: var(--ec-shadow-1); transition: border-color .15s ease, box-shadow .15s ease;
}
.ec-wb .ec-wb-project-card:hover { border-color: #accac4; box-shadow: var(--ec-shadow-3); }
.ec-wb .ec-wb-project-card.is-active { border-color: #95cdb5; box-shadow: 0 0 0 1px rgba(8, 123, 107, .13); }
.ec-wb .ec-wb-project-card strong { font-size: 13px; color: var(--ec-ink); }
.ec-wb .ec-wb-project-card small { color: var(--ec-muted); font-size: 9px; }
.ec-wb .ec-wb-project-code { align-self: flex-start; font-size: 9px; color: #536e77; background: #edf4f4; border-radius: 4px; padding: 2px 7px; }
.ec-wb .ec-wb-app-card { background: var(--ec-white); border: 1px solid var(--ec-line); border-radius: var(--ec-radius); padding: 15px; display: flex; align-items: center; gap: 12px; box-shadow: var(--ec-shadow-1); }
.ec-wb .ec-wb-app-card.is-revoked { opacity: .65; }
.ec-wb .ec-wb-app-icon { width: 34px; height: 34px; border-radius: 8px; background: var(--ec-green-weak); color: var(--ec-green); display: grid; place-items: center; flex: none; }
.ec-wb .ec-wb-run-button {
  border: 1px solid transparent; background: transparent; color: inherit; font: inherit; text-align: left;
  display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 8px;
  border-radius: var(--ec-radius-sm); cursor: pointer;
}
.ec-wb .ec-wb-run-button:hover { background: #fbfdfc; }
.ec-wb .ec-wb-run-button[aria-current="true"] { background: var(--ec-green-weak); border-color: #95cdb5; }
.ec-wb .ec-wb-run-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; border-top: 1px solid var(--ec-line); padding-top: 11px; }
.ec-wb .ec-wb-pager { display: flex; align-items: center; gap: 10px; padding-top: 10px; flex-wrap: wrap; }
.ec-wb .ec-wb-pager span { color: var(--ec-muted); font-size: 9px; font-variant-numeric: tabular-nums; }

/* ── Question card (native questions awaiting an answer) ────────────────── */
.ec-wb .ec-wb-interaction {
  background: #fffaf3; border: 1px solid var(--ec-amber-line); border-radius: var(--ec-radius);
  padding: 14px 15px; margin-top: 2px; display: flex; flex-direction: column; gap: 10px;
}
.ec-wb .ec-wb-question-title { display: flex; align-items: center; gap: 7px; color: #7c5a2a; }
.ec-wb .ec-wb-fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ec-wb .ec-wb-fieldset legend { font-size: 11px; font-weight: 680; color: #7c5a2a; padding: 0; display: flex; align-items: center; gap: 7px; }
.ec-wb .ec-wb-options { display: flex; flex-wrap: wrap; gap: 7px; }
.ec-wb .ec-wb-option { position: relative; display: inline-flex; }
.ec-wb .ec-wb-option input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.ec-wb .ec-wb-option span {
  font-size: 10px; padding: 6px 10px; border: 1px solid #e4d4b4; border-radius: var(--ec-radius-sm);
  background: var(--ec-white); color: #71583a; transition: border-color .15s ease, background-color .15s ease;
}
.ec-wb .ec-wb-option:hover span { border-color: #c8a765; background: #fffcf5; }
.ec-wb .ec-wb-option input:checked + span { border-color: #c8a765; background: #fdf3e0; color: #6b4f22; font-weight: 650; }
.ec-wb .ec-wb-option input:focus-visible + span { outline: 3px solid var(--ec-focus); outline-offset: 2px; }
.ec-wb .ec-wb-interaction .ec-wb-input { border-color: #e4d4b4; }
.ec-wb .ec-wb-interaction-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* ── Work detail ────────────────────────────────────────────────────────── */
.ec-wb .ec-wb-view { display: block; }
.ec-wb button.ec-wb-back-link {
  display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent;
  color: var(--ec-primary); font: inherit; font-size: 10px; font-weight: 600; padding: 0 0 6px; cursor: pointer;
}
.ec-wb .ec-wb-back-link:hover { text-decoration: underline; }
.ec-wb .ec-wb-file-dot {
  width: 26px; height: 26px; flex: none; border-radius: 5px; background: #eff4f3; border: 1px solid #e0e9ea;
  display: grid; place-items: center; color: #3c7a6e; font-size: 10px; font-weight: 700; text-transform: lowercase;
}
.ec-wb .ec-wb-dl { margin-left: auto; font-size: 9px; color: var(--ec-primary); flex: none; }
.ec-wb .ec-wb-run-dot { width: 6px; height: 6px; border-radius: 50%; background: #1a987a; flex: none; }
.ec-wb .ec-wb-run-dot[data-tone="warn"] { background: #cd8b30; }
.ec-wb .ec-wb-run-dot[data-tone="error"] { background: #c0574c; }
.ec-wb .ec-wb-run-dot[data-tone="muted"] { background: #a8b6b9; }

/* ── Work console: enterprise head + rail around the native conversation ── */
.ec-wb .ec-wb-main-session { display: flex; flex-direction: column; height: calc(100vh - var(--ec-topbar-h)); }
.ec-wb .ec-wb-console { display: flex; flex-direction: column; flex: 1; min-height: 0; animation: ec-wb-view-in .18s ease-out; }
@keyframes ec-wb-view-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.ec-wb .ec-wb-console-head {
  flex: none; background: var(--ec-white); border-bottom: 1px solid var(--ec-line);
  padding: 12px 24px 11px; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
}
.ec-wb .ec-wb-console-crumb { font-size: 10px; color: #5c7278; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ec-wb .ec-wb-console-title-row { display: flex; align-items: center; gap: 10px; margin-top: 4px; min-width: 0; }
.ec-wb .ec-wb-console-title { font-size: 16px; color: #153f49; font-weight: 680; letter-spacing: -.02em; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ec-wb .ec-wb-pill {
  font-size: 10px; padding: 4px 9px; border-radius: 4px; background: var(--ec-green-weak); color: #217251;
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; flex: none;
}
.ec-wb .ec-wb-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #18a37e; flex: none; }
.ec-wb .ec-wb-pill[data-tone="warn"] { background: var(--ec-amber-weak); color: var(--ec-amber); }
.ec-wb .ec-wb-pill[data-tone="warn"]::before { background: #d09034; }
.ec-wb .ec-wb-pill[data-tone="error"] { background: #fbeaea; color: var(--ec-danger); }
.ec-wb .ec-wb-pill[data-tone="error"]::before { background: #c0574c; }
.ec-wb .ec-wb-pill[data-tone="muted"] { background: #eef3f4; color: #4f676d; }
.ec-wb .ec-wb-pill[data-tone="muted"]::before { background: #a8b6b9; }
.ec-wb .ec-wb-console-actions { display: flex; align-items: center; gap: 8px; flex: none; flex-wrap: wrap; }
.ec-wb .ec-wb-console-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) clamp(288px, 21vw, 360px); gap: 16px; padding: 14px 24px 12px; overflow: hidden; }
.ec-wb .ec-wb-console-thread { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.ec-wb .ec-wb-console-rail { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 14px; padding-right: 2px; }
.ec-wb .ec-wb-fact-line { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 11.5px; padding: 7px 0; border-bottom: 1px solid #eff3f4; }
.ec-wb .ec-wb-fact-line:last-of-type { border-bottom: 0; }
.ec-wb .ec-wb-fact-line span:first-child { color: #5c7278; flex: none; }
.ec-wb .ec-wb-fact-line span:last-child { color: #40606a; text-align: right; overflow-wrap: anywhere; }
/* The upstream conversation factory owns its own scroll body and composer; the thread column
   only gives it a definite height, so the enterprise rail never grows the page scroll. */
.ec-wb .ec-wb-session-conversation { flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* Embedded conversation View tabs: the seat the native session header alone provides upstream.
   Rendered only when more than one View is registered (对话 / 轨迹). */
.ec-wb .ec-wb-session-view-tabs { flex: none; display: flex; align-items: center; gap: 2px; padding: 6px 12px 0; border-bottom: 1px solid var(--ec-line); background: var(--ec-white); }
.ec-wb .ec-wb-session-view-tab { border: 0; background: transparent; padding: 7px 12px 6px; font: inherit; font-size: 12.5px; color: #5c7278; border-bottom: 2px solid transparent; cursor: pointer; border-radius: 6px 6px 0 0; }
.ec-wb .ec-wb-session-view-tab:hover { color: var(--ec-primary); background: #f4faf7; }
.ec-wb .ec-wb-session-view-tab-active { color: var(--ec-primary); border-bottom-color: var(--ec-primary); font-weight: 640; }

/* Run transcript (selected run in the console center): the run's own scrollable history. */
.ec-wb .ec-wb-transcript { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.ec-wb .ec-wb-transcript-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 2px 4px 12px 2px; }
.ec-wb .ec-wb-transcript-item { background: var(--ec-white); border: 1px solid var(--ec-line); border-radius: 10px; padding: 10px 14px 12px; }
.ec-wb .ec-wb-transcript-item header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.ec-wb .ec-wb-transcript-item time { font-size: 10px; color: #7d9297; }
.ec-wb .ec-wb-transcript-kind { font-size: 10px; font-weight: 640; padding: 2px 8px; border-radius: 4px; background: #eef3f4; color: #4f676d; flex: none; }
.ec-wb .ec-wb-transcript-item.is-text .ec-wb-transcript-kind,
.ec-wb .ec-wb-transcript-item.is-final .ec-wb-transcript-kind { background: var(--ec-green-weak); color: #217251; }
.ec-wb .ec-wb-transcript-item.is-reasoning .ec-wb-transcript-kind { background: #f2effa; color: #6b5bb5; }
.ec-wb .ec-wb-transcript-item.is-tool-call .ec-wb-transcript-kind,
.ec-wb .ec-wb-transcript-item.is-tool-result .ec-wb-transcript-kind { background: #fdf3e4; color: #a86a1f; }
.ec-wb .ec-wb-transcript-item p { margin: 0; font-size: 12px; line-height: 1.65; color: #2b4c55; white-space: pre-wrap; overflow-wrap: anywhere; }
.ec-wb .ec-wb-transcript-item.is-reasoning p { color: #5c7278; font-size: 11.5px; }
.ec-wb .ec-wb-transcript-item.is-final { border-color: #bfe0d2; background: #f4faf7; }
.ec-wb .ec-wb-transcript-item pre { margin: 8px 0 0; font-size: 10.5px; line-height: 1.5; color: #4f676d; background: #f6f9fa; border: 1px solid var(--ec-line); border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; }

/* ── Responsive ─────────────────────────────────────────────────────────── */
@media (min-width: 1600px) {
  .ec-wb .ec-wb-home-grid { grid-template-columns: minmax(0, 1fr) 310px; }
  .ec-wb .ec-wb-detail { grid-template-columns: minmax(0, 1fr) 330px; }
  .ec-wb .ec-wb-console-body { grid-template-columns: minmax(0, 1fr) 340px; }
}
@media (max-width: 1200px) {
  .ec-wb { --ec-nav-w: 184px; }
  .ec-wb .ec-wb-page { padding: 20px 18px 12px; }
  .ec-wb .ec-wb-home-grid { grid-template-columns: minmax(0, 1fr) 245px; }
  .ec-wb .ec-wb-detail { grid-template-columns: minmax(0, 1fr) 260px; }
  .ec-wb .ec-wb-launch { grid-template-columns: minmax(0, 1fr) 230px; }
  .ec-wb .ec-wb-quick { margin-left: 0; }
  .ec-wb .ec-wb-launch-controls { padding-left: 12px; padding-right: 12px; }
  .ec-wb .ec-wb-table-head, .ec-wb .ec-wb-work-row {
    grid-template-columns: minmax(140px, 1.4fr) minmax(84px, .85fr) minmax(66px, .65fr) minmax(80px, .75fr) 54px;
    gap: 7px; padding: 0 12px;
  }
  .ec-wb .ec-wb-console-body { grid-template-columns: minmax(0, 1fr) 232px; gap: 10px; padding: 11px 16px 10px; }
  .ec-wb .ec-wb-console-head { padding: 11px 16px; }
}
@media (max-width: 980px) {
  .ec-wb .ec-wb-shell { grid-template-columns: minmax(0, 1fr); }
  .ec-wb .ec-wb-nav {
    position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center;
    border-right: 0; border-bottom: 1px solid var(--ec-line); padding: 10px 14px; gap: 6px; overflow: visible;
  }
  .ec-wb .ec-wb-nav-brand, .ec-wb .ec-wb-nav-caption, .ec-wb .ec-wb-recent, .ec-wb .ec-wb-nav-empty { display: none; }
  .ec-wb button.ec-wb-nav-bottom { display: none; }
  .ec-wb .ec-wb-nav-items { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 0; }
  .ec-wb button.ec-wb-nav-item { height: 32px; }
  .ec-wb .ec-wb-nav-count { margin-left: 6px; }
  .ec-wb .ec-wb-main-session { height: auto; min-height: calc(100vh - var(--ec-topbar-h) - 54px); }
  .ec-wb .ec-wb-console-body { display: flex; flex-direction: column; overflow: visible; padding: 12px 15px; }
  .ec-wb .ec-wb-console-thread { min-height: 62vh; }
  .ec-wb .ec-wb-console-rail { overflow: visible; }
  .ec-wb .ec-wb-home-grid, .ec-wb .ec-wb-detail { grid-template-columns: minmax(0, 1fr); }
  .ec-wb .ec-wb-page-home { min-height: 0; }
  .ec-wb .ec-wb-page-home .ec-wb-queue, .ec-wb .ec-wb-page-home .ec-wb-rail > .ec-wb-card:last-child { flex: none; }
  .ec-wb .ec-wb-topbar { padding: 0 16px; }
  .ec-wb .ec-wb-hero { min-height: 0; align-items: flex-start; }
  .ec-wb .ec-wb-row-button { align-items: flex-start; flex-direction: column; }
}
@media (max-width: 720px) {
  .ec-wb h1 { font-size: 20px; }
  .ec-wb .ec-wb-top-divider, .ec-wb .ec-wb-breadcrumb, .ec-wb .ec-wb-chip { display: none; }
  .ec-wb .ec-wb-top-actions { gap: 7px; }
  .ec-wb .ec-wb-conn { font-size: 0; gap: 0; }
  .ec-wb .ec-wb-page { padding: 18px 14px 12px; }
  .ec-wb .ec-wb-hero { display: block; }
  .ec-wb .ec-wb-hero-actions { margin-top: 11px; }
  .ec-wb .ec-wb-launch { display: flex; flex-direction: column; }
  .ec-wb .ec-wb-launch-controls { border-left: 0; border-top: 1px solid #e8eeee; }
  .ec-wb .ec-wb-project-grid { grid-template-columns: minmax(0, 1fr); }
  .ec-wb .ec-wb-table-head { display: none; }
  .ec-wb .ec-wb-work-row { grid-template-columns: minmax(0, 1fr) auto 54px; gap: 6px; padding: 8px 12px; }
  .ec-wb .ec-wb-work-row .ec-wb-app-cell { display: none; }
  .ec-wb .ec-wb-work-row .ec-wb-updated { grid-column: 2; grid-row: 1; font-size: 8px; }
  .ec-wb .ec-wb-work-row .ec-wb-state { grid-column: 2; grid-row: 2; }
  .ec-wb .ec-wb-work-row .ec-wb-work-tail { grid-column: 3; grid-row: 1 / 3; }
  .ec-wb .ec-wb-work-row .ec-wb-work-tail .ec-wb-button { opacity: 1; }
  .ec-wb .ec-wb-queue-head { padding: 13px 12px 10px; }
  .ec-wb .ec-wb-queue-tools { width: 100%; }
  .ec-wb .ec-wb-search { flex: 1 1 100%; min-width: 0; }
  .ec-wb .ec-wb-select.ec-wb-queue-select { flex: 1 1 0; min-width: 0; }
  .ec-wb .ec-wb-queue-empty, .ec-wb .ec-wb-queue-note { padding-left: 12px; padding-right: 12px; }
  .ec-wb .ec-wb-console-head { padding: 10px 14px; flex-wrap: wrap; }
  .ec-wb .ec-wb-console-head > div:first-child { flex: 1 1 100%; min-width: 0; }
  .ec-wb .ec-wb-console-actions { flex-wrap: wrap; gap: 7px; width: 100%; min-width: 0; }
  .ec-wb .ec-wb-console-actions > .ec-wb-button { flex: 1 1 auto; min-width: 0; }
  .ec-wb .ec-wb-mode-banner { flex-direction: column; align-items: flex-start; gap: 4px; }
  .ec-wb .ec-wb-bind-steps li { font-size: 11px; }
  .ec-wb .ec-wb-session-tools { width: 100%; }
  .ec-wb .ec-wb-session-tools .ec-wb-search { flex: 1 1 100%; }
  .ec-wb .ec-wb-session-tools .ec-wb-select { flex: 1 1 0; min-width: 0; }
  .ec-wb .ec-wb-wizard-actions > .ec-wb-button { flex: 1 1 auto; }
  .ec-wb .ec-wb-freshness { flex-wrap: wrap; }
}
@media (max-height: 740px) and (min-width: 981px) {
  .ec-wb .ec-wb-page { padding-top: 15px; }
  .ec-wb .ec-wb-hero { min-height: 67px; }
  .ec-wb .ec-wb-launch-intro { padding-top: 14px; padding-bottom: 12px; }
  .ec-wb .ec-wb-work-row { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .ec-wb *, .ec-wb *::before, .ec-wb *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
/* Interaction affordances added with the 2026-11-17 experience pass: an explicit live-chat /
   run-record switch, a binding-status strip, a work wizard and freshness lines. All colours come
   from the same tokens, so the dark block below re-inks them without duplicate rules. */
.ec-wb .ec-wb-freshness { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--ec-muted); }
.ec-wb .ec-wb-freshness button { border: 0; background: none; color: var(--ec-primary); font: inherit; cursor: pointer; text-decoration: underline; }
.ec-wb .ec-wb-mode-banner { display: flex; justify-content: space-between; gap: 12px; align-items: center; border: 1px solid var(--ec-amber-line); background: var(--ec-amber-weak); color: var(--ec-amber); border-radius: var(--ec-radius-sm); padding: 6px 10px; font-size: 12px; }
.ec-wb .ec-wb-mode-banner button { border: 0; background: none; color: inherit; text-decoration: underline; cursor: pointer; font: inherit; }
.ec-wb .ec-wb-console-center { display: flex; flex-direction: column; gap: 8px; min-width: 0; min-height: 0; }
.ec-wb .ec-wb-console-center > .ec-wb-console-thread { flex: 1; min-height: 0; }
/* A run's transcript in the rail keeps a bounded window; the rail itself scrolls. The card is
   inked like a reading surface so it reads as a record, not one more list row. */
.ec-wb .ec-wb-rail-record { background: #fbfdfc; border-color: #cfe2db; box-shadow: var(--ec-shadow-1), inset 3px 0 0 var(--ec-primary); gap: 8px; }
.ec-wb .ec-wb-rail-record .ec-wb-transcript { max-height: 340px; }
.ec-wb .ec-wb-rail-record .ec-wb-transcript-item { padding: 8px 10px 9px; }
.ec-wb .ec-wb-rail-record .ec-wb-transcript-item p { font-size: 12px; line-height: 1.6; }
.ec-wb .ec-wb-bind-steps { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 0 0 8px; padding: 0; }
.ec-wb .ec-wb-bind-steps li { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ec-muted); border: 1px solid var(--ec-line); border-radius: 999px; padding: 2px 9px; }
.ec-wb .ec-wb-bind-steps li[data-state="done"] { color: var(--ec-primary); border-color: var(--ec-line-strong); }
.ec-wb .ec-wb-bind-steps li[data-state="active"] { color: var(--ec-ink); border-color: var(--ec-primary); }
.ec-wb .ec-wb-bind-steps li[data-state="blocked"] { color: var(--ec-danger); border-color: var(--ec-danger); }
.ec-wb .ec-wb-wizard { display: flex; flex-direction: column; gap: 12px; }
.ec-wb .ec-wb-stepbar { display: flex; gap: 6px; flex-wrap: wrap; list-style: none; margin: 0; padding: 0; font-size: 12px; }
.ec-wb .ec-wb-stepbar li { padding: 3px 10px; border-radius: 999px; border: 1px solid var(--ec-line); color: var(--ec-muted); }
.ec-wb .ec-wb-stepbar li[aria-current="step"] { border-color: var(--ec-primary); color: var(--ec-primary); }
.ec-wb .ec-wb-stepbar li[data-done="true"] { color: var(--ec-secondary); }
.ec-wb .ec-wb-step-button { appearance: none; background: none; border: 0; padding: 0; margin: 0; font: inherit; color: inherit; cursor: pointer; }
.ec-wb .ec-wb-step-button:disabled { cursor: default; opacity: .5; }
.ec-wb .ec-wb-wizard-actions { display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap; }
.ec-wb .ec-wb-session-tools { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; align-items: center; }
.ec-wb .ec-wb-session-tools .ec-wb-select { width: auto; min-width: 150px; flex: 0 1 auto; }
.ec-wb .ec-wb-rerun-form { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; padding-top: 12px; border-top: 1px solid var(--ec-line); }
.ec-wb .ec-wb-rerun-form .ec-wb-form-actions { align-items: center; }

/* Global command palette (Ctrl/⌘+K) added with the E4-6 pass. Token-based like the block
   above, so the dark theme re-inks it automatically; the only literal is the backdrop veil. */
.ec-wb .ec-wb-palette-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); display: flex; align-items: flex-start; justify-content: center; padding: 12vh 16px 16px; z-index: 60; }
.ec-wb .ec-wb-palette { width: 100%; max-width: 560px; background: var(--ec-white); border: 1px solid var(--ec-line-strong); border-radius: var(--ec-radius-sm); box-shadow: var(--ec-shadow-2); display: flex; flex-direction: column; gap: 8px; padding: 12px; max-height: 70vh; }
.ec-wb .ec-wb-palette-input { width: 100%; }
.ec-wb .ec-wb-palette-note { margin: 0; font-size: 12px; }
.ec-wb .ec-wb-palette-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; border-top: 1px solid var(--ec-line); }
.ec-wb .ec-wb-palette-hit { display: block; width: 100%; text-align: left; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; padding: 8px 10px; border-radius: var(--ec-radius-sm); }
.ec-wb .ec-wb-palette-hit:hover { background: var(--ec-soft); }
.ec-wb .ec-wb-palette-hit.is-active { background: var(--ec-soft); outline: 2px solid var(--ec-focus); outline-offset: -2px; }
.ec-wb .ec-wb-palette-hit:focus-visible { outline: 2px solid var(--ec-focus); outline-offset: -2px; }
.ec-wb .ec-wb-palette-hit-main { display: flex; flex-direction: column; gap: 2px; font-size: 13px; color: var(--ec-ink); }
.ec-wb .ec-wb-palette-hit-main small { font-size: 11px; color: var(--ec-muted); }
/* E4-4 keyboard path: the skip link is hidden until it receives focus. */
.ec-wb .ec-wb-skip { position: absolute; left: 8px; top: -48px; z-index: 70; background: var(--ec-white); color: var(--ec-ink); border: 1px solid var(--ec-line-strong); border-radius: var(--ec-radius-sm); padding: 6px 12px; font: inherit; font-size: 13px; text-decoration: none; transition: top .15s ease; }
.ec-wb .ec-wb-skip:focus-visible { top: 8px; outline: 2px solid var(--ec-focus); outline-offset: -2px; }

@media (prefers-color-scheme: dark) {
  .ec-wb {
    --ec-ink: #e4eaec;
    --ec-deep: #d6e4e6;
    --ec-muted: #93a5ab;
    --ec-secondary: #b6c4c8;
    --ec-primary: #4fbfa4;
    --ec-primary-hover: #6fd2b8;
    --ec-green: #4fbfa4;
    --ec-green-weak: #16302b;
    --ec-paper: #12171a;
    --ec-white: #1a2024;
    --ec-line: #2a3237;
    --ec-line-strong: #38424a;
    --ec-line-soft: #242c31;
    --ec-soft: #1f262a;
    --ec-amber: #e0b070;
    --ec-amber-weak: #33280f;
    --ec-amber-line: #4a3a1c;
    --ec-danger: #e59182;
    --ec-danger-weak: #2e1f1c;
    --ec-focus: #6fd2b8;
    --ec-topbar-bg: #1a2024;
    --ec-shadow-1: 0 2px 5px rgba(0, 0, 0, .28);
    --ec-shadow-2: 0 2px 4px rgba(0, 0, 0, .35);
    --ec-shadow-3: 0 8px 24px rgba(0, 0, 0, .40);
    --ec-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23b6c4c8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    color-scheme: dark;
    scrollbar-color: #38424a transparent;
  }
  .ec-wb h1, .ec-wb h2, .ec-wb h3 { color: var(--ec-ink); }
  .ec-wb .ec-wb-wordmark, .ec-wb .ec-wb-nav-brand strong { color: var(--ec-ink); }
  .ec-wb .ec-wb-breadcrumb span:last-child { color: var(--ec-secondary); }
  .ec-wb .ec-wb-nav { background: #171d21; }
  .ec-wb .ec-wb-nav-mark { background: #0d3b45; }
  .ec-wb button.ec-wb-nav-new, .ec-wb button.ec-wb-launch-go { color: #08221d; }
  .ec-wb button.ec-wb-nav-item[aria-current="page"] { color: var(--ec-primary); }
  .ec-wb button.ec-wb-recent-item strong, .ec-wb .ec-wb-nav-bottom strong { color: var(--ec-secondary); }
  .ec-wb button.ec-wb-recent-item:hover, .ec-wb button.ec-wb-nav-item:hover { background: #202a2e; }
  .ec-wb button.ec-wb-recent-item.is-active { background: #1d2b28; }
  .ec-wb button.ec-wb-recent-item.is-active strong { color: var(--ec-primary); }
  .ec-wb .ec-wb-launch-controls, .ec-wb .ec-wb-table-head, .ec-wb .ec-wb-queue-foot { background: #1e2529; border-color: var(--ec-line); }
  .ec-wb .ec-wb-work-row { background: var(--ec-white); }
  .ec-wb .ec-wb-work-row:hover, .ec-wb .ec-wb-row-button:hover, .ec-wb .ec-wb-run-button:hover { background: #202a2e; }
  .ec-wb .ec-wb-work-icon, .ec-wb .ec-wb-monogram, .ec-wb .ec-wb-file-dot { background: #1f2a28; border-color: var(--ec-line); color: var(--ec-primary); }
  .ec-wb .ec-wb-orb, .ec-wb .ec-wb-empty-icon, .ec-wb .ec-wb-nav-bottom-mark { background: #1d2b28; color: var(--ec-primary); }
  .ec-wb .ec-wb-work-name strong, .ec-wb .ec-wb-launch-intro h2, .ec-wb .ec-wb-console-title { color: var(--ec-ink); }
  .ec-wb .ec-wb-input, .ec-wb .ec-wb-select, .ec-wb .ec-wb-textarea { color: var(--ec-ink); border-color: var(--ec-line-strong); }
  .ec-wb .ec-wb-interaction { background: #262015; }
  .ec-wb .ec-wb-fieldset legend { color: var(--ec-amber); }
  .ec-wb .ec-wb-option span { background: #1f1b13; border-color: #4a3a1c; color: var(--ec-amber); }
  .ec-wb .ec-wb-option input:checked + span { background: #33280f; }
  .ec-wb .ec-wb-tick { background: var(--ec-white); border-color: var(--ec-line-strong); }
  .ec-wb .ec-wb-tick[data-tone="ok"] { background: #16302b; border-color: #235045; color: var(--ec-primary); }
  .ec-wb .ec-wb-tick[data-tone="pending"] { background: #33280f; border-color: #4a3a1c; color: var(--ec-amber); }
  .ec-wb .ec-wb-fact-line { border-color: var(--ec-line-soft); }
  .ec-wb .ec-wb-fact-line span:last-child, .ec-wb .ec-wb-facts dd { color: var(--ec-secondary); }
  /* The light palette hard-codes a few ink/border values for exact draft fidelity; each one is
     re-mapped here so no pairing falls below readable contrast on the dark canvas. */
  .ec-wb .ec-wb-card { border-color: var(--ec-line); }
  .ec-wb .ec-wb-nav-bottom { border-top-color: var(--ec-line); }
  .ec-wb .ec-wb-orb::after { box-shadow: 0 0 0 3px #1d3b34; }
  .ec-wb .ec-wb-conn { color: var(--ec-primary); }
  .ec-wb .ec-wb-conn::before { background: var(--ec-primary); box-shadow: 0 0 0 3px #16302b; }
  .ec-wb .ec-wb-conn.is-down { color: var(--ec-amber); }
  .ec-wb .ec-wb-conn.is-down::before { background: var(--ec-amber); box-shadow: 0 0 0 3px #33280f; }
  .ec-wb .ec-wb-breadcrumb, .ec-wb .ec-wb-eyebrow, .ec-wb .ec-wb-chip, .ec-wb .ec-wb-hero p,
  .ec-wb .ec-wb-launch-label, .ec-wb .ec-wb-launch-desc, .ec-wb .ec-wb-app-cell, .ec-wb .ec-wb-state,
  .ec-wb .ec-wb-checkline, .ec-wb .ec-wb-pending-empty p, .ec-wb .ec-wb-model-row,
  .ec-wb .ec-wb-table-head, .ec-wb .ec-wb-queue-foot, .ec-wb .ec-wb-queue-tools .ec-wb-count,
  .ec-wb .ec-wb-work-name small, .ec-wb .ec-wb-updated, .ec-wb .ec-wb-project-row small,
  .ec-wb .ec-wb-run-row small, .ec-wb .ec-wb-artifact-row small, .ec-wb .ec-wb-recent-item small,
  .ec-wb .ec-wb-nav-caption, .ec-wb .ec-wb-nav-empty, .ec-wb .ec-wb-nav-bottom span.ec-wb-nav-bottom-sub,
  .ec-wb .ec-wb-console-crumb, .ec-wb .ec-wb-fact-line span:first-child, .ec-wb .ec-wb-facts dt,
  .ec-wb .ec-wb-canvas-foot, .ec-wb .ec-wb-pending-empty small { color: var(--ec-muted); }
  .ec-wb .ec-wb-model-row strong, .ec-wb .ec-wb-project-row strong, .ec-wb .ec-wb-run-row strong,
  .ec-wb .ec-wb-artifact-row strong { color: var(--ec-ink); }
  .ec-wb button.ec-wb-button { color: var(--ec-secondary); }
  /* Filled buttons must be re-inked after the generic outline rule above: equal specificity means
     source order decides, and a light label on the jade fill would be unreadable. */
  .ec-wb button.ec-wb-primary { color: #08221d; }
  .ec-wb button.ec-wb-button:hover:not(:disabled) { background: #202a2e; border-color: #3d5a55; color: var(--ec-primary); }
  .ec-wb button.ec-wb-primary:hover:not(:disabled) { background: var(--ec-primary-hover); border-color: var(--ec-primary-hover); color: #08221d; }
  .ec-wb button.ec-wb-stop { border-color: #5a3a34; color: var(--ec-danger); }
  .ec-wb button.ec-wb-stop:hover:not(:disabled) { background: var(--ec-danger-weak); border-color: #6d463e; color: var(--ec-danger); }
  .ec-wb button.ec-wb-quick-target { background: #1f262a; border-color: var(--ec-line); color: var(--ec-secondary); }
  .ec-wb button.ec-wb-quick-target:hover { background: #233029; border-color: #3d5a55; }
  .ec-wb button.ec-wb-quick-target b { color: var(--ec-primary); }
  .ec-wb button.ec-wb-foot-link, .ec-wb button.ec-wb-project-link, .ec-wb button.ec-wb-readiness-link { color: var(--ec-primary); }
  .ec-wb .ec-wb-badge { background: #232b30; color: var(--ec-secondary); }
  .ec-wb .ec-wb-badge[data-tone="ok"] { background: #16302b; color: #6fd2b8; }
  .ec-wb .ec-wb-badge[data-tone="warn"] { background: #33280f; color: var(--ec-amber); }
  .ec-wb .ec-wb-badge[data-tone="error"] { background: #33201d; color: var(--ec-danger); }
  .ec-wb .ec-wb-badge[data-tone="muted"] { background: #262b31; color: #9aa4b2; }
  .ec-wb .ec-wb-state-tag { background: #33280f; color: var(--ec-amber); }
  .ec-wb .ec-wb-state-tag::before { background: var(--ec-amber); }
  .ec-wb .ec-wb-state-tag[data-tone="ok"] { background: #16302b; color: #6fd2b8; }
  .ec-wb .ec-wb-state-tag[data-tone="ok"]::before { background: #4fbfa4; }
  .ec-wb .ec-wb-pill { background: #16302b; color: #6fd2b8; }
  .ec-wb .ec-wb-pill::before { background: #4fbfa4; }
  .ec-wb .ec-wb-pill[data-tone="warn"] { background: #33280f; color: var(--ec-amber); }
  .ec-wb .ec-wb-pill[data-tone="warn"]::before { background: var(--ec-amber); }
  .ec-wb .ec-wb-pill[data-tone="error"] { background: #33201d; color: var(--ec-danger); }
  .ec-wb .ec-wb-pill[data-tone="error"]::before { background: var(--ec-danger); }
  .ec-wb .ec-wb-pill[data-tone="muted"] { background: #232b30; color: var(--ec-secondary); }
  .ec-wb .ec-wb-pill[data-tone="muted"]::before { background: #7d8b90; }
  .ec-wb .ec-wb-project-code { background: #232b30; color: var(--ec-secondary); }
  .ec-wb .ec-wb-project-card.is-active, .ec-wb .ec-wb-run-button[aria-current="true"] { border-color: #3d5a55; }
  .ec-wb .ec-wb-error { border-color: #5a3a34; }
  .ec-wb .ec-wb-question-title { color: var(--ec-amber); }
  .ec-wb .ec-wb-interaction .ec-wb-input { border-color: #4a3a1c; }
  .ec-wb .ec-wb-search-glyph, .ec-wb button.ec-wb-search-clear { color: var(--ec-muted); }
  .ec-wb button.ec-wb-search-clear:hover { background: #202a2e; color: var(--ec-primary); }
  .ec-wb .ec-wb-canvas-foot .ec-wb-sep { border-color: var(--ec-line-strong); }
  .ec-wb button.ec-wb-recent-item small, .ec-wb .ec-wb-nav-brand small, .ec-wb .ec-wb-field-label,
  .ec-wb .ec-wb-nav-count, .ec-wb button.ec-wb-nav-bottom, .ec-wb .ec-wb-tick,
  .ec-wb .ec-wb-input::placeholder, .ec-wb .ec-wb-textarea::placeholder { color: var(--ec-muted); }
}
`