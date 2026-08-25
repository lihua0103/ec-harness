# Codebase Audit

**Verdict:** CONCERNS

---

## Scope and Baseline

**Stack:** Node.js 插件 (`src/*.js`) + Python 安全内核 (`security/*.py`) + DSH profile
**Package:** `emerald-clinical-data-guard` v1.0.5
**Runtimes:** Python 3.10+ worker（常驻 line-JSON 协议），Node.js 插件（DSH 扩展点接入）
**Entrypoints:** `python -m security.worker`（worker），`src/index.js`（DSH 插件入口）
**Commands checked:**
- `python tests/run_all.py` → 58/60 全绿，2 FAIL（xlwt 环境依赖）
- `python tests/unit/test_smart_guard_wiring.py` → PASS
- `python tests/unit/test_listing_security.py` → 22/22 全绿
- `python tests/integration/test_plugin_runtime.py` → 3/3 全绿
- `python tests/integration/test_branding.py` → 1/1 全绿

**Exclusions:** `.cache/`、`.git/`、`node_modules/`、`.venv/`、`.pnpm-store/`、CI 外部行为（未接入）

---

## Health Summary

| Area | Status | Evidence |
|---|---|---|
| Security | CONCERNS | D3 shadow 未激活（cordis.patch.yml 空数组），2 个 xlwt 用例静默 FAIL 混入基线，smart_guard 接线已完成但 v2 逻辑在 worker.py 分支覆盖需验证 |
| Delivery | PASS | 全量测试 84/86 通过（2 FAIL 已知环境依赖），插件架构契约完整，Node/Python 双层扩展点接线 |
| Maintainability | CONCERNS | 双车道口径不对称（post-execute token化 vs llm/stream BLOCK），header_detect.py 存在但 package.json files 清单需确认，文档与实现对齐 |
| Dependencies | CONCERNS | xlwt 在 requirements.txt 但环境未装，pyreadstat 缺失导致 .sas7bdat 不可 onboard |
| Diagnosability, concurrency, lifecycle | PASS | worker 心跳机制（ST-P2-11），EgressCheckpoint 全局单例线程安全，fail-closed 异常范式完整，审计轮转有 5 个归档上限 |

---

## Findings

