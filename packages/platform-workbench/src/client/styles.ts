/** Browser styles for the enterprise workbench shell. Every rule is scoped under `.ec-wb`, so the
 *  native conversation, sidebar and composer keep their own styling; disabling the plugin removes
 *  the whole stylesheet.
 *
 *  The 2026-11-22 RBQM Emerald research work desk (方案 B) re-inks the shell on the emerald
 *  palette: a dark teal global rail (`#053a4c`) beside the deep teal work-index panel
 *  (`#064f67`), a near-white canvas (`#f4f7f7`) and emerald actions (`#007b82`). Amber stays
 *  reserved for states that need a human
 *  act. Dark mode derives the same semantic surfaces; every text/background pair of the tested
 *  tokens clears 4.5:1 in BOTH themes (the E4-4 contract test computes them positionally — each
 *  tested token is declared exactly twice: light in the base block, dark in the block below).
 *
 *  The 2026-11-21 single-sidebar revision keeps the brand and the one global navigation in the
 *  `sidebar` slot occupant (`sidebar-nav.tsx`); the enterprise sidebar is now the dark rail of the
 *  desk. Desk layout rules live in `desk-styles.ts` and are appended to the same stylesheet.
 */
import { DESK_CSS } from './desk-styles.js'

const BASE_CSS = `
.ec-wb {
  --ec-ink: #153847;
  --ec-deep: #053a4c;
  --ec-muted: #536d78;
  --ec-secondary: #24485a;
  --ec-primary: #007b82;
  --ec-primary-hover: #056a72;
  --ec-green: #216544;
  --ec-green-weak: #eef8f3;
  --ec-paper: #f4f7f7;
  --ec-white: #ffffff;
  --ec-line: #cddcdc;
  --ec-line-strong: #769ba1;
  --ec-line-soft: #e3edec;
  --ec-soft: #eaf1f2;
  --ec-amber: #795212;
  --ec-amber-weak: #fff8e9;
  --ec-amber-line: #e3d0a0;
  --ec-danger: #c23b45;
  --ec-danger-weak: #fff0f1;
  --ec-focus: #056a72;
  --ec-radius: 7px;
  --ec-radius-sm: 5px;
  --ec-font: "Aptos", "Segoe UI Variable Text", "Microsoft YaHei UI", "PingFang SC", "Segoe UI", sans-serif;
  --ec-topbar-h: 56px;
  --ec-topbar-bg: #ffffff;
  --ec-shadow-1: 0 2px 5px rgba(14, 42, 48, .05);
  --ec-shadow-2: 0 2px 4px rgba(10, 90, 98, .16);
  --ec-shadow-3: 0 8px 24px rgba(14, 42, 48, .14);
  /* 全局轨（企业导航）与工作索引面板：两个主题下都是深青绿双层（RBQM Emerald 开发说明 §2.1，
     轨实底 #053A4C、索引实底 #064F67 叠一次纵向渐变），文本分两档：当前项标题白，其余 #CFE0E6。 */
  --ec-rail-bg: #053a4c;
  --ec-rail-ink: #ffffff;
  --ec-rail-text: #cfe0e6;
  --ec-rail-muted: #cfe0e6;
  --ec-rail-line: #497381;
  --ec-rail-hover: #0d5c70;
  --ec-rail-active: #13676c;
  --ec-rail-accent: #57c487;
  /* 深轨/深面板上的警示琥珀两个主题共用：暗色 token 在深轨上对比不足。 */
  --ec-rail-warn: #d9a44c;
  --ec-index-bg: #064f67;
  --ec-index-ink: #ffffff;
  --ec-index-text: #cfe0e6;
  --ec-index-muted: #cfe0e6;
  --ec-index-line: #497381;
  --ec-index-hover: #0d5c70;
  --ec-index-active: #13676c;
  --ec-index-accent: #57c487;
  /* RBQM 移植规则（开发说明 §2）：平面色与渐变背景图分离——渐变只在索引列表面与单个主
     动作按钮上各画一次，弹层/下拉留实底；深区输入用实底 #073F54，边界另测 3:1（#7FA3AD）。 */
  --ec-index-surface-image: linear-gradient(180deg, #064f67 0%, #073f54 100%);
  --ec-enter-image: linear-gradient(135deg, #007b82 0%, #064f67 100%);
  --ec-enter-hover-bg: #056a72;
  --ec-enter-pressed-bg: #064f67;
  --ec-input-deep-bg: #073f54;
  --ec-input-deep-border: #7fa3ad;
  --ec-focus-deep: #a8e0e2;
  /* 13 号稿的工作资料栏：品牌浅青表面（暗色在暗色块重定）。 */
  --ec-console-rail-bg: #f2fafa;
  --ec-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23536d78' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  /* Host-token compatibility: the enterprise palette is authoritative here, while these aliases
     keep the page legible if a host only publishes the standard --dsw-* tokens. */
  --ec-host-label-primary: var(--dsw-alias-label-primary, #153847);
  --ec-host-label-tertiary: var(--dsw-alias-label-tertiary, var(--ec-muted));
  --ec-host-border: var(--dsw-alias-border-l2, #cddcdc);
  --ec-host-surface: var(--dsw-alias-bg-layer-1, #ffffff);
  --ec-host-business: var(--dsw-alias-state-business-primary, #007b82);
  --ec-host-error: var(--dsw-alias-state-error-primary, #c23b45);
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
.ec-wb { scrollbar-width: thin; scrollbar-color: #c2d1d4 transparent; }
.ec-wb ::-webkit-scrollbar { width: 9px; height: 9px; }
.ec-wb ::-webkit-scrollbar-thumb { background: #c2d1d4; border: 2px solid transparent; border-radius: 5px; background-clip: content-box; }
.ec-wb ::-webkit-scrollbar-track { background: transparent; }
.ec-wb[data-density="compact"] { --ec-gap: 10px; --ec-pad: 12px; font-size: 12px; }
/* Expert diagnostics: raw infrastructure facts (paths, session ids, digests) stay hidden from the
   business-facing view until the employee turns on expert mode. A display preference, not a gate. */
.ec-wb:not([data-expert="on"]) .ec-wb-expert-only { display: none; }
.ec-wb h1 { margin: 0; font-size: 24px; line-height: 1.2; letter-spacing: -.035em; font-weight: 700; color: var(--ec-ink); }
.ec-wb h2 { margin: 0; font-size: 13px; line-height: 1.4; font-weight: 650; color: var(--ec-ink); }
.ec-wb h3 { margin: 0; font-size: 12px; line-height: 1.4; font-weight: 650; color: var(--ec-ink); }
.ec-wb h4 { margin: 0; font-size: 12px; line-height: 1.4; font-weight: 650; }
.ec-wb p { margin: 0; }
.ec-wb .ec-wb-muted { color: var(--ec-muted); font-size: 12px; line-height: 1.6; }
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
/* 单侧栏架构：品牌标识只在左栏排一次；页眉从这里开始就是当前页面或工作名。 */
.ec-wb .ec-wb-breadcrumb { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ec-muted); min-width: 0; }
.ec-wb .ec-wb-breadcrumb span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ec-secondary); font-weight: 600; }
.ec-wb .ec-wb-top-actions { margin-left: auto; display: flex; align-items: center; gap: 10px; flex: none; }
.ec-wb .ec-wb-conn { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--ec-green); white-space: nowrap; }
.ec-wb .ec-wb-conn::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ec-green); box-shadow: 0 0 0 3px var(--ec-green-weak); flex: none; }
.ec-wb .ec-wb-conn.is-down { color: var(--ec-amber); }
.ec-wb .ec-wb-conn.is-down::before { background: var(--ec-amber); box-shadow: 0 0 0 3px var(--ec-amber-weak); }
.ec-wb button.ec-wb-icon-btn {
  width: 30px; height: 30px; flex: none; display: grid; place-items: center; padding: 0;
  border: 1px solid var(--ec-line); border-radius: 6px; background: var(--ec-white); color: var(--ec-secondary);
  cursor: pointer; transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.ec-wb button.ec-wb-icon-btn:hover { background: var(--ec-soft); border-color: var(--ec-line-strong); }
.ec-wb button.ec-wb-icon-btn[aria-pressed="true"] { background: var(--ec-green-weak); border-color: var(--ec-line-strong); color: var(--ec-primary); }

/* ── Shell and the enterprise sidebar (单侧栏架构 2026-11-21; 方案 B 深靛轨) ────
   左栏导航由 sidebar slot 的企业导航承担，渲染在宿主 ui-layout 的列内（展开 264–420px、
   折叠 56px 图标栏、窄屏抽屉的几何与遮罩都由宿主提供）；主区只有一列内容，不再有第二套导航。
   企业标识只在左栏排一次，页眉从当前页面或工作名开始。轨面颜色两个主题一致（--ec-rail-*）。 */
.ec-wb .ec-wb-shell { display: grid; grid-template-columns: minmax(0, 1fr); min-height: calc(100vh - var(--ec-topbar-h)); align-items: stretch; }
.ec-wb.ec-wb-side { height: 100%; display: flex; flex-direction: column; gap: 3px; padding: 14px 12px 12px; background: var(--ec-rail-bg); border-right: 1px solid var(--ec-rail-line); min-width: 0; overflow: hidden; }
.ec-wb .ec-wb-side-brand { display: flex; align-items: center; gap: 9px; padding: 2px 4px 15px; color: var(--ec-rail-ink); }
.ec-wb .ec-wb-side-wordmark { font-size: 12px; letter-spacing: .11em; font-weight: 800; color: var(--ec-rail-ink); white-space: nowrap; }
.ec-wb button.ec-wb-side-toggle { margin-left: auto; width: 28px; height: 28px; flex: none; display: grid; place-items: center; padding: 0; border: 1px solid var(--ec-rail-line); border-radius: 6px; background: transparent; color: var(--ec-rail-text); cursor: pointer; transition: background-color .15s ease; }
.ec-wb button.ec-wb-side-toggle:hover { background: var(--ec-rail-hover); }
.ec-wb button.ec-wb-side-new { display: flex; align-items: center; gap: 7px; height: 36px; flex: none; border: 0; border-radius: var(--ec-radius-sm); background: var(--ec-primary); color: #fff; font: inherit; font-size: 13px; font-weight: 650; text-align: left; padding: 0 12px; cursor: pointer; box-shadow: var(--ec-shadow-2); transition: background-color .15s ease; }
.ec-wb button.ec-wb-side-new:hover { background: var(--ec-primary-hover); }
.ec-wb .ec-wb-side-new-plus { font-size: 15px; line-height: 1; }
.ec-wb .ec-wb-side-items { display: grid; gap: 3px; margin-top: 15px; flex: 1; align-content: start; overflow: auto; min-height: 0; }
.ec-wb button.ec-wb-side-item { display: flex; align-items: center; gap: 0; height: 35px; width: 100%; padding: 0 11px; border: 0; border-radius: var(--ec-radius-sm); background: transparent; color: var(--ec-rail-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; transition: background-color .15s ease, color .15s ease; }
.ec-wb .ec-wb-side-glyph { display: inline-flex; align-items: center; justify-content: center; width: 23px; flex: none; color: var(--ec-rail-muted); }
.ec-wb .ec-wb-side-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ec-wb button.ec-wb-side-item:hover { background: var(--ec-rail-hover); }
.ec-wb button.ec-wb-side-item[aria-current="page"] { background: var(--ec-rail-active); color: var(--ec-rail-ink); font-weight: 700; box-shadow: inset 2px 0 0 var(--ec-rail-accent); }
.ec-wb button.ec-wb-side-item[aria-current="page"] .ec-wb-side-glyph { color: var(--ec-rail-accent); }
.ec-wb .ec-wb-side-count { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--ec-rail-muted); font-variant-numeric: tabular-nums; }
.ec-wb .ec-wb-side-count[data-alert="true"] { color: var(--ec-rail-warn); }
.ec-wb .ec-wb-side-foot { border-top: 1px solid var(--ec-rail-line); padding-top: 8px; flex: none; }
.ec-wb .ec-wb-side-conn { margin-left: auto; font-size: 12px; color: var(--ec-rail-warn); white-space: nowrap; }
/* 折叠图标轨：只有图标、悬停提示与徽标，不排文字——宿主的折叠列只有 56px，放不下任何可翻译的
   文字（中文标签 9px 仍被裁切，English 的 Conversations / Applications 直接截断）。名称由
   aria-label 与 title 提供；「待我处理」带数量徽标；连接状态是一个带可访问名称的点。
   创建入口在索引标题旁的 ＋；logo 位即展开开关。 */
.ec-wb.ec-wb-side-rail { align-items: center; padding: 12px 4px; gap: 6px; }
.ec-wb button.ec-wb-side-rail-toggle { width: 100%; height: 38px; border: 1px solid var(--ec-rail-line); border-radius: var(--ec-radius-sm); background: transparent; color: var(--ec-rail-ink); display: grid; place-items: center; padding: 0; cursor: pointer; flex: none; transition: background-color .15s ease; }
.ec-wb button.ec-wb-side-rail-toggle:hover { background: var(--ec-rail-hover); }
.ec-wb button.ec-wb-side-rail-new { width: 34px; height: 34px; border: 0; border-radius: var(--ec-radius-sm); background: var(--ec-primary); color: #fff; font: inherit; font-size: 15px; line-height: 1; display: grid; place-items: center; padding: 0; cursor: pointer; flex: none; transition: background-color .15s ease; }
.ec-wb button.ec-wb-side-rail-new:hover { background: var(--ec-primary-hover); }
.ec-wb button.ec-wb-side-rail-item { position: relative; width: 40px; height: 40px; border: 0; border-radius: var(--ec-radius-sm); background: transparent; color: var(--ec-rail-muted); display: grid; place-items: center; padding: 0; cursor: pointer; flex: none; transition: background-color .15s ease, color .15s ease; }
.ec-wb button.ec-wb-side-rail-item:hover { background: var(--ec-rail-hover); color: var(--ec-rail-text); }
.ec-wb button.ec-wb-side-rail-item[aria-current="page"] { background: var(--ec-rail-active); color: var(--ec-rail-ink); }
/* 待办数量徽标：数字本身 12px（可读文字下限），胶囊 18px 高才装得下。 */
.ec-wb .ec-wb-side-rail-badge { position: absolute; top: 1px; right: 1px; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 999px; background: var(--ec-rail-warn); color: #06262e; font-size: 12px; font-weight: 700; line-height: 18px; display: inline-grid; place-items: center; font-variant-numeric: tabular-nums; }
.ec-wb .ec-wb-side-rail-spring { flex: 1; }
.ec-wb .ec-wb-side-rail-conn { display: grid; place-items: center; padding: 8px 0 4px; flex: none; }
.ec-wb .ec-wb-side-rail-conn-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ec-green); flex: none; }
.ec-wb .ec-wb-side-rail-conn.is-down .ec-wb-side-rail-conn-dot { background: var(--ec-rail-warn); }
/* shell.leading 抽屉打开控件：宿主仅在抽屉/隐藏态挂载本 seat，data-sidebar-opener
   是企业导航折叠后归还焦点的查找锚点。 */
.ec-wb.ec-wb-side-opener { width: 30px; height: 30px; display: grid; place-items: center; padding: 0; border: 1px solid var(--ec-line); border-radius: 6px; background: var(--ec-white); color: var(--ec-secondary); cursor: pointer; transition: background-color .15s ease; }
.ec-wb.ec-wb-side-opener:hover { background: var(--ec-soft); }

/* ── Main column and page frame ─────────────────────────────────────────── */
.ec-wb .ec-wb-main { min-width: 0; background: var(--ec-paper); }
.ec-wb .ec-wb-page { padding: 23px 28px 14px; display: flex; flex-direction: column; gap: var(--ec-gap); min-width: 0; }
.ec-wb .ec-wb-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.ec-wb .ec-wb-page-head p { margin-top: 6px; max-width: 68ch; }
.ec-wb .ec-wb-page-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ec-wb .ec-wb-hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; min-height: 79px; flex-wrap: wrap; }
.ec-wb .ec-wb-eyebrow { font-size: 12px; color: var(--ec-muted); margin-bottom: 5px; }
.ec-wb .ec-wb-hero p { margin-top: 6px; color: var(--ec-muted); font-size: 12px; max-width: 64ch; }
.ec-wb .ec-wb-hero-actions { display: flex; align-items: center; gap: 8px; padding-bottom: 2px; flex-wrap: wrap; }
.ec-wb .ec-wb-chip { font-size: 12px; color: var(--ec-muted); padding-right: 7px; white-space: nowrap; }
.ec-wb .ec-wb-hero-cta { min-height: 32px; padding: 0 13px; font-size: 12px; }
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
.ec-wb .ec-wb-canvas-foot { display: flex; align-items: center; gap: 10px; padding: 2px; color: var(--ec-muted); font-size: 12px; flex-wrap: wrap; }
.ec-wb .ec-wb-canvas-foot .ec-wb-sep { height: 10px; border-left: 1px solid var(--ec-line); }
.ec-wb button.ec-wb-foot-link { margin-left: auto; border: 0; background: transparent; padding: 0; font: inherit; font-size: 12px; color: var(--ec-muted); cursor: pointer; }
.ec-wb button.ec-wb-foot-link:hover { color: var(--ec-primary); }

/* ── Panels ─────────────────────────────────────────────────────────────── */
.ec-wb .ec-wb-card {
  background: var(--ec-white); border: 1px solid var(--ec-line); border-radius: var(--ec-radius);
  padding: var(--ec-pad); display: flex; flex-direction: column; gap: 10px; min-width: 0;
  box-shadow: var(--ec-shadow-1);
}
.ec-wb .ec-wb-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ec-wb .ec-wb-card-head p { margin-top: 3px; }

/* ── AI launch panel ────────────────────────────────────────────────────── */
.ec-wb .ec-wb-launch { display: grid; grid-template-columns: minmax(0, 1fr) 260px; padding: 0; gap: 0; position: relative; overflow: hidden; }
.ec-wb .ec-wb-launch::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--ec-primary); }
.ec-wb .ec-wb-launch-intro { padding: 18px 20px 15px 23px; display: flex; flex-direction: column; justify-content: space-between; gap: 14px; min-width: 0; }
.ec-wb .ec-wb-launch-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ec-wb .ec-wb-orb {
  width: 39px; height: 39px; flex: none; position: relative; border-radius: 10px;
  background: var(--ec-green-weak); color: var(--ec-green); display: grid; place-items: center;
}
.ec-wb .ec-wb-orb::after { content: ""; position: absolute; width: 5px; height: 5px; border-radius: 50%; background: var(--ec-green); top: 7px; right: 7px; box-shadow: 0 0 0 3px var(--ec-green-weak); }
.ec-wb .ec-wb-launch-label { font-size: 12px; color: var(--ec-muted); }
.ec-wb .ec-wb-launch-intro h2 { font-size: 17px; letter-spacing: -.02em; color: var(--ec-ink); font-weight: 680; }
.ec-wb .ec-wb-launch-desc { font-size: 12px; color: var(--ec-muted); margin-top: 3px; }
.ec-wb .ec-wb-quick { display: flex; align-items: center; gap: 7px; margin-left: 51px; flex-wrap: wrap; }
.ec-wb .ec-wb-quick > span { font-size: 12px; color: var(--ec-muted); margin-right: 2px; }
.ec-wb button.ec-wb-quick-target {
  display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--ec-line); background: var(--ec-white);
  border-radius: 4px; padding: 5px 8px; font: inherit; font-size: 12px; color: var(--ec-secondary); cursor: pointer;
  transition: border-color .15s ease, background-color .15s ease;
}
.ec-wb button.ec-wb-quick-target:hover { border-color: var(--ec-line-strong); background: var(--ec-soft); }
.ec-wb button.ec-wb-quick-target b { font-size: 12px; color: var(--ec-green); }
.ec-wb .ec-wb-launch-controls {
  background: var(--ec-soft); border-left: 1px solid var(--ec-line); padding: 15px 17px 13px;
  display: flex; flex-direction: column; justify-content: center; gap: 9px; min-width: 0;
}
.ec-wb .ec-wb-model-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; color: var(--ec-muted); }
.ec-wb .ec-wb-model-row strong { font-size: 12px; color: var(--ec-secondary); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ec-wb button.ec-wb-launch-go {
  height: 34px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
  margin-top: 2px; background: var(--ec-primary); border: 0; border-radius: var(--ec-radius-sm);
  color: #fff; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer;
  transition: background-color .15s ease;
}
.ec-wb button.ec-wb-launch-go:hover:not(:disabled) { background: var(--ec-primary-hover); }
.ec-wb button.ec-wb-launch-go:disabled { opacity: .5; cursor: not-allowed; }

/* ── Rail: pending, readiness, projects ─────────────────────────────────── */
.ec-wb .ec-wb-pending-empty { display: flex; align-items: flex-start; gap: 9px; padding: 3px 0 1px; }
.ec-wb .ec-wb-empty-icon { width: 23px; height: 23px; border-radius: 6px; display: grid; place-items: center; background: var(--ec-green-weak); color: var(--ec-green); flex: none; }
.ec-wb .ec-wb-pending-empty p { font-size: 12px; color: var(--ec-muted); line-height: 1.55; }
.ec-wb .ec-wb-pending-empty small { display: block; color: var(--ec-muted); font-size: 12px; margin-top: 2px; }
.ec-wb .ec-wb-pending-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ec-amber); flex: none; }
.ec-wb .ec-wb-readiness-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ec-wb .ec-wb-state-tag { font-size: 12px; color: var(--ec-amber); background: var(--ec-amber-weak); padding: 4px 7px; border-radius: 4px; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; }
.ec-wb .ec-wb-state-tag::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--ec-amber); flex: none; }
.ec-wb .ec-wb-state-tag[data-tone="ok"] { color: var(--ec-green); background: var(--ec-green-weak); }
.ec-wb .ec-wb-state-tag[data-tone="ok"]::before { background: var(--ec-green); }
.ec-wb .ec-wb-checks { display: grid; gap: 7px; }
.ec-wb .ec-wb-checkline { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ec-muted); }
.ec-wb .ec-wb-tick {
  width: 16px; height: 16px; flex: none; border: 1px solid var(--ec-line); border-radius: 4px;
  display: grid; place-items: center; font-size: 12px; color: var(--ec-muted); background: var(--ec-white);
}
.ec-wb .ec-wb-tick[data-tone="ok"] { border-color: var(--ec-line-strong); background: var(--ec-green-weak); color: var(--ec-green); }
.ec-wb .ec-wb-tick[data-tone="pending"] { border-color: var(--ec-amber-line); background: var(--ec-amber-weak); color: var(--ec-amber); }
.ec-wb button.ec-wb-readiness-link {
  margin-top: 1px; padding: 9px 0 0; border: 0; border-top: 1px solid var(--ec-line-soft);
  background: transparent; width: 100%; display: flex; align-items: center; justify-content: space-between;
  color: var(--ec-green); font: inherit; font-size: 12px; cursor: pointer;
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
  width: 27px; height: 27px; flex: none; display: grid; place-items: center; background: var(--ec-green-weak);
  border-radius: 5px; color: var(--ec-green); font-size: 12px; font-weight: 700;
}
.ec-wb .ec-wb-project-row strong, .ec-wb .ec-wb-run-row strong, .ec-wb .ec-wb-artifact-row strong { display: block; font-size: 12px; font-weight: 620; overflow-wrap: anywhere; }
.ec-wb .ec-wb-project-row small, .ec-wb .ec-wb-run-row small, .ec-wb .ec-wb-artifact-row small { display: block; font-size: 12px; color: var(--ec-muted); margin-top: 2px; }
/* Rail rows are read at a glance, not scanned: give the run name a readable size and a
   visible selected state instead of relying on a 6px dot. */
.ec-wb .ec-wb-run-row { border-radius: 8px; padding: 10px 8px; margin: 0 -8px; }
.ec-wb .ec-wb-run-row strong { font-size: 12px; }
.ec-wb .ec-wb-run-row small { font-size: 12px; }
.ec-wb button.ec-wb-run-row[aria-current="true"] { background: var(--ec-green-weak); }
.ec-wb button.ec-wb-run-row[aria-current="true"] strong { color: var(--ec-primary); }
.ec-wb .ec-wb-row-tail { margin-left: auto; color: var(--ec-muted); font-size: 14px; flex: none; }
.ec-wb button.ec-wb-project-link {
  margin-top: 1px; padding: 8px 0 0; border: 0; border-top: 1px solid var(--ec-line-soft);
  background: transparent; width: 100%; text-align: left; color: var(--ec-green); font: inherit; font-size: 12px; cursor: pointer;
}
.ec-wb button.ec-wb-project-link:hover { color: var(--ec-primary-hover); }

/* ── Works queue table ──────────────────────────────────────────────────── */
.ec-wb .ec-wb-queue { padding: 0; gap: 0; }
.ec-wb .ec-wb-queue-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 17px 11px; flex-wrap: wrap; }
.ec-wb .ec-wb-queue-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ec-wb .ec-wb-queue-tools .ec-wb-count { font-size: 12px; color: var(--ec-muted); font-variant-numeric: tabular-nums; }
/* Queue toolbar: a search field and two compact selects, sized to the draft's 9–11px metadata. */
.ec-wb .ec-wb-search { position: relative; display: flex; align-items: center; min-width: 190px; }
.ec-wb .ec-wb-search-glyph { position: absolute; left: 9px; display: inline-flex; color: var(--ec-muted); pointer-events: none; }
.ec-wb .ec-wb-input.ec-wb-search-input {
  min-height: 31px; padding: 0 26px 0 28px; font-size: 12px; border-radius: var(--ec-radius-sm);
}
.ec-wb .ec-wb-search-input::-webkit-search-cancel-button { display: none; }
.ec-wb button.ec-wb-search-clear {
  position: absolute; right: 5px; width: 18px; height: 18px; display: grid; place-items: center;
  border: 0; border-radius: 4px; background: transparent; color: var(--ec-muted); font: inherit; font-size: 13px;
  line-height: 1; cursor: pointer;
}
.ec-wb button.ec-wb-search-clear:hover { background: var(--ec-soft); color: var(--ec-primary); }
.ec-wb .ec-wb-select.ec-wb-queue-select { width: auto; min-width: 92px; min-height: 31px; font-size: 12px; padding: 0 24px 0 9px; }
.ec-wb .ec-wb-queue-empty { padding: 4px 17px 14px; }
.ec-wb .ec-wb-queue-note { padding: 0 17px 8px; }
.ec-wb .ec-wb-queue-foot button.ec-wb-text-link:disabled { opacity: .6; cursor: default; }
.ec-wb .ec-wb-table { min-width: 0; }
.ec-wb .ec-wb-table-head, .ec-wb .ec-wb-work-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.6fr) minmax(100px, .95fr) minmax(74px, .7fr) minmax(92px, .8fr) 62px;
  align-items: center; gap: 10px; padding: 0 17px;
}
.ec-wb .ec-wb-table-head { height: 28px; background: var(--ec-soft); border-top: 1px solid var(--ec-line); border-bottom: 1px solid var(--ec-line); font-size: 12px; color: var(--ec-muted); }
.ec-wb .ec-wb-work-row { min-height: 49px; border-bottom: 1px solid var(--ec-line-soft); background: var(--ec-white); transition: background-color .15s ease; }
.ec-wb .ec-wb-work-row:hover { background: var(--ec-soft); }
.ec-wb .ec-wb-work-name { display: flex; align-items: center; gap: 9px; min-width: 0; }
.ec-wb .ec-wb-work-icon {
  width: 27px; height: 27px; flex: none; border: 1px solid var(--ec-line); background: var(--ec-green-weak); border-radius: 5px;
  display: grid; place-items: center; color: var(--ec-green); font-size: 12px; font-weight: 700;
}
.ec-wb button.ec-wb-work-open { border: 0; background: transparent; padding: 0; text-align: left; font: inherit; color: inherit; cursor: pointer; min-width: 0; }
.ec-wb .ec-wb-work-name strong { display: block; font-size: 12px; color: var(--ec-ink); font-weight: 640; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
.ec-wb button.ec-wb-work-open:hover strong { color: var(--ec-primary); }
.ec-wb .ec-wb-work-name small { font-size: 12px; color: var(--ec-muted); display: block; margin-top: 2px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
.ec-wb .ec-wb-app-cell { font-size: 12px; color: var(--ec-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ec-wb .ec-wb-state { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ec-secondary); white-space: nowrap; }
.ec-wb .ec-wb-state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ec-green); flex: none; }
.ec-wb .ec-wb-state[data-tone="warn"]::before { background: var(--ec-amber); }
.ec-wb .ec-wb-state[data-tone="error"]::before { background: var(--ec-danger); }
.ec-wb .ec-wb-state[data-tone="muted"]::before { background: var(--ec-muted); }
.ec-wb .ec-wb-updated { font-size: 12px; color: var(--ec-muted); white-space: nowrap; }
.ec-wb .ec-wb-work-tail { display: flex; justify-content: flex-end; }
.ec-wb .ec-wb-queue-foot {
  min-height: 27px; margin-top: auto; padding: 6px 16px; display: flex; align-items: center; gap: 7px;
  background: var(--ec-white); border-top: 1px solid var(--ec-line-soft); font-size: 12px; color: var(--ec-muted);
}
.ec-wb .ec-wb-queue-foot i { width: 5px; height: 5px; border-radius: 50%; background: var(--ec-green); flex: none; }
.ec-wb .ec-wb-queue-foot .ec-wb-foot-right { margin-left: auto; }

/* ── Rows, badges, buttons ──────────────────────────────────────────────── */
.ec-wb .ec-wb-row-button {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 10px 4px; border-top: 1px solid var(--ec-line-soft); background: transparent;
  border-left: 0; border-right: 0; border-bottom: 0; color: inherit; font: inherit; width: 100%; min-width: 0;
}
.ec-wb .ec-wb-rows .ec-wb-row-button:first-of-type { border-top: 0; }
.ec-wb .ec-wb-row-button:hover { background: var(--ec-soft); }
.ec-wb .ec-wb-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ec-wb .ec-wb-row-main strong { font-size: 12px; font-weight: 620; color: var(--ec-ink); overflow-wrap: anywhere; }
/* The rail's run rows carry the primary label the employee reads; the generic row-main size
   (used by dense tables elsewhere) is too small there. */
.ec-wb .ec-wb-run-row .ec-wb-row-main strong { font-size: 12px; }
.ec-wb .ec-wb-run-row .ec-wb-row-main small { font-size: 12px; }
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
.ec-wb .ec-wb-action-form label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; font-weight: 600; color: var(--ec-ink); }
.ec-wb .ec-wb-action-form input,
.ec-wb .ec-wb-action-form select { font: inherit; font-size: 12px; padding: 5px 8px; border: 1px solid var(--ec-line-strong); border-radius: var(--ec-radius-sm); background: var(--ec-white); color: var(--ec-ink); min-width: 0; }
/* Declarative result views and key-aligned diffs (E1-4/E1-5): compact tables and diff blocks
   readable at rail width. */
.ec-wb .ec-wb-inline-field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; font-weight: 600; color: var(--ec-ink); padding-bottom: 6px; }
.ec-wb .ec-wb-inline-field select { font: inherit; font-size: 12px; padding: 5px 8px; border: 1px solid var(--ec-line-strong); border-radius: var(--ec-radius-sm); background: var(--ec-white); color: var(--ec-ink); min-width: 0; }
.ec-wb .ec-wb-diff-block, .ec-wb .ec-wb-view-block { display: flex; flex-direction: column; gap: 4px; padding: 6px 0; border-top: 1px solid var(--ec-line-soft); }
.ec-wb .ec-wb-diff-kind { font-size: 12px; font-weight: 620; color: var(--ec-ink); }
.ec-wb .ec-wb-finding-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ec-wb .ec-wb-finding-table th { text-align: left; font-weight: 600; color: var(--ec-secondary); padding: 4px 8px 4px 0; border-bottom: 1px solid var(--ec-line-soft); }
.ec-wb .ec-wb-finding-table td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--ec-line-soft); color: var(--ec-ink); overflow-wrap: anywhere; }
.ec-wb .ec-wb-metric-list { margin: 0; padding: 0 0 0 16px; font-size: 12px; color: var(--ec-ink); }
.ec-wb button.ec-wb-button {
  border: 1px solid var(--ec-line-strong); background: var(--ec-white); color: var(--ec-secondary);
  font: inherit; font-size: 12px; font-weight: 600; line-height: 1.3; border-radius: var(--ec-radius-sm);
  padding: 0 11px; cursor: pointer; white-space: nowrap; min-height: 31px;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.ec-wb button.ec-wb-button:hover:not(:disabled) { background: var(--ec-green-weak); border-color: var(--ec-line-strong); color: var(--ec-primary); }
.ec-wb button.ec-wb-button:disabled { opacity: .5; cursor: not-allowed; }
.ec-wb button.ec-wb-primary { color: #fff; background: var(--ec-primary); border-color: var(--ec-primary); font-weight: 650; }
.ec-wb button.ec-wb-primary:hover:not(:disabled) { background: var(--ec-primary-hover); border-color: var(--ec-primary-hover); color: #fff; }
.ec-wb button.ec-wb-stop { border-color: var(--ec-danger); color: var(--ec-danger); }
.ec-wb button.ec-wb-stop:hover:not(:disabled) { background: var(--ec-danger-weak); border-color: var(--ec-danger); color: var(--ec-danger); }
.ec-wb a.ec-wb-link, .ec-wb .ec-wb-text-link { color: var(--ec-primary); text-decoration: none; font-size: 12px; font-weight: 600; }
.ec-wb a.ec-wb-link:hover { text-decoration: underline; }
.ec-wb button.ec-wb-text-link { border: 0; background: transparent; padding: 0; font: inherit; font-size: 12px; font-weight: 600; color: var(--ec-primary); cursor: pointer; }
.ec-wb button.ec-wb-text-link:hover { text-decoration: underline; }
.ec-wb .ec-wb-badge {
  display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; font-size: 12px; font-weight: 500;
  line-height: 1.4; padding: 3px 7px; border-radius: 4px; background: var(--ec-line-soft); color: var(--ec-secondary);
  font-variant-numeric: tabular-nums;
}
.ec-wb .ec-wb-badge[data-tone="ok"] { background: var(--ec-green-weak); color: var(--ec-green); }
.ec-wb .ec-wb-badge[data-tone="ok"]::before, .ec-wb .ec-wb-badge[data-tone="warn"]::before, .ec-wb .ec-wb-badge[data-tone="error"]::before {
  content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentcolor; flex: none;
}
.ec-wb .ec-wb-badge[data-tone="warn"] { background: var(--ec-amber-weak); color: var(--ec-amber); }
.ec-wb .ec-wb-badge[data-tone="error"] { background: var(--ec-danger-weak); color: var(--ec-danger); }
.ec-wb .ec-wb-badge[data-tone="muted"] { background: var(--ec-line-soft); color: var(--ec-secondary); }
.ec-wb .ec-wb-empty { color: var(--ec-muted); font-size: 12px; padding: 12px 2px; line-height: 1.7; }
.ec-wb .ec-wb-status { min-height: 1px; color: var(--ec-muted); font-size: 12px; }
.ec-wb .ec-wb-error {
  border: 1px solid var(--ec-danger); border-left: 3px solid var(--ec-danger); border-radius: var(--ec-radius-sm);
  padding: 9px 11px; display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap;
}
.ec-wb .ec-wb-error p { color: var(--ec-danger); font-size: 12px; overflow-wrap: anywhere; }
.ec-wb .ec-wb-error-text { color: var(--ec-danger); font-size: 12px; overflow-wrap: anywhere; }
.ec-wb .ec-wb-facts { display: grid; grid-template-columns: minmax(84px, max-content) minmax(0, 1fr); gap: 6px 12px; font-size: 12px; margin: 0; }
.ec-wb .ec-wb-facts dt { color: var(--ec-muted); }
.ec-wb .ec-wb-facts dd { margin: 0; color: var(--ec-secondary); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.ec-wb .ec-wb-digest { font-family: "Cascadia Mono", Consolas, monospace; font-size: 12px; }

/* ── Forms ──────────────────────────────────────────────────────────────── */
.ec-wb .ec-wb-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.ec-wb .ec-wb-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--ec-secondary); min-width: 0; }
.ec-wb .ec-wb-field-label { color: var(--ec-muted); font-size: 12px; font-weight: 600; }
.ec-wb .ec-wb-form-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 4px; }
.ec-wb .ec-wb-subform { border-top: 1px dashed var(--ec-line); margin-top: 4px; padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.ec-wb .ec-wb-input, .ec-wb .ec-wb-select, .ec-wb .ec-wb-textarea {
  font: inherit; font-size: 12px; color: var(--ec-secondary); background: var(--ec-white);
  border: 1px solid var(--ec-line); border-radius: var(--ec-radius-sm); padding: 7px 9px; width: 100%; min-width: 0;
}
.ec-wb .ec-wb-textarea { resize: vertical; line-height: 1.6; }
.ec-wb .ec-wb-select {
  appearance: none; -webkit-appearance: none; min-height: 32px;
  background-image: var(--ec-chevron); background-repeat: no-repeat; background-position: right 9px center;
  padding-right: 26px; cursor: pointer;
}
.ec-wb .ec-wb-input::placeholder, .ec-wb .ec-wb-textarea::placeholder { color: var(--ec-muted); }
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
.ec-wb .ec-wb-project-card:hover { border-color: var(--ec-line-strong); box-shadow: var(--ec-shadow-3); }
.ec-wb .ec-wb-project-card.is-active { border-color: var(--ec-primary); box-shadow: 0 0 0 1px rgba(12, 115, 104, .13); }
.ec-wb .ec-wb-project-card strong { font-size: 13px; color: var(--ec-ink); }
.ec-wb .ec-wb-project-card small { color: var(--ec-muted); font-size: 12px; }
.ec-wb .ec-wb-project-code { align-self: flex-start; font-size: 12px; color: var(--ec-secondary); background: var(--ec-line-soft); border-radius: 4px; padding: 2px 7px; }
.ec-wb .ec-wb-app-card { background: var(--ec-white); border: 1px solid var(--ec-line); border-radius: var(--ec-radius); padding: 15px; display: flex; align-items: center; gap: 12px; box-shadow: var(--ec-shadow-1); }
.ec-wb .ec-wb-app-card.is-revoked { opacity: .65; }
.ec-wb .ec-wb-app-icon { width: 34px; height: 34px; border-radius: 8px; background: var(--ec-green-weak); color: var(--ec-green); display: grid; place-items: center; flex: none; }
.ec-wb .ec-wb-run-button {
  border: 1px solid transparent; background: transparent; color: inherit; font: inherit; text-align: left;
  display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 8px;
  border-radius: var(--ec-radius-sm); cursor: pointer;
}
.ec-wb .ec-wb-run-button:hover { background: var(--ec-soft); }
.ec-wb .ec-wb-run-button[aria-current="true"] { background: var(--ec-green-weak); border-color: var(--ec-primary); }
.ec-wb .ec-wb-run-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; border-top: 1px solid var(--ec-line); padding-top: 11px; }
.ec-wb .ec-wb-pager { display: flex; align-items: center; gap: 10px; padding-top: 10px; flex-wrap: wrap; }
.ec-wb .ec-wb-pager span { color: var(--ec-muted); font-size: 12px; font-variant-numeric: tabular-nums; }

/* ── Question card (native questions awaiting an answer) ────────────────── */
.ec-wb .ec-wb-interaction {
  background: var(--ec-amber-weak); border: 1px solid var(--ec-amber-line); border-radius: var(--ec-radius);
  padding: 14px 15px; margin-top: 2px; display: flex; flex-direction: column; gap: 10px;
}
.ec-wb .ec-wb-question-title { display: flex; align-items: center; gap: 7px; color: var(--ec-amber); }
.ec-wb .ec-wb-fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ec-wb .ec-wb-fieldset legend { font-size: 12px; font-weight: 680; color: var(--ec-amber); padding: 0; display: flex; align-items: center; gap: 7px; }
.ec-wb .ec-wb-options { display: flex; flex-wrap: wrap; gap: 7px; }
.ec-wb .ec-wb-option { position: relative; display: inline-flex; }
.ec-wb .ec-wb-option input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.ec-wb .ec-wb-option span {
  font-size: 12px; padding: 6px 10px; border: 1px solid var(--ec-amber-line); border-radius: var(--ec-radius-sm);
  background: var(--ec-white); color: var(--ec-amber); transition: border-color .15s ease, background-color .15s ease;
}
.ec-wb .ec-wb-option:hover span { border-color: var(--ec-amber); background: var(--ec-amber-weak); }
.ec-wb .ec-wb-option input:checked + span { border-color: var(--ec-amber); background: var(--ec-amber-weak); color: var(--ec-amber); font-weight: 650; }
.ec-wb .ec-wb-option input:focus-visible + span { outline: 3px solid var(--ec-focus); outline-offset: 2px; }
.ec-wb .ec-wb-interaction .ec-wb-input { border-color: var(--ec-amber-line); }
.ec-wb .ec-wb-interaction-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* ── Work detail ────────────────────────────────────────────────────────── */
.ec-wb .ec-wb-view { display: block; }
.ec-wb button.ec-wb-back-link {
  display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent;
  color: var(--ec-primary); font: inherit; font-size: 12px; font-weight: 600; padding: 0 0 6px; cursor: pointer;
}
.ec-wb .ec-wb-back-link:hover { text-decoration: underline; }
.ec-wb .ec-wb-file-dot {
  width: 26px; height: 26px; flex: none; border-radius: 5px; background: var(--ec-soft); border: 1px solid var(--ec-line);
  display: grid; place-items: center; color: var(--ec-green); font-size: 12px; font-weight: 700; text-transform: lowercase;
}
.ec-wb .ec-wb-dl { margin-left: auto; font-size: 12px; color: var(--ec-primary); flex: none; }
.ec-wb .ec-wb-run-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ec-green); flex: none; }
.ec-wb .ec-wb-run-dot[data-tone="warn"] { background: var(--ec-amber); }
.ec-wb .ec-wb-run-dot[data-tone="error"] { background: var(--ec-danger); }
.ec-wb .ec-wb-run-dot[data-tone="muted"] { background: var(--ec-muted); }

/* ── Work console: enterprise head + rail around the native conversation ── */
.ec-wb .ec-wb-main-session { display: flex; flex-direction: column; height: calc(100vh - var(--ec-topbar-h)); }
.ec-wb .ec-wb-console { display: flex; flex-direction: column; flex: 1; min-height: 0; animation: ec-wb-view-in .18s ease-out; }
@keyframes ec-wb-view-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.ec-wb .ec-wb-console-head {
  flex: none; background: var(--ec-white); border-bottom: 1px solid var(--ec-line);
  padding: 12px 24px 11px; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
}
.ec-wb .ec-wb-console-crumb { font-size: 12px; color: var(--ec-muted); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ec-wb .ec-wb-console-title-row { display: flex; align-items: center; gap: 10px; margin-top: 4px; min-width: 0; }
.ec-wb .ec-wb-console-title { font-size: 16px; color: var(--ec-ink); font-weight: 680; letter-spacing: -.02em; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ec-wb .ec-wb-pill {
  font-size: 12px; padding: 4px 9px; border-radius: 4px; background: var(--ec-green-weak); color: var(--ec-green);
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; flex: none;
}
.ec-wb .ec-wb-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ec-green); flex: none; }
.ec-wb .ec-wb-pill[data-tone="warn"] { background: var(--ec-amber-weak); color: var(--ec-amber); }
.ec-wb .ec-wb-pill[data-tone="warn"]::before { background: var(--ec-amber); }
.ec-wb .ec-wb-pill[data-tone="error"] { background: var(--ec-danger-weak); color: var(--ec-danger); }
.ec-wb .ec-wb-pill[data-tone="error"]::before { background: var(--ec-danger); }
.ec-wb .ec-wb-pill[data-tone="muted"] { background: var(--ec-line-soft); color: var(--ec-secondary); }
.ec-wb .ec-wb-pill[data-tone="muted"]::before { background: var(--ec-muted); }
.ec-wb .ec-wb-console-actions { display: flex; align-items: center; gap: 8px; flex: none; flex-wrap: wrap; }
.ec-wb .ec-wb-console-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) clamp(288px, 21vw, 360px); gap: 16px; padding: 14px 24px 12px; overflow: hidden; }
.ec-wb .ec-wb-console-thread { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.ec-wb .ec-wb-console-rail { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 14px; padding-right: 2px; }
.ec-wb .ec-wb-fact-line { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 12px; padding: 7px 0; border-bottom: 1px solid var(--ec-line-soft); }
.ec-wb .ec-wb-fact-line:last-of-type { border-bottom: 0; }
.ec-wb .ec-wb-fact-line span:first-child { color: var(--ec-muted); flex: none; }
.ec-wb .ec-wb-fact-line span:last-child { color: var(--ec-secondary); text-align: right; overflow-wrap: anywhere; }
/* The upstream conversation factory owns its own scroll body and composer; the thread column
   only gives it a definite height, so the enterprise rail never grows the page scroll. */
.ec-wb .ec-wb-session-conversation { flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* Embedded conversation View tabs: the seat the native session header alone provides upstream.
   Rendered only when more than one View is registered (对话 / 轨迹). */
.ec-wb .ec-wb-session-view-tabs { flex: none; display: flex; align-items: center; gap: 2px; padding: 6px 12px 0; border-bottom: 1px solid var(--ec-line); background: var(--ec-white); }
.ec-wb .ec-wb-session-view-tab { border: 0; background: transparent; padding: 7px 12px 6px; font: inherit; font-size: 12.5px; color: var(--ec-muted); border-bottom: 2px solid transparent; cursor: pointer; border-radius: 6px 6px 0 0; }
.ec-wb .ec-wb-session-view-tab:hover { color: var(--ec-primary); background: var(--ec-green-weak); }
.ec-wb .ec-wb-session-view-tab-active { color: var(--ec-primary); border-bottom-color: var(--ec-primary); font-weight: 640; }

/* Run transcript (selected run in the console center): the run's own scrollable history. */
.ec-wb .ec-wb-transcript { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.ec-wb .ec-wb-transcript-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 2px 4px 12px 2px; }
.ec-wb .ec-wb-transcript-item { background: var(--ec-white); border: 1px solid var(--ec-line); border-radius: 10px; padding: 10px 14px 12px; }
.ec-wb .ec-wb-transcript-item header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.ec-wb .ec-wb-transcript-item time { font-size: 12px; color: var(--ec-muted); }
.ec-wb .ec-wb-transcript-kind { font-size: 12px; font-weight: 640; padding: 2px 8px; border-radius: 4px; background: var(--ec-line-soft); color: var(--ec-secondary); flex: none; }
.ec-wb .ec-wb-transcript-item.is-text .ec-wb-transcript-kind,
.ec-wb .ec-wb-transcript-item.is-final .ec-wb-transcript-kind { background: var(--ec-green-weak); color: var(--ec-green); }
.ec-wb .ec-wb-transcript-item.is-reasoning .ec-wb-transcript-kind { background: #f2effa; color: #6b5bb5; }
.ec-wb .ec-wb-transcript-item.is-tool-call .ec-wb-transcript-kind,
.ec-wb .ec-wb-transcript-item.is-tool-result .ec-wb-transcript-kind { background: var(--ec-amber-weak); color: var(--ec-amber); }
.ec-wb .ec-wb-transcript-item p { margin: 0; font-size: 12px; line-height: 1.65; color: var(--ec-ink); white-space: pre-wrap; overflow-wrap: anywhere; }
.ec-wb .ec-wb-transcript-item.is-reasoning p { color: var(--ec-muted); font-size: 12px; }
.ec-wb .ec-wb-transcript-item.is-final { border-color: var(--ec-line-strong); background: var(--ec-green-weak); }
.ec-wb .ec-wb-transcript-item pre { margin: 8px 0 0; font-size: 12px; line-height: 1.5; color: var(--ec-secondary); background: var(--ec-soft); border: 1px solid var(--ec-line); border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; }

/* ── Responsive ─────────────────────────────────────────────────────────── */
@media (min-width: 1600px) {
  .ec-wb .ec-wb-home-grid { grid-template-columns: minmax(0, 1fr) 310px; }
  .ec-wb .ec-wb-detail { grid-template-columns: minmax(0, 1fr) 330px; }
  .ec-wb .ec-wb-console-body { grid-template-columns: minmax(0, 1fr) 340px; }
}
@media (max-width: 1200px) {
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
  .ec-wb .ec-wb-breadcrumb, .ec-wb .ec-wb-chip { display: none; }
  .ec-wb .ec-wb-top-actions { gap: 7px; }
  .ec-wb .ec-wb-conn { font-size: 0; gap: 0; }
  .ec-wb .ec-wb-page { padding: 18px 14px 12px; }
  .ec-wb .ec-wb-hero { display: block; }
  .ec-wb .ec-wb-hero-actions { margin-top: 11px; }
  .ec-wb .ec-wb-launch { display: flex; flex-direction: column; }
  .ec-wb .ec-wb-launch-controls { border-left: 0; border-top: 1px solid var(--ec-line); }
  .ec-wb .ec-wb-project-grid { grid-template-columns: minmax(0, 1fr); }
  .ec-wb .ec-wb-table-head { display: none; }
  .ec-wb .ec-wb-work-row { grid-template-columns: minmax(0, 1fr) auto 54px; gap: 6px; padding: 8px 12px; }
  .ec-wb .ec-wb-work-row .ec-wb-app-cell { display: none; }
  .ec-wb .ec-wb-work-row .ec-wb-updated { grid-column: 2; grid-row: 1; font-size: 12px; }
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
  .ec-wb .ec-wb-bind-steps li { font-size: 12px; }
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
/* Interaction affordances added with the 2026-11-17 experience pass: a binding-status strip,
   a work wizard and freshness lines. All colours come from the same tokens, so the dark block
   below re-inks them without duplicate rules. */
.ec-wb .ec-wb-freshness { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--ec-muted); }
.ec-wb .ec-wb-freshness button { border: 0; background: none; color: var(--ec-primary); font: inherit; cursor: pointer; text-decoration: underline; }
.ec-wb .ec-wb-console-center { display: flex; flex-direction: column; gap: 8px; min-width: 0; min-height: 0; }
.ec-wb .ec-wb-console-center > .ec-wb-console-thread { flex: 1; min-height: 0; }
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
.ec-wb .ec-wb-palette-hit-main small { font-size: 12px; color: var(--ec-muted); }
/* E4-4 keyboard path: the skip link is hidden until it receives focus. */
.ec-wb .ec-wb-skip { position: absolute; left: 8px; top: -48px; z-index: 70; background: var(--ec-white); color: var(--ec-ink); border: 1px solid var(--ec-line-strong); border-radius: var(--ec-radius-sm); padding: 6px 12px; font: inherit; font-size: 13px; text-decoration: none; transition: top .15s ease; }
.ec-wb .ec-wb-skip:focus-visible { top: 8px; outline: 2px solid var(--ec-focus); outline-offset: -2px; }

@media (prefers-color-scheme: dark) {
  .ec-wb {
    /* RBQM Emerald 开发说明 §2.2：暗色画布 #04141A、卡面 #0D2026、一级文字 #E8F4F6、
       次文 #B0C9CF、分隔 #24484E、可读链接 #6BD0D5；主按钮保留深渐变与白字。 */
    --ec-ink: #e8f4f6;
    --ec-deep: #d6e4e4;
    --ec-muted: #b0c9cf;
    --ec-secondary: #b0c9cf;
    --ec-primary: #6bd0d5;
    --ec-primary-hover: #85dade;
    --ec-green: #6bd0d5;
    --ec-green-weak: #11312c;
    --ec-paper: #04141a;
    --ec-white: #0d2026;
    --ec-line: #24484e;
    --ec-line-strong: #5e8a93;
    --ec-line-soft: #193239;
    --ec-soft: #0e2228;
    --ec-amber: #d9a44c;
    --ec-amber-weak: #33290f;
    --ec-amber-line: #4a3c1d;
    --ec-danger: #e28f80;
    --ec-danger-weak: #32201c;
    --ec-focus: #6bd0d5;
    --ec-topbar-bg: #0d2026;
    --ec-shadow-1: 0 2px 5px rgba(0, 0, 0, .28);
    --ec-shadow-2: 0 2px 4px rgba(0, 0, 0, .35);
    --ec-shadow-3: 0 8px 24px rgba(0, 0, 0, .40);
    --ec-rail-bg: #06262e;
    --ec-rail-line: #234f59;
    --ec-rail-hover: #0d5c70;
    --ec-rail-active: #13676c;
    --ec-index-bg: #073039;
    --ec-index-line: #234f59;
    --ec-index-hover: #0d5c70;
    --ec-index-active: #13676c;
    --ec-input-deep-bg: #073f54;
    --ec-input-deep-border: #7fa3ad;
    --ec-console-rail-bg: #0e2228;
    --ec-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23b0c9cf' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    color-scheme: dark;
    scrollbar-color: #24484e transparent;
  }
  .ec-wb h1, .ec-wb h2, .ec-wb h3 { color: var(--ec-ink); }
  .ec-wb .ec-wb-side-wordmark { color: var(--ec-rail-ink); }
  .ec-wb .ec-wb-breadcrumb span:last-child { color: var(--ec-secondary); }
  .ec-wb button.ec-wb-side-new, .ec-wb button.ec-wb-launch-go { color: #053a4c; }
  .ec-wb .ec-wb-launch-controls, .ec-wb .ec-wb-table-head, .ec-wb .ec-wb-queue-foot { background: #0e2228; border-color: var(--ec-line); }
  .ec-wb .ec-wb-work-row { background: var(--ec-white); }
  .ec-wb .ec-wb-work-row:hover, .ec-wb .ec-wb-row-button:hover, .ec-wb .ec-wb-run-button:hover { background: #193239; }
  .ec-wb .ec-wb-work-icon, .ec-wb .ec-wb-monogram, .ec-wb .ec-wb-file-dot { background: #0d5c70; border-color: var(--ec-line); color: var(--ec-primary); }
  .ec-wb .ec-wb-orb, .ec-wb .ec-wb-empty-icon { background: #0d5c70; color: var(--ec-primary); }
  .ec-wb .ec-wb-work-name strong, .ec-wb .ec-wb-launch-intro h2, .ec-wb .ec-wb-console-title { color: var(--ec-ink); }
  .ec-wb .ec-wb-input, .ec-wb .ec-wb-select, .ec-wb .ec-wb-textarea { color: var(--ec-ink); border-color: var(--ec-line-strong); }
  .ec-wb .ec-wb-interaction { background: #2a2415; }
  .ec-wb .ec-wb-fieldset legend { color: var(--ec-amber); }
  .ec-wb .ec-wb-option span { background: #241f14; border-color: #4a3c1d; color: var(--ec-amber); }
  .ec-wb .ec-wb-option input:checked + span { background: #33290f; }
  .ec-wb .ec-wb-tick { background: var(--ec-white); border-color: var(--ec-line-strong); }
  .ec-wb .ec-wb-tick[data-tone="ok"] { background: #11312c; border-color: #29523f; color: var(--ec-primary); }
  .ec-wb .ec-wb-tick[data-tone="pending"] { background: #33290f; border-color: #4a3c1d; color: var(--ec-amber); }
  .ec-wb .ec-wb-fact-line { border-color: var(--ec-line-soft); }
  .ec-wb .ec-wb-fact-line span:last-child, .ec-wb .ec-wb-facts dd { color: var(--ec-secondary); }
  /* The light palette hard-codes a few ink/border values for exact draft fidelity; each one is
     re-mapped here so no pairing falls below readable contrast on the dark canvas. */
  .ec-wb .ec-wb-card { border-color: var(--ec-line); }
  .ec-wb .ec-wb-side-foot { border-top-color: var(--ec-rail-line); }
  .ec-wb.ec-wb-side-rail, .ec-wb.ec-wb-side { border-right-color: var(--ec-rail-line); }
  .ec-wb .ec-wb-orb::after { box-shadow: 0 0 0 3px #13676c; }
  .ec-wb .ec-wb-conn { color: var(--ec-primary); }
  .ec-wb .ec-wb-conn::before { background: var(--ec-primary); box-shadow: 0 0 0 3px #11312c; }
  .ec-wb .ec-wb-conn.is-down { color: var(--ec-amber); }
  .ec-wb .ec-wb-conn.is-down::before { background: var(--ec-amber); box-shadow: 0 0 0 3px #33290f; }
  .ec-wb .ec-wb-breadcrumb, .ec-wb .ec-wb-eyebrow, .ec-wb .ec-wb-chip, .ec-wb .ec-wb-hero p,
  .ec-wb .ec-wb-launch-label, .ec-wb .ec-wb-launch-desc, .ec-wb .ec-wb-app-cell, .ec-wb .ec-wb-state,
  .ec-wb .ec-wb-checkline, .ec-wb .ec-wb-pending-empty p, .ec-wb .ec-wb-model-row,
  .ec-wb .ec-wb-table-head, .ec-wb .ec-wb-queue-foot, .ec-wb .ec-wb-queue-tools .ec-wb-count,
  .ec-wb .ec-wb-work-name small, .ec-wb .ec-wb-updated, .ec-wb .ec-wb-project-row small,
  .ec-wb .ec-wb-run-row small, .ec-wb .ec-wb-artifact-row small,
  .ec-wb .ec-wb-side-count, .ec-wb .ec-wb-side-conn,
  .ec-wb .ec-wb-console-crumb, .ec-wb .ec-wb-fact-line span:first-child, .ec-wb .ec-wb-facts dt,
  .ec-wb .ec-wb-canvas-foot, .ec-wb .ec-wb-pending-empty small { color: var(--ec-muted); }
  .ec-wb .ec-wb-model-row strong, .ec-wb .ec-wb-project-row strong, .ec-wb .ec-wb-run-row strong,
  .ec-wb .ec-wb-artifact-row strong { color: var(--ec-ink); }
  .ec-wb button.ec-wb-button { color: var(--ec-secondary); }
  /* Filled buttons must be re-inked after the generic outline rule above: equal specificity means
     source order decides, and a light label on the jade fill would be unreadable. */
  .ec-wb button.ec-wb-primary { color: #04141a; }
  .ec-wb button.ec-wb-button:hover:not(:disabled) { background: #193239; border-color: #2b5c55; color: var(--ec-primary); }
  .ec-wb button.ec-wb-primary:hover:not(:disabled) { background: var(--ec-primary-hover); border-color: var(--ec-primary-hover); color: #04141a; }
  .ec-wb button.ec-wb-stop { border-color: #5a3a34; color: var(--ec-danger); }
  .ec-wb button.ec-wb-stop:hover:not(:disabled) { background: var(--ec-danger-weak); border-color: #6d463e; color: var(--ec-danger); }
  .ec-wb button.ec-wb-quick-target { background: #0e2228; border-color: var(--ec-line); color: var(--ec-secondary); }
  .ec-wb button.ec-wb-quick-target:hover { background: #0d5c70; border-color: #2b5c55; }
  .ec-wb button.ec-wb-quick-target b { color: var(--ec-primary); }
  .ec-wb button.ec-wb-foot-link, .ec-wb button.ec-wb-project-link, .ec-wb button.ec-wb-readiness-link { color: var(--ec-primary); }
  .ec-wb .ec-wb-badge { background: #193239; color: var(--ec-secondary); }
  .ec-wb .ec-wb-badge[data-tone="ok"] { background: #11312c; color: #6bd0d5; }
  .ec-wb .ec-wb-badge[data-tone="warn"] { background: #33290f; color: var(--ec-amber); }
  .ec-wb .ec-wb-badge[data-tone="error"] { background: #32201c; color: var(--ec-danger); }
  .ec-wb .ec-wb-badge[data-tone="muted"] { background: #193239; color: #b0c9cf; }
  .ec-wb .ec-wb-state-tag { background: #33290f; color: var(--ec-amber); }
  .ec-wb .ec-wb-state-tag::before { background: var(--ec-amber); }
  .ec-wb .ec-wb-state-tag[data-tone="ok"] { background: #11312c; color: #6bd0d5; }
  .ec-wb .ec-wb-state-tag[data-tone="ok"]::before { background: var(--ec-primary); }
  .ec-wb .ec-wb-pill { background: #11312c; color: #6bd0d5; }
  .ec-wb .ec-wb-pill::before { background: var(--ec-primary); }
  .ec-wb .ec-wb-pill[data-tone="warn"] { background: #33290f; color: var(--ec-amber); }
  .ec-wb .ec-wb-pill[data-tone="warn"]::before { background: var(--ec-amber); }
  .ec-wb .ec-wb-pill[data-tone="error"] { background: #32201c; color: var(--ec-danger); }
  .ec-wb .ec-wb-pill[data-tone="error"]::before { background: var(--ec-danger); }
  .ec-wb .ec-wb-pill[data-tone="muted"] { background: #193239; color: var(--ec-secondary); }
  .ec-wb .ec-wb-pill[data-tone="muted"]::before { background: var(--ec-muted); }
  .ec-wb .ec-wb-project-code { background: #193239; color: var(--ec-secondary); }
  .ec-wb .ec-wb-project-card.is-active, .ec-wb .ec-wb-run-button[aria-current="true"] { border-color: #2b5c55; }
  .ec-wb .ec-wb-error { border-color: #5a3a34; }
  .ec-wb .ec-wb-question-title { color: var(--ec-amber); }
  .ec-wb .ec-wb-interaction .ec-wb-input { border-color: #4a3c1d; }
  .ec-wb .ec-wb-search-glyph, .ec-wb button.ec-wb-search-clear { color: var(--ec-muted); }
  .ec-wb button.ec-wb-search-clear:hover { background: #193239; color: var(--ec-primary); }
  .ec-wb .ec-wb-canvas-foot .ec-wb-sep { border-color: var(--ec-line-strong); }
  .ec-wb .ec-wb-field-label, .ec-wb .ec-wb-tick,
  .ec-wb .ec-wb-input::placeholder, .ec-wb .ec-wb-textarea::placeholder { color: var(--ec-muted); }
}
`

/** The desk shell (方案 B) appends its own block; the contract tests read the combined sheet. */
export const WORKBENCH_CSS = BASE_CSS + DESK_CSS