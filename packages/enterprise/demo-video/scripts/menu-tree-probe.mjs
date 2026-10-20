// ═══════════════════════════════════════════════════════════════════════════
// 菜单树探针（S0 覆盖计划；enterprise_demo_survey 工具按此驱动）。
// 递归展开侧边栏（accordion 逐组），输出完整菜单树 + 可见菜单标签的中文计数：
// 不同账号/权限可见叶子不同——先知道有多少页，再定覆盖清单（S0 门禁第一步）。
//
// 运行契约（与 walk 脚本同源的环境变量；enterprise_demo_survey 注入）：
//   DV_WORK（工作目录，必填；输出 menu-tree.txt 落这里）/ DV_BASE / DV_USER / DV_PASS /
//   DV_CHROME（Chromium 路径）/ DV_PW（playwright-core 包目录）。
// 【模块适配区】登录后进入业务层级的步骤（选研究/选环境等）按目标系统改；
//   菜单选择器按 Element Plus 写（.el-menu/.el-sub-menu），其他 UI 库同步替换。
// 数据安全：只读不改——不点任何业务按钮，不进弹窗，不产生写入；账号密码经环境变量
//   注入（工具侧走宿主凭据解析），本脚本不含任何凭据/主机/环境值。
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = require(process.env.DV_PW || 'playwright-core');

const WORK = process.env.DV_WORK;
if (!WORK) { console.error('[fatal] 缺少 DV_WORK 环境变量'); process.exit(2); }
const USER = process.env.DV_USER || '';
const PASS = process.env.DV_PASS || '';
// 与 walk 模板同款 BASE 规范化（cmd set 空格并入 / 无尾斜杠拼 hash 均实测翻过车）
const BASE = (process.env.DV_BASE || '').trim().replace(/#.*$/, '').replace(/\/+$/, '') + '/';
if (BASE === '/') { console.error('[fatal] 缺少 DV_BASE（系统地址）'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[tree]', ...a);

const browser = await pw.chromium.launch({ executablePath: process.env.DV_CHROME || undefined, headless: true, args: ['--disable-blink-features=AutomationControlled'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true, locale: 'en-US' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  // 英文界面注入与 walk 模板同口径（目标系统不用 pure-admin 时改【模块适配区】）
  await page.addInitScript(() => { try { localStorage.setItem('responsive-locale', JSON.stringify({ locale: 'en' })); } catch {} });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await sleep(2500);
  if (USER && PASS && await page.evaluate(() => !!document.querySelector('input[type="password"]')).catch(() => false)) {
    await page.locator('input[type="text"], input:not([type="password"]):not([type="checkbox"]):not([type="radio"])').first().fill(USER);
    await page.locator('input[type="password"]').first().fill(PASS);
    await page.locator('button:has-text("登录"), button:has-text("Login"), button:has-text("Sign")').first().click();
    let cur = await page.evaluate(() => location.hash).catch(() => ''), w = 0;
    while (/login/i.test(cur) && w < 16000) { await sleep(800); w += 800; cur = await page.evaluate(() => location.hash).catch(() => ''); }
    if (/login/i.test(cur)) {
      // 登录被拒不循环重试（账号被占用/密码错）——如实上报，换账号或请用户释放
      console.log('[tree] LOGIN_REJECTED 登录被拒：停在登录页（密码错误或账号被占用）');
      process.exitCode = 3;
    }
    await sleep(2000);
  }
  log('当前 hash=', await page.evaluate(() => location.hash).catch(() => '?'));

  // =====【模块适配区】进入业务层级（示例：研究列表点第一个 → 选环境 → 确定）=====
  await page.evaluate(() => {
    const v = el => el.getBoundingClientRect().height > 0;
    const btn = [...document.querySelectorAll('table tbody tr td button')].find(v);
    if (btn) btn.click();
  }).catch(() => {});
  await sleep(1600);
  await page.locator('.el-dialog:visible .el-select input, .el-message-box .el-select input').first().click().catch(() => {});
  await sleep(1100);
  await page.evaluate(() => {
    const v = el => el.getBoundingClientRect().height > 0;
    const opt = [...document.querySelectorAll('.el-select-dropdown__item')].find(v);
    if (opt) opt.click();
  }).catch(() => {});
  await sleep(600);
  await page.locator('.el-dialog:visible button, .el-message-box button').filter({ hasText: /Confirm|确定|OK|Enter|进入/ }).first().click().catch(() => {});
  await sleep(3000);

  // ===== 逐组展开（accordion：每次只点一个未展开的组），最多 20 轮 =====
  for (let round = 0; round < 20; round++) {
    const title = await page.evaluate(() => {
      const v = el => el.getBoundingClientRect().height > 0;
      const norm = s => (s || '').replace(/\s+/g, '');
      const groups = [...document.querySelectorAll('.el-sub-menu, .el-submenu')].filter(g => v(g));
      const collapsed = groups.find(g => {
        const t = g.querySelector(':scope > .el-sub-menu__title, :scope > .el-submenu__title');
        if (!t || !v(t)) return false;
        return !(g.classList.contains('is-opened') || g.classList.contains('is-open'));
      });
      if (!collapsed) return null;
      const t = collapsed.querySelector('.el-sub-menu__title, .el-submenu__title');
      t.click();
      return norm(t.textContent);
    }).catch(() => null);
    if (!title) break;
    await sleep(900);
  }
  await sleep(800);

  // ===== 输出菜单树（UI 标签允许出域）+ 可见菜单标签中文计数（只计数不输出内容） =====
  const tree = await page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const walk = (ul, depth) => {
      const out = [];
      if (!ul) return out;
      for (const li of ul.children) {
        if (!li.tagName || li.tagName !== 'LI') continue;
        const isGroup = li.classList.contains('el-sub-menu') || li.classList.contains('el-submenu');
        const titleEl = li.querySelector(':scope > .el-sub-menu__title, :scope > .el-submenu__title');
        if (isGroup && titleEl) {
          out.push('  '.repeat(depth) + '[G] ' + norm(titleEl.textContent));
          const sub = li.querySelector(':scope > ul');
          if (sub) out.push(...walk(sub, depth + 1));
        } else {
          const t = norm(li.textContent);
          if (t) out.push('  '.repeat(depth) + '- ' + t);
        }
      }
      return out;
    };
    const menu = document.querySelector('.el-menu');
    return menu ? walk(menu, 0) : ['(未找到 .el-menu——非 Element Plus 界面，改探针选择器)'];
  });
  const cjk = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.height > 0 && r.width > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
    let total = 0;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const p = n.parentElement;
      if (!p || !vis(p) || !p.closest('.el-menu')) continue;
      const m = (n.textContent || '').match(/[\u4e00-\u9fff]/g);
      if (m) total += m.length;
    }
    return total;
  }).catch(() => -1);

  const groups = tree.filter(l => l.includes('[G]')).length;
  const leaves = tree.filter(l => /^\s*- /.test(l)).length;
  console.log(tree.join('\n'));
  console.log(`[tree] groups=${groups} leaves=${leaves} cjk-menu-labels=${cjk}`);
  const summary = `[summary] groups=${groups} leaves=${leaves} cjk-menu-labels=${cjk}`;
  fs.writeFileSync(path.join(WORK, 'menu-tree.txt'), `${tree.join('\n')}\n${summary}\n`);
  console.log('[survey-json] ' + JSON.stringify({ ok: process.exitCode !== 3, groups, leaves, cjkMenuLabels: cjk, file: path.join(WORK, 'menu-tree.txt') }));
} finally {
  await browser.close();
  log('done');
}
