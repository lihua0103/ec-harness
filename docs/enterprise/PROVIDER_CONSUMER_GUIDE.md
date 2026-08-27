# DSH 企业插件 Provider/Consumer/Service 设计指南

## 概述

DSH (DeepSeek Harness) 基于 Cordis 插件系统，提供可组合的能力缝（Capability Seam）设计模式。本指南以现有企业插件为例，展示 Provider/Consumer/Service 三角关系的正确实现方式。

## 核心概念

### 能力缝三角

`
Service Definition（接口定义）
       ↓
Provider（能力提供者）
       ↓
Consumer（能力消费者）
`

- **Service Definition**：定义能力接口和类型
- **Provider**：实现能力，注册到 Context
- **Consumer**：声明依赖，使用能力

---

## 模式 1：Consumer 型插件（无 Service）

**适用场景**：插件消费官方或其他插件的服务，自身不提供可复用服务。

### 示例：@dsh-enterprise/branding

#### 1. 声明依赖

```typescript
// packages/enterprise/branding/src/index.ts
export const name = 'enterprise-branding'
export const inject = ['webServer']  // 声明依赖 webServer 服务
```

#### 2. 消费服务

```typescript
export function apply(ctx: Context, config: BrandingConfig = {}): void {
  ctx.effect(() => registerBranding(ctx, config))
}

// packages/enterprise/branding/src/branding.ts
export function registerBranding(ctx: Context, config: BrandingConfig): () => void {
  // 获取依赖的服务
  const webServer = ctx.get('webServer')
  
  if (!webServer) {
    throw new Error('[branding] webServer 服务不存在')
  }
  
  // 使用服务能力（tapIndex）
  return webServer.tapIndex((html: string) => {
    // 品牌转换逻辑
    return transformHtml(html, config)
  })
}
```

#### 3. 关键点

- ✅ **使用 inject 声明依赖**：Cordis 会确保 webServer 先加载
- ✅ **fail-fast 验证**：服务不存在时立即抛错（boot 期可见）
- ✅ **返回 disposer**：通过 ctx.effect() 确保可逆注册
- ✅ **结构类型访问**：不导入 webServer 包，用局部类型声明

---

## 模式 2：Tool Consumer 型插件

**适用场景**：注册模型可见工具，消费 tools/systemPrompt 服务。

### 示例：@dsh-enterprise/listing

#### 1. 工具注册

```typescript
// packages/enterprise/listing/src/index.ts
export const name = 'enterprise-listing'

interface CommandContext {
  command: (definition: unknown, handler: (args: unknown) => Promise<unknown>) => () => void
  logger?: { info: (message: string) => void }
}

export function apply(ctx: Context): void {
  const worker = new PythonWorker()
  const disposers: Array<() => void> = []
  const cmdCtx = ctx as unknown as CommandContext
  
  // 注册工具
  disposers.push(
    cmdCtx.command(
      {
        name: 'enterprise_listing_inspect',
        description: '识别项目 doc/ 下 spec/ALS...',
        parameters: { /* JSON Schema */ }
      },
      async (args: unknown) => {
        const { project, scenario } = args as { project: string; scenario?: string }
        const result = await worker.request({ operation: 'listing_inspect', project, scenario })
        return result.inspection
      }
    )
  )
  
  // 清理逻辑
  ctx.effect(() => () => {
    for (let i = disposers.length - 1; i >= 0; i--) disposers[i]()
    worker.dispose()
  })
}
```

#### 2. 关键点

- ✅ **标准工具注册**：使用 ctx.command()，返回值自动包装为 	ool/result 事件
- ✅ **类型安全**：定义 CommandContext 接口，避免 ny
- ✅ **资源管理**：在 ctx.effect() 中集中清理
- ✅ **Session Log 自动记录**：无需手动写 SessionEvent

---

## 模式 3：Service Provider 型插件

**适用场景**：提供可复用服务给其他插件使用。

### 示例：@dsh-enterprise/ui-settings

