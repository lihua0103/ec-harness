# Emerald Clinical Listing 链路根因分析与系统性解决方案

**日期：** 2026-08-22
**状态：** 分析完成，待决策执行
**范围：** dsh-clinical-data-guard 插件（Node.js `src/*.js` + Python `security/*.py`）的临床 listing 生成链路（report / medical / manual / rbqm 四场景）
**关联文档：** [CODEBASE_AUDIT_DSH_GUARD_20260822.md](CODEBASE_AUDIT_DSH_GUARD_20260822.md)、[zero-egress-dev-spec-v1.md](zero-egress-dev-spec-v1.md)、[EMERALD_CLINICAL_MASTER_SPEC.md](EMERALD_CLINICAL_MASTER_SPEC.md)

---

## 1. 执行摘要

### 1.1 业务需求（用户原意的形式化重述）

临床 listing 需求本身是明确且稳定的：

1. 四场景（report / medical / manual / rbqm）共用同一条链路：**读取 spec 需求 → 理解需求 → 依据 ALS 字段结构对 SAS 数据做处理 → 生成对应 listing 数据集**。
2. 唯一硬性安全约束（死命令）：
   - SAS 数据集中的 **data 值不允许喂给 AI**；
   - report 场景中 spec 提到的**衍生 data 数据不允许输出给 AI**；
   - 但**允许读取表结构**，让程序去处理数据。

### 1.2 核心结论

> 问题不是需求复杂，而是**建成的架构与需求方向相反**。

- **用户要的**：AI 读 spec → AI 理解需求 → AI 产出处理逻辑 → 本地确定性程序拿逻辑去跑 SAS 数据 → 产出 listing。数据值永不进 AI。
- **实际建成的**：一个硬编码 Python 生成器（`emerald_listing_generator.py`）试图用穷举的方式覆盖所有场景；AI 被刻意排除在"理解需求"之外，只能看到计数收据（如 `requirements: 476`）；安全防线以**内容正则模式识别**为主判据，在 spec/ALS/SAS 语境下天然高误报，表现为"不是这儿拦截，就是那儿脱敏后无法识别"。

**职责倒挂是总根因**：AI 最擅长的事（理解自然语言需求）被架构禁止；程序做不了的事（理解"New\Modified 的信息请标识"这类中文业务规则）却硬塞给了硬编码生成器。

### 1.3 关键事实速览

| 事实 | 证据 |
|---|---|
| listing 链路**从未**在真实项目数据上产出过 `completed` 收据 | §3 证据 E1 |
| 当前代码对真实 ALS 解析结果为 **0 条 mappings**，链路必然以 needs_input 告终 | §3 证据 E2（2026-08-22 复现） |
| 真实 spec 的自然语言规则会触发生成器的**主动拒绝**逻辑 | §3 证据 E3 |
| 旧版收据曾将 **466 行原始受试者数据**泄露进 AI 可见的 receipt | §3 证据 E4 |
| 全部端到端证据均来自合成 fixture；真实数据回放不在测试门禁内 | §6.3 |

---

## 2. 现状链路全景

### 2.1 调用链

```text
用户/模型
  │ 调用工具 clinical_listing_workflow(project, scenario, credentialRef)
  ▼
src/clinical-listing-plugin.js  registerClinicalListingPlugin → tool.execute (L150-162)
  │ runtime.request({operation:'listing_workflow', ...})
  ▼
src/index.js  SecurityRuntime.request (L107-134) → spawn('python -m security.worker') (L54)
  │ stdin/stdout JSON 行协议
  ▼
security/worker.py  _handle() operation=='listing_workflow' (L192-210)
  │ 准入: context.localDataAccess == 'uat-local' (L193)
  ▼
security/listing_workflow.py  execute_listing_workflow (L94-250)
  ├─ resolve_under_root 路径边界 (L106)
  ├─ find_spec_documents → parse_spec_document → 只取计数进收据 (L114-143)
  ├─ read_credential 读 ZIP 密码 (L150)
  └─ emerald_listing_generator.generate(...) → staging → 原子发布 (L156-227)
        ▼
security/emerald_listing_generator.py  generate_listing (L427-519)
  ├─ 完整解析 spec/ALS（留本地，不进收据）
  ├─ mappings 按 datasetName 分组 (L442-459)
  ├─ medical 场景: _require_medical_rule_provenance (L462)
  ├─ _source_files 扫描 .sas7bdat/.xpt / _extract_archives 解 ZIP
  ├─ pyreadstat 按 ALS 映射 usecols 读真实数据 (L213-218 / L352-357)
  └─ openpyxl 写 XLSX + Manifest
        ▼
回传 receipt（RECEIPT_SCHEMA 白名单，additionalProperties:false）
模型只见: status / stage / 文档计数 / 产物名与 sheet 行列数 / warnings
```

