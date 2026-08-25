# DSH-Guard 数据出域拦截开关重构详细设计 v2

## 一、设计目标

### 1.1 核心需求

| 场景 | 开关状态 | 行为 |
|------|----------|------|
| **数据拦截** | 启用 | 拦截 data 域数据发给 AI，不泄露 |
| **数据拦截** | 关闭 | 不拦截数据内容 |
| **流程引导** | 任意 | **始终生效**，不受开关影响 |
| **表格输出样式规范** | 任意 | **始终生效**，不受开关影响 |
| **EDC 系统字段识别** | 任意 | **始终生效**，不受开关影响 |
| **智能表头识别** | 任意 | **始终生效**，不受开关影响 |

### 1.2 关键原则

1. **开关控制范围**：只控制一件事——是否拦截 data 域数据内容
2. **开关切换**：自动触发进程重启
3. **智能功能始终生效**：流程引导、EDC识别、模板规范不受开关控制

### 1.3 架构变更

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           重构前架构                                        │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                         DataInterceptionPolicy                          │ │
│  │                                                                          │ │
│  │  isEnabled() ──→ 控制整个 DSH 系统                                     │ │
│  │      │                                                                  │ │
│  │      ├── true  ──→ 启用所有功能                                      │ │
│  │      │         • 数据拦截                                              │ │
│  │      │         • 智能功能                                              │ │
│  │      │         • 流程引导                                              │ │
│  │      │                                                                  │ │
│  │      └── false ──→ 禁用所有功能                                      │ │
│  │                • Harness 完全接管                                       │ │
│  │                                                                          │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘

                                    ↓ 重构

┌─────────────────────────────────────────────────────────────────────────────┐
│                           重构后架构                                        │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                         DataInterceptionPolicy                          │ │
│  │                                                                          │ │
│  │  isEnabled() ──→ 只控制数据拦截                                        │ │
│  │      │                                                                  │ │
│  │      ├── true  ──→ 拦截 data 域数据                                  │ │
│  │      │         • SAS 完全阻断                                          │ │
│  │      │         • Excel/CSV 内容拦截                                    │ │
│  │      │         • llm/stream 出域检查                                  │ │
│  │      │                                                                  │ │
│  │      └── false ──→ 不拦截数据内容                                     │ │
│  │                • SAS/Excel 正常返回                                   │ │
│  │                • llm/stream 无检查                                    │ │
│  │                                                                          │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                      始终生效的功能（不受开关控制）                       │ │
│  │                                                                          │ │
│  │  1. 流程引导                                                           │ │
│  │     • Listing 插件工作流                                               │ │
│  │     • listing_inspect / run_code / publish                           │ │
│  │                                                                          │ │
│  │  2. 表格输出样式规范                                                   │ │
│  │     • Output 模板验证                                                  │ │
│  │     • 交付物结构检查                                                   │ │
│  │                                                                          │ │
│  │  3. EDC 系统字段识别                                                   │ │
│  │     • Medidata/Oracle/VEVA 字段映射                                  │ │
│  │     • SDTM 命名规范验证                                                │ │
│  │                                                                          │ │
│  │  4. 智能表头识别                                                       │ │
│  │     • 评分式算法                                                       │ │
│  │     • DLP 模式扫描                                                     │ │
│  │     • 方向检测                                                         │ │
│  │                                                                          │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、开关切换机制

### 2.1 开关切换流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          开关切换流程                                        │
│                                                                              │
│  1. 用户在 UI 点击开关                                                       │
│     ↓                                                                        │
│  2. PUT /api/settings/data-interception                                     │
│     { "dataInterceptionEnabled": true/false }                               │
│     ↓                                                                        │
│  3. Policy.setEnabled() 被调用                                               │
│     ├── 触发 onChange 回调                                                  │
│     └── 触发 restart 通知                                                    │
│     ↓                                                                        │
│  4. Harness 收到 restart 通知                                                │
│     ├── 安全关闭当前 DSH 进程                                                │
│     └── 启动新的 DSH 进程（使用新配置）                                       │
│     ↓                                                                        │
│  5. 新进程启动                                                              │
│     ├── 读取新配置                                                          │
│     └── 注册组件（根据开关状态）                                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心代码设计

