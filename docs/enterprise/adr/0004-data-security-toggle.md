<!--
> **取代横幅(2026-08-28)**:本文描述的 protectedPatterns glob、data-security/check-file 事件、
> minimatch 依赖与 @dsh-enterprise/auth bundle 均已不存在。现行口径见 ADR-0006(开关本体)、
> ADR-0007(单规则红线 + 通用车道护栏)与 ADR-0009(出域单点)。
> 本文仅作历史存档,勿按此实施。另注:编号 0004 与 0004-listing-session-log.md
> 冲突(历史产物,整档归档方案见 DEFECT_FIX_PLAN_20260828.md D-9)。
-->
# ADR 0004: 数据安全开关功能

## 状态

已实施

## 背景

DSH Enterprise 需要在 Agent 预设页面增加数据安全开关功能，用于控制敏感数据是否允许发送给 AI 模型。具体需求：

1. **拦截范围**：
   - SAS 数据集文件（`.sas7bdat`、`.xpt`）
   - `data/`、`spec/` 目录下的 Excel 文件（`.xlsx`、`.xls`）

2. **行为规则**：
   - 开关**启用**（默认）：执行拦截逻辑，阻止敏感文件发送给 AI
   - 开关**关闭**：不执行任何拦截，所有操作正常放行

3. **默认状态**：启用（安全优先）

## 决策

采用**事件驱动的拦截器模式**，基于 Cordis 插件架构实现：

### 架构分层

```
┌─────────────────────────────────────────────────────────┐
│  WebUI（Agent 预设页面）                                 │
│  └─ 数据安全 Toggle 开关                                 │
│     └─ RPC: /api/settings/data-security                 │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────────────┐
│  @dsh-enterprise/ui-settings                             │
│  ├─ DataSecurityService（状态 + 持久化）                 │
│  │   • isEnabled(): boolean                             │
│  │   • getProtectedPatterns(): string[]                 │
│  │   • setEnabled(enabled): Promise<void>               │
│  └─ HTTP API: GET/POST /api/settings/data-security      │
└────────────────────┬────────────────────────────────────┘
                     │ inject: ['dataSecurityService']
┌────────────────────┴────────────────────────────────────┐
│  @dsh-enterprise/tool-audit                              │
│  └─ data-interceptor                                     │
│     ├─ 监听: data-security/check-file 事件               │
│     └─ 决策逻辑：                                         │
│        • 开关关闭 → 直接放行                              │
│        • 开关启用 → 检查文件路径匹配 → 允许/阻止         │
└─────────────────────────────────────────────────────────┘
```

### 核心组件

#### 1. DataSecurityService

**位置**：`packages/enterprise/ui-settings/src/data-security-service.ts`

**职责**：
- 管理数据安全开关状态
- 持久化配置到 `$DSH_HOME/profiles/enterprise/.data-security.json`
- 提供 HTTP API 供前端调用
- 发出 `data-security/changed` 事件通知状态变化

**配置结构**：
```typescript
interface DataSecurityConfig {
  enabled: boolean  // 默认 true
  protectedPatterns: string[]  // glob patterns
}
```

**默认受保护模式**：
- `**/*.sas7bdat`
- `**/*.xpt`
- `**/data/**/*.xlsx`
- `**/data/**/*.xls`
- `**/spec/**/*.xlsx`
- `**/spec/**/*.xls`

#### 2. Data Interceptor

**位置**：`packages/enterprise/tool-audit/src/data-interceptor.ts`

**职责**：
- 注册 `data-security/check-file` 事件处理器
- 使用 minimatch 进行路径模式匹配
- 返回 `{ allowed: boolean, reason?: string }`

**拦截逻辑**：
```typescript
if (!dataSecurityService.isEnabled()) {
  return { allowed: true }  // 开关关闭，直接放行
}

for (const pattern of protectedPatterns) {
  if (minimatch(filePath, pattern, { nocase: true })) {
    return { 
      allowed: false, 
      reason: '数据安全策略已阻止...' 
    }
  }
}

return { allowed: true }  // 未匹配到敏感模式，放行
```

### 集成点

