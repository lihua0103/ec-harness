# @dsh-guard/clinical-guard

临床数据守护插件 - AI驱动的临床试验数据安全和Listing生成系统

## 🎯 核心功能

### 1. 数据安全开关（核心）
- **默认开启**：开箱即用的数据安全保护
- **关闭后**：不做任何拦截，完全放行
- **双重拦截**：
  - SAS 数据集 data 出域 AI 拦截
  - Spec 需求辅助理解处理 data 出域 AI 拦截

### 2. AI 临床流程
- Listing 生成流程自动化
- AI 辅助临床数据处理

### 3. 智能算法
- **表头识别**：AI 增强的表头检测
- **EDC 字段识别**：支持 Medidata、Oracle、Veeva 等主流系统

### 4. 输出规范
- Listing 样式规范模板
- 标准化输出格式

## 📦 安装

```bash
pnpm install
```

## 🔧 配置

### Cordis 配置示例

```yaml
plugins:
  - name: '@dsh-guard/clinical-guard'
    config:
      # 数据安全开关（核心配置）
      dataEgressControl:
        enabled: true  # 默认开启，false 时不做任何拦截
        
        # SAS 数据集出域拦截
        sasDatasetEgress:
          enabled: true
          aiInterception: true
        
        # Spec 需求数据出域拦截
        specDataEgress:
          enabled: true
          aiInterception: true
      
      # 表头检测
      headerDetection:
        enabled: true
        aiEnhanced: true
      
      # EDC 字段识别
      edcFieldRecognition:
        enabled: true
        systems:
          - Medidata
          - Oracle
          - Veeva
      
      # Listing 模板
      listingTemplate:
        enabled: true
        standardTemplates: true
        customTemplates: []
      
      # 可选配置
      pythonPath: /path/to/python
      auditLogPath: /path/to/audit/logs
```

### TypeScript 配置

```typescript
import { Context } from '@deepseek-ai/cordis'
import ClinicalGuard, { EgressType } from '@dsh-guard/clinical-guard'

const ctx = new Context()

ctx.plugin(ClinicalGuard, {
  dataEgressControl: {
    enabled: true,
    sasDatasetEgress: {
      enabled: true,
      aiInterception: true,
    },
    specDataEgress: {
      enabled: true,
      aiInterception: true,
    },
  },
  headerDetection: {
    enabled: true,
    aiEnhanced: true,
  },
  edcFieldRecognition: {
    enabled: true,
    systems: ['Medidata', 'Oracle', 'Veeva'],
  },
  listingTemplate: {
    enabled: true,
    standardTemplates: true,
    customTemplates: [],
  },
})

// 使用服务
const result = await ctx.clinicalGuard.checkEgress(
  EgressType.SAS_DATASET,
  myData
)

if (!result.allowed) {
  console.log('数据出域被拦截:', result.reason)
}
```

## 🔒 数据安全开关详解

### 工作原理

```
┌─────────────────────────────────────────┐
│     数据安全开关 (默认: 开启)            │
├─────────────────────────────────────────┤
│  enabled: true  → 执行安全检查           │
│  enabled: false → 不做任何拦截 (直接放行) │
└─────────────────────────────────────────┘
           ↓
    ┌──────┴──────┐
    ↓             ↓
┌─────────┐  ┌─────────┐
│SAS 拦截 │  │Spec拦截 │
│AI 决策  │  │AI 理解  │
└─────────┘  └─────────┘
```

### 拦截场景

#### 场景 1：SAS 数据集出域拦截

```typescript
// 数据安全开关：开启
// SAS 拦截：开启
// AI 拦截：开启

const result = await ctx.clinicalGuard.checkEgress(
  EgressType.SAS_DATASET,
  sasDataset
)

// result.allowed: false (如果 AI 判断数据敏感)
// result.reason: "检测到敏感患者数据"
```

#### 场景 2：Spec 需求数据出域拦截

```typescript
// 数据安全开关：开启
// Spec 拦截：开启
// AI 拦截：开启

const result = await ctx.clinicalGuard.checkEgress(
  EgressType.SPEC_DATA,
  specData
)

// AI 会理解 Spec 内容，判断是否包含敏感数据
```

#### 场景 3：关闭安全开关

```yaml
dataEgressControl:
  enabled: false  # 关闭后不做任何拦截
```

所有数据直接放行，不经过任何检查。

## 🏗️ 项目结构

