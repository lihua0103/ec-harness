<!--
> **过时归档横幅(2026-08-28)**:本文为历史交付/状态文档,所述实现与口径
> 已被后续演进取代——数据安全现行口径见 ADR-0007(单规则红线)与
> ADR-0009(出域单点);工具契约见 listing 插件系统提示与仓库 README。
> 仅作过程记录保留,请勿按本文操作。
-->
# 数据安全开关 - 快速参考

## 概述

数据安全开关用于控制 SAS 数据集和敏感 Excel 文件是否允许发送给 AI 模型。

## 架构

```
ui-settings (状态管理)
    ↓ inject
tool-audit (拦截执行)
    ↓ emit event
listing / 其他插件 (检查权限)
```

## 核心 API

### DataSecurityService

```typescript
// 检查开关状态
const enabled = ctx.dataSecurityService.isEnabled()

// 设置开关状态
await ctx.dataSecurityService.setEnabled(false)

// 获取受保护的文件模式
const patterns = ctx.dataSecurityService.getProtectedPatterns()
```

### 事件：data-security/check-file

```typescript
// 检查文件访问权限
const result = ctx.emit('data-security/check-file', '/path/to/file.xlsx')

if (!result.allowed) {
  throw new Error(result.reason)
  // 或者自定义处理逻辑
}
```

返回值：
```typescript
interface CheckResult {
  allowed: boolean
  reason?: string  // 仅在 allowed=false 时提供
}
```

## 受保护的文件类型

默认拦截以下文件：

| 类型 | 模式 | 说明 |
|------|------|------|
| SAS 数据集 | `**/*.sas7bdat` | SAS 数据表 |
| SAS 传输文件 | `**/*.xpt` | SAS XPORT 格式 |
| Data Excel | `**/data/**/*.xlsx`<br>`**/data/**/*.xls` | data 目录下的 Excel |
| Spec Excel | `**/spec/**/*.xlsx`<br>`**/spec/**/*.xls` | spec 目录下的 Excel |

## 配置文件

位置：`$DSH_HOME/profiles/enterprise/.data-security.json`

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

## HTTP API

### 获取状态

```bash
GET /api/settings/data-security

Response:
{
  "enabled": true
}
```

### 设置状态

```bash
POST /api/settings/data-security
Content-Type: application/json

{
  "enabled": false
}

Response:
{
  "success": true,
  "enabled": false
}
```

## 前端集成示例

```typescript
// 获取当前状态
const response = await fetch('/api/settings/data-security')
const { enabled } = await response.json()

// 切换开关
async function toggleDataSecurity(enabled: boolean) {
  const response = await fetch('/api/settings/data-security', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  
  if (!response.ok) {
    throw new Error('Failed to update data security setting')
  }
  
  return response.json()
}
```

## 使用场景

### 场景 1：工具执行前检查

```typescript
export function apply(ctx: Context) {
  ctx.on('before-tool-execute', async (tool, args) => {
    // 提取文件路径
    const filePath = args.filePath
    
    // 检查权限
    const result = ctx.emit('data-security/check-file', filePath)
    
    if (!result.allowed) {
      // 阻止工具执行
      return {
        error: result.reason,
        code: 'DATA_SECURITY_BLOCKED'
      }
    }
    
    // 继续执行
  })
}
```

### 场景 2：文件列表过滤

```typescript
export function apply(ctx: Context) {
  ctx.on('list-files', async (directory) => {
    const files = await readDirectory(directory)
    
    // 过滤敏感文件
    const visibleFiles = files.filter(file => {
      const result = ctx.emit('data-security/check-file', file.path)
      return result.allowed
    })
    
    return visibleFiles
  })
}
```

### 场景 3：批量文件处理

```typescript
export function apply(ctx: Context) {
  async function processFiles(files: string[]) {
    const results = []
    
    for (const file of files) {
      const check = ctx.emit('data-security/check-file', file)
      
      if (!check.allowed) {
        ctx.logger.warn(`Skipped protected file: ${file}`)
        results.push({ file, status: 'skipped', reason: check.reason })
        continue
      }
      
      // 处理允许的文件
      const result = await processFile(file)
      results.push({ file, status: 'processed', result })
    }
    
    return results
  }
}
```

## 日志

所有拦截动作都会记录到日志：

```
[WARN] Data security: blocked access to /project/data/patients.xlsx
```

日志级别：`warn`（表示阻止了潜在的敏感数据访问）

## 故障排查

### 问题 1：开关切换后未生效

**原因**：配置未持久化或缓存未刷新

**解决**：
1. 检查配置文件是否更新
2. 重启 DSH 服务
3. 查看日志确认 `data-security/changed` 事件是否触发

### 问题 2：误拦截非敏感文件

**原因**：文件路径匹配到受保护模式

**解决**：
1. 检查文件路径是否包含 `data/` 或 `spec/` 目录
2. 修改配置文件中的 `protectedPatterns`
3. 或暂时关闭数据安全开关

### 问题 3：敏感文件未被拦截

**原因**：
- 数据安全开关已关闭
- 文件路径未匹配到保护模式

**解决**：
1. 确认开关状态：`GET /api/settings/data-security`
2. 测试文件路径：`ctx.emit('data-security/check-file', filePath)`
3. 如需添加新的保护模式，修改配置文件

## 性能考虑

- **开关关闭**：零性能损耗（直接返回 `allowed: true`）
- **开关启用**：每次检查约 0.1-0.5ms（minimatch 匹配）
- **配置加载**：仅启动时一次，之后常驻内存

## 安全建议

1. **默认启用**：保持数据安全开关启用状态
2. **最小权限**：仅在必要时临时关闭开关
3. **审计日志**：定期检查日志中的拦截记录
4. **模式审查**：定期审查 `protectedPatterns`，确保覆盖所有敏感数据
5. **权限控制**：限制谁可以修改数据安全配置（前端权限管理）

## 扩展自定义

### 添加新的保护模式

编辑 `$DSH_HOME/profiles/enterprise/.data-security.json`：

```json
{
  "enabled": true,
  "protectedPatterns": [
    "**/*.sas7bdat",
    "**/*.xpt",
    "**/data/**/*.xlsx",
    "**/data/**/*.xls",
    "**/spec/**/*.xlsx",
    "**/spec/**/*.xls",
    "**/*.csv",              // 添加：保护所有 CSV
    "**/sensitive/**/*"      // 添加：保护 sensitive 目录
  ]
}
```

### 监听状态变化

```typescript
export function apply(ctx: Context) {
  ctx.on('data-security/changed', (enabled) => {
    ctx.logger.info(`Data security ${enabled ? 'enabled' : 'disabled'}`)
    
    // 执行自定义逻辑
    if (enabled) {
      // 启用时的处理
    } else {
      // 关闭时的处理
    }
  })
}
```

## 相关文档

- [ADR 0004: 数据安全开关功能](./adr/0004-data-security-toggle.md)
- [插件架构](./PLUGIN_ARCHITECTURE.md)
- [编码规范](./CODING_STANDARDS.md)