### 2.2 安全防线现状（两层四关）

| 关卡 | 位置 | 机制 |
|---|---|---|
| ① 工具参数快筛 quickGuard | `src/index.js:541-554` → `src/patterns.js` scanDlp | JS 正则初筛，命中即 deny |
| ② pre-execute | `src/index.js:557-599` → worker `check_tool` + JS `planeAdmission` (L275-326) | 危险工具/bash/AST 检查 + 来源域准入 |
| ③ post-execute | `src/index.js:602-653` → `src/tool-result-guard.js` safeToolResult (L176-291) | 按 planeOf 来源域处置工具结果 |
| ④ llm/stream 出域 | `src/index.js:655-684` → worker `check_llm` → `check_egress_v2`（默认）/ v1 | 出域扫描/体量红线拦截 |

### 2.3 AI 可见性边界现状

| 信息 | AI 是否可见 | 说明 |
|---|---|---|
| SAS 数据值 | 不可见（符合死命令） | 全程在 Python worker 进程内，pyreadstat usecols 读取 |
| 表结构元数据 | 部分可见（有损） | 列名经 header_detect 白名单投影，非白名单列名变 `COLUMN_n` |
| spec 需求文本 | **listing 链路内不可见**（仅计数）；spec/document plane 通用读取通道可见 | 两条通道割裂，listing 工具主动屏蔽需求文本 |
| ALS 字段结构 | 不可见（仅计数，ALS 连 sheets 计数都清零） | listing_workflow.py L134-135 |
| 生成产物 | 不可见内容，仅 sheet 名与行列数 | 产物留在本地 `.clinical-listing/output/<scenario>/` |

---

## 3. 证据链

### E1：仓库中唯一的真实运行收据是失败收据

文件：`dsh-clinical-data-guard/.tmp-real-replay/receipt.json`（真实项目 GQ1005-301）

```json
{
  "status": "needs_input",
  "stage": "generate",
  "artifact": {"id": "", "name": "", "kind": "none"},
  "artifacts": [],
  "warnings": [
    "a specification document could not be parsed",
    "listing requirements require local clarification"
  ]
}
```

失败路径：ALS 解析失败/无映射 → 生成器零 mappings → `ListingNeedsInput` → needs_input 收据。

### E2：2026-08-22 用当前代码复现，依然无法产出

对真实 ALS 文件执行当前版解析器：

```powershell
python -c "from security import spec_parser; \
  print(spec_parser.parse_spec_document(r'.tmp-real-replay/GQ1005-301/doc/GQ1005-301_ALS_V1.0_20241219.xlsx'))"
```

实际输出：

```text
PARSE OK
{'forms': 0, 'datasets': 0, 'fields': 2000, 'kris': 0, 'mappings': 0,
 'requirements': 2000, 'sheets': 23}
```

三个致命细节：

1. **`mappings: 0`** —— 23 个 sheet 的真实 EDC 导出 ALS，一条 dataset→sourceColumn 映射都没识别出来。解析器只覆盖 3 种 ALS 布局（`_parse_als_sheet` / `_parse_form_field_als` / `_parse_relational_als`），真实文件布局不在其中。
2. **`fields: 2000` 与 `requirements: 2000` 恰好打满** `MAX_DEFINITIONS=2000` 上限（spec_parser.py L23-27）——存在静默截断，后半部分字段定义悄悄丢失，无任何告警。
3. 生成器入口 `emerald_listing_generator.py L447-448` 对零 mappings 直接抛 `ListingNeedsInput`。**即使用当前代码重跑，结果仍然是 needs_input，产不出 listing。**

