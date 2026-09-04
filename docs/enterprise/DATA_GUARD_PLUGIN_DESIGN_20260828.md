<!--
> **修订横幅(2026-08-28 晚)**:本文的"两规则"口径已被 ADR-0007 修订——场景②(doc/ 辅助 Excel
> 投影)整条退役,doc/ 零拦截;新增 tool-audit 通用车道护栏。开关宿主侧/fail-closed/审计
> 机制见 ADR-0007 历史记录;开关、stdout 与辅助 Excel 位置口径已被 ADR-0010 取代。
> 本文其余工程细节(节流、围栏、测试策略)仍具参考价值。
-->
# 数据拦截插件设计（按 2026-08-28 澄清需求重写）

> 需求原文（2026-08-28 用户澄清，效力高于 ADR-0017/0018 的 V2 表述）：
> 1. 固定项目目录下 doc/ 文件夹中所有文件允许全量读。
> 2. 数据拦截开关默认打开。拦截**只有两种场景**：
>    ① SAS 数据集的 data 原始数据不允许输出给 AI；
>    ② spec 需求中提到的辅助 Excel 表格的 data 数据不允许输出给 AI。
>    除这两种情况外，其他所有任何操作都不做处理。
> 3. 关闭开关时：任何所有限制都不做拦截处理。

---

## 1. 需求语义定标（含两处歧义裁决）

| # | 需求 | 机械判据（可判别，无内容形态识别） |
|---|---|---|
| R1 | doc/ 全量读 | `doc/**` 下文本类文件（.txt/.md）回执含**全文 content**，不再投影为 200 字预览 |
| R2a | 场景①：SAS 数据集原始数据不出域 | `.sas7bdat` / `.xpt` / `.csv`（含加密归档解出的数据集）读取回执 → 只出**元数据白名单**：`name/path/columns/rowCount/dtypes/nullCount/uniqueCount`，`sample` 行值不建不出 |
| R2b | 场景②：辅助 Excel 数据不出域 | `doc/**` 下 `.xlsx/.xls/.xlsm`（即 spec 辅助表）读取回执 → 只出**结构白名单**：`path/type/size/structure(含 headerRows 表头带)/mappings(ALS 三元组)/datasets`；`rows` 单元格值不建不出 |
| R3 | 其他一律不碰 | run_code 的 stdout/stderr、错误消息、失败清单、路径、AI 产物（model-output/derived）、publish 统计、通用工具面——**零处理**（沿用范围铁律） |
| R4 | 开关：默认开、关=零拦截 | 宿主侧开关（UI 设置页），**非工具参数**；关闭时 worker 不做任何投影，回执原样 |

**歧义裁决**（需求未明说、按整体意图裁定，落地前可推翻）：

- **doc/ 全量读 vs 场景② 的张力**：辅助 Excel 就放在 doc/ 里。裁决 = 文件类型切分——doc/ 文本全量读（R1），doc/ Excel 按场景②投影（R2b）。否则场景②永远不触发，需求自相矛盾。
- **.csv 归类**：UAT 里 csv 是 SAS 数据集的交付形态，归场景①（R2a），与现行 `DataSource.SAS_DATASET` 口径一致。
- **headerRows 含首批数据行**：现行 `_sheet_structure` 把表头行 + 1 行数据行并入"结构"（多层表头的第 2 层以数据行形态存在）。保留该约定（否则多层表头识别失效），**显式接受每 sheet ≤2 行随结构出域**，记为已知边界而非缺陷。
- **"spec 提到的"不做事后语义判定**：辅助表 = doc/ 下全部 Excel（路径判定），不解析 spec 文本去筛"哪些被提到"——那是业务判断，交给 AI 推理，不写死在拦截层。

---

## 2. 总体架构：一套插件、三个面、一个开关

不新造 bundle。功能落在现有两个企业包上，`DataSecurityService` 是唯一开关：

