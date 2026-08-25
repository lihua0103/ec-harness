import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FAVICON_URL = new URL('../assets/branding/favicon.svg', import.meta.url);

const SETTINGS_BODY_LIMIT_BYTES = 1024;

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function validateBrandingConfig(raw = {}) {
  const brandName = (raw.brandName ?? process.env.EMERALD_BRAND_NAME ?? 'Emerald Clinical').trim();
  const brandShortName = (raw.brandShortName ?? process.env.EMERALD_BRAND_SHORT_NAME ?? 'Emerald').trim();
  if (!brandName || brandName.length > 80 || /[<>]/.test(brandName)) {
    throw new Error('brandName must be 1..80 characters and cannot contain angle brackets');
  }
  if (!brandShortName || brandShortName.length > 24 || /[<>]/.test(brandShortName)) {
    throw new Error('brandShortName must be 1..24 characters and cannot contain angle brackets');
  }
  return { brandName, brandShortName };
}

// FIX-8: 设置页"通用设置"区块数据拦截开关。
// 锚点用官方插槽属性 [data-slot="settings.general.item"]（ui-settings-general
// GeneralSection 渲染契约，跨版本稳定）；行布局复刻 LanguageRow Setting-Cell
// （figma 501:30011）规范，配色用 --dsw-alias-* 主题变量自动适配明暗主题。
// 防重复：注入前在 .then 内重新解析存活 section 并清理全文档残留节点，
// 规避 fetch 异步窗口内 React 重挂载导致的重复注入/孤儿注入。
function settingsToggleScript() {
  return `
<script>
(function() {
  const API_BASE = '/api/settings/data-interception';
  const ITEM_SLOT = 'settings.general.item';
  const TOGGLE_ID = 'clinical-data-guard-setting';
  let currentState = null;

  // 定位通用设置区块列：任一现有 item 行的父级即 section 列
  function findSectionColumn() {
    const item = document.querySelector('[data-slot="' + ITEM_SLOT + '"]');
    return item && item.parentElement && item.parentElement.isConnected
      ? item.parentElement
      : null;
  }

  function renderState(root, enabled) {
    const desc = root.querySelector('[data-cdg-desc]');
    const knob = root.querySelector('[data-cdg-knob]');
    const track = root.querySelector('[data-cdg-track]');
    if (desc) desc.textContent = enabled
      ? '已启用 — SAS 数据与 Excel 单元格数据将被拦截。流程引导和智能功能正常工作'
      : '已禁用 — 数据内容不拦截，流程引导和智能功能仍生效（Harness 可直接处理数据，切换将自动重启进程）';
    if (knob) knob.style.transform = enabled ? 'translateX(18px)' : 'translateX(0)';
    if (track) {
      track.style.background = enabled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l2)';
      track.setAttribute('aria-checked', String(enabled));
    }
  }

  function createToggleItem(enabled) {
    // 外层 wrapper 带 data-slot 属性：与原生 item 同构，复用 section 的 :last-child 去底边框规则
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-slot', ITEM_SLOT);
    wrapper.id = TOGGLE_ID;
    wrapper.setAttribute('data-clinical', ''); // 品牌文本替换跳过此容器

    // 复刻 LanguageRow .row（Setting-Cell 单行：border/padding/align-center/gap 8）
    const row = document.createElement('div');
    row.style.cssText = 'border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex;';

    // 复刻 .rowText（flex:1 / column / gap 4 / padding-right 48）
    const rowText = document.createElement('div');
    rowText.style.cssText = 'flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex;';

    const title = document.createElement('div');
    title.textContent = '临床数据出域拦截';
    // 复刻 .title（label-primary / 14px / line-height 22px）
    title.style.cssText = 'color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px;';

    const desc = document.createElement('div');
    desc.setAttribute('data-cdg-desc', '');
    desc.style.cssText = 'color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;';

    const track = document.createElement('button');
    track.type = 'button';
    track.setAttribute('data-cdg-track', '');
    track.setAttribute('role', 'switch');
    track.style.cssText = 'flex:none;width:40px;height:22px;border-radius:11px;border:none;cursor:pointer;position:relative;transition:background .2s;padding:0;';
    const knob = document.createElement('span');
    knob.setAttribute('data-cdg-knob', '');
    knob.style.cssText = 'position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .2s;';
    track.appendChild(knob);

    track.onclick = function() {
      const next = !currentState;
      currentState = next; // 乐观更新
      renderState(wrapper, next);
      fetch(API_BASE, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataInterceptionEnabled: next })
      }).then(r => r.json()).then(data => {
        currentState = !!data.dataInterceptionEnabled;
        renderState(wrapper, currentState);
      }).catch(() => {
        currentState = !next; // 失败回滚
        renderState(wrapper, currentState);
      });
    };

    rowText.append(title, desc);
    row.append(rowText, track);
    wrapper.appendChild(row);
    renderState(wrapper, enabled);
    return wrapper;
  }

  function injectToggle() {
    const section = findSectionColumn();
    if (!section) return; // 设置面板未打开，等 MutationObserver 下次触发
    // 稳态早退：开关已在存活 section 内则不动作（避免 observer 自触发死循环）
    if (section.querySelector('[id="' + TOGGLE_ID + '"]')) return;
    // 异常态（缺失/被 React 移出/重复）：fetch 后全文档清理并重建
    fetch(API_BASE).then(r => r.json()).then(data => {
      const live = findSectionColumn();
      if (!live) return;
      if (live.querySelector('[id="' + TOGGLE_ID + '"]')) return; // 期间已注入
      // 关键：fetch 异步窗口内 React 可能重挂载 section——清理全文档残留
      // （含被 React 重新父级化到别处的旧注入），杜绝双开关
      document.querySelectorAll('[id="' + TOGGLE_ID + '"]').forEach(n => n.remove());
      currentState = !!data.dataInterceptionEnabled;
      live.appendChild(createToggleItem(currentState));
    }).catch(() => {});
  }

  // 防抖监听：设置面板由客户端按需渲染（React 重渲染可能移除注入节点，自动重注）
  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(injectToggle, 150);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  injectToggle();
})();
</script>`;
}

