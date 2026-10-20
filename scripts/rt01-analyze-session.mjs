// 分析已导出的会话 jsonl：统计工具调用、拦截、错误，并定位被拦工具。
// 用法：node scripts/rt01-analyze-session.mjs <session.jsonl>
// 只输出结构信息（工具名/错误码/计数），不打印工具返回正文。
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) { console.error('usage: node rt01-analyze-session.mjs <session.jsonl>'); process.exit(1) }
const events = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  .map(line => { try { return JSON.parse(line) } catch { return undefined } })
  .filter(Boolean)

/** 工具结果正文位于 data.message.content[].content[].text */
function resultText(event) {
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const block of content) {
    if (Array.isArray(block.content)) {
      for (const item of block.content) if (typeof item.text === 'string') out.push(item.text)
    }
  }
  return out.join('\n')
}

const callsBySeq = new Map()
const calls = []
for (const event of events) {
  if (event.type !== 'tool/call') continue
  // 实测事件形态：data.name / data.arguments / data.callId（不是 message 块）。
  const name = event.data?.name
  if (typeof name !== 'string') continue
  const entry = { name, args: String(event.data?.arguments ?? ''), callId: event.data?.callId }
  calls.push(entry)
  if (entry.callId) callsBySeq.set(entry.callId, entry)
}

const blocks = []
const errors = []
for (const event of events) {
  if (event.type !== 'tool/result') continue
  const messageBlocks = event.data?.message?.content
  if (!Array.isArray(messageBlocks)) continue
  for (const block of messageBlocks) {
    const call = callsBySeq.get(block.toolCallId)
    const text = resultText({ data: { message: { content: [block] } } })
    const codes = text.match(/errorCode=[A-Z_]+/g)
    if (codes || /受保护临床数据值/.test(text)) {
      blocks.push({
        tool: call?.name ?? '?',
        code: codes?.[0] ?? 'PROTECTED_CONTENT_WITHHELD',
        argPreview: (call?.args ?? '').slice(0, 90),
        isError: block.isError === true,
      })
    } else if (block.isError === true) {
      errors.push({ tool: call?.name ?? '?', preview: text.slice(0, 120) })
    }
  }
}

const tally = {}
for (const item of blocks) tally[item.code] = (tally[item.code] ?? 0) + 1
const toolTally = {}
for (const call of calls) toolTally[call.name] = (toolTally[call.name] ?? 0) + 1

console.log('tool calls by name:', JSON.stringify(toolTally, null, 2))
console.log('total tool results:', events.filter(event => event.type === 'tool/result').length)
console.log('guard blocks:', blocks.length, JSON.stringify(tally))
if (blocks.length > 0) console.log('blocked calls:', JSON.stringify(blocks, null, 2))
console.log('other tool errors:', errors.length)
if (errors.length > 0) console.log(JSON.stringify(errors, null, 2))
const lastAssistant = events.filter(event => event.type === 'assistant/message').at(-1)
if (lastAssistant) {
  const text = (lastAssistant.data?.message?.content ?? [])
    .filter(block => typeof block.text === 'string').map(block => block.text).join('\n')
  console.log('--- last assistant message (first 1200 chars) ---')
  console.log(text.slice(0, 1200))
}
