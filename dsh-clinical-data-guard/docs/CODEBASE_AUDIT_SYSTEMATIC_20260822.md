# dsh-guard 临床数据安全项目系统性代码审计报告

**审计日期**: 2026-08-22  
**审计范围**: dsh-guard 全代码库（Node.js 插件 + Python 安全内核）  
**审计方法**: 逐函数阅读、架构分析、文档交叉验证  
**判决**: FAIL - 架构性缺陷导致系统无法满足基本业务需求

---

## 执行摘要

### 核心发现

**这不是安全措施"过严"的问题，而是架构从设计上就与需求相反。**

用户需求非常明确：
1. AI 读取 doc/ 目录中的 spec/als/template 文件 → 理解需求
2. AI 根据理解生成处理逻辑
3. 本地程序拿逻辑去处理 SAS 数据（读表结构OK，但数据值不能给AI）
4. 产出 listing

**但实际建成的系统**：
1. ✅ doc/ 目录文件在"通用文件读取"通道确实可以全文读取（planes.js 自动检测）
2. ❌ 但 clinical listing 工具链**主动屏蔽**了 spec 内容，只给 AI 计数（`requirements: 476`）
3. ❌ 硬编码的 Python 生成器试图用穷举方式覆盖所有场景，但真实 ALS 解析结果为 0 mappings
4. ❌ 真实 spec 的中文自然语言规则触发生成器的**主动拒绝**逻辑
5. ❌ 仓库中唯一的真实项目运行收据是 `status: needs_input`（失败）

### 致命证据

| 证据 | 来源 | 说明 | 复现状态 |
|---|---|---|---|
| E1 | `.tmp-real-replay/receipt.json` | 唯一真实运行收据：`status: needs_input`（失败） | ✅ 已验证 |
| E2 | 2026-08-22 真实运行 | GQ1005-301 ALS 解析：`mappings: 0`；RBQM ALS 解析：`mappings: 0` | ✅ 已复现 |
| E3 | spec 规则分析 | 中文自然语言规则触发 `medical_rule_provenance` 主动拒绝 | ✅ 代码确认 |
| E4 | GQ1005-301 真实文件 | **MM Listing要求.xlsx 的 SV sheet 包含 466 行真实受试者数据** | ✅ 已复现 |
| E5 | 测试覆盖分析 + 真实运行 | 全部端到端证据来自合成 fixture，**零真实数据测试** | ✅ 已验证 |
| E6 | RBQM_test 真实运行 | ZIP 文件 lab.sas7bdat 7.1GB 超过 512MB 限制，解压失败 | ✅ 已复现 |
| E7 | 多项目真实运行 | pyreadstat/xlwt/pyzipper 缺失，import 立即崩溃 | ✅ 已复现 |
| E8 | RBQM_test 工作区 | 临时目录 `.extract-*` 因权限错误无法清理（Operation not permitted） | ✅ 已复现 |

---

## 1. 架构性缺陷（总根因）

### 缺陷 A1: 职责倒挂 - AI 被禁止做它唯一擅长的事

**证据**:
```python
# listing_workflow.py L132-140
# AI 收据只有计数，完整内容"只留本地生成器"
receipt["requirements"] = {
    "documents": [{
        "name": doc_path.name,
        "kind": "specification",
        "summary": parsed  # 只有计数: {forms: 0, datasets: 0, requirements: 476}
    }]
}
```

**后果**: 真实 spec 规则全是中文自然语言（"New\Modified的信息请标识"），硬编码生成器在**原理上**无法覆盖任意自然语言需求。

能理解需求的（AI）看不到需求；看得到需求的（生成器）不理解需求。**链路在设计上就是断的。**

### 缺陷 A2: "spec 文件 ≠ 数据文件"假设不成立

**证据**: 真实《MM Listing要求》xlsx 内嵌 466 行 SV 数据 sheet（E4）。

**当前架构**: 
- `planes.js` 按**文件级**判断：doc/spec/ 下的文件 → spec plane → 全文放行
- 但真实临床文件中 **spec 与数据是混排的**（同一个 Excel 文件里既有需求说明 sheet，又有数据示例 sheet）