### E3：修好 ALS 映射后，下一道拦截在等着

真实 spec《GQ1005-301_MM Listing要求_20250211.xlsx》的 9 条规则为中文自然语言：

```text
1 导出Rawdata
2 以本文件SV页面为例，各页面通用信息保留：中心编号、项目编号、受试者编号…
3 各页面具体字段信息：删除Code Value列
4 添加目录
5 标题只保留中文
6 每个sheet最后增加四列：Flag(Old\New\Modified)、Update Details、Review Comments、Initial/Date
7 New\Modified的信息请标识
8 固定首行，固定字段记录号（包含字段记录号）之前的列
9 涉及到编码的页面只呈现Status为"已编码"的对应编码信息
```

而 medical 场景的 `_require_medical_rule_provenance`（emerald_listing_generator.py L411-424）在检测到需求文本含 "New/Modified" 或 "已编码+Status" 时**主动拒绝执行**（code=`medical_rule_provenance`），要求人工确认规则来源。即：真实 spec 的第 6/7/9 条恰好踩中这个拦截器——**链路上叠着第二道必然失败的关卡**。

同时，这 9 条规则是自然语言，硬编码生成器在原理上就无法覆盖任意此类需求。

### E4：旧版收据曾泄露 466 行原始受试者数据

同一份 receipt.json 的 `requirements.documents[0].requirements` 数组中，包含 SV sheet 的 **466 行原始记录**：受试者编号、访视日期、CRC 账号、甚至 `525586226@qq.com`、`yedd@genequantum.com` 邮箱与手机号 `15735646539`。

根因：真实《MM Listing要求》xlsx 内嵌了一个 466 行的 SV 原始数据 sheet（spec 与数据混排在一个文件里），旧版解析器把数据行当作"不规则自然语言需求"注入了 requirements。

该泄露当前已被 `_is_data_example_layout`（spec_parser.py L506-514，表头 ≥60% 为机器字段名的 sheet 判为数据示例页）修复并有回归测试；且当前 RECEIPT_SCHEMA 的 `additionalProperties:false` 会让这种收据直接被 schema 拒绝。但它的启示是结构性的：

> **这套系统既过度拦截正常开发，又曾把最该保护的数据原样吐给 AI——两个方向同时失守。** 文件级 trust 边界的粒度选错了，真实临床文件中 spec 与数据是混排的，边界必须是 sheet 级/行级。

### E5：端到端证据的全部来源是合成 fixture

- 最接近真实部署的 e2e 证据是 `tests/integration/test_plugin_runtime.py::test_listing_uses_session_cwd_over_configured_root`（L625-658），但它用的是合成 ALS.xlsx + DM.xpt。
- `tests/replay_e2e.py` 只回放 `scrub_text` → `check_llm` 两条脱敏车道，**不覆盖 listing 生成**，且不在 `run_all.py` 门禁内。
- 仓库中不存在"当前代码 + 真实 GQ1005-301 数据 + status:completed"的任何证据。

---

## 4. 失败/拦截点全清单

### 4.1 JS 插件层（src/）

| 位置 | 触发条件 | 结果 |
|---|---|---|
| clinical-listing-plugin.js:120 | `localDataAccess !== 'uat-local'` | 工具不注册（默认关闭） |
| clinical-listing-plugin.js:158-160 | worker 回 `{ok:false}` | execute 抛 Error |
| index.js:114-122 | worker 损坏/超时（默认 30s） | reject，fail-closed |
| index.js:541-554 quickGuard | 工具参数 DLP 命中 | 阻断 |
| index.js:275-326 planeAdmission | 数据域路径直读 / shell 启动解释器 / pwsh 数据读取模式 | deny |
| index.js:667-670 llm/stream | check_llm 不 ok | 抛错"临床数据出域已阻断" |

### 4.2 worker.py 协议层

