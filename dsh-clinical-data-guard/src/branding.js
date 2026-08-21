import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FAVICON_URL = new URL('../assets/branding/favicon.svg', import.meta.url);

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

export function registerBranding(ctx, config = {}) {
  // FIX-12 (AF-07): 缺 webServer 服务时 fail-fast——品牌注入是部署契约的一部分，
  // 静默降级会导致未品牌化页面流入生产。
  if (!ctx?.webServer || typeof ctx.webServer.tapIndex !== 'function' || typeof ctx.webServer.register !== 'function') {
    throw new Error('[clinical-data-guard] webServer service is required for branding registration');
  }
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
  ];
  return () => disposers.reverse().forEach((dispose) => dispose());
}