**后果**: 
- 旧版把数据行当"需求"注入 AI 上下文（泄露）
- 新版打补丁用 `_is_data_example_layout` 识别数据示例页，但这又是形态识别（补丁竞赛）

**正确边界**: 必须是 **sheet 级/行级**，不能是文件级。

### 缺陷 A3: 安全模型判据错误 - 内容正则代替边界控制

**核心问题**: 在数学上无法区分"spec 中举例的日期"与"真实受试日期"。

**证据**: patterns.py 中大量误报修复记录
```python
# patterns.py L26-32
# 真实缺陷修复：本模式会把"标识+YYYYMMDD"的文档版本号（DVP20260610、
# SPEC20260610）误判为受试者编号。文档编号在 spec/ALS/DVP/template 场景中
# 高频出现，一条误报即经全量历史重扫把整个会话永久钉死。
```

**误报清单**（为什么"到处都是拦截"）:
1. Sheet 名黑名单含 `"listing"`/`"ae"`/`"data"` → spec 文件《MM Listing要求》整表被跳过
2. SAS 日期字面量 `'01JAN2024'd` → 写正常 SAS 程序被 quickGuard 拒绝
3. ISO 日期 `2024-01-01` → write_file 参数含日期即被拦死
4. 字母前缀编号 `[A-Z]{1,4}\d{6,8}` → ALS 的 ItemOID、记录号被误判
5. 表头白名单投影 → ALS 核心列名 `DatasetName`/`SASLabel` → `COLUMN_n`（语义归零）

### 缺陷 A4: 双层拦截、口径漂移

**现状**: 同一文本过两道关：
1. JS `quickGuard` (index.js L589-602) → 基于 `node_patterns.json`
2. Python worker (worker.py) → 基于 `patterns.py`

**问题**: 豁免逻辑只在 Python 侧（纯日期降级、字母末段豁免、token 区间豁免），`scripts/sync_patterns.py` 只同步正则不同步豁免。

**后果**: "Python 放行、JS 拦死"成为日常。

### 缺陷 A5: 脱敏是破坏性的且不可关联

**机制**:
- 表头投影: `DatasetName` → `COLUMN_3`
- 数据行连坐: "失访率" → `[TEXT:a1b2c3d4]`
- HMAC 密钥每进程随机 (tokenizer.py L23)

**后果**: 这正是"脱敏后无法识别 spec 需求"的**直接机制**。AI 既看不到值也无法跨会话关联。

---

## 2. 实现缺陷清单（真实运行验证）

| # | 缺陷 | 位置 | 后果 | 证据 | 复现 |
|---|---|---|---|---|---|
| **B1** | ALS 解析只认 3 种布局，真实多 sheet 导出产出 **0 mappings** 且静默降级 | spec_parser.py | listing 工具链完全不可用 | E2 | ✅ GQ1005/RBQM 两项目 |
| **B2** | `MAX_DEFINITIONS=2000` 静默截断 | spec_parser.py L23-27 | 字段定义丢失无告警 | E2 | ✅ `fields: 2000` 打满 |
| **B3** | `needs_input` 收据不含"缺什么"的结构化说明 | listing_workflow.py L228-241 | 每次失败都是死胡同 | E1 | ✅ 收据只有模糊 warning |
| **B4** | sheet 名黑名单误杀"Listing要求" | data_egress_guard.py L219-223 | spec 整表不可见 | 代码审查 | 未测试 |
| **B5** | pyreadstat/xlwt/pyzipper 未声明进 requirements.txt | requirements.txt | import 立即崩溃 | E7 | ✅ 3 个依赖全缺失 |
| **B6** | cordis.patch.yml 为空数组，shadow 止血未激活 | cordis.patch.yml L5 | 误报可锁死会话（P0） | 代码确认 | 未测试 |
| **B7** | 横向表头处理取列时固定使用 `scan_rows[0]` 而非当前行 | header_detect.py L297/L370/L446 | 横向表头列索引错位风险 | 代码审查 | 未测试 |
| **B8** | JS/Python 豁免口径不对称 | patterns.js / patterns.py | 一处拦一处放 | 代码审查 | 未测试 |
| **B9** | 通用 spec 读取豁免通道与 listing 工具链割裂 | index.js vs listing_workflow.py | 设计内的 spec 可见性在 listing 场景不生效 | 架构分析 | ✅ 两条通道互不相通 |
| **B10** | ZIP 文件大小限制 512MB，真实数据常超 1GB | path_policy.py L16 | 真实项目 ZIP 无法解压 | E6 | ✅ lab.sas7bdat 7.1GB |
| **B11** | 临时目录清理失败（Windows 权限映射） | path_policy.py L156 / archive_passwords.py L109 | 工作区永久污染，无法清理 | E8 | ✅ Operation not permitted |
| **B12** | 错误信息被通用包装抹平 | listing_workflow.py L56-59 | 所有底层错误变成 "inspection failed" | 真实运行 | ✅ 无法诊断根因 |
| **B13** | ALS 导出只有表头无数据行时被跳过 | spec_parser.py | GQ1005 ALS 所有 sheet rowCount=0 | E2 | ✅ Items/FormItem 均为空 |

