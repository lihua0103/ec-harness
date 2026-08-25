# DSH Guard 审计修复处置记录

本文对应 `CODEBASE_AUDIT_DSH_GUARD_20260822.md`，记录 2026-08-22 对审计发现的复核、修复和残余风险。原报告是审计时点证据；当报告与当前代码或安全合同冲突时，以复现结果、生产零出域目标和自动化验证为准。

## 修复原则

- 生产保持 `mode: enforce`，临床数据防泄露路径 fail-closed。
- Listing 业务能力统一由 DSH 插件编排；插件只向模型暴露规格定义、结构元数据和白名单收据。
- 完整医学 Listing 计算由企业审批的本地生成器负责，插件不复制临床记录、不构造患者级数据替身。
- 文件名、相对路径和规格声明保留业务可理解性；患者级记录、日期和标识符按策略 token 化。

## 审计发现处置

| 原优先级 | 原发现 | 当前处置 | 验证证据 |
|---|---|---|---|
| P0 | `cordis.patch.yml` 未启用 shadow | 原证据已过期，且不采纳生产 shadow 建议。当前配置为 `mode: enforce`；退回 shadow 会使命中仅记录而不阻断，违反零出域合同。 | 插件 `cordis.patch.yml`；全量 DLP、bypass 与 mutation 测试。 |
| P0 | `xlwt` 缺失导致 XLS 用例未执行 | 已在两份 requirements 中固定 `xlwt==1.3.0`，真实 XLS 横向结构测试已运行。 | Listing 安全测试 15/15，CSV/XLSX/XLS 横向坐标一致性用例通过。 |
| P1 | stream 脱敏透传未端到端验证 | 已通过 Node 集成驱动覆盖；测试冻结输入 options/messages，证明钩子创建新对象且不会修改 DSH 只读 GenerateOptions。 | 插件运行时测试 22/22。 |
| P1 | spec 混合内容双车道未覆盖 | 已覆盖规格定义保留、混入患者记录 token 化及 stream 放行安全载荷。结构读取不返回数据行。 | Listing 安全与插件运行时测试。 |
| P1 | spec 下 CJK 数字归一化 | 明确保留该行为，作为中文数字日期和编号的编码规避防线；“规格可理解”不等于患者级编码可原样出域。 | `test_spec_profile_normalizes_cjk_digits_before_release`。 |
| P2 | 打包可能遗漏 `header_detect.py` | `package.json` 的 `security/*.py` 已覆盖该文件；模块不读取 `node_patterns.json`，不存在报告怀疑的循环依赖。 | npm tarball 文件清单检查。 |
| P2 | Listing 仅在 `uat-local` 激活 | 保留为显式能力边界。`disabled` 时不注册本地数据工具，防止因默认配置意外开放数据域访问。 | 插件合同及运行时注册测试。 |
| P2 | 缺少 `demo_replica.py` | 不实现。患者级“替身”仍扩大敏感信息副本面，也可能误导模型或用户把合成结果视为真实 Listing。模型只接收白名单收据；插件合同明确禁止该模块。 | 插件合同测试断言模块不存在。 |
| P2 | `pyreadstat` 缺失或不兼容 | 两份 requirements 已升级并固定 `pyreadstat==1.3.6`，解决旧版 1.2.7 在 Python 3.13 无 wheel、需要本地 MSVC 编译的问题。 | Python 3.13 安装成功；`read_sas7bdat(metadataonly=...)` API 验证通过。 |
| P3 | `dataProtectionEnabled` 只能全局控制 | 原结论已过期。Node 调用上下文会把该值传给 worker；保护判定具备调用上下文粒度。生产配置仍不得关闭保护。 | worker context 接线与运行时测试。 |
| P3 | 横向表头坐标错误 | 报告定位到 XLS 分支不准确；复现出的真实缺陷位于 CSV 首行观测标签写回沿用末次 `ri`。已固定写回 `row: 0`。 | CSV/XLSX/XLS 三格式坐标回归测试。 |

## 盲点处置

