// 录屏虚拟光标模块：注入页面一个箭头指针 + 点击扩散圈 + 目标高亮框（纯视觉层，不拦截事件）
// 安装器幂等：addInitScript 极早期执行时 documentElement 可能未就绪，此时挂到 DOMContentLoaded 重装；
// Node 侧 aim* 辅助函数每次调用前自动 ensureCursor 补装，杜绝时序竞态。
// 页面侧全局符号统一用 __dmv* 前缀（demo video），避免与目标系统应用变量冲突。
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 页面侧安装器源码（addInitScript 与 evaluate 复用同一份；避免嵌套模板串，内部全部用字符串拼接）
export const CURSOR_SRC = `
(() => {
  if (window.__dmvCursor) return;
  const install = () => {
    if (window.__dmvCursor || !document.documentElement) return false;
    if (window.__dmvCurEls) { window.__dmvCurEls.forEach(e => e.remove()); }
    const mk = (css) => { const d = document.createElement('div'); d.style.cssText = css; return d; };
    const cur = mk('position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform .3s cubic-bezier(.25,.7,.3,1);will-change:transform;');
    cur.innerHTML = '<svg width="26" height="30" viewBox="0 0 26 30" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,.55))"><path d="M4 1.5 L4 22.5 L9.6 17.4 L13 26.2 L17.1 24.6 L13.7 16 L21 16 Z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    const rip = mk('position:fixed;left:0;top:0;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid rgba(255,140,0,.95);background:rgba(255,160,0,.3);opacity:0;z-index:2147483646;pointer-events:none;');
    const hl = mk('position:fixed;left:0;top:0;width:0;height:0;border:2.5px solid rgba(255,176,32,.95);border-radius:6px;box-shadow:0 0 0 2px rgba(255,176,32,.25);opacity:0;z-index:2147483645;pointer-events:none;transition:all .18s ease;');
    document.documentElement.appendChild(cur);
    document.documentElement.appendChild(rip);
    document.documentElement.appendChild(hl);
    window.__dmvCurEls = [cur, rip, hl];
    window.__dmvCursor = {
      tip: { x: 0, y: 0 },
      target: null,
      aim: function (el) {
        const self = window.__dmvCursor;
        const r0 = el && el.getBoundingClientRect();
        if (!el || !document.contains(el) || !r0 || r0.width < 2 || r0.height < 2) return false;
        self.target = el;
        const x = Math.max(2, Math.min(window.innerWidth - 4, r0.left + r0.width / 2));
        const y = Math.max(2, Math.min(window.innerHeight - 4, r0.top + Math.min(r0.height / 2, 16)));
        cur.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 1) + 'px)';
        self.tip = { x: x, y: y };
        hl.style.left = (r0.left - 3) + 'px';
        hl.style.top = (r0.top - 3) + 'px';
        hl.style.width = (r0.width + 6) + 'px';
        hl.style.height = (r0.height + 6) + 'px';
        hl.style.opacity = '1';
        clearTimeout(window.__dmvHlT);
        window.__dmvHlT = setTimeout(() => { hl.style.opacity = '0'; }, 1100);
        return true;
      },
      ripple: function () {
        const p = window.__dmvCursor.tip;
        rip.style.left = p.x + 'px';
        rip.style.top = p.y + 'px';
        if (rip.animate) rip.animate([{ opacity: .95, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(2.8)' }], { duration: 460, easing: 'ease-out' });
      },
      fire: function () {
        const self = window.__dmvCursor;
        self.ripple();
        let ok = false;
        try {
          if (self.target && document.contains(self.target) && self.target.getBoundingClientRect().height > 0) {
            // SVGElement 没有 .click()（返回箭头、卡片 More 图标都是 svg），退回派发 click 事件
            if (typeof self.target.click === 'function') self.target.click();
            else self.target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            ok = true;
          }
        } catch { /* 目标被重渲染则返回 false 由上层处理 */ }
        return ok;
      }
    };
    return true;
  };
  window.__dmvCursorInstall = install;
  if (!install() && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  }
})()
`;

export async function installCursor(page) {
  await page.addInitScript(CURSOR_SRC);
}

export async function ensureCursor(page) {
  await page.evaluate(CURSOR_SRC).catch(() => {});
}

// 定位并滑向目标（findEval 在页面内查找元素并调用 __dmvCursor.aim(el)，返回布尔）
export async function aim(page, findEval) {
  await ensureCursor(page);
  return page.evaluate(findEval);
}

// 滑向目标 → 停顿让滑动动画可见 → 扩散圈 + el.click()
// 关键：点击前重新定位目标——列表轮询/数据刷新会重建 DOM，
// 若直接点 430ms 前缓存的节点会落到已分离的旧元素上（表现为"点了没反应"）。
// 重定位与点击分两次 evaluate（间隔仅一次往返，约毫秒级），把失效窗口压到最小。
export async function aimClick(page, findEval) {
  await ensureCursor(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await page.evaluate(findEval))) return false; // 滑向目标（动画可见）
    await sleep(430);
    if (!(await page.evaluate(findEval))) return false; // 重新定位到最新节点
    const ok = await page.evaluate(() => window.__dmvCursor.fire()); // 立即点击
    await sleep(160);
    if (ok) return true;
    await sleep(350);
  }
  return false;
}

// 滑向目标 → 停顿 → 只放扩散圈；真实点击由调用方用 Playwright locator 完成（el-select 等必须真实点击的控件）
export async function aimRipple(page, findEval) {
  await ensureCursor(page);
  if (!(await page.evaluate(findEval))) return false;
  await sleep(430);
  await page.evaluate(() => window.__dmvCursor.ripple());
  await sleep(120);
  return true;
}