---

## 3. 为什么"到处都是问题"- 根因分析

### 3.1 开发顺序倒置

先建三层 guard（quickGuard / pre-execute / post-execute / llm/stream），业务链路却从未在真实数据上拿到一次 `completed`。

**这相当于先装三道安检门，再发现流水线没接电。**

### 3.2 验收标准错位

**当前标准**: "拦截数 = 0"（bypass 矩阵 BY-1..BY-12 全通过）  
**缺失标准**: "listing 产出 = 成功"（零真实项目 listing 用例）

测试全绿 ≠ 业务可用。

### 3.3 测试视角单一

**现状**: bypass 矩阵与 mutation 全是**攻击视角**（"能不能泄露"）  
**缺失**: 零用例断言"spec 字段名必须可读""需求文本必须完整可达 AI"

误伤回归没有安全网。mutation 的 10 个变异体全部针对 v1 老架构，误伤重灾区（smart_guard / tool-result-guard / planes / header_detect）零覆盖。

### 3.4 架构决策与需求错配

| 用户需求 | 实际建成 | 错配原因 |
|---|---|---|
| doc/ 内容AI全文可读 | ✅ planes.js 确实支持（通用读取） | ✓ 这部分对 |
| listing 工具链 AI 理解需求 | ❌ listing_workflow.py 主动屏蔽内容 | **架构决策错误** |
| 本地程序处理数据 | ✅ worker 内 pyreadstat 读取 | ✓ 这部分对 |
| 表结构可读 | ❌ 表头白名单投影 → `COLUMN_n` | **过度防御** |

---

## 4. 失败链路完整追踪

### 4.1 正常使用路径（用户期望）

```
用户调用 clinical_listing_workflow(project: "GQ1005-301", scenario: "medical")
   ↓
期望: AI 读 doc/GQ1005-301_MM_Listing要求.xlsx → 理解 9 条规则 → 生成处理逻辑
   ↓
期望: AI 读 doc/GQ1005-301_ALS_V1.0.xlsx → 理解字段映射
   ↓
期望: 本地执行器按逻辑处理 data/*.sas7bdat → 产出 listing
   ↓
期望: 返回 {status: "completed", artifact: {name: "医学列表.xlsx"}}
```

### 4.2 实际执行路径（必然失败）

```
用户调用 clinical_listing_workflow(project: "GQ1005-301", scenario: "medical")
   ↓
src/clinical-listing-plugin.js L158-160
   runtime.request({operation: 'listing_workflow'})
   ↓
security/worker.py L219-261 (operation == 'listing_workflow')
   context.localDataAccess != 'uat-local' → 默认 'disabled'
   → 返回 {ok: false, code: "LOCAL_DATA_ACCESS_REQUIRED"}
   ↓
❌ 失败点 1: clinical listing 工具默认不注册
```

**假设用户配置了 `localDataAccess: 'uat-local'`，继续执行**:

```
security/listing_workflow.py L94-250 execute_listing_workflow()
   ↓
L114-143: find_spec_documents → parse_spec_document
   真实输出: {forms: 0, datasets: 0, fields: 2000, mappings: 0, requirements: 2000}
   注意: mappings = 0 ← ALS 解析完全失败
   ↓
L132-140: AI 收据只包含计数，完整需求文本"只留本地生成器"
   receipt["requirements"]["summary"] = {forms: 0, datasets: 0, ...}
   ↓
❌ 失败点 2: AI 看不到需求文本（只有数字）
```

**假设 AI 能神奇地理解（实际不可能），继续执行**:

```
security/emerald_listing_generator.py L427-519 generate_listing()
   ↓
L442-459: mappings 按 datasetName 分组
   len(mappings) == 0
   ↓
L447-448:
   if not mappings:
       raise ListingNeedsInput("无法从 ALS 识别到字段映射")
   ↓
❌ 失败点 3: 零 mappings 必然抛异常（E2 证据）
```

**假设修好了 ALS 解析（mappings > 0），继续执行**:

```
L462-469: medical 场景
   _require_medical_rule_provenance(requirements)
   ↓
检测真实 spec 规则:
   "6. 每个sheet最后增加四列：Flag(Old\New\Modified)..."
   "7. New\Modified的信息请标识"
   "9. 涉及到编码的页面只呈现Status为"已编码"的对应编码信息"
   ↓
L411-424: _require_medical_rule_provenance()
   if "New" in rule or "Modified" in rule or ("已编码" in rule and "Status" in rule):
       raise MedicalRuleProvenance(code="medical_rule_provenance")
   ↓
❌ 失败点 4: 真实 spec 的第 6/7/9 条恰好踩中拦截器（E3 证据）
```

**即使神奇地全都通过，还有第 5 道关**:

```
L483-484: 查找数据集文件
   如果 data/*.sas7bdat 缺失或同名多份
   ↓
❌ 失败点 5: 文件缺失歧义
```

### 4.3 失败概率统计

| 关卡 | 默认配置失败率 | 真实数据失败率 | 证据 |
|---|---|---|---|
| localDataAccess 检查 | **100%** | 100% | 默认 disabled |
| ALS mappings == 0 | N/A | **100%** | E2：真实 ALS 解析为 0 |
| medical_rule_provenance | N/A | **100%** | E3：真实 spec 必触发 |
| 数据文件缺失 | 变量 | 变量 | 取决于环境 |

**结论**: 在默认配置下，失败率 100%。即使配置 uat-local，真实数据失败率仍然 100%（ALS 解析 + medical 拒绝双重锁死）。

---

## 5. "脱敏后无法识别"的技术机制

### 5.1 表头投影破坏语义

**原始 ALS 列名**:
```
DatasetName | SourceColumn | ItemOID | SASLabel | SASName | CodeList
```

**经过 header_detect.py 白名单投影后**:
```
COLUMN_1 | COLUMN_2 | COLUMN_3 | COLUMN_4 | COLUMN_5 | COLUMN_6
```

**后果**: AI 无法理解 ALS 结构，因为所有业务语义列名都被抹成了序号。

### 5.2 数据行连坐 token 化

**spec 表格中的业务词**:
```
字段           | 说明
失访率         | 计算受试者失访比例
监控频率       | 每月一次中心访视
风险等级       | 高/中/低三级分类
```

**经过 smart_guard 连坐 hash 后**:
```
字段           | 说明
[TEXT:a1b2c3d4] | [TEXT:e5f6g7h8] [TEXT:i9j0k1l2]
[TEXT:m3n4o5p6] | [TEXT:q7r8s9t0] [TEXT:u1v2w3x4]
[TEXT:y5z6a7b8] | [TEXT:c9d0e1f2] [TEXT:g3h4i5j6]
```

**后果**: AI 无法理解业务规则，因为所有领域词汇都被替换成了不可读的 token。

### 5.3 HMAC 密钥随机 - 跨会话不可关联

```python
# tokenizer.py L23
_HMAC_KEY = secrets.token_bytes(32)  # 每次 worker 重启都变
```

