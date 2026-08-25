# Listing Specification 与最小数据边界修复报告

## 结论

本轮实现已按最新架构收敛：安全层只对以下两类来源建立硬边界：

1. 真实 SAS 数据集：`.sas7bdat`、`.xpt`、`.sas7bcat`；
2. `doc` 固定目录外的 Excel：`.xlsx`、`.xlsm`、`.xls`、`.xlsb`。

`doc` 内 Excel 被视为规格/文档内容，允许 harness 读取完整文本；Listing 规格理解、场景判断、计划组织和业务执行不再由额外的 report-specific 文件名规则限制。

## 已完成修改

### 来源平面

`src/planes.js` 现在遵循以下判定：

- SAS 扩展名无论所在目录均为 `data`；
- workspace 内嵌套的 `doc`、`docs`、`document` 目录内文件为 `document`；
- `doc/spec`、`doc/als`、`doc/template` 等规格子目录为 `spec`；
- `doc` 目录外 Excel 为 `data`；
- 移除依据 `Page_Details`、`PROD`、`crViewer` 等文件名猜测 `report_support_data` 的逻辑。

### 工具结果边界

`src/tool-result-guard.js` 现在保证：

- SAS/XPT 真实内容不返回模型，仅返回数据域占位结果；
- `doc` 外 Excel 不返回 cell 数据，仅返回结构信息；
- `doc` 内规格/文档内容保留完整正文，并通过可信文档 token 在模型请求前后安全恢复；
- 本地处理程序可以读取 SAS/外部 Excel；面向模型的结果仍只返回占位符或结构信息；
- `print`、stdout/stderr、日志和 job output 不得承载真实 records：`bash`/`pwsh`/`shell`/`exec`/`read`/`job_output` 等工具在只带 `command`（无显式路径参数）时，从命令串正则提取 SAS/外部 Excel 源路径并把结果降级为占位符，同时打上 `protectedDataSource` 来源标记交由出境检查兜底；
- 该命令串车道只在 `extractPath()` 取不到显式路径时生效，`read_file` 等带 `path` 的调用仍走原有表头/结构投影，不会被降级；
- `.csv` 不属于用户界定的两类受保护数据（真实 SAS 数据集、`doc` 外 Excel），因此不在命令串来源识别范围内；
- metadata-only receipt 可继续作为 harness 控制信息使用。

### 出境检查

`security/egress_checkpoint.py` 增加了来源标记检查：

- `protectedDataSource=sas`：硬阻断；
- `protectedDataSource=external_excel`：硬阻断；
- `protectedDataSource=doc_excel`：原样通过；
- 普通 harness 指令不再因包含临床字段名称而被自动改写。

## 验证证据

以下命令均在当前工作区新鲜执行并退出码为 0：

- `node tests/unit/planes_cases.mjs`：PASS；
- `node --check src/index.js`：PASS；
- `node --check src/tool-result-guard.js`：PASS；
- `node --check src/planes.js`：PASS；
- `python -m pytest tests/unit/test_egress_v2_fix.py tests/unit/test_smart_guard_wiring.py tests/unit/test_listing_e2e_fixes.py tests/unit/test_listing_security.py tests/unit/test_listing_plan_contract.py -q`：93 passed，3 warnings；
- `python -m pytest tests/integration/test_plugin_runtime.py -k "plane_data or protected_source" -q`：2 passed；
- `python -m pytest tests/unit/test_egress_v2_fix.py tests/unit/test_listing_e2e_fixes.py tests/unit/test_listing_security.py tests/unit/test_listing_plan_contract.py -q`：93 passed，3 warnings；
- `python -m pytest tests/integration/test_plugin_runtime.py -q`：33 passed，2 warnings（含新增 `test_local_output_projection_hides_real_records`）；
- `node tests/unit/planes_cases.mjs`：PASS；
- 反向验证：临时禁用 `LOCAL_OUTPUT_TOOL_RE` 后 `test_local_output_projection_hides_real_records` 立即失败（真实值 `010-001-1001` 回流），恢复后转 green，确认投影分支是生效原因；
- `python -m compileall -q security tests`：PASS；
- `npm pack --dry-run --json --cache .npm-cache`：PASS，生成包预览 `emerald-clinical-data-guard@1.0.7`，34 个文件；
- `git diff --check`：PASS，无 whitespace error。