```javascript
// src/data-interception-policy.js

export function createDataInterceptionPolicy(initialEnabled = true, options = {}) {
  let enabled = initialEnabled;
  
  // 开关切换回调
  const onSwitch = options.onSwitch || (() => {});
  
  return Object.freeze({
    isEnabled() {
      return enabled;
    },
    
    setEnabled(nextEnabled, metadata = {}) {
      if (typeof nextEnabled !== 'boolean') {
        throw new TypeError('enabled must be a boolean');
      }
      
      const previousEnabled = enabled;
      enabled = nextEnabled;
      
      // 触发变更回调
      options.onChange?.({
        previousEnabled,
        enabled,
        source: metadata.source ?? 'runtime',
      });
      
      // ⚠️ 开关切换时触发进程重启
      if (previousEnabled !== enabled) {
        console.log(`[clinical-data-guard] 开关切换: ${previousEnabled} → ${enabled}，触发进程重启`);
        onSwitch({
          previousEnabled,
          enabled,
          reason: 'data_interception_switch',
        });
      }
      
      return enabled;
    },
  });
}

// src/index.js

export default function clinicalDataGuard(ctx, rawConfig = {}) {
  const config = validateConfig(rawConfig);
  
  // ⚠️ 创建策略对象，传入开关切换回调
  const policy = createDataInterceptionPolicy(config.dataInterceptionEnabled, {
    onChange(change) {
      // 记录变更日志
      logPolicyChange(change);
    },
    
    // ⚠️ 开关切换时触发重启
    onSwitch(switchInfo) {
      // 通知 Harness 重启进程
      ctx.emit?.('plugin:restart', {
        reason: 'data_interception_switch',
        previousEnabled: switchInfo.previousEnabled,
        enabled: switchInfo.enabled,
      });
    },
  });

  // ⚠️ 始终注册所有组件
  // - 开关只控制数据拦截
  // - 智能功能始终生效
  
  const runtime = new SecurityRuntime(config);
  const trustedToken = randomBytes(32).toString('hex');
  
  // 1. 品牌与开关 UI（始终注册）
  const disposers = [];
  disposers.push(registerBranding(ctx, config, policy));
  
  // 2. Listing 插件（始终注册，流程引导始终生效）
  disposers.push(registerClinicalListingPlugin(ctx, runtime, config, policy));
  
  // 3. 本地数据工具（始终注册）
  disposers.push(registerLocalMetadataTool(ctx, runtime, config, policy));
  
  // 4. post-execute 钩子（数据拦截受开关控制）
  const post = ctx.on('tools/post-execute', async (exec, result, next) => {
    if (shouldReplaceResult(exec)) {
      // ⚠️ 根据开关状态决定是否拦截数据
      const shouldIntercept = policy.isEnabled();
      
      const decision = await safeToolResult(
        exec,
        result,
        runtime,
        { ...config, hookTimeoutMs: hookTimeoutMs(config) },
        trustedToken,
        { interceptData: shouldIntercept },  // ⚠️ 传递拦截标志
      );
      return { kind: 'accept', content: decision.content ?? result.content };
    }
    return next();
  });
  disposers.push(post);
  
  // 5. llm/stream 钩子（出域检查受开关控制）
  const stream = ctx.on('llm/stream', async function* streamGuard(options, next) {
    // ⚠️ 根据开关状态决定是否检查
    if (policy.isEnabled()) {
      // 执行出域检查
      yield* checkEgress(options, runtime, config, policy, trustedToken);
    } else {
      // ⚠️ 开关关闭：不检查，直接放行
      yield* next();
    }
  });
  disposers.push(stream);
  
  return () => disposers.reverse().forEach(d => d?.());
}
```

---

## 三、始终生效的智能功能

### 3.1 功能矩阵

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           功能生效控制                                        │
│                                                                              │
│  ┌─────────────────────────────┬──────────────────────────────────────────┐ │
│  │ 功能                        │ 开关状态                                  │ │
│  │                             ├──────────────┬──────────────────────────┤ │
│  │                             │ 启用          │ 关闭                     │ │
│  ├─────────────────────────────┼──────────────┼──────────────────────────┤ │
│  │ 【数据拦截】                 │              │                          │ │
│  │ • SAS 数据阻断              │ ✅ 阻断       │ ❌ 正常返回              │ │
│  │ • Excel 内容拦截            │ ✅ 拦截       │ ❌ 正常返回              │ │
│  │ • llm/stream 出域检查       │ ✅ 检查       │ ❌ 不检查               │ │
│  ├─────────────────────────────┼──────────────┼──────────────────────────┤ │
│  │ 【始终生效】                 │              │                          │ │
│  │ • 流程引导 (Listing)         │ ✅ 生效       │ ✅ 生效                  │ │
│  │ • 表格输出样式规范           │ ✅ 验证       │ ✅ 验证                  │ │
│  │ • EDC 系统字段识别           │ ✅ 识别       │ ✅ 识别                  │ │
│  │ • 智能表头识别               │ ✅ 提取       │ ✅ 提取                  │ │
│  │ • 文档/spec 域放行           │ ✅ 放行       │ ✅ 放行                  │ │
│  │ • 凭据文件处理               │ ✅ 阻断       │ ✅ 阻断                  │ │
│  └─────────────────────────────┴──────────────┴──────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Listing 插件（流程引导，始终生效）

