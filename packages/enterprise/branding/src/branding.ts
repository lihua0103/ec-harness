import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

export interface BrandingConfig {
  /** 完整品牌名（1..80 字符，禁尖括号；env DSH_BRAND_NAME 兜底）。 */
  brandName?: string
  /** 短名（1..24 字符，禁尖括号；env DSH_BRAND_SHORT_NAME 兜底）。 */
  brandShortName?: string
}

/** 官方结构化注入行的结构子集（webserver 包，按名镜像——见 ADR-0002 决策 3）。 */
export type IndexInjectionRow =
  | { kind: 'html'; placement: 'head' | 'body'; html: string }

/** 本插件用到的 `ctx.webServer` 服务面（结构子集）。 */
interface WebServerLike {
  tapIndex(transform: (html: string) => string): () => void
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'webserver/index-inject': (table: IndexInjectionRow[]) => void
  }
}

const BRAND_GLOBAL = '__DSH_ENTERPRISE_BRAND__'
const FAVICON_URL = new URL('../assets/branding/favicon.svg', import.meta.url)

/** 解析并校验品牌配置（ADR-0002 决策 4）：patch config → env 兜底 → 中性默认。 */
export function validateBrandingConfig(config: BrandingConfig = {}): { brandName: string; brandShortName: string } {
  const brandName = config.brandName || process.env.DSH_BRAND_NAME || 'DSH Enterprise'
  const brandShortName = config.brandShortName || process.env.DSH_BRAND_SHORT_NAME || 'DSH'
  for (const [field, value, max] of [
    ['brandName', brandName, 80],
    ['brandShortName', brandShortName, 24],
  ] as const) {
    if (value.length < 1 || value.length > max) {
      throw new Error(`[branding] ${field} 长度必须是 1..${max}（当前 ${value.length}）`)
    }
    if (/[<>]/.test(value)) {
      throw new Error(`[branding] ${field} 不允许包含尖括号（防 HTML 注入）`)
    }
  }
  return { brandName, brandShortName }
}

