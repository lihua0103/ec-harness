// ═══════════════════════════════════════════════════════════════════════════
// 模块演示视频 walk 模板（S1 录制；企业插件 @dsh-enterprise/demo-video 随包资产）
// 复制到 <workDir>/walk.mjs 后只改下面三个【模块适配区】，其余保持原样：
//   ① G 区谓词（列表/详情判定——双语概念对）
//   ② clickMenu*** 菜单入口（改菜单正则与 hash 兜底路由）
//   ③ 主流程 try 块「===== 段落 =====」区块（模块步骤；全部用 doAim/doAimClick/rowOp/tabOps，
//      每步前 act('旁白锚点key')；写库类按钮只 doAim 高亮）
// 通用机制（勿删）：英文界面注入、闪光标记（掐头）、act() 黑条打点（配音同步）、
//   ensureCtx 被踢自愈（登录被拒不循环重试）、双语别名查找器、SVG/dropdown/select 交互兜底、
//   closeOverlay 三段式 + purgeStrayPoppers + assertClean（弹层卫生三件套，防遮罩累积/幽灵下拉）、
//   scrollSteps（长页逐屏滚动，带出懒渲染）、cjk() 语言体检（可见性过滤中文计数，S0 门禁）。
//
// 运行契约（enterprise_demo_record 工具按此驱动，本脚本不解析命令行参数）：
//   环境变量 DV_WORK（工作目录，必填）/ DV_BASE / DV_USER / DV_PASS /
//   DV_VERSION / DV_MODULE / DV_CHROME（Chromium 路径）/ DV_PW（playwright-core 包目录）。
//   依赖 ./cursor.mjs 与本脚本同目录（录制工具会自动同步）。
//   产物：<DV_WORK>/timings.json = { module, steps[], actions[], totalDuration,
//   video, flashWall, navigations }；webm 落 <DV_WORK>/record/。
//   timings.json 是 S2 锚点阶段的输入契约：flashWall=闪光注入的墙钟秒。
//
// 原型实例：目标系统某风险管理模块全功能连贯走查（英文界面/每动作黑条打点）。
// 数据安全（红线，最高优先级）：全程只做「打开弹窗→取消」，绝不提交；
//   无确认层、会直接写库的按钮只高亮不点击；真实点击必须经用户明确同意并在交付说明写明。
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = require(process.env.DV_PW || 'playwright-core');
import { installCursor, ensureCursor } from './cursor.mjs';

const WORK = process.env.DV_WORK;
if (!WORK) { console.error('[fatal] 缺少 DV_WORK 环境变量'); process.exit(2); }
const MODULE = (process.env.DV_MODULE || 'demo').replace(/[^\w.-]/g, '') || 'demo';
const WORKREC = path.join(WORK, 'record');
const VDIR = WORKREC;
fs.mkdirSync(VDIR, { recursive: true });