#### 1. Service Definition

```typescript
// packages/enterprise/ui-settings/src/data-security-service.ts
export interface DataSecurityConfig {
  enabled?: boolean
  protectedPatterns?: string[]
}

export class DataSecurityService {
  static inject = ['webServer']  // 声明依赖
  
  private enabled = true
  private patterns: string[] = [
    '**/*.sas7bdat',
    '**/*.xpt',
    '**/data/**/*.xlsx'
  ]
  
  constructor(private ctx: Context, config: DataSecurityConfig = {}) {
    if (config.enabled !== undefined) this.enabled = config.enabled
    if (config.protectedPatterns) this.patterns = config.protectedPatterns
  }
  
  // Provider 接口
  isEnabled(): boolean {
    return this.enabled
  }
  
  async setEnabled(value: boolean): Promise<void> {
    this.enabled = value
    this.ctx.emit('data-security/changed', value)
  }
  
  getProtectedPatterns(): string[] {
    return [...this.patterns]
  }
}
```

#### 2. Provider 注册

```typescript
// packages/enterprise/ui-settings/src/index.ts
export const name = 'enterprise-ui-settings'
export const inject = ['webServer']

export function apply(ctx: Context): void {
  // 注册为插件
  ctx.plugin(DataSecurityService)
  
  ctx.effect(() => {
    // 未来其他设置扩展
    return () => undefined
  })
}
```

#### 3. Consumer 使用（假设其他插件）

```typescript
// 其他插件可以这样使用
export const inject = ['dataSecurityService']

export function apply(ctx: Context): void {
  const security = ctx.dataSecurityService
  
  if (security.isEnabled()) {
    // 应用数据保护策略
  }
}
```

#### 4. 关键点

- ✅ **Service 类声明依赖**：static inject
- ✅ **事件通知**：状态变化时 emit 事件
- ✅ **类型导出**：xport type { DataSecurityService }
- ✅ **防御性复制**：getProtectedPatterns() 返回副本

---

## 设计原则

### 1. KISS（Keep It Simple, Stupid）

❌ **错误**：为了"未来扩展"创建复杂抽象
```typescript
// 过度设计
interface BrandingStrategy {
  transform(html: string): string
}
class DefaultBrandingStrategy implements BrandingStrategy { /* ... */ }
class AdvancedBrandingStrategy implements BrandingStrategy { /* ... */ }
```

✅ **正确**：只实现当前需要的功能
```typescript
// 简单直接
function registerBranding(ctx: Context, config: BrandingConfig) {
  return ctx.webServer.tapIndex((html) => transformHtml(html, config))
}
```

### 2. 声明式依赖

❌ **错误**：运行时动态查找
```typescript
// 不推荐
export function apply(ctx: Context) {
  const webServer = ctx.root.scope.services.find(s => s.name === 'webServer')
}
```

✅ **正确**：声明式 inject
```typescript
// 推荐
export const inject = ['webServer']
export function apply(ctx: Context) {
  const webServer = ctx.get('webServer')
}
```

### 3. 可逆注册

❌ **错误**：无法清理的副作用
```typescript
// 不可逆
export function apply(ctx: Context) {
  ctx.webServer.on('request', handler)
  // 没有返回 disposer
}
```

✅ **正确**：通过 ctx.effect 确保可逆
```typescript
// 可逆
export function apply(ctx: Context) {
  ctx.effect(() => {
    const disposer = ctx.webServer.on('request', handler)
    return () => disposer()
  })
}
```

### 4. 结构类型 vs 导入依赖

**何时使用结构类型**（推荐）：
- 插件只消费服务接口
- 避免循环依赖
- 减少编译依赖

```typescript
// 结构类型镜像
interface WebServerLike {
  tapIndex(transform: (html: string) => string): () => void
}

export function apply(ctx: Context) {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
}
```

**何时导入依赖**：
- 需要具体类型（如 enum、union type）
- 需要运行时工具函数
- 官方包已明确导出