export function brandHtml(html, config = {}) {
  const { brandName, brandShortName } = validateBrandingConfig(config);
  const escapedName = escapeHtml(brandName);
  const brandJson = JSON.stringify(brandName).replaceAll('<', '\\u003c');
  const title = `<title>${escapedName}</title>`;
  const markup = [
    `<meta name="application-name" content="${escapedName}">`,
    `<script>(() => {`,
    `  const brand = ${brandJson};`,
    `  const apply = () => {`,
    `    if (document.title !== brand) document.title = brand;`,
    `    if (!document.body) return;`,
    `    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);`,
    `    while (walker.nextNode()) {`,
    `      const node = walker.currentNode;`,
    `      // ST-P2-9: 跳过 data-clinical 祖先容器内的文本节点，避免误改临床文本中的 DSH 缩写`,
    `      let _skip = false, _anc = node.parentElement;`,
    `      while (_anc) { if (_anc.dataset && 'clinical' in _anc.dataset) { _skip = true; break; } _anc = _anc.parentElement; }`,
    `      if (_skip) continue;`,
    `      const replaced = node.nodeValue`,
    `        .replace(/DeepSeek(?: Harness)?/gi, brand)`,
    `        .replace(/\\bDSH\\b/g, ${JSON.stringify(brandShortName)});`,
    `      if (replaced !== node.nodeValue) node.nodeValue = replaced;`,
    `    }`,
    // 左上角标志是内联 SVG（BrandWordmark/FishLogo path 图形），文本替换覆盖不到。
    // 注意：这些节点由 React 管理，不能 replaceWith/remove（removeChild 找不到节点会让
    // 整个 sidebar slot 崩溃）。改为注入 CSS 隐藏原 SVG，再追加我们自己的品牌元素——
    // React 只移除自己创建的节点，追加的兄弟节点不影响协调。
    `    if (!document.getElementById('brand-logo-css')) {`,
    `      const style = document.createElement('style');`,
    `      style.id = 'brand-logo-css';`,
    `      style.textContent = 'div[class*="logoRow"] > button[class*="brand"] > svg, svg[class*="railFish"] { display: none !important; }';`,
    `      document.head.append(style);`,
    `    }`,
    `    const brandBtn = document.querySelector('div[class*="logoRow"] > button[class*="brand"]');`,
    `    if (brandBtn && !brandBtn.querySelector('[data-brand-logo]')) {`,
    `      const wrap = document.createElement('span');`,
    `      wrap.setAttribute('data-brand-logo', '');`,
    `      wrap.style.cssText = 'display:inline-flex;align-items:center;gap:8px;color:inherit;';`,
    `      const img = document.createElement('img');`,
    `      img.src = '/favicon.svg';`,
    `      img.alt = '';`,
    `      img.width = 22;`,
    `      img.height = 22;`,
    `      const label = document.createElement('span');`,
    `      label.textContent = brand;`,
    `      label.style.cssText = 'font-size:15px;font-weight:600;letter-spacing:.2px;white-space:nowrap;';`,
    `      wrap.append(img, label);`,
    `      brandBtn.append(wrap);`,
    `    }`,
    `    const fish = document.querySelector('svg[class*="railFish"]');`,
    `    const railImg = document.querySelector('img[data-brand-fish]');`,
    `    if (fish && !railImg) {`,
    `      const fishImg = document.createElement('img');`,
    `      fishImg.src = '/favicon.svg';`,
    `      fishImg.alt = '';`,
    `      fishImg.width = fish.width.baseVal.value || 24;`,
    `      fishImg.height = fish.height.baseVal.value || 24;`,
    // 继承 railFish 类名以复用原 CSS（定位、hover 与面板图标互换），隐藏规则只针对 svg 标签
    `      fishImg.setAttribute('class', fish.getAttribute('class') || '');`,
    `      fishImg.setAttribute('data-brand-fish', '');`,
    `      fish.after(fishImg);`,
    `    } else if (!fish && railImg) {`,
    // 侧边栏展开后 React 会移除 fish svg，清理我们追加的图标避免残留在 toggle 按钮里
    `      railImg.remove();`,
    `    }`,
    `  };`,
    `  apply();`,
    // FIX-11 (FR-18-13): 写回仅在值变化时发生 + ≥100ms 防抖，避免宿主页面变异风暴。
    `  let scheduled = false;`,
    `  const schedule = () => {`,
    `    if (scheduled) return;`,
    `    scheduled = true;`,
    `    setTimeout(() => { scheduled = false; apply(); }, 100);`,
    `  };`,
    `  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });`,
    `})();</script>`
  ].join('\n');

  const hasTitle = /<title[^>]*>.*?<\/title>/i.test(html);
  let output = hasTitle
    ? html.replace(/<title[^>]*>.*?<\/title>/i, title)
    : `${title}\n${html}`;
  if (output.includes('</head>')) {
    output = output.replace('</head>', `${markup}\n</head>`);
  } else {
    output = `${markup}\n${output}`;
  }

  // FIX-8: 添加设置页面开关注入脚本
  if (output.includes('</body>')) {
    output = output.replace('</body>', `${settingsToggleScript()}\n</body>`);
  }

  return output;
}