```javascript
// src/clinical-listing-plugin.js

function workflowContext(config, exec) {
  return {
    // ⚠️ 不再依赖开关，流程引导始终生效
    flowGuidanceEnabled: true,  // 固定为 true
    
    localDataAccess: config.localDataAccess,
    localDataRoot: exec?.agent?.session?.header?.cwd ?? config.localDataRoot,
    outputPlaneRoot: config.outputPlaneRoot,
    credentialsDir: config.credentialsDir,
    sessionId: exec.agent?.sessionId ?? config.sessionId ?? 'unknown-session',
    userId: exec.agent?.userId ?? config.userId ?? 'anonymous',
  };
}

// ⚠️ 插件始终注册，不受开关控制
export function registerClinicalListingPlugin(ctx, runtime, config, policy) {
  // ... 注册 listing_inspect / run_code / publish
}
```

### 3.3 表格输出样式规范（始终生效）

```javascript
// src/tool-result-guard.js

/**
 * Output 模板规范验证
 * ⚠️ 始终生效，不受开关控制
 */
async function validateOutputTemplate(localPath, config) {
  const headers = await runExtractor(localPath, config.maxScanRows ?? 20);
  
  // ⚠️ 始终验证模板规范
  const spec = OUTPUT_TEMPLATE_SPECS.listing;
  const required = spec.required_columns;
  const headers_lower = headers.map(h => h.toLowerCase());
  
  const missing = required.filter(col => 
    !headers_lower.includes(col.toLowerCase())
  );
  
  return {
    templateValid: missing.length === 0,
    templateType: 'listing',
    missingRequired: missing,
    complianceScore: (required.length - missing.length) / required.length,
  };
}

/**
 * safeToolResult
 * ⚠️ 智能功能始终生效，数据拦截受开关控制
 */
async function safeToolResult(exec, result, runtime, config, trustedToken, options = {}) {
  const { interceptData = true } = options;
  const execName = String(exec?.name ?? '');
  
  // 1. Listing 工具 → 信任收据通道（始终生效）
  if (CLINICAL_LISTING_TOOLS.has(execName)) {
    return handleListingResult(exec, result, runtime, config, trustedToken);
  }
  
  // 2. 凭据文件 → 始终阻断
  if (isCredentialPath(path, config.credentialsDir)) {
    return blockWithPlaceholder(credentialPlaceholder(path));
  }
  
  // 3. 文档/spec 域 → 始终放行
  if (plane === 'spec' || plane === 'document') {
    return passWithTrust(result, trustedToken);
  }
  
  // 4. 产物域 → 智能功能始终生效
  if (plane === 'output') {
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      // ⚠️ 始终提取表头和模板验证
      const headers = await runExtractor(localPath, config.maxScanRows ?? 20);
      const templateValidation = await validateOutputTemplate(localPath, config);
      
      // ⚠️ 数据内容根据开关状态决定
      if (interceptData) {
        return blockDataKeepStructure(headers, templateValidation);
      } else {
        return passWithStructure(headers, templateValidation);
      }
    }
  }
  
  // 5. 数据域
  if (plane === 'data') {
    if (['.sas7bdat', '.xpt', '.sas7bcat'].includes(ext)) {
      // ⚠️ SAS 数据根据开关状态决定
      return interceptData 
        ? blockSAS()           // 启用：阻断
        : passSAS();           // 关闭：正常返回
    }
    
    if (['.xlsx', '.xlsm', '.xls', '.xlsb', '.csv'].includes(ext)) {
      // ⚠️ Excel 始终提取智能信息
      const headers = await runExtractor(localPath, config.maxScanRows ?? 20);
      const edcRecognition = detectEDCSystem(headers);
      const fieldMapping = mapToStandardFields(headers, edcRecognition);
      
      // ⚠️ 数据内容根据开关状态决定
      if (interceptData) {
        return blockDataKeepStructure(headers, edcRecognition, fieldMapping);
      } else {
        return passWithStructure(headers, edcRecognition, fieldMapping);
      }
    }
  }
  
  // 6. 其他 → 原样放行
  return { content: existingContent(result) };
}
```

### 3.4 EDC 系统字段识别（始终生效）

```python
# security/header_detect.py - EDC 识别（已实现）

EDC_FIELD_MAPPINGS = {
    'medidata': {
        'SubjectID': 'USUBJID',
        'SiteID': 'SITEID',
        'Subject': 'SUBJID',
        'VisitName': 'VISIT',
        'FormName': 'FORM',
        'RecordID': 'RECKEY',
        # ...
    },
    'oracle': {
        'PATIENT_ID': 'USUBJID',
        'SITE_ID': 'SITEID',
        # ...
    },
    'veeva': {
        'Subject': 'USUBJID',
        'Site': 'SITEID',
        # ...
    },
}

def detect_edc_system(headers):
    """自动识别 EDC 系统"""
    # 评分匹配，返回最可能的系统
    ...

def map_to_standard_fields(headers, edc_system):
    """映射到标准 CDISC 字段"""
    # 返回映射结果
    ...
```

