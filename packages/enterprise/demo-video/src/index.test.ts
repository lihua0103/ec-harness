import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from './index.js'

// 项目路径经 host 侧校验（存在目录的绝对路径），测试使用真实临时目录。
const WORK = mkdtempSync(join(tmpdir(), 'dsh-demo-video-test-'))

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output?: { schema: Record<string, unknown> }
  execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>
}

function makeContext() {
  const tools = new Map<string, ToolDefinition>()
  const promptSections: Array<{ name: string; order: number; text: string }> = []
  const registerDisposes: Array<() => void> = []
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        tools.set(definition.name, definition)
        const dispose = () => tools.delete(definition.name)
        registerDisposes.push(dispose)
        return dispose
      },
    },
    systemPrompt: { section(section: { name: string; order: number; text: string }) { promptSections.push(section); return () => undefined } },
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as Context
  return { ctx, tools, promptSections, registerDisposes }
}

describe('enterprise-demo-video plugin', () => {
  let tools: Map<string, ToolDefinition>
  let promptSections: Array<{ name: string; order: number; text: string }>

  beforeEach(() => {
    const made = makeContext()
    tools = made.tools
    promptSections = made.promptSections
    apply(made.ctx)
  })

  it('声明 inject 与七个模型工具（preflight/survey/record/anchors/narrate/compose/kb）', () => {
    expect(name).toBe('enterprise-demo-video')
    expect(inject).toEqual(['tools', 'systemPrompt', 'credentials'])
    expect([...tools.keys()]).toEqual([
      'enterprise_demo_preflight',
      'enterprise_demo_survey',
      'enterprise_demo_record',
      'enterprise_demo_anchors',
      'enterprise_demo_narrate',
      'enterprise_demo_compose',
      'enterprise_demo_kb',
    ])
    for (const tool of tools.values()) expect(tool.output?.schema).toMatchObject({ type: 'object' })
  })

  it('systemPrompt 注入工具契约（order 126，红线与 S0+四阶段门禁）', () => {
    expect(promptSections).toHaveLength(1)
    const section = promptSections[0]
    expect(section?.name).toBe('tool:enterprise-demo')
    expect(section?.order).toBe(126)
    const text = section?.text ?? ''
    expect(text).toContain('enterprise_demo_survey')
    expect(text).toContain('enterprise_demo_record')
    expect(text).toContain('enterprise_demo_anchors')
    expect(text).toContain('enterprise_demo_narrate')
    expect(text).toContain('enterprise_demo_compose')
    expect(text).toContain('只点按钮不动数据')
    expect(text).toContain('只高亮不点击')
    expect(text).toContain('credentialRef')
    expect(text).toContain('enterprise_demo_kb')
    expect(text).toContain('黑条锚点是唯一基准')
    expect(text).toContain('brightness.ok')
    expect(text).toContain('字幕实证')
  })

  it('工具参数不暴露部署配置开关（ffmpeg/python 路径不经参数下发）', () => {
    for (const tool of tools.values()) {
      const properties = (tool.parameters as { properties: Record<string, unknown> }).properties
      expect(properties.ffmpegPath).toBeUndefined()
      expect(properties.pythonExe).toBeUndefined()
      expect(properties.dataInterception).toBeUndefined()
    }
  })

  it('record 缺 walk 脚本时给出出路（fail-fast，不 spawn）', async () => {
    const tool = tools.get('enterprise_demo_record')
    await expect(tool?.execute(
      { workDir: WORK, base: 'http://localhost:4173' },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'DEMO_WALK_MISSING' })
  })

  it('workDir 必须是绝对路径', async () => {
    const tool = tools.get('enterprise_demo_record')
    await expect(tool?.execute(
      { workDir: 'relative/dir', base: 'http://localhost:4173' },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'DEMO_WORKDIR_INVALID' })
    await expect(tools.get('enterprise_demo_anchors')?.execute(
      { workDir: 123 },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'DEMO_WORKDIR_INVALID' })
  })

  it('credentialRef 必须是宿主凭据引用名，密码不进参数（record 与 survey 同口径）', async () => {
    const record = tools.get('enterprise_demo_record')
    await expect(record?.execute(
      { workDir: WORK, base: 'http://x', credentialRef: 'not a ref' },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'DEMO_CREDENTIAL_REF_INVALID' })
    const survey = tools.get('enterprise_demo_survey')
    await expect(survey?.execute(
      { workDir: WORK, base: 'http://x', credentialRef: 'not a ref' },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'DEMO_CREDENTIAL_REF_INVALID' })
  })

  it('anchors 在缺 S1 产物时给阶段顺序出路', async () => {
    const tool = tools.get('enterprise_demo_anchors')
    await expect(tool?.execute(
      { workDir: WORK },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'DEMO_STAGE_ORDER' })
  })

  it('kb 工具读取随包知识库三主题并拒绝未知主题', async () => {
    const tool = tools.get('enterprise_demo_kb')
    const overview = await tool?.execute({}, { signal: new AbortController().signal }) as { topic: string; content: string }
    expect(overview.topic).toBe('overview')
    expect(overview.content).toContain('阶段接口（S0 + 四阶段）')
    expect(overview.content).toContain('数据安全红线')
    expect(overview.content).toContain('S0')
    const pitfalls = await tool?.execute({ topic: 'pitfalls' }, { signal: new AbortController().signal }) as { content: string }
    expect(pitfalls.content).toContain('时钟漂移')
    expect(pitfalls.content).toContain('signalstats')
    expect(pitfalls.content).toContain('遮罩')
    const guide = await tool?.execute({ topic: 'walk-guide' }, { signal: new AbortController().signal }) as { content: string }
    expect(guide.content).toContain('模块适配区')
    await expect(tool?.execute({ topic: 'nope' }, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'DEMO_KB_TOPIC_INVALID' })
  })

  it('插件的注册可卸载（dispose 全量移除注册项）', () => {
    const made = makeContext()
    apply(made.ctx)
    expect(made.tools.size).toBe(7)
    for (const dispose of made.registerDisposes) dispose()
    expect(made.tools.size).toBe(0)
  })
})
