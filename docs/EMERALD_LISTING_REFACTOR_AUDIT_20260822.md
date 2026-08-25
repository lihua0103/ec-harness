# Emerald Clinical Listing 重构完成度复审报告

**日期：** 2026-08-22（复审）
**类型：** HOTL Code Review（direct，最终裁决模型）
**审查范围：** 工作区相对基线 commit `56d8390`（baseline: pre-refactor snapshot 2026-08-20）的全部改动：51 文件，+6020/−1064；含 4 个新模块（listing_plan / listing_executor / listing_data_catalog / listing_inspector）与 JS 插件层、测试体系改动
**对照基线：** [EMERALD_LISTING_ROOT_CAUSE_ANALYSIS_20260822.md](EMERALD_LISTING_ROOT_CAUSE_ANALYSIS_20260822.md)（下称 RCA）提出的第 0 步架构修改、止血包 S1-S6、可用性修复 U1-U3
**关联文档：** [CODEBASE_AUDIT_DSH_GUARD_20260822_REMEDIATION.md](CODEBASE_AUDIT_DSH_GUARD_20260822_REMEDIATION.md)

---

## 1. Scope（含验证证据）

### 1.1 审查对象

RCA 第 0 步"计划-执行两段式"架构的真实落地情况，以及止血包/可用性修复的逐项核验。仓库只有一个基线 commit，全部改动在工作区（staged + unstaged），审查范围即工作区全量 diff。

### 1.2 本次复审独立执行的验证证据

| # | 验证动作 | 结果 |
|---|---|---|
| V1 | 真实 ALS 重解析（`spec_parser.parse_spec_document` 对 GQ1005-301 ALS） | 仍 `mappings: 0`——但新架构下 ALS 映射由 AI 经 inspect 车道生成计划，不再依赖 parser 穷举布局，**该指标已不再是阻断点**（旧 worker 车道仍受影响，见 W-4） |
| V2 | 全量测试基线 `python -B tests\run_all.py` | **TOTAL_FAILED_SUITES=2**（详见 F-8/F-9）；其余套件全绿（integration 28/28、resilience 3/3、bypass 13/13、scan_dlp 12/12、planes PASS、e2e 冒烟 PASS） |
| V3 | mutation 测试 | **10/10（100%）全部 KILLED** |
| V4 | 失败用例隔离复跑 | `tokenizer_is_idempotent_and_shared_by_both_lanes` 单跑 **PASS**（全套件内 FAIL → 顺序依赖/状态污染）；`test_reparse_point_escape_is_rejected` 单跑仍 FAIL（Windows symlink/junction 环境问题） |
| V5 | 真实项目产物核验（GQ1005-301 `.clinical-listing/output/medical/`） | **存在今天 19:35 生成的真实产物**：`MEDICAL_000_CONTENTS.xlsx`（Contents 目录页）+ `MEDICAL_001_REPLAY.xlsx`（REPLAY sheet，193 行 × 9 列；表头 = AE 域字段 AEENDAT/AESER/AESEV/AESTDAT/AETERM **+ spec 第 6 条要求的衍生列 Flag/Update Details/Review Comments/Initial/Date**）——证明新执行器已在真实 SAS 数据上跑通并落实了 spec 衍生列规则 |
| V6 | 生产环境故障核实（用户截图：RBQM_test 72 数据集） | **确认阻断**：`Error: security worker request timeout after 30000ms`，本轮运行失败（见 F-1） |
| V7 | receipt.json 检查 | 仍是旧版 `needs_input` 收据——**仓库内仍无新链路的 completed 收据**，V5 产物由直接调用产生而非完整插件链路留痕 |

### 1.3 止血包/可用性修复逐项核验（对照 RCA）