```text
┌─ ui-settings bundle ─────────────────────────────┐
│ DataSecurityService（已有，当前死接线 → 本次接活） │
│  · 设置页开关（settings-page.ts 已有 UI）          │
│  · GET/POST /api/settings/data-security           │
│  · 持久化 profiles/enterprise/.data-security.json │
│  · isEnabled() 读取点 + 'data-security/changed'   │
└──────────────┬───────────────────────────────────┘
               │ 宿主每次工具调用时读取（非模型传入）
┌─ listing bundle ─▼────────────────────────────────┐
│ index.ts  三工具：参数表删除 redactDisabled         │
│   execute() → request.dataInterception =           │
│     ctx.dataSecurityService?.isEnabled() ?? true   │
│ worker.py（持久 Python 会话，每 Agent 一个）        │
│   dispatch(): 开关关 → 回执原样返回，零处理         │
│   开关开 → data_guard.project(response) 两条规则    │
│ discovery.py 全量读 + _source 标注（照旧）          │
│ data_guard.py（redact.py 重写）两条投影规则          │
│ sandbox.py builtins 白名单（执行安全，不受开关控制） │
└───────────────────────────────────────────────────┘
```

开关语义四条：

1. **宿主侧**：模型永远接触不到开关。彻底修掉审计 P0-1（`redactDisabled` 工具参数）。
2. **默认开 + fail-closed**：服务未装配、配置读不到、读取出错 → 一律按"开"处理。
3. **免重启**：开关是每请求下发的旗标，持久 worker 不重建（对比 emerald v2 的 onSwitch→进程重启）。
4. **只控数据拦截**：sandbox builtins 阻断（`__import__`/`open` 等）是程序执行安全，独立于开关，永不解除（ADR-0021 口径）。

---

## 3. 核心机制

### 3.1 源头分类（source_registry.py 收敛为三类 + 兜底）

```python
class DataSource(str, Enum):
    DATASET = "dataset"        # 场景①：sas7bdat/xpt/csv + 归档解出的数据集
    AUX_EXCEL = "aux-excel"    # 场景②：doc/ 下的 xlsx/xls/xlsm
    MODEL_OUTPUT = "model-output"  # AI 产物（含 derived）→ passthrough
# doc/ 文本不再标 spec-document 投影类——R1 要求全量，直接 passthrough（仍带 _source
# 标记便于审计区分，但不在投影表里 = 未标记不碰）
```

投影表只剩两条（改这里就是改整条红线）：

```python
PROJECTION = {
    DataSource.DATASET.value:    ("name", "path", "columns", "rowCount",
                                  "dtypes", "nullCount", "uniqueCount"),
    DataSource.AUX_EXCEL.value:  ("path", "type", "size", "structure",
                                  "mappings", "datasets"),
}
```

`_walk` 递归投影机制照旧：只投影带标记子树，其余对象恒等不动。**不再有 200 字 preview 逻辑、不再有模式扫描。**

### 3.2 开关流（每请求）

```text
POST /api/settings/data-security {enabled:false}
  → DataSecurityService.setEnabled(false) → 落盘 → emit 'data-security/changed'
     → listing execute() 下次调用读到 false → request.dataInterception=false
        → worker.dispatch() 直接 return response（一行都不改）
```

### 3.3 构建期节流（不建再剥，省内存与协议行）

- `dataset_payloads(..., with_sample=dataInterception)`：开关开 → 根本不构建 `sample` 字段。
- `read_spec_files(doc, build_rows=dataInterception)`：开关开 → 不构建 xlsx 的 `rows`。
- 投影层仍保留（双保险 + 覆盖 scan_excel_structures 等旁路载荷）。

### 3.4 审计（极简 JSONL）

`worker.dispatch` 投影发生时记一行（无任何数据值）：时间、开关态、操作、被投影载荷的 source 类与 path（path 属操作数据，铁律允许出）+ toggle 事件由 DataSecurityService 记。审计写失败**不阻断**（审计不是防线，投影才是），但记入 stderr。

---

## 4. 改动清单（文件级）

