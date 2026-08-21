# Checklist

## P1 红线验收

- [x] `shouldReplaceResult` 不含工具名 `read` 白名单；`fetch_database` + 无路径 + 合成受试者标记的结果被替换（真 TC-20 / BY-13 通过）
- [x] 带路径未知扩展名（`.xpt`）工具结果强制脱敏（BR-03.4）
- [x] 任意顶层/嵌套敏感键名（如 `A1234567`）在 enforce 下于 `next()` 前阻断（R-7 / FR-09-03）
- [x] 审计 `payload_fields` 只含已知字段白名单，未知字段为哈希；审计文件中搜索不到合成键名原文（R-6 / FR-12-05）
- [x] worker 异常回执不含 `str(exc)` 原文与本地路径；extractor stderr/输出文件名已脱敏（R-6 / 8.3）
- [x] post-execute SENSITIVE 不再把三选项作为工具结果交给 Agent；无审批通道时 BLOCKED（R-3 / 5.5）
- [x] 授权类别与用户选择一致；`L3_ALLOW_AUDITED` 仅当次有效并被检查侧消费（FR-13 / TC-27）
- [x] `write_file` 写入恶意 Python 代码被 AST 检查阻断；`import pickle as p`、`from pickle import load` 被识别（FR-03-13/15 / TC-25）
- [x] worker 收到非法 JSON 行后返回 `SECURITY_UNAVAILABLE` 且继续服务后续请求（AR-2.6）
- [x] `SecurityRuntime.request` 超时生效；stdin EPIPE 后 worker 被 kill 且全部 pending 被拒绝（R-9）
- [x] 审计并发写入测试通过：双进程追加 + 轮转不丢记录、无截断 JSON 行、归档 ≤5（BR-06.10 / TC-34）

## P2 一致性验收

- [x] `inspect_file` 覆盖全部 sheet 且使用配置 `maxScanRows`
- [x] `.xls` 按选定口径交付：xlrd 解析出表头结构（TC-15）
- [x] extractor 超时可配置（默认 10s / 上限 30s）+ 优雅终止（NFR-12）
- [x] 审计记录中 session/user 身份哈希非空串哈希（BR-06.5）
- [x] 轻度脱敏覆盖 `[CODE]`、美式/中文日期、USUBJID 复合格式（FR-11）
- [x] METADATA evidence 不含原始单元格文本
- [x] 授权记录与审计记录可通过统一哈希上下文关联
- [x] `.gitignore` 不再忽略 `cordis.yml`；profile 清单与锁文件可被 Git 跟踪（AR-4）
- [x] Git 仓库已初始化；干净克隆 + `start.ps1` 一键启动成功（TC-40 / BG-5）※ git init + `start.ps1 -Check` 全绿；远程干净克隆待有 remote 后复验
- [x] `normal_request_is_fast` 恢复 PASS（NFR-1 <10ms）

## P3 工程验收

- [x] worker 心跳生效：kill worker 后自动重启或 3 次 ping 失败标记 degraded
- [x] 模式库一致性校验进入测试，人工修改 `patterns.py` 未同步时测试失败
- [x] base64 候选最小长度 ≥24，误报测试集不回归（NFR-2 <1%）
- [x] MutationObserver 无重复写回，宿主页面无变异风暴（FR-18-13）
- [x] 审计/授权 root 可配置且默认不在插件包内（FR-16-07）
- [x] pre-execute 与 post-execute 路径键提取一致（5 键）
- [x] `strings` 读数据文件被阻断（FR-03-10）；`_assess_tool_threat` 无重复死代码
- [x] `temp_check.py` 已删除或正式化；`registerBranding` 缺服务时 fail-fast；MASTER_SPEC 变异数为 10

## 发布门禁

- [x] `tests/run_all.py`：`TOTAL_FAILED_SUITES=0`（连续 3 轮）
- [x] 变异测试 ≥95% killed（目标 100%），含 FIX-1/FIX-2/FIX-4 新 mutant（10/10 = 100%）
- [x] 项目契约、`start.ps1 -Check`、安装态冒烟全绿
- [x] 审计/授权 JSONL 合成标记扫描通过：无原文、无凭据、无原始身份（TC-32/33）
- [x] 发布包 SHA-256 与文件清单重新归档（FR-17-13）※ SHA-256: FEEEFA8CEAF9ACE9E4FF515A08866F6C5822EF0B24437F4720E6744B89ABECC6

## 真实项目复测（CGB3002-TEST，2026-08-19 修复后）

首轮 12 项修复未经真实项目验证，实际运行暴露 4 个新缺陷，已修复并回归：

- [x] worker stdout 遇 `\udcae` 孤立代理崩溃（用户报错"一炮就报错"）→ `clean_surrogates` 出口统一清洗 + `_emit` 编码失败兜底，worker 存活继续服务
- [x] crViewer.xls 无表头数据表被整表判为"表头"泄露 124 行受试者数据（`num_ratio==0.5` 边界不扣分）→ 修复后仅输出 2 行标题，`data_start_row=2`
- [x] `08 Jun 2026 05:19:50`（Rave/EDC 临床日期）检测与脱敏双侧不识别 → 月份枚举模式入库，带时间成分判 BLOCK；轻度脱敏改为循环模式库消除双轨漂移
- [x] worker `inspect_file` 对 .xls 用 openpyxl 必失败（真实 .xls 预检不可用）→ xlrd 路径 + SpreadsheetML XML 伪装 .xls fail-closed
- [x] 前导零受试者号（01001，EDC 形态）单元格级脱敏
- [x] 端到端验证：spec xlsx / crViewer.xls / PROD.xls(XML) / sas7bdat / llm-dirty / fetch-database 全场景 ALL_PASS，受试者级零泄露（站点代码为 spec 报告分组维度，非受试者标识）
- [x] 回归：run_all TOTAL_FAILED_SUITES=0、变异 10/10=100%、单测 37/37