**后果**: 同一个值在不同会话或 worker 重启后产生不同 token，AI 无法建立关联。

---

## 6. 为什么"不是这儿拦截，就是那儿脱敏"

### 6.1 拦截层级图

```
用户输入
   ↓
① quickGuard (JS 正则初筛) ← 误报点 1
   ↓
② pre-execute (危险工具/bash 检查 + planeAdmission) ← 误报点 2
   ↓
③ post-execute (planeOf 来源域处置 + 表头提取) ← 破坏性脱敏点 1
   ↓
④ llm/stream 出域 (check_egress_v2 / smart_guard) ← 破坏性脱敏点 2
   ↓
模型
```

### 6.2 每层的误报/过度脱敏

| 层 | 机制 | 误报/过度脱敏场景 | 绕不过去的原因 |
|---|---|---|---|
| ① quickGuard | JS 正则 `node_patterns.json` | `2024-01-01`、`'01JAN2024'd`、`USUBJID=f'{...}'` | Python 豁免未同步到 JS |
| ② pre-execute | planeAdmission 路径检查 | 数据域路径直读被拒 | ✓ 这是设计意图（正确）|
| ③ post-execute | 表头白名单投影 | `DatasetName` → `COLUMN_3` | 白名单太窄，ALS 核心列名不在内 |
| ④ llm/stream | smart_guard token 化 | spec 表格中文业务词全抹 | CJK 数字归一化 + 数据行连坐 |

### 6.3 用户体验：进退两难

**场景 1**: 用户想读 spec 文件理解需求
- 通用 `read` 工具读取 → ③ 表头投影 + ④ token 化 → 语义丢失
- listing 工具读取 → 只给计数 `{requirements: 476}` → 完全看不到内容

**场景 2**: 用户想看 ALS 字段映射
- 通用 `read` 工具读取 → ③ 列名变 `COLUMN_n` → 映射关系丢失
- listing 工具读取 → `{fields: 2000, mappings: 0}` → 解析失败

**场景 3**: 用户想处理数据
- 通用工具（bash/read）→ ② planeAdmission 拒绝 → "必须用 listing 工具"
- listing 工具 → ❌ ALS 解析失败 + medical 拒绝 → 完全跑不通

**结果**: 无论走哪条路都是死胡同。

---

## 7. 已知的"临时修复"为什么不起作用

### 7.1 来源域架构 (Provenance Plane, 2026-08-21)

**设计目标**: 按文件来源分域，spec plane 放行、data plane 拒绝。

**实际效果**:
- ✅ doc/ 目录下的文件确实被识别为 spec/document plane
- ✅ 通用文件读取工具确实能全文读取 spec plane 文件
- ❌ 但 **listing 工具链根本不走这条通道**
- ❌ listing_workflow.py 有自己的解析逻辑，主动屏蔽内容只给计数

**问题**: 来源域架构和 listing 工具链是**两套平行系统**，互不相通。修了左边没修右边。

### 7.2 smart_guard 白名单式 token 化 (2026-08-20)

**设计目标**: "不认识的 token 默认 hash，避免新形态漏检"。

**实际效果**:
- ✅ 确实降低了泄露风险（任何含数字的值默认 token 化）
- ❌ 但代价是 **spec 散文中的业务词也被 hash**
- ❌ 数据行连坐机制：一行内有数字 token，整行字母词也 hash

**问题**: 在 spec/document plane 文件中，这套逻辑不应该生效（或至少应该用 `profile: 'spec'` 参数关闭），但当前 post-execute 调用 smart_guard 时没有传 profile。

### 7.3 header_detect 白名单投影 (2026-08-21)

**设计目标**: 表头字段名白名单，非白名单列名变 `COLUMN_n`。

**问题**:
- 白名单只有 41 个通用词（name/date/value/count...）
- ALS 的核心列名 `DatasetName`/`SourceColumn`/`SASLabel`/`ItemOID` 全都不在白名单内
- 结果：ALS 表头语义完全丢失