| 文件 | 动作 |
|---|---|
| `listing/src/index.ts` | **删** 3 处 `redactDisabled` 参数与 REDACT_DISABLED 常量；inject 加 `dataSecurityService`；execute 每次读 `isEnabled() ?? true` 下发 `dataInterception`；systemPrompt 数据安全段改写为新口径（doc/ 文本全量、数据集元数据、Excel 结构） |
| `listing/python/redact.py` → `data_guard.py` | **重写**：删 preview/STRUCTURE 200 字逻辑，投影表收敛为两条；`sanitize_receipt(receipt, data_interception: bool)` 开关关闭一行短路 |
| `listing/python/worker.py` | dispatch 读 `request.dataInterception`（缺省 True = fail-closed）；inspect 调用带 `with_sample/build_rows` 节流；审计落点 |
| `listing/python/discovery.py` | `dataset_payloads`/`read_spec_files` 加构建旗标；txt/md 载荷不再走投影类（保留 `_source="spec-document"` 标记仅作审计区分）；`.csv` 维持 DATASET 类 |
| `listing/python/source_registry.py` | 枚举改三类；`tag_dataframe` **移出**沙箱命名空间（修审计 P1-1：源头标记不可由模型重贴） |
| `listing/python/sandbox.py` | builtins 白名单保留；补 `scan_excel_structures/list_files` 的项目根路径围栏（禁 `../` 穿越，修 P0-4 一半）；（可选）恢复 AST 禁用表：`read_*/to_*/eval/query` 按名阻断——属执行安全，理由：合法数据已全部经 `datasets` 注入，沙箱内文件 IO 无正当用途 |
| `ui-settings/src/data-security-service.ts` | 接活：暴露 `isEnabled()`；`protectedPatterns` 死配置**删除或降级**为场景文件类型扩展名配置（`datasetExtensions`/`auxExcelExtensions`，默认 sas7bdat;xpt;csv / xlsx;xls;xlsm）；toggle 事件审计 |
| `tool-audit/src/data-interceptor.ts` | **删除**空转拦截器与误导注释（"pre-execute 不拦截"之类）；该包降级为审计消费端或整体移除 |
| `listing/src/redaction.test.ts` → `data-guard.test.ts` | 验收矩阵重写（见 §6） |

---

## 5. 明确不做的事（对齐"其他一律不碰"）

stdout/stderr 脱敏、错误消息处理、AI 产物投影、通用 read/bash 工具拦截、内容模式扫描（PHI/日期/ID 正则——已删，不复活）、llm/stream 出域门（emerald v2 路线，不进本插件）、会话日志改写。

**已知边界（显式接受，写进 ADR 即可）**：

1. run_code 里 `print(datasets['ae'].to_string())` 会经 stdout 出域——铁律范围内，威胁模型是"非对抗 AI"；若未来要收，是另立场景③的事，不偷加。
2. 通用工具直接 cat 二进制 sas7bdat 得乱码（自限性）；对抗性 bash+python 属执行安全域，由 harness 沙箱/权限插件（如社区 dsh-permission-rules / dsh-egress-guard）负责，不属本插件。
3. Excel 结构带的 headerRows 含 ≤2 行首批数据（多层表头识别需要，§1 裁决）。

---

## 6. 验收矩阵（data-guard.test.ts）

| 用例 | 开关 | 断言 |
|---|---|---|
| SAS 元数据出、行值不出 | 开 | datasets 含 columns/rowCount/dtypes；payload 无 SUBJ-777 等行值、无 sample 键 |
| doc/ 文本全量读 | 开 | documents[0].content 含 200 字窗外的 REQUIREMENT-TAIL-MARKER（**与现行测试相反**） |
| 辅助 Excel 结构出、单元格不出 | 开 | structure/mappings 在、rows 键不存在 |
| stdout 原样 | 开 | run_code print 回显完整、无任何改写 |
| 开关关闭全放行 | 关 | sample 3 行、xlsx rows、全文全部在回执中 |
| 开关不在工具 schema | — | 三工具 parameters JSON 无 redactDisabled 键 |
| fail-closed | — | 请求不带 dataInterception 旗标 → 按开处理（元数据投影生效） |
| 沙箱独立 | 关 | `__import__`/`open` 仍 NameError |
| 穿越围栏 | 开 | scan_excel_structures('../x') 抛错 |

## 7. 落地顺序

1. 第一步（半天）：index.ts 删参 + 服务接线 + worker 旗标短路——P0-1 即刻闭合。
2. 第二步：data_guard.py 重写 + discovery 节流 + 测试矩阵（含 doc/ 全量读的行为反转）。
3. 第三步：sandbox 围栏/AST 表、tag_dataframe 移出、审计 JSONL、tool-audit 清理。
4. 收尾：ADR-0017/0018 出修订版（doc/ 全量读取代 200 字预览口径），旧 redact.py 删除。

---

*设计基于 2026-08-28 工作树实测（discovery.py/_sheet_structure/worker.py/settings-page.ts 均已核对）。本插件 = listing（执行面）+ ui-settings（开关面）+ DataSecurityService（开关本体），不新增 bundle。*