| 项 | 结论 | 证据与说明 |
|---|---|---|
| S1 shadow 激活 | **未落地（有意决策）** | `cordis.patch.yml` 仍 `mode: enforce`；REMEDIATION L16 明确不采纳 shadow（零出域合同优先） |
| S2 依赖声明 | ✅ 已落地 | 两份 requirements.txt 均有 `xlwt==1.3.0`、`pyreadstat==1.3.6` |
| S3 sheet 名黑名单 | **未落地** | data_egress_guard.py L219-223 五关键词原样保留；主流程绕开 inspect_file（index.js L591-598），但 worker 协议层 `inspect_file` 仍可达该车道 |
| S4 JS/Python 豁免对齐 | **未落地** | 正则已同步（11 条一致），但纯日期 WARN、SAS 日期字面量、token 区间三项豁免 JS 侧仍无；`write_file` 含 `2024-01-01` / `'01JAN2024'd` 仍被 quickGuard 拦死；sync_patterns.py 仍只同步正则不同步豁免 |
| S5 结构化 missing | **部分落地** | 落点在新 inspect 车道（listing_inspector.py L138），但粒度只有 `"specification"` 一种；数据集缺失/歧义只进 warnings 字符串；旧 needs_input 收据三处未改 |
| S6 横向表头坐标 | ✅ 已落地（按修正后口径） | RCA 原定位经复现改判（REMEDIATION L26），真实缺陷（CSV 写回坐标沿用末次 ri）已修，三格式回归测试锁定 |
| U1 ALS/EDC 表头白名单 | **部分落地** | FormOID/ItemOID 已收录；**PreText/ItemOrder/DatasetName/SASLabel 仍会被投影为 COLUMN_n** |
| U2 sheet 级放行 | **部分落地** | sheet 级分离实现在新 inspect 车道（spec_parser L575 + listing_inspector._safe_spec）；但 spec/document plane 通用读取通道仍是**文件级**整文放行，E4 型混排文件（spec 内嵌数据 sheet）经通用工具读取的缺口未堵 |
| U3 spec 不 token 化 | **部分落地（有意的偏差有记录）** | 主链路已落地（plane 原文透传 + v2 出域不改写载荷）；spec profile 的 CJK 数字归一化有意保留（REMEDIATION L20，有固化测试） |

---

## 2. Reviewed Dimensions

- **计划对齐（对照 RCA）**：第 0 步架构方向（AI 提交受限 IR → 本地校验 → 本地执行 → 白名单收据）**已真实落地**；止血包 6 项中 2 项落地、1 项有意不采纳、3 项未/部分落地；验收重建（V1-V5 真实回放门禁、可用性测试族、mutation 扩展、JS/Python 行为等价测试）**未实施**。
- **安全与可靠性**：plan IR 白名单校验（标识符正则、join 键双向存在性、未知属性拒绝、版本/场景强绑定）、ZIP 安全解压、凭据单行限制、收据脱敏——设计扎实，"数据值不出域"结构性成立；但发现 valueRef 执行语义缺陷（F-2）与 rowCount 预言机通道（F-4）等。
- **代码质量**：新发布路径丢失回滚保护（F-7）；validator 与 executor 存在三处语义不一致（F-3/F-5/F-6）；死代码若干（executor `_files()` 无人调用、SCENARIOS 重复定义、新旧 staging/backup 逻辑大段重复）。
- **测试覆盖**：plan 校验/执行的攻防面**零测试**（F-2 因此漏网）；测试隔离缺陷（F-8）；环境依赖用例失败（F-9）。
- **移除与简化**：旧 `listing_workflow` 操作与 `emerald_listing_generator`（含 `_require_medical_rule_provenance` 拦路逻辑）仍在 worker 协议层可达，形成新旧双轨（W-4）。

---

## 3. Findings

### BLOCK