- 横向 CSV、XLSX、XLS 已加入同一回归用例，验证 orientation 和首行观测标签坐标。
- `report` 场景由获批本地生成器解释场景语义；安全插件只负责输入边界、结构投影、执行隔离和输出收据。
- R 或 gold standard 医学结果比对属于企业 Listing 生成器的验证职责，不并入安全插件。
- 多级 merged-cell 表头仍依赖现有结构检测策略，当前未增加独立医学语义 oracle；上线前应使用企业批准的非临床结构夹具验收。

## 外部残余风险

- 插件不能替代 OS、容器或企业网络策略。本地生成器进程的网络访问必须由部署环境限制，插件只约束 DSH 模型与工具边界。
- 当前 Windows 账户无符号链接创建权限，动态 symlink 用例显式跳过；实现仍通过 canonical resolve 和根目录 containment 拒绝链接逃逸。应在具备创建权限的 CI 或预发布主机补跑。
- 插件不是完整医学 Listing 算法。生成器的医学正确性、统计验证、模板一致性和审批记录由企业生成器发布流程负责。
- `localDataRoot`、`credentialsDir`、生成器代码和产物目录仍需最小权限、变更审批、恶意软件防护及备份恢复控制。

## 发布验收门槛

1. `python tests/run_all.py` 全部套件通过，跳过项必须可见并说明环境原因。
2. `python tests/mutation/run_mutation.py` 达到 10/10。
3. 根项目合同测试通过，Python 与 Node 语法检查通过。
4. npm tarball 清单包含安全 worker、表头检测、DLP 模式、Cordis patch 和 requirements，不包含测试、缓存、日志或临床数据。
5. 从 tarball 隔离安装后验证导入、版本、注入服务、worker 和 stream。

---

# Listing 重构复审（EMERALD_LISTING_REFACTOR_AUDIT_20260822）处置记录

对应 [EMERALD_LISTING_REFACTOR_AUDIT_20260822.md](EMERALD_LISTING_REFACTOR_AUDIT_20260822.md) 的 NOT READY 裁决。本轮处置全部 BLOCK/WARN/NOTE 项，并落定报告标出的三项需决策项。

## 需决策项裁决（2026-08-22，用户决策）

| 项 | 裁决 | 落地方式 |
|---|---|---|
| F-4 存在性预言机 | **接受该通道，配限频 + 审计计数**。不对 rowCount 分桶——临床交付物需要真实行数，分桶会破坏收据可读性与产物核对。 | 新增 `security/listing_budget.py`：单会话单项目 execute 次数上限（默认 50，`EMERALD_LISTING_MAX_EXECUTIONS` 可覆写），每次调用写 `listing_ops` 审计（含计划指纹、序号、过滤条件数、是否放行），超限 fail-closed 返回 `EXECUTE_BUDGET_EXHAUSTED`。记账在读取任何真实记录之前，超限时一次 rowCount 都不回传。审计只记结构性元数据与不可逆指纹，**不记 literal 原值**——抄下 literal 等于把推断出的数据值写进文件，反而扩大出域面。 |
| F-11 旧双轨 | **彻底下线旧生成器及其测试**。medical 来源确认从"拦路异常"改为计划校验规则。 | 删除 `security/emerald_listing_generator.py`（约 700 行）、`execute_listing_workflow` 及其 `_load_generator`/`_receipt`/`_requirement_summary` 辅助、worker 的 `listing_workflow` 操作分支、`listingGenerator` 配置项（含 cordis.patch.yml、index.js、plugin_driver.js）与 12 个旧路径测试。新增 `_require_medical_provenance`：spec 要求标识 New/Modified 则计划必须启用 `appendReviewColumns`，要求只呈现已编码信息则必须声明 `statusFilter`，否则以 `MEDICAL_PROVENANCE_REQUIRED` 结构化拒绝并指明缺失字段。旧行为把整轮打回 needs_input、模型看不到缺什么；新行为可被模型直接修正。 |
| F-12 document plane 文件级放行 | **有意设计，不修**。`doc/` 目录中的文件就是需求 spec/ALS，整文读取是预期行为。 | 该目录是按**路径**认定的受信需求平面，不按内容逐 sheet 剥离；边界由 `test_only_doc_directory_is_a_requirements_source` 锁定。后续审计若再将此列为缺陷，引用本决策驳回。 |

## findings 处置

