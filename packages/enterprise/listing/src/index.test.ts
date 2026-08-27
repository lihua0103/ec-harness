import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from './index.js'

// Mock PythonWorker
vi.mock('./worker.js', () => ({
  PythonWorker: class MockPythonWorker {
    private disposed = false
    
    async request(req: unknown): Promise<unknown> {
      if (this.disposed) throw new Error('Worker已释放')
      
      const request = req as { operation: string; project?: string; scenario?: string; code?: string }
      
      if (request.operation === 'listing_inspect') {
        return {
          ok: true,
          action: 'inspect',
          inspection: {
            project: request.project,
            scenario: request.scenario,
            datasets: [
              { name: 'adsl', path: 'doc/spec/adsl.sas', rows: 100 }
            ]
          }
        }
      }
      
      if (request.operation === 'listing_run_code') {
        return {
          ok: true,
          action: 'run_code',
          receipt: {
            stdout: 'Code executed successfully',
            result: { shape: [10, 5] }
          }
        }
      }
      
      if (request.operation === 'listing_publish') {
        return {
          ok: true,
          action: 'publish',
          receipt: {
            path: '/output/listing.xlsx',
            written: true
          }
        }
      }
      
      return { ok: false, reason: 'Unknown operation' }
    }
    
    dispose(): void {
      this.disposed = true
    }
  }
}))

interface CommandDefinition {
  name: string
  description: string
  parameters: unknown
}

type CommandHandler = (args: unknown) => Promise<unknown>

describe('enterprise-listing plugin', () => {
  let mockCtx: Context
  let registeredCommands: Map<string, CommandHandler>
  
  beforeEach(() => {
    registeredCommands = new Map()
    
    mockCtx = {
      command: (def: CommandDefinition, handler: CommandHandler) => {
        registeredCommands.set(def.name, handler)
        return () => {
          registeredCommands.delete(def.name)
        }
      },
      effect: (fn: () => (() => void) | void) => {
        const disposer = fn()
        return disposer || (() => {})
      },
      logger: {
        info: vi.fn()
      }
    } as unknown as Context
  })
  
  afterEach(() => {
    registeredCommands.clear()
  })
  
  describe('插件注册', () => {
    it('应该注册三个工具', () => {
      apply(mockCtx)
      
      expect(registeredCommands.has('enterprise_listing_inspect')).toBe(true)
      expect(registeredCommands.has('enterprise_listing_run_code')).toBe(true)
      expect(registeredCommands.has('enterprise_listing_publish')).toBe(true)
    })
  })
  
  describe('enterprise_listing_inspect', () => {
    it('应该返回数据集检查结果', async () => {
      apply(mockCtx)
      
      const handler = registeredCommands.get('enterprise_listing_inspect')
      expect(handler).toBeDefined()
      
      if (!handler) throw new Error('Handler not found')
      
      const result = await handler({
        project: '/path/to/project',
        scenario: 'adsl'
      })
      
      expect(result).toEqual({
        project: '/path/to/project',
        scenario: 'adsl',
        datasets: [
          { name: 'adsl', path: 'doc/spec/adsl.sas', rows: 100 }
        ]
      })
    })
    
    it('应该处理缺少 scenario 的情况', async () => {
      apply(mockCtx)
      
      const handler = registeredCommands.get('enterprise_listing_inspect')
      if (!handler) throw new Error('Handler not found')
      
      const result = await handler({
        project: '/path/to/project'
      })
      
      expect(result).toHaveProperty('project', '/path/to/project')
      expect(result).toHaveProperty('scenario', undefined)
    })
  })
  
  describe('enterprise_listing_run_code', () => {
    it('应该执行 Python 代码并返回结果', async () => {
      apply(mockCtx)
      
      const handler = registeredCommands.get('enterprise_listing_run_code')
      expect(handler).toBeDefined()
      
      if (!handler) throw new Error('Handler not found')
      
      const result = await handler({
        project: '/path/to/project',
        code: 'print(df.shape)'
      })
      
      expect(result).toEqual({
        stdout: 'Code executed successfully',
        result: { shape: [10, 5] }
      })
    })
  })
  
  describe('enterprise_listing_publish', () => {
    it('应该发布 Excel 文件', async () => {
      apply(mockCtx)
      
      const handler = registeredCommands.get('enterprise_listing_publish')
      expect(handler).toBeDefined()
      
      if (!handler) throw new Error('Handler not found')
      
      const result = await handler({
        project: '/path/to/project'
      })
      
      expect(result).toEqual({
        path: '/output/listing.xlsx',
        written: true
      })
    })
  })
})