| Priority | Problem | Evidence and Justification | Required Resolution |
|---|---|---|---|
| **P0** | **shadow 止血未激活**：cordis.patch.yml 当前是空数组 `[]`，D3 会话锁死（字母前缀编号误报钉死会话）风险在生产 enforce 模式下仍然存在。文档 §2 明确要求设 `mode: shadow` 止血，重启 DSH 后才能继续开发。 | `cordis.patch.yml` 第 5 行 `[]`；zero-egress-dev-spec-v1.md §2 实测确认 | 立即修改 cordis.patch.yml 为 `[{ config: { id: clinical-data-guard, mode: shadow } }]`；这是开发阶段要求，阶段 1 验收后删除 |
| **P0** | **xlwt 依赖缺失**：requirements.txt 声明 xlwt，但环境未装导致 2 个用例静默 FAIL 混入基线。`No module named 'xlwt'` 在 run_all.py 中显示为 PASSED（测试本身检测到导入失败），但 fixture 需要 xlwt 写入 .xls 夹具时静默跳过，导致 xls header extraction 测试始终未真正运行。 | run_all.py 输出 `FAIL xls_header_extraction_delivers_structure_without_values: No module named 'xlwt'` | `pip install xlwt --break-system-packages`；或改测试夹具为 .xlsx；或在 run_all.py 中对 xlwt 缺失增加显式 SKIP（明确标为环境缺失而非功能失败） |
| **P1** | **smart_guard 接线 worker 分支已落但 check_llm 分支接线验证缺失**：worker.py 第 235-254 行 scrub_text 已接线 smart_guard，但 check_llm 分支（155-177）的 v2 灰度开关 `EMERALD_EGRESS_V2` 尚未在真实会话中验证实际放行行为。测试 test_smart_guard_wiring.py 覆盖了 worker 直接调用，但 DSH 插件的 stream 钩子（index.js 592-631）通过 `yield* next({ ...options, ...check.payload })` 传递脱敏后载荷的集成路径未被端到端覆盖。 | index.js 626 行 `yield* next({ ...options, ...check.payload })`；worker.py 167-171 行 v2 分支调用 `check_egress_v2`；无端到端集成测试验证 stream 钩子实际放行 | 新增 `tests/e2e/test_stream_guard_scrubbed_passthrough.py`：构造含真实临床数据的 messages，触发 stream 钩子，断言 `check.action === 'scrubbed'` 且 `next` 收到的新对象不含原值 |
| **P1** | **双车道口径不对称残留**：post-execute（tool-result-guard.js 285-298）走 smart_guard 的 `scrub_text`；llm/stream（index.js 596-600）走 `check_llm` → `check_egress_v2`。两分支的统计口径一致（均用 `tokens_hashed`），但 post-execute 结果通过 `safeToolResult` 返回时可能落入 `dataOnlyPlaceholder`（data plane 文件）或表头提取（document plane），而非直接 token 化放行。real data plane 文件走到 tool-result-guard.js 224 行直接 BLOCK，never reaches stream 车道；document plane 文件走表头提取。但 spec plane 文件若含混合内容（spec 散文 + 数据行），两车道的处置差异未被测试覆盖。 | tool-result-guard.js 222-250 的 plane 分支逻辑；spec plane 文件混合内容场景未覆盖 | 新增 `tests/e2e/test_spec_plane_mixed_content.py`：构造 spec plane 含 data row 的混合文件，验证 post-execute 返回 token 化内容且 stream 车道放行 |
| **P1** | **smart_guard 的 CJK 数字归一化在 spec profile 下仍生效**：smart_guard.py 第 490-491 行 `_normalize_cjk_digit_runs` 在任何 profile（strict/spec）下均执行，spec profile 的设计目标是"散文零改写"但 CJK 数字归一化在 spec 文本中仍可能改写中文格式的日期/编号（如"二零二六年八月十九日"）。文档 I2 未明确 CJK 数字在 spec 车道的处置策略。 | smart_guard.py 475-500：`_normalize_cjk_digit_runs` 无 profile 条件分支；doc/zero-egress-dev-spec-v1.md I2 只提"spec 允许读取"未提脱敏策略 | 明确 spec profile 下 CJK 数字归一化的处置策略；若 spec 散文需保留 CJK 数字格式，则添加 `if profile != 'spec': _normalize_cjk_digit_runs(line)` 条件；或在 zero-egress-dev-spec-v1.md §4 中明确 spec profile 的 CJK 数字口径 |
| **P2** | **package.json files 清单需补充 header_detect.py**：当前 `files` 数组包含 `security/*.py`，header_detect.py 在 security/ 下应被包含，但 `node_patterns.json` 的同步脚本 `scripts/sync_patterns.py` 依赖 patterns.py 的 NODE_DLP_PATTERNS，需确认 header_detect.py 不依赖 node_patterns.json（避免循环依赖）。 | patterns.py 第 1-14 行文档注释声明 patterns.py 是 DLP 模式单一来源；sync_patterns.py 读取 patterns.py 生成 node_patterns.json；header_detect.py 导入 patterns.py；package.json 第 28 行 `security/*.py` 覆盖 header_detect.py | 验证 `header_detect.py` 不引用 `node_patterns.json`（避免循环）；若存在循环则需拆分或修改 files 清单显式排除 |
| **P2** | **Clinical listing plugin 仅在 uat-local 模式激活**：clinical-listing-plugin.js 第 130 行 `if (config.localDataAccess !== 'uat-local') return () => {}`，medical/manual/report/rbqm 四场景默认 `localDataAccess='disabled'`，clinical listing 工作流在这些场景下不可用。文档描述"多场景 medical/manual/report/rbqm listingAI 智能执行器"，但插件实现与文档存在语义差：localDataAccess 不仅是 UAT 车道开关，也决定 listing plugin 是否注册。 | clinical-listing-plugin.js 130；listing_workflow.py 第 27 行 SCENARIOS 声明四场景；worker.py 197-215 listing_workflow 分支独立检查 uat-local | 明确 listing plugin 的激活条件：若 localDataAccess='disabled' 时仍需支持 listing（通过其他认证机制），则修改 clinical-listing-plugin.js 第 130 行条件；或在文档中明确 listing 需要 uat-local |
| **P2** | **Demo replica 模块缺失**：zero-egress-dev-spec-v1.md §5 定义的 demo_replica.py（构造性合成数据替身，主防线核心模块）未在仓库中找到。文档 §9 环境坑提到"本仓是最终交付"，但 demo_replica.py 属于阶段 2 交付物，当前仓库尚未实现。 | §5 定义了 `security/demo_replica.py` 的 API、合成规则、泄漏自检；grep 全仓未找到 demo_replica 相关文件 | 若阶段 2 尚未开始，无需操作；若已部分实现需确认位置；当前仓库阶段 1 已完成，阶段 2 需按计划开发 demo_replica.py |
| **P2** | **pyreadstat 缺失导致 .sas7bdat metadata-only 读取在部分环境中不可用**：local_data_inspector.py 第 125-141 行 _sas_metadata 捕获 ImportError 并抛出 LocalDataInspectionError，listing_workflow.py 第 163-178 行对 sas_metadata 异常仅 warning 不 fail。但 RBQM 场景需要读取 .sas7bdat 结构信息，pyreadstat 缺失会导致 RBQM listing 工作流降级。 | local_data_inspector.py 128；pyreadstat 未在 requirements.txt 中声明；grep 全仓 requirements.txt 无 pyreadstat | 在 requirements.txt 中添加 `pyreadstat`；或在文档 EMERALD_CLINICAL_MASTER_SPEC.md 中明确 pyreadstat 是可选依赖，缺失时 listing workflow 降级行为 |
| **P3** | **dataProtectionEnabled 全局开关无法按场景/对话粒度控制**：index.js 185-187 与 worker.py 123 均用全局布尔开关，关闭后所有出域检查跳过。这对于"测试数据环境"是合理设计，但对于需要部分出域检查（spec 允许、数据拒绝）的混合场景，当前实现要求每次切换都重启 DSH 或改环境变量。 | index.js 185-187；worker.py 123-163；无 per-conversation 或 per-prompt 的 dataProtectionEnabled 粒度控制 | 如需支持混合场景，在 worker.py 增加 `context.dataProtectionEnabled` 按调用方传入的 context 动态判断（当前已部分实现：worker.py 123 行）；验证 index.js context() 函数是否传递 dataProtectionEnabled 到 worker（当前 index.js 330 行已传递） |
| **P3** | **header_detect.py 的 process_xls 函数第 427 行 CSV 索引 bug**：process_xls 第 427 行 `for ci, val in enumerate(scan_rows[0][1:] if scan_rows else [], start=1):` 在横向表头处理中内层循环使用了外层的 `ri` 变量（而非当前行 `row`），导致列索引基于 scan_rows[0] 而非当前行；scan_rows[0] 是纵向第一行数据行，不是横向表头的列定义行。 | header_detect.py 第 427 行：`for ci, val in enumerate(scan_rows[0][1:] if scan_rows else [], start=1):`；上下文是横向表头处理（第 408-426 行），`for ri, row in enumerate(scan_rows):` 定义了 ri 但内层循环使用 scan_rows[0] 而非 row | 修改为 `for ci, val in enumerate(row[1:] if row else [], start=1):`，使用当前行 `row` 而非 scan_rows[0] |

