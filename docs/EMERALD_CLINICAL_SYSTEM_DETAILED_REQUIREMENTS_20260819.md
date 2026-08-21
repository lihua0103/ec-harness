# Emerald Clinical 临床 Listing 数据安全工作台系统详细需求规格

**文档版本**: v1.0  
**日期**: 2026-08-19  
**产品名称**: Emerald Clinical / Emerald Clinical Data Guard  
**系统形态**: 本地 DeepSeek Harness（DSH）/ Cordis 标准插件与独立 clinical profile  
**适用对象**: 产品、研发、安全、测试、运维、第三方审计  
**文档性质**: 目标态系统需求规格。本文描述系统必须满足的完整功能点；不等于当前实现全部已经完成。当前实现与缺口另见《Emerald Clinical / Clinical Listing 全量审计基线》。

## 1. 文档目的与范围

### 1.1 目的

本文完整定义 Emerald Clinical 临床 Listing 数据安全工作台的业务目标、用户场景、系统边界、功能需求、数据需求、安全红线、接口需求、部署需求、配置需求、异常处理、非功能需求和验收标准，作为开发、测试、验收和第三方审计的统一需求基线。

### 1.2 In Scope

系统必须覆盖以下能力：

1. 本地 DSH 工作台启动、依赖检测、项目内环境管理和 Web UI 打开。
2. 标准 DSH/Cordis 插件接入，不修改 DSH 官方插件或宿主源码。
3. 临床 Listing 场景中的工具调用输入防护。
4. AI / Agent 危险操作检测与阻断。
5. SAS、Excel、CSV、ZIP 等临床数据文件的安全读取与结果替换。
6. 表头结构智能识别与数据区隔离。
7. 发送给 AI 模型的完整请求数据检测、阻断、脱敏和审计。
8. 多层临床数据识别算法、绕过检测和复合风险判定。
9. L3 敏感数据用户决策、授权和留痕。
10. 无临床数据值、无凭据、无原始身份的审计与轮转。
11. Emerald Clinical 品牌白标。
12. 插件打包、安装、启动检查、回归测试、变异测试和交付验收。

### 1.3 Out of Scope

以下内容不属于本系统承诺：

1. 外置 HTTP proxy、Docker proxy 或额外网络监听端口。
2. 修改 DeepSeek Harness 官方插件、官方前端源码或 `node_modules` 内文件。
3. 在项目内携带便携 Node.js 或 Python 运行时。
4. SSO、多租户、企业用户体系、SIEM 平台对接、操作系统级沙箱。
5. 医疗法规认证、HIPAA/GDPR 合规认证或通用匿名化算法认证。
6. 对所有未知混淆、语义等价改写、OCR 图片、语音内容的绝对识别承诺。
7. 真实外部模型 provider 的网络出域替代测试。
8. 审计数据法定留存周期的企业策略管理。

## 2. 产品定位与业务目标

### 2.1 产品定位

Emerald Clinical 是面向临床试验 Listing 开发场景的本地 AI 数据安全工作台。用户可以在本地 DSH 环境中使用 AI 辅助生成 Listing 规范、代码和交付物，但临床数据行、受试者标识、临床日期、医学编码、原始数据内容和凭据不得离开本地安全边界。

### 2.2 核心业务目标

| 编号 | 目标 | 衡量方式 |
|---|---|---|
| BG-1 | 临床数据在进入模型 adapter 前被完整检查 | 本地捕获 adapter 证明敏感请求未到达模型层 |
| BG-2 | AI 工具执行不得绕过数据安全策略 | 工具、bash、路径、代码执行均经过 pre-execute 检查 |
| BG-3 | 数据文件只暴露结构，不暴露数据区 | SAS/Excel/CSV/ZIP 输出矩阵无数据原值 |
| BG-4 | 审计可证明但不再泄露数据 | JSONL 只有指纹、类型、脱敏证据和单向哈希 |
| BG-5 | 企业项目可从 Git 一键启动 | 干净克隆后 `start.ps1` 可完成环境检测与依赖安装 |
| BG-6 | 系统保持标准 DSH 插件架构 | manifest、patch、inject、扩展点契约全部符合官方规范 |
| BG-7 | 用户可见品牌为 Emerald Clinical | UI、PWA、favicon 与动态文本不显示 DeepSeek/DSH 品牌 |
| BG-8 | 安全逻辑可被测试和变异验证 | 总回归全绿，关键安全 mutant 必须全部 killed |

## 3. 用户与角色

| 角色 | 说明 | 主要操作 | 权限边界 |
|---|---|---|---|
| Clinical Listing Developer | 临床 Listing 开发人员 | 使用 AI 生成规范、代码、文档；读取结构化数据元数据 | 不能绕过 enforce 安全策略 |
| Clinical Data Reviewer | 数据审查人员 | 查看 L3 提示、选择跳过/脱敏/授权、核对审计摘要 | 授权必须绑定会话并留痕 |
| Security Officer | 安全官 | 审计阻断、授权、模式、数据红线和发布包 | 不直接接触模型请求原文 |
| DevOps Engineer | 企业交付与运维人员 | 一键启动、依赖安装、环境检查、日志轮转、备份 | 不修改官方 runtime 源码 |
| Test Engineer | 测试人员 | 执行单元、集成、绕过、变异、安装态和 HTTP 验收 | 测试数据必须是合成数据 |
| Third-party Auditor | 第三方审计 | 复核需求、代码、测试、包、日志和主机边界 | 只查看脱敏证据，不复制敏感文件 |
| System Service | DSH/Cordis 系统 | 调度插件、工具事件、模型事件和 Web 扩展点 | 由官方 host 管理生命周期 |

## 4. 总体架构需求

## 4.1 AR-1 标准 DSH/Cordis 插件形态

**Priority**: Must

系统业务扩展必须打包为独立插件 `emerald-clinical-data-guard`，通过项目内 clinical profile 加载。

需求点：

1. 插件具有独立 `package.json`、入口 `src/index.js` 和 `cordis.patch.yml`。
2. 插件声明默认导出 `clinicalDataGuard`。
3. 插件声明 `inject=["tools","llm","webServer"]`。
4. 插件通过官方扩展点接入：
   - `ctx.tools.guard`
   - `tools/pre-execute`
   - `tools/post-execute`
   - `llm/stream`
   - `webServer.tapIndex`
   - `webServer.register`
5. 插件不直接修改 DSH 官方插件、官方前端源码或 `node_modules` 文件。
6. 插件不新增 HTTP 监听端口。
7. 插件返回统一 disposer，支持反向释放资源。

验收标准：

1. manifest、patch、导出、inject 和扩展点由插件契约测试验证。
2. 安装态从 profile `node_modules` 导入成功。
3. dispose 后 guard、事件、路由和 worker 均清理。

