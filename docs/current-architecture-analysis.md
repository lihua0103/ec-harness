# DSH-Guard 当前架构分析

## 一、系统架构总览

### 1.1 核心组件关系

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Claude Harness (DSH)                            │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    Clinical Data Guard Plugin                            │  │
│  │                                                                       │  │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────┐ │  │
│  │  │  index.js       │  │ branding.js       │  │ clinical-listing   │ │  │
│  │  │  (主入口/钩子)   │  │ (品牌/开关UI)     │  │ -plugin.js        │ │  │
│  │  │                 │  │                   │  │ (主流程引导)       │ │  │
│  │  │  • post-execute │  │  • 设置页面注入   │  │                   │ │  │
│  │  │  • llm/stream   │  │  • 开关API        │  │ • listing_inspect │ │  │
│  │  │                 │  │                   │  │ • listing_run_code │ │  │
│  │  │                 │  │                   │  │ • listing_publish  │ │  │
│  │  └────────┬────────┘  └──────────────────┘  └─────────┬──────────┘ │  │
│  │           │                                           │            │  │
│  │           ▼                                           ▼            │  │
│  │  ┌───────────────────────────────────────────────────────────────┐  │  │
│  │  │                    SecurityRuntime (Node.js)                  │  │  │
│  │  │  ┌────────────────┐  ┌────────────────┐                    │  │  │
│  │  │  │   fast lane     │  │   heavy lane   │                    │  │  │
│  │  │  │  (check_llm)    │  │ (listing_*)    │                    │  │  │
│  │  │  └────────┬────────┘  └────────┬───────┘                    │  │  │
│  │  │           │                   │                             │  │  │
│  │  └───────────┼───────────────────┼─────────────────────────────┘  │  │
│  │              │                   │                                  │  │
│  │              ▼                   ▼                                  │  │
│  │  ┌───────────────────────────────────────────────────────────────┐  │  │
│  │  │                   worker.py (Python)                           │  │  │
│  │  │  • egress_checkpoint.py - 出域检查                           │  │  │
│  │  │  • header_detect.py      - 表头识别                         │  │  │
│  │  │  • listing_code_lane.py  - 代码车道                         │  │  │
│  │  │  • patterns.py           - 临床数据模式库                    │  │  │
│  │  └───────────────────────────────────────────────────────────────┘  │  │
│  │                                                                       │  │
│  │  ┌───────────────────────────────────────────────────────────────┐  │  │
│  │  │                    tool-result-guard.js                        │  │  │
│  │  │  • 工具结果安全处置                                           │  │  │
│  │  │  • planeOf() - 来源域判定                                    │  │  │
│  │  │  • safeToolResult() - 智能表头提取                           │  │  │
│  │  └───────────────────────────────────────────────────────────────┘  │  │
│  │                                                                       │  │
│  │  ┌───────────────────────────────────────────────────────────────┐  │  │
│  │  │                 data-interception-policy.js                   │  │  │
│  │  │  • isEnabled() - 总开关                                      │  │  │
│  │  │  • setEnabled() - 状态切换                                  │  │  │
│  │  └───────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 数据流

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              数据流向                                        │
│                                                                              │
│  1. User Request → Harness → LLM                                            │
│     ↓                                                                       │
│  2. llm/stream 钩子 → check_llm → worker (egress_checkpoint)               │
│     ↓                                                                       │
│  3. Tool Call → post-execute 钩子 → safeToolResult                          │
│     ↓                                                                       │
│  4. safeToolResult → planeOf() → 根据域拦截/放行                          │
│     ↓                                                                       │
│  5. data plane → 智能表头提取 → 拦截数据内容                                │
│     ↓                                                                       │
│  6. Tool Result → Harness → LLM                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、核心模块分析

### 2.1 index.js (主入口)

**职责**：
- 注册所有钩子（`tools/post-execute`, `llm/stream`）
- 管理 `SecurityRuntime` 生命周期
- 协调各组件注册

**当前开关逻辑**：
```javascript
// post-execute 钩子
const post = ctx.on('tools/post-execute', async (exec, result, next) => {
  if (!policy.isEnabled()) return next();  // ⚠️ 关闭时完全跳过
  // ... 拦截逻辑
});

// llm/stream 钩子
const stream = ctx.on('llm/stream', async function* streamGuard(options, next) {
  if (!policy.isEnabled()) {
    yield* next();  // ⚠️ 关闭时直接放行
    return;
  }
  // ... 拦截逻辑
});
```