---

## 四、详细代码设计

### 4.1 src/index.js

```javascript
/**
 * index.js - DSH 临床数据守卫主入口
 * 
 * 2026-08-25 重构 v2：
 * - 开关只控制数据拦截
 * - 智能功能始终生效
 * - 开关切换触发进程重启
 */

import { randomBytes } from 'node:crypto';
import { registerBranding } from './branding.js';
import { createDataInterceptionPolicy } from './data-interception-policy.js';
import { safeToolResult, shouldReplaceResult } from './tool-result-guard.js';
import { registerClinicalListingPlugin } from './clinical-listing-plugin.js';
import { registerLocalMetadataTool } from './local-metadata-tool.js';
import { SecurityRuntime } from './security-runtime.js';

// ============================================================
// 常量
// ============================================================

const HOOK_TIMEOUT_DEFAULT_MS = 120_000;

// ============================================================
// 配置验证
// ============================================================

function validateConfig(raw = {}) {
  const envEnabled = process.env.DATA_INTERCEPTION_ENABLED !== '0';
  const dataInterceptionEnabled = raw.dataInterceptionEnabled ?? envEnabled;
  
  if (typeof dataInterceptionEnabled !== 'boolean') {
    throw new Error('dataInterceptionEnabled must be a boolean');
  }

  return {
    dataInterceptionEnabled,
    maxScanRows: Number(raw.maxScanRows ?? 20),
    credentialsDir: raw.credentialsDir ?? process.env.EMERALD_CREDENTIALS_DIR,
    localDataAccess: raw.localDataAccess ?? 'disabled',
    outputPlaneRoot: raw.outputPlaneRoot ?? process.env.EMERALD_OUTPUT_PLANE_ROOT,
  };
}

// ============================================================
// 辅助函数
// ============================================================

function hookTimeoutMs(config) {
  return Number.isFinite(config?.hookTimeoutMs) && config.hookTimeoutMs > 0
    ? config.hookTimeoutMs : HOOK_TIMEOUT_DEFAULT_MS;
}

function context(config, exec = {}) {
  return {
    dataInterceptionEnabled: true,  // ⚠️ 不再传递开关状态
    sessionId: exec.agent?.sessionId ?? config.sessionId ?? 'unknown-session',
    userId: exec.agent?.userId ?? config.userId ?? 'anonymous',
    workspaceRoot: exec.agent?.session?.header?.cwd ?? config.localDataRoot,
    localDataAccess: config.localDataAccess,
    credentialsDir: config.credentialsDir,
  };
}

function logPolicyChange(change) {
  const record = {
    event: 'data_interception_policy_changed',
    previousEnabled: change.previousEnabled,
    enabled: change.enabled,
    source: change.source ?? 'runtime',
    timestamp: new Date().toISOString(),
  };
  console.log('[clinical-data-guard]', JSON.stringify(record));
}

// ============================================================
// 主入口
// ============================================================

export default function clinicalDataGuard(ctx, rawConfig = {}) {
  const config = validateConfig(rawConfig);
  
  // ⚠️ 创建策略对象
  const policy = createDataInterceptionPolicy(config.dataInterceptionEnabled, {
    onChange: logPolicyChange,
    
    // ⚠️ 开关切换时触发进程重启
    onSwitch(switchInfo) {
      console.log(`[clinical-data-guard] 开关切换: ${switchInfo.previousEnabled} → ${switchInfo.enabled}，触发进程重启`);
      
      // 通知 Harness 重启
      if (typeof ctx.emit === 'function') {
        ctx.emit('plugin:restart', {
          reason: 'data_interception_switch',
          previousEnabled: switchInfo.previousEnabled,
          enabled: switchInfo.enabled,
        });
      }
    },
  });

  // ⚠️ 始终创建 runtime
  const runtime = new SecurityRuntime(config);
  const trustedToken = randomBytes(32).toString('hex');
  runtime.startHeartbeat();

  const disposers = [];

  // ============================================================
  // 1. 品牌与开关 UI（始终注册）
  // ============================================================
  disposers.push(registerBranding(ctx, config, policy));

  // ============================================================
  // 2. Listing 插件（流程引导，始终生效）
  // ============================================================
  disposers.push(registerClinicalListingPlugin(ctx, runtime, config, policy));

  // ============================================================
  // 3. 本地数据工具（始终注册）
  // ============================================================
  disposers.push(registerLocalMetadataTool(ctx, runtime, config, policy));

  // ============================================================
  // 4. post-execute 钩子（数据拦截受开关控制）
  // ============================================================
  const post = ctx.on('tools/post-execute', async (exec, result, next) => {
    if (shouldReplaceResult(exec)) {
      // ⚠️ 根据开关状态决定是否拦截数据
      const interceptData = policy.isEnabled();
      
      const decision = await safeToolResult(
        exec,
        result,
        runtime,
        {
          ...config,
          workspaceRoot: context(config, exec).workspaceRoot,
          hookTimeoutMs: hookTimeoutMs(config),
        },
        trustedToken,
        { interceptData },  // ⚠️ 传递拦截标志
      );
      return { kind: 'accept', content: decision.content ?? result.content };
    }
    return next();
  });
  disposers.push(post);

  // ============================================================
  // 5. llm/stream 钩子（出域检查受开关控制）
  // ============================================================
  const stream = ctx.on('llm/stream', async function* streamGuard(options, next) {
    // ⚠️ 根据开关状态决定是否执行出域检查
    if (policy.isEnabled()) {
      // 启用：执行出域检查
      const check = await runtime.request({
        operation: 'check_llm',
        payload: options,
        context: context(config),
      }, { timeoutMs: hookTimeoutMs(config) });

      if (!check.ok) {
        throw new Error(`[clinical-data-guard] 临床数据出域已阻断`);
      }

      if (check.payload) {
        yield* next({ ...options, ...check.payload });
        return;
      }
    }
    
    // ⚠️ 关闭：不检查，直接放行给 Harness
    yield* next();
  });
  disposers.push(stream);

  // 清理函数
  return () => {
    disposers.reverse().forEach(d => d?.());
    runtime.dispose();
  };
}

clinicalDataGuard.inject = ['tools', 'llm', 'webServer', 'systemPrompt'];
```