## 4.2 AR-2 Python 安全内核

**Priority**: Must

需求点：

1. 插件启动本地常驻 Python worker。
2. Node 与 worker 使用 line JSON 协议通信。
3. 每个请求必须有唯一 `requestId`。
4. Worker 支持操作：
   - `check_tool`
   - `check_llm`
   - `scrub_row`
   - `scrub_text`
   - `inspect_file`
   - `authorize`
5. 未知操作返回 `UNKNOWN_OPERATION`。
6. worker 启动失败、退出、非法 JSON、响应无法关联、写入失败均视为安全不可用。
7. 安全不可用时工具执行拒绝，模型请求抛错，不得放行。
8. worker 不将临床数据原文写入 stdout 日志。
9. worker 异常返回稳定错误码，不返回底层异常文本、路径片段或数据值。

验收标准：

1. 缺失 Python 时工具 pre-execute deny。
2. 缺失 Python 时 LLM stream fail-closed。
3. 非法 worker 响应 fail-closed。
4. 未知操作不执行任何安全旁路。

## 4.3 AR-3 本地部署边界

**Priority**: Must

需求点：

1. DSH Web UI 只在本地 `127.0.0.1:3080` 提供服务。
2. 插件不连接外部控制平面。
3. 插件不新增网络端口。
4. 默认关闭 DSH telemetry。
5. 审计、授权、runtime、profile、venv 和缓存均位于项目目录内。

验收标准：

1. HTTP `/` 返回 200。
2. 无新增监听端口。
3. 项目契约确认无外置 proxy 和项目外默认缓存。

## 4.4 AR-4 项目内企业交付

**Priority**: Must

需求点：

1. DSH runtime 清单和 lock 文件在项目内。
2. clinical profile manifest、lock 文件和 workspace 文件必须随 Git 提交。
3. profile 对插件使用相对路径 link，不包含机器盘符。
4. Python `.venv` 在项目根目录。
5. npm cache、pip cache、pnpm store 在项目根目录。
6. 不携带便携 Node/Python。
7. 缺失系统环境时提示用户安装，不自动下载便携运行时。
8. 缺失 pnpm 时可使用系统 npm 安装固定版本 `pnpm@11.19.0`。

验收标准：

1. 干净 Git 克隆后一键启动成功。
2. lock 文件无 `C:/Users`、`G:/` 等机器路径。
3. `.tools` 不存在。
4. 已安装依赖时脚本不重复下载。

## 5. 业务流程需求

## 5.1 BR-01 一键启动流程

**Priority**: Must

前置条件：

1. 用户已获得完整项目源码。
2. 系统已安装 Node.js 24+、npm、Python 3.10+。

主流程：