**问题**：开关关闭时，整个 DSH 系统的钩子和功能都被跳过

---

### 2.2 data-interception-policy.js (策略管理)

**当前实现**：
```javascript
export function createDataInterceptionPolicy(initialEnabled = true, options = {}) {
  let enabled = initialEnabled;
  return Object.freeze({
    isEnabled() { return enabled; },
    setEnabled(nextEnabled, metadata = {}) { /* ... */ },
  });
}
```

**问题**：单一开关控制整个系统，无法区分"数据拦截"和"智能功能"

---

### 2.3 tool-result-guard.js (工具结果守卫)

**职责**：
- 工具结果的安全处置
- 来源域判定（`planeOf()`）
- 表头智能提取

**当前拦截逻辑**：
```javascript
// safeToolResult() 核心逻辑

// 1. Listing 工具 → 信任收据通道
if (CLINICAL_LISTING_TOOLS.has(execName)) { /* ... */ }

// 2. 凭据文件 → 完全阻断
if (isCredentialPath(path, config.credentialsDir)) { /* ... */ }

// 3. 文档/spec 域 → 信任放行
if (plane === 'spec' || plane === 'document') { /* ... */ }

// 4. 产物域 → 表头提取
if (plane === 'output') { /* ... */ }

// 5. 数据域 → 拦截内容
if (plane === 'data') {
  if (['.sas7bdat', '.xpt'].includes(ext)) {
    // SAS 完全阻断
  }
  if (['.xlsx', '.csv'].includes(ext)) {
    // Excel/CSV 表头提取 + 数据拦截
  }
}
```

---

### 2.4 planes.js (来源域判定)

**来源域定义**：
- `data` - 数据域（SAS/Excel 数据文件）
- `spec` - 规格档（需求文档、ALS 模板）
- `document` - 辅助档（参考文档）
- `output` - 产物域（交付物）
- `null` - 其他

**判定优先级**：
```
SAS/XPT 扩展名 > spec/document 目录 > output 目录 > Excel 扩展名 > dataPlaneRoots
```

---

### 2.5 header_detect.py (智能表头识别)

**功能**：
1. 评分式表头识别算法
2. 水平/垂直方向检测
3. DLP 模式扫描
4. SDTM 命名规范验证
5. EDC 字段角色映射

**核心算法**：
```python
# _score_row() - 评分式表头识别
def _score_row(row, total_cols, merged_cols):
    score = 0.0
    # 字符串占比高 → +3.0
    # 列填充率高 → +2.0
    # 合并单元格 → +2.0
    # DLP 命中 → -3.0~-5.0
    # 像数据值 → -6.0
    return score
```

**EDC 字段角色映射**：
```python
EDC_FIELD_ROLES = {
    "study": {"STUDYID", "STUDYNAME", ...},
    "site": {"SITEID", "SITENUMBER", ...},
    "subject": {"USUBJID", "SUBJID", ...},
    "visit": {"VISIT", "VISITNAME", ...},
    "form": {"FORM", "FORMNAME", ...},
    # ...
}
```

**问题**：EDC 识别已有，但与数据拦截耦合

---

### 2.6 egress_checkpoint.py (出域检查点)

**职责**：
- LLM 请求的出域数据检测
- 临床数据模式识别（CDISC、SDTM）
- HMAC 签名验证

**关键函数**：
```python
def check_egress_v2(payload, context):
    """检测 LLM 请求中的临床数据"""
    # 1. 扫描 messages
    # 2. 检测受试者 ID、日期等
    # 3. 返回 evidence
```

**全局开关**：
```python
def _egress_enabled(context=None) -> bool:
    value = (context or {}).get("dataInterceptionEnabled")
    if isinstance(value, bool):
        return value
    return os.environ.get("DATA_INTERCEPTION_ENABLED", "1") != "0"
```

---

### 2.7 listing_code_lane.py (代码车道)

**工作流**：
```
run_listing_code → iterate → publish_listing_code
```

**安全约束**：
- 只回聚合元数据信封（行数/列名/dtype）
- 字符串字段 scrub
- SAS 行级数据零出域

**收据结构**：
```python
{
    "clinicalGuard": "CLINICAL_LISTING_CODE_RECEIPT",
    "status": "ok|rejected|error",
    "stage": "run",
    "dataClass": "METADATA_ONLY",
    # ... 元数据
}
```