警告仅包括 openpyxl 的 `datetime.utcnow()` 弃用警告，以及一个既有的 pytest collection warning，不影响本轮测试结果。

## 未完成或需明确标记的事项

### 1. Node→worker `protectedDataSource` 已完成端到端接线

`src/tool-result-guard.js` 会在受保护来源的工具结果中写入随机 token 绑定的 provenance 标记：

- SAS：`protectedDataSource=sas`；
- `doc` 外 Excel：`protectedDataSource=external_excel`。

`src/index.js` 仅接受当前进程生成的随机 token，扫描模型请求中的可信工具结果标记，并将来源写入 `check_llm` context。伪造普通文本、缺少 token 或 token 不匹配时不会建立来源标记。

Python worker 继续由 `check_egress_v2()` 对上述两个来源执行硬阻断；因此工具结果投影之外，模型出境检查本身也形成独立的 Node→worker 防线。

新增集成回归覆盖 SAS 与 `doc` 外 Excel 的真实 roundtrip，证明两类来源均在 `llm/stream` 阶段被阻断。

### 2. 完整真实项目 Listing 产物验证未纳入本轮完成声明

以下旧范围未被包装为已完成：

- `CGB3002-TEST` 完整 Listing 全链路；
- medical 项目完整 Listing 全链路；
- RBQM 项目完整 Listing 全链路；
- 最终 workbook 的真实项目结构检查。

这些业务验证应在 harness 读取规格文本并自主生成执行计划后单独运行，不应通过继续增加安全层业务补丁解决。

### 3. Excel extractor 的扩展名覆盖仍需后续统一

来源平面已覆盖 `.xlsx`、`.xlsm`、`.xls`、`.xlsb`，但当前 structure-only extractor 分支的实现覆盖集合仍需进一步统一检查，尤其是 `.xlsm` 和 `.xlsb` 的结构读取失败时应保持 fail-closed，不能回传原始 cell 内容。

## 拦截点全量盘点（2026-08-23）

判定依据是用户反复澄清的边界：只拦"读取 data 数据输出给 AI"，程序本地读取与处理数据全部放绿通道；体量不构成任何拦截理由；出域不做 token 化（token 化会让 AI 无法理解 spec 需求）。

盘点方法：grep 穷举 `security/` 下所有 `raise (EgressViolation|DangerousOperationBlocked|PermissionError|RuntimeError|ValueError)`，逐个判定。

| 拦截点 | 判据 | 判定 |
|---|---|---|
| `ai_operations_monitor.py` 四个 check 入口的 `raise DangerousOperationBlocked` | `threat.recommendation == "BLOCK" or risk_level >= HIGH` | 曾是错误拦截，本轮已修（见下） |
| `egress_checkpoint.py` `check_egress_v2()` | 仅 `protectedDataSource in {sas, external_excel}` | 符合边界，唯一权威出域判据 |
| `egress_checkpoint.py` v1 `check()` | 内容形态 + 体量 | 生产链路不可达：全库无任何代码读取 `EMERALD_EGRESS_V2`，`worker.py` 只 import 并调用 `check_egress_v2`；`checkpoint.check(` 其余调用仅存在于测试与模块自检。不构成生产误拦，按"不启用，先不删"保留 |
| `data_egress_guard.py` `scan_xlsx_sheet_safe(max_rows=200)` | 扫描行数上限 | 非拦截判据：超限只追加"剩余 N 行未扫描"提示，不抛异常。符合边界 |
| `listing_inspector.py` 109/114/116 `raise ValueError` | 参数校验 | 非数据拦截，符合边界 |
| `worker.py` 408 `raise` | JSON 格式校验 | 非数据拦截，符合边界 |
| `local_data_inspector.py` 六处 `LocalDataInspectionError` | 路径策略、文件类型、依赖缺失 | 非按内容形态阻断，符合边界 |
| `egress_authz.py` | 无抛出点，纯授权记录读写 | 无拦截判据 |
| `tokenizer.py` / `header_detect.py` | 无抛出点、无体量阈值 | 无拦截判据；`tokenizer` 已不被出域检查调用 |
| `path_policy.py` `MAX_ARCHIVE_RATIO = 200` | 压缩比 | zip bomb 防护，与临床数据无关，符合边界 |