**根本问题**: **白名单的边界判断错误**。应该是"数据列名需要投影，元数据列名（用于描述数据结构的列名）应该保留"。但当前实现没有这个区分，一刀切。

---

## 8. 系统性解决方案建议

### 8.1 最小修复方案（保留现有架构）

**目标**: 让 listing 链路至少能跑通一次真实数据。

| 修改 | 位置 | 说明 |
|---|---|---|
| 1. 修复 ALS 解析 | spec_parser.py | 增加真实 23-sheet 导出布局支持，静默截断改显式报错 |
| 2. 移除 medical_rule_provenance 拒绝 | emerald_listing_generator.py L411-424 | 改为 warning 而非主动拒绝 |
| 3. listing 收据增加需求文本 | listing_workflow.py L132-140 | `summary` 包含前 N 条需求的完整文本（受控数量） |
| 4. header_detect 白名单扩充 | header_detect.py | 增加 ALS 核心列名：DatasetName/SourceColumn/SASLabel/ItemOID |
| 5. post-execute spec plane 豁免 | tool-result-guard.js | spec plane 文件跳过表头投影，整表原样返回 |
| 6. smart_guard profile 参数 | index.js post-execute 调用 | 传 `profile: 'spec'` 跳过 CJK 归一化和连坐 hash |
| 7. 激活 shadow 模式 | cordis.patch.yml | 设为 `[{config: {id: clinical-data-guard, mode: shadow}}]` |

**预期效果**: 
- ALS 能解析出 mappings > 0
- AI 能看到部分需求文本（受控数量）
- spec 表头列名可读
- 误报不再锁死会话（shadow 模式）

**残留问题**: 
- AI 仍然只能看到"受控数量"的需求，不是完整的
- 硬编码生成器仍然无法理解任意自然语言规则
- 本质上是"打补丁让它勉强能跑"，不是根治

### 8.2 根治方案（架构重构）

**核心思路**: 采用"计划-执行"两段式（EMERALD_PROVENANCE_ARCHITECTURE 文档中的设计）

```
阶段 1: AI 理解需求（完全放开 spec 可见性）
   输入: spec 完整文本 + ALS 完整结构（不含任何数据值）
   输出: ListingPlan (JSON DSL)
   {
      datasets: [{name, source, columns, filters, sort}],
      derivedColumns: [{name, expression, refs}],
      layout: {freeze, toc, dropCodeValue, flagColumns...}
   }
   
阶段 2: 本地确定性执行器（完全隔离在 worker 内）
   输入: ListingPlan + data/*.sas7bdat
   验证: 计划中不得包含任何数据字面量（结构性保证死命令）
   输出: listing.xlsx（数据值全程不进 AI）
   
阶段 3: 收据返回（仅元数据）
   返回: {status, artifact: {name, sheets, rowCounts}, validation}
```

**优势**:
1. AI 职责恢复：理解需求、生成计划（这是它擅长的）
2. 数据值隔离：全程在 worker 内，结构性保证不出域
3. 规避动机消失：AI 有合法看结构的路（schema + 合成样本），不需要绕过
4. 判据可判定：验证 JSON 计划是否合规，而非识别"这串像不像数据"

**缺点**:
- 需要重构 listing 工具链（工作量大）
- 需要设计 ListingPlan DSL 和验证器
- 需要 AI 学习新的计划语言

---

## 9. 优先级建议

### P0 - 立即修复（否则无法继续开发）

1. **激活 shadow 模式** (cordis.patch.yml) - 防止误报锁死会话
2. **补齐依赖** (`pip install xlwt pyreadstat`) - 修复基线假绿
3. **listing 工具默认注册条件** - 至少让工具能被调用

### P1 - 本周修复（核心功能可用）

4. **修复 ALS 解析** - 支持真实 23-sheet 导出布局
5. **移除 medical 主动拒绝** - 改为 warning
6. **listing 收据增加需求文本** - 让 AI 能看到需求（受控数量）

### P2 - 本月修复（提升可用性）

7. **header_detect 白名单扩充** - ALS 核心列名可读
8. **post-execute spec plane 豁免** - spec 文件整表原样返回
9. **JS/Python 豁免口径对齐** - 消除双层拦截漂移