- **[BLOCK] F-1: 生产环境 30 秒超时阻断真实 listing 运行** — `src/index.js:13`（`REQUEST_TIMEOUT_DEFAULT_MS = 30_000`）、`src/index.js:109-122`
  用户生产截图实证：RBQM_test 项目（72 个 SAS 数据集解压就位后）执行 rbqm 场景，工具调用以 `security worker request timeout after 30000ms` 失败、本轮运行中断。插件侧从未为 listing 重操作覆写 `timeoutMs`（`clinical-listing-plugin.js` 全文无 `timeoutMs`），inspect/catalog/execute 在大数据集上必然超过 30s。
  **Why:** 这是"进程中断，无法执行下去"的直接原因——架构对了但真实数据规模下跑不完。
  **Fix:** listing 三操作按操作类型设置超时（inspect/execute 建议 300s+ 或可配置 `requestTimeoutMs`），execute 支持进度心跳；并在超时时返回可重试的结构化收据而非裸 Error。

- **[BLOCK] F-2: valueRef 过滤语义错误——数据值与列名字符串比较，静默产出错误临床交付物** — `security/listing_executor.py:57-67, 85`（对照正确用法 `:99`）
  `_column()` 返回列名**字符串**，filter 分支 `right = _column(result, item["valueRef"])` 把数据值与列名比较：`eq` 静默返回空 listing、`ne` 静默返回全表。validator 明确放行 valueRef（listing_plan.py L175-176），属合法计划产生错误结果。
  **Why:** 临床 listing 的正确性缺陷，且**静默**——无任何报错信号。
  **Fix:** `result[_column(result, item["valueRef"])]`；并补 valueRef 端到端断言测试。

- **[BLOCK] F-3: plan 校验器/执行器攻防面零测试覆盖**
  全 `tests/` 检索 `validate_listing_plan / listing_executor / execute_listing_plan` 零命中。新增约 900 行测试全部落在**旧路径**回归。未覆盖：恶意计划（未知属性/数据集/字段、非法 join、超长 literal）、数据字面量通道（bool 冒充 number、>256 字符串）、validator↔executor 一致性（F-5/F-6）、valueRef 正确性（F-2）、发布回滚（F-7）。
  **Why:** 新架构最核心的安全边界（validator 是"死命令"的结构性保证）没有对抗性测试网。
  **Fix:** 为 listing_plan/listing_executor 建独立对抗性测试文件（合法/越界/混淆三族用例），纳入 run_all.py 门禁。

### WARN

- **[WARN] F-4: rowCount 回执 + 任意字面量 filter = 无上限存在性预言机** — `listing_plan.py:73-86,160-183`；`listing_executor.py:219`；`listing_workflow.py:144`；豁免点 `index.js:547-550, 607`
  AI 每次 execute 得到过滤后 rowCount，相当于"该值是否存在于该列"的 1-bit 预言机，次数无上限、无审计计数。数据值本身不出域（结构保证成立），但成员关系推断通道是设计内开放的。
  **Fix:** 显式决策：接受并限频+审计计数，或对 rowCount 分桶/阈值化；决策写入 REMEDIATION。

- **[WARN] F-5: validator 与 executor 的 filters/derivations 顺序不一致** — `listing_plan.py:141-183`（先 derivations 后 filters，允许 filter 引用派生列）vs `listing_executor.py:137-145`（先 filters 后 derive）
  合法计划执行期必然报 "validated field is unavailable"，"validated 即可执行"契约被破坏。
  **Fix:** 两侧统一为"先派生后过滤"（或 validator 禁止 filter 引用派生列），加一致性测试。

- **[WARN] F-6: sort 校验双向不一致** — `listing_plan.py:186-195, 210-216` vs `listing_executor.py:176-180`
  validator 允许任意可用字段排序、executor 要求排序列必须在输出列；反向地聚合输出列名未注册进 available，按聚合结果排序被 validator 拒绝。两个方向都有"合法计划被拒/非法计划被放行"。
  **Fix:** 统一排序列域定义（建议：输出列 ∪ groupBy 列 ∪ 聚合别名），注册聚合别名进 available。

- **[WARN] F-7: 新发布路径丢失回滚保护（健壮性回退）** — `listing_workflow.py:132-136`（新）vs `:341-357`（旧，有 rollback）
  `output→backup` 改名后若 `staging→output` 失败，异常上抛、旧产物留在孤儿 backup 目录不恢复。
  **Fix:** 恢复 try/except 回滚分支，补"备份清理失败降级"等价测试。