---

### 2.8 branding.js (品牌与开关UI)

**功能**：
1. 品牌注入（标题、Logo）
2. 设置页面开关注入
3. API 端点注册

**开关 API**：
```javascript
// GET /api/settings/data-interception
// PUT /api/settings/data-interception
```

---

## 三、当前架构问题

### 3.1 开关逻辑问题

| 问题 | 当前实现 | 影响 |
|------|----------|------|
| **单一开关控制一切** | `policy.isEnabled()` 控制所有钩子和功能 | 关闭时无法使用智能功能 |
| **智能功能未解耦** | 表头提取与数据拦截耦合 | 无法在测试模式下使用智能识别 |
| **Listing 插件依赖** | `workflowContext` 携带 `dataProtectionEnabled` | 关闭时 Listing 功能异常 |

### 3.2 数据流问题

```
当前流程：
User → llm/stream → check_llm → Tool Call → post-execute → Tool Result → LLM
         ↑                                    ↑
         └──── 全局开关控制 ──────────────────┘

问题：
1. 关闭开关时，连文档分析都跳过
2. 无法在测试模式下使用智能功能
3. 没有区分"数据拦截"和"流程引导"
```

---

## 四、需求澄清

### 4.1 开关行为

| 开关状态 | 期望行为 |
|----------|----------|
| **启用** | 数据拦截 + 智能功能 + 流程引导 |
| **关闭** | **整个 DSH 系统静默**，Harness 完全接管 |

### 4.2 智能功能（始终生效）

| 功能 | 描述 |
|------|------|
| 智能表头识别 | 评分式算法，识别方向、DLP、SDTM 规范 |
| EDC 字段识别 | Medidata/Oracle/VEVA 字段映射 |
| Output 样式规范 | Listing/QC 模板验证 |
| 主流程引导 | Listing 插件工作流 |

---

## 五、架构重构方案

### 5.1 核心改动

```javascript
// index.js - 关键改动

export default function clinicalDataGuard(ctx, rawConfig = {}) {
  const policy = createDataInterceptionPolicy(config.dataInterceptionEnabled);
  
  // ⚠️ 关键：开关关闭时整个系统静默
  if (!policy.isEnabled()) {
    return () => {};  // 空 dispose，不注册任何钩子
  }
  
  // 开关启用时：注册所有组件
  // ...
}
```

### 5.2 智能功能解耦

```
┌─────────────────────────────────────────────────────────────┐
│                    智能功能层（始终生效）                      │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ 表头识别   │  │ EDC映射    │  │ 模板验证    │         │
│  │ header_detect │ │ EDC_FIELD_ROLES │ │ OUTPUT_SPEC │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                    Listing Plugin                        ││
│  │  • inspect → schema 理解                                 ││
│  │  • run_code → 迭代推理                                  ││
│  │  • publish → 规范输出                                   ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    数据拦截层（受开关控制）                    │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ data plane  │  │ SAS/XPT    │  │ llm/stream  │         │
│  │ 内容拦截    │  │ 完全阻断   │  │ 出域检查   │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

---

## 六、文件清单

### 6.1 JavaScript 源文件

| 文件 | 职责 |
|------|------|
| `src/index.js` | 主入口、钩子注册、生命周期管理 |
| `src/data-interception-policy.js` | 策略管理 |
| `src/tool-result-guard.js` | 工具结果守卫 |
| `src/planes.js` | 来源域判定 |
| `src/clinical-listing-plugin.js` | Listing 工作流插件 |
| `src/branding.js` | 品牌与开关UI |
| `src/patterns.js` | 脱敏模式 |

### 6.2 Python 源文件

| 文件 | 职责 |
|------|------|
| `security/worker.py` | 安全检查进程 |
| `security/egress_checkpoint.py` | 出域检查点 |
| `security/header_detect.py` | 智能表头识别 |
| `security/listing_code_lane.py` | 代码车道 |
| `security/patterns.py` | 临床数据模式库 |
| `security/listing_workflow.py` | 工作流编排 |
| `security/spec_parser.py` | 规格解析 |

---


---

## 七、详细代码流程

### 7.1 开关启用时的完整数据流

```
1. 用户请求
   ↓