### 4.2 src/tool-result-guard.js

```javascript
/**
 * tool-result-guard.js - 工具结果守卫
 * 
 * 2026-08-25 重构 v2：
 * - 智能功能始终生效（表头提取、EDC识别、模板验证）
 * - 数据拦截受开关控制
 */

// ============================================================
// 核心函数
// ============================================================

/**
 * @param {object} exec - 工具执行信息
 * @param {object} result - 工具返回结果
 * @param {object} runtime - 安全运行时
 * @param {object} config - 配置
 * @param {string} trustedToken - 信任令牌
 * @param {object} options - 选项
 * @param {boolean} options.interceptData - 是否拦截数据内容
 */
export async function safeToolResult(exec, result, runtime, config, trustedToken, options = {}) {
  const interceptData = options.interceptData ?? true;
  const execName = String(exec?.name ?? '');
  const path = extractPath(exec.arguments ?? {});
  const plane = planeOf(path, config);
  const ext = extname(path).toLowerCase();
  const localPath = resolveLocalPath(path, config);

  // ============================================================
  // 1. Listing 工具（流程引导，始终生效）
  // ============================================================
  if (CLINICAL_LISTING_TOOLS.has(execName)) {
    return handleListingTool(exec, result, runtime, config, trustedToken);
  }

  // ============================================================
  // 2. 凭据文件（始终阻断）
  // ============================================================
  if (isCredentialPath(path, config.credentialsDir)) {
    return blockWithPlaceholder(credentialPlaceholder(path));
  }

  // ============================================================
  // 3. 文档/spec 域（始终放行）
  // ============================================================
  if (plane === 'spec' || plane === 'document') {
    return passWithTrust(result, trustedToken);
  }

  // ============================================================
  // 4. 产物域（表格输出样式规范，始终生效）
  // ============================================================
  if (plane === 'output') {
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      // ⚠️ 始终提取结构信息和模板验证
      const headers = await runExtractor(localPath, config.maxScanRows ?? 20);
      const templateValidation = validateOutputTemplate(headers);
      const edcRecognition = detectEDCSystem(headers);
      
      // ⚠️ 数据内容根据开关状态决定
      if (interceptData) {
        return contentOnly(result, JSON.stringify({
          clinicalGuard: 'OUTPUT_STRUCTURE_VALIDATED',
          ...headers,
          templateValidation,
          edcRecognition,
          note: '交付物结构已验证，数据内容已屏蔽',
        }));
      } else {
        return contentOnly(result, JSON.stringify({
          clinicalGuard: 'OUTPUT_STRUCTURE',
          ...headers,
          templateValidation,
          edcRecognition,
          note: '交付物结构信息',
        }));
      }
    }
  }

  // ============================================================
  // 5. 数据域
  // ============================================================
  if (plane === 'data') {
    // SAS 数据
    if (['.sas7bdat', '.xpt', '.sas7bcat'].includes(ext)) {
      return interceptData
        ? blockSAS(path)
        : passSAS(result);
    }

    // Excel/CSV
    if (['.xlsx', '.xlsm', '.xls', '.xlsb', '.csv'].includes(ext)) {
      // ⚠️ 始终提取智能信息
      const headers = await runExtractor(localPath, config.maxScanRows ?? 20);
      const edcRecognition = detectEDCSystem(headers);
      const fieldMapping = mapToStandardFields(headers, edcRecognition);
      
      // ⚠️ 数据内容根据开关状态决定
      if (interceptData) {
        return contentOnly(result, JSON.stringify({
          clinicalGuard: 'DATA_BLOCKED_STRUCTURED',
          file: basename(path),
          sheets: headers.sheets,
          edcRecognition,
          fieldMapping,
          note: '数据内容已屏蔽，表头和 EDC 字段已提取',
        }));
      } else {
        // ⚠️ 关闭：正常返回数据内容，但附加智能识别信息
        return contentOnly(result, JSON.stringify({
          clinicalGuard: 'DATA_WITH_SMART_INFO',
          file: basename(path),
          originalContent: extractOriginalContent(result),
          edcRecognition,
          fieldMapping,
          note: '数据内容和智能识别信息',
        }));
      }
    }
  }

  // ============================================================
  // 6. 其他 → 原样放行
  // ============================================================
  return { content: existingContent(result) };
}

// ============================================================
// 智能功能
// ============================================================

/**
 * 验证 Output 模板规范
 * ⚠️ 始终生效，不受开关控制
 */
function validateOutputTemplate(headers) {
  const spec = OUTPUT_TEMPLATE_SPECS.listing;
  const headerNames = headers.sheets?.[0]?.headers ?? [];
  const headerLower = headerNames.map(h => h.toLowerCase());
  
  const required = spec.required_columns;
  const missing = required.filter(col => 
    !headerLower.includes(col.toLowerCase())
  );
  
  return {
    templateValid: missing.length === 0,
    templateType: 'listing',
    requiredColumns: required,
    missingColumns: missing,
    complianceScore: required.length > 0 
      ? (required.length - missing.length) / required.length 
      : 1.0,
  };
}

/**
 * 检测 EDC 系统
 * ⚠️ 始终生效，不受开关控制
 */
function detectEDCSystem(headers) {
  const headerNames = headers.sheets?.[0]?.headers ?? [];
  const normalized = headerNames.map(h => h.toLowerCase().replace(/[_\s]/g, ''));
  
  const scores = {};
  for (const [system, mapping] of Object.entries(EDC_FIELD_MAPPINGS)) {
    let matches = 0;
    for (const field of Object.keys(mapping)) {
      if (normalized.includes(field.toLowerCase().replace(/[_\s]/g, ''))) {
        matches++;
      }
    }
    scores[system] = matches;
  }
  
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 3 
    ? { system: best[0], confidence: best[1] / Object.keys(EDC_FIELD_MAPPINGS[best[0]]).length }
    : { system: null, confidence: 0 };
}

/**
 * 映射到标准字段
 */
function mapToStandardFields(headers, edcRecognition) {
  if (!edcRecognition.system) return { mapped: [], unmapped: headers };
  
  const mapping = EDC_FIELD_MAPPINGS[edcRecognition.system] ?? {};
  const normalized = {};
  headers.forEach(h => {
    normalized[h.toLowerCase().replace(/[_\s]/g, '')] = h;
  });
  
  const mapped = [];
  const unmapped = [];
  
  for (const [edcField, standardField] of Object.entries(mapping)) {
    const norm = edcField.toLowerCase().replace(/[_\s]/g, '');
    if (normalized[norm]) {
      mapped.push({
        original: normalized[norm],
        standard: standardField,
        edcSystem: edcRecognition.system,
      });
    }
  }
  
  const mappedOriginals = new Set(mapped.map(m => m.original));
  headers.forEach(h => {
    if (!mappedOriginals.has(h)) unmapped.push(h);
  });
  
  return { mapped, unmapped };
}
```

