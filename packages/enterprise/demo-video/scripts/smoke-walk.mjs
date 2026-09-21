// ═══════════════════════════════════════════════════════════════════════════
// 样例 walk 脚本（无登录静态页；examples/demo-page/index.html 的配套走查）。
// 用途：①插件冒烟验收——不依赖目标系统与账号即可全链路跑通 S1–S4；
//      ②新模块 walk 脚本的"最小骨架"参考（对照 walk-template.mjs 的完整实例）。
// 运行契约与完整模板一致：DV_WORK/DV_BASE/DV_PW/DV_CHROME/DV_MODULE 环境变量，
// 依赖 ./cursor.mjs 同目录（录制工具自动同步），产出 <DV_WORK>/timings.json。
// 数据安全：静态演示页，无写库面；真实系统录制请遵守模板头部红线。
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = require(process.env.DV_PW || 'playwright-core');
import { installCursor, ensureCursor } from './cursor.mjs';

const WORK = process.env.DV_WORK;
if (!WORK) { console.error('[fatal] 缺少 DV_WORK 环境变量'); process.exit(2); }
const MODULE = (process.env.DV_MODULE || 'smoke').replace(/[^\w.-]/g, '') || 'smoke';
const VDIR = path.join(WORK, 'record');
fs.mkdirSync(VDIR, { recursive: true });

const BASE = (process.env.DV_BASE || '').trim().replace(/\/+$/, '') + '/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const steps = [], actions = [];
// 闪光墙钟秒（掐头对齐基准）：try 内赋值，finally 写入 timings.json（S2 契约字段）
let flashWall = null;
const step = (name, ok, extra = '') => { steps.push({ name, ok, t: +(((Date.now() - t0) / 1000).toFixed(2)) }); console.log(`[step] ${name}: ${ok ? 'OK' : 'FAIL'}${extra ? ' | ' + extra : ''}`); };
// 黑条打点（与完整模板同一机制：顶边 120x6 黑条 110ms，后期逐动作提取真实视频时刻）
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
const ready = async () => { await ensureCursor(page); };
// aim + fire：先滑虚拟光标（动画可见），停顿后重新定位并点击（列表重渲染兜底）
const aimClickText = async (text) => {
  await ready();
  for (let i = 0; i < 2; i++) {
    const aimed = await page.evaluate(t => {
      if (!window.__dmvCursor) return false;
      const vis = el => { const r = el && el.getBoundingClientRect(); return !!r && r.height > 0 && r.width > 0; };
      const el = [...document.querySelectorAll('button, .link, .tab, .menu div')].filter(vis)
        .find(x => (x.textContent || '').replace(/\s+/g, '') === t);
      return el ? window.__dmvCursor.aim(el) : false;
    }, text);
    if (!aimed) return false;
    await sleep(430);
    const ok = await page.evaluate(() => window.__dmvCursor.fire());
    await sleep(160);
    if (ok) return true;
    await sleep(320);
  }
  return false;
};
const dialogOpen = () => page.evaluate(() => { const d = document.querySelector('.dialog-mask'); return !!d && d.classList.contains('show'); }).catch(() => false);
const menuOpen = () => page.evaluate(() => { const m = document.getElementById('export-menu'); return !!m && m.classList.contains('show'); }).catch(() => false);
const rowCount = () => page.evaluate(() => document.querySelectorAll('#rows tr').length).catch(() => 0);

const browser = await pw.chromium.launch({ executablePath: process.env.DV_CHROME || undefined, headless: true, args: ['--window-size=1920,1080'] });
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 }, locale: 'en-US', timezoneId: 'Asia/Shanghai',
  recordVideo: { dir: VDIR, size: { width: 1920, height: 1080 } }
});
ctx.setDefaultTimeout(10000);
const page = await ctx.newPage();
let navCount = 0;
page.on('framenavigated', f => { if (f === page.mainFrame()) navCount++; });
await installCursor(page);

try {
  console.log('[tour] BASE=' + BASE.replace(/\/\/[^/]+/, '//[local]') + ' module=' + MODULE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#btn-export', { timeout: 15000 });
  await ready();
  await beat(1600);

  // ===== 片头：列表静止帧 → 闪光标记（成片掐头锚）=====
  await aimClickText('Version1').catch(() => {});
  await beat(800);
  flashWall = +(((Date.now() - t0) / 1000).toFixed(2));
  await page.evaluate(() => {
    const f = document.createElement('div');
    f.id = '__dmvFlash';
    f.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483000;pointer-events:none;';
    document.documentElement.appendChild(f);
    setTimeout(() => f.remove(), 260);
  });
  await sleep(900);
  step('样例页就绪', true);
  act('page_ready');
  await beat(2200);

  // ===== 导出下拉（打开→收起，不点导出项）=====
  act('export_menu');
  await aimClickText('Export');
  await beat(900);
  const menuOk = await menuOpen();
  await page.keyboard.press('Escape').catch(() => {});
  await beat(600);
  step('导出下拉', menuOk);

  // ===== 稽查轨迹弹窗（打开→取消，绝不提交）=====
  act('dialog_open');
  await aimClickText('AuditTrail');
  await beat(1000);
  const dlgOk = await dialogOpen();
  await beat(1600);
  act('dialog_cancel');
  await aimClickText('Cancel');
  await beat(700);
  const dlgClosed = !(await dialogOpen());
  step('弹窗展示并取消', dlgOk && dlgClosed);

  // ===== 切换 Data tab =====
  act('tab_data');
  await aimClickText('Data');
  await beat(1500);
  step('Data 标签页', true);

  // ===== 创建记录（演示页仅内存追加）=====
  act('record_created');
  const before = await rowCount();
  await aimClickText('CreateRecord');
  await beat(1200);
  const after = await rowCount();
  step('创建记录', after > before, '行数 ' + before + '→' + after);

  // ===== 查询 =====
  act('query_done');
  await aimClickText('Query');
  await beat(1200);
  step('查询', true);

  // ===== 回 Processes tab 收尾 =====
  act('back_processes');
  await aimClickText('Processes');
  await beat(1200);
  step('返回 Processes', true);
  // 收尾停顿给旁白末句 + ≥3s 尾留白（S3/S4 验收门需要成片尾部余量）
  await beat(4800);
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
  fs.writeFileSync(path.join(WORK, 'timings.json'), JSON.stringify({ module: MODULE, steps, actions, totalDuration: +dur, video: saved, flashWall, navigations: navCount }, null, 1));
  console.log('---');
  console.log(`[result] 总耗时=${dur}s 步骤=${steps.filter(s => s.ok).length}/${steps.length}通过 打点=${actions.length} 导航=${navCount}`);
  console.log(`[result] 视频=${saved ? saved : '未生成'} (${size})`);
}