### P3 - 长期规划（根治）

10. **架构重构为"计划-执行"两段式** - 彻底终结补丁竞赛

---

## 10. 残余风险（即使完成所有修复）

### 10.1 最小修复方案的残余风险

| 风险 | 说明 | 接受理由 |
|---|---|---|
| AI 只能看到"受控数量"需求 | 长需求文本仍可能被截断 | 比完全看不到好；真实需求通常不超过 20 条 |
| 硬编码生成器无法覆盖所有规则 | 遇到新规则仍需改代码 | 明示为已知限制；至少常见场景能跑 |
| 表头白名单仍可能遗漏新列名 | 新 ALS 格式可能引入新列名 | 白名单可持续扩充；比全拦截好 |
| 补丁竞赛未终结 | 新数据形态仍可能误报 | shadow 模式兜底；至少不锁死会话 |

### 10.2 根治方案的残余风险

| 风险 | 说明 | 缓解措施 |
|---|---|---|
| AI 生成的计划可能包含错误逻辑 | 计划验证器可能漏掉某些错误 | 提供 dry-run 模式，用户可预览计划 |
| ListingPlan DSL 学习曲线 | AI 需要学习新语言 | 提供充足示例，few-shot 学习 |
| 重构工作量大 | 可能需要 2-4 周 | 分阶段迁移，渐进式替换旧链路 |

---

## 11. 结论

### 11.1 当前状态判决

**FAIL - 系统无法满足基本业务需求**

**判决依据**:
1. 唯一真实项目运行收据是失败收据 (E1)
2. 当前代码对真实数据必然失败 (E2: mappings=0)
3. 真实 spec 规则触发主动拒绝逻辑 (E3)
4. 零端到端真实数据测试覆盖 (E5)

### 11.2 根因总结

**不是"安全措施太严"，而是"架构与需求相反"**:

- 用户要 AI 理解需求 → 架构主动屏蔽需求给 AI
- 用户要表结构可读 → 架构把列名变成 `COLUMN_n`
- 用户要 spec 全文可读 → 通用通道确实可以，但 listing 工具链不走这条路

**职责倒挂是总根因**:
- AI 最擅长的事（理解自然语言需求）被架构禁止
- 程序做不了的事（理解"New\Modified的信息请标识"）却硬塞给硬编码生成器

### 11.3 建议行动

**如果只有 1 周时间**: 执行 P0+P1 修复（最小修复方案），至少让链路能跑通。

**如果有 1 个月时间**: 执行完整最小修复方案 (P0+P1+P2)，提升可用性到可接受水平。

**如果要根治**: 启动架构重构（"计划-执行"两段式），预计 2-4 周，彻底终结补丁竞赛。

---

## 附录 A: 关键代码位置索引

| 功能 | 文件 | 行号 | 说明 |
|---|---|---|---|
| listing 工具注册 | clinical-listing-plugin.js | L120-162 | localDataAccess 检查 |
| listing 收据构造 | listing_workflow.py | L132-140 | 只给计数不给内容 |
| ALS 解析 | spec_parser.py | L199-574 | 只认 3 种布局 |
| medical 拒绝逻辑 | emerald_listing_generator.py | L411-424 | 主动拒绝自然语言规则 |
| 表头白名单投影 | header_detect.py | L596-624 | 41 个通用词白名单 |
| 来源域判定 | planes.js | L97-169 | planeOf() 函数 |
| quickGuard | index.js | L589-602 | JS 正则初筛 |
| post-execute 处置 | tool-result-guard.js | L176-291 | 按 plane 分支处置 |
| llm/stream 出域 | index.js | L655-684 | check_egress_v2 调用 |
| smart_guard token 化 | smart_guard.py | L265-539 | 白名单式 token 化 |

---

**审计完成时间**: 2026-08-22 23:00
**审计工作量**: 逐文件阅读全部 src/*.js + security/*.py，交叉验证 docs/*.md，复现真实数据失败路径
**审计方法**: 静态分析 + 文档交叉验证 + 失败路径追踪 + 历史事故分析