```
clinical-guard/
├── src/
│   ├── index.ts                      # 主入口（Cordis 插件）
│   ├── config.ts                     # 配置和 Schema
│   ├── service.ts                    # 主服务类
│   ├── core/                         # 核心功能
│   │   ├── egress-switch.ts         # 数据安全开关 ✅
│   │   ├── egress-checkpoint.ts     # 出域检查点 (TODO)
│   │   ├── header-detector.ts       # 表头识别 (TODO)
│   │   ├── edc-field-detector.ts    # EDC 字段识别 (TODO)
│   │   └── listing-template.ts      # Listing 模板 (TODO)
│   ├── ai/                          # AI 功能
│   │   ├── listing-flow.ts          # Listing 流程 (TODO)
│   │   ├── spec-parser.ts           # Spec 解析 (TODO)
│   │   └── data-inspector.ts        # 数据检查 (TODO)
│   ├── security/                    # 安全模块
│   │   ├── audit-log.ts             # 审计日志 (TODO)
│   │   ├── sandbox.ts               # 代码沙箱 (TODO)
│   │   └── path-policy.ts           # 路径策略 (TODO)
│   ├── workflow/                    # 工作流
│   │   ├── listing-executor.ts      # 执行器 (TODO)
│   │   └── listing-plan.ts          # 计划 (TODO)
│   └── tools/                       # Cordis 工具
│       ├── listing-inspect.ts       # (TODO)
│       ├── listing-run-code.ts      # (TODO)
│       └── listing-publish.ts       # (TODO)
├── python/                          # Python 后端
│   └── security/                    # 原有 Python 模块
│       ├── egress_checkpoint.py     # 出域检查
│       ├── header_detect.py         # 表头检测
│       ├── listing_workflow.py      # Listing 工作流
│       └── ... (其他模块)
├── tests/
│   ├── unit/                        # 单元测试
│   ├── integration/                 # 集成测试
│   └── e2e/                         # E2E 测试
├── docs/
│   ├── API.md                       # API 文档
│   ├── ARCHITECTURE.md              # 架构说明
│   └── MIGRATION.md                 # 迁移指南
├── package.json
├── tsconfig.json
└── README.md
```

## 🧪 测试

```bash
# 运行所有测试
pnpm test

# 单元测试
pnpm test:unit

# 集成测试
pnpm test:integration

# E2E 测试
pnpm test:e2e

# 覆盖率测试
pnpm test:coverage
```

### 测试要求

- ✅ 单元测试覆盖率 > 80%
- ✅ 集成测试覆盖核心流程
- ✅ E2E 测试覆盖主要用户场景
- ✅ 数据安全开关测试（开启/关闭）
- ✅ SAS 数据集拦截测试
- ✅ Spec 数据拦截测试

## 📝 开发指南

### 添加新的拦截类型

```typescript
// 1. 在 EgressType 中添加新类型
export enum EgressType {
  SAS_DATASET = 'sas_dataset',
  SPEC_DATA = 'spec_data',
  NEW_TYPE = 'new_type',  // 新类型
}

// 2. 在配置中添加开关
export interface DataEgressControlConfig {
  // ... 其他配置
  newTypeEgress: {
    enabled: boolean
    aiInterception: boolean
  }
}

// 3. 在 EgressSwitch 中实现拦截逻辑
private async interceptNewType(
  data: any,
  timestamp: number
): Promise<InterceptionResult> {
  // 实现拦截逻辑
}
```

### 集成 Python 后端

```typescript
// Python 后端通过子进程调用
import { spawn } from 'node:child_process'

const python = spawn('python', ['-m', 'security.worker'])

// 通过 IPC 通信
python.stdin.write(JSON.stringify({ 
  operation: 'check_egress',
  data: myData 
}))
```

## 🔄 从旧系统迁移

### 迁移步骤

1. **复制 Python 模块**：
```bash
cp -r dsh-clinical-data-guard/security python/security
```

2. **更新配置**：
```yaml
# 旧配置
plugins:
  - name: emerald-clinical-data-guard
    # ...

# 新配置
plugins:
  - name: '@dsh-guard/clinical-guard'
    config:
      dataEgressControl:
        enabled: true
```

3. **更新测试**：
```bash
# 迁移测试文件
cp -r dsh-clinical-data-guard/tests/* tests/
```

4. **运行测试验证**：
```bash
pnpm test
```

## 🚀 快速开始

### 1. 构建

```bash
pnpm build
```

### 2. 运行测试

```bash
pnpm test
```

### 3. 使用

在 `configs/cordis.yml` 中配置：

```yaml
plugins:
  - name: '@dsh-guard/clinical-guard'
    config:
      dataEgressControl:
        enabled: true
```

然后启动 DSH：

```bash
pnpm start
```

## 📚 API 文档

### ClinicalGuardService

#### checkEgress(egressType, data)

检查数据出域。

**参数：**
- `egressType: EgressType` - 出域类型
- `data: any` - 要检查的数据

**返回：** `Promise<InterceptionResult>`

**示例：**
```typescript
const result = await ctx.clinicalGuard.checkEgress(
  EgressType.SAS_DATASET,
  myData
)
```

#### getEgressSwitchStatus()

获取数据安全开关状态。

**返回：** 开关配置对象

### EgressSwitch

#### shouldIntercept(egressType)

判断是否应该拦截。

**返回：** `boolean`

#### intercept(egressType, data)

执行拦截检查。

**返回：** `Promise<InterceptionResult>`

## 🐛 故障排除

### 问题：数据被错误拦截

**解决方案：**
1. 检查开关配置
2. 查看审计日志
3. 调整 AI 拦截参数

### 问题：性能问题

**解决方案：**
1. 禁用不需要的功能
2. 调整 AI 拦截策略
3. 使用缓存

## 📄 许可证

MIT License

---

**状态**: 🚧 开发中  
**版本**: 1.0.0  
**维护**: DSH Guard Team