- **[WARN] F-8: 测试隔离缺陷——tokenizer 幂等性用例全套件运行时 FAIL、单跑 PASS** — `test_security.py::tokenizer_is_idempotent_and_shared_by_both_lanes`
  run_all 全量运行时断言"token 化非幂等"失败（V4）；单独运行 61/61 全 PASS。说明套件间存在共享状态污染（会话密钥/tokenizer 单例被先序用例改变）。
  **Why:** 幂等性是脱敏三大架构不变量之一；顺序敏感的失败会让 CI 门禁结果不可信。
  **Fix:** 定位污染源（哪个先序用例重置/复用了 tokenizer 会话），在用例 setup 中显式重置会话密钥。

- **[WARN] F-9: `test_reparse_point_escape_is_rejected` 在本 Windows 环境持续失败** — `tests/unit/test_listing_security.py:315-342`
  `symlink_to` 无权限后回退 `mklink /J` 报 "Cannot create a file when that file already exists"。路径越界保护本身由其他用例覆盖，此为测试环境/清理缺陷。
  **Fix:** mklink 前先防御性清理 `link`；或检测无权限时 skip 而非 FAIL。

- **[WARN] F-10: S4 未落地——正常 SAS/日期文本仍被 JS quickGuard 拦死**（详见 §1.3）
  写 SAS 程序含 `'01JAN2024'd`、写 spec 含 `2024-01-01` 仍被 quickGuard 拒绝；"脱敏误伤"主诉在通用编辑车道依然存在。
  **Fix:** scanDlp 增加与 Python 对齐的豁免（纯日期 WARN、SAS 字面量、token 区间），并纳入 sync_patterns.py 单一来源。

- **[WARN] F-11: 旧双轨残留——worker `listing_workflow` 操作与 medical provenance 拦路逻辑仍可达** — `worker.py:192-210`；`emerald_listing_generator.py:411-423,462`；默认生成器配置仍指向旧生成器（`listing_workflow.py:203`、`index.js:231-232`）
  插件虽不再注册旧工具，但 worker 协议层旧操作仍可被调用；新计划路径对 medical 场景不再有任何 New/Modified 基线与编码 Status 来源确认——若是有意放弃需文档明示，若是疏漏则是 medical 质量门禁回归。
  **Fix:** 决策：下线旧 worker 操作或将旧生成器仅作内部计划模板；medical 来源确认如保留应作为计划校验规则而非拦路异常。

- **[WARN] F-12: U2 缺口——document plane 通用读取仍是文件级整文放行**（详见 §1.3）
  E4 型混排文件（spec xlsx 内嵌 466 行数据 sheet）经通用 read_file 读取仍整文进模型上下文，且 maskTrustedDocuments 会让其绕开出域检查。
  **Fix:** TRUSTED_DOCUMENT_CONTENT 通道对 xlsx 启用 sheet 级剥离（复用 `_is_data_example_layout`）。

### NOTE