### 本轮修掉的三类错误判据

1. **体量判据**：`is_mass_data_dump()` 恒 `False`；`worker.py` 的 `scrub_row` / `scrub_text` 不再调用它，`needs_user` 恒 `False`（函数本体按"不启用，先不删"保留）。同时修掉 `test_smart_guard_wiring.py` 中断言"250 行必须判为 mass dump"的用例。
2. **出域 token 化**：`check_egress_v2()` 载荷原样透传，不再调用 `smart_scrub_structure()`。
3. **本地准入的内容形态识别**：
   - `DANGEROUS_PATH_PATTERNS` 5→2 条，移除 `\.sas7bdat$`、`output.*\.xlsx$`、`docment/.*/data/`；
   - `DANGEROUS_CODE_PATTERNS` 6→2 条，移除 `pd\.read_sas` / `pd\.read_excel` / `load_workbook` / `open\(.*sas7bdat`；
   - `DANGEROUS_BASH_PATTERNS` 移除 `python.*read_sas|read_excel`、`\|\s*python`（管道到 Python）等本地执行条目；
   - `_assess_code_threat()` 的 AST 层：`pd.read_*` 关键词由 `["expected","sas7bdat","output"]` 收窄为 `["expected"]`，`open()` 由 `["expected","sas7bdat",".pkl"]` 收窄为 `["expected",".pkl"]`；
   - `DANGEROUS_TOOLS` 移除 `read_sas_folder` 与 `read_sas_columns`（按 ALS 字段查询 SAS 结构是必经入口，返回结构而非 data 数据）；
   - `src/index.js` 的 `tools/pre-execute` 不再在读取级别拦截，同步改写集成用例 `test_reading_sas_is_allowed_at_pre_execute`。

### 仍保留拦截的场景及理由

- `cat` / `head` / `tail` / `strings` / `xxd` / `od` / PowerShell `Get-Content` 等读数据文件：内容直接写 stdout，工具结果即进入 AI 上下文，等价于"读取 data 数据输出给 AI"；
- `pickle.load` 及其别名/动态导入变体：任意代码执行面，与读取临床数据无关；
- `expected*.xlsx` 读写、`read_expected_output`：标准答案；
- `peek_data_values`：语义就是把真实数据值呈现给 AI；
- 真实 SAS records 与 doc 外 Excel data 进入模型：由工具结果投影与 `check_egress_v2` 两道独立防线负责。

### 本轮验证证据

- `python tests/unit/test_security.py`：66/66；
- `python tests/run_all.py`：`TOTAL_FAILED_SUITES=0`（13 个套件，含 e2e、bypass 与两个 Node 套件）；
- 反向验证（本地准入名单）：备份后临时加回 `\.sas7bdat$` / `pd\.read_sas` / `load_workbook\s*\(`，`test_security.py` 掉到 63/65 且失败原因精确复现两个误拦（`代码含危险模式: pd\.read_sas`、`SAS数据集`），恢复后全绿；
- 反向验证（`DANGEROUS_TOOLS`）：临时加回 `read_sas_folder: HIGH`，`sas_metadata_tools_are_allowed` 立即失败于"工具 read_sas_folder 在危险工具列表中"，恢复后 `TOTAL_FAILED_SUITES=0`。

### 已知残余问题（未纳入完成声明）

- `test_full_model_request_scope_blocks_and_audits_clean_requests` 在 `pytest tests/unit tests/integration` 一次性并行跑时会因共享审计目录竞争而 sha256 不匹配；单独跑 integration 或走 `run_all.py` 均通过。属测试隔离问题，非本轮修复引入；
- `src/planes.js` 中 `.csv` 的归类与其他扩展名不一致，未处理。

## 当前状态

- 本轮最小数据边界改动：已实现并通过相关单元、集成、语法、编译和打包验证；
- Listing 业务能力：未因本轮范围收敛而宣称完整真实项目验收；
- 工作区：保留现有 staged、unstaged 和 untracked 改动，未执行 reset、clean 或 commit。