1. 用户执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1`。
2. 脚本检测 Node 和 npm；缺失则终止并提示 Node.js 安装地址。
3. 脚本检测 `EMERALD_PYTHON`、`python`、`python3` 或 `py -3`；缺失则终止并提示 Python 安装地址。
4. 校验 Node 版本不低于 24.0.0。
5. 校验 Python 版本不低于 3.10.0。
6. 设置项目内 `DSH_HOME`、npm cache、pip cache。
7. runtime lock/manifest hash 变化时执行 `npm ci`。
8. 缺 `.venv` 时创建；requirements hash 变化时安装依赖。
9. 缺 pnpm 时安装固定版本。
10. clinical profile 执行 pnpm frozen lock 安装。
11. 启动 DSH clinical profile。
12. 等待 Web UI 返回 200 后打开浏览器。

异常流程：

| 编号 | 异常 | 要求 |
|---|---|---|
| BR01-E1 | Node/npm 缺失 | 终止并提示官方安装地址 |
| BR01-E2 | Python 缺失 | 终止并提示官方安装地址 |
| BR01-E3 | 版本过低 | 终止并显示最低版本与当前版本 |
| BR01-E4 | runtime 安装失败 | 终止并显示非零退出码 |
| BR01-E5 | venv 创建失败 | 终止 |
| BR01-E6 | Python 依赖安装失败 | 终止 |
| BR01-E7 | pnpm 安装失败 | 终止并给出手动安装命令 |
| BR01-E8 | profile 安装失败 | 终止 |
| BR01-E9 | Web UI 启动失败 | 终止并释放 opener 子进程 |

验收标准：

1. 缺环境分支不把运行时下载进项目。
2. `start.ps1 -Check` 输出 `PROJECT_DSH_CHECK=PASS`。
3. 已有依赖时 pnpm 输出 Already up to date 或等价复用结果。

## 5.2 BR-02 工具输入安全流程

**Priority**: Must

主流程：

1. Agent 或用户发起工具调用。
2. DSH 触发 `ctx.tools.guard`。
3. 插件序列化工具参数。
4. Node 使用 DLP 快筛模式识别疑似临床数据。
5. 命中时返回官方 guard reason 并阻断。
6. 未命中时进入 `tools/pre-execute`。
7. Python worker 执行 AI 危险操作检查。
8. Excel 文件执行敏感预检。
9. 需要用户决策时发起 L3 审批。
10. 检查通过后执行原工具。

验收标准：

1. 工具参数包含受试者、日期等敏感值时被阻断。
2. 危险工具和危险命令在执行前被阻断。
3. 所有非安全失败均 fail-closed。

## 5.3 BR-03 工具结果安全流程

**Priority**: Must

主流程：

1. 工具执行完成。
2. DSH 触发 `tools/post-execute`。
3. enforce 模式下插件拦截结果。
4. 按文件类型或无路径结果执行安全替换。
5. 返回 `{kind:"accept", content}` 替换模型可见内容投影；必须保留原工具的 canonical `value`，除非替换值完全满足该工具的 output schema。

需求点：

1. SAS 数据集不读取数据行，返回元数据占位。
2. ZIP 不解压，返回疑似数据占位。
3. Excel/CSV 只返回表头结构，不返回数据区值。
4. 所有无法通过路径确定类型的工具结果必须强制脱敏。
5. 非 `read` 命名工具同样必须进入无路径结果脱敏，不得按工具名白名单跳过。
6. Excel 提取失败时返回 `CHECK_FAILED`。
7. Python 脱敏失败时返回 `BLOCKED`。
8. 错误 detail 必须先脱敏且不得泄露本地路径或临床值。

验收标准：

1. 安全替换作用于模型可见 `content`；不得以通用占位对象破坏任意工具的 canonical `value` output schema。
2. 输出矩阵中不得出现数据区原值。
3. 非 `read` 工具名 + 无路径 + 敏感值必须被替换。

## 5.4 BR-04 模型请求出域流程

**Priority**: Must

主流程：

1. DSH 组装完整 `GenerateOptions`。
2. 插件在 `llm/stream` waterfall 中接收请求。
3. 校验 `messages` 形态。
4. 剥离本地 `signal`。
5. 将其他可序列化字段送 Python 完整扫描。
6. 扫描对象键名、字符串值、数组、嵌套结构。
7. 识别临床敏感信号和封装绕过。
8. enforce 下存在 BLOCK 威胁时抛错。
9. 干净请求写审计指纹。
10. 检查通过后才 `yield* next()` 进入模型 adapter。

必须覆盖的官方字段：

1. `provider`
2. `model`
3. `reasoningEffort`
4. `messages`
5. `system`
6. `tools`
7. `temperature`
8. `maxTokens`
9. `stop`
10. `sessionId`
11. `purpose`
12. 未来新增的可序列化字段

例外：

1. `signal` 是本地取消信号，不进入扫描和指纹。

验收标准：

1. 敏感命中在 `next()` 前阻断。
2. 本地捕获 adapter 未收到 dirty 请求。
3. 敏感键名与敏感值同样阻断。
4. 干净完整请求的 canonical SHA-256 与审计指纹一致。

## 5.5 BR-05 L3 用户决策流程

**Priority**: Must

触发条件：

1. Excel 预检发现敏感组合。
2. 无路径结果脱敏发现 SENSITIVE 行。

用户选项：

| 选项 | 行为 |
|---|---|
| 跳过 | 默认推荐；拒绝继续读取 |
| 脱敏后继续 | 输出脱敏结果并写授权 |
| 允许并审计 | 仅当前一次有效，写授权和审计 |

需求点：

1. Prompt 必须包含位置、命中模式、脱敏证据和三个选项。
2. 默认必须是跳过。
3. 宿主无审批通道时拒绝。
4. 只有 outcome 等于 `allowed-once` 才继续。
5. 授权写失败时拒绝。
6. 授权按用户、会话隔离。
7. 授权文件不得保存原始用户、会话、操作人或临床值。

## 5.6 BR-06 审计流程

**Priority**: Must

需求点：

1. 每次 LLM 检查，无论 clean、dirty、shadow，都写 egress audit。
2. 每次危险操作检查写 AI operations audit。
3. 每次 L3 授权写授权审计。
4. egress audit 保存：
   - audit id
   - timestamp
   - action
   - threat count
   - blocking threat count
   - canonical SHA-256
   - payload bytes
   - 已知字段名或脱敏后的字段摘要
   - message count
   - 脱敏 threat summary
   - 哈希上下文
5. AI operations audit 保存：
   - 工具名
   - 风险等级
   - action
   - 脱敏 reason/evidence
   - 参数类型摘要
   - 哈希身份
   - 操作链序号
6. 审计不得保存：
   - 模型请求原文
   - 工具结果原文
   - 临床数据值
   - 凭据
   - 原始用户/会话/操作人
   - 未脱敏路径
7. 单文件达到 10MB 轮转。
8. 最多保留 5 个归档。
9. 目录权限 0700，文件权限 0600。
10. 轮转、写入和并发追加不得丢记录或串 request。

## 5.7 BR-07 品牌白标流程

**Priority**: Must

需求点：

1. Web title 为 `Emerald Clinical`。
2. `application-name` 为 `Emerald Clinical`。
3. PWA `name` 为 `Emerald Clinical`。
4. PWA `short_name` 为 `Emerald`。
5. favicon 使用 Emerald 资产且无 DeepSeek 标识。
6. 页面动态出现的可见 `DeepSeek`、`DeepSeek Harness` 被替换为品牌名。
7. 独立 `DSH` 可见文本替换为 `Emerald`。
8. 品牌配置必须校验长度和尖括号，防 HTML/JSON 注入。
9. 只通过官方 `webServer.tapIndex/register` 实现。
10. route 和 tap 注册均返回 disposer。

边界说明：

1. 底层依赖包名 `@deepseek-ai/*` 可出现在技术网络响应中。
2. 用户可见品牌文本不得显示 DeepSeek/DSH。
3. 如企业要求网络响应完全无 DeepSeek 字符串，应新增更强需求并重新设计宿主依赖标识。

## 6. 功能需求明细

## 6.1 FR-01 插件生命周期管理

| ID | 需求 | Priority |
|---|---|---|
| FR-01-01 | 插件启动时读取 profile config 与环境变量并合并 | Must |
| FR-01-02 | 校验 mode 只能为 enforce/shadow/disabled | Must |
| FR-01-03 | disabled 必须同时提供 approvalId 和 approvedBy，否则启动失败 | Must |
| FR-01-04 | maxScanRows 必须为 1..200 整数，否则启动失败 | Must |
| FR-01-05 | Python 配置缺失时使用平台默认 Python 命令 | Should |
| FR-01-06 | 插件启动 Python worker 并建立 requestId 映射 | Must |
| FR-01-07 | worker 响应按 requestId 匹配，无法匹配则 fail-closed | Must |
| FR-01-08 | dispose 顺序为 stream、post、pre、guard、branding、worker | Must |
| FR-01-09 | 重复 dispose 不得抛错或重复 kill | Must |
| FR-01-10 | 官方服务缺失时插件应 fail-fast 或输出不可忽略错误 | Should |

## 6.2 FR-02 工具参数快速检测

| ID | 需求 | Priority |
|---|---|---|
| FR-02-01 | 对 `exec.arguments` 做稳定序列化 | Must |
| FR-02-02 | 使用与 Python 内核同步的 DLP 快筛模式 | Must |
| FR-02-03 | 命中返回官方 guard reason 字符串 | Must |
| FR-02-04 | 未命中返回 undefined | Must |
| FR-02-05 | reason 只包含模式标签，不包含原值 | Must |
| FR-02-06 | 文件名中的版本日期按安全豁免处理 | Should |
| FR-02-07 | Day/Week/Cycle/Visit 等表头术语不得造成误拦 | Should |

## 6.3 FR-03 AI 危险操作检测

| ID | 需求 | Priority |
|---|---|---|
| FR-03-01 | 检查所有工具调用名称、参数和上下文 | Must |
| FR-03-02 | 支持危险工具名单与风险等级 | Must |
| FR-03-03 | `read_sas_folder` 为 HIGH 或以上 | Must |
| FR-03-04 | `read_expected_output`、`peek_data_values` 为 CRITICAL | Must |
| FR-03-05 | bash 命令进入专门分析器 | Must |
| FR-03-06 | 识别 `.sas7bdat` 直接读取 | Must |
| FR-03-07 | 识别 expected/output 数据读取 | Must |
| FR-03-08 | 识别 `pickle.load` 和别名导入 | Must |
| FR-03-09 | 识别 base64 解码后接 shell | Must |
| FR-03-10 | 识别 cat/head/tail/strings 读数据文件 | Must |
| FR-03-11 | 识别 Python read_excel/read_sas | Must |
| FR-03-12 | 文件路径按敏感模式分级 | Must |
| FR-03-13 | AI 生成 Python 代码支持字符串模式和 AST | Must |
| FR-03-14 | 语法错误代码按攻击尝试 BLOCK | Must |
| FR-03-15 | AST 识别 pickle.load、pd.read_sas、pd.read_excel、pd.read_csv、open 敏感文件 | Must |
| FR-03-16 | BLOCK recommendation 或风险 >= HIGH 必须阻断 | Must |
| FR-03-17 | shadow 模式记录观察结果但不阻断 | Must |
| FR-03-18 | 操作链记录脱敏摘要和序号 | Must |

## 6.4 FR-04 SAS 数据处置

| ID | 需求 | Priority |
|---|---|---|
| FR-04-01 | `.sas7bdat` 工具结果不得读取数据行 | Must |
| FR-04-02 | 输出 `clinicalGuard:"DATA_BLOCKED"` | Must |
| FR-04-03 | 输出 `kind:"SAS_DATA"` | Must |
| FR-04-04 | 文件名先脱敏再输出 | Must |
| FR-04-05 | 输出固定安全说明：仅允许本地处理，禁止发送给模型 | Must |
| FR-04-06 | 大小写扩展名均识别 | Must |

## 6.5 FR-05 ZIP 数据处置

| ID | 需求 | Priority |
|---|---|---|
| FR-05-01 | `.zip` 不解压 | Must |
| FR-05-02 | 输出 `kind:"ZIP_MAYBE_DATA"` | Must |
| FR-05-03 | 不列出压缩包内文件内容 | Must |
| FR-05-04 | 文件名脱敏 | Must |
| FR-05-05 | 输出疑似数据风险说明 | Must |

## 6.6 FR-06 Excel/CSV 表头结构提取

| ID | 需求 | Priority |
|---|---|---|
| FR-06-01 | 支持 `.xlsx` | Must |
| FR-06-02 | 支持 `.csv` | Must |
| FR-06-03 | 支持 `.xls` 表头结构提取 | Must |
| FR-06-04 | 识别 vertical 表头 | Must |
| FR-06-05 | 识别 horizontal 表头 | Must |
| FR-06-06 | 识别 merged cells | Must |
| FR-06-07 | 输出 sheet 名 | Must |
| FR-06-08 | 输出 orientation | Must |
| FR-06-09 | 输出 header rows | Must |
| FR-06-10 | 输出 data start row | Must |
| FR-06-11 | 输出 total rows/cols | Must |
| FR-06-12 | 输出 header cells | Must |
| FR-06-13 | 表头中敏感值替换为 `[REDACTED:*]` | Must |
| FR-06-14 | 输出 redacted in header 列表 | Must |
| FR-06-15 | 输出 warnings | Must |
| FR-06-16 | 默认扫描 20 行 | Must |
| FR-06-17 | maxScanRows 可配置 1..200 | Must |
| FR-06-18 | 提取失败返回 `CHECK_FAILED` | Must |
| FR-06-19 | CSV 读取有编码容错策略 | Should |
| FR-06-20 | 输出不得包含数据区单元格值 | Must |

## 6.7 FR-07 无路径工具结果脱敏

| ID | 需求 | Priority |
|---|---|---|
| FR-07-01 | 工具参数无可用路径时必须进入脱敏 | Must |
| FR-07-02 | 适用所有工具名，不限于 read-like 命名 | Must |
| FR-07-03 | 支持 string、object、array 等可序列化结果 | Must |
| FR-07-04 | 低风险行轻度脱敏 | Must |
| FR-07-05 | 高风险行重度脱敏 | Must |
| FR-07-06 | 敏感组合返回用户决策提示 | Must |
| FR-07-07 | 脱敏失败返回 `BLOCKED` | Must |
| FR-07-08 | 输出脱敏行数 | Must |
| FR-07-09 | 输出不得包含原始受试者、日期、编码和身份值 | Must |

## 6.8 FR-08 模型请求形态校验

| ID | 需求 | Priority |
|---|---|---|
| FR-08-01 | `messages` 必须是数组 | Must |
| FR-08-02 | 每个 message 必须是对象 | Must |
| FR-08-03 | message.content 必须是 string 或 typed array | Must |
| FR-08-04 | content block 必须是对象且有 type | Must |
| FR-08-05 | 允许 block 类型仅 text/reasoning/tool-call/tool-result | Must |
| FR-08-06 | image、audio、video、未知 block 拒绝 | Must |
| FR-08-07 | 畸形结构返回明确安全错误 | Must |
| FR-08-08 | 错误不得包含原始 content | Must |

## 6.9 FR-09 完整模型请求扫描

| ID | 需求 | Priority |
|---|---|---|
| FR-09-01 | 扫描除 signal 外全部模型侧字段 | Must |
| FR-09-02 | 递归扫描 dict/list/string | Must |
| FR-09-03 | 递归扫描对象键名 | Must |
| FR-09-04 | 嵌套任意未知字段不得形成扫描盲区 | Must |
| FR-09-05 | `messages`、`system`、`tools`、`stop` 均扫描 | Must |
| FR-09-06 | `provider`、`model`、routing、purpose 等字符串字段均扫描 | Must |
| FR-09-07 | base64 候选解码后递归扫描 | Must |
| FR-09-08 | 零宽字符归一化后扫描 | Must |
| FR-09-09 | 编号内空白归一化后扫描 | Must |
| FR-09-10 | 复合威胁参与最终判定 | Must |
| FR-09-11 | enforce 下 BLOCK 威胁在 adapter 前抛错 | Must |
| FR-09-12 | shadow 下写 OBSERVED 不阻断 | Must |
| FR-09-13 | 已审批 disabled 下不阻断但必须审计 | Must |

## 6.10 FR-10 临床数据智能识别

### FR-10-01 受试者标识

系统必须识别：

1. 站点-受试者编号，如 3..4 位站点 + 3..6 位编号。
2. 字母前缀 + 6..8 位数字。
3. 复合站点编号。
4. USUBJID 组合格式。
5. Excel 数值型 6..8 位受试者编号。
6. 零宽或空白混淆后的上述格式。

### FR-10-02 临床日期时间

系统必须识别：

1. ISO8601 时间戳。
2. ISO 日期。
3. SAS 日期。
4. 美式日期。
5. 中文日期。
6. 数据上下文中的其他明确临床日期。

### FR-10-03 医学编码

系统必须识别：

1. MedDRA PT 编码。
2. MedDRA LLT 编码。
3. WHO 药品编码。
4. 其他经规则配置的医学编码。

### FR-10-04 CDISC 字段

系统必须识别常用 CDISC/SDTM 字段，包括但不限于：

1. `USUBJID`
2. `SUBJID`
3. `SUBJECT`
4. `SITEID`
5. `SCREENID`
6. `RANDID`
7. `RFSTDTC`
8. `RFENDTC`
9. `DTHDTC`
10. `AESTDTC`
11. `AEENDTC`
12. `CMSTDTC`
13. `EXSTDTC`
14. `VISIT`
15. `VISITNUM`
16. `DOMAIN`
17. `STUDYID`

### FR-10-05 临床术语

系统必须识别中英文常见临床状态和事件术语：

1. 筛选中、筛选失败、已入组、已随机。
2. baseline、screening、enrolled、randomized。
3. treatment、follow-up、early termination。
4. 不良事件、严重不良事件。
5. adverse event、serious adverse event。
6. mild、moderate、severe。
7. 血压、心率、体温等生命体征。

### FR-10-06 SAS/ADaM 域

系统必须识别常见 SDTM 和 ADaM 域：

1. DM、AE、CM、EX、LB、VS、EG、MH、PE。
2. QS、SC、DS、SV、PR、FA、IE、HO。
3. ADSL、ADAE、ADCM、ADLB、ADVS、ADEG。

### FR-10-07 组合风险

系统必须识别组合威胁：

1. 受试者 ID + 临床日期。
2. CDISC 字段 + 受试者 ID。
3. 多个独立 BLOCK 信号。
4. 受试者 ID + 日期 + 临床术语。
5. sheet 名风险 + 表头 + 数据行信号。

## 6.11 FR-11 分级脱敏

| 风险级 | 定义 | 处置 |
|---|---|---|
| METADATA | 结构、说明、需求文本 | 放行 |
| SUSPICIOUS_LOW | 单一弱信号或表头后多列行 | 轻度脱敏 |
| SUSPICIOUS_HIGH | 多个强信号或数据行高置信 | 重度脱敏 |
| SENSITIVE | ID + 日期 + 临床术语组合 | 拒绝或用户决策 |

轻度脱敏必须替换：

1. `[SUBJ]` 受试者编号。
2. `[DATE]` 日期时间。
3. `[CODE]` 医学编码。

重度脱敏只保留：

1. `[NUM]`
2. `[DATE]`
3. `[TEXT]`
4. 空值
5. 列数和结构信息

## 6.12 FR-12 出域审计证据

| ID | 需求 | Priority |
|---|---|---|
| FR-12-01 | 生成 canonical JSON | Must |
| FR-12-02 | 使用 SHA-256 请求指纹 | Must |
| FR-12-03 | 记录 canonical 字节数 | Must |
| FR-12-04 | 记录已知顶层字段名 | Must |
| FR-12-05 | 未知字段名必须哈希或类型摘要，不得原文输出 | Must |
| FR-12-06 | 记录 messages 数量 | Must |
| FR-12-07 | 审计不得包含请求原文 | Must |
| FR-12-08 | 审计不得包含临床值 | Must |
| FR-12-09 | clean 记录 ALLOWED | Must |
| FR-12-10 | dirty enforce 记录 BLOCKED | Must |
| FR-12-11 | dirty shadow 记录 OBSERVED | Must |
| FR-12-12 | 审计写失败必须导致请求失败 | Must |

## 6.13 FR-13 授权管理

| ID | 需求 | Priority |
|---|---|---|
| FR-13-01 | 授权类别仅限 L3_SKIP/L3_REDACTED_CONTINUE/L3_ALLOW_AUDITED | Must |
| FR-13-02 | 默认无授权 | Must |
| FR-13-03 | 授权读取失败按无授权处理 | Must |
| FR-13-04 | 用户、会话、操作人使用单向哈希 | Must |
| FR-13-05 | 授权写入必须原子 | Must |
| FR-13-06 | 授权目录和文件权限受控 | Must |
| FR-13-07 | 授权按 user/session 隔离 | Must |
| FR-13-08 | 授权文件不得保存临床数据值 | Must |

## 6.14 FR-14 审计轮转与留存

| ID | 需求 | Priority |
|---|---|---|
| FR-14-01 | JSONL 追加写入 | Must |
| FR-14-02 | 单文件阈值 10MB | Must |
| FR-14-03 | 轮转使用原子 replace | Must |
| FR-14-04 | 最多保留 5 个归档 | Must |
| FR-14-05 | 超过上限删除最旧归档 | Must |
| FR-14-06 | 当前文件与归档权限 0600 | Must |
| FR-14-07 | 目录权限 0700 | Must |
| FR-14-08 | 并发写入不丢记录 | Must |
| FR-14-09 | 轮转后新记录必须写入当前文件 | Must |

## 6.15 FR-15 Web UI 品牌白标

| ID | 需求 | Priority |
|---|---|---|
| FR-15-01 | title 替换为品牌名 | Must |
| FR-15-02 | application-name 替换为品牌名 | Must |
| FR-15-03 | PWA name 替换为品牌名 | Must |
| FR-15-04 | PWA short_name 替换为品牌短名 | Must |
| FR-15-05 | favicon 使用品牌资产 | Must |
| FR-15-06 | 动态文本持续监控 | Must |
| FR-15-07 | DeepSeek 大小写变体替换 | Must |
| FR-15-08 | DeepSeek Harness 替换 | Must |
| FR-15-09 | 独立 DSH 替换 | Must |
| FR-15-10 | 品牌名长度和字符校验 | Must |
| FR-15-11 | HTML escape | Must |
| FR-15-12 | JSON script 注入防护 | Must |
| FR-15-13 | manifest 和 favicon 使用 exact route | Must |
| FR-15-14 | disposer 清理 tap 和 routes | Must |

## 6.16 FR-16 配置管理

| ID | 需求 | Priority |
|---|---|---|
| FR-16-01 | profile config 优先于环境变量默认值 | Must |
| FR-16-02 | mode 支持 enforce/shadow/disabled | Must |
| FR-16-03 | disabled 双审批字段必填 | Must |
| FR-16-04 | maxScanRows 范围校验 | Must |
| FR-16-05 | Python 可配置 | Must |
| FR-16-06 | 品牌名和短名可配置 | Must |
| FR-16-07 | 审计和授权 root 可配置 | Must |
| FR-16-08 | 用户和会话授权键可配置 | Must |
| FR-16-09 | 无效配置 fail-fast | Must |
| FR-16-10 | 配置值不得进入日志原文 | Must |

## 6.17 FR-17 打包与安装

| ID | 需求 | Priority |
|---|---|---|
| FR-17-01 | 发布 npm tarball | Must |
| FR-17-02 | 包含 JS 源码 | Must |
| FR-17-03 | 包含 Python 安全源码 | Must |
| FR-17-04 | 包含 Excel 提取器 | Must |
| FR-17-05 | 包含品牌资产 | Must |
| FR-17-06 | 包含 Cordis patch | Must |
| FR-17-07 | 包含 README | Must |
| FR-17-08 | 不包含测试数据 | Must |
| FR-17-09 | 不包含审计数据 | Must |
| FR-17-10 | 不包含字节码 | Must |
| FR-17-11 | 不包含 `.env` 或凭据 | Must |
| FR-17-12 | peer dependencies 声明官方运行能力 | Must |
| FR-17-13 | 发布包生成 SHA-256 指纹 | Must |
| FR-17-14 | 安装态必须能导入并执行 clean stream | Must |

## 6.18 FR-18 Listing 工作台宿主能力继承

DSH Web App 提供以下基础工作台能力。Emerald Clinical 不修改其源码，但必须保证这些能力触发的工具调用和模型请求全部经过本插件安全边界。

| ID | 需求 | Priority |
|---|---|---|
| FR-18-01 | 支持本地工作区和项目目录选择 | Must |
| FR-18-02 | 支持会话创建、继续和历史访问 | Must |
| FR-18-03 | 支持用户输入 Listing 需求、规范和任务指令 | Must |
| FR-18-04 | 支持 agent 执行 Listing 规范、代码和文档辅助生成 | Must |
| FR-18-05 | 支持工具调用结果进入会话上下文 | Must |
| FR-18-06 | 支持交付物和工作区文件查看 | Must |
| FR-18-07 | 支持模型/provider 配置和选择 | Must |
| FR-18-08 | 支持多 agent / workflow 执行时所有子请求进入同一安全边界 | Must |
| FR-18-09 | 宿主 UI 语言、主题、布局和交互保持 DSH 官方行为 | Should |
| FR-18-10 | 宿主能力产生的模型请求必须走 `llm/stream` | Must |
| FR-18-11 | 宿主能力产生的工具调用必须走 tools guard/pre/post | Must |
| FR-18-12 | 不通过修改宿主前端实现任何业务功能 | Must |
| FR-18-13 | 不因白标脚本破坏宿主布局、交互或动态渲染 | Must |
| FR-18-14 | 不因安全插件导致 clean 工作流不可用 | Must |

验收标准：

1. 创建会话、发起 Listing 任务、调用工具、查看交付物的正常路径可用。
2. clean 请求可透传。
3. dirty 工具和 dirty 模型请求被阻断。
4. workflow / 多 agent 的每个模型请求都有独立审计指纹。
5. 白标后 UI 无可见 DeepSeek/DSH 品牌残留。

## 7. 数据需求

## 7.1 输入数据类型

| 类型 | 来源 | 安全等级 | 处置 |
|---|---|---|---|
| 用户需求文本 | UI 输入 | 低 | 允许，但需 DLP 扫描 |
| Listing 规范文本 | 文档/用户 | 低到中 | DLP 扫描 |
| `.sas7bdat` | 临床数据 | 高 | 只返回元数据占位 |
| `.xlsx` | 临床数据 | 高 | 只返回表头结构 |
| `.xls` | 临床数据 | 高 | 只返回表头结构 |
| `.csv` | 临床数据 | 高 | 只返回表头结构 |
| `.zip` | 可能含数据 | 高 | 不解压，占位 |
| 工具参数 | Agent/用户 | 中到高 | quick guard + pre-execute |
| 工具结果 | 工具执行 | 中到高 | post-execute 替换或脱敏 |
| 模型请求 | DSH agent loop | 高 | 完整出域扫描 |
| 审批上下文 | host/session | 中 | 哈希后审计 |
| 凭据 | 环境/host | 禁止 | 不进入日志和模型 |

## 7.2 输出数据

| 输出 | 接收方 | 要求 |
|---|---|---|
| guard reason | DSH | 无原值 |
| deny reason | DSH/用户 | 无临床值和底层异常 |
| 安全工具结果 | Agent/模型 | 只有结构或脱敏值 |
| L3 prompt | 用户 | 位置、模式、脱敏证据 |
| egress audit | 本地审计文件 | 无请求原文 |
| AI ops audit | 本地审计文件 | 无原始参数 |
| authz record | 本地授权文件 | 无原始身份和临床值 |
| Web UI | 本地用户 | Emerald Clinical 品牌 |
| 发布包 | 企业交付 | 可复现、无敏感数据 |

## 7.3 数据保留与销毁

1. 当前审计文件按月命名。
2. 达到 10MB 轮转。
3. 最多 5 个归档。
4. 企业备份策略必须在系统外定义。
5. 审计归档恢复和销毁流程属于运维需求。
6. `.env`、审计数据、运行数据不得进入 Git 或发布包。

## 8. 接口需求

## 8.1 DSH 官方接口

| 接口 | 方向 | 数据 | 要求 |
|---|---|---|---|
| `ctx.tools.guard(exec)` | 输入 | ToolExecution | 返回 string/undefined |
| `tools/pre-execute(exec,next)` | 输入 | ToolExecution | deny 或 next |
| `tools/post-execute(exec,result,next)` | 输出 | ToolExecution + Result | accept 新 value 或 next |
| `llm/stream(options,next)` | 输出 | GenerateOptions | async generator |
| `webServer.tapIndex(html)` | UI | index html | 返回品牌化 html |
| `webServer.register(route)` | UI | exact route | 返回 disposer |
| `ctx.approval.request(payload)` | UI | L3 决策请求 | 仅 allowed-once 继续 |

## 8.2 Python Worker 协议

请求：

```json
{"requestId":"req-1","operation":"check_llm","payload":{},"context":{}}
```

响应：

```json
{"requestId":"req-1","ok":true,"action":"allow"}
```

通用规则：

1. 一行一个 JSON。
2. 每行请求必须 flush。
3. 响应必须回传 requestId。
4. `ok:false` 表示安全拒绝或不可用。
5. 错误 reason 必须是稳定枚举描述。

## 8.3 Excel 提取器 CLI

调用形式：

```text
python excel_header_extractor.py <file> [sheet] --max-scan-rows <n>
```

输出：

```json
{"file":"redacted-name.xlsx","sheets":[...]}
```

退出码：

1. 0 成功。
2. 1 文件读取或解析失败。
3. 2 依赖缺失。

要求：

1. stdout 只输出 JSON。
2. stderr 不包含临床值。
3. 超时必须终止。
4. 超时或非法 JSON 返回 `CHECK_FAILED`。

## 9. 安全需求

## 9.1 数据红线

| 编号 | 红线 |
|---|---|
| R-1 | `.sas7bdat` 数据行不得进入 LLM 消息 |
| R-2 | Excel/CSV 数据区单元格值不得进入 LLM 消息 |
| R-3 | 用户或模型指令不能覆盖安全处置 |
| R-4 | base64、图片、未知 content block、畸形消息默认拒绝 |
| R-5 | 无后门开关；disabled 必须审批 |
| R-6 | 日志、审计、错误回执不得包含临床值、凭据或原始身份 |
| R-7 | 模型请求任意键名和任意嵌套字段必须进入扫描 |
| R-8 | 所有无路径工具结果必须脱敏，不得按工具名豁免 |
| R-9 | worker 不可用时必须 fail-closed |
| R-10 | 安全模式下生产验收必须使用 enforce |

## 9.2 模式策略

| 模式 | 工具危险操作 | 工具结果替换 | LLM 出域 | 用途 |
|---|---|---|---|---|
| enforce | 阻断 | 替换/脱敏 | 阻断 | 生产默认 |
| shadow | 观察 | 不替换 | 观察 | 试运行和调优 |
| disabled + 双审批 | 阻断 | 不替换 | 不阻断 | 受控应急 |

## 9.3 绕过防护

系统必须防护以下绕过场景：

| 编号 | 绕过场景 |
|---|---|
| BY-01 | base64 编码载荷 |
| BY-02 | 图片或未知 content block |
| BY-03 | 畸形 messages |
| BY-04 | 非 messages 字段携带敏感值 |
| BY-05 | 宽泛上下文豁免 |
| BY-06 | 全字符串伪装表头 |
| BY-07 | 横向 Excel 首列数据 |
| BY-08 | 数值受试者编号 |
| BY-09 | worker 缺失 |
| BY-10 | pickle 别名 |
| BY-11 | base64 shell |
| BY-12 | 零宽字符 |
| BY-13 | 非 read 工具名无路径结果 |
| BY-14 | 敏感对象键名 |
| BY-15 | 未知顶层字段 |

## 10. 非功能需求

| 编号 | 需求 | 目标 | 验收 |
|---|---|---|---|
| NFR-1 | 正常请求性能 | <10ms | 单元测试统计 |
| NFR-2 | 正常请求误拦率 | <1% | 100 个合成正常请求 |
| NFR-3 | 请求审计覆盖率 | 100% | clean/dirty 均新增 |
| NFR-4 | 安全模块行覆盖率 | >=90% | coverage 报告 |
| NFR-5 | 变异杀死率 | >95%，目标 100% | mutation runner |
| NFR-6 | 审计磁盘上限 | 当前 + 5 x 10MB | 轮转测试 |
| NFR-7 | 无新增监听端口 | 是 | 契约与运行验证 |
| NFR-8 | 完整模型请求字段覆盖 | 除 signal 全覆盖 | 官方类型驱动测试 |
| NFR-9 | 审计零数据 | 无原文/值/凭据 | 合成标记扫描 |
| NFR-10 | 一键启动时间 | 首次依赖安装除外，常规启动可交互 | 本地计时 |
| NFR-11 | Python worker 常驻 | 是，不做每请求冷启动 | 生命周期测试 |
| NFR-12 | Excel 提取超时 | 10s 内终止 | 超时测试 |
| NFR-13 | 审计并发 | 不丢记录、不串 requestId | 并发测试 |
| NFR-14 | 插件清理 | 无孤儿 worker/route/listener | dispose 测试 |
| NFR-15 | 企业可复现 | Git 克隆 + 锁文件安装成功 | 干净环境测试 |
| NFR-16 | 可诊断性 | 错误码稳定且不泄露数据 | 错误矩阵 |
| NFR-17 | 兼容性 | DSH 0.1.0-rc.6 官方契约 | 契约测试 |
| NFR-18 | 本地绑定 | 127.0.0.1 only | 网络验证 |

## 11. 异常与错误码需求

| 错误码/标识 | 触发 | 用户/系统行为 |
|---|---|---|
| `SECURITY_UNAVAILABLE` | worker 不可用、协议失败、内部异常 | fail-closed |
| `UNKNOWN_OPERATION` | 未知 worker operation | 拒绝，不放行 |
| `EGRESS_VIOLATION` | LLM 请求命中 BLOCK | 请求前抛错 |
| `DANGEROUS_OPERATION` | 工具/命令/代码高危 | pre-execute deny |
| `CHECK_FAILED` | 文件安全检查失败 | 返回安全占位 |
| `BLOCKED` | 脱敏失败 | 返回安全占位 |
| `USER_DECISION_REQUIRED` | L3 敏感组合 | 返回三选项提示 |
| `INVALID_CONFIG` | 配置非法 | 插件启动失败 |
| `DEPENDENCY_MISSING` | 环境或依赖缺失 | 启动脚本终止并提示 |

错误消息要求：

1. 包含稳定错误码。
2. 可包含 audit id。
3. 不包含临床值。
4. 不包含凭据。
5. 不包含未脱敏路径。
6. 不包含 Python 底层异常原文。

## 12. 配置项需求

| 配置 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| mode | `DATA_PROTECTION_MODE` | enforce | 安全模式 |
| approvalId | `DATA_PROTECTION_APPROVAL_ID` | 空 | disabled 必填 |
| approvedBy | `DATA_PROTECTION_APPROVED_BY` | 空 | disabled 必填 |
| maxScanRows | `MAX_SCAN_ROWS` | 20 | 表头扫描上限 |
| python | `PYTHON` | python/python3 | worker 解释器 |
| brandName | `EMERALD_BRAND_NAME` | Emerald Clinical | 品牌名 |
| brandShortName | `EMERALD_BRAND_SHORT_NAME` | Emerald | 品牌短名 |
| userId | 无 | anonymous | 审计上下文 |
| authorizationRoot | 无 | 项目内默认 | 授权根 |
| authorizationUser | 无 | 空 | 授权用户键 |
| authorizationSession | 无 | 空 | 授权会话键 |
| 无 | `EMERALD_PYTHON` | 空 | 启动脚本基础 Python |
| 无 | `DSH_HOME` | 项目 `.dsh` | DSH home |
| 无 | `NPM_CONFIG_CACHE` | 项目 `.cache/npm` | npm cache |
| 无 | `PIP_CACHE_DIR` | 项目 `.cache/pip` | pip cache |
| 无 | `DSH_TELEMETRY_MODE` | DISABLED | telemetry |
| 无 | `PYTHONDONTWRITEBYTECODE` | 1 | 禁止字节码 |

## 13. 测试与验收需求

## 13.1 测试层级

| 层级 | 必测内容 |
|---|---|
| 单元测试 | 识别、组合、脱敏、审计、授权、性能、误报、轮转 |
| 集成测试 | 插件事件、工具结果、LLM stream、shadow、fail-closed |
| 品牌测试 | title、manifest、favicon、动态文本、disposer |
| 契约测试 | manifest、patch、peer、inject、五个扩展点 |
| 项目契约 | start、项目内路径、无 proxy、无 `.tools`、相对 link |
| 绕过矩阵 | BY-1..BY-15 |
| 变异测试 | 关键安全逻辑 mutant 全 killed |
| 安装态 | profile 导入、版本、inject、clean stream |
| HTTP 验收 | `/`、manifest、favicon |
| 干净环境 | Git 克隆一键启动 |
| 并发验收 | worker、审计、轮转并发 |

## 13.2 必须存在的验收用例

| 编号 | 场景 | 预期 |
|---|---|---|
| TC-01 | clean LLM stream | 透传并审计 |
| TC-02 | messages 含受试者 | adapter 前阻断 |
| TC-03 | system 含受试者 | adapter 前阻断 |
| TC-04 | tools 描述含受试者 | adapter 前阻断 |
| TC-05 | stop 含受试者 | adapter 前阻断 |
| TC-06 | 任意未知字段值含受试者 | adapter 前阻断 |
| TC-07 | 任意键名为受试者 | adapter 前阻断 |
| TC-08 | base64 临床载荷 | 阻断 |
| TC-09 | 零宽受试者 | 阻断 |
| TC-10 | image block | 阻断 |
| TC-11 | 畸形 messages | 阻断 |
| TC-12 | SAS 文件 | 只返回占位 |
| TC-13 | ZIP 文件 | 只返回占位 |
| TC-14 | XLSX 表头 | 无数据区值 |
| TC-15 | XLS 表头 | 无数据区值 |
| TC-16 | CSV 表头 | 无数据区值 |
| TC-17 | 横向表 | 无数据区值 |
| TC-18 | 数值受试者 | 无原值 |
| TC-19 | read 工具无路径结果 | 脱敏 |
| TC-20 | 非 read 工具无路径结果 | 脱敏 |
| TC-21 | 危险工具 | deny |
| TC-22 | 危险 bash | deny |
| TC-23 | pickle 别名 | deny |
| TC-24 | base64 shell | deny |
| TC-25 | AST 危险代码 | deny |
| TC-26 | L3 prompt | 三选项 |
| TC-27 | L3 allowed-once | 继续并授权 |
| TC-28 | L3 拒绝 | deny |
| TC-29 | worker 缺失 | fail-closed |
| TC-30 | shadow dirty | 观察不阻断 |
| TC-31 | 审计 clean/dirty | 均有记录 |
| TC-32 | 审计文件 | 无合成标记 |
| TC-33 | 授权文件 | 无原始身份 |
| TC-34 | 审计轮转 | 5 个归档上限 |
| TC-35 | UI title | Emerald Clinical |
| TC-36 | manifest | name/short_name 正确 |
| TC-37 | favicon | 无 DeepSeek 标识 |
| TC-38 | 动态 DSH 文本 | 替换 |
| TC-39 | 插件 dispose | 无残留 |
| TC-40 | 干净克隆启动 | 成功 |
| TC-41 | Listing 会话正常创建与执行 | 工作台基础能力可用 |
| TC-42 | workflow / 多 agent clean 子请求 | 全部透传且逐请求审计 |
| TC-43 | workflow / 多 agent dirty 子请求 | 任一敏感子请求阻断 |
| TC-44 | 宿主工作区与交付物查看 | 功能可用且无安全旁路 |

## 13.3 发布门禁

发布前必须全部满足：

1. 单元测试全绿。
2. 集成测试全绿。
3. 品牌测试全绿。
4. 插件契约测试全绿。
5. 项目交付契约全绿。
6. 绕过矩阵全绿。
7. 变异杀死率不低于 95%，目标 100%。
8. JS 语法检查全绿。
9. Python 编译检查全绿。
10. 安装态冒烟全绿。
11. `start.ps1 -Check` 全绿。
12. HTTP 白标验收全绿。
13. 干净 Git 克隆一键启动验收全绿。
14. 发布包 SHA-256 和文件清单归档。
15. 无 `.env`、审计数据、字节码、测试数据进入发布包。

## 14. 运维需求

1. 插件日志必须结构化并包含稳定错误码。
2. 审计目录必须纳入企业备份和访问控制。
3. 运维必须能通过归档文件恢复审计。
4. 磁盘接近轮转上限时必须有企业告警。
5. 生产运行必须使用 enforce。
6. shadow/disabled 使用必须有审批记录和时间窗口。
7. DSH 版本升级前必须先跑插件契约测试。
8. Python/Node 版本升级必须重跑一键启动和安装态测试。
9. 安全规则更新必须同步 BY 矩阵和 mutation oracle。
10. 发布包指纹必须留存。

## 15. 可追踪性要求

每个代码变更必须提供：

1. 需求 ID。
2. 实现文件。
3. 测试用例。
4. 安全影响说明。
5. 配置影响。
6. 文档更新。
7. 发布包影响。

需求变更必须同步：

1. 本需求规格。
2. 主规格。
3. 开发计划。
4. README。
5. 插件契约测试。
6. BY 绕过矩阵。
7. mutation oracle。

## 16. 术语表

| 术语 | 定义 |
|---|---|
| DSH | DeepSeek Harness 本地 AI 宿主 |
| Cordis | DSH 插件/profile 装载机制 |
| Listing | 临床试验交付表格或报表 |
| Egress | 数据离开本地边界进入模型 adapter 的行为 |
| CDISC | 临床数据交换标准 |
| SDTM | Study Data Tabulation Model |
| ADaM | Analysis Data Model |
| L3 | 最高风险等级的敏感数据决策 |
| Fail-closed | 安全组件失败时拒绝继续 |
| Canonical JSON | 键排序、紧凑、稳定编码的 JSON |
| Shadow mode | 只观察不阻断 |
| Worker | Node 插件调用的常驻 Python 安全进程 |

## 17. 需求完整性声明

本文覆盖以下功能域：

1. 一键启动与环境管理。
2. 标准 DSH 插件架构。
3. 工具输入防护。
4. AI 危险操作防护。
5. SAS/ZIP/Excel/CSV 处置。
6. 表头结构识别。
7. 无路径结果脱敏。
8. 完整模型请求扫描。
9. 智能识别算法。
10. 分级脱敏。
11. L3 审批与授权。
12. 审计与轮转。
13. UI 白标。
14. 配置管理。
15. 打包与安装。
16. 异常与错误码。
17. 非功能需求。
18. 测试与验收。
19. 运维需求。
20. 需求追踪。
21. DSH 宿主 Listing 工作台继承能力。

若后续新增功能、文件格式、模型字段、模型 provider、审批策略或审计要求，必须先追加需求 ID 和验收用例，再进入实现。