| 位置 | 触发条件 | 返回 code |
|---|---|---|
| L130-134 | local_data_metadata 非 uat-local | LOCAL_DATA_ACCESS_REQUIRED |
| L144-151 | check_tool_call 判危险 | DANGEROUS_OPERATION |
| L167-172 | check_llm 抛 EgressViolation | EGRESS_VIOLATION |
| L193-195 | listing_workflow 非 uat-local | LOCAL_DATA_ACCESS_REQUIRED |
| L207-208 | ListingWorkflowError | LISTING_WORKFLOW_ERROR |
| L209-210 | 未预期异常 | WORKFLOW_UNAVAILABLE（sanitize_error 脱敏） |

### 4.3 编排层与生成器（listing 业务失败点）

| 位置 | 触发条件 |
|---|---|
| listing_workflow.py L103-104 | scenario 不在 {medical, rbqm, manual, report} |
| listing_workflow.py L115-117 | doc/ 无 xlsx → needs_input |
| listing_workflow.py L128-130 | 单个 spec 解析失败 → warning 后继续（**静默降级**） |
| emerald_listing_generator.py L447-448 | **零 ALS mappings → ListingNeedsInput（E2 命中点）** |
| emerald_listing_generator.py L411-424 | **medical 场景规则来源未确认 → 主动拒绝（E3 命中点）** |
| emerald_listing_generator.py L206/L313 | ALS 源列在 SAS 数据集中不存在 |
| emerald_listing_generator.py L483-484 | 数据集文件缺失或同名多份歧义 |
| archive_passwords.py L110 | ZIP 全部候选密码失败 |

### 4.4 高频误伤规则清单（"到处拦截"的来源）

| 规则 | 位置 | 误伤场景 |
|---|---|---|
| sheet 名黑名单含 `"listing"`/`"ae"`/`"data"`/`"visit"`/`"数据"` | data_egress_guard.py L219-223 | spec 文件《MM Listing要求》整表被跳过 |
| SAS 日期字面量 `\d{2}[A-Z]{3}\d{4}` | patterns.py L72 + node_patterns.json | 写正常 SAS 程序 `'01JAN2024'd` 被 quickGuard 拒绝 |
| ISO 日期任意阻断 | node_patterns.json ISO_DATE | write_file 参数含 `2024-01-01` 即被 JS 层拦死（Python 侧仅 WARN） |
| 字母前缀编号 `[A-Z]{1,4}\d{6,8}` | patterns.py L33 | ALS/EDC 的 ItemOID、记录号 |
| JS 独有 LEADING_ZERO_SUBJECT_ID `\b0\d{4,7}\b` | patterns.py L153 | 代码常量 `06000`/`012345` |
| 表头白名单投影 | header_detect.py L596-624 | ALS 核心列名 PreText/ItemOrder/DatasetName/SASLabel → `COLUMN_n`，字段语义归零 |
| 数据行连坐 hash | smart_guard.py L361-375 | spec 表格行内中文业务词（失访率、监控频率）全部 `[TEXT:hex8]` 抹平 |
| bash 含 `.sas7bdat` 即 HIGH/BLOCK；`python.*read_excel` 即 HIGH | ai_operations_monitor.py L92-106 | "看一眼数据结构"的日常动作全在打击面 |
| DATA_QUERY_TOOL_RE 按工具名阻断 | tool-result-guard.js L15 | 不看内容，凡 `fetch/query/read/export_*` 即拦 |

---

## 5. 根因分层

### 5.1 架构性缺陷（总根源）

**A1. 职责倒挂：AI 被禁止做它唯一擅长的事。**
listing 链路的设计注释明确写着解析结果"只留本地生成器"（listing_workflow.py L132-140），AI 收据只有 `{name, kind, summary计数}`。而真实 spec 规则全是中文自然语言（E3），硬编码生成器在原理上无法覆盖任意自然语言需求。结果：能理解需求的（AI）看不到需求；看得到需求的（生成器）不理解需求。链路在设计上就是断的。

**A2. "spec 文件 ≠ 数据文件"的文件级二分假设不成立。**
真实《MM Listing要求》xlsx 内嵌 466 行 SV 数据 sheet（E4）。plane 模型（spec plane 放行 / data plane 阻断）建立在"文件级干净分离"假设上，假设破裂导致旧版泄露、新版打补丁。边界粒度必须是 sheet/行级，不能是文件级。

