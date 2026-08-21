# Emerald Clinical / Clinical Listing 全量审计基线

**文档版本**: 1.0  
**基准日期**: 2026-08-19  
**审计对象**: `G:\home\dsh-guard` 当前文件状态  
**插件版本**: `emerald-clinical-data-guard@1.0.4`  
**DSH 版本**: `@deepseek-ai/dsh@0.1.0-rc.6`  
**文档用途**: 供第三方审计工具或审计团队复核需求完整性、代码真实性、测试交付和数据红线。  
**当前总评**: `FAIL for release approval`。已测试的主路径和绕过矩阵通过，但存在未闭环的 P1 安全与交付缺口；不能把测试通过解释为“全部红线无条件守住”。

> 本文只记录事实和可复核证据，不把开发计划当作已发生事实。`.env`、`.env.china`、`var/` 可能包含凭据或运行审计数据，本文只记录存在性，不复制内容。

## 1. 审计结论摘要

### 1.1 已证明的部分

- 架构已改为标准 DSH/Cordis 插件：入口为 `dsh-clinical-data-guard/src/index.js`，声明 `inject=["tools","llm","webServer"]`，通过 `ctx.tools.guard`、`tools/pre-execute`、`tools/post-execute`、`llm/stream`、`webServer.tapIndex/register` 接入。
- 未发现外置 HTTP proxy、旧 `proxy.js`、旧 Node-Python checkpoint 或 `node_modules` 内补丁残留。
- DSH runtime、clinical profile、Python `.venv`、npm/pip/pnpm 缓存均按脚本设计落在项目目录；Node/Python 由系统提供，缺失时脚本终止并提示安装。
- 模型出域检查覆盖官方 `GenerateOptions` 的可序列化字段，本地 `signal` 被剥离；干净请求写入 canonical SHA-256 指纹，敏感请求在 `next()` 前阻断。
- UI 白标通过官方 `webServer` 扩展完成，HTTP 实测标题、manifest、favicon 均为 Emerald Clinical。
- 当前总回归、变异测试、项目契约、启动检查和安装态冒烟全部通过。

### 1.2 未闭环的审计发现

