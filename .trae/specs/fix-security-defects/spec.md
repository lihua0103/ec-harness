# 数据红线缺陷统一修复计划 Spec

## Why

两份独立审计（Claude Opus 5 审计报告 `EMERALD_CLINICAL_CODEBASE_AUDIT_20260819.md` 与 TRAE 代码审查）共同确认：当前 `emerald-clinical-data-guard@1.0.4` 存在多个数据红线级缺陷，不能通过"数据红线无条件守住"的发布验收。本计划将两份审计的发现去重合并为一份可执行的修复规格。

判定来源：
- Claude 审计：P1-1（工具过滤不完整）、P1-2（审计竞态）、P1-3（错误消息泄露）+ P2-1~P2-7
- TRAE 审查：6 个 P1/P2 新发现（键名扫描缺口、AST 死代码、L3 Agent 自决、授权语义、worker 崩溃、审计上下文键名错位）+ 交付闭环缺口 + NFR-1 性能回归实测失败

## What Changes

### P1 红线修复（阻塞发布）

- **FIX-1 工具结果过滤去白名单**：`shouldReplaceResult` 不再按工具名含 `read` 放行；所有无路径结果强制 `scrub_text`；带路径但扩展名未识别的结果同样强制脱敏（合并 Claude P1-1 + TRAE #1/#14，对应 R-8、FR-07-02、BR-03.4、BY-13、TC-20）
- **FIX-2 模型请求键名扫描**：递归扫描对任意对象键名调用 `scan_text`；审计 `payload_fields` 改为已知 `GenerateOptions` 字段白名单，未知字段只记录 `sha256` 截断哈希或 `UNKNOWN:<n>`；`threats_summary.location` 不拼接原始键名（对应 R-6、R-7、FR-09-03、FR-12-05、TC-06/07）
- **FIX-3 错误消息统一脱敏**：worker 不再回传 `str(exc)` 原文；Node/Python 双侧提供路径与受试者模式脱敏函数；extractor stderr 与输出 `file` 字段脱敏（合并 Claude P1-3 + TRAE #11，对应 R-6、AR-2.9、8.3）
- **FIX-4 L3 决策真实化**：post-execute 命中 SENSITIVE 时不再把三选项作为工具结果交给 Agent 自决，改走 `ctx.approval.request`；无审批通道时 fail-closed；授权类别按用户选择写入（`L3_REDACTED_CONTINUE` / `L3_ALLOW_AUDITED`）；授权记录被检查侧消费，"允许并审计"仅当次有效（对应 R-3、5.5、FR-13、TC-26/27/28）
- **FIX-5 AI 代码检查接线**：`write_file`/代码执行类工具的 Python 内容接入 `check_python_code`；AST 分析补 `import pickle as x`、`from pickle import load` 别名识别（对应 FR-03-13/14/15、BY-10、TC-25）
- **FIX-6 worker 健壮性**：修复非法 JSON 行导致 `UnboundLocalError` 崩溃；worker 单行解析失败返回 `SECURITY_UNAVAILABLE` 并继续服务；`SecurityRuntime.request` 增加超时（默认 30s）与 stdin EPIPE 损坏标记（kill + 拒绝全部 pending）（合并 TRAE #6 + Claude P2-4，对应 AR-2.6/7、R-9）
- **FIX-7 审计并发安全**：`write_audit_record` 增加跨平台文件锁（Unix `fcntl` / Windows `msvcrt`），轮转与追加均在锁内完成（Claude P1-2，对应 BR-06.10、FR-14-08、TC-34、NFR-13）

### P2 一致性与交付修复

- **FIX-8 Excel 链路收敛**：`inspect_file` 遍历全部 sheet 并使用配置 `maxScanRows`；`.xls` 默认引入 `xlrd` 固定版本只读解析以交付 FR-06-03（若评审选择 fail-closed 口径，则先修订 FR-06-03/TC-15 再实施）；extractor 超时可配置（默认 10s，上限 30s）+ SIGTERM→SIGKILL 优雅终止（合并 TRAE #7/#20 + Claude P2-2，对应 FR-06-03、TC-15、NFR-12）
- **FIX-9 审计上下文与脱敏补齐**：统一上下文键名（Node `sessionId/userId` → Python 正确消费），身份哈希真实生效；轻度脱敏补 `[CODE]` 医学编码、美式/中文日期、USUBJID 复合格式；METADATA 行 evidence 不再含原始单元格文本；授权与审计使用同一哈希上下文可关联（合并 TRAE #8/#9/#10 + Claude P2-5，对应 BR-06.5、FR-11、R-6）
- **FIX-10 交付闭环**：修正 `.gitignore`（`cordis.yml` 恢复提交、profile 清单/锁文件可跟踪、按 AR-4 评估 workspace 文件）；初始化 Git 仓库并从干净克隆实测一键启动；修复 `normal_request_is_fast` 性能回归（NFR-1）（对应 AR-4、BG-5、TC-40、AF-03）

### P3 工程优化

- **FIX-11 健壮性增强**：worker ping/pong 心跳与自动重启（Claude P2-1）；`node_patterns.json` 与 `patterns.py` 一致性校验纳入测试（Claude P2-3）；base64 候选最小长度提升降低误报（Claude P2-7）；MutationObserver 值变化才写回 + 防抖（Claude P2-6 / TRAE #15）
- **FIX-12 配置与清理**：审计/授权 root 可配置（FR-16-07），默认指向项目级目录而非插件包内；pre-execute 路径键与 `extractPath` 对齐（5 键）；危险 bash 模式补 `strings`；删除 `temp_check.py` 或正式化；`registerBranding` 缺 webServer 时 fail-fast；同步 MASTER_SPEC 变异数（9→10）（合并 TRAE #16~#21 + AF-06/07/08）

## Impact

- Affected specs: 数据红线 R-1~R-10、FR-03/06/07/09/11/12/13/14/16、BR-03/05/06、NFR-1/12/13、BY-10/13/14/15、TC-06/07/15/20/25/26/27/28/34/40
- Affected code:
  - `dsh-clinical-data-guard/src/index.js`（worker 协议、超时、L3 审批、配置）
  - `dsh-clinical-data-guard/src/tool-result-guard.js`（过滤逻辑、错误脱敏、超时配置）
  - `dsh-clinical-data-guard/src/branding.js`（MutationObserver 优化、fail-fast）
  - `dsh-clinical-data-guard/src/patterns.js`（错误脱敏函数）
  - `dsh-clinical-data-guard/security/worker.py`（畸形行存活、错误脱敏）
  - `dsh-clinical-data-guard/security/egress_checkpoint.py`（键名扫描、审计字段白名单、上下文键名）
  - `dsh-clinical-data-guard/security/audit_log.py`（并发锁）
  - `dsh-clinical-data-guard/security/ai_operations_monitor.py`（代码检查接线、别名 AST、strings）
  - `dsh-clinical-data-guard/security/data_egress_guard.py`（脱敏补齐、evidence 去原文）
  - `dsh-clinical-data-guard/security/egress_authz.py`（授权消费、哈希上下文统一）
  - `dsh-clinical-data-guard/excel_header_extractor.py`（stderr/file 脱敏、.xls、超时）
  - `dsh-clinical-data-guard/tests/**`（补齐 TC-15/20/25/34 等盲区用例）
  - `.gitignore`、`docs/EMERALD_CLINICAL_MASTER_SPEC.md`

## ADDED Requirements

### Requirement: 非 read 工具结果强制脱敏
系统 SHALL 对所有未被文件类型明确处置的工具结果执行 `scrub_text` 脱敏，不论工具名是否包含 `read`。

#### Scenario: 非 read 工具名无路径结果
- **WHEN** 工具名为 `fetch_database` 且参数无可用路径，结果含合成受试者标记
- **THEN** post-execute 返回 `{kind:"accept", content}`，模型可见 content 中不含原值；保留工具自身 canonical value 以满足其 output schema

#### Scenario: 带路径但扩展名未知
- **WHEN** 工具结果路径为 `.xpt`/`.pdf` 等未识别扩展名
- **THEN** 结果强制进入脱敏流程，不直接放行

### Requirement: 对象键名出域扫描
系统 SHALL 对模型请求中任意嵌套对象键名执行与字符串值相同的 DLP 扫描。