- **[NOTE] N-1 计划无资源上限**：outputs/joins/filters/derivations/columns 数量无上限，worker JSON 行无大小限制（worker.py L363-368）——本地 DoS/磁盘填满面。
- **[NOTE] N-2 非 ListingPlanError 逃逸**：`int(layout.get("freezeColumns"))`（listing_plan.py L227）对垃圾输入抛裸 ValueError，降级为 WORKFLOW_UNAVAILABLE，丢失结构化诊断。
- **[NOTE] N-3 statusFilter 无长度上限、不经 schema 校验**（listing_plan.py L227；executor 按列名大小写匹配任意 "status" 列）。
- **[NOTE] N-4 is_null/not_null 携带 literal 被静默丢弃**而非报错（listing_plan.py L174-183）。
- **[NOTE] N-5 派生运算 arity 未校验**：`date_diff_days` 单 ref 在执行期 IndexError（listing_executor.py L104）。
- **[NOTE] N-6 死代码/重复**：executor `_files()`（L49-54）无人调用；`_execute_output` 的 `project` 参数未使用；SCENARIOS 两处定义；新旧 staging/backup 逻辑重复。
- **[NOTE] N-7 归档数据集显示名含随机临时目录名**（listing_data_catalog.py L26-32 → listing_inspector.py L104-109 的 `archive/` 分支成死代码），AI 视图不稳定。
- **[NOTE] N-8 限定名碰撞边缘**：左表原生 `AE__CM` 列与 join 重命名规则冲突时 `_column("AE.CM")` 静默错列（listing_executor.py L129-136）。
- **[NOTE] N-9 count 语义不一致**：无 groupBy 含 NaN、有 groupBy 走 pandas `.count()` 不含 NaN（listing_executor.py L154-157）。
- **[NOTE] N-10 AI 可控文本写 Excel 存在公式注入面**：label/列名未拒绝 `= + - @` 前缀（listing_plan.py L203-206 → listing_executor.py L205-211），openpyxl 会把 `=` 开头存为公式，污染交付物。

---

## 4. What Was Not Covered

1. **生产项目 RBQM_test 不在本工作区**，无法在本环境复跑其 72 数据集场景；超时结论基于截图证据 + 代码确认（插件无 timeoutMs 覆写）。
2. **新链路完整插件路径（UI → 插件 → worker → execute → 持久化 completed 收据）未在真实数据上留痕**：V5 产物证明 executor 真实跑通，但 receipt.json 仍是旧版 needs_input，completed 收据的持久化路径未验证。
3. 旧 `emerald_listing_generator` 医疗场景的质量规则（编码 Status 过滤等）在新计划路径中的等价物未被业务确认。
4. JS 层 diff（index.js/tool-result-guard.js/planes.js）本轮以止血包核验为主，未做逐行安全评审。

## 5. Residual Risks

- F-1 修复前，**任何超过 30s 的真实项目都无法通过 UI 完成 listing**——这是当前最高优先级的用户阻断。
- F-2 修复前，使用 valueRef 过滤的 listing 会静默产出空表/全表，属于临床交付物正确性风险。
- F-4 的预言机通道在威胁模型上属于"设计内开放"，需要产品层面明确接受或收敛。
- 新旧双轨并存期间，误调旧 worker 操作会触发已被新架构取代的拦截/失败模式，造成"问题又回来了"的体感。
- U1 未覆盖的 ALS 列名投影问题不影响新 inspect 车道（该车道直接给真实字段名），但影响通用 Excel 读取车道的语义可读性。

## 6. Verdict

# **NOT READY**

**已真实完成（值得肯定）：**
- RCA 第 0 步的核心架构方向**已落地且设计扎实**：受限计划 IR + 白名单 validator + 本地 executor + 白名单收据，"SAS 数据值不出域"从内容识别升级为结构性保证；
- **首次在真实项目数据上产出了结构正确的 listing 产物**（V5：193 行 AE 域 + spec 衍生列，四衍生列与 spec 第 6 条逐字对应）；
- mutation 10/10、bypass 13/13、integration 全绿；S2/S6 落地；S1 不采纳有明确决策记录。

**阻断项（必须修复后方可 READY）：**
1. F-1 超时——真实规模下链路跑不完（用户正在因此被中断）；
2. F-2 valueRef 静默错误——临床产物正确性；
3. F-3 新架构攻防面零测试——validator 是死命令的唯一结构性保证，必须有用例网。

**需要决策项：** F-4（预言机通道）、F-11（旧轨下线 + medical 来源门禁取舍）、F-12（文件级放行缺口）。

**建议修复顺序：** F-1（超时，半小时级改动）→ F-2 + F-5/F-6（executor 一致性）→ F-3（对抗性测试网）→ F-7/F-8/F-9（健壮性与测试卫生）→ 决策项落定后处理 F-10/F-11/F-12。
