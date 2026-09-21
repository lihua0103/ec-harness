#!/usr/bin/env node

/**
 * 查询当前使用的智谱 GLM Coding Plan key 的用量。
 *
 * 数据来源是智谱开放平台的 monitor 接口（与官方 glm-plan-usage 插件同源，
 * 见 github.com/zai-org/zai-coding-plugins）：
 *   GET {origin}/api/monitor/usage/quota/limit    套餐额度（5 小时窗口 / 月度 MCP）
 *   GET {origin}/api/monitor/usage/model-usage    模型调用量（按小时分桶）
 *   GET {origin}/api/monitor/usage/tool-usage     内置工具调用量（按小时分桶）
 * 鉴权为 `Authorization: <api-key>`（原样传，不带 Bearer 前缀）。
 *
 * key 解析顺序：--key 参数 > 环境变量 ZAI_CODING_CN_API_KEY
 *   > 仓库根目录 .credentials.yaml 的 refs.ZAI_CODING_CN_API_KEY（与 settings.yaml
 *   的 llm-pi-ai providers 配置一致）。任何输出都不回显 key 明文，只显示尾 4 位。
 *
 * 用法：
 *   node scripts/zai-usage.mjs [--hours 24] [--hourly] [--json]
 *       [--base-url https://open.bigmodel.cn] [--key <key>]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KEY_ENV = 'ZAI_CODING_CN_API_KEY'
const DEFAULT_BASE_URL = 'https://open.bigmodel.cn'
const REQUEST_TIMEOUT_MS = 20_000

function parseArgs(argv) {
  const args = { hours: 24, hourly: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1]
    switch (argv[i]) {
      case '--hours':
        args.hours = Number(value)
        if (!Number.isFinite(args.hours) || args.hours <= 0) {
          fail(`--hours 需要正整数，收到：${value}`)
        }
        i++
        break
      case '--hourly':
        args.hourly = true
        break
      case '--json':
        args.json = true
        break
      case '--base-url':
        if (!value) fail('--base-url 需要一个 URL，例如 https://open.bigmodel.cn')
        args.baseUrl = value
        i++
        break
      case '--key':
        if (!value) fail('--key 需要显式传入 key 值')
        args.key = value
        i++
        break
      default:
        fail(`未知参数：${argv[i]}。可用参数：--hours N --hourly --json --base-url URL --key KEY`)
    }
  }
  return args
}

/** 从 .credentials.yaml 的 refs 块取指定 env 名对应的 key（只解析这一块，不引入 YAML 依赖）。 */
function readKeyFromCredentials(envName) {
  const file = path.join(ROOT, '.credentials.yaml')
  if (!fs.existsSync(file)) return undefined
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const refStart = lines.findIndex((line) => line.trim() === 'refs:')
  if (refStart === -1) return undefined
  for (let i = refStart + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() !== '' && !/^\s/.test(line)) break // 离开 refs 块
    const match = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.+?)\s*$/)
    if (match?.[1] === envName) {
      return match[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return undefined
}

function resolveKey(args) {
  if (args.key) return { key: args.key, source: '--key 参数' }
  if (process.env[KEY_ENV]) return { key: process.env[KEY_ENV], source: `环境变量 ${KEY_ENV}` }
  const fromFile = readKeyFromCredentials(KEY_ENV)
  if (fromFile) return { key: fromFile, source: '.credentials.yaml refs' }
  fail(
    `未找到 ${KEY_ENV}。出路任选其一：\n` +
      `  1) 在 .credentials.yaml 的 refs 下加一行 ${KEY_ENV}: <你的key>（推荐，与 harness 同一来源）\n` +
      `  2) 设置环境变量 ${KEY_ENV} 后重跑\n` +
      `  3) node scripts/zai-usage.mjs --key <你的key>`,
  )
}

function resolveOrigin(args) {
  const raw = args.baseUrl ?? process.env.ZAI_USAGE_BASE_URL ?? DEFAULT_BASE_URL
  try {
    return new URL(raw).origin
  } catch {
    fail(`--base-url / ZAI_USAGE_BASE_URL 不是合法 URL：${raw}`)
  }
}

function maskKey(key) {
  return `***${key.slice(-4)}`
}

const numberFormat = new Intl.NumberFormat('en-US')

function pad(text, width) {
  const visible = [...text].length
  return text + ' '.repeat(Math.max(0, width - visible))
}

function padStart(text, width) {
  const visible = [...text].length
  return ' '.repeat(Math.max(0, width - visible)) + text
}

const pad2 = (n) => String(n).padStart(2, '0')

function formatDateTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

async function fetchUsage(origin, pathname, query, key, label) {
  const url = `${origin}${pathname}${query}`
  let response
  try {
    response = await fetch(url, {
      headers: { Authorization: key, 'Content-Type': 'application/json', 'Accept-Language': 'zh-CN,zh' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const reason = error?.cause?.code ?? error?.name ?? 'unknown'
    fail(
      `请求 ${label} 失败（${reason}）：${url}\n` +
        `出路：检查网络/代理；或用 --base-url 指定可达的智谱域名（默认 ${DEFAULT_BASE_URL}）`,
    )
  }
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    if (!response.ok) return failWithStatus(response.status, text)
    fail(`请求 ${label} 的响应不是 JSON：${text.slice(0, 200)}`)
  }
  // 智谱的鉴权失败裹在 HTTP 200 里：{"code":401,"msg":"...","success":false}
  if (payload && payload.success === false) {
    return failWithStatus(payload.code ?? response.status, payload.msg ?? text, label)
  }
  if (!response.ok) return failWithStatus(response.status, text)
  return payload
}

function failWithStatus(status, detail, label) {
  const hint =
    status === 401 || status === 403
      ? '（key 无效、过期，或该 key 不是 GLM Coding Plan 个人版套餐——团队/企业 key 查不了用量）'
      : status === 429
        ? '（被限流，稍后重试）'
        : ''
  fail(`请求${label ? ` ${label}` : ''} 失败（HTTP ${status}）${hint}\n响应：${String(detail).slice(0, 500)}`)
}

/** data 字段解包；出错时 payload 里通常已带可读 message。 */
function unwrap(payload, label) {
  if (payload?.data) return payload.data
  fail(`请求 ${label} 成功但缺少 data 字段：${JSON.stringify(payload).slice(0, 300)}`)
}

// 窗口单位的解码经 nextResetTime 逐条实测核对：3=小时、5=月、6=周；
// 出现未知 unit 时回退为原始值展示，不猜。官方 glm-plan-usage 插件丢弃了
// unit/number，把周额度也标成 "Token usage(5 Hour)"，属其展示缺陷。
const LIMIT_UNIT_NAMES = { 3: '小时', 5: '月', 6: '周' }

function windowLabel(item) {
  const name = LIMIT_UNIT_NAMES[item.unit]
  if (!name) return `unit=${item.unit}×${item.number}`
  return item.number === 1 ? name : `${item.number} ${name}`
}

function formatReset(ms) {
  if (typeof ms !== 'number' || ms < 1e12) return ''
  const d = new Date(ms)
  return `，${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())} 重置`
}

function renderQuota(quota) {
  console.log('== 套餐额度 ==')
  for (const item of quota.limits ?? []) {
    if (item.type === 'TOKENS_LIMIT') {
      console.log(`  ${windowLabel(item)}窗口 Token 限额：已用 ${item.percentage}%${formatReset(item.nextResetTime)}`)
    } else if (item.type === 'TIME_LIMIT') {
      console.log(`  月度 MCP 用量：${numberFormat.format(item.currentValue ?? 0)}/${numberFormat.format(item.usage ?? 0)}（${item.percentage}%）${formatReset(item.nextResetTime)}`)
      for (const detail of item.usageDetails ?? []) {
        console.log(`    - ${detail.modelCode}: ${numberFormat.format(detail.usage ?? 0)}`)
      }
    } else {
      console.log(`  ${item.type}：${JSON.stringify(item)}`)
    }
  }
  if (quota.level) console.log(`  套餐档位：${quota.level}`)
  console.log()
}

function renderModelUsage(model, { hourly }) {
  const total = model.totalUsage ?? {}
  console.log(`== 模型用量（近 ${model.x_time?.length ?? '?'} 个小时桶）==`)
  console.log(
    `  合计：${numberFormat.format(total.totalModelCallCount ?? 0)} 次调用 / ${numberFormat.format(total.totalTokensUsage ?? 0)} tokens`,
  )
  const summary = total.modelSummaryList ?? model.modelSummaryList ?? []
  const nameWidth = Math.max('模型'.length, ...summary.map((m) => [...m.modelName].length))
  console.log(`  ${pad('模型', nameWidth)}  ${padStart('tokens', 15)}`)
  for (const item of summary) {
    console.log(`  ${pad(item.modelName, nameWidth)}  ${padStart(numberFormat.format(item.totalTokens ?? 0), 15)}`)
  }
  if (hourly) renderHourly(model.x_time ?? [], [{ name: '调用次数', values: model.modelCallCount ?? [] }, { name: 'tokens', values: model.tokensUsage ?? [] }])
  console.log()
}

function renderToolUsage(tool, { hourly }) {
  const total = tool.totalUsage ?? {}
  console.log('== 工具用量 ==')
  console.log(
    `  合计：联网搜索 ${numberFormat.format(total.totalNetworkSearchCount ?? 0)} 次 / ` +
      `web-reader ${numberFormat.format(total.totalWebReadMcpCount ?? 0)} 次 / ` +
      `zread ${numberFormat.format(total.totalZreadMcpCount ?? 0)} 次`,
  )
  if (hourly) renderHourly(tool.x_time ?? [], [{ name: '联网搜索', values: tool.networkSearchCount ?? [] }, { name: 'web-reader', values: tool.webReadMcpCount ?? [] }, { name: 'zread', values: tool.zreadMcpCount ?? [] }])
  console.log()
}

function renderHourly(times, seriesList) {
  const series = seriesList.filter((s) => s.values.some((v) => v !== 0))
  if (series.length === 0) {
    console.log('  （窗口内所有小时均为 0，略去小时明细）')
    return
  }
  const timeWidth = Math.max(...times.map((t) => [...t].length))
  const header = `${pad('时间(整点)', timeWidth)}  ${series.map((s) => padStart(s.name, 12)).join('  ')}`
  console.log(`  ${header}`)
  for (let i = 0; i < times.length; i++) {
    console.log(`  ${pad(times[i], timeWidth)}  ${series.map((s) => padStart(numberFormat.format(s.values[i] ?? 0), 12)).join('  ')}`)
  }
}

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))

const { key, source } = resolveKey(args)
const origin = resolveOrigin(args)

const endTime = new Date()
const startTime = new Date(endTime.getTime() - args.hours * 60 * 60 * 1000)
const windowQuery = `?startTime=${encodeURIComponent(formatDateTime(startTime))}&endTime=${encodeURIComponent(formatDateTime(endTime))}`

const [quotaPayload, modelPayload, toolPayload] = await Promise.all([
  fetchUsage(origin, '/api/monitor/usage/quota/limit', '', key, '套餐额度(quota/limit)'),
  fetchUsage(origin, '/api/monitor/usage/model-usage', windowQuery, key, '模型用量(model-usage)'),
  fetchUsage(origin, '/api/monitor/usage/tool-usage', windowQuery, key, '工具用量(tool-usage)'),
])

if (args.json) {
  console.log(JSON.stringify({ quota: quotaPayload, model: modelPayload, tool: toolPayload }, null, 2))
  process.exit(0)
}

console.log(`智谱 GLM Coding Plan 用量（key 来源：${source}，尾号 ${maskKey(key)}，站点 ${origin}）`)
console.log(`用量统计窗口：${formatDateTime(startTime)} ~ ${formatDateTime(endTime)}`)
console.log()
renderQuota(unwrap(quotaPayload, 'quota/limit'))
renderModelUsage(unwrap(modelPayload, 'model-usage'), { hourly: args.hourly })
renderToolUsage(unwrap(toolPayload, 'tool-usage'), { hourly: args.hourly })