**A3. 安全模型判据错误：内容模式识别代替边界控制。**
内容正则在数学上无法区分"spec 中举例的日期"与"真实受试日期"。sheet 名关键词、日期正则、编号正则在临床语境必然持续误报；豁免逻辑逐事故打补丁（代码注释中 2026-08-20/21 事故记录为证），补丁速度永远追不上真实语料多样性。

**A4. 双层拦截、口径漂移。**
同一文本过 JS quickGuard 与 Python worker 两道关。豁免逻辑只在 Python 侧（纯日期降级、字母末段豁免、token 区间豁免），`scripts/sync_patterns.py` 只同步正则不同步豁免；PowerShell 防护重复实现两份且模式不一致。后果："Python 放行、JS 拦死"成为日常。

**A5. 脱敏是破坏性的且不可关联。**
表头 `COLUMN_n` 化、数据行连坐 `[TEXT:hex8]` 抹平、HMAC 密钥每进程随机（tokenizer.py L23，worker 重启后同值 token 全变）——AI 既看不到值也无法跨会话关联。这是"脱敏后无法识别 spec 需求"的直接机制。

### 5.2 实现缺陷清单

| # | 缺陷 | 位置 | 后果 |
|---|---|---|---|
| B1 | ALS 解析只认 3 种布局，真实 23-sheet 导出产出 0 mappings 且静默降级 | spec_parser.py | 用户看到"无法识别"，无从诊断 |
| B2 | MAX_DEFINITIONS=2000 静默截断 | spec_parser.py L23-27 | 字段定义丢失无告警 |
| B3 | needs_input 收据不含"缺什么"的结构化说明 | listing_workflow.py L228-241 | 每次失败都是死胡同 |
| B4 | sheet 名黑名单误杀"Listing要求" | data_egress_guard.py L219-223 | spec 整表不可见 |
| B5 | pyreadstat 未声明进 requirements.txt；xlwt 环境缺失致 2 用例静默 FAIL | requirements.txt | .sas7bdat 新环境不可读；基线混入假绿 |
| B6 | cordis.patch.yml 为空数组，shadow 止血未激活 | cordis.patch.yml L5 | 误报可锁死会话（审计 P0） |
| B7 | 横向表头处理取列时固定使用 `scan_rows[0]` 而非当前行（多处同型：L297/L370/L446），横向表头列索引基于首行而非各自行 | header_detect.py L297/L370/L446 | 横向表头（行=变量、列=观测）场景列索引错位风险 |
| B8 | JS/Python 豁免口径不对称；pwsh 正则两份实现不一致 | patterns.js / index.js / ai_operations_monitor.py | 一处拦一处放 |
| B9 | 通用 spec 读取豁免通道与 listing 工具链割裂 | index.js L355-403 vs listing_workflow.py | 设计内的 spec 可见性在 listing 场景不生效 |

### 5.3 流程缺陷（缺陷为何能活着到达用户）

**C1. 开发顺序倒置。** 先建三层 guard，业务链路却从未在真实数据上拿到一次 `completed`。相当于先装三道安检门，再发现流水线没接电。

**C2. 验收标准只有"拦截数=0"，没有"listing 产出=成功"。** `run_all.py` 门禁内没有任何真实项目 listing 用例；replay_e2e 只验脱敏车道。测试全绿 ≠ 业务可用。

**C3. 测试视角单一。** bypass 矩阵与 mutation 全是攻击视角（"能不能泄露"），零用例断言"spec 字段名必须可读""需求文本必须完整可达 AI"。误伤回归没有安全网。mutation 的 10 个变异体全部针对 v1 老架构，误伤重灾区（smart_guard、tool-result-guard、planes、header_detect）零覆盖。

---

## 6. 系统性解决方案

### 6.0 架构原则（从死命令反推）