| 编号 | 等级 | 问题 | 影响 | 最小修复方向 |
|---|---:|---|---|---|
| AF-01 | P1 | `tools/post-execute` 只有工具名包含 `read` 时才进入结果替换；非 `read` 且无路径的工具结果会原样接受。审计用合成样本 `fetch_database` 复现原值通过。 | 违反“无路径工具结果强制脱敏”的规范口径；临床值可先进入本地会话和工具结果材料化路径，后续只能依赖模式识别兜底。 | 取消按工具名包含 `read` 的白名单；所有未被文件类型明确处置的工具结果强制 `scrub_text`，并加入非 `read` 工具名的 BY 用例。 |
| AF-02 | P1 | 完整请求递归扫描未扫描任意对象键名；`payload_fields` 还把顶层键名原文写入审计。合成顶层键 `A1234567` 被允许且出现在审计中。 | 键名本身携带受试者编号时可绕过扫描并违反 R-6“审计不得包含临床数据值”。 | 键名进入同一 DLP 递归扫描；审计字段使用已知 `GenerateOptions` 字段白名单，未知字段记录哈希或 `UNKNOWN:<n>`。 |
| AF-03 | P2 | `.gitignore` 忽略 `.dsh/profiles/clinical/*` 且只恢复 `cordis.yml`，导致 profile `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 不会被提交。 | 其他人克隆后 `start.ps1` 会因缺少 lockfile 失败，一键企业交付不可复现。项目当前不是 Git 仓库，无法用历史证明这些文件曾提交。 | 调整 ignore 规则，提交 profile 清单和锁文件；在干净目录执行一键启动验收。 |
| AF-04 | P2 | `.xls` 由 `openpyxl` 处理，但 `openpyxl` 不支持传统 `.xls`；当前实际结果是 `CHECK_FAILED` fail-closed，不是“输出表头结构”。 | `.xls` 功能需求未完整交付，虽然安全侧没有放行。 | 引入支持 `.xls` 的受控解析器，或在需求中明确 `.xls` 仅 fail-closed 不支持。 |
| AF-05 | P2 | worker 异常将 `str(exc)` 原样返回，Node 拒绝理由也可能拼接 `error.message`；错误文本可能含本地路径或数据片段。 | R-6 对错误回执的零数据要求没有闭环。 | worker 只返回稳定枚举错误码和哈希；Node 端拒绝理由不拼接底层异常文本。 |
| AF-06 | P2 | 主规范 NFR-5 仍写“9 个变异点”，当前实际是 10 个。 | 文档漂移会误导审计基线。 | 将主规范同步为 10/10，并建立变异数量与文档断言。 |
| AF-07 | P3 | `tests/e2e/temp_check.py` 是临时诊断脚本，无正式测试入口。 | 企业代码清洁度残留。 | 删除或改造为带断言的正式测试。 |
| AF-08 | P3 | `registerBranding` 在缺少 `webServer` 服务时静默 no-op。当前 `inject` 保证服务存在，所以主路径不受影响。 | 测试替身或非标准宿主下可能误以为白标已启用。 | 缺少官方服务时启动失败或记录不可屏蔽的错误。 |

### 1.3 审计盲点

- 当前目录不是 Git 仓库，无法审计变更历史、作者、分支、提交完整性或用户未提交修改。
- 未向真实外部模型 provider 发送请求；所有模型链路使用本地 fake adapter / async generator 验证。
- 未执行长期并发、多用户、重启恢复、磁盘满、审计归档恢复和崩溃恢复压测。
- 未在本轮重新生成覆盖率产物；NFR-4 只能引用开发计划中的历史 `trace` 记录。
- 未执行在线依赖漏洞审计；需要网络和官方 advisory 源。
- 未验证 Windows ACL、审计文件所有权、备份策略和法定留存周期，只验证代码中的 0700/0600 与轮转逻辑。
- 多 Agent 同步开发只存在于开发计划记录，仓库中没有可复核的 agent 执行日志，不能作为强交付证据。

## 2. 系统定位与不可变架构裁定

### 2.1 业务定位

Emerald Clinical Data Guard 面向临床试验 Listing 场景，在本地 DSH 工作台中执行临床数据识别、脱敏、审批、阻断和审计。目标是在不修改 DSH 官方插件的前提下，阻止临床数据行、SAS 数据、Excel/CSV 数据区和敏感模型请求字段出域。

### 2.2 架构红线

| 编号 | 裁定 | 当前实现 | 状态 |
|---|---|---|---|
| ARCH-1 | 唯一业务扩展形态是标准 DSH/Cordis 插件 | `dsh-clinical-data-guard` 独立包，`cordis.patch.yml` 插入 layer | PASS |
| ARCH-2 | 不修改 DeepSeek Harness 原有插件 | 插件源码独立；契约测试禁止旧 proxy/checkpoint | PASS，需第三方用 lockfile 校验 runtime 完整性 |
| ARCH-3 | 不修改 `runtime/node_modules` 源码 | 未发现项目文件直接写入 `node_modules`；无 patch 文件 | PASS，无 Git 基线是审计盲点 |
| ARCH-4 | 不使用外置 HTTP proxy | 无监听 3081 或 proxy 入口；插件随 DSH Web UI 运行 | PASS |
| ARCH-5 | 本地部署，Web UI 为 `127.0.0.1:3080` | `start.ps1` 和运行时实测 | PASS |
| ARCH-6 | `DSH_HOME` 在项目 `.dsh` | `start.ps1` 设置 `$Root\.dsh` | PASS |
| ARCH-7 | runtime/profile/venv/cache 在项目内 | `.venv`、`.cache`、`.pnpm-store`、`runtime/`、`.dsh/profiles/clinical` | PASS |
| ARCH-8 | Node/Python 使用系统环境，不携带便携运行时 | 检测 `node`、`npm`、`python`/`py`，缺失即终止；`.tools` 不存在 | PASS |
| ARCH-9 | 前端依赖使用 pnpm，已有包优先复用 | `pnpm install --frozen-lockfile --prefer-offline --store-dir .pnpm-store` | PASS |
| ARCH-10 | 缺 pnpm 时自动安装固定版本 | `npm install --global pnpm@11.19.0`；这是系统工具安装，项目依赖仍在项目内 | PASS |
| ARCH-11 | 企业交付不留旧方案 | 旧 proxy/checkpoint、未接线 SSO/SIEM/沙箱/租户模块未发现 | PASS，存在少量临时测试与运行数据 |
| ARCH-12 | Git 拉取后可一键启动 | 脚本逻辑满足，但 `.gitignore` 会漏提交 profile 锁文件 | FAIL，见 AF-03 |

### 2.3 插件扩展点

| 扩展点 | 代码位置 | 行为 | 返回契约 |
|---|---|---|---|
| `ctx.tools.guard` | `src/index.js:140` | 工具参数 Node DLP 快速初筛 | 命中返回 string reason，未命中返回 `undefined`，符合 DSH `ToolGuard` 类型 |
| `tools/pre-execute` | `src/index.js:149` | Python worker 检查危险操作；Excel L3 审批预检；审批通过写授权 | `{kind:'deny'}` 或 `next()` |
| `tools/post-execute` | `src/index.js:200` | enforce 模式按工具 output schema 安全替换模型可见 content；SAS/ZIP/Excel/CSV/无路径结果处置；不对任意工具通用替换 canonical value | `{kind:'accept', content}` 或 `next()` |
| `llm/stream` | `src/index.js:209` | 校验消息形态，剥离本地 `signal`，完整 `GenerateOptions` 送 Python 检查，敏感时在 `next()` 前抛错 | async generator，`yield* next()` |
| `webServer.tapIndex/register` | `src/branding.js:81` | 标题、application-name、动态文本、manifest、favicon 白标 | 官方 disposer |

官方 `GenerateOptions` 契约来自 `runtime/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts:312`，包含 `provider`、`model`、`reasoningEffort`、`messages`、`system`、`tools`、`temperature`、`maxTokens`、`stop`、`signal`、`sessionId`、`purpose`。`signal` 是本地取消信号，扫描前剥离。

## 3. 需求总控清单

### 3.1 数据红线 R-1..R-6

| 红线 | 需求 | 实现位置 | 自动化证据 | 当前状态 |
|---|---|---|---|---|
| R-1 | `.sas7bdat` 行内容不得进入 LLM 消息，只允许元数据占位 | `tool-result-guard.js:77` 返回 `SAS_DATA`；`ai_operations_monitor.py` 阻断读取 SAS | `test_extension_registration_and_sas_denial`、BY-10、mutation `sas-extension` | PASS for tested paths |
| R-2 | Excel/CSV 数据区不得进入 LLM 消息，只允许表头结构 | `safeToolResult` + `excel_header_extractor.py` | `test_excel_post_execute_keeps_headers_only`、BY-6/7/8 | PARTIAL：`.xls` 仅 fail-closed；非 `read` 工具结果绕过 post 处置，见 AF-01/04 |
| R-3 | 用户或模型指令不能覆盖安全处置 | 配置只来自 profile/env；`disabled` 必须有审批 ID 和审批人；消息内容不改变策略 | `test_non_text_and_invalid_messages_fail_closed`、配置校验代码 | PASS |
| R-4 | base64、图片、非核心 content block、畸形消息默认拒绝 | `validateMessageShape` + Python base64 递归扫描 | BY-1/2/3/4、mutation `base64-boundary` | PASS |
| R-5 | 无后门开关；`disabled` 必须审批 | `validateConfig` | 契约测试静态检查；未发现消息内关闭通道 | PASS |
| R-6 | 日志、审计、错误回执不得包含临床数据值、凭据或原始身份 | audit/authz 上下文哈希；威胁 evidence 占位；错误路径部分脱敏 | `clean_model_request_audit_keeps_only_fingerprint`、`ai_operation_audit_has_no_raw_filename_or_identity`、`authorization_stores_no_raw_values` | PARTIAL：任意顶层键名可入审计，worker 异常可携带原文，见 AF-02/05 |

### 3.2 验收 AC-1..AC-14

| AC | 需求口径 | 证据 | 状态 |
|---|---|---|---|
| AC-1 | dirty LLM stream 抛错并包含 audit id | `test_llm_clean_streams_and_dirty_blocks` | PASS |
| AC-2 | 非文本与非法 content block fail-closed | `test_non_text_and_invalid_messages_fail_closed`、BY-1/2 | PASS |
| AC-3 | 插件侧消息结构校验等价替代旧 proxy body 校验 | 同 AC-2；无外置 proxy | PASS |
| AC-4 | Excel 伪装表头绕过被阻断 | BY-6 | PASS |
| AC-5 | 横向 Excel 首列绕过被阻断 | BY-7 | PASS |
| AC-6 | worker 缺失 fail-closed | `test_missing_python_worker_fails_closed`、BY-9 | PASS |
| AC-7 | shadow 模式观察不阻断 | `test_shadow_mode_observes_without_blocking_llm` | PASS |
| AC-8 | 数值受试者号绕过被阻断 | BY-8 | PASS |
| AC-9 | 总回归全绿 | `tests/run_all.py` 当前 `TOTAL_FAILED_SUITES=0` | PASS |
| AC-10 | manifest、patch、export、inject、五个扩展点接线 | `test_plugin_contract` | PASS |
| AC-11 | L3 三选项、位置、模式、证据与授权留痕 | L3 prompt + approval 测试 | PASS |
| AC-12 | 无路径工具结果脱敏并出现 `[DATE]` 等占位 | `test_no_path_tool_result_is_scrubbed`、BY-12 | PARTIAL：测试工具名含 `read`，非 read 路径未覆盖，见 AF-01 |
| AC-13 | `system` 等辅助字段敏感命中在 adapter 前阻断 | `test_full_model_request_scope_blocks_and_audits_clean_requests` | PASS |
| AC-14 | 干净完整请求的 canonical SHA-256 与审计指纹一致 | 同 AC-13 测试 | PASS |

### 3.3 绕过矩阵 BY-1..BY-12

| 编号 | 场景 | 断言 | 当前结果 |
|---|---|---|---|
| BY-1 | base64 临床载荷 | 解码后递归扫描并阻断 | PASS |
| BY-2 | image content block | 消息形态校验拒绝 | PASS |
| BY-3 | 畸形 messages | fail-closed | PASS |
| BY-4 | 非 messages 载荷 | 完整请求扫描覆盖 | PASS |
| BY-5 | 上下文豁免绕过 | `101-001234` 复合信号阻断 | PASS |
| BY-6 | 全字符串伪装 Excel 表头 | 数据原值不返回 | PASS |
| BY-7 | 横向 Excel 首列 | 数据原值不返回 | PASS |
| BY-8 | 数值受试者号 | 字符串化后识别，不返回原值 | PASS |
| BY-9 | worker 缺失 | pre-execute deny | PASS |
| BY-10 | pickle 别名、base64 shell、SAS 命令混淆 | 危险操作阻断 | PASS |
| BY-11 | 零宽字符受试者号 | 归一化后阻断 | PASS |
| BY-12 | 无路径工具结果 | 测试样本脱敏 | PARTIAL：仅覆盖工具名含 `read` 的路径，见 AF-01 |

### 3.4 非功能 NFR-1..NFR-9

| NFR | 需求 | 当前证据 | 状态 |
|---|---|---|---|
| NFR-1 | 正常出境检查 <10ms | `normal_request_is_fast` 通过 | PASS，单机当前样本 |
| NFR-2 | 正常请求误拦率 <1% | 5 类样本 x20，共 100 个，零误拦 | PASS，合成集有限 |
| NFR-3 | clean/dirty 100% 审计 | `every_request_is_audited_without_raw_values` | PASS |
| NFR-4 | 安全模块覆盖率 >=90% | 开发计划记录历史 trace 行覆盖 100%；本轮未重新生成覆盖率 | UNVERIFIED for current baseline |
| NFR-5 | 变异杀死率 >95% | 当前 10/10，100% | PASS；主规范仍写 9，见 AF-06 |
| NFR-6 | 10MB 轮转、最多 5 归档 | `audit_rotation_has_disk_cap`；代码常量 10MB/5 | PASS |
| NFR-7 | 不新增监听端口 | 标准插件形态；无 proxy 端口 | PASS |
| NFR-8 | 完整模型请求字段覆盖 | `system/tools/stop` 测试与干净请求字段指纹 | PARTIAL：任意键名未扫描，见 AF-02 |
| NFR-9 | 出域审计只保存指纹和脱敏摘要 | 干净请求原文缺失断言 | PARTIAL：顶层未知键名可原文进入 `payload_fields`，见 AF-02 |

### 3.5 UI 品牌需求 UI-BR-1..UI-BR-4

| 编号 | 需求 | 实现 | 证据 | 状态 |
|---|---|---|---|---|
| UI-BR-1 | Web title/application-name 为 Emerald Clinical | `brandHtml` | 品牌驱动测试 + HTTP `/` | PASS |
| UI-BR-2 | PWA name/short_name 为 Emerald Clinical/Emerald | `brandManifest` | 驱动测试 + HTTP manifest | PASS |
| UI-BR-3 | favicon 使用 Emerald 资产且无 DeepSeek 标识 | `assets/branding/favicon.svg` | 驱动测试 + HTTP favicon | PASS |
| UI-BR-4 | 可见 DeepSeek/DSH 动态替换，且只用官方 webServer 扩展 | MutationObserver + `tapIndex/register` | 驱动测试断言脚本与 disposer | PASS |

HTTP 实测还显示宿主 boot 插件 URL 仍包含 `@deepseek-ai/*` 技术包名。这是底层依赖标识，不是可见品牌文本；若企业要求网络响应中完全无 DeepSeek 字符串，需要另行提升为需求。

### 3.6 一键启动与企业交付需求

| 需求 | 实现 | 证据 | 状态 |
|---|---|---|---|
| 系统检测 Node >=24 | `start.ps1:63` | 当前 `start.ps1 -Check` PASS | PASS |
| 系统检测 Python >=3.10 | `start.ps1:70` | 同上 | PASS |
| 不携带便携 Node/Python | `.tools` 不存在，脚本无下载 runtime | 项目契约 | PASS |
| DSH runtime 按锁文件安装 | `npm ci --prefix runtime` + hash stamp | 启动检查输出 Already up to date | PASS |
| Python 依赖项目内 `.venv` | `python -m venv .venv` + requirements | `openpyxl==3.1.5` | PASS |
| npm/pip cache 项目内 | `.cache/npm`、`.cache/pip` | 脚本环境变量 | PASS |
| pnpm store 项目内 | `.pnpm-store` | `--store-dir` | PASS |
| 缺 pnpm 自动安装 11.19.0 | `npm install --global pnpm@11.19.0` | 脚本与当前 pnpm 输出 | PASS |
| 已有依赖不重复下载 | runtime hash stamp；pnpm `--prefer-offline` | `Already up to date` | PASS |
| profile 使用相对 link | `link:../../../dsh-clinical-data-guard` | profile manifest/lock | PASS |
| 启动后打开 Web UI | 等待 200 后 `Start-Process` | 当前服务 HTTP 200 | PASS |
| Git 分发可复现 | 依赖 profile package/lock 提交 | `.gitignore` 实际会忽略它们 | FAIL，AF-03 |

注意：`pnpm` 是系统级工具，缺失时按用户要求自动全局安装；这不改变项目依赖和 store 的项目内位置。

### 3.7 用户补充需求追踪

| 来源需求 | 当前落点 | 证据 | 状态 |
|---|---|---|---|
| 必须采用 DeepSeek Harness/DSH 插件模式，不修改官方插件 | 独立 `emerald-clinical-data-guard` + 官方扩展点 | 插件契约、安装态、官方类型定义 | PASS |
| 企业开发不保留旧形态，项目代码干净 | 删除外置 proxy、旧 checkpoint、便携 runtime、未接线模块 | 项目契约与文件盘点 | PASS with residues：`temp_check.py`、历史 `var/` 见 AF-07 |
| 需求功能必须全部满足 | 红线、AC、BY、NFR、UI、启动均有实现与测试 | 第 3、4、7 节 | PARTIAL：AF-01..AF-06 待闭环 |
| 本地 DSH，本地部署 | 项目 `.dsh` profile + `127.0.0.1:3080` | `start.ps1 -Check`、HTTP | PASS |
| runtime/profile/venv/cache 跟项目走，不写系统 C 盘 | `$PSScriptRoot` 派生全部项目内路径 | 启动脚本与项目契约 | PASS；pnpm 系统工具例外按需求 |
| Node/Python 检测系统环境，缺失提示安装，不带入项目 | Node >=24、Python >=3.10、`.tools` 不存在 | 启动脚本 | PASS |
| 一键启动、自动检测并安装项目依赖、启动 Web UI | runtime/profile/venv 按锁文件安装，打开 3080 | 当前启动检查与服务 | PARTIAL：干净 Git 克隆会缺 profile lock，AF-03 |
| 前端使用 pnpm，已有包不重复下载 | pnpm 11.19.0、frozen lock、prefer-offline、项目 store | 当前输出 Already up to date | PASS |
| 缺 pnpm 自动安装 | npm 全局安装固定版本 | 启动脚本 | PASS |
| 检测 LLM 发送给 AI 模型的所有数据 | 官方 `GenerateOptions` 除本地 `signal` 外递归扫描 | 完整请求集成测试与审计指纹 | PARTIAL：任意键名缺口 AF-02 |
| 多个智能算法与智能 AI 检测 | 模式库、复合威胁、分级脱敏、base64/Unicode、AI 操作/AST | 第 4.6、4.7 节与单元/BY/变异 | PASS for implemented rules |
| UI 将 DeepSeek/DSH 品牌替换为 Emerald Clinical | 官方 `webServer` 白标 + 动态 MutationObserver | 品牌测试与 HTTP | PASS |
| 回归测试与变异测试验收 | 总回归与 10 个 mutant | 当前执行记录 | PASS |
| workflow / 多 Agent 同步开发验收 | 开发计划记录契约复核、插件内核、安全算法、企业清理等并行工作流 | 无 agent 执行日志 | UNVERIFIED：只能作为过程说明，不能作为代码级交付证据 |

## 4. 功能模块清单

### 4.1 Cordis 插件入口

**Owner**: `dsh-clinical-data-guard/src/index.js`

| 功能 | 位置 | 详细行为 |
|---|---|---|
| Python worker 启动 | `SecurityRuntime` | 以配置的 Python 启动 `python -m security.worker`，line JSON 协议，requestId 关联请求 |
| worker 故障处置 | `SecurityRuntime` | spawn error、exit、非法 JSON、写入错误均 reject；上层 deny/throw |
| 配置校验 | `validateConfig` | mode 限 `enforce/shadow/disabled`；disabled 必须有 approvalId/approvedBy；maxScanRows 1..200 |
| 上下文构造 | `context` | 携带 mode、session/user、审批字段；审计侧哈希 |
| 模型载荷构造 | `modelRequestPayload` | 仅剥离本地 `signal`，其余字段进入扫描 |
| 消息形态校验 | `validateMessageShape` | messages 必须数组；content 必须 string 或 typed array；content block 仅 `text/reasoning/tool-call/tool-result` |
| 插件清理 | 返回 disposer | 反向释放 runtime、branding、guard、事件 |
| inject 声明 | `clinicalDataGuard.inject` | `tools`、`llm`、`webServer` |

### 4.2 工具输入守卫

**Owner**: `src/index.js:140`、`src/patterns.js`、`security/patterns.py`

- Node 端快速序列化 `exec.arguments` 并执行 DLP 子集。
- 命中返回 DSH 官方 guard reason 字符串。
- Python pre-execute 再执行危险工具、bash、路径、代码和操作链检查，双保险。

### 4.3 工具执行前防护

**Owner**: `src/index.js:149`、`security/worker.py:35`、`security/ai_operations_monitor.py`

操作序列：

1. Node 调 worker `check_tool`。
2. worker 调 `check_tool_call` 评估工具、bash、路径、Python 代码风险。
3. worker 不可用或返回不 ok 时，Node 返回 deny。
4. Excel 路径进入 `inspect_file`。
5. L3 数据存在且宿主有 `ctx.approval.request` 时展示三选项。
6. 仅 `allowed-once` 继续。
7. 继续前写 `L3_REDACTED_CONTINUE` 授权记录；写失败则 deny。

### 4.4 工具结果处置

**Owner**: `src/tool-result-guard.js`、`excel_header_extractor.py`

| 输入 | 当前处置 | 输出 | 状态 |
|---|---|---|---|
| `.sas7bdat` | 不读行，直接替换 | `DATA_BLOCKED/SAS_DATA` + 脱敏文件名 + 固定消息 | PASS |
| `.zip` | 不解压，直接替换 | `DATA_BLOCKED/ZIP_MAYBE_DATA` | PASS |
| `.xlsx` | openpyxl read_only + merged cells 预加载，输出结构 | `EXCEL_HEADERS_ONLY` | PASS |
| `.csv` | Python csv 扫描，输出结构 | `EXCEL_HEADERS_ONLY` | PASS |
| `.xls` | openpyxl 尝试解析；实际不支持传统格式 | `CHECK_FAILED` | 安全但功能不完整，AF-04 |
| 无扩展名且工具名含 `read` | `scrub_text` | 自动脱敏文本或 L3 提示 | PASS for tested |
| 无路径且工具名不含 `read` | 不进入 `shouldReplaceResult`，直接 `next()` | 原结果 | FAIL，AF-01 |
| Excel 提取失败 | fail-closed | `CHECK_FAILED` | PASS |
| 脱敏 worker 失败 | fail-closed | `BLOCKED` | PASS |

表头结构输出包含：sheet、orientation、header rows、data start row、total rows/cols、header cells、redacted in header、warnings。默认扫描 20 行，配置范围 1..200。

### 4.5 模型请求出域检查

**Owner**: `src/index.js:209`、`security/egress_checkpoint.py`

完整流程：

1. Node 校验消息形态。
2. 剥离 `signal`。
3. 将完整可序列化 `GenerateOptions` 送 worker `check_llm`。
4. Python 递归扫描 dict/list/string。
5. 识别 CDISC、受试者、日期、医学编码、术语聚集、SAS 域和复合威胁。
6. 归一化零宽字符和编号内空白。
7. 解码可完整解码且 UTF-8 可读的 base64，并递归扫描。
8. enforce 下 BLOCK 威胁抛 `EgressViolation`。
9. clean/shadow/disabled 写审计，不保存请求原文。
10. Node 仅在 check ok 后 `yield* next()`。

已证明进入同一指纹的字段：`provider`、`model`、`messages`、`system`、`tools`、`temperature`、`maxTokens`、`stop`、`purpose`。官方还包括 `reasoningEffort`、`sessionId`，实现按“除 signal 外全部递归”覆盖。

限制：任意对象键名当前作为结构键处理，未统一进入文本 DLP 扫描；顶层键名会进入审计字段列表。见 AF-02。

### 4.6 智能检测算法

**Owner**: `security/patterns.py`、`security/data_egress_guard.py`、`security/egress_checkpoint.py`

| 算法层 | 内容 | 用途 |
|---|---|---|
| Subject ID | 站点-编号、字母前缀编号、复合编号、USUBJID、6..8 位纯数字 | 受试者识别 |
| Date/time | ISO8601、ISO date、SAS date、美式日期、中文日期 | 临床日期识别 |
| Medical coding | MedDRA PT/LLT、WHO drug code | 医学编码识别 |
| CDISC fields | USUBJID/SUBJID/SUBJECT/SITEID/RFSTDTC/AESTDTC 等 | 结构化字段识别 |
| Clinical terms | 中英文入组、随机、访视、AE/SAE、生命体征等 | 组合信号 |
| SAS domains | DM/AE/CM/EX/LB/VS/EG 与 ADaM 常用域 | 数据域识别 |
| Composite threat | ID+日期、CDISC+ID、多个 BLOCK 信号 | 降低单点误判 |
| Encapsulation | base64 严格候选解码 + 递归扫描 | 绕过防御 |
| Unicode | 零宽字符与编号内空白归一化 | BY-11 |
| Filename exemption | 仅完整文件名形态中的版本日期豁免 | 降低误报且防上下文绕过 |
| Risk grading | METADATA、SUSPICIOUS_LOW、SUSPICIOUS_HIGH、SENSITIVE | 分级脱敏与审批 |
| Sheet risk | 高风险/低风险 sheet 命名启发 | L3 前置提示 |
| Streaming scrub | light/heavy/sensitive 三级处置 | 行级脱敏 |
| Header intelligence | vertical/horizontal、merged cells、评分、安全术语 | 表头结构提取 |

已知算法边界：这是模式与规则驱动的检测，不等价于语义级 DLP；未知混淆、自由文本姓名、非常规格式和图片 OCR 不承诺全覆盖。新增绕过样本必须进入 BY 矩阵和 mutation oracle。

### 4.7 AI 危险操作检测

**Owner**: `security/ai_operations_monitor.py`

风险等级：`SAFE/LOW/MEDIUM/HIGH/CRITICAL`。

阻断范围包括：

- 危险工具：`read_sas_folder`、`read_expected_output`、`peek_data_values` 等。
- bash：`.sas7bdat`、expected xlsx、`pickle.load`、pickle 别名、base64 解码接 shell、cat/head/tail 数据文件、Python 读 Excel/SAS、敏感项目目录。
- 文件路径：SAS 缓存、expected、output、SAS 数据、项目数据目录。
- Python 代码：危险字符串模式、语法错误按攻击尝试处理、AST 分析 pickle/read_sas/read_excel/read_csv/open。
- `BLOCK` recommendation 或风险 >= HIGH 均阻断。
- 操作链保留脱敏摘要和序号。

### 4.8 L3 授权

**Owner**: `security/egress_authz.py`

- 类别仅限 `L3_SKIP`、`L3_REDACTED_CONTINUE`、`L3_ALLOW_AUDITED`。
- 用户、会话、操作人经 SHA-256 截断哈希。
- 默认无授权；读取失败返回空集合。
- `tempfile` + `os.replace` 原子写入。
- 权限 0700/0600。

### 4.9 审计

**Owner**: `security/audit_log.py`

- JSONL 一行一条。
- 单文件达到 10MB 时轮转。
- 最多保留 5 个 `.rotated` 归档。
- 目录 0700，当前文件和归档 0600。
- egress 审计记录 action、威胁摘要、canonical SHA-256、payload 字节数、顶层字段、消息数、哈希上下文。
- AI 操作审计记录工具、风险、动作、脱敏原因/证据、参数类型摘要、哈希身份和序号。

当前活动审计目录是插件包内 `dsh-clinical-data-guard/var/...`，因为 worker 以插件根为 cwd。根目录 `var/...` 也存在历史审计文件，来源无法用 Git 历史区分，第三方应按潜在敏感数据隔离检查。

### 4.10 UI 白标

**Owner**: `src/branding.js`

- 配置长度和 `< >` 校验，HTML/JSON 注入防护。
- 替换 title、application-name。
- 注入 MutationObserver，持续替换可见 `DeepSeek` / `DeepSeek Harness` / 独立 `DSH`。
- 注册 exact routes：`/manifest.webmanifest`、`/favicon.svg`。
- favicon 为 Emerald 盾形图标，不包含 DeepSeek 文本。
- 所有注册返回 disposer 并反向清理。

### 4.11 一键启动

**Owner**: `start.ps1`

执行顺序：

1. 参数：`-Check` 只校验，`-NoOpen` 不打开浏览器。
2. 检测系统 Node/npm。
3. 检测 `EMERALD_PYTHON`、`python`、`python3`、`py -3`。
4. 校验 Node >=24、Python >=3.10。
5. 设置项目内 `DSH_HOME`、npm cache、pip cache、pnpm store。
6. runtime lock/manifest hash 不匹配才 `npm ci`。
7. 缺 `.venv` 则创建；requirements hash 变化才 pip install。
8. 缺 pnpm 则全局安装 `pnpm@11.19.0`。
9. profile 执行 `pnpm install --frozen-lockfile --prefer-offline`。
10. `-Check` 调 DSH `--dump-config` 并确认插件加载。
11. 默认启动并等待 `http://127.0.0.1:3080` 200 后打开浏览器。

## 5. 配置与环境变量

| 配置键 | 环境变量 | 默认 | 消费者 | 校验 |
|---|---|---|---|---|
| `mode` | `DATA_PROTECTION_MODE` | `enforce` | pre/post/LLM/worker | 枚举 |
| `approvalId` | `DATA_PROTECTION_APPROVAL_ID` | 空 | disabled 模式 | disabled 必填 |
| `approvedBy` | `DATA_PROTECTION_APPROVED_BY` | 空 | disabled 模式、授权 operator | disabled 必填 |
| `maxScanRows` | `MAX_SCAN_ROWS` | 20 | Excel 表头提取 | 1..200 整数 |
| `python` | `PYTHON` | win `python`，其他 `python3` | worker、Excel extractor | 启动失败 fail-closed |
| `brandName` | `EMERALD_BRAND_NAME` | `Emerald Clinical` | UI | 1..80，无尖括号 |
| `brandShortName` | `EMERALD_BRAND_SHORT_NAME` | `Emerald` | UI | 1..24，无尖括号 |
| `userId` | 无 | `anonymous` | 审计上下文 | 字符串，审计哈希 |
| `authorizationRoot` | 无 | 插件 `var/egress_authz` | 授权存储 | 路径 |
| `authorizationUser` | 无 | 空 | 授权隔离 | 哈希 |
| `authorizationSession` | 无 | 空 | 授权隔离 | 哈希 |
| 无 | `EMERALD_PYTHON` | 空 | start.ps1 指定基础 Python | 必须存在 |
| 无 | `DSH_HOME` | start 设置项目 `.dsh` | DSH CLI | 项目内 |
| 无 | `NPM_CONFIG_CACHE` | 项目 `.cache/npm` | npm | 项目内 |
| 无 | `PIP_CACHE_DIR` | 项目 `.cache/pip` | pip | 项目内 |
| 无 | `DSH_TELEMETRY_MODE` | 默认 DISABLED | DSH | 可外部覆盖，需企业审计确认 |
| 无 | `PYTHONDONTWRITEBYTECODE` | start 设置 1 | Python | 防字节码 |

模式语义：

| 模式 | pre 工具危险操作 | post 工具结果 | LLM |
|---|---|---|---|
| `enforce` | deny | 文件/无路径结果替换或 fail-closed | 命中阻断 |
| `shadow` | 观察并放行 | 不替换 | 观察并放行，写 OBSERVED |
| `disabled` + 双审批字段 | 当前工具危险操作仍按 enforce 处理 | 不替换 | 不阻断 |

`shadow` 和已审批 `disabled` 是明确的观测/审批通道，不是无痕后门；生产数据红线验收必须在 `enforce` 下执行。

## 6. 数据流与信任边界

### 6.1 工具输入流

```text
Agent/用户 -> DSH tool dispatch
  -> ctx.tools.guard: Node DLP 快筛
  -> tools/pre-execute: Python check_tool / inspect_file
     -> HIGH/CRITICAL/BLOCK: deny + ai_ops audit
     -> Excel L3: approval.request
        -> 非 allowed-once: deny
        -> allowed-once: authz atomic write 后继续
  -> 原工具执行
```

### 6.2 工具结果流

```text
Tool result -> tools/post-execute
  -> enforce 且 shouldReplaceResult(exec)
     -> sas7bdat: SAS_DATA
     -> zip: ZIP_MAYBE_DATA
     -> xlsx/csv: header-only JSON
     -> xls: extractor 失败则 CHECK_FAILED
     -> 无路径且 read-like: scrub_text
  -> 否则 next()
```

**审计结论**：`shouldReplaceResult` 的 read-like 条件是当前最大的实现/规范差异点。

### 6.3 模型出域流

```text
DSH agent loop -> GenerateOptions
  -> validateMessageShape
  -> remove local signal
  -> worker check_llm
     -> recursive structured/text scan
     -> base64 decode + recursive scan
     -> unicode normalize
     -> composite threat
     -> request fingerprint
     -> JSONL audit
  -> enforce BLOCK threat: throw before next()
  -> clean: yield* next() -> provider adapter
```

### 6.4 审计流

```text
检查逻辑 -> 脱敏 evidence / 类型摘要 / 身份哈希
  -> audit_log.write_audit_record
  -> current monthly JSONL
  -> >=10MB rotate
  -> 保留最新 5 个 archive
```

## 7. 测试资产与当前执行证据

### 7.1 当前执行记录

| 命令 | 结果 | 关键输出 |
|---|---|---|
| `.venv/Scripts/python.exe dsh-clinical-data-guard/tests/run_all.py` | PASS | unit 14/14；runtime 10/10；branding 1/1；contract 1/1；bypass 1/1；`TOTAL_FAILED_SUITES=0` |
| `.venv/Scripts/python.exe dsh-clinical-data-guard/tests/mutation/run_mutation.py` | PASS | 10/10 killed，100.00% |
| `.venv/Scripts/python.exe tests/test_project_contract.py` | PASS | `PASS project-delivery-contract` |
| `powershell ... start.ps1 -Check` | PASS | pnpm Already up to date；`PROJECT_DSH_CHECK=PASS` |
| `node tests/e2e/installed_smoke.js`（`PYTHON` 指向项目 venv） | PASS | imported true；version 1.0.4；inject 三个服务；streamed true |
| `node --check` 4 个 src JS + `plugin_driver.js` | PASS | 语法通过 |
| HTTP `/` | PASS | 200；title/application-name Emerald Clinical；白标脚本存在 |
| HTTP `/manifest.webmanifest` | PASS | name/short_name 为 Emerald Clinical/Emerald |
| HTTP `/favicon.svg` | PASS | Emerald 图标，无 DeepSeek 文本 |

说明：首次直接运行 installed smoke 时未设置 `PYTHON`，触发环境缺失失败；按脚本语义设置项目 venv 后通过。该脚本本身依赖调用方提供 Python 环境。

### 7.2 单元测试 14 项

| 测试 | 覆盖 |
|---|---|
| `subject_id_blocks` | 字母前缀受试者编号阻断 |
| `site_subject_and_date_composite_blocks` | 站点/受试者/日期复合威胁 |
| `base64_payload_blocks` | base64 递归识别 |
| `full_generate_options_fields_are_scanned` | system/tools/stop 辅助字段 |
| `clean_model_request_audit_keeps_only_fingerprint` | SHA-256、字节数、消息数、无原文 |
| `filename_date_is_allowed` | 完整文件名日期豁免 |
| `dangerous_tools_and_bash_block` | 危险工具与 SAS bash |
| `ai_operation_audit_has_no_raw_filename_or_identity` | 操作审计不含样本标识和原始身份 |
| `graded_scrub_removes_values` | 分级脱敏和 SENSITIVE 分类 |
| `authorization_stores_no_raw_values` | 授权文件无原始用户/会话/操作人 |
| `normal_request_is_fast` | <10ms |
| `normal_requests_have_low_false_positive_rate` | 100 个合成正常请求零误拦 |
| `every_request_is_audited_without_raw_values` | clean/dirty 均审计且无样本原值 |
| `audit_rotation_has_disk_cap` | 轮转数量上限 |

### 7.3 插件运行时测试 10 项

| 测试 | 覆盖 |
|---|---|
| `test_extension_registration_and_sas_denial` | 扩展注册与 SAS pre-deny |
| `test_llm_clean_streams_and_dirty_blocks` | clean stream 透传、dirty 阻断 |
| `test_full_model_request_scope_blocks_and_audits_clean_requests` | 完整请求扫描、辅助字段、指纹 |
| `test_shadow_mode_observes_without_blocking_llm` | shadow 观察不阻断 |
| `test_non_text_and_invalid_messages_fail_closed` | image/畸形消息 |
| `test_excel_post_execute_keeps_headers_only` | Excel 数据区不返回 |
| `test_no_path_tool_result_is_scrubbed` | read-like 无路径结果脱敏 |
| `test_l3_prompt_shows_location_patterns_evidence_and_options` | L3 解释与三选项 |
| `test_l3_approval_allows_once_and_writes_authz` | allowed-once 与授权留痕 |
| `test_missing_python_worker_fails_closed` | worker 缺失 deny |

### 7.4 品牌、契约与项目契约

品牌测试断言：

- title 与 application-name。
- 动态 DeepSeek/DSH 替换脚本。
- manifest name/short_name/content-type。
- favicon 颜色和无 DeepSeek。
- 两个 exact route 注册与 disposer 清理。

插件契约测试断言：

- ESM、main、exports。
- bundle patch。
- 无 runtime dependencies，四个 peer dependencies。
- 默认导出。
- inject 与五个扩展点。
- worker、branding、favicon 存在。
- 旧 `proxy.js` 和 `security-checkpoint.js` 不存在。

项目契约测试断言：

- start 脚本、版本阈值、pnpm、项目内 runtime/profile。
- 插件 1.0.4、品牌资产、webServer peer。
- profile 相对 link 与 bundles。
- lock 无机器盘符。
- 无 `.tools`、旧 proxy 端口、C 盘路径。

### 7.5 变异测试 10 项

| Mutant | 目标 | 当前 |
|---|---|---|
| `egress-blocking` | 关闭阻断 | KILLED |
| `full-request-scope` | 只扫 messages | KILLED |
| `base64-boundary` | base64 边界识别 | KILLED |
| `unicode-bypass` | 零宽归一化 | KILLED |
| `sas-extension` | SAS 扩展识别 | KILLED |
| `pickle-alias` | pickle 别名风险级别 | KILLED |
| `base64-shell` | base64 shell 风险级别 | KILLED |
| `sensitive-combination` | 敏感组合分类 | KILLED |
| `light-subject-scrub` | 轻度受试者脱敏 | KILLED |
| `filename-exemption` | 文件名豁免方向 | KILLED |

### 7.6 安装态与包资产

- 发布包：`dsh-clinical-data-guard/var/emerald-clinical-data-guard-1.0.4.tgz`
- SHA-256：`60F7A72F5997F5BBF17E2461D5EE64EEC8915BE934D3F65A9D170B3981A6FC92`
- 包内 18 个文件：4 个 JS 源、9 个 Python 源/测试初始化、favicon、manifest、patch、README 等；无字节码。
- 安装态从 `.dsh/profiles/clinical/node_modules/emerald-clinical-data-guard` 导入并成功 clean stream。

### 7.7 测试缺口

- 没有非 `read` 工具名的无路径结果测试。
- 没有任意敏感键名/未知顶层字段的扫描与审计测试。
- 没有 `.xls` 正向表头测试。
- 没有真实 provider adapter 网络出域取证。
- 没有多 worker 并发、崩溃恢复和审计轮转竞态测试。
- 没有 CI workflow。
- 没有当前机器上的 coverage 产物。
- installed smoke 对调用方 Python 环境有隐式依赖，未纳入 `run_all.py`。

## 8. 代码与资产盘点

### 8.1 插件源码

| 路径 | 职责 |
|---|---|
| `dsh-clinical-data-guard/src/index.js` | 插件入口、worker、配置、事件接线 |
| `dsh-clinical-data-guard/src/tool-result-guard.js` | 文件分类、表头提取调用、工具结果替换 |
| `dsh-clinical-data-guard/src/patterns.js` | Node DLP 快筛和错误脱敏 |
| `dsh-clinical-data-guard/src/branding.js` | Web/PWA/favicon 白标 |
| `dsh-clinical-data-guard/security/worker.py` | line JSON worker 与操作分发 |
| `dsh-clinical-data-guard/security/patterns.py` | Python 模式单一来源 |
| `dsh-clinical-data-guard/security/egress_checkpoint.py` | 模型出域硬检查与指纹 |
| `dsh-clinical-data-guard/security/data_egress_guard.py` | 风险分级、流式脱敏、Excel 安全扫描 |
| `dsh-clinical-data-guard/security/ai_operations_monitor.py` | AI 工具/bash/路径/代码风险 |
| `dsh-clinical-data-guard/security/egress_authz.py` | L3 授权 |
| `dsh-clinical-data-guard/security/audit_log.py` | JSONL 与轮转 |
| `dsh-clinical-data-guard/excel_header_extractor.py` | Excel/CSV 表头结构 |
| `dsh-clinical-data-guard/cordis.patch.yml` | profile 插入插件 |
| `dsh-clinical-data-guard/assets/branding/favicon.svg` | 品牌图标 |

### 8.2 项目交付文件

| 路径 | 职责 |
|---|---|
| `start.ps1` | 环境检测、依赖安装、启动 |
| `requirements.txt` | Python openpyxl 版本 |
| `runtime/package.json`、`runtime/package-lock.json` | DSH runtime 清单与锁 |
| `.dsh/profiles/clinical/package.json` | clinical profile 与相对插件 link |
| `.dsh/profiles/clinical/pnpm-lock.yaml` | profile 可复现安装 |
| `.dsh/profiles/clinical/cordis.yml` | profile root |
| `.dsh/profiles/clinical/cordis.patch.yml` | profile patch root |
| `tests/test_project_contract.py` | 企业交付契约 |
| `docs/EMERALD_CLINICAL_MASTER_SPEC.md` | 主规格 |
| `docs/EMERALD_DEV_PLAN_v2_20260818.md` | 开发与验收计划 |
| `README.md`、插件 README | 使用与验证说明 |

### 8.3 本地运行数据与敏感文件

存在但不应提交或复制：

- `.env`
- `.env.china`
- `var/`
- `dsh-clinical-data-guard/var/`
- `.venv/`
- `.cache/`
- `.pnpm-store/`
- `runtime/node_modules/`
- `.dsh/profiles/clinical/node_modules/`

当前活动插件审计文件大小量级：egress 约 663KB、AI ops 约 60KB；根目录另有历史 egress/AI ops 文件。本文不展开任何日志内容。

## 9. 第三方审计检查单

### 9.1 必测安全检查

1. 在干净环境执行 `start.ps1`，确认 Node/Python 缺失分支、项目内缓存和 profile 安装。
2. 用本地捕获 adapter 记录真实进入 adapter 的最终 `GenerateOptions`，证明 dirty 请求未到达。
3. 执行总回归、变异、项目契约、安装态冒烟。
4. 增加 AF-01 用例：非 `read` 工具名 + 无路径 + 临床值，断言 canonical value 被替换。
5. 增加 AF-02 用例：敏感键名、未知顶层字段、嵌套任意键，断言阻断或键名哈希。
6. 遍历 `.xlsx/.xls/.csv/.sas7bdat/.zip/无扩展名` 输入矩阵，断言无数据区原值。
7. 用无害标记样本检查 egress/AI ops/authz JSONL，确认无标记、无凭据、无原始身份。
8. 对 `shadow` 和 `disabled` 做数据外发风险评估，生产验收只认 `enforce`。
9. 用并发请求验证 worker requestId、审计追加和轮转无交叉/丢失。
10. 验证 worker kill、非法 JSON、stderr、stdout 半行、超时和重复 dispose。

### 9.2 交付与供应链检查

1. 初始化真实 Git 仓库后确认 profile `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 被跟踪。
2. 用 lockfile/integrity 校验 DSH 官方包未被修改。
3. 执行 npm/pnpm 官方 audit 并核对可达性。
4. 校验发布包 SHA-256 与文件清单。
5. 在 CI 中运行全部脚本，禁止 skip/allow-failure。
6. 生成并归档 coverage 证据，而不是只引用计划文本。
7. 检查 `.env` 是否曾被提交或打包；如确认暴露，只报告类型和位置，不复制值。
8. 核查 `DSH_TELEMETRY_MODE` 在企业环境不可被无意开启。

### 9.3 主机与运维检查

1. Windows ACL、审计目录所有者、远程访问和备份范围。
2. 审计留存周期、时钟源、归档完整性和恢复演练。
3. 磁盘配额与 10MB x5 上限下的运维告警。
4. Web UI 仅绑定本机的网络验证。
5. 崩溃日志、核心转储、swap/休眠文件中是否可能残留请求内容。

## 10. 已知不交付项

以下不是当前版本的功能承诺：

- 外置 HTTP proxy 或 Docker proxy。
- 修改 DSH 官方插件或宿主前端源码。
- 便携 Node/Python 运行时下载。
- SSO、SIEM、多租户、沙箱等未接线企业模块。
- 通用匿名化/去标识化算法或 HIPAA/GDPR 合规认证。
- 未知混淆的绝对识别承诺。
- 真实外部模型 provider 的网络出域测试。
- 审计留存的法定合规期限管理。

## 11. 文档漂移与待修正

| 位置 | 漂移 | 处理建议 |
|---|---|---|
| `docs/EMERALD_CLINICAL_MASTER_SPEC.md` NFR-5 | 写 9 个变异点，实际 10 个 | 更新为 10/10 并加契约断言 |
| `.gitignore` | profile 清单/锁文件被忽略，与 README“提交 profile 清单与锁文件”冲突 | 修正 ignore 规则 |
| `README.md` | 写死当前 `G:\home\dsh-guard` 路径；脚本实际支持 `$PSScriptRoot` 克隆位置 | 改为相对说明，保留当前机器示例 |
| 开发计划 | “多 Agent 同步”无执行日志证据 | 保留为过程记录，不作为交付证明 |
| NFR-4 | 当前无 coverage 产物 | 重新生成并归档 |
| 根目录 `var/` | 与插件活动审计目录并存，来源无法追溯 | 审计后按保留策略归档或清理 |
| `tests/e2e/temp_check.py` | 临时诊断脚本 | 删除或正式化 |

## 12. 复核 AF-01 与 AF-02 的最小实验

以下均使用合成标记，不使用真实临床数据。

### AF-01 复现要点

构造 `tools/post-execute`：

```text
exec.name = fetch_database
exec.arguments = {}
result.value = status <合成受试者标记> <合成日期>
```

当前返回 `{kind:'accept', value:<原值>}`，`leaked=true`。根因是 `shouldReplaceResult` 先要求工具名包含 `read`。

### AF-02 复现要点

构造完整请求顶层未知字段：

```json
{"A1234567":"x","messages":[]}
```

当前检查结果为 `ALLOWED`，审计 `payload_fields` 包含 `A1234567`，审计文件中可搜索到该键名。根因是递归扫描只把已知 CDISC 键当敏感键，其他键作为路径处理；证据层直接 `sorted(payload)`。

## 13. 最终审计判定

| 维度 | 判定 | 依据 |
|---|---|---|
| 标准 DSH 插件架构 | PASS | 官方扩展点、manifest、patch、inject、安装态 |
| 企业项目内交付 | CONCERNS | 脚本和路径正确，但 profile 锁文件 ignore 导致克隆不可复现 |
| UI 白标 | PASS | 自动化 + HTTP |
| 智能检测 | CONCERNS | 多算法已落地，但键名和非 read 工具结果存在缺口 |
| 模型出域拦截 | CONCERNS | tested payload 字段阻断有效；任意键名和真实 provider 为盲点 |
| 工具结果红线 | FAIL | 非 read 无路径结果可原样进入 canonical value |
| 审计零数据 | FAIL | 顶层未知键名可原文进入审计 |
| 测试交付 | PASS with gaps | 当前门禁全绿，但存在明确未覆盖路径 |
| 变异测试 | PASS | 10/10 |
| 供应链与历史 | UNVERIFIED | 无 Git 仓库、无 CI、未执行官方 audit |

**结论**：当前系统不能通过“数据红线无条件守住”的最终验收。它已经具备标准 DSH 插件形态、较强的已测试防御和完整本地交付脚本，但 AF-01 和 AF-02 是必须先修复并补测试的 P1 安全缺口；AF-03 是必须修复的企业分发缺口。修复后应从干净 Git 克隆重新执行本文件第 7、9 节的全部检查。