export function brandManifest(config = {}) {
  const { brandName, brandShortName } = validateBrandingConfig(config);
  return {
    id: '/',
    name: brandName,
    short_name: brandShortName,
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}

async function serveFixedAsset(res, body, contentType, method) {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(method === 'HEAD' ? undefined : body);
}

export function registerBranding(ctx, config = {}, policy) {
  // FIX-12 (AF-07): 缺 webServer 服务时 fail-fast——品牌注入是部署契约的一部分，
  // 静默降级会导致未品牌化页面流入生产。
  if (!ctx?.webServer || typeof ctx.webServer.tapIndex !== 'function' || typeof ctx.webServer.register !== 'function') {
    throw new Error('[clinical-data-guard] webServer service is required for branding registration');
  }
  if (!policy || typeof policy.isEnabled !== 'function' || typeof policy.setEnabled !== 'function') {
    throw new Error('[clinical-data-guard] data interception policy is required for branding registration');
  }

  const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

  const handleDataInterception = async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, JSON_HEADERS);
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload));
    };

    if (req.method === 'GET' || req.method === 'HEAD') {
      send(200, { dataInterceptionEnabled: policy.isEnabled(), mode: policy.isEnabled() ? 'data-blocking' : 'open', modeDescription: policy.isEnabled() ? '数据拦截已启用 - 数据内容将被拦截，流程引导和智能功能正常工作' : '数据拦截已关闭 - 数据内容不拦截，流程引导和智能功能仍生效（Harness 可直接处理数据）' });
      return;
    }

    if (req.method === 'PUT') {
      const contentType = String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        send(415, { error: 'Content-Type must be application/json' });
        return;
      }
      const fetchSite = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase();
      const origin = String(req.headers?.origin ?? '');
      const host = String(req.headers?.host ?? '');
      if (fetchSite === 'cross-site' || (origin && host && (() => {
        try { return new URL(origin).host !== host; } catch { return true; }
      })())) {
        send(403, { error: 'Cross-site settings changes are not allowed' });
        return;
      }

      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > SETTINGS_BODY_LIMIT_BYTES) {
          send(413, { error: 'Request body is too large' });
          return;
        }
        chunks.push(buffer);
      }
      try {
        const updates = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!updates || Array.isArray(updates) || typeof updates !== 'object'
            || Object.keys(updates).length !== 1
            || typeof updates.dataInterceptionEnabled !== 'boolean') {
          send(400, { error: 'Expected exactly { dataInterceptionEnabled: boolean }' });
          return;
        }
        policy.setEnabled(updates.dataInterceptionEnabled, { source: 'settings-api' });
        send(200, { dataInterceptionEnabled: policy.isEnabled(), mode: policy.isEnabled() ? 'data-blocking' : 'open', modeDescription: policy.isEnabled() ? '数据拦截已启用 - 数据内容将被拦截，流程引导和智能功能正常工作' : '数据拦截已关闭 - 数据内容不拦截，流程引导和智能功能仍生效（Harness 可直接处理数据）' });
      } catch {
        send(400, { error: 'Invalid JSON' });
      }
      return;
    }

    send(405, { error: 'Method not allowed' });
  };

  const disposers = [
    ctx.webServer.tapIndex((html) => brandHtml(html, config)),
    ctx.webServer.register({
      kind: 'exact',
      path: '/manifest.webmanifest',
      handler: async (req, res) => {
        const body = JSON.stringify(brandManifest(config));
        await serveFixedAsset(res, body, 'application/manifest+json; charset=utf-8', req.method);
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/favicon.svg',
      handler: async (req, res) => {
        const body = await readFile(FAVICON_URL);
        await serveFixedAsset(res, body, 'image/svg+xml', req.method);
      },
    }),
    // FIX-8: 数据拦截开关 API
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/settings/data-interception',
      handler: handleDataInterception,
    }),
  ];
  return () => disposers.reverse().forEach((dispose) => dispose());
}