const strip = s => String(s || '').replace(/`/g, '');
// 账号经环境变量注入（工具侧默认走宿主凭据解析，明文不进模型上下文）
const USER = strip(process.env.DV_USER || '');
const PASS = strip(process.env.DV_PASS || '');
// BASE 先 trim 再规范成「origin+path+/」后拼 hash。
// 两个坑都实测踩过：①cmd 的 `set VAR=v && cmd` 会把空格并入变量值，不 trim 时拼出来的
// URL 变成 "http://host␣/" → page.goto 抛 Cannot navigate to invalid URL；
// ②直接拼 '#/...'（无尾斜杠）同样非法，且异常被 catch 吞掉后整段会静默停在详情页。
const BASE = (process.env.DV_BASE || '').trim().replace(/#.*$/, '').replace(/\/+$/, '') + '/';
const hashTo = h => BASE + '#' + (h.startsWith('/') ? h : '/' + h);
const BASE_DESC = (() => { try { const u = new URL(BASE); return (u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? 'local' : 'remote') + ':' + u.port; } catch { return '(非法)'; } })();
const DEMO_VERSION = process.env.DV_VERSION || 'Version2'; // 演示版本：选已发布、各 tab 均有数据的版本（编辑控件按发布态置灰）

const sleep = ms => new Promise(r => setTimeout(r, ms));
const maskUrl = u => String(u).replace(/\/\/[^/]+/, '//[内部域名]');
const t0 = Date.now();
const steps = [], actions = [];
// 闪光墙钟秒（掐头对齐基准）：try 内赋值，finally 写入 timings.json（S2 契约字段）
let flashWall = null;
const step = (name, ok, extra = '') => { steps.push({ name, ok, t: +(((Date.now() - t0) / 1000).toFixed(2)) }); console.log(`[step] ${name}: ${ok ? 'OK' : 'FAIL'}${extra ? ' | ' + extra : ''}`); };
// 动作打点：除了记墙钟，还在画面顶边闪一条 120x6 黑条（110ms，肉眼不可见）——
// 后期 crop=120:6:0:0 + 逐帧 YMIN 帧簇提取「真实视频时刻」，彻底绕开 webm 时钟漂移
// （旧 blackdetect 口径已弃用：闪光帧可能被虚拟光标压住、深色侧边栏 luma 恰在 pix_th 临界）。
const act = key => {
  actions.push({ key, t: +(((Date.now() - t0) / 1000).toFixed(2)) });
  page.evaluate(() => {
    const b = document.createElement('div');
    b.className = '__dmvBlip';
    b.style.cssText = 'position:fixed;left:0;top:0;width:120px;height:6px;background:#000;z-index:2147483000;pointer-events:none;';
    document.documentElement.appendChild(b);
    setTimeout(() => b.remove(), 110);
  }).catch(() => {});
};
const beat = ms => sleep(ms);

// ---------- 页面侧查找器（注入一次，幂等）【模块适配区①：alias 表与专用查找器】 ----------
const FINDER_SRC = `
(() => {
  if (window.__dmvFind) return;
  window.__dmvFind = {
    norm: s => (s || '').replace(/\\s+/g, ''),
    vis: el => { const r = el && el.getBoundingClientRect(); return !!r && r.height > 0 && r.width > 0; },
    // 中→英别名（英文界面下按中文调用仍能命中；norm 后比较，空白不敏感）
    alias: {
      '导出': ['Export'], '导出列表': ['ExportList'], '导出稽查轨迹': ['ExportAuditTrail'],
      '创建RACT': ['CreateRACT'], '稽查轨迹': ['AuditTrail'], '发布': ['Publish'],
      '编辑': ['Edit'], '删除': ['Delete'], '详情': ['Details'], '添加': ['Add'], '保存': ['Save'],
      '取消': ['Cancel'], '确定': ['Confirm'], '查询': ['Search'], '重置': ['Reset'],
      '关键过程': ['CriticalProcess'], '关键数据': ['CriticalData'],
      '风险定义&评估': ['RiskDefinition&Assessment', 'RiskDefinitionAndAssessment'],
      '风险缓解措施': ['RiskMitigation'], '参与者': ['Participants'],
      '待缓解问题': ['Issuestomitigate'], '待缓解分类': ['Categorytomitigate'], '已缓解': ['mitigated'],
      '新建风险分类': ['NewRiskCategory'], '评估': ['CategoryAssessment'],
      'RACT版本': ['RACTVersion'], '登录': ['Login']
    },
    eq(text, el) {
      const self = this, n = self.norm(el.textContent);
      if (n === self.norm(text)) return true;
      return (self.alias[self.norm(text)] || []).some(a => n === self.norm(a));
    },
    btn(text, opt) {
      opt = opt || {};
      const self = this;
      const scope = opt.scope || 'button, .el-button, .el-dropdown-menu__item, .el-select-dropdown__item, .el-tabs__item';
      let cands = [...document.querySelectorAll(scope)].filter(self.vis);
      if (opt.inTable === true) cands = cands.filter(x => !!x.closest('.el-table__body-wrapper, .el-table__fixed'));
      if (opt.inTable === false) cands = cands.filter(x => !x.closest('.el-table'));
      if (opt.row != null) {
        const rows = [...document.querySelectorAll('.el-table__body-wrapper tbody tr, .el-table__fixed tbody tr')].filter(self.vis);
        if (!rows[opt.row]) return false;
        cands = cands.filter(x => rows[opt.row].contains(x));
      }
      const el = opt.exact === false
        ? cands.find(x => { const n = self.norm(x.textContent); return n.indexOf(self.norm(text)) >= 0 || (self.alias[self.norm(text)] || []).some(a => n.indexOf(a) >= 0); })
        : cands.find(x => self.eq(text, x));
      return el ? window.__dmvCursor.aim(el) : false;
    },
    // 行内/全局操作：先表格内，找不到再全局（部分问题列表不是 el-table）
    rowBtn(text, row) {
      const self = this;
      if (self.btn(text, { inTable: true, row: row })) return true;
      return self.btn(text, { inTable: false });
    },
    // 工具条按钮：优先表格外（避免误命中行内同名按钮），找不到再全局兜底
    toolBtn(text) {
      const self = this;
      if (self.btn(text, { inTable: false })) return true;
      return self.btn(text, {});
    },
    // 探测按钮状态：missing / disabled / enabled（已发布版本的编辑控件会置灰，点了不会有反应）
    btnState(text, opt) {
      opt = opt || {};
      const self = this;
      const scope = opt.scope || 'button, .el-button';
      let cands = [...document.querySelectorAll(scope)].filter(self.vis);
      if (opt.inTable === true) cands = cands.filter(x => !!x.closest('.el-table__body-wrapper, .el-table__fixed'));
      if (opt.row != null) {
        const rows = [...document.querySelectorAll('.el-table__body-wrapper tbody tr')].filter(self.vis);
        if (!rows[opt.row]) return 'missing';
        cands = cands.filter(x => rows[opt.row].contains(x));
      }
      const el = cands.find(x => self.eq(text, x));
      if (!el) return 'missing';
      return (el.disabled || el.classList.contains('is-disabled') || el.getAttribute('aria-disabled') === 'true') ? 'disabled' : 'enabled';
    },
    dlgBtn(text, opt) {
      opt = opt || {};
      const self = this;
      const box = [...document.querySelectorAll(opt.mb ? '.el-message-box' : '.el-dialog')].find(self.vis);
      if (!box) return false;
      const el = [...box.querySelectorAll('button, .el-button')].filter(self.vis).find(x => self.eq(text, x));
      return el ? window.__dmvCursor.aim(el) : false;
    },
    dlgClose() {
      const self = this;
      const box = [...document.querySelectorAll('.el-dialog, .el-drawer')].filter(self.vis)[0];
      if (!box) return false;
      const btn = box.querySelector('.el-dialog__headerbtn, .el-drawer__close-btn');
      return btn ? window.__dmvCursor.aim(btn) : false;
    },
    card(idx, sub) {
      const self = this;
      const cards = [...document.querySelectorAll('.el-card')].filter(self.vis);
      const c = cards[idx]; if (!c) return false;
      if (!sub) return window.__dmvCursor.aim(c);
      const el = [...c.querySelectorAll('button, .el-button, li, span')].filter(self.vis)
        .find(x => self.eq(sub, x) && x.children.length <= 1);
      return el ? window.__dmvCursor.aim(el) : false;
    },
    // 风险类别卡片内子操作按钮的状态（已发布版本下评估/编辑/删除同样置灰）
    cardState(idx, sub) {
      const self = this;
      const cards = [...document.querySelectorAll('.el-card')].filter(self.vis);
      const c = cards[idx]; if (!c) return 'missing';
      const el = [...c.querySelectorAll('button, .el-button, li, span')].filter(self.vis)
        .find(x => self.norm(x.textContent) === self.norm(sub) && x.children.length <= 1);
      if (!el) return 'missing';
      return (el.disabled || el.classList.contains('is-disabled') || el.getAttribute('aria-disabled') === 'true') ? 'disabled' : 'enabled';
    },
    // 详情头部版本下拉（选中值渲染在 input.value）
    headerSelect() {
      const self = this;
      const sel = [...document.querySelectorAll('.el-select')].filter(self.vis)
        .find(s => { const v = (s.querySelector('input') || {}).value || ''; return /Version/i.test(v); });
      return sel ? window.__dmvCursor.aim(sel) : false;
    },
    // 风险问题行 i 的行首展开箭头（svg）
    qRowArrow(i) {
      const self = this;
      const w = document.querySelector('.bg-slate-100');
      if (!w) return false;
      const row = [...w.children].filter(self.vis)[i];
      const svg = row && [...row.querySelectorAll('svg')][0];
      return svg ? window.__dmvCursor.aim(svg) : false;
    },
    // 真实风险类别卡（排除"新建风险分类"Add 卡）
    realCards() {
      return [...document.querySelectorAll('.el-card')].filter(this.vis).filter(c => !/新建风险分类|New\\s*Risk\\s*Category/.test(c.textContent || ''));
    },
    // 卡头 More(⋯) 下拉图标：是 svg，fire() 会走派发 click 事件的分支
    cardMore(idx) {
      const self = this;
      const c = self.realCards()[idx]; if (!c) return false;
      const el = [...c.querySelectorAll('.card-header svg, .card-header [class*="cursor-pointer"]')].filter(self.vis)[0];
      return el ? window.__dmvCursor.aim(el) : false;
    },
    // "新建风险分类" Add 卡
    cardAdd() {
      const self = this;
      const c = [...document.querySelectorAll('.el-card')].filter(self.vis).find(x => /新建风险分类|New\\s*Risk\\s*Category/.test(x.textContent || ''));
      return c ? window.__dmvCursor.aim(c) : false;
    },
    // 详情页返回箭头：在包含模块名文本与版本下拉的头部条里，取第一个可见 svg
    // （详情页显示由父组件本地 ref 控制、不改 URL，所以只能点箭头退回列表）
    backIcon() {
      const self = this;
      const heads = [...document.querySelectorAll('div')].filter(self.vis)
        .filter(d => /RACT/.test((d.textContent || '').slice(0, 12)) && d.querySelector('svg') && d.querySelector('.el-select'));
      const h = heads[heads.length - 1];
      if (!h) return false;
      const svg = [...h.querySelectorAll('svg')].filter(self.vis)[0];
      return svg ? window.__dmvCursor.aim(svg) : false;
    },
    // 语言体检（S0 门禁）：可见性过滤后统计可见叶节点里的中文字符数，按 tag.class 归类。
    // 只输出计数与元素类型，不输出中文内容（回执红线）；canvas（ECharts）文本抓不到，
    // 用 canvases 计数提示「图表标签语言未程序化验证」。
    cjk() {
      const self = this;
      const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.height > 0 && r.width > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
      const counts = {}; let total = 0;
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const p = n.parentElement;
        if (!p || !vis(p)) continue;
        const m = (n.textContent || '').match(/[\\u4e00-\\u9fff]/g);
        if (!m) continue;
        total += m.length;
        const k = p.tagName + '.' + String(p.className || '').split(/\\s+/).slice(0, 2).join('.');
        counts[k] = (counts[k] || 0) + m.length;
      }
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + ':' + v);
      return { total, top, canvases: [...document.querySelectorAll('canvas')].filter(vis).length };
    },
    dump() {
      const self = this;
      const btns = [...new Set([...document.querySelectorAll('button, .el-button')].filter(self.vis).map(b => (b.textContent || '').replace(/\\s+/g, ' ').trim()).filter(t => t && t.length <= 20))];
      const dlg = [...document.querySelectorAll('.el-dialog, .el-message-box, .el-drawer')].filter(self.vis)
        .map(d => ((d.querySelector('.el-dialog__title, .el-drawer__title, .el-message-box__title') || {}).textContent || '(无题)').trim());
      return { btns, dlg, rows: [...document.querySelectorAll('.el-table__body-wrapper tbody tr')].filter(self.vis).length }
    }
  };
})();
`;

// ---------- 浏览器初始化 ----------
const browser = await pw.chromium.launch({ executablePath: process.env.DV_CHROME || undefined, headless: true, args: ['--disable-blink-features=AutomationControlled', '--window-size=1920,1080'] });
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true, locale: 'en-US', timezoneId: 'Asia/Shanghai',
  recordVideo: { dir: VDIR, size: { width: 1920, height: 1080 } }
});
ctx.setDefaultTimeout(10000);
const pg = await ctx.newPage();
// 英文界面（交付口径：系统切英文，而不是中文页面配英文解说）。
// pure-admin 的语言持久化在 localStorage 'responsive-locale'（值 {"locale":"en"}），addInitScript 在应用脚本前生效
await pg.addInitScript(() => {
  try { localStorage.setItem('responsive-locale', JSON.stringify({ locale: 'en' })); } catch {}
});
pg.on('dialog', d => d.dismiss().catch(() => {}));
pg.on('download', d => d.cancel().catch(() => {}));
let navCount = 0;
pg.on('framenavigated', f => { if (f === pg.mainFrame()) navCount++; });
await installCursor(pg);

async function ready() { await ensureCursor(pg); await pg.evaluate(FINDER_SRC).catch(() => {}); }
const doAim = async (fn, ...args) => { await ready(); return pg.evaluate(([f, a]) => window.__dmvFind[f](...a), [fn, args]); };
const doAimClick = async (fn, ...args) => {
  await ready();
  for (let i = 0; i < 2; i++) {
    if (!(await pg.evaluate(([f, a]) => window.__dmvFind[f](...a), [fn, args]))) return false;
    await sleep(420);
    const ok = await pg.evaluate(() => window.__dmvCursor.fire());
    await sleep(150);
    if (ok) return true;
    await sleep(320);
  }
  return false;
};
const page = pg;

// ---------- 页面状态工具 ----------
const path_ = () => page.evaluate(() => location.pathname + location.hash).catch(() => '');
async function settle(ms = 1200) { try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch {} await sleep(ms); }
async function waitIdle(maxMs = 9000) {
  const t = Date.now();
  while (Date.now() - t < maxMs) {
    const busy = await page.evaluate(() => [...document.querySelectorAll('.el-loading-mask')].some(m => { const r = m.getBoundingClientRect(); return r.height > 0 && r.width > 0 && getComputedStyle(m).display !== 'none' && +getComputedStyle(m).opacity > 0.05; })).catch(() => false);
    if (!busy) break;
    await sleep(200);
  }
  await sleep(220);
}
async function gate(predFn, timeout = 15000) {
  const t = Date.now();
  while (Date.now() - t < timeout) { if (await page.evaluate(predFn).catch(() => false)) return true; await sleep(350); }
  return false;
}
const hasDialog = kind => page.evaluate(k => [...document.querySelectorAll('.' + k)].some(d => d.getBoundingClientRect().height > 0), kind || 'el-dialog');
// 注意：gate() 会把传入函数序列化进页面执行，必须是无闭包的纯 DOM 谓词
const P_OVERLAY = () => [...document.querySelectorAll('.el-dialog, .el-drawer, .el-message-box')].some(d => d.getBoundingClientRect().height > 0);
const P_MESSAGEBOX = () => [...document.querySelectorAll('.el-message-box')].some(d => d.getBoundingClientRect().height > 0);

// ---------- 弹层卫生三件套（RBQM 实测：遮罩累积会把整支视频蒙黑） ----------
// 遮罩清干净的判据是「可见 .el-overlay 数」归零，不是抽屉 height（关闭动画期 height 残留）。
async function visibleOverlayCount() {
  return page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.height > 0 && r.width > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
    return [...document.querySelectorAll('.el-overlay')].filter(vis).length;
  }).catch(() => -1);
}
async function waitOverlaysClosed(timeout = 4000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    const n = await visibleOverlayCount();
    if (n === 0) return true;
    await sleep(250);
  }
  return false;
}
// 幽灵下拉清理：抽屉内 el-select 的下拉 teleport 到 body，抽屉卸载不带走（即便先前
// Escape 关过，关抽屉时它仍会再冒出来）。只在弹层全关后调用：此时任何可见 popper 都是幽灵。
async function purgeStrayPoppers() {
  await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.height > 0 && r.width > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
    const overlays = [...document.querySelectorAll('.el-overlay')].filter(vis);
    for (const p of document.querySelectorAll('.el-popper')) {
      if (!vis(p)) continue;
      if (overlays.some(o => o.contains(p))) continue;
      p.remove();
    }
  }).catch(() => {});
}
// 关闭链三段式：Escape blur 下拉 → Cancel/X → before-close 确认框点主按钮 → 轮询遮罩归零。
// 带.before-close 的抽屉只按 Esc/X 关不掉，且每试一次再叠一层 rgba(0,0,0,.5) 遮罩。
// 红线守卫：主按钮只点「放弃编辑/关闭确认」类消息框；含破坏性词（删除/发布/提交…）的
// 消息框绝不点主按钮（走取消）——主按钮在那种框里是执行写操作。
const DESTRUCTIVE_RE = /删除|清空|发布|停用|启用|提交|删除|Delete|Publish|Submit|Deactivate|Activate/i;
async function closeOverlay(opt = {}) {
  await page.keyboard.press('Escape').catch(() => {});   // 先 blur 掉打开中的下拉
  await beat(300);
  // opt.mb=true：调用方明确这是破坏性确认框（删除/发布等）→ 只走取消，绝不碰主按钮
  let ok = await doAimClick('dlgBtn', '取消', { mb: !!opt.mb });
  if (!ok) ok = await doAimClick('dlgClose');
  await beat(400);
  if (!opt.mb) {
    const mbTexts = await page.evaluate(() => {
      const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.height > 0 && r.width > 0 && +cs.opacity > 0.05; };
      return [...document.querySelectorAll('.el-message-box')].filter(vis).map(b => (b.textContent || '').slice(0, 200));
    }).catch(() => []);
    if (mbTexts.length && !mbTexts.some(t => DESTRUCTIVE_RE.test(t))) {
      await doAimClick('dlgBtn', '确定', { mb: true });
      await beat(400);
    }
  }
  if (!(await waitOverlaysClosed(1200))) {
    await page.keyboard.press('Escape').catch(() => {});
    await waitOverlaysClosed(2500);
  }
  await purgeStrayPoppers();
  await beat(250);
}
// 每段开始前的卫生门：脏则自愈一次再查；仍脏只记账（S2 亮度剖面会点名）不炸段。
async function assertClean(tag) {
  let n = await visibleOverlayCount();
  if (n > 0) {
    console.log(`[clean] ${tag} 前发现 ${n} 层残留遮罩，尝试关闭`);
    await closeOverlay();
    n = await visibleOverlayCount();
  }
  await purgeStrayPoppers();
  step(`  [clean] ${tag}`, n === 0, n === 0 ? '' : `仍有 ${n} 层可见遮罩（继续录制，交付前按亮度剖面决定是否重录）`);
  return n === 0;
}

// ---------- 长页逐屏滚动（懒渲染：图表只在滚到视口时初始化） ----------
// 找最大可滚容器分步滚，每步可 aim 一个目标（边滚边带出懒渲染图表）；结束回顶。
// 万像素级长页 4 屏起步；预热段先全页滚一遍再开录，否则片头扫视拍到空图。
async function scrollSteps(times, px, aimFn) {
  const scrollLargest = delta => page.evaluate(p => {
    const cands = [document.scrollingElement, ...document.querySelectorAll('.el-scrollbar__wrap, .el-table__body-wrapper, .main-content, main')].filter(Boolean);
    let best = document.scrollingElement, bestH = 0;
    for (const c of cands) {
      const h = (c.scrollHeight || 0) - (c.clientHeight || 0);
      if (h > bestH) { bestH = h; best = c; }
    }
    if (!best) return false;
    if (p > 0) { best.scrollTop += p; if (typeof best.scrollBy === 'function') best.scrollBy(0, p); } else { best.scrollTop = 0; }
    return true;
  }, delta).catch(() => false);
  for (let i = 0; i < times; i++) {
    await scrollLargest(px);
    await sleep(700);
    if (aimFn) await aimFn(i);
    await waitIdle(4000);
  }
  await scrollLargest(0);
  await sleep(500);
}

// 【模块适配区①：G 区谓词】列表判定=表头文案（双语概念对）；详情判定=5 个 tab 概念各至少一个可见按钮
const G = {
  loginForm: () => { const p = document.querySelector('input[type="password"]'); return !!p && p.getBoundingClientRect().height > 0; },
  welcomeRows: () => [...document.querySelectorAll('table tbody tr td button.rbqm-link')].filter(b => b.getBoundingClientRect().height > 0).length > 0,
  menuReady: () => [...document.querySelectorAll('li.el-menu-item')].filter(x => x.getBoundingClientRect().height > 0).length >= 3,
  ractList: () => [...document.querySelectorAll('.el-table__header-wrapper th')].some(th => ['RACT版本','RACTVersion'].includes((th.textContent || '').replace(/\s+/g, '')) && th.getBoundingClientRect().height > 0)
    && [...document.querySelectorAll('.el-table__body-wrapper tbody tr')].filter(tr => tr.getBoundingClientRect().height > 0).length > 0,
  detail: () => !!([...document.querySelectorAll('button, .el-button')].find(x => /关键过程|Critical\s*Process/.test(x.textContent || '') && x.getBoundingClientRect().height > 0))
};

async function dumpUi(tag) {
  const d = await page.evaluate(() => window.__dmvFind.dump()).catch(() => ({ btns: [], dlg: [], rows: -1 }));
  console.log(`    [ui:${tag}] rows=${d.rows} dlg=[${d.dlg.join(',')}] btns=[${d.btns.join('|')}]`);
  return d;
}
// 关弹窗统一走 closeOverlay（弹层卫生三段式，见上方定义）。
// 详情页判定：5 个 tab 概念各至少一个（中/英任一）可见按钮（列表页不会有）
const P_DETAIL = () => {
  const norm = s => (s || '').replace(/\s+/g, '');
  const vis = el => el.getBoundingClientRect().height > 0;
  const concepts = [
    ['关键过程', 'CriticalProcess'],
    ['关键数据', 'CriticalData'],
    ['风险定义&评估', 'RiskDefinition&Assessment', 'RiskDefinitionAndAssessment'],
    ['风险缓解措施', 'RiskMitigation'],
    ['参与者', 'Participants']
  ];
  const btns = [...document.querySelectorAll('button, .el-button')].filter(vis).map(x => norm(x.textContent));
  return concepts.every(al => btns.some(n => al.some(a => n === norm(a))));
};
const isDetail = () => page.evaluate(P_DETAIL).catch(() => false);

// 【模块适配区②：菜单入口】叶子点不到 → 展开子菜单 → hash 路由兜底
async function clickMenuRact() {
  let ok = await doAimClick('btn', 'RACT', { scope: 'li.el-menu-item', exact: false });
  if (!ok || !(await gate(G.ractList, 3500))) {
    await page.evaluate(() => {
      const vis = el => el.getBoundingClientRect().height > 0;
      [...document.querySelectorAll('.el-sub-menu__title, .el-submenu__title')].filter(vis).forEach(t => t.click());
    }).catch(() => {});
    await sleep(1000);
    ok = await doAimClick('btn', 'RACT', { scope: 'li.el-menu-item', exact: false });
    if (!ok) { console.log('[nav] 菜单不可达，走 hash 路由'); await page.evaluate(() => { location.hash = '/riskAssesment/RACT/index'; }).catch(() => {}); }
  }
  return gate(G.ractList, 25000);
}
// 确保停在列表：详情开着就先点返回箭头（菜单项在已激活路由上不重新挂载，点了没用）
async function ensureList() {
  for (let i = 0; i < 3; i++) {
    if (await gate(G.ractList, 1600)) return true;
    if (await isDetail()) {
      const back = await doAimClick('backIcon');
      if (!back) await page.keyboard.press('Escape').catch(() => {});
      await beat(1400); await waitIdle();
      continue;
    }
    // 兜底：先离开路由卸载组件，再回来重挂载
    await page.evaluate(() => { location.hash = '/studyDashboard/dashboard/index'; }).catch(() => {});
    await beat(1600);
    await clickMenuRact();
    await beat(1200);
  }
  return gate(G.ractList, 10000);
}
async function openVersion(label) {
  for (let i = 0; i < 3; i++) {
    await ensureCtx({ seg: 'list' });   // 被踢自愈（互踢随时可能发生）
    if (!(await ensureList())) continue;
    // 版本按钮可能在分页第 2 页：先回第 1 页找，找不到再翻一页
    let clicked = await doAimClick('btn', label, { inTable: true, exact: true });
    if (!clicked) {
      await page.evaluate(() => {
        const vis = el => el.getBoundingClientRect().height > 0;
        const prev = [...document.querySelectorAll('.el-pagination button')].filter(vis).find(b => b.className.includes('btn-prev') && !b.className.includes('disabled'));
        if (prev) prev.click();
        else { const p1 = [...document.querySelectorAll('.el-pager li, .el-pagination .number')].filter(vis).find(li => (li.textContent || '').trim() === '1'); p1?.click(); }
      }).catch(() => {});
      await sleep(1600);
      clicked = await doAimClick('btn', label, { inTable: true, exact: true });
    }
    if (!clicked) { step('  点击 ' + label + ' 按钮', false, '第' + (i + 1) + '次'); await sleep(1200); continue; }
    const ok = await gate(P_DETAIL, 60000);
    if (ok) { await waitIdle(); return true; }
    await sleep(1500);
  }
  return false;
}
// 读取详情头部版本下拉当前显示值（版本号属配置元数据，非业务数据）
// 注意：EP 的选中值渲染在 input.value 里，不是 textContent —— 只读 textContent 会恒为空
const headerVersion = () => page.evaluate(() => {
  const vis = s => s.getBoundingClientRect().height > 0;
  const sels = [...document.querySelectorAll('.el-select')].filter(vis);
  const sel = sels.find(s => /Version/i.test(((s.querySelector('input') || {}).value) || (s.textContent || '')));
  if (!sel) return '';
  const input = sel.querySelector('input');
  return (((input && input.value) || sel.textContent || '') + '').replace(/\s+/g, '');
}).catch(() => '');

// ---------- 可复用片段 ----------
// 行内操作：稽查轨迹/编辑/删除（删除走确认框后取消）；key 用于动作级配音打点
async function rowOp(op, tag = '', key = '') {
  if (op === '稽查轨迹') {
    act(key + '_audit');
    const ok = await doAimClick('rowBtn', op, 0);
    const opened = ok && await gate(P_OVERLAY, 10000);
    if (opened) { await beat(3000); await closeOverlay(); }
    step('  ' + tag + '行·稽查轨迹', !!opened);
  } else if (op === '编辑' || op === '删除') {
    const st = await page.evaluate(([f, a]) => window.__dmvFind[f](...a), ['btnState', [op, { inTable: true, row: 0 }]]).catch(() => 'missing');
    if (st === 'disabled') {
      act(key + '_' + (op === '编辑' ? 'edit' : 'del'));
      await doAim('rowBtn', op, 0);
      await beat(1800);
      step('  ' + tag + '行·' + op, true, '已发布版本置灰（只读），只高亮不点击');
      await waitIdle();
      return;
    }
    act(key + '_' + (op === '编辑' ? 'edit' : 'del'));
    const ok = await doAimClick('rowBtn', op, 0);
    if (op === '编辑') {
      await beat(600);
      const dlg = await hasDialog();
      if (dlg) { await beat(2200); await closeOverlay(); }
      step('  ' + tag + '行·编辑', !!ok && dlg, dlg ? '弹窗已展示并取消' : '未出现弹窗');
    } else {
      const mb = ok && await gate(P_MESSAGEBOX, 8000);
      if (mb) { await beat(2200); await closeOverlay({ mb: true }); }
      step('  ' + tag + '行·删除确认', !!mb, mb ? '确认框已展示并取消' : '未出现确认框');
    }
  } else if (op === '详情') {
    act(key + '_detail');
    const ok = await doAimClick('rowBtn', op, 0);
    const opened = ok && await gate(P_OVERLAY, 10000);
    if (opened) { await beat(3200); await dumpUi(tag + '详情抽屉'); await closeOverlay(); }
    step('  ' + tag + '行·详情', !!opened);
  }
  await waitIdle();
}
// 一个 tab 的标准序列：导出下拉 → 添加（弹窗→取消）→ 行内操作 → 查询/重置
// key 用于动作级配音打点（cp_/cd_ 等前缀）
async function tabOps({ exportItems = [], addText, rowOps = [], query = false, tag = '', key = '' }) {
  if (exportItems.length) {
    act(key + '_export');
    await doAimClick('toolBtn', '导出');
    await beat(900);
    for (const it of exportItems) { await doAim('btn', it, { exact: true }); await beat(1000); }
    await page.keyboard.press('Escape').catch(() => {});
    await beat(500);
    step('  ' + tag + '导出下拉: ' + exportItems.join(' / '), true);
  }
  if (addText) {
    const st = await page.evaluate(([f, a]) => window.__dmvFind[f](...a), ['btnState', [addText, {}]]).catch(() => 'missing');
    if (st === 'missing') {
      await doAim('toolBtn', addText);
      step('  ' + tag + '添加入口', false, '当前版本无此入口（权限/状态）');
    } else if (st === 'disabled') {
      act(key + '_add');
      await doAim('toolBtn', addText);
      await beat(1800);
      step('  ' + tag + '添加入口', true, '已发布版本置灰（只读），只高亮不点击');
    } else {
      act(key + '_add');
      const ok = await doAimClick('toolBtn', addText);
      await beat(700);
      const dlg = await hasDialog();
      if (dlg) { await beat(2400); await closeOverlay(); }
      step('  ' + tag + '添加弹窗', !!ok && dlg, dlg ? '弹窗已展示并取消' : '未出现弹窗');
    }
    await waitIdle();
  }
  for (const op of rowOps) await rowOp(op, tag, key);
  if (query) {
    act(key + '_query');
    await doAimClick('btn', '查询', { exact: true });
    await waitIdle(); await beat(900);
    await doAimClick('btn', '重置', { exact: true });
    await waitIdle(); await beat(900);
  }
}

// ---------- 登录与进研究（可复用：首次进入 + 被踢自愈共用） ----------
async function loginAndEnter() {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await settle(1500); await waitIdle();
  if (!(await gate(G.loginForm, 15000))) return false;
  await page.locator('input[type="text"], input:not([type="password"]):not([type="checkbox"]):not([type="radio"])').first().fill(USER);
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.evaluate(() => { const cb = [...document.querySelectorAll('.el-checkbox')].find(c => /同意|阅读|协议|agree|terms/i.test(c.textContent)); if (cb && !cb.classList.contains('is-checked')) cb.click(); });
  await page.locator('button:has-text("登录"), button:has-text("Login"), button:has-text("Sign")').first().click();
  let cur = await path_(), w = 0;
  while (/login/.test(cur) && w < 20000) { await sleep(800); w += 800; cur = await path_(); }
  if (/login/.test(cur)) {
    // 登录被拒（密码错误或账号被占用，单点互踢）：页面停在登录页。
    // 实测教训：这种情况循环重试永远不会成功——返回 rejected 让调用方停手换账号。
    const stillForm = await page.evaluate(() => { const p = document.querySelector('input[type="password"]'); return !!(p && p.getBoundingClientRect().height > 0); }).catch(() => false);
    return stillForm ? 'rejected' : false;
  }
  await settle(1500);
  if (!/welcome/i.test(cur)) { await page.goto(hashTo('/welcome/index'), { waitUntil: 'domcontentloaded' }).catch(() => {}); await settle(2000); }
  await waitIdle();
  await gate(G.welcomeRows, 12000);
  // 研究列表可能分页：找不到目标研究就点下一页翻找（最多 5 页）
  const findStudyBtn = () => page.evaluate(() => {
    const vis = el => el.getBoundingClientRect().height > 0;
    const btn = [...document.querySelectorAll('table tbody tr td button.rbqm-link')].filter(vis).find(x => /tede/i.test(x.textContent || ''));
    if (!btn) return false; btn.click(); return true;
  });
  let studyClicked = await findStudyBtn();
  for (let p = 2; !studyClicked && p <= 5; p++) {
    const nexted = await page.evaluate(() => {
      const vis = el => el.getBoundingClientRect().height > 0;
      const btn = [...document.querySelectorAll('.el-pagination button')].filter(vis).find(b => b.className.includes('btn-next') && !b.className.includes('disabled'));
      if (!btn) return false; btn.click(); return true;
    });
    if (!nexted) break;
    await sleep(1800);
    studyClicked = await findStudyBtn();
  }
  if (!studyClicked) return false;
  await sleep(1500);
  if (await page.locator('.el-dialog:visible .el-select, .el-message-box .el-select').count()) {
    await page.locator('.el-dialog:visible .el-select, .el-message-box .el-select').first().click().catch(() => {});
    await sleep(1100);
    await page.evaluate(() => { [...document.querySelectorAll('.el-select-dropdown__item')].filter(x => x.getBoundingClientRect().height > 0).find(x => /dev/i.test((x.textContent || '').trim()))?.click(); });
    await sleep(600);
    await page.locator('.el-dialog:visible button, .el-message-box button').filter({ hasText: /确定|进入|确认|Confirm|OK|Enter|Continue/ }).first().click().catch(() => {});
  }
  await settle(2500);
  return gate(G.menuReady, 25000);
}

// 单点互踢检测：页面回到登录页（同账号别处登录会把当前会话踢下线）
async function isKicked() {
  const h = await path_();
  if (/login/i.test(h)) return true;
  return page.evaluate(() => { const p = document.querySelector('input[type="password"]'); return !!(p && p.getBoundingClientRect().height > 0); }).catch(() => false);
}
// 被踢自愈：重登 → 进研究 → 回到指定位置（列表 或 详情+指定 tab）。
// 登录被拒（账号被占用/密码错）时立即停手不循环重试——换不互踢的账号或请用户释放。
async function ensureCtx(pos) {
  if (!(await isKicked())) return true;
  console.log('[recover] 会话被踢，自愈恢复 → ' + pos.seg + (pos.tab ? '/' + pos.tab : ''));
  for (let i = 0; i < 3; i++) {
    const r = await loginAndEnter();
    if (r === 'rejected') {
      console.log('[recover] 登录被拒（密码错误或账号被占用）：停止重试，请换不互踢的账号或请用户释放会话');
      return false;
    }
    if (r) {
      await clickMenuRact();
      if (pos.seg === 'detail') {
        await openVersion(DEMO_VERSION);
        if (pos.tab) { await doAimClick('btn', pos.tab); await beat(1800); await waitIdle(); }
        if (await isDetail()) { console.log('[recover] 已恢复到详情/' + (pos.tab || '')); return true; }
      } else if (await gate(G.ractList, 8000)) {
        console.log('[recover] 已恢复到列表'); return true;
      }
    }
    await sleep(2000);
  }
  console.log('[recover] 恢复失败');
  return false;
}

// ---------- 主流程【模块适配区③：模块步骤段落】 ----------
try {
  console.log('[tour] BASE=' + maskUrl(BASE) + ' [' + BASE_DESC + '] 演示版本=' + DEMO_VERSION);

  // ===== 准备：登录 → 进研究 =====
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await settle(1500); await waitIdle();
  const loginOk = await gate(G.loginForm, 15000);
  step('登录页就绪', loginOk, 'navigations=' + navCount + ' url=' + maskUrl(await path_()));
  if (!loginOk) throw new Error('登录页未渲染 BASE=' + BASE_DESC + ' nav=' + navCount);
  const entered = await loginAndEnter();
  step('登录跳转+进入演示研究', entered === true, entered === 'rejected' ? '登录被拒（账号被占用/密码错）——换不互踢账号或请用户释放后重录' : '');
  if (entered === 'rejected') throw new Error('登录被拒（密码错误或账号被占用）：停止录制，换不互踢的账号或请用户释放会话');
  if (entered !== true) throw new Error('登录或进研究失败');

  // ===== 预热（成片掐掉）=====
  if (!process.env.DV_NO_WARMUP) {
    console.log('[warmup] 开始');
    const tw = Date.now();
    if (await clickMenuRact()) {
      await openVersion(DEMO_VERSION);
      for (const name of ['关键过程','Critical Process','关键数据','Critical Data','风险定义&评估','Risk Definition&Assessment','风险缓解措施','Risk Mitigation','参与者','Participants']) {
        await doAimClick('btn', name);
        await beat(1300); await waitIdle();
      }
      // 全页滚动预热：懒渲染图表只在滚到视口时初始化，先滚一遍再开录（否则片头扫视拍到空图）
      await scrollSteps(4, 900);
      await ensureList();
    }
    console.log('[warmup] 结束 ' + ((Date.now() - tw) / 1000).toFixed(0) + 's');
  } else { console.log('[warmup] 跳过'); }

  // ===== 片头：直接从模块列表开始（首页/登录段全部掐掉）=====
  await page.evaluate(() => { location.hash = '/riskAssesment/RACT/index'; }).catch(() => {});
  const listReady = await gate(G.ractList, 25000);
  await waitIdle();
  // 光标先落在列表头部，首帧有自然落点
  await doAim('btn', 'RACT 版本', { scope: '.el-table__header-wrapper th', exact: false });
  await beat(1200);
  // 黑场闪光标记（260ms）：后期逐帧亮度法按「全帧 YAVG<40 的最长连续段」精确定位掐头点——
  // 场景分值口径已弃用（闪光帧可能被虚拟光标压住几个像素导致分值不足）。
  // flashWall=闪光注入的墙钟秒，写进 timings.json 供 S2 对齐初始漂移（勿删）。
  flashWall = +(((Date.now() - t0) / 1000).toFixed(2));
  await page.evaluate(() => {
    const f = document.createElement('div');
    f.id = '__dmvFlash';
    f.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483000;pointer-events:none;';
    document.documentElement.appendChild(f);
    setTimeout(() => f.remove(), 260);
  });
  await sleep(900); // 等闪光出画，留出干净的列表静止帧
  step('模块列表', listReady);
  act('ract_list');
  await beat(2800);

  act('export_list');
  await assertClean('列表段');
  await ensureCtx({ seg: 'list' });
  await doAimClick('toolBtn', '导出');
  await beat(900);
  await doAim('btn', '导出列表', { exact: true });
  await beat(1100);
  await doAim('btn', '导出稽查轨迹', { exact: true });
  await beat(1400);
  await page.keyboard.press('Escape').catch(() => {});
  await beat(600);
  step('列表·导出下拉', true, '导出列表 / 导出稽查轨迹');

  act('create_click');
  await assertClean('创建段');
  await ensureCtx({ seg: 'list' });
  // 示例：真实点击演示（一键建草稿，无确认层）——真实点击必须经用户明确同意
  const createOk = await doAimClick('toolBtn', '创建RACT');
  const toastOk = await gate(() => [...document.querySelectorAll('.el-message')].some(m => m.getBoundingClientRect().height > 0), 6000);
  await beat(1000); await waitIdle();
  act('create_done');
  const newRowAimed = await doAim('btn', 'Version', { inTable: true, row: 0, exact: false });
  await beat(2600);
  step('列表·创建（真实点击）', createOk && (toastOk || !!newRowAimed), '一键创建草稿并刷新列表（真实产生新草稿版本，交付说明须写明）');

  act('audit_list');
  await assertClean('列表稽查');
  await ensureCtx({ seg: 'list' });
  await rowOp('稽查轨迹', '列表', 'list');

  act('publish');
  await assertClean('发布段');
  await ensureCtx({ seg: 'list' });
  // 找带「发布」按钮的行（版本多时可能在第 2 页）
  const findPublishRow = () => page.evaluate(() => {
    const vis = el => el.getBoundingClientRect().height > 0;
    return [...document.querySelectorAll('.el-table__body-wrapper tbody tr')].filter(vis)
      .findIndex(tr => [...tr.querySelectorAll('button')].filter(vis).some(b => /发布|Publish/i.test(b.textContent || '')));
  });
  let pubIdx = await findPublishRow();
  if (pubIdx < 0) {
    const nexted = await page.evaluate(() => {
      const vis = el => el.getBoundingClientRect().height > 0;
      const btn = [...document.querySelectorAll('.el-pagination button')].filter(vis).find(b => b.className.includes('btn-next') && !b.className.includes('disabled'));
      if (!btn) return false; btn.click(); return true;
    });
    if (nexted) { await sleep(1800); pubIdx = await findPublishRow(); }
  }
  if (pubIdx >= 0) {
    await doAimClick('btn', '发布', { inTable: true, row: pubIdx });
    const mbOk = await gate(P_MESSAGEBOX, 8000);
    step('列表·发布确认框', mbOk);
    if (mbOk) { await beat(2600); await closeOverlay({ mb: true }); }
  } else { step('列表·发布确认框', false, '当前无带发布按钮的版本行'); }

  act('version_open');
  const detailOk = await openVersion(DEMO_VERSION);
  let shownVer = await headerVersion();
  if (detailOk && !shownVer) { await beat(1000); shownVer = await headerVersion(); }
  step('进入版本详情 ' + DEMO_VERSION, detailOk, detailOk ? '当前版本=' + (shownVer || '(读取失败)') : '');
  await beat(2400);
  if (!detailOk) throw new Error('版本详情未打开');

  // ===== 段二：详情页头（版本切换）=====
  act('header');
  // 版本下拉：EP 2.2.32 须真实点击 input；且页面上有多个 select，须按 input.value 含 Version 定位（探针实证）
  const vsAimed = await doAim('headerSelect');
  await beat(400);
  act('ver_dd');
  const vIdx = await page.evaluate(() => [...document.querySelectorAll('.el-select')]
    .findIndex(s => /version/i.test(((s.querySelector('input') || {}).value) || '')));
  if (vIdx >= 0) await page.locator('.el-select').nth(vIdx).locator('input').click({ timeout: 4000 }).catch(() => {});
  await beat(1100);
  const vOpts = await page.evaluate(() => [...document.querySelectorAll('.el-select-dropdown__item')].filter(x => x.getBoundingClientRect().height > 0).map(x => (x.textContent || '').trim()));
  await dumpUi('版本下拉');
  // 只悬停展示，不点选项（点了会切换当前演示版本）
  if (vOpts.length) { await doAim('btn', vOpts[0], { scope: '.el-select-dropdown__item', exact: true }); await beat(900); }
  await page.keyboard.press('Escape').catch(() => {});
  await beat(700);
  step('详情头·版本下拉', !!vsAimed && vOpts.length > 0, '可选版本数=' + vOpts.length);

  // ===== 段三：Tab1 关键过程 =====
  act('tab_cp');
  await assertClean('Tab1');
  await ensureCtx({ seg: 'detail', tab: '关键过程' });
  await doAimClick('btn', '关键过程');
  await beat(2000); await waitIdle();
  await dumpUi('关键过程');
  await tabOps({ exportItems: ['导出列表', '导出稽查轨迹'], addText: '添加', rowOps: ['编辑', '删除', '稽查轨迹'], query: true, tag: '关键过程 ', key: 'cp' });
  step('Tab1 关键过程', true);

  // ===== 段四：Tab2 关键数据 =====
  act('tab_cd');
  await assertClean('Tab2');
  await ensureCtx({ seg: 'detail', tab: '关键数据' });
  await doAimClick('btn', '关键数据');
  await beat(2000); await waitIdle();
  await dumpUi('关键数据');
  await tabOps({ exportItems: ['导出列表', '导出稽查轨迹'], addText: '添加', rowOps: ['编辑', '删除', '稽查轨迹'], query: true, tag: '关键数据 ', key: 'cd' });
  step('Tab2 关键数据', true);

  // ===== 段五：Tab3 风险定义&评估 =====
  act('tab_rd');
  await assertClean('Tab3');
  await ensureCtx({ seg: 'detail', tab: '风险定义&评估' });
  await doAimClick('btn', '风险定义&评估');
  await beat(2400); await waitIdle();
  await dumpUi('风险定义&评估');
  await doAimClick('toolBtn', '导出');
  await beat(900);
  await doAim('btn', '导出列表', { exact: true });
  await beat(1000);
  await page.keyboard.press('Escape').catch(() => {});
  await beat(500);
  // 风险类别卡片：点选第一张真实卡片（Add 卡不点，它会开新建表单）
  const cardCount = await page.evaluate(() => window.__dmvFind.realCards().length).catch(() => 0);
  step('风险类别卡片数', cardCount > 0, '共 ' + cardCount + ' 张（另有 1 张新建卡）');
  if (cardCount > 0) {
    act('rd_card');
    await doAimClick('card', 0);
    await beat(2200); await waitIdle();
    // 风险问题列表（.bg-slate-100 容器下的自绘行，非 el-table；进入 tab 时首卡自动选中并加载）
    const qn = await page.evaluate(() => { const w = document.querySelector('.bg-slate-100'); return w ? [...w.children].filter(c => c.getBoundingClientRect().height > 0).length : 0; }).catch(() => 0);
    step('风险问题列表', qn > 0, '行数=' + qn);
    // 展开第一行：先让虚拟光标滑向行首箭头（视觉连贯），再派发点击
    act('rd_qrow');
    const rowArrowAimed = await doAim('qRowArrow', 0);
    const expOk = rowArrowAimed && await page.evaluate(() => {
      const w = document.querySelector('.bg-slate-100');
      if (!w) return false;
      const row = [...w.children].filter(c => c.getBoundingClientRect().height > 0)[0];
      const svg = row && [...row.querySelectorAll('svg')][0];
      if (!svg) return false;
      if (typeof svg.click === 'function') svg.click(); else svg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    });
    await beat(2200);
    // 展开区内的行内操作：稽查轨迹（弹窗→取消）；保存会写库 → 只高亮
    act('rd_q_audit');
    const auditHit = await doAim('btn', '稽查轨迹');
    let auditOpened = false;
    if (auditHit) {
      const ok = await doAimClick('btn', '稽查轨迹');
      auditOpened = ok && await gate(P_OVERLAY, 10000);
      if (auditOpened) { await beat(3000); await closeOverlay(); }
    }
    step('风险问题行·稽查轨迹', auditOpened, expOk ? '' : '行未展开');
    await waitIdle();
    const saveHit = await doAim('btn', '保存');
    if (saveHit) { await beat(1800); step('风险问题行·保存入口演示', true, '会直接提交，只高亮不点击'); }
    // 收起行：光标滑向箭头再点
    await doAim('qRowArrow', 0);
    await page.evaluate(() => {
      const w = document.querySelector('.bg-slate-100');
      const row = w && [...w.children].filter(c => c.getBoundingClientRect().height > 0)[0];
      const svg = row && [...row.querySelectorAll('svg')][0];
      if (svg) { if (typeof svg.click === 'function') svg.click(); else svg.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
    }).catch(() => {});
    await beat(800);
    // 卡内操作挂在卡头 More(⋯) 下拉，且 el-dropdown 默认 hover 触发：
    // 先让虚拟光标滑到图标，再用真指针 hover（否则画面上箭头不动、菜单凭空弹出=不连贯）
    const ddIdx = await page.evaluate(() => {
      const vis = el => el.getBoundingClientRect().height > 0;
      return [...document.querySelectorAll('.el-card')].filter(vis).findIndex(c => !/新建风险分类|New\s*Risk\s*Category/.test(c.textContent || ''));
    });
    let items = [];
    if (ddIdx >= 0) {
      act('rd_more');
      await doAim('cardMore', 0);
      await page.locator('.el-card').nth(ddIdx).locator('.el-dropdown').hover({ timeout: 4000 }).catch(() => {});
      await beat(1300);
      items = await page.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].filter(x => x.getBoundingClientRect().height > 0).map(x => (x.textContent || '').replace(/\s+/g, '')));
    }
    step('风险类别·More 下拉', items.length > 0, '项目=[' + items.join(' / ') + ']');
    for (const it of items) {
      const st = await page.evaluate(t => {
        const el = [...document.querySelectorAll('.el-dropdown-menu__item')].filter(x => x.getBoundingClientRect().height > 0).find(x => (x.textContent || '').replace(/\s+/g, '') === t);
        if (!el) return 'missing';
        const b = el.querySelector('button, .el-button') || el;
        return (b.disabled || b.classList.contains('is-disabled')) ? 'disabled' : 'enabled';
      }, it).catch(() => 'missing');
      if (st === 'disabled') {
        await doAim('btn', it, { scope: '.el-dropdown-menu__item', exact: true });
        await beat(1500);
        step('  风险类别·' + it, true, '已发布版本置灰（只读），只高亮不点击');
      } else {
        const hit = await doAimClick('btn', it, { scope: '.el-dropdown-menu__item', exact: true });
        await beat(700);
        const opened = await page.evaluate(() => [...document.querySelectorAll('.el-dialog, .el-drawer')].some(d => d.getBoundingClientRect().height > 0));
        if (opened) { await beat(2800); await closeOverlay(); }
        step('  风险类别·' + it, !!hit, opened ? '弹窗已展示并取消' : '无弹窗');
        await waitIdle();
      }
      // 下拉可能因选中而收起，收起后重新 hover（同样先滑虚拟光标）
      const stillOpen = await page.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].some(x => x.getBoundingClientRect().height > 0));
      if (!stillOpen && items.indexOf(it) < items.length - 1 && ddIdx >= 0) {
        await doAim('cardMore', 0);
        await page.locator('.el-card').nth(ddIdx).locator('.el-dropdown').hover({ timeout: 4000 }).catch(() => {});
        await beat(1000);
      }
    }
    // 新建风险分类入口（只打开表单不提交；已发布版本不渲染时跳过）
    const addCardHit = await doAim('cardAdd');
    if (addCardHit) {
      act('rd_addcard');
      await beat(500);
      await page.evaluate(() => {
        const c = [...document.querySelectorAll('.el-card')].filter(x => x.getBoundingClientRect().height > 0).find(x => /新建风险分类|New\s*Risk\s*Category/.test(x.textContent || ''));
        if (c) { if (typeof c.click === 'function') c.click(); else c.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      }).catch(() => {});
      await beat(900);
      const addDlg = await hasDialog();
      if (addDlg) { await beat(2400); await closeOverlay(); }
      step('新建风险分类入口', true, addDlg ? '表单已展示并取消' : '点击未出表单');
    } else {
      step('新建风险分类入口', true, '已发布版本不渲染该入口');
    }
    await waitIdle();
  }
  await doAimClick('btn', '查询', { exact: true });
  await waitIdle(); await beat(1100);
  await dumpUi('风险问题列表');
  step('Tab3 风险定义&评估', true);

  // ===== 段六：Tab4 风险缓解措施 =====
  act('tab_rm');
  await assertClean('Tab4');
  await ensureCtx({ seg: 'detail', tab: '风险缓解措施' });
  await doAimClick('btn', '风险缓解措施');
  await beat(2200); await waitIdle();
  await dumpUi('风险缓解措施');
  act('rm_sub');
  for (const sub of ['待缓解问题', '待缓解分类', '已缓解']) {
    if (await doAimClick('btn', sub, { exact: false })) { await beat(1700); await waitIdle(); }
  }
  await doAimClick('btn', '待缓解问题', { exact: false });
  await beat(1700); await waitIdle();
  act('rm_export');
  await doAimClick('toolBtn', '导出');
  await beat(900);
  await doAim('btn', '导出列表', { exact: true });
  await beat(1000);
  await page.keyboard.press('Escape').catch(() => {});
  await beat(500);
  act('rm_detail');
  await rowOp('详情', '缓解措施 ', 'rm');
  await rowOp('稽查轨迹', '缓解措施 ', 'rm');
  step('Tab4 风险缓解措施', true);

  // ===== 段七：Tab5 参与者 =====
  act('tab_part');
  await assertClean('Tab5');
  await ensureCtx({ seg: 'detail', tab: '参与者' });
  await doAimClick('btn', '参与者');
  await beat(2200); await waitIdle();
  await dumpUi('参与者');
  await doAimClick('toolBtn', '导出');
  await beat(900);
  await doAim('btn', '导出列表', { exact: true });
  await beat(1000);
  await page.keyboard.press('Escape').catch(() => {});
  await beat(500);
  const addSt = await page.evaluate(([f, a]) => window.__dmvFind[f](...a), ['btnState', ['添加', {}]]).catch(() => 'missing');
  if (addSt === 'missing') {
    step('参与者·添加入口', true, '当前账号无该权限，页面不渲染该入口');
  } else {
    const addOk = await doAimClick('toolBtn', '添加');
    await beat(1800); await waitIdle();
    step('参与者·添加行', !!addOk, '本地追加编辑行，未提交');
  }
  await rowOp('稽查轨迹', '参与者 ', 'part');
  // 删除 & 保存：无确认层直连接口 → 只高亮
  act('part_del_demo');
  step('参与者·删除入口演示', !!(await doAim('rowBtn', '删除', 0)), '无确认层且直连接口，只高亮不点击');
  await beat(2200);
  act('part_save_demo');
  step('参与者·保存入口演示', !!(await doAim('toolBtn', '保存')), '会直接提交，只高亮不点击');
  await beat(2200);

  // ===== 收尾：点详情页返回箭头回列表 =====
  act('back_list');
  await assertClean('返回列表');
  await ensureCtx({ seg: 'list' });
  step('返回模块列表', await ensureList());
  await waitIdle();
  await beat(2800);

  await page.screenshot({ path: path.join(VDIR, 'walk-final.png'), type: 'png' }).catch(() => {});
  step('走查结束', true, '总导航次数=' + navCount);
} catch (e) {
  step('异常中断', false, e.message.slice(0, 140));
} finally {
  const video = await page.video();
  await ctx.close();
  let saved = null;
  if (video) {
    const vp = await video.path().catch(() => null);
    if (vp && fs.existsSync(vp)) {
      saved = path.join(VDIR, `record-${MODULE}_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.webm`);
      try { fs.renameSync(vp, saved); } catch { saved = vp; }
    }
  }
  await browser.close();
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  const size = saved ? (fs.statSync(saved).size / 1048576).toFixed(1) + 'MB' : '-';
  // S2 输入契约：flashWall=闪光注入墙钟秒（掐头对齐），actions=黑条打点序列
  fs.writeFileSync(path.join(WORK, 'timings.json'), JSON.stringify({ module: MODULE, steps, actions, totalDuration: +dur, video: saved, flashWall, navigations: navCount }, null, 1));
  console.log('---');
  console.log(`[result] 总耗时=${dur}s 步骤=${steps.filter(s => s.ok).length}/${steps.length}通过 打点=${actions.length} 导航=${navCount}`);
  console.log(`[result] 视频=${saved ? saved : '未生成'} (${size})`);
}