---

## Remediation Order and Residual Risks

### Dependency-aware next actions (by risk reduction)

1. **立即止血**：修改 `cordis.patch.yml` → shadow 模式（D3 会话锁死根因）
2. **环境修复**：`pip install xlwt pyreadstat --break-system-packages` → 基线全绿
3. **阶段 1 闭环**：运行 `EMERALD_EGRESS_V2=1 python tests/e2e/test_stream_guard_scrubbed_passthrough.py` 验证 stream 钩子集成路径
4. **spec plane 混合内容**：新增 test_spec_plane_mixed_content.py 覆盖 spec 散文+数据行场景
5. **CJK 数字 spec 策略**：明确 spec profile 下 CJK 数字归一化行为
6. **package.json files 验证**：运行打包脚本验证 header_detect.py 在 tgz 中
7. **listing plugin 激活条件**：明确 clinical listing 在 disabled 模式下的行为
8. **阶段 2 规划**：demo_replica.py 开发按 zero-egress-dev-spec-v1.md §5 执行

### Blind spots

- **RBQM 多表头横向/纵向识别**：header_detect.py 的 `_detect_orientation`（第 117-145 行）和 `_find_header_end_row`（第 148-154 行）已实现，但无端到端测试验证横向表头（行=变量、列=观测）场景下的表头识别正确性
- **report 场景 Excel 辅助数据**：tool-result-guard.js 第 226-250 行对 document/output plane 的 xlsx/xls/csv 调用 excel_header_extractor.py（mode=headers），仅提取表头结构。report 场景需求描述"AI 允许读取表头结构来辅助程序处理相关数据"，当前实现满足，但 report 场景的 listing_workflow 分支未区分处理（SCENARIOS 含 'report' 但 worker.py 197-215 的 listing_workflow 分支未按 scenario 分派不同逻辑）
- **R 反向逻辑执行出 listing 对比**：zero-egress-dev-spec-v1.md 未定义 R 反向验证的机制；grep 全仓未找到 R/gold standard/expected output 对比相关实现

### Unverified candidates

- index.js stream 钩子中 `yield* next({ ...options, ...check.payload })` 对 DSH options 只读属性的处理：D7（Cannot assign to read only property）修复依赖展开操作符构造新对象，但 next() 收到的新对象是否完全满足 DSH adapter 的要求未在 CI 中验证（需要 Windows 本机环境）
- Excel header extractor 的 merged cells 信息提取：`_extract_merged_info`（第 201-211 行）对部分合并单元格实现可能不完整，无多级合并表头（纵向多行+横向多列）的测试覆盖