1. **数据值永不进 AI** —— 保留现有 worker 内 pyreadstat 读取与 receipt 白名单机制。
2. **spec 需求文本、ALS 字段结构必须完整给 AI** —— 这是"AI 理解需求"的前提，当前链路恰恰断在这里。
3. **AI 产出"处理计划"，本地确定性执行器拿计划跑数据** —— 替代硬编码生成器猜需求。
4. **安全防线从"内容模式识别"转向"边界 + 结构校验"**，内容扫描退为最后兜底（仅 mass-dump 体量红线）。

### 6.1 第 0 步：核心架构修改 —— "计划-执行"两段式

```text
spec/ALS（本地解析；数据示例 sheet 在解析层剥离记录行）
   │ 需求文本 + 字段结构（不含任何数据值）
   ▼
AI 理解需求 → 产出 ListingPlan（JSON DSL）
   │   {datasets: [{name, source, columns, filters, sort}],
   │    derivedColumns: [{name, expression, refs}],
   │    layout: {freeze, toc, dropCodeValue, flagColumns...}}
   ▼
PlanValidator（本地，确定性）
   │ · JSON schema 校验
   │ · 只允许引用元数据中存在的表/列
   │ · 计划中出现任何数据字面量 → 校验失败（死命令的结构性保证）
   ▼
Executor（本地，pyreadstat/pandas/openpyxl）
   │ 在 SAS 数据上执行计划 → listing xlsx（staging → 原子发布，沿用现有机制）
   ▼
Receipt（白名单：sheet 名、行列数、warnings、missing 结构化诊断）
```

要点：

- **AI 看 spec 全文**：复用现有 `_is_data_example_layout` 能力，把它从"防注入闸口"升格为"spec/数据 sheet 级分离器"——需求 sheet 全文给 AI，数据 sheet 只给表头结构。
- **AI 生成映射计划**：ALS 布局多样性问题（E2）随之消失，不再依赖 parser 穷举布局。
- **硬编码生成器降级为内置计划模板库**：medical/rbqm 常见场景提供预置 plan，`_require_medical_rule_provenance` 拦路逻辑删除——规则确认由人在 review plan 时完成（HOTL 的人工闸门）。
- **死命令由 validator 结构性保证**：计划里出现数据字面量即拒绝，不再靠正则猜内容。

### 6.2 第 1 步：止血包（不涉及架构，当天可做）

| # | 动作 | 对应缺陷 |
|---|---|---|
| S1 | cordis.patch.yml 改为 `[{ config: { id: clinical-data-guard, mode: shadow } }]` | B6（审计 P0） |
| S2 | `pip install xlwt pyreadstat`，pyreadstat 写入 requirements.txt | B5 |
| S3 | 删除 sheet 名关键词黑名单（plane 判定已足够） | B4 |
| S4 | JS quickGuard 对齐 Python 豁免：纯日期 WARN、SAS 日期字面量豁免、token 区间豁免；豁免逻辑纳入 sync_patterns.py 单一来源 | B8 |
| S5 | needs_input 收据增加结构化 `missing` 字段（缺哪个数据集/映射/规则/凭据） | B3 |
| S6 | 修 header_detect.py L427 横向表头索引变量 | B7 |

### 6.3 第 2 步：可用性修复（让 AI 看得见）

| # | 动作 | 对应缺陷 |
|---|---|---|
| U1 | 表头白名单扩充：ALS/EDC 元数据词汇（PreText、ItemOrder、DatasetName、SASLabel、FormOID、ItemOID 等）视为"已证明字段名" | A5 |
| U2 | spec/document plane 放行粒度从文件级降到 sheet 级：数据示例 sheet 剥离记录行，需求 sheet 全文放行 | A2/B9 |
| U3 | token 化只保留在数据值车道；spec profile 下关闭 CJK 数字归一化等散文改写 | A5 |
| U4 | listing 链路收据增加 spec 需求条目的**结构化摘要**（规则编号 + 类型标签，不含数据值），让 AI 能逐条对齐需求与计划 | A1 |

### 6.4 第 3 步：验收重建（防止回潮）