其他插件（如 `@dsh-enterprise/listing`）通过事件检查文件访问权限：

```typescript
// 在工具执行前检查
const result = ctx.emit('data-security/check-file', filePath)
if (!result.allowed) {
  throw new Error(result.reason)
}
```

### Bundle 顺序

`profiles/enterprise/package.json`：
```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@dsh-enterprise/auth",
        "@dsh-enterprise/ui-settings",    // 先加载，提供 Service
        "@dsh-enterprise/tool-audit",     // 后加载，消费 Service
        "@dsh-enterprise/branding",
        "@dsh-enterprise/listing"
      ]
    }
  }
}
```

## 不采用的方案

### 方案 A：全局中间件拦截

在 DSH 核心层注入拦截逻辑。

**拒绝理由**：违反"企业插件不修改官方代码"原则。

### 方案 B：文件系统层拦截

在 `ctx.fs` Provider 层面阻止文件读取。

**拒绝理由**：过于底层，会影响非 AI 场景的合法文件访问（如本地编辑器、构建工具）。

### 方案 C：LLM 输出内容过滤

在 `llm/stream` 事件中检测和脱敏敏感数据。

**拒绝理由**：事后补救，数据已经进入模型上下文；且内容检测易误报/漏报。

## 安全性

### 数据不出域保证

1. **默认启用**：安全优先，用户必须主动关闭才会放行
2. **fail-closed**：如果配置加载失败，使用默认配置（启用状态）
3. **拦截前置**：在工具执行前就阻断，数据不进入 AI 上下文
4. **模式匹配**：基于文件路径而非内容，零误报
5. **审计日志**：所有拦截动作记录到 `ctx.logger`

### 配置持久化

配置文件：`$DSH_HOME/profiles/enterprise/.data-security.json`

```json
{
  "enabled": true,
  "protectedPatterns": [
    "**/*.sas7bdat",
    "**/*.xpt",
    "**/data/**/*.xlsx",
    "**/data/**/*.xls",
    "**/spec/**/*.xlsx",
    "**/spec/**/*.xls"
  ]
}
```

### 模型可见性

- **不可见**：数据安全开关状态对模型不可见
- **Session Event**：不需要持久化到会话事件（仅运行时状态）

## 升级影响

### 官方依赖

- `@deepseek-ai/cordis`：使用标准 Service、Event API，无破坏性变更风险
- `minimatch`：第三方库，语义化版本管理

### 向后兼容

- 新增功能，不影响现有工作流
- 默认启用，保持现有安全等级
- 关闭开关后行为与升级前一致

### 迁移路径

首次部署：
1. 构建企业插件：`pnpm -r run build`
2. 无需配置，使用默认启用状态
3. 前端 UI 自动显示开关

## 测试验证

### 单元测试

`packages/enterprise/ui-settings/tests/data-security-service.test.ts`：
- 默认启用状态
- 切换开关功能
- 配置持久化

### 集成测试

场景 1：开关启用，访问敏感文件
```bash
# 预期：阻止访问
emit('data-security/check-file', '/project/data/patients.xlsx')
# => { allowed: false, reason: '数据安全策略已阻止...' }
```

场景 2：开关关闭，访问敏感文件
```bash
# 预期：放行
setEnabled(false)
emit('data-security/check-file', '/project/data/patients.xlsx')
# => { allowed: true }
```

场景 3：开关启用，访问普通文件
```bash
# 预期：放行
emit('data-security/check-file', '/project/src/main.ts')
# => { allowed: true }
```

## 实施清单

- [x] 创建 `DataSecurityService`
- [x] 实现 HTTP API `/api/settings/data-security`
- [x] 创建 `data-interceptor`
- [x] 添加类型声明
- [x] 配置依赖关系
- [x] 构建验证
- [ ] 编写单元测试
- [ ] 前端 UI 集成
- [ ] 端到端测试
- [ ] 文档更新

## 参考

- [PLUGIN_ARCHITECTURE.md](./PLUGIN_ARCHITECTURE.md)
- [CODING_STANDARDS.md](./CODING_STANDARDS.md)
- [Cordis 文档](../../upstream/deepseek-harness/docs/api/core.md)