### 4.3 src/clinical-listing-plugin.js

```javascript
/**
 * clinical-listing-plugin.js - Listing 主流程引导插件
 * 
 * 2026-08-25 重构 v2：
 * - 流程引导始终生效，不受开关控制
 * - 插件始终注册
 */

// ⚠️ 流程引导始终生效
function workflowContext(config, exec) {
  return {
    // ⚠️ 固定为 true，流程引导不受开关控制
    flowGuidanceEnabled: true,
    dataProtectionEnabled: config.dataInterceptionEnabled,
    
    localDataAccess: config.localDataAccess,
    localDataRoot: exec?.agent?.session?.header?.cwd ?? config.localDataRoot,
    outputPlaneRoot: config.outputPlaneRoot,
    credentialsDir: config.credentialsDir,
    sessionId: exec.agent?.sessionId ?? config.sessionId ?? 'unknown-session',
    userId: exec.agent?.userId ?? config.userId ?? 'anonymous',
  };
}

// ⚠️ 插件始终注册
export function registerClinicalListingPlugin(ctx, runtime, config, policy) {
  const disposers = [];
  
  // listing_inspect
  disposers.push(ctx.tools.register(defineTool({
    name: 'clinical_listing_inspect',
    // ...
  })));
  
  // listing_run_code
  disposers.push(ctx.tools.register(defineTool({
    name: 'clinical_listing_run_code',
    // ...
  })));
  
  // listing_publish
  disposers.push(ctx.tools.register(defineTool({
    name: 'clinical_listing_publish',
    // ...
  })));
  
  // 系统提示
  if (ctx.systemPrompt?.section) {
    disposers.push(ctx.systemPrompt.section({
      name: 'tool:clinical-listing-lifecycle',
      order: 95,
      text: '临床 Listing 使用固定工作流...',  // ⚠️ 始终提示
    }));
  }
  
  return () => disposers.forEach(d => d?.());
}
```