| 项 | 处置 | 证据 |
|---|---|---|
| F-1 30s 超时阻断（BLOCK） | 已修。`clinical-listing-plugin.js` 按操作类型设置超时（inspect 300s / validate 60s / execute 900s），经 `listingTimeoutMs` 可覆写；超时返回 `LISTING_TIMEOUT` + `retryable: true` 结构化收据而非裸 Error。`index.js` 校验配置形状与范围。 | 插件与 index.js 语法检查；合同测试。 |
| F-2 valueRef 静默错误（BLOCK） | 已修。`right = result[_column(...)]`，比较列的**值**而非列名字符串。 | `test_valueref_filter_compares_values_not_column_names`；回退修复后该用例 FAIL，证明可判定。 |
| F-3 攻防面零测试（BLOCK） | 已修。新增 `tests/unit/test_listing_plan_contract.py`（37 用例，合法/越界/混淆三族 + 契约一致性 + 发布路径 + 预算），已纳入 `run_all.py` 门禁。 | 37/37。 |
| F-5 filters/derivations 顺序 | 已修。执行器统一为"先派生后过滤"，与 validator 注册顺序一致。 | `test_filter_can_reference_a_derived_column`；回退后 FAIL。 |
| F-6 sort 双向不一致 | 已修。排序列域收敛为"未被 dropCodeValue 移除的输出列 + 启用时的复核列"，与执行器投影后排序同口径；同时把聚合别名注册进 `available`（此前"输出聚合结果"的计划被 validator 拒绝，聚合能力实际不可用）。 | `test_validated_sort_is_always_executable`、`test_dropped_code_value_column_cannot_be_sorted_on`、`test_join_derive_filter_aggregate_plan_is_accepted`。 |
| F-7 发布路径丢失回滚 | 已修。恢复 try/except 回滚分支；备份清理失败降级为收据 warning。 | `test_publish_failure_restores_the_previous_listing`、`test_published_listing_stays_completed_when_backup_cleanup_fails`；回退后两者均 FAIL。 |
| F-8 tokenizer 幂等性 | 已修，**但审计归因有误**。报告称是"套件间共享状态污染/顺序依赖"；真因是幂等性架构缺陷：token 形态 `[KIND:hex8]` 的 HMAC digest 偶发"字母前缀+6-8位数字"形态（实测 `f1989023`），被受试者编号正则命中导致 token 自我重套（`[DATE:[SUBJ:...]]`）。会话密钥随机 → 是否踩中是概率事件（实测约 3% 密钥触发），因此表现为"全套件 FAIL、单跑 PASS"。修法是 token 一旦生成立即隔离出后续模式视野（与出域侧 `_TOKEN_SPAN_RE` 同一思路，写入侧此前漏了），并非重置会话密钥。 | 固定密钥对照：新旧实现在 10 种形态上输出**逐字节一致**，仅消除自套；1000 个随机密钥非幂等 0 次（修复前约 3%）。新增 `tokenizer_idempotency_survives_subject_shaped_digests` 用 mock 钉死最坏 digest 形态，不靠随机碰运气。 |
| F-9 symlink/junction 用例 | 已修。mklink 前防御性清理残留；本机既无 symlink 权限又建不出 junction 时显式 `SKIP`（可见并说明环境原因），不再伪装成代码缺陷 FAIL。 | 跑器区分 SKIP 与 FAIL 并单独计数。 |
| F-10 S4 JS/Python 豁免对齐 | 已修。`NODE_DLP_PATTERNS` 增加 `severity` 字段作为单一来源并经 `sync_patterns.py` 同步；Node 侧新增纯日期降级为 warn、SAS 日期字面量（`'01JAN2024'd`）区间豁免、token 区间豁免。判据留在 patterns.py，未在 patterns.js 另写 label 名单。 | scan_dlp 23/23（含"含时间成分仍阻断""SAS 字面量外的真实值仍阻断""token 区间外的真实值仍阻断"三条不可回退不变量）+ severity 报告断言；`node_patterns_json_matches_python_source_of_truth` 校验同步。 |
| N-1 计划无资源上限 | 已修。`MAX_OUTPUTS=64`、`MAX_ITEMS_PER_OUTPUT=256`，全部数组经 `_bounded_list`，超限 `PLAN_TOO_LARGE`。 | `test_plan_resource_limits_are_enforced`。 |
| N-2 裸 ValueError 逃逸 | 已修。`_bounded_int` 对垃圾输入抛结构化 `INVALID_LAYOUT_REQUIREMENT`，不再降级为不可诊断的 WORKFLOW_UNAVAILABLE。 | `test_layout_numbers_reject_garbage_with_structured_errors`。 |
| N-3 statusFilter 无上限 | 已修。长度 ≤256 且拒绝公式前缀，与 literal 同口径。 | `test_formula_prefixes_are_rejected_in_free_text`。 |
| N-4 is_null 携带 literal 静默丢弃 | 已修。显式拒绝——静默忽略模型意图会让"计划写错"表现为"结果不对"。 | `test_null_checks_reject_smuggled_comparison_values`。 |
| N-5 派生 arity 未校验 | 已修。`DERIVATION_MIN_REFS` 在校验期拒绝，不再在执行期 IndexError。 | `test_derivation_arity_is_validated`。 |
| N-6 死代码/重复 | 已修。删除执行器 `_files()`、`_execute_output` 未使用的 `project` 参数、`listing_workflow` 重复的 `SCENARIOS`、随 F-8 修复失效的 `_token_sub_despaced` 及其 stale import；复核列与 dropCodeValue 判据收敛为 `listing_plan` 的 `REVIEW_COLUMNS`/`_is_code_value_column` 单一来源，执行器改为引用。 | py_compile + 全量套件。 |
| N-7 归档显示名不稳定 | 已修。解包产物统一显示 `archive/<file>`，不再泄露随机临时目录名（此前 `is_relative_to` 分支恒真使 `archive/` 分支成死代码，AI 每轮看到不同名字）。 | 两次独立运行显示名与 schemaFingerprint 一致。 |
| N-8 限定名碰撞 | 已修。限定引用只允许命中 join 重命名列，命中不了才回退非限定名，不再静默错列到左表同名干扰列。 | `test_join_qualified_reference_never_silently_picks_a_native_column`。 |
| N-9 count 语义不一致 | 已修。两条分支统一为 pandas 非空计数口径。 | `test_aggregation_count_semantics_match_across_grouping`。 |
| N-10 Excel 公式注入 | 已修。label/statusFilter 拒绝 `= + - @` 前缀；写入侧对所有以这些字符开头的单元格强制 `data_type="s"`（实测未修时 `=1+1` 落盘为 `<f>1+1</f>` 活公式）。 | `test_formula_prefixes_are_rejected_in_free_text` + openpyxl XML 落盘核验。 |