/** HTML 文本/属性上下文转义。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** script 上下文安全 JSON：`</script>` 经 `<` 失效。 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

const CLIENT_SCRIPT = `
;(function() {
  var brand = globalThis["__DSH_ENTERPRISE_BRAND__"]
  if (!brand) return
  var BRAND_ATTRS = ['aria-label', 'title', 'alt', 'placeholder']
  function brandReplace(value) {
    return value
      .replace(/DeepSeek(?: Harness)?/gi, function() { return brand.brandName })
      .replace(/\\bDSH\\b/g, function() { return brand.brandShortName })
  }
  function inNoBrand(node) {
    for (var anc = node; anc; anc = anc.parentElement) {
      if (anc.dataset && 'noBrand' in anc.dataset) return true
    }
    return false
  }
  function apply() {
    if (document.title !== brand.brandName) document.title = brand.brandName
    if (!document.body) return
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      var node = walker.currentNode
      if (inNoBrand(node.parentElement)) continue
      var replaced = brandReplace(node.nodeValue)
      if (replaced !== node.nodeValue) node.nodeValue = replaced
    }
    var elements = document.body.querySelectorAll('*')
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i]
      if (inNoBrand(el)) continue
      for (var j = 0; j < BRAND_ATTRS.length; j++) {
        var name = BRAND_ATTRS[j]
        var value = el.getAttribute(name)
        if (!value) continue
        var attrReplaced = brandReplace(value)
        if (attrReplaced !== value) el.setAttribute(name, attrReplaced)
      }
    }
    if (!document.getElementById('brand-logo-css')) {
      var style = document.createElement('style')
      style.id = 'brand-logo-css'
      style.textContent = 'div[class*="logoRow"] button[class*="brand"] .jIPhXG_brandIdentity, svg[class*="railFish"] { display: none !important; }'
      document.head.append(style)
    }
    var brandBtn = document.querySelector('div[class*="logoRow"] > button[class*="brand"]')
    if (brandBtn && !brandBtn.querySelector('[data-brand-logo]')) {
      var wrap = document.createElement('span')
      wrap.setAttribute('data-brand-logo', '')
      wrap.style.cssText = 'display:inline-flex;align-items:center;gap:8px;color:inherit;'
      var img = document.createElement('img')
      img.src = '/favicon.svg'
      img.alt = ''
      img.width = 22
      img.height = 22
      var label = document.createElement('span')
      label.textContent = brand.brandName
      label.style.cssText = 'font-size:15px;font-weight:600;letter-spacing:.2px;white-space:nowrap;'
      wrap.append(img, label)
      brandBtn.append(wrap)
    }
    var fish = document.querySelector('svg[class*="railFish"]')
    var railImg = document.querySelector('img[data-brand-fish]')
    if (fish && !railImg) {
      var fishImg = document.createElement('img')
      fishImg.src = '/favicon.svg'
      fishImg.alt = brand.brandShortName
      fishImg.width = fish.width.baseVal.value || 24
      fishImg.height = fish.height.baseVal.value || 24
      var fishClass = fish.getAttribute('class') || ''
      fishImg.setAttribute('class', fishClass)
      fishImg.setAttribute('data-brand-fish', '')
      fishImg.style.cssText = 'display: block; pointer-events: none;'
      fish.parentNode.insertBefore(fishImg, fish)
      fish.style.display = 'none'
    } else if (!fish && railImg) {
      railImg.remove()
    }
    var allSvgs = document.querySelectorAll('svg')
    for (var k = 0; k < allSvgs.length; k++) {
      var svg = allSvgs[k]
      var ariaLabel = svg.getAttribute('aria-label')
      if (ariaLabel && /deepseek/i.test(ariaLabel)) {
        svg.setAttribute('aria-label', brandReplace(ariaLabel))
      }
    }
  }
  apply()
  var scheduled = false
  function schedule() {
    if (scheduled) return
    scheduled = true
    setTimeout(function() { scheduled = false; apply() }, 100)
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true })
})();
`

/**
 * 注册品牌白标（ADR-0002）：
 * - 结构化注入行（`webserver/index-inject`）承载全局品牌对象与客户端脚本；
 * - `tapIndex` 仅做无法表达为行的字符串替换（title / application-name / icon link）；
 * - `/favicon.svg` 与 `/manifest.webmanifest` 两条 no-store 具名路由（此前 404，修审计 B-6）；
 * - 品牌值经长度/字符校验 + HTML 转义后才进入替换与 script 上下文（防注入）。
 */
export function registerBranding(ctx: Context, config: BrandingConfig): () => void {
  const webServer = (ctx as unknown as { get?: (name: string) => WebServerLike | undefined }).get?.('webServer')
  if (!webServer) throw new Error('[branding] webServer 服务不存在')

  const { brandName, brandShortName } = validateBrandingConfig(config)
  const brandObj = { brandName, brandShortName }

  const globalVar = `globalThis[${JSON.stringify(BRAND_GLOBAL)}] = ${jsonForScript(brandObj)}`
  const safeName = escapeHtml(brandName)

  const transform = (html: string): string => {
    let result = html
    result = result.replace(
      /<meta name="application-name"[^>]*>/i,
      `<meta name="application-name" content="${safeName}">`,
    )
    result = result.replace(/<title>[^<]*<\/title>/i, `<title>${safeName}</title>`)
    result = result.replace(
      /<link rel="icon"[^>]*>/gi,
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
    )
    return result
  }

  const disposers: Array<() => void> = []

  disposers.push(ctx.on('webserver/index-inject', rows => {
    rows.push({ kind: 'html', placement: 'head', html: `<script>${globalVar}</script>` })
    rows.push({ kind: 'html', placement: 'body', html: `<script>${CLIENT_SCRIPT}</script>` })
  }))

  disposers.push(webServer.register({
    kind: 'exact', path: '/favicon.svg',
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      try {
        const body = await readFile(fileURLToPath(FAVICON_URL))
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' })
        res.end(body)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('favicon not found')
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact', path: '/manifest.webmanifest',
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      const manifest = JSON.stringify({
        name: brandName,
        short_name: brandShortName,
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
        display: 'standalone',
        start_url: '/',
      })
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' })
      res.end(manifest)
    },
  }))

  disposers.push(webServer.tapIndex(transform))

  return () => { for (const dispose of disposers.splice(0)) dispose() }
}