| # | 动作 |
|---|---|
| V1 | **把"GQ1005-301 真实数据产出 completed listing"作为一级验收用例**纳入 `run_all.py` 门禁，四场景各一份真实回放 |
| V2 | 新增"可用性保持"测试族：spec 字段名可读、需求条数与人工清点一致、含日期/SAS 字面量的 write_file 不被拦、spec 全文可达 AI |
| V3 | mutation 扩展至新架构组件（smart_guard、tool-result-guard、planes、PlanValidator） |
| V4 | 新增 JS/Python 行为等价测试：同一语料过 scanDlp 与 Python 出域扫描必须同判 |
| V5 | check_egress_v2 补行为测试：200+ 数据行必 BLOCK、shadow/disabled 模式用例 |

### 6.5 预期效果

| 现状症状 | 解决后 |
|---|---|
| 到处拦截 | 内容正则退为兜底，主防线是 plane 边界 + plan 结构校验——结构性、不靠猜 |
| 脱敏后无法识别 spec | spec 文本不经 token 化直达 AI；数据值由 validator 结构性隔绝 |
| 产不出 listing | ALS 布局多样性由 AI 理解兜底；每次失败带结构化 missing 诊断 |
| 既误拦又泄露 | 边界粒度降到 sheet/行级；泄露与误伤用同一份语料做双向回归 |

---

## 7. 执行顺序与决策点

```text
第 1 步止血包（S1-S6，当天）          ← 决策点 D1：先止血，恢复可开发状态
   │
第 2 步可用性修复（U1-U4）            ← 决策点 D2：spec 全文给 AI 的安全评审
   │
第 0 步架构修改（计划-执行两段式）     ← 决策点 D3：ListingPlan DSL 的 schema 评审
   │
第 3 步验收重建（V1-V5）              ← 与上述各步同步补充，最终并入 run_all.py 门禁
```

**建议**：先执行第 1 步止血包并在真实项目 GQ1005-301 上重跑一次拿到结构化诊断输出；随后按 HOTL 流程对第 0 步做正式 brainstorm 与实施计划。

---

## 附录 A：复现命令

```powershell
Set-Location g:\home\dsh-guard\dsh-clinical-data-guard
$env:PYTHONIOENCODING='utf-8'

# E2 复现：真实 ALS 解析结果（mappings=0）
python -c "from security import spec_parser; \
  r = spec_parser.parse_spec_document(r'.tmp-real-replay/GQ1005-301/doc/GQ1005-301_ALS_V1.0_20241219.xlsx'); \
  print({k: (len(v) if isinstance(v, list) else v) for k, v in r.items()})"

# 全量基线
python tests\run_all.py
python tests\mutation\run_mutation.py
```

## 附录 B：本文涉及的关键文件索引

| 文件 | 角色 |
|---|---|
| `src/clinical-listing-plugin.js` | DSH 插件入口、RECEIPT_SCHEMA |
| `src/index.js` | SecurityRuntime、quickGuard、planeAdmission、llm/stream 钩子 |
| `src/tool-result-guard.js` | post-execute 按 plane 处置 |
| `src/patterns.js` + `security/node_patterns.json` | JS 侧 DLP 正则子集 |
| `security/worker.py` | 常驻 Python worker，JSON 行协议 |
| `security/listing_workflow.py` | listing 编排层 |
| `security/emerald_listing_generator.py` | 硬编码生成器（拟降级为计划模板库） |
| `security/spec_parser.py` | spec/ALS 解析器（3 种 ALS 布局；MAX_DEFINITIONS=2000） |
| `security/smart_guard.py` | 智能脱敏（数据行连坐） |
| `security/tokenizer.py` | 会话级 HMAC token 化 |
| `security/header_detect.py` | 表头识别与 COLUMN_n 投影 |
| `security/data_egress_guard.py` | sheet 名黑名单、Excel 安全扫描 |
| `security/egress_checkpoint.py` | 出域检查 v1/v2 |
| `security/ai_operations_monitor.py` | 危险工具/bash/AST 监控 |
| `security/path_policy.py` / `archive_passwords.py` | 路径边界 / ZIP 凭据 |
| `tests/replay_e2e.py` / `tests/run_all.py` | 现有回放与门禁（不覆盖 listing 真实数据） |
| `.tmp-real-replay/receipt.json` | 真实项目唯一运行收据（needs_input，E1/E4 证据） |
