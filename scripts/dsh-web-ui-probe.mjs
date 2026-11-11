// DSH Web 真实运行 — UI 结构探针
//
// 设计原则（与安全边界一致）：
// 1. 启动令牌只存在于本进程内存：从 dsh web 的 stdout 读入后立即交给
//    page.goto 完成会话交换，随即清空引用。不打印、不写盘、不进报告、
//    不传给任何第三方。
// 2. 页面交换后地址栏回到干净的 `./`，后续截图与 DOM 转储不含令牌。
// 3. 探针只观察 UI 结构（标题、可见文本、可交互元素），不触发业务操作。
//
// 用法：node scripts/dsh-web-ui-probe.mjs

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('D:/package/Nvm/nvm/node_global/node_modules/@playwright/mcp/node_modules/playwright-core')

const projectRoot = 'D:/project/company/ec-clinical-dsh'
const upstream = path.join(projectRoot, 'upstream', 'deepseek-harness-git')
const home = path.join(projectRoot, '.runtime', 'dsh-home')
const outDir = path.join(projectRoot, '.runtime', 'dvp-web-e2e', 'probe')
const port = 3081
fs.mkdirSync(outDir, { recursive: true })

const server = spawn(
  process.execPath,
  ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'],
  { cwd: upstream, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
)

let output = ''
let launchUrl
let launchUrlConsumed = false

server.stdout.on('data', chunk => {
  output += chunk.toString()
  if (launchUrl === undefined) {
    const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S+)/)
    if (match) launchUrl = match[1]
  }
})
server.stderr.on('data', chunk => { output += chunk.toString() })

function fail(reason) {
  console.error('PROBE-FAILED', reason)
  try { server.kill() } catch {}
  process.exit(1)
}

const deadline = Date.now() + 120_000
while (launchUrl === undefined) {
  if (server.exitCode !== null) fail(`server exited early (code ${server.exitCode})`)
  if (Date.now() > deadline) fail('no dsh web URL line within 120s')
  await new Promise(resolve => setTimeout(resolve, 250))
}

let browser
try {
  browser = await chromium.launch({ headless: false })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(launchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // 令牌已一次性消费，清空引用。
  launchUrl = undefined
  launchUrlConsumed = true
  await page.waitForTimeout(6000)

  const cleanHref = page.url()
  await page.screenshot({ path: path.join(outDir, 'probe-01.png') })

  const structure = await page.evaluate(() => {
    const describe = el => {
      const attrs = {}
      for (const name of ['type', 'placeholder', 'aria-label', 'role', 'title', 'data-testid']) {
        const value = el.getAttribute(name)
        if (value) attrs[name] = value
      }
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || '').trim().slice(0, 120),
        attrs,
      }
    }
    return {
      title: document.title,
      href: location.href,
      bodyText: (document.body?.innerText ?? '').slice(0, 6000),
      interactive: Array.from(
        document.querySelectorAll('textarea, input, button, [role="button"], [contenteditable="true"], a'),
      ).slice(0, 80).map(describe),
    }
  })

  fs.writeFileSync(
    path.join(outDir, 'probe-structure.json'),
    JSON.stringify({ cleanHref, structure }, null, 2),
    'utf8',
  )
  console.log('PROBE-OK', JSON.stringify({
    title: structure.title,
    href: structure.href,
    bodyTextLength: structure.bodyText.length,
    interactive: structure.interactive.length,
    tokenConsumed: launchUrlConsumed && launchUrl === undefined,
  }))
} catch (error) {
  fail(error && error.stack ? error.stack : String(error))
} finally {
  try { await browser?.close() } catch {}
  try { server.kill() } catch {}
}