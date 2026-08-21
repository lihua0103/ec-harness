# Tasks

## 阶段一：P1 红线修复（阻塞发布）

- [x] Task 1: FIX-1 工具结果过滤去白名单（src/tool-result-guard.js）
  - [x] 1.1 `shouldReplaceResult` 移除工具名含 `read` 的前置条件：无路径 → true；危险扩展名 → true；带路径未知扩展名 → true
  - [x] 1.2 补充测试：非 read 工具名（`fetch_database`）无路径含合成受试者标记必须被替换（真 TC-20 / BY-13）
  - [x] 1.3 补充测试：带路径未知扩展名（`.xpt`）结果强制脱敏

- [x] Task 2: FIX-2 模型请求键名扫描与审计字段白名单（security/egress_checkpoint.py）
  - [x] 2.1 `scan_structured` 对任意 dict 键名调用 `scan_text`
  - [x] 2.2 `payload_fields` 改为 GenerateOptions 已知字段白名单，未知字段记录 `sha256` 截断哈希
  - [x] 2.3 `threats_summary.location` 键路径脱敏
  - [x] 2.4 补充测试：顶层/嵌套敏感键名阻断 + 审计无键名原文（TC-06/07 强化）

- [x] Task 3: FIX-3 错误消息统一脱敏（worker.py / tool-result-guard.js / patterns.js / excel_header_extractor.py）
  - [x] 3.1 Python 侧新增 `sanitize_error`（路径→`[PATH]`、受试者模式→`[SUBJ]`、截断），应用于 worker 全部异常分支
  - [x] 3.2 Node 侧 `redactSensitiveText` 增加路径脱敏，应用于 `detail` 拼接处
  - [x] 3.3 extractor stderr 不打印原始路径/异常原文，输出 `file` 字段脱敏
  - [x] 3.4 补充测试：含合成标记路径的失败回执无路径与标记

- [x] Task 4: FIX-4 L3 决策真实化（src/index.js / src/tool-result-guard.js / security/egress_authz.py）
  - [x] 4.1 post-execute SENSITIVE 改走 `ctx.approval.request`，无审批通道时返回 BLOCKED
  - [x] 4.2 授权类别按用户选择写入；`L3_ALLOW_AUDITED` 仅当次有效（消费后移除或不落盘持久类别）
  - [x] 4.3 检查侧消费 `authorized_categories`
  - [x] 4.4 补充测试：Agent 无法自决、授权一次性语义（TC-26/27/28 强化）

- [x] Task 5: FIX-5 AI 代码检查接线（security/ai_operations_monitor.py / security/worker.py）
  - [x] 5.1 `write_file`/代码类工具的 Python 内容接入 `check_python_code`
  - [x] 5.2 AST 补 `import pickle as x`、`from pickle import load` 别名识别
  - [x] 5.3 补充测试：写入恶意 .py 被阻断、pickle 别名被阻断（TC-25 / BY-10 强化）

- [x] Task 6: FIX-6 worker 健壮性（security/worker.py / src/index.js）
  - [x] 6.1 修复非法 JSON 行 `UnboundLocalError`；畸形行返回 `SECURITY_UNAVAILABLE` 且进程继续服务
  - [x] 6.2 `SecurityRuntime.request` 增加超时（默认 30s，可配置）
  - [x] 6.3 stdin 写入失败（EPIPE）标记 worker 损坏：kill 进程并拒绝全部 pending（Claude P2-4）
  - [x] 6.4 补充测试：畸形行后服务连续、超时 fail-closed

- [x] Task 7: FIX-7 审计并发锁（security/audit_log.py）
  - [x] 7.1 实现跨平台文件锁（Unix `fcntl` / Windows `msvcrt`），轮转与追加在锁内
  - [x] 7.2 补充并发测试：双进程并发追加 + 轮转不丢记录、无截断行、归档 ≤5（TC-34 / NFR-13）

## 阶段二：P2 一致性与交付修复

- [x] Task 8: FIX-8 Excel 链路收敛（worker.py / excel_header_extractor.py / tool-result-guard.js）
  - [x] 8.1 `inspect_file` 遍历全部 sheet 并使用配置 `maxScanRows`
  - [x] 8.2 `.xls` 支持：引入 `xlrd` 固定版本只读解析，或先修订需求为 fail-closed 口径（二选一，需先定）
  - [x] 8.3 extractor 超时可配置（默认 10s，上限 30s），SIGTERM→2s→SIGKILL
  - [x] 8.4 补充测试：多 sheet 预检、`.xls` 正向用例（TC-15）或 fail-closed 断言

- [x] Task 9: FIX-9 审计上下文与脱敏补齐（egress_checkpoint.py / ai_operations_monitor.py / data_egress_guard.py / egress_authz.py / src/index.js）
  - [x] 9.1 统一上下文键名，使 session/user 哈希真实生效
  - [x] 9.2 轻度脱敏补 `[CODE]`、美式/中文日期、USUBJID 复合格式，与检测模式同步
  - [x] 9.3 METADATA 行 evidence 去原始单元格文本
  - [x] 9.4 授权与审计使用统一哈希上下文（HMAC 或统一 salt），可关联
  - [x] 9.5 补充测试：身份哈希非空、轻度脱敏覆盖编码与多日期格式

- [x] Task 10: FIX-10 交付闭环（.gitignore / 仓库初始化 / 性能）
  - [x] 10.1 修正 `.gitignore`：`!.dsh/profiles/clinical/cordis.yml`，确认 profile 清单/锁文件可跟踪，按 AR-4 处理 workspace 文件
  - [x] 10.2 初始化 Git 仓库，干净克隆实测 `start.ps1` 一键启动（TC-40）
  - [x] 10.3 定位并修复 `normal_request_is_fast` 性能回归（NFR-1 <10ms）

## 阶段三：P3 工程优化

- [x] Task 11: FIX-11 健壮性增强
  - [x] 11.1 worker ping/pong 心跳（30s 间隔，5s 超时，3 次失败重启）（Claude P2-1）
  - [x] 11.2 `node_patterns.json` 与 `patterns.py` 一致性校验纳入测试（Claude P2-3）
  - [x] 11.3 base64 候选最小长度提升（≥24）降低误报（Claude P2-7）
  - [x] 11.4 MutationObserver 仅在值变化时写回 + ≥100ms 防抖（Claude P2-6）

- [x] Task 12: FIX-12 配置与清理
  - [x] 12.1 审计/授权 root 可配置（FR-16-07），默认项目级目录
  - [x] 12.2 pre-execute 路径键与 `extractPath` 对齐（path/file_path/filePath/filename/file）
  - [x] 12.3 危险 bash 模式补 `strings`；清理 `_assess_tool_threat` 重复死代码
  - [x] 12.4 删除或正式化 `tests/e2e/temp_check.py`；`registerBranding` 缺 webServer 时 fail-fast；MASTER_SPEC 变异数同步为 10

## 阶段四：发布门禁回归

- [x] Task 13: 全量回归验证
  - [x] 13.1 `tests/run_all.py` 全绿（含 NFR-1 性能用例）
  - [x] 13.2 变异测试 10/10 killed，新增 mutant 覆盖 FIX-1/FIX-2/FIX-4
  - [x] 13.3 项目契约 + `start.ps1 -Check` + 安装态冒烟全绿
  - [x] 13.4 审计/授权文件合成标记扫描：无原文、无凭据、无原始身份（TC-32/33）

# Task Dependencies

- Task 4 依赖 Task 1（post-execute 流程建立在修复后的过滤入口上）
- Task 9.4 依赖 Task 4（授权消费语义先确定）
- Task 11.1 依赖 Task 6（worker 生命周期管理先稳定）
- Task 13 依赖 Task 1~12 全部完成
- 其余任务相互独立，可并行：Task 1/2/3/5/6/7/8/10 可并行推进
