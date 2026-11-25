/** Desk shell styles for the Emerald research work desk (方案 B, appended to WORKBENCH_CSS).
 *
 *  区域次序（plan §2/§5）: 全局导航（宿主 sidebar 列，本文件不重排宿主几何）| 工作索引 | 工作摘要，
 *  或 工作索引 | 原生会话 | 工作资料。列显隐由主区实际宽度的 container query 表达（见 Desk frame
 *  的断点表），而不是用视口媒体查询假设侧栏几何；索引列宽 284px。收起后的索引/资料是临时面板
 *  （`data-desk-panel` / `data-desk-rail`），面板用 absolute 定位覆盖工作台区域——`position: fixed`
 *  仍然只属于命令面板背景（T09 合同）。模板字符串内不能出现反引号。
 *
 *  All colours come from the shell tokens declared in `styles.ts`; the only desk-local tokens
 *  are the row/veil surfaces below (declared light here, re-inked in the desk dark block).
 */
export const DESK_CSS = `
/* ── Desk frame ─────────────────────────────────────────────────────────── */
/* 外层是 inline-size 容器（container query 不能样式化容器自身，所以列切换发生在内层 desk 上）。
   内层 desk 是一个命名区域网格：index（工作索引）| top（顶栏）+ main（主区）。工作索引只挂载
   一份 DOM，由网格区域决定它在哪一档宽度下是列、行内块，还是收起为顶栏按钮的临时面板。
   判定依据是主区实际宽度（含宿主侧栏变化），没有 JS 宽度状态，也没有显隐反馈循环（方案 B §5）。

   断点（每个选择器只在下面声明一次——同特异性的后置规则曾把这里的单列回退整个盖掉）：
     ≥1180px          索引列 | 对话 | 工作资料（三列，对话净宽 ≥ 604px）
     1120–1179.9px    索引列 | 对话；工作资料改为浮层面板
     800–1119.9px     索引收为顶栏「工作索引」按钮的临时面板；对话占满
     <800px           首页：索引作为行内块排在主区上方，选中一项后让位给摘要 */
.ec-wb.ec-wb-desk-outer { height: 100%; overflow: hidden; position: relative; container: ec-desk / inline-size; }
.ec-wb.ec-wb-desk {
  --ec-desk-veil: rgba(8, 34, 38, .45);
  height: 100%; overflow: hidden; position: relative;
  display: grid;
  grid-template-columns: 284px minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-areas: "index top" "index main";
  background: var(--ec-paper);
}
.ec-wb .ec-wb-desk-index {
  grid-area: index;
  min-width: 0; width: 284px; height: 100%;
  display: flex; flex-direction: column; background-color: var(--ec-index-bg); background-image: var(--ec-index-surface-image);
  border-right: 1px solid var(--ec-rail-line); overflow: hidden;
}
.ec-wb.ec-wb-desk .ec-wb-topbar { grid-area: top; min-width: 0; }
.ec-wb.ec-wb-desk .ec-wb-main { grid-area: main; min-width: 0; min-height: 0; overflow: auto; }
.ec-wb.ec-wb-desk .ec-wb-main-session { min-height: 0; overflow: hidden; }
/* 顶栏索引切换按钮：只在索引列收起后出现（<1120px 主区），宽列态隐藏。 */
.ec-wb button.ec-wb-desk-index-toggle { display: none; }
@container ec-desk (max-width: 1119.9px) {
  .ec-wb.ec-wb-desk {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas: "top" "main";
  }
  .ec-wb .ec-wb-desk-index { display: none; }
  .ec-wb button.ec-wb-desk-index-toggle { display: inline-flex; }
}
.ec-wb button.ec-wb-desk-index-toggle {
  /* display 由上面的基础规则（默认 none）与 @container（窄容器 inline-flex）决定。 */
  align-items: center; gap: 7px; height: 30px; padding: 0 12px; flex: none;
  border: 1px solid var(--ec-line); border-radius: 6px; background: var(--ec-white);
  color: var(--ec-secondary); font: inherit; font-size: 12px; cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease;
}
.ec-wb button.ec-wb-desk-index-toggle:hover { background: var(--ec-soft); border-color: var(--ec-line-strong); color: var(--ec-primary); }

/* 基准图 B1 顶栏：左侧两级面包屑（📁 项目 / 视图），右侧「全局搜索 Ctrl K」+ 工具菜单。 */
.ec-wb .ec-wb-breadcrumb-glyph { display: inline-flex; color: var(--ec-muted); flex: none; }
.ec-wb .ec-wb-breadcrumb-root { color: var(--ec-ink); font-weight: 650; }
.ec-wb .ec-wb-breadcrumb-sep { color: var(--ec-muted); }
.ec-wb button.ec-wb-desk-search {
  display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; flex: none;
  border: 1px solid var(--ec-line); border-radius: 7px; background: var(--ec-white);
  color: var(--ec-muted); font: inherit; font-size: 12.5px; cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.ec-wb button.ec-wb-desk-search:hover { background: var(--ec-soft); color: var(--ec-primary); }
.ec-wb button.ec-wb-desk-search kbd {
  font: inherit; font-size: 12px; color: var(--ec-secondary);
  border: 1px solid var(--ec-line); border-radius: 4px; padding: 1px 6px; background: var(--ec-soft);
}
.ec-wb .ec-wb-desk-tools { position: relative; display: inline-flex; flex: none; }
.ec-wb button.ec-wb-desk-tools-trigger {
  width: 32px; height: 32px; display: grid; place-items: center; padding: 0;
  border: 1px solid var(--ec-line); border-radius: 7px; background: var(--ec-white);
  color: var(--ec-secondary); font: inherit; font-size: 15px; cursor: pointer;
  transition: background-color .15s ease, color .15s ease;
}
.ec-wb button.ec-wb-desk-tools-trigger:hover, .ec-wb button.ec-wb-desk-tools-trigger[aria-expanded="true"] { background: var(--ec-soft); color: var(--ec-primary); }
.ec-wb .ec-wb-desk-tools-menu {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 25; min-width: 176px;
  display: flex; flex-direction: column; padding: 6px;
  border: 1px solid var(--ec-line); border-radius: 8px; background: var(--ec-white); box-shadow: var(--ec-shadow-3);
}
.ec-wb button.ec-wb-desk-tools-item {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%;
  border: 0; border-radius: 6px; background: transparent; padding: 8px 10px;
  color: var(--ec-ink); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
}
.ec-wb button.ec-wb-desk-tools-item:hover { background: var(--ec-soft); }
.ec-wb button.ec-wb-desk-tools-item[aria-checked="true"]::after { content: "✓"; color: var(--ec-primary); font-size: 12px; }

/* ── Work index (「我的工作」主从列表) ───────────────────────────────────── */
.ec-wb .ec-wb-desk-index-frame { flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* 基准图 12 号稿：索引列是深青绿面板，顶部为「Emerald 工作台」品牌行。 */
.ec-wb .ec-wb-desk-brand { margin: 0; padding: 16px 14px 2px; font-size: 17px; letter-spacing: -.01em; font-weight: 750; color: var(--ec-index-ink); }
.ec-wb .ec-wb-desk-brand small { margin-left: 7px; font-size: 12px; font-weight: 500; letter-spacing: 0; color: var(--ec-index-text); }
.ec-wb .ec-wb-desk-index-head { flex: none; position: relative; display: flex; flex-direction: column; gap: 10px; padding: 14px 14px 8px; }
.ec-wb .ec-wb-desk-index-title { margin: 0; font-size: 20px; line-height: 1.2; letter-spacing: -.02em; font-weight: 700; color: var(--ec-index-ink); }
/* 基准图 12 号稿：标题行右侧的绿色方块 ＋ 是索引创建入口（走既有 create 意图）。 */
.ec-wb .ec-wb-desk-index-tools { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ec-wb button.ec-wb-desk-index-add {
  width: 30px; height: 30px; flex: none; display: grid; place-items: center; padding: 0;
  border: 0; border-radius: 8px; background: var(--ec-primary); color: #fff;
  font: inherit; font-size: 16px; line-height: 1; cursor: pointer;
  box-shadow: var(--ec-shadow-2); transition: background-color .15s ease;
}
.ec-wb button.ec-wb-desk-index-add:hover { background: var(--ec-primary-hover); }
.ec-wb .ec-wb-desk-index-search { position: relative; display: flex; align-items: center; min-width: 0; }
.ec-wb .ec-wb-desk-index-search .ec-wb-search-glyph { position: absolute; left: 10px; color: var(--ec-index-muted); pointer-events: none; display: inline-flex; }
.ec-wb .ec-wb-desk-index-search .ec-wb-search-input {
  width: 100%; min-height: 34px; padding: 0 30px 0 30px; font-size: 12.5px;
  background-color: var(--ec-input-deep-bg); border: 1px solid var(--ec-input-deep-border); color: #ffffff;
}
.ec-wb .ec-wb-desk-index-search .ec-wb-search-input::placeholder { color: var(--ec-index-muted); }
.ec-wb .ec-wb-desk-index-search button.ec-wb-desk-filter {
  position: absolute; right: 6px; width: 24px; height: 24px; display: grid; place-items: center; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--ec-index-muted); cursor: pointer;
}
.ec-wb .ec-wb-desk-index-search button.ec-wb-desk-filter:hover { background: var(--ec-index-hover); color: var(--ec-index-ink); }
.ec-wb .ec-wb-desk-index-search button.ec-wb-desk-filter[aria-expanded="true"] { color: var(--ec-index-accent); }
.ec-wb .ec-wb-desk-filter-count { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--ec-index-accent); color: #06262e; font-size: 12px; font-weight: 700; line-height: 16px; display: inline-grid; place-items: center; }
/* 筛选浮层：与深面板同族的深色卡，Escape/再点漏斗关闭（非模态弹出层）。 */
.ec-wb .ec-wb-desk-filter-panel {
  position: absolute; top: calc(100% + 26px); right: 14px; z-index: 20; width: min(250px, calc(100% - 28px));
  display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px;
  border: 1px solid var(--ec-index-line); border-radius: 8px; background: var(--ec-input-deep-bg);
  box-shadow: var(--ec-shadow-3);
}
.ec-wb .ec-wb-desk-filter-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ec-index-muted); }
.ec-wb .ec-wb-desk-filter-panel .ec-wb-select { min-height: 30px; font-size: 12px; width: 100%; background: transparent; border-color: var(--ec-index-line); color: var(--ec-index-ink); }
.ec-wb .ec-wb-desk-filter-panel .ec-wb-select option { color: var(--ec-ink); }
.ec-wb .ec-wb-desk-filter-panel .ec-wb-form-actions { margin: 0; }
.ec-wb .ec-wb-desk-filter-panel .ec-wb-button { background: transparent; border-color: var(--ec-index-line); color: var(--ec-index-text); }
.ec-wb .ec-wb-desk-index-list { flex: 1; min-height: 0; overflow: auto; padding: 2px 10px 12px; display: flex; flex-direction: column; }
.ec-wb .ec-wb-desk-section { display: flex; flex-direction: column; }
.ec-wb .ec-wb-desk-section-label { font-size: 12px; font-weight: 700; color: var(--ec-index-muted); padding: 14px 8px 6px; }
.ec-wb button.ec-wb-desk-row {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px;
  width: 100%; border: 0; background: transparent; border-radius: 8px; padding: 9px 10px;
  cursor: pointer; text-align: left; font: inherit; transition: background-color .15s ease;
}
.ec-wb button.ec-wb-desk-row:hover { background: var(--ec-index-hover); }
.ec-wb button.ec-wb-desk-row[aria-current="true"] { background: var(--ec-index-active); box-shadow: inset 3px 0 0 var(--ec-index-accent); }
.ec-wb button.ec-wb-desk-row:focus-visible { outline: 2px solid var(--ec-focus-deep); outline-offset: -2px; }
.ec-wb .ec-wb-desk-row-icon {
  width: 30px; height: 30px; flex: none; border-radius: 7px; background: transparent;
  border: 1px solid var(--ec-index-line); display: grid; place-items: center;
  font-size: 12px; font-weight: 700; color: var(--ec-index-text);
}
.ec-wb button.ec-wb-desk-row[aria-current="true"] .ec-wb-desk-row-icon { color: var(--ec-index-accent); border-color: var(--ec-index-accent); }
.ec-wb .ec-wb-desk-row-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ec-wb .ec-wb-desk-row-title { font-size: 14px; font-weight: 640; color: var(--ec-index-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ec-wb .ec-wb-desk-row-project { font-size: 12px; color: var(--ec-index-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ec-wb .ec-wb-desk-row-tags { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 2px; }
.ec-wb .ec-wb-desk-row-chip { font-size: 12px; font-weight: 650; padding: 1.5px 7px; border-radius: 999px; background: rgba(217, 164, 76, .18); color: var(--ec-rail-warn); white-space: nowrap; }
.ec-wb .ec-wb-desk-row-chip[data-tone="error"] { background: rgba(226, 143, 128, .18); color: var(--ec-danger); }
.ec-wb .ec-wb-desk-row-chip[data-tone="muted"] { background: rgba(143, 176, 181, .16); color: var(--ec-index-text); }
.ec-wb .ec-wb-desk-row-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: none; }
.ec-wb .ec-wb-desk-row-time { font-size: 12px; color: var(--ec-index-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ec-wb .ec-wb-desk-row-current { font-size: 12px; font-weight: 700; color: var(--ec-index-accent); white-space: nowrap; }
.ec-wb .ec-wb-desk-index-empty { padding: 18px 12px 22px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.ec-wb .ec-wb-desk-index-empty p { font-size: 12.5px; color: var(--ec-index-muted); line-height: 1.6; }
.ec-wb .ec-wb-desk-index-empty .ec-wb-button { background: transparent; border-color: var(--ec-index-line); color: var(--ec-index-text); }
.ec-wb .ec-wb-desk-index-note { padding: 0 12px 8px; font-size: 12px; }
.ec-wb .ec-wb-desk-index-foot {
  flex: none; border-top: 1px solid var(--ec-index-line); padding: 9px 14px;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 12px; color: var(--ec-index-muted); font-variant-numeric: tabular-nums;
}
.ec-wb .ec-wb-desk-index-foot button.ec-wb-text-link { font-size: 12px; flex: none; color: var(--ec-index-accent); }
.ec-wb .ec-wb-desk-index-foot button.ec-wb-text-link:disabled { opacity: .6; cursor: default; }

/* 窄屏单列首页：索引排在主区上方（见下方 <800px 规则），动作回到列表有明确返回。 */
.ec-wb .ec-wb-desk-back {
  display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 4px; margin-bottom: 4px;
  border: 0; background: none; color: var(--ec-secondary); font: inherit; font-size: 13px; cursor: pointer;
}
.ec-wb .ec-wb-desk-back:hover { color: var(--ec-primary); }

/* ── Temporary panels (index / rail share ONE slot: data-desk-panel) ─────── */
.ec-wb .ec-wb-desk-panel-backdrop { position: absolute; inset: 0; z-index: 40; background: var(--ec-desk-veil); }
.ec-wb .ec-wb-desk-panel {
  position: absolute; top: 0; bottom: 0; left: 0; z-index: 41; width: min(340px, 88%);
  background-color: var(--ec-index-bg); background-image: var(--ec-index-surface-image);
  border-right: 1px solid var(--ec-rail-line); box-shadow: var(--ec-shadow-3);
  display: flex; flex-direction: column; padding: 0;
}
.ec-wb .ec-wb-desk-panel .ec-wb-desk-index { width: 100%; border-right: 0; background: transparent; }

/* ── Work brief (选中工作的只读摘要) ─────────────────────────────────────── */
.ec-wb .ec-wb-brief-wrap { max-width: 1040px; width: 100%; margin: 0 auto; padding: 28px clamp(20px, 4vw, 46px) 56px; display: flex; flex-direction: column; gap: 26px; }
.ec-wb .ec-wb-brief-head { display: flex; flex-direction: column; gap: 10px; }
.ec-wb .ec-wb-brief-status-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ec-wb .ec-wb-brief-app { font-size: 13px; font-weight: 600; color: var(--ec-muted); }
.ec-wb .ec-wb-brief-title { margin: 0; font-size: clamp(30px, 3.4vw, 40px); line-height: 1.15; letter-spacing: -.025em; font-weight: 750; color: var(--ec-ink); overflow-wrap: anywhere; }
.ec-wb .ec-wb-brief-facts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--ec-muted); }
.ec-wb .ec-wb-brief-facts b { color: var(--ec-secondary); font-weight: 600; }
/* 基准图 B1：标题下的目标句（员工录入的 goal，不是编造的结论）。 */
.ec-wb .ec-wb-brief-goal { margin: 0; font-size: 15px; line-height: 1.6; color: var(--ec-secondary); max-width: 72ch; }
.ec-wb .ec-wb-brief-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 8px; }
.ec-wb button.ec-wb-brief-enter {
  height: 44px; padding: 0 18px; display: inline-flex; align-items: center; gap: 9px; flex: none;
  background-color: var(--ec-primary); background-image: var(--ec-enter-image); color: #fff; border: 0; border-radius: 8px;
  font: inherit; font-size: 14px; font-weight: 650; cursor: pointer;
  transition: background-color .15s ease, background-image .15s ease;
}
.ec-wb button.ec-wb-brief-enter:hover:not(:disabled) { background-image: none; background-color: var(--ec-enter-hover-bg); }
.ec-wb button.ec-wb-brief-enter:active:not(:disabled) { background-image: none; background-color: var(--ec-enter-pressed-bg); }
.ec-wb button.ec-wb-brief-enter:disabled { background-image: none; opacity: .55; cursor: default; }
.ec-wb button.ec-wb-brief-link {
  display: inline-flex; align-items: center; gap: 6px; border: 0; background: none; padding: 0;
  color: var(--ec-secondary); font: inherit; font-size: 13.5px; cursor: pointer;
}
.ec-wb button.ec-wb-brief-link:hover { color: var(--ec-primary); text-decoration: underline; }
.ec-wb .ec-wb-brief-section { display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--ec-line); padding-top: 22px; }
.ec-wb .ec-wb-brief-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.ec-wb .ec-wb-brief-section-head h2 { margin: 0; font-size: 21px; font-weight: 700; letter-spacing: -.01em; color: var(--ec-ink); }
.ec-wb .ec-wb-brief-section-head small { font-size: 12px; color: var(--ec-muted); font-variant-numeric: tabular-nums; }
.ec-wb .ec-wb-brief-empty {
  border: 1px dashed var(--ec-line-strong); border-radius: 12px; background: var(--ec-white);
  padding: 26px 24px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start;
  color: var(--ec-muted); font-size: 13px; line-height: 1.6;
}
.ec-wb .ec-wb-brief-stage { max-width: 1040px; width: 100%; margin: 0 auto; padding: 28px clamp(20px, 4vw, 46px) 56px; display: flex; flex-direction: column; gap: 18px; }
.ec-wb .ec-wb-brief-stage .ec-wb-empty-state { border: 1px dashed var(--ec-line-strong); border-radius: 12px; background: var(--ec-white); padding: 40px 28px; display: flex; flex-direction: column; gap: 14px; align-items: center; text-align: center; color: var(--ec-muted); font-size: 13.5px; }
.ec-wb .ec-wb-empty-state h2 { margin: 0; font-size: 20px; color: var(--ec-ink); }

/* 工作底稿: 通用格式封面 — 不伪造工作表、页数或内容说明。 */
.ec-wb .ec-wb-artifact-card { border: 1px solid var(--ec-line); border-radius: 12px; background: var(--ec-white); padding: 18px 20px; display: flex; gap: 18px; align-items: stretch; }
.ec-wb .ec-wb-artifact-cover {
  width: 112px; min-height: 112px; flex: none; border-radius: 10px; position: relative; overflow: hidden;
  background: #dde7e7;
  border: 1px solid var(--ec-line);
  display: grid; place-items: center;
}
.ec-wb .ec-wb-artifact-cover::before { content: ""; position: absolute; left: 14px; top: 14px; right: 14px; bottom: 14px; border-radius: 6px; background: var(--ec-white); box-shadow: 0 2px 6px rgba(14, 42, 48, .10); transform: rotate(-2deg); }
.ec-wb .ec-wb-artifact-cover::after { content: ""; position: absolute; right: 10px; top: 10px; width: 20px; height: 20px; background: linear-gradient(225deg, #dde7e7 50%, rgba(10, 90, 98, .22) 50%); border-radius: 0 0 0 6px; }
.ec-wb .ec-wb-artifact-cover b { position: relative; font-size: 15px; font-weight: 750; letter-spacing: .05em; color: var(--ec-secondary); }
.ec-wb .ec-wb-artifact-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; padding: 2px 0; }
.ec-wb .ec-wb-artifact-name { font-size: 16.5px; font-weight: 680; color: var(--ec-ink); overflow-wrap: anywhere; }
.ec-wb .ec-wb-artifact-meta { font-size: 12.5px; color: var(--ec-muted); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
.ec-wb .ec-wb-artifact-meta i { font-style: normal; display: inline-flex; align-items: center; gap: 5px; }
.ec-wb .ec-wb-artifact-meta i::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--ec-muted); }
.ec-wb .ec-wb-artifact-meta i[data-tone="ok"]::before { background: var(--ec-green); }
.ec-wb .ec-wb-artifact-meta i[data-tone="warn"]::before { background: var(--ec-amber); }
.ec-wb .ec-wb-artifact-foot { margin-top: auto; padding-top: 8px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ec-wb .ec-wb-artifact-hint { font-size: 12.5px; color: var(--ec-muted); }
.ec-wb button.ec-wb-artifact-download {
  display: inline-flex; align-items: center; gap: 7px; border: 0; background: none; padding: 0; flex: none;
  color: var(--ec-primary); font: inherit; font-size: 13px; font-weight: 650; cursor: pointer;
}
.ec-wb button.ec-wb-artifact-download:hover:not(:disabled) { text-decoration: underline; }
.ec-wb button.ec-wb-artifact-download:disabled { opacity: .55; cursor: default; }
.ec-wb .ec-wb-artifact-list { border: 1px solid var(--ec-line); border-radius: 12px; background: var(--ec-white); overflow: hidden; }
.ec-wb .ec-wb-artifact-line { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--ec-line-soft); min-width: 0; }
.ec-wb .ec-wb-artifact-line:first-child { border-top: 0; }
.ec-wb .ec-wb-artifact-line .ec-wb-artifact-name { font-size: 14px; flex: 1; min-width: 0; }

/* 最新活动: 只展示已记录的动作与时间。 */
.ec-wb .ec-wb-activity-list { display: flex; flex-direction: column; }
.ec-wb .ec-wb-activity-row { display: flex; align-items: baseline; gap: 12px; padding: 11px 2px; border-top: 1px solid var(--ec-line-soft); font-size: 13px; min-width: 0; }
.ec-wb .ec-wb-activity-row:first-child { border-top: 0; }
.ec-wb .ec-wb-activity-row strong { flex: none; font-weight: 650; color: var(--ec-ink); }
.ec-wb .ec-wb-activity-row > span { flex: 1; min-width: 0; color: var(--ec-secondary); overflow-wrap: anywhere; }
.ec-wb .ec-wb-activity-row time { flex: none; font-size: 12px; color: var(--ec-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }

/* ── Console rail groups (B4): 可辨的「当前运行 / 待处理 / 发起执行 / 文件成果 / 运行记录」 ── */
.ec-wb .ec-wb-rail-title { margin: 0 0 2px; font-size: 16px; font-weight: 700; letter-spacing: -.01em; color: var(--ec-ink); }
.ec-wb .ec-wb-rail-group { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ec-wb .ec-wb-rail-group-title { margin: 0; font-size: 12px; font-weight: 750; letter-spacing: .03em; color: var(--ec-muted); padding: 0 2px; }
/* 基准图 B2：运行记录是竖线时间轴（dot + 连接线），会话对话行保持普通按钮。 */
.ec-wb .ec-wb-card.ec-wb-runs-card { position: relative; }
.ec-wb .ec-wb-card.ec-wb-runs-card .ec-wb-run-row { position: relative; padding-left: 22px; }
.ec-wb .ec-wb-card.ec-wb-runs-card .ec-wb-run-row .ec-wb-run-dot { position: absolute; left: 2px; top: 16px; }
.ec-wb .ec-wb-card.ec-wb-runs-card .ec-wb-run-row::after { content: ""; position: absolute; left: 4.5px; top: 24px; bottom: -10px; width: 1px; background: var(--ec-line); }
.ec-wb .ec-wb-card.ec-wb-runs-card .ec-wb-run-row:last-of-type::after { display: none; }
/* 工作资料：主区 <1180px 时右栏不再是常驻列（三列会把对话挤到 600px 以下），改为「工作资料」按钮
   打开的浮层面板。open 态必须显式写 display——它与 closed 态的 display:none 同特异性，只靠定位
   属性盖不回去（2026-11-24 修复：此前 ≤1180px 资料整栏不可达）。 */
.ec-wb button.ec-wb-rail-toggle { display: none; }
/* 右栏「工作资料」：品牌浅青表面（13 号稿），列态与面板态同源 token。 */
.ec-wb .ec-wb-console-rail { background: var(--ec-console-rail-bg); }
@container ec-desk (max-width: 1179.9px) {
  .ec-wb .ec-wb-console-body[data-desk-rail] { position: relative; grid-template-columns: minmax(0, 1fr); }
  .ec-wb .ec-wb-console-body[data-desk-rail="closed"] .ec-wb-console-rail { display: none; }
  .ec-wb .ec-wb-console-body[data-desk-rail="open"] .ec-wb-console-rail {
    display: flex; flex-direction: column;
    position: absolute; top: 0; right: 0; bottom: 0; z-index: 30; width: min(400px, 100%);
    background: var(--ec-console-rail-bg); border-left: 1px solid var(--ec-line); box-shadow: var(--ec-shadow-3);
    padding: 14px; overflow: auto;
  }
  .ec-wb button.ec-wb-rail-toggle { display: inline-flex; }
}

/* ── Work home: ≥800px 摘要占满主区（索引列 ≥1120px，否则是顶栏按钮的临时面板）；
     <800px 索引作为行内块排在主区上方（自身限高、列表内滚动），选中一项后让位给摘要并给出明确
     返回。data-home-mode 在 desk 根上，由页面按“是否有摘要或创建表单在显示”给出。 ── */
@container ec-desk (max-width: 799.9px) {
  .ec-wb.ec-wb-desk[data-desk-view="home"] {
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-areas: "top" "index" "main";
  }
  .ec-wb.ec-wb-desk[data-desk-view="home"] .ec-wb-desk-index {
    display: flex; width: 100%; height: auto; max-height: 46vh; min-height: 132px;
    border-right: 0; border-bottom: 1px solid var(--ec-index-line);
  }
  /* 选中一行（data-home-mode="brief"）后索引让位给摘要。 */
  .ec-wb.ec-wb-desk[data-desk-view="home"][data-home-mode="brief"] {
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas: "top" "main";
  }
  .ec-wb.ec-wb-desk[data-desk-view="home"][data-home-mode="brief"] .ec-wb-desk-index { display: none; }
  .ec-wb .ec-wb-page-home .ec-wb-home-brief { display: none; }
  .ec-wb.ec-wb-desk[data-home-mode="brief"] .ec-wb-page-home .ec-wb-home-brief { display: block; }
  .ec-wb.ec-wb-desk[data-home-mode="brief"] .ec-wb-page-home .ec-wb-desk-back { display: inline-flex; }
}
.ec-wb .ec-wb-page-home .ec-wb-desk-back { display: none; }

/* ── Desk dark theme: same semantics, dark surfaces; the global rail stays dark in both themes ── */
@media (prefers-color-scheme: dark) {
  .ec-wb.ec-wb-desk {
    --ec-desk-veil: rgba(0, 0, 0, .52);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ec-wb.ec-wb-desk *, .ec-wb.ec-wb-desk *::before, .ec-wb.ec-wb-desk *::after { transition: none; }
}

  /* ── V5 direct-workbench alignment ─────────────────────────────────────── */
  /* 2026-11-24：这里曾有一条无条件的 desk 网格列宽声明（284px + 1fr），排在
     上面的容器查询单列规则之后、同特异性，把 <1120px 的单列回退整个盖掉（主区 800–1120px 时主区被
     挤进 284px 列）；另有一条 ≤1180px 无条件隐藏工作资料的规则。列宽与断点现在只在 Desk frame
     声明一次，本块只保留配色、间距与字号。模板字符串内不要写反引号。 */
  .ec-wb.ec-wb-desk-outer { background: #f2f6f4; }
  .ec-wb.ec-wb-desk { background: #fff; }
  .ec-wb .ec-wb-desk-index { width: 284px; background: #fbfdfc; border-right: 1px solid #dce8e6; }
  .ec-wb .ec-wb-desk-brand { color: #102e35; padding: 22px 15px 3px; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; }
  .ec-wb .ec-wb-desk-brand small { display: none; }
  .ec-wb .ec-wb-desk-index-head { padding: 18px 15px 10px; gap: 12px; }
  /* 「＋ 新建工作」是横向胶囊按钮，文字来自 DOM（work-index.tsx）；不注入、不堆叠。 */
  .ec-wb button.ec-wb-desk-index-add {
    display: inline-flex; align-items: center; gap: 5px; width: auto; height: 28px; padding: 0 11px;
    border-radius: 6px; background: #16a486; color: #ffffff; font-size: 12px; font-weight: 700; line-height: 1;
  }
  .ec-wb button.ec-wb-desk-index-add .ec-wb-desk-index-add-plus { font-size: 13px; }
  .ec-wb button.ec-wb-desk-index-add .ec-wb-desk-index-add-label { white-space: nowrap; }
  .ec-wb .ec-wb-desk-index-search .ec-wb-search-input { min-height: 32px; padding-left: 30px; background: #fff; border: 1px solid #dce8e6; color: #102e35; }
  .ec-wb .ec-wb-desk-index-search .ec-wb-search-input::placeholder { color: #9eafad; }
  .ec-wb .ec-wb-desk-index-search .ec-wb-search-glyph, .ec-wb .ec-wb-desk-index-search button.ec-wb-desk-filter { color: #96aaa9; }
  .ec-wb .ec-wb-desk-index-list { padding: 2px 15px 12px; }
  .ec-wb .ec-wb-desk-section-label { color: #899f9e; padding: 16px 3px 7px; }
  .ec-wb button.ec-wb-desk-row { padding: 9px 7px; border-radius: 7px; gap: 9px; }
  .ec-wb button.ec-wb-desk-row:hover, .ec-wb button.ec-wb-desk-row[aria-current="true"] { background: #eaf5f1; }
  .ec-wb button.ec-wb-desk-row[aria-current="true"] { box-shadow: inset 3px 0 0 #16a486; }
  .ec-wb .ec-wb-desk-row-icon { width: 27px; height: 27px; border-radius: 7px; border: 0; background: #e3f5ec; color: #1b896b; }
  /* 字阶回到方案 B §5：工作行 14–15px、辅助信息 ≥12px（曾压到 11.5px / 10px）。 */
  .ec-wb .ec-wb-desk-row-title { color: #102e35; font-size: 14px; }
  .ec-wb .ec-wb-desk-row-project, .ec-wb .ec-wb-desk-row-time { color: #8ba09f; font-size: 12px; }
  .ec-wb .ec-wb-desk-index-foot { color: #8ba09f; border-top-color: #dce8e6; }
  .ec-wb .ec-wb-console { height: 100%; background: #fff; }
  .ec-wb .ec-wb-console-head { padding: 23px 34px 14px; border-bottom: 1px solid #edf2f0; }
  .ec-wb .ec-wb-console-crumb { color: #71908d; font-size: 12px; }
  .ec-wb .ec-wb-console-title { color: #102e35; font-size: 20px; letter-spacing: -.035em; }
  .ec-wb .ec-wb-console-body { grid-template-columns: minmax(0, 1fr) 292px; gap: 0; }
  .ec-wb .ec-wb-console-center { background: #fff; overflow: hidden; }
  /* 中心只有一个原生会话流（2026-11-23）：thread 占满中心列全高，运行视图不再叠加其上。 */
  .ec-wb .ec-wb-console-thread { width: 100%; max-width: 100%; min-height: 0; height: auto; flex: 1 1 auto; margin: 0; padding: 0; overflow: hidden; border-top: 0; }
  .ec-wb .ec-wb-console-thread > .ec-wb-session-conversation { height: 100%; min-height: 0; max-height: 100%; flex: 1 1 auto; overflow: hidden; }
  /* 右栏运行记录卡：抄本正文在卡内自滚动，不撑长右栏。 */
  .ec-wb .ec-wb-rail-transcript .ec-wb-transcript { border: 0; }
  .ec-wb .ec-wb-rail-transcript .ec-wb-transcript-body { max-height: 320px; padding-right: 6px; }
  .ec-wb .ec-wb-console-rail { background: #f7faf8; border-left: 1px solid #dce8e6; padding: 23px 18px 16px; }
  .ec-wb .ec-wb-rail-title { font-size: 15px; color: #102e35; }
  .ec-wb .ec-wb-rail-group-title { color: #577270; letter-spacing: 0; text-transform: none; }
  .ec-wb .ec-wb-card { border-color: #dce8e6; border-radius: 7px; box-shadow: none; }
  @container ec-desk (max-width: 560px) { .ec-wb .ec-wb-console-head { padding: 18px 14px 12px; } }
  @media (prefers-reduced-motion: reduce) { .ec-wb.ec-wb-desk *, .ec-wb.ec-wb-desk *::before, .ec-wb.ec-wb-desk *::after { transition: none !important; } }
}
`