### 4.4 src/branding.js

```javascript
/**
 * branding.js - 品牌与开关 UI
 * 
 * ⚠️ 开关 UI 始终注册，但状态根据 policy 变化
 */

// ⚠️ 品牌和开关 UI 始终注册
export function registerBranding(ctx, config, policy) {
  const disposers = [];
  
  // HTML 品牌注入
  disposers.push(ctx.webServer.tapIndex(html => brandHtml(html, config)));
  
  // API 端点
  disposers.push(ctx.webServer.register({
    path: '/api/settings/data-interception',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        res.end(JSON.stringify({
          dataInterceptionEnabled: policy.isEnabled(),
          // ⚠️ 添加模式说明
          mode: policy.isEnabled() ? 'data-blocking' : 'open',
          modeDescription: policy.isEnabled() 
            ? '数据拦截已启用'
            : '数据拦截已关闭（流程引导和智能功能仍生效）',
        }));
      } else if (req.method === 'PUT') {
        // ⚠️ 开关切换
        const { dataInterceptionEnabled } = await parseBody(req);
        policy.setEnabled(dataInterceptionEnabled, { source: 'settings-api' });
        // ⚠️ policy.setEnabled 会触发 onSwitch 回调
        res.end(JSON.stringify({
          dataInterceptionEnabled: policy.isEnabled(),
          mode: policy.isEnabled() ? 'data-blocking' : 'open',
          restartTriggered: true,
        }));
      }
    },
  }));
  
  return () => disposers.forEach(d => d?.());
}
```

---

## 五、行为对照表

### 5.1 完整功能矩阵

```
┌────────────────────────────┬─────────────────────────┬─────────────────────────┐
│ 功能                        │ 开关启用                  │ 开关关闭                  │
├────────────────────────────┼─────────────────────────┼─────────────────────────┤
│ 【数据拦截】                 │                         │                         │
│ • llm/stream 出域检查       │ ✅ 检查                 │ ❌ 不检查               │
│ • SAS 数据                  │ ✅ 阻断                 │ ❌ 正常返回             │
│ • Excel 数据内容             │ ✅ 拦截                 │ ❌ 正常返回             │
│ • CSV 数据内容               │ ✅ 拦截                 │ ❌ 正常返回             │
├────────────────────────────┼─────────────────────────┼─────────────────────────┤
│ 【始终生效】                 │                         │                         │
│ • 流程引导 (Listing)         │ ✅ 生效                 │ ✅ 生效                 │
│ • 表格输出样式规范           │ ✅ 验证                 │ ✅ 验证                 │
│ • EDC 系统字段识别           │ ✅ 识别                 │ ✅ 识别                 │
│ • 智能表头识别               │ ✅ 提取                 │ ✅ 提取                 │
│ • 文档/spec 域放行           │ ✅ 放行                 │ ✅ 放行                 │
│ • 凭据文件阻断               │ ✅ 阻断                 │ ✅ 阻断                 │
├────────────────────────────┼─────────────────────────┼─────────────────────────┤
│ 【开关切换】                 │                         │                         │
│ • 触发进程重启              │ ✅                      │ ✅                      │
└────────────────────────────┴─────────────────────────┴─────────────────────────┘
```