---

## 常见模式对比

| 模式 | inject | Service 类 | 适用场景 |
|------|--------|-----------|---------|
| **Pure Consumer** | ✅ 需要 | ❌ 不需要 | branding（消费 webServer） |
| **Tool Consumer** | ❌ 可选 | ❌ 不需要 | listing（注册工具） |
| **Service Provider** | ✅ 需要 | ✅ 需要 | ui-settings（提供服务） |
| **Hybrid** | ✅ 需要 | ✅ 需要 | 复杂插件（既消费又提供） |

---

## 测试模式

### Consumer 插件测试

```typescript
// packages/enterprise/branding/src/branding.test.ts
describe('registerBranding', () => {
  it('应该注册品牌配置并返回清理函数', () => {
    const mockCtx = {
      get: (key: string) => {
        if (key === 'webServer') {
          return {
            tapIndex: () => () => {}  // mock 方法
          }
        }
        return undefined
      },
    } as unknown as Context

    const dispose = registerBranding(mockCtx, { brandName: 'Test' })
    expect(typeof dispose).toBe('function')
  })
})
```

### Service Provider 测试

```typescript
// packages/enterprise/ui-settings/tests/data-security-service.test.ts
describe('DataSecurityService', () => {
  it('should export DataSecurityService class', () => {
    expect(DataSecurityService).toBeTypeOf('function')
  })

  it('should have correct inject dependencies', () => {
    expect(DataSecurityService.inject).toEqual(['webServer'])
  })
})
```

---

## 架构检查清单

创建新插件时，确认以下检查项：

### 包结构
- [ ] package.json 声明 private: true
- [ ] package.json 声明 	ype: "module"
- [ ] package.json 声明 dsh.bundle.patch
- [ ] cordis.patch.yml 存在且包含 id + 
ame
- [ ] src/index.ts 默认导出插件函数
- [ ] xports 包含 ./cordis.patch.yml

### 依赖声明
- [ ] 使用 xport const inject = [...] 声明依赖
- [ ] Service 类使用 static inject = [...]
- [ ] 运行时验证服务存在（fail-fast）

### 生命周期
- [ ] 所有注册通过 ctx.effect() 包装
- [ ] 返回 disposer 函数清理资源
- [ ] HMR 支持（可选）：ctx.acceptHmr

### 命名规范
- [ ] 包名：@dsh-enterprise/*
- [ ] Row ID：nterprise-*
- [ ] Service 名：小驼峰（dataSecurityService）

---

## 参考资源

### 官方文档
- [Cordis 插件系统](../../upstream/deepseek-harness/docs/cordis-primer.md)
- [能力缝设计](../../upstream/deepseek-harness/docs/capability-seams.md)
- [架构文档](../../upstream/deepseek-harness/docs/architecture.md)

### 企业实现示例
- [ADR-0002: 企业品牌插件](./adr/0002-enterprise-branding-plugin.md)
- [ADR-0003: 临床 Listing 插件](./adr/0003-enterprise-listing-plugin.md)
- [架构审计](./ARCHITECTURE_AUDIT.md)

### 代码示例
- Consumer: packages/enterprise/branding/
- Tool Consumer: packages/enterprise/listing/
- Service Provider: packages/enterprise/ui-settings/

---

## 总结

**三个关键原则**：

1. **声明式依赖**：用 inject 声明，用 ctx.get() 获取
2. **可逆注册**：所有副作用通过 ctx.effect() 包装
3. **KISS 优先**：只实现当前需要的，避免过度设计

**何时创建 Service**：

- ✅ 多个插件需要相同能力
- ✅ 状态需要共享和通知
- ✅ 接口需要版本化管理

**何时避免 Service**：

- ❌ 只有一个消费者
- ❌ 逻辑足够简单（直接实现即可）
- ❌ 官方已提供等效能力

遵循这些模式，可以创建可维护、可测试、可组合的 DSH 企业插件。
