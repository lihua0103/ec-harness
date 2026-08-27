import type { Context } from '@deepseek-ai/cordis'

export interface BrandingConfig {
  brandName?: string
  brandShortName?: string
}

const BRAND_GLOBAL = '__DSH_ENTERPRISE_BRAND__'

const CLIENT_SCRIPT = `
;(function() {
  var brand = globalThis["__DSH_ENTERPRISE_BRAND__"]
  if (!brand) return
  var BRAND_ATTRS = ['aria-label', 'title', 'alt', 'placeholder']
  function brandReplace(value) {
    return value
      .replace(/DeepSeek(?: Harness)?/gi, function() { return brand.brandName })
      .replace(/\bDSH\b/g, function() { return brand.brandShortName })
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
 * 注册品牌白标：注入全局品牌对象、替换 manifest/favicon、在页面加载时执行客户端脚本。
 * 通过 webServer.tapIndex() 方法实现，不修改 harness 源码。
 */
export function registerBranding(ctx: Context, config: BrandingConfig): () => void {
  const webServer = ctx.get('webServer')
  if (!webServer) throw new Error('[branding] webServer 服务不存在')

  const brandName = config.brandName || 'DSH Enterprise'
  const brandShortName = config.brandShortName || 'DSH'
  const brandObj = { brandName, brandShortName }

  const globalVar = `globalThis[${JSON.stringify(BRAND_GLOBAL)}] = ${JSON.stringify(brandObj)}`

  const transform = (html: string): string => {
    let result = html
    result = result.replace(
      /<meta name="application-name"[^>]*>/i,
      `<meta name="application-name" content="${brandName}">`
    )
    result = result.replace(/<title>[^<]*<\/title>/i, `<title>${brandName}</title>`)
    result = result.replace(
      /<link rel="icon"[^>]*>/gi,
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg">'
    )
    if (!result.includes(BRAND_GLOBAL)) {
      const scriptTag = `<script>${globalVar}</script>`
      result = result.replace('</head>', `${scriptTag}</head>`)
    }
    if (!result.includes('MutationObserver(schedule)')) {
      const brandScriptTag = `<script>${CLIENT_SCRIPT}</script>`
      result = result.replace('</body>', `${brandScriptTag}</body>`)
    }
    return result
  }

  // 使用 tapIndex 而不是 on('webserver/index-inject')
  return webServer.tapIndex(transform)
}