### 5.2 UI 显示

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              开关 UI                                         │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ 临床数据出域拦截                                                        │ │
│  │                                                                       │ │
│  │  启用时：                                                              │ │
│  │  "数据拦截已启用 — SAS 数据集与 Excel 单元格数据将在出域前拦截，        │ │
│  │   仅元数据信封交给 AI。流程引导和智能功能正常工作。"                      │ │
│  │                                                                       │ │
│  │  关闭时：                                                              │ │
│  │  "数据拦截已关闭 — 不拦截数据内容，Harness 可直接处理数据。              │ │
│  │   流程引导和智能功能（表头识别、EDC 映射）仍正常工作。"                  │ │
│  │                                                                       │ │
│  │                                    [开关]                              │ │
│  │                                                                       │ │
│  │  ⚠️ 切换开关将自动重启进程                                             │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 六、测试设计

### 6.1 单元测试

```javascript
describe('数据拦截开关 v2', () => {
  
  test('开关启用时，数据内容被拦截', async () => {
    const policy = createDataInterceptionPolicy(true);
    const result = await safeToolResult(
      { name: 'read_file', arguments: { path: 'data/patients.csv' } },
      { content: [{ type: 'text', text: 'USUBJID,VISIT\n001-001,Week 1' }] },
      runtime,
      config,
      token,
      { interceptData: policy.isEnabled() }
    );
    expect(result.content[0].text).toContain('DATA_BLOCKED');
  });

  test('开关关闭时，数据内容正常返回', async () => {
    const policy = createDataInterceptionPolicy(false);
    const result = await safeToolResult(
      { name: 'read_file', arguments: { path: 'data/patients.csv' } },
      { content: [{ type: 'text', text: 'USUBJID,VISIT\n001-001,Week 1' }] },
      runtime,
      config,
      token,
      { interceptData: policy.isEnabled() }
    );
    expect(result.content[0].text).toContain('DATA_WITH_SMART_INFO');
    expect(result.content[0].text).toContain('001-001');  // 原始数据
  });

  test('开关切换触发重启回调', () => {
    const restartCalled = [];
    const policy = createDataInterceptionPolicy(true, {
      onSwitch: (info) => restartCalled.push(info),
    });
    
    policy.setEnabled(false, { source: 'test' });
    
    expect(restartCalled).toHaveLength(1);
    expect(restartCalled[0]).toMatchObject({
      previousEnabled: true,
      enabled: false,
      reason: 'data_interception_switch',
    });
  });

  test('Listing 插件始终注册，不受开关影响', () => {
    const ctx = createMockContext();
    
    // 开关关闭
    clinicalDataGuard(ctx, { dataInterceptionEnabled: false });
    
    // Listing 插件仍注册
    expect(ctx.tools.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'clinical_listing_inspect' })
    );
    expect(ctx.tools.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'clinical_listing_run_code' })
    );
  });

  test('智能功能始终生效，不受开关影响', async () => {
    const policy = createDataInterceptionPolicy(false);
    const result = await safeToolResult(
      { name: 'read_file', arguments: { path: 'data/dm.xlsx' } },
      { content: [{ type: 'text', text: 'USUBJID,VISIT,FORM\n001-001,Week 1,DM' }] },
      runtime,
      config,
      token,
      { interceptData: policy.isEnabled() }
    );
    
    // EDC 识别仍然生效
    expect(result.content[0].text).toContain('edcRecognition');
    expect(result.content[0].text).toContain('fieldMapping');
  });
});
```

---

## 七、文件改动清单

```
src/
├── index.js                          # ⚠️ 改动：传递 interceptData 选项
├── data-interception-policy.js       # ⚠️ 改动：添加 onSwitch 回调
├── tool-result-guard.js              # ⚠️ 改动：interceptData 参数
├── clinical-listing-plugin.js        # ⚠️ 改动：flowGuidanceEnabled 固定为 true
├── branding.js                       # 改动：API 响应添加模式说明
└── (其他文件无需改动)

security/
└── (Python 层无需改动)

tests/
├── unit/test_switch_v2.js           # 新增：v2 开关测试
└── e2e/test_switch_v2_integration.js # 新增：v2 集成测试
```

---

## 八、总结

### 8.1 核心改动

| 改动点 | 内容 |
|--------|------|
| **Policy** | 添加 `onSwitch` 回调，开关切换触发进程重启 |
| **Index.js** | 传递 `interceptData` 选项给 `safeToolResult` |
| **ToolResultGuard** | 根据 `interceptData` 决定是否拦截数据 |
| **Listing Plugin** | `flowGuidanceEnabled` 固定为 true |
| **Branding** | API 响应添加模式说明 |

### 8.2 效果

| 场景 | 数据拦截 | 智能功能 | 流程引导 |
|------|----------|----------|----------|
| 开关启用 | ✅ 生效 | ✅ 生效 | ✅ 生效 |
| 开关关闭 | ❌ 不生效 | ✅ 生效 | ✅ 生效 |

### 8.3 开关切换

- 切换时自动触发 `onSwitch` 回调
- Harness 收到通知后重启进程
- 新进程使用新配置启动
