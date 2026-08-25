# dsh-guard 全仓限制审计与拆除方案

日期：2026-08-25
范围：`dsh-clinical-data-guard/security/**`（23 个 py）、`src/**`（6 个 js）、`.trae/**`、`.dsh/profiles/clinical/**`
目标：**只保留"临床数据出域拦截"。其余一切限制交还 harness 驱动 AI 自主推理。**

---

## 0. 结论摘要

审计出 **147 个限制点**，分类结果：

| 分类 | 定义 | 数量 | 处置 |
|---|---|---|---|
| **A** | 数据出域拦截（真实数据值/凭据进入模型上下文） | 42 | 保留，但受总开关门控 |
| **B** | 安全沙箱必需（防恶意代码执行、路径逃逸、zip bomb） | 31 | 保留最小集，其中 12 项可降级 |
| **C** | 与数据安全无关的额外限制 | **74** | **应删除或放宽** |

三条实测报错的根因**全部落在 C 类**，且**都不是"沙箱模式必须"**：

| 实测报错 | 根因位置 | 是否数据安全必需 |
|---|---|---|
| `security worker request timeout after 120000ms` | `src/index.js:20` `HOOK_TIMEOUT_DEFAULT_MS` + worker **单进程串行队列** | 否。架构缺陷伪装成安全限制 |
| 文件锁 | `security/audit_log.py:35` `_exclusive_lock` + Windows `msvcrt.LK_LOCK` 阻塞 10s | 否。审计日志并发写的实现选择 |
| 有密码文件不能推理解密 | `security/archive_passwords.py:114` 候选耗尽即硬拒 | 否。**恰恰相反：它阻止了 AI 推理** |

**最严重的架构性发现**：当前**没有一个真正的总开关**。存在三套语义重叠、作用域不同的开关（`DATA_INTERCEPTION_ENABLED` / `mode` / `localDataAccess`），关掉任意一个都不能达成"完全交给 harness 驱动 AI 自主推理"。且 Python 侧的 C 类限制（预算、超时、格式校验、密码拒绝）**完全不受任何开关门控**——关掉拦截通道后它们照样拦。

---

## 1. 开关现状：为什么"关掉拦截"关不掉限制

### 1.1 三套开关的实际作用域