#### Scenario: 敏感键名阻断
- **WHEN** 完整请求含顶层键 `A1234567` 或嵌套键含受试者编号
- **THEN** enforce 模式在 `next()` 前抛错，且审计中该键名仅以哈希形式出现

### Requirement: worker 畸形输入存活
系统 SHALL 在收到非法 JSON 行时返回 `SECURITY_UNAVAILABLE` 响应并继续处理后续请求。

#### Scenario: 畸形行后服务连续
- **WHEN** 向 worker stdin 写入一行非法 JSON，随后写入合法 `check_tool` 请求
- **THEN** 第一条返回 `SECURITY_UNAVAILABLE`，第二条正常响应

### Requirement: 审计并发写入
系统 SHALL 在多进程并发追加与轮转时不丢失审计记录。

#### Scenario: 并发追加 + 轮转
- **WHEN** 两个进程同时写入使当前文件超过 10MB
- **THEN** 全部记录保留于当前文件或归档中，无截断 JSON 行，归档数不超过 5

## MODIFIED Requirements

### Requirement: L3 用户决策流程（5.5）
post-execute 命中 SENSITIVE 时 SHALL 通过 `ctx.approval.request` 请求用户决策；宿主无审批通道时 SHALL fail-closed；仅 outcome 为 `allowed-once` 时继续；授权类别 SHALL 与用户选择一致（脱敏后继续 → `L3_REDACTED_CONTINUE`，允许并审计 → `L3_ALLOW_AUDITED`）；`L3_ALLOW_AUDITED` SHALL 仅当次有效并在检查侧消费。

#### Scenario: Agent 无法自决
- **WHEN** 无路径结果脱敏发现 SENSITIVE 行且宿主无审批通道
- **THEN** 返回 BLOCKED 占位，三选项不作为工具结果进入模型上下文

### Requirement: 错误消息要求（第 11 章）
worker 与 Node 错误回执 SHALL 先经路径脱敏（Windows/Unix 路径 → `[PATH]`）与受试者模式脱敏，长度截断；SHALL NOT 包含 `str(exc)` 原文、本地路径或临床值。

#### Scenario: 提取器异常
- **WHEN** Excel 提取器以包含合成受试者标记的路径失败
- **THEN** 返回 detail 不含路径片段与标记值

## REMOVED Requirements

无。本计划不移除任何既有需求；`.xls` 支持口径若选择 fail-closed 而非解析器，需先修订 FR-06-03/TC-15 再实施。

## 审计发现追踪映射

| 修复项 | Claude 审计 | TRAE 审查 | 需求/红线 |
|---|---|---|---|
| FIX-1 | P1-1 | #1、#14 | R-8、FR-07-02、BY-13、TC-20 |
| FIX-2 | —（审计盲点外新发现） | #2（=基线 AF-02）、#12 | R-6、R-7、FR-09-03、FR-12-05 |
| FIX-3 | P1-3 | #11（=基线 AF-05） | R-6、AR-2.9、8.3 |
| FIX-4 | — | #4、#5 | R-3、5.5、FR-13、TC-26/27/28 |
| FIX-5 | — | #3 | FR-03-13/14/15、BY-10、TC-25 |
| FIX-6 | P2-4 | #6 | AR-2.6/7、R-9 |
| FIX-7 | P1-2 | —（基线盲点已标注） | BR-06.10、FR-14-08、TC-34 |
| FIX-8 | P2-2 | #7（=AF-04）、#20 | FR-06-03、TC-15、NFR-12 |
| FIX-9 | P2-5 | #8、#9、#10 | BR-06.5、FR-11、R-6 |
| FIX-10 | — | #13、#14（=AF-03） | AR-4、BG-5、TC-40、NFR-1 |
| FIX-11 | P2-1、P2-3、P2-6、P2-7 | #15 | NFR-2、FR-18-13 |
| FIX-12 | — | #16~#21、AF-06/07/08 | FR-16-07、FR-03-10 |

说明：两份审计重叠发现（工具名白名单 = Claude P1-1 = TRAE #1；错误消息泄露 = Claude P1-3 = TRAE #11）已合并为 FIX-1/FIX-3，不重复立项。