## 本轮新发现（审计未列出）

- **聚合类型语义缺陷**：无 groupBy 分支此前构造包含全部六种聚合的 dict 再取一个，使"只求 count"的计划也在文本列上执行 sum/mean。更严重的是 pandas 对字符串 series 的 `sum` 是**拼接**（`'a'+'b'` → `'ab'`）——会静默产出一个看起来像"合计"、实际是所有不良事件名首尾相接的单元格。已改为按需求值 + `sum`/`mean` 显式要求数值字段，非数值抛结构化 `ListingExecutionError`。证据：`test_aggregation_rejects_type_incompatible_operations`、`test_numeric_aggregation_still_works_on_numeric_fields`。

## 残余风险

- 生产项目 RBQM_test 不在本工作区，F-1 的 300s/900s 超时值基于操作类型推定，需在真实 72 数据集规模上确认是否足够；超时已可经 `listingTimeoutMs` 调整且返回可重试收据，不再是硬阻断。
- 完整插件链路（UI → 插件 → worker → execute → 持久化 completed 收据）的真实数据留痕仍未取得；本轮已在工作流层用真实 CSV 数据集端到端验证 completed 收据、相对产物标识、整目录替换与回滚。
- F-4 预算是 worker 进程内状态，worker 重启会重置计数；审计记录持久化，异常频次事后可查。
- Node 侧 4 个套件（bypass/integration/e2e/contract）依赖 `@deepseek-ai/dsh-tools`，在本次 Linux 验证环境中该模块不可读（I/O 错误），未能执行；需在 Windows 宿主补跑 `python tests/run_all.py` 全量。