| 开关 | 定义位置 | 默认 | 关闭后仍然生效的限制 |
|---|---|---|---|
| `DATA_INTERCEPTION_ENABLED` | [branding.js:6-17](file:///g:/home/dsh-guard/dsh-clinical-data-guard/src/branding.js#L6-L17)，消费于 [index.js:668-672](file:///g:/home/dsh-guard/dsh-clinical-data-guard/src/index.js#L668-L672) | **开** | Python 侧全部 C 类：预算、超时、密码拒绝、格式校验、AST 黑名单、文件锁 |
| `mode`（enforce/shadow/disabled） | [index.js:342-353](file:///g:/home/dsh-guard/dsh-clinical-data-guard/src/index.js#L342-L353)，bundle 写死 `enforce`（[cordis.patch.yml:5](file:///g:/home/dsh-guard/dsh-clinical-data-guard/cordis.patch.yml#L5)） | `enforce` | 只关 post-execute 投影一层；quickGuard / pre-execute / llm-stream 三层照旧 |
| `localDataAccess` | [index.js:364-367](file:///g:/home/dsh-guard/dsh-clinical-data-guard/src/index.js#L364-L367) | `disabled` | 不是拦截开关，是**能力开关**：非 `uat-local` 时 listing 工具**根本不注册** |

### 1.2 门控覆盖缺口（核心问题）

`DATA_INTERCEPTION_ENABLED=0` 时，仅 JS 侧四层钩子跳过。以下限制**无任何开关可关**：

- `listing_budget.py` 200 run / 50 publish 预算
- `code_sandbox.py` 64KB 代码上限、30000 AST 节点、语法错误拒绝
- `archive_passwords.py` 密码候选耗尽硬拒
- `path_policy.py` 凭据 16KB / 单行限制
- `listing_plan.py` 全部 47 条契约校验
- `audit_log.py` 文件锁
- `HOOK_TIMEOUT_DEFAULT_MS` 及各级超时

只有 `code_sandbox.check_code`（[L94-95](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/code_sandbox.py#L94-L95)）和 `egress_checkpoint`（[L105](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/egress_checkpoint.py#L105)）读了 `DATA_PROTECTION_ENABLED`，覆盖率约 3%。

---

## 2. 三条实测报错逐条根因

### 2.1 `security worker request timeout after 120000ms`

调用链：`src/index.js` 钩子 → `sendRequest()` → 单个常驻 worker stdin/stdout → Python `worker.main()` **串行 while 循环**。

- 超时值定义 [index.js:20](file:///g:/home/dsh-guard/dsh-clinical-data-guard/src/index.js#L20) `HOOK_TIMEOUT_DEFAULT_MS = 120_000`；另有 [L14](file:///g:/home/dsh-guard/dsh-clinical-data-guard/src/index.js#L14) `REQUEST_TIMEOUT_DEFAULT_MS = 30_000`
- 覆写入口 `hookTimeoutMs(config)` [L431-435](file:///g:/home/dsh-guard/dsh-clinical-data-guard/src/index.js#L431-L435)，可用 `EMERALD_HOOK_TIMEOUT_MS`
- 触发点 [L225-249](file:///g:/home/dsh-guard/dsh-clinical-data-guard/src/index.js#L225-L249)：超时后若无其他在途请求则重启 worker
- **真正根因不是超时值太小**，而是 worker 单进程串行：`listing_inspect` / `listing_run_code` / `listing_publish` 是分钟级计算（sandbox 默认 300s、publish 600s），期间任何一个 quickGuard 钩子请求都在排队，钩子的 120s 预算被前面的长任务吃掉。
- 结论：**C 类**。数据安全不需要"钩子必须 120s 内返回"。

### 2.2 文件锁

`security/audit_log.py` `_exclusive_lock` [L35-64](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/audit_log.py#L35-L64)：

- 锁文件 `.audit.lock`；POSIX `fcntl.flock(LOCK_EX)`，Windows `msvcrt.locking(fd, LK_LOCK, 1)`——**LK_LOCK 阻塞重试约 10 秒后抛 OSError**
- 三处使用点：`write_audit_record` [L125](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/audit_log.py#L125)、`egress_authz.authorize_category` [L100](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/egress_authz.py#L100)、`egress_authz.consume_category` [L141](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/egress_authz.py#L141)
- 锁内做了"轮转 → 清理旧归档 → 追加 → fsync"四件事，持锁时间被放大
- 审计写入本身已用 `O_APPEND` + fsync（[L67-75](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/audit_log.py#L67-L75)），单行追加在两个平台上都是原子的，**锁只对"轮转"必需**
- 结论：**C 类**。可将锁缩到仅轮转路径，并把 OSError 降级为 warn 不阻断主流程。

### 2.3 有密码文件不能推理解密

`security/archive_passwords.py`：

- `password_candidates` [L27-75](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/archive_passwords.py#L27-L75)：从项目名、去符号变体、逐段前缀、sidecar 文件、归档名分词、项目内其他文件名 token 生成候选
- sidecar 读取上限 `MAX_SIDECAR_BYTES=256` / `MAX_SIDECAR_LINE_CHARS=128`（[L14-15](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/archive_passwords.py#L14-L15)）——超限**静默跳过**，AI 完全看不到"密码文件存在但被忽略"
- `extract_dataset_archive` [L78-114](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/archive_passwords.py#L78-L114)：候选全部失败 → `raise PathPolicyError("archive password is unavailable or invalid")`
- 这条文案**不含任何可行动信息**：没告诉 AI 试了哪些候选、sidecar 在哪、可以用什么通道补凭据
- 结论：**C 类，且方向相反**。它不是在保护数据，是在阻断 AI 推理。

---

## 3. C 类限制全清单（74 条，按文件）

### 3.1 `listing_budget.py` — 迭代次数硬限（4 条）

| 位置 | 限制 | 报错文案 |
|---|---|---|
| [L35](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_budget.py#L35) | `DEFAULT_MAX_EXECUTIONS = 50` | — |
| [L82](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_budget.py#L82) | `DEFAULT_MAX_CODE_RUNS = 200` | — |
| [L127-128](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_budget.py#L127-L128) | `charge_code_run` 超限 | `listing code run budget for this session and project is exhausted` |
| [L171-173](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_budget.py#L171-L173) | `charge_execution` 超限 | `listing execute budget for this session and project is exhausted` |

机制本身（限频抑制"存在性预言机"推断通道）属 A，但**数值 50/200 与硬拒姿态属 C**。代码注释自承"接受该通道"。AI 迭代调试列表代码，200 次 run 在复杂项目上不够用，且用尽后无任何恢复路径。

### 3.2 `code_sandbox.py` — 代码体量与语法（5 条）

| 位置 | 限制 | 报错文案 |
|---|---|---|
| [L31](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/code_sandbox.py#L31) | `MAX_CODE_CHARS = 65536` | `code exceeds the size limit` |
| [L32](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/code_sandbox.py#L32) | `MAX_AST_NODES = 30000` | `code is too complex` |
| [L80-121](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/code_sandbox.py#L80-L121) | 空代码 | `code is empty` |
| 同上 | 语法错误 | `code has a syntax error` |
| [L159](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/code_sandbox.py#L159) | `timeout_seconds=300.0` | `sandbox execution exceeded {n}s and was terminated` |

语法错误应当**原样回传 SyntaxError 的行列与文案**让 AI 自行修，而非归入"违规"。

### 3.3 `ai_operations_monitor.py` — 最大误伤源（9 条）

| 位置 | 限制 | 问题 |
|---|---|---|
| [L413-421](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/ai_operations_monitor.py#L413-L421) | 语法错误 → MEDIUM **BLOCK**，文案`代码语法错误（可能是攻击尝试）` | **最严重**：AI 写错一个括号被判定为攻击 |
| [L464-572](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/ai_operations_monitor.py#L464-L572) | `getattr` → CRITICAL BLOCK | pandas 动态取列的常规写法被封 |
| 同上 | `pd.read_*` 路径含 `expected` / `.pkl` → HIGH BLOCK | 字符串匹配，误伤合法文件名 |
| [L72-81](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/ai_operations_monitor.py#L72-L81) | `DANGEROUS_TOOLS` 名单 | 与沙箱重复 |
| [L84-126](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/ai_operations_monitor.py#L84-L126) | `DANGEROUS_BASH_PATTERNS` | 与沙箱重复 |
| [L137-143](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/ai_operations_monitor.py#L137-L143) | `DANGEROUS_PATH_PATTERNS` | 与 path_policy 重复 |
| [L151-154](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/ai_operations_monitor.py#L151-L154) | `DANGEROUS_CODE_PATTERNS` | 与 code_sandbox 重复 |
| [L166-199](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/ai_operations_monitor.py#L166-L199) | `check_tool_call` risk≥HIGH 即 raise | 无 shadow 模式 |
| [L248-259](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/ai_operations_monitor.py#L248-L259) | `check_local_data_policy` 已 no-op | 死代码 |

整个模块与 `code_sandbox` + `path_policy` **职责完全重叠**，是"启发式二次拦截"，不提供任何出域保护。

### 3.4 `listing_plan.py` — 契约校验（约 30 条 C，共 47 条）

| 位置 | 限制 | 分类 |
|---|---|---|
| [L30-31](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_plan.py#L30-L31) | `MAX_OUTPUTS=64` / `MAX_ITEMS_PER_OUTPUT=256` | B（DoS） |
| [L39-46](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_plan.py#L39-L46) | `_is_formula` 公式前缀拦截 | **A**（注入） |
| [L76-80](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_plan.py#L76-L80) | `_identifier` 正则 `^[A-Za-z_][A-Za-z0-9_]{0,127}$` | B（核心契约） |
| [L146-203](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_plan.py#L146-L203) | `_validate_report_output_contract` **6 条重名校验** | **C** |
| [L206-235](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_plan.py#L206-L235) | `_require_medical_provenance` 2 条 | **C**（spec 合规硬编码） |
| [L238-428](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_plan.py#L238-L428) | `EMPTY_PLAN` / `EMPTY_OUTPUT` / sort / layout / arity / separator 长度 | **C** |
| 同上 | `当前执行器只支持中文标题` | **C**（最不合理的一条） |

这些是**业务正确性校验**，不是安全边界。正确做法是把违规降级为**结构化警告**回传给 AI，让 AI 自己修计划后重试，而不是 raise 掉整轮。

### 3.5 `path_policy.py` — 凭据与目录（4 条 C）

| 位置 | 限制 | 报错文案 |
|---|---|---|
| [L79-85](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/path_policy.py#L79-L85) | 凭据文件 >16KB 拒绝 | `credential file exceeds the local policy limit` |
| [L88-100](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/path_policy.py#L88-L100) | 凭据必须单行 | `credential reference must contain one non-empty line` |
| [L123-204](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/path_policy.py#L123-L204) | 解压目录必须为空 | `managed extraction directory is not empty` |
| [L31-34](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/path_policy.py#L31-L34) | zip bomb 四阈值 | B，保留 |

`resolve_under_root` [L37-66](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/path_policy.py#L37-L66) 的 7 条 raise 属 A/B，**必须保留**。

### 3.6 `sandbox_runner.py` — 输出形状限制（5 条 C）

| 位置 | 限制 |
|---|---|
| [L22-25](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/sandbox_runner.py#L22-L25) | `MAX_OUTPUTS=64` / `MAX_COLUMNS=512` / `MAX_NAME_CHARS=64` / `MAX_AVAILABLE_HINT=50` |
| [L109-134](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/sandbox_runner.py#L109-L134) | 扩展名白名单 `unsupported file format: {suffix}` |

`set_allowed_dirs` [L49-56](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/sandbox_runner.py#L49-L56) 与 `_validate_path` [L67-88](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/sandbox_runner.py#L67-L88) 是 **A 类白名单契约，必须保留**。

### 3.7 其余 C 类（按文件汇总，17 条）

| 文件 | 位置 | 限制 |
|---|---|---|
| `data_egress_guard.py` | [L399-401](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/data_egress_guard.py#L399-L401) | `max_rows=200` xlsx 扫描行数上限 |
| 同上 | [L459-461](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/data_egress_guard.py#L459-L461) | 行文本截断 300 字符 |
| `listing_inspector.py` | [L91-93](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_inspector.py#L91-L93) | `_SUPPORT_MAX_ROWS=2000` / `_MAX_COLUMNS=256` / `_MAX_CELL_CHARS=512` |
| 同上 | [L70-85](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_inspector.py#L70-L85) | `SCENARIO_AMBIGUOUS` 硬拒（应回传候选让 AI 选） |
| `spec_parser.py` | [L23-30](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/spec_parser.py#L23-L30) | `MAX_SHEETS=64` / `MAX_DEFINITIONS=10000` / `MAX_CELL_CHARS=512` 等 6 条 |
| `listing_code_lane.py` | [L38-39](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_code_lane.py#L38-L39) | run 300s / publish 600s 超时 |
| 同上 | [L48-55](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_code_lane.py#L48-L55) | `_scrub` 报错截断 128 字符——**AI 看不到完整 traceback** |
| `worker.py` | [L312-344](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/worker.py#L312-L344) | `inspect_file` 扩展名过滤 |
| `project_profile.py` | 多处 | 字段长度上限（fail-safe 回退，影响小） |
| `listing_executor.py` | 多处 | 中文标题/布局正确性校验 |

`_scrub` 截断 128 字符是**仅次于语法错误 BLOCK 的第二大误伤**：AI 拿不到完整异常，只能盲猜。