2. llm/stream 钩子触发
   ├── policy.isEnabled() → true
   ├── maskTrustedDocuments() - 掩码信任文档
   ├── runtime.request(check_llm, payload)
   │   └── worker.py → egress_checkpoint.check_egress_v2()
   │       └── 检测 clinical data
   └── check.ok → yield* next() 或阻断
   ↓
3. 工具调用
   ├── listing_inspect/run_code/publish
   │   └── runtime.request(listing_*, context)
   │       └── worker.py → listing_code_lane.*
   └── 其他工具
       └── post-execute 钩子
   ↓
4. safeToolResult() 处理
   ├── planeOf() - 判定来源域
   ├── 凭据文件 → 阻断
   ├── spec/document → 信任放行
   ├── output → 表头提取 + EDC识别
   ├── data → 数据拦截 + 表头提取
   └── 其他 → 原样放行
   ↓
5. 工具结果返回
```

### 7.2 开关关闭时的当前行为

```
当前实现：
1. 用户请求
   ↓
2. llm/stream 钩子
   ├── policy.isEnabled() → false
   └── yield* next() - 直接放行 ⚠️
   ↓
3. 工具调用
   ├── listing_* → 仍注册，仍可调用
   └── 其他工具 → post-execute 跳过 ⚠️
   ↓
4. 问题：
   - llm/stream 无检查，数据可能出域
   - 工具结果无拦截，数据可能出域
   - 智能功能（表头提取）被跳过
```

### 7.3 期望的开关关闭行为

```
期望实现：
1. 用户请求
   ↓
2. 整个 DSH 系统静默
   ├── 无 llm/stream 钩子
   ├── 无 post-execute 钩子
   ├── 无 Listing 插件注册
   └── Harness 完全接管
   ↓
3. 效果：
   - 零拦截
   - 零智能功能
   - 零引导
   - Harness 自由推理
```

---

## 八、当前实现与需求差异

### 8.1 差异对照表

| 功能 | 当前实现 | 需求 | 差异 |
|------|----------|------|------|
| 开关关闭时 llm/stream | `yield* next()` | 静默（Harness接管） | ❌ 未静默 |
| 开关关闭时 post-execute | `return next()` | 静默（Harness接管） | ❌ 未静默 |
| 开关关闭时 Listing | 插件仍注册 | 插件不注册 | ❌ 未解耦 |
| 开关关闭时智能表头 | 被跳过 | 始终生效 | ❌ 未解耦 |
| 开关关闭时 EDC 识别 | 被跳过 | 始终生效 | ❌ 未解耦 |
| 开关关闭时模板规范 | 被跳过 | 始终生效 | ❌ 未解耦 |

### 8.2 重构目标

```
┌─────────────────────────────────────────────────────────────────┐
│                      重构目标                                    │
│                                                                  │
│  Policy (保持不变)                                               │
│  ├── isEnabled() → 总开关                                       │
│  └── setEnabled() → 状态切换                                    │
│                              │                                   │
│                              ▼                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Index.js                                │  │
│  │                                                            │  │
│  │  if (!policy.isEnabled()) {                               │  │
│  │    return () => {};  // 整个系统静默                        │  │
│  │  }                                                        │  │
│  │                                                            │  │
│  │  // 开关启用时：注册所有组件                                │  │
│  │  registerBranding();                                       │  │
│  │  registerClinicalListingPlugin();                         │  │
│  │  registerHooks();  // post-execute + llm/stream           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  效果：                                                          │
│  - 开关启用 → 数据拦截 + 智能功能 + 流程引导                     │
│  - 开关关闭 → 整个 DSH 系统静默，Harness 完全接管                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 九、总结

### 9.1 当前架构优点

1. **模块化设计**：各组件职责清晰
2. **双车道架构**：快车道（check_llm）与重车道（listing_*）隔离
3. **智能表头识别**：评分式算法成熟
4. **EDC 字段映射**：已有 Medidata/Oracle/VEVA 支持
5. **Listing 代码车道**：安全约束到位

### 9.2 当前架构问题

1. **开关过于笼统**：单一开关控制整个系统
2. **智能功能未解耦**：与数据拦截耦合
3. **关闭时不完整静默**：仍有组件残留

### 9.3 重构方向

1. **Policy 保持不变**：单一 `isEnabled()` 开关
2. **Index.js 关键改动**：开关关闭时返回空 dispose
3. **智能功能始终生效**：在开关启用时完整工作
4. **Harness 完全接管**：关闭时无任何 DSH 干预

