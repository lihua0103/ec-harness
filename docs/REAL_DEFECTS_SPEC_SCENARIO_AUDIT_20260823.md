# 真实缺陷报告：需求文档识别、场景推断与 Listing 入口

**日期：** 2026-08-23  
**项目：** `G:\home\dsh-guard` / `dsh-clinical-data-guard`  
**真实项目目录：** `G:\home\Clinical-Data`  
**报告性质：** 代码与真实项目复现报告，不是设计猜测  
**当前结论：** FAIL。现有自动化测试全绿，但真实需求识别契约仍未满足。

## 1. 执行摘要

当前 Listing 工作流存在两个直接阻断业务的问题：

1. `doc` 目录中的辅助数据文件会被错误当作 specification 需求文档读取。
2. `clinical_listing_inspect` 要求调用方预先提供 `scenario`，系统没有根据需求文档自动推断 `report`、`medical`、`manual` 或 `rbqm`。

在真实项目 `CGB3002-TEST` 中已复现：

| 文件 | 当前代码分类 | 实际角色 | 结论 |
|---|---|---|---|
| `RT01_DM Status Report Specification_11Aug2026.xlsx` | `als` | report 场景 specification | 错误分类 |
| `Page_Details.xlsx` | `specification` | report 辅助数据 | 错误纳入需求文档 |
| `Query_Details.xlsx` | `specification` | report 辅助数据 | 错误纳入需求文档 |
| `RT01_V1.0_29JUN2026_PROD.xls` | 未发现 | report 辅助数据 | 被 `.xlsx` 扫描规则漏掉 |
| `crViewer.xls` | 未发现 | report 辅助数据 | 被 `.xlsx` 扫描规则漏掉 |

这会导致模型拿不到正确的 report specification 正文，同时收到辅助数据文件被伪装成需求结构后的错误上下文。

## 2. 影响等级

### D1：辅助数据污染需求文档集合

**等级：P0**  
**影响：** 需求理解错误，可能生成错误 ListingPlan，或在 inspect 阶段读取大量非需求数据。

### D2：明确的 report specification 被分类为 ALS

**等级：P0**  
**影响：** specification 的 `requirements` 在安全投影阶段被清空，report 需求无法完整到达模型。

### D3：场景必须由模型预先猜测

**等级：P0**  
**影响：** 在需求识别前已经要求 `scenario`，无法实现“读取需求后自动选择场景”的真实工作流。

### D4：`.xls` 辅助文档未进入统一识别链路

**等级：P1**  
**影响：** report 辅助资料可能完全不可见，后续本地执行器无法获得必要的表结构元数据。

### D5：大型辅助数据被当作需求全文解析，造成性能阻塞

**等级：P1**  
**影响：** `CGB3002-TEST/Page_Details.xlsx` 被解析出约 5000 条“requirements”，单项目需求发现过程超过 30 秒，可能触发 worker timeout。

## 3. 代码证据

### 3.1 候选文件发现过宽

文件：`dsh-clinical-data-guard/security/spec_parser.py`  
函数：`find_spec_documents()`

当前逻辑只要满足以下条件就会纳入需求文档：

```python
project / "doc" / "**/*.xlsx"
```

没有排除：

- `Page_Details.xlsx`
- `Query_Details.xlsx`
- `crViewer.xls`
- `*_PROD.xls`
- 数据库导出文件
- report 模板和辅助数据

### 3.2 文档角色只有两类

文件：`dsh-clinical-data-guard/security/spec_parser.py`  
函数：`classify_spec_document()`

当前返回值只有：

```text
als
specification
```

缺少：

```text
report_support_data
template
supplement
data_dictionary
```

因此代码无法表达“文件位于 `doc` 目录，但不是需求正文”。

### 3.3 ALS 规则覆盖明确的 specification 文件名

当前逻辑先执行文件名/表头 ALS 判断。真实文件：

```text
RT01_DM Status Report Specification_11Aug2026.xlsx
```

被返回为：

```text
als
```

随后 `listing_inspector.py` 中的 `_safe_spec()` 对 ALS 文档执行：

```python
"requirements": parsed.get("requirements", []) if kind != "als" else []
```

因此该文件的需求正文被清空。

### 3.4 Listing 工具要求 scenario 必填

文件：`dsh-clinical-data-guard/src/clinical-listing-plugin.js`

当前参数契约要求：

```js
scenario: {
  type: 'string',
  enum: ['medical', 'rbqm', 'manual', 'report'],
  required: true
}
```

当前实际流程是：

```text
模型先猜 scenario
    -> clinical_listing_inspect(project, scenario)
    -> 代码读取 doc
```

目标流程应该是：

```text
读取 doc 目录文档
    -> 识别 specification / ALS / template / 辅助数据
    -> 根据需求语义推断场景
    -> inspect / submit_plan / execute
```

## 4. 真实复现步骤

### 4.1 复现辅助数据被错误纳入

在仓库 Python 环境执行：

```powershell
Set-Location G:\home\dsh-guard\dsh-clinical-data-guard

@'
from pathlib import Path
from security.spec_parser import find_spec_documents, classify_spec_document

project = Path(r"G:\home\Clinical-Data\CGB3002-TEST")
for path in sorted((project / "doc").iterdir()):
    if path.is_file():
        kind = classify_spec_document(path) if path.suffix.lower() == ".xlsx" else "not-discovered"
        print(path.name, kind, path in find_spec_documents(project))
'@ | python -
```

实际结果：

```text
Page_Details.xlsx specification True
Query_Details.xlsx specification True
RT01_DM Status Report Specification_11Aug2026.xlsx als True
RT01_V1.0_29JUN2026_PROD.xls not-discovered False
crViewer.xls not-discovered False
```

预期结果：

```text
Page_Details.xlsx report_support_data True
Query_Details.xlsx report_support_data True
RT01_DM Status Report Specification_11Aug2026.xlsx specification True
RT01_V1.0_29JUN2026_PROD.xls report_support_data True
crViewer.xls report_support_data True
```

### 4.2 复现辅助数据被解析为需求

执行真实 inspect 或直接调用：

```powershell
Set-Location G:\home\dsh-guard\dsh-clinical-data-guard

@'
from security.spec_parser import find_spec_documents, classify_spec_document, parse_spec_document
from pathlib import Path

project = Path(r"G:\home\Clinical-Data\CGB3002-TEST")
for path in find_spec_documents(project):
    kind = classify_spec_document(path)
    parsed = parse_spec_document(str(path), "als" if kind == "als" else "spec")
    print(path.name, kind, "requirements=", len(parsed.get("requirements", [])))
'@ | python -
```

实际观察：

```text
Page_Details.xlsx ... requirements=5000
```

这证明辅助数据不只是“被列出”，而是已经进入需求解析语义，造成性能和语义污染。

### 4.3 复现 scenario 必填设计

查看工具契约：

```powershell
rg -n "scenario|required|SCENARIOS" `
  G:\home\dsh-guard\dsh-clinical-data-guard\src\clinical-listing-plugin.js `
  G:\home\dsh-guard\dsh-clinical-data-guard\security\listing_inspector.py
```

实际结果：

```text
scenario 是 clinical_listing_inspect 的 required 参数
inspect_listing_context() 直接拒绝不在 SCENARIOS 的值
```

没有自动场景推断入口。

## 5. 当前测试证据

仓库现有自动化套件已执行完成：

```text
TOTAL_FAILED_SUITES=0
```

通过项目包括：

```text
Listing 计划契约：37/37
Listing 安全：19/19
通用安全：62/62
Listing E2E 修复：9/9
插件运行时：31/31
运行时韧性：4/4
插件契约：1/1
安装包 smoke：1/1
绕过矩阵：BY-1..BY-13
Node DLP：23/23
Node planes：PASS
```

但现有测试没有覆盖以下业务契约：

- `Page_Details.xlsx` 不得进入需求正文；
- `Query_Details.xlsx` 不得进入需求正文；
- 明确包含 `Status Report Specification` 的文件不得分类为 ALS；
- `.xls` 辅助数据必须进入统一元数据识别链路；
- scenario 可以缺省并由需求文档自动推断；
- 8 个真实项目的文档角色、场景和最终 `completed` 产物。

所以 `TOTAL_FAILED_SUITES=0` 不代表本问题不存在，而是现有测试覆盖不足。

## 6. 修复设计建议

### 6.1 建立文档角色分类

建议把分类结果扩展为：

```text
specification
als
report_support_data
template
supplement
data_dictionary
unknown
```

分类优先级建议：

1. 明确的文件名语义：`Specification`、`Spec`、`Listing要求`、`Medical Listing`、`Status Report`；
2. 文档表头和 sheet 元数据；
3. 辅助数据特征：`Page`、`Query`、`Viewer`、`Export`、`Database`、`PROD`；
4. ALS 字段结构特征；
5. 无法确定时返回 `unknown`，不得默认为 specification。

### 6.2 specification 文件名优先于 ALS 表头猜测

对于：

```text
RT01_DM Status Report Specification_11Aug2026.xlsx
```

必须优先识别为：

```text
role = specification
scenario = report
```

ALS 只能在没有明确 specification 语义且结构特征充分时生效。

### 6.3 辅助数据也要读取，但只读取 metadata-only

用户要求的正确边界不是“不读取 doc”，而是：

```text
需求正文：受信域完整读取
ALS：读取字段结构和映射
report 辅助数据：只读取文件类型、sheet、行数、列名
临床数据值：只能进入本地执行器，不能进入模型载荷
```

因此辅助数据不应被排除出整个工作流，而应从 `documents` 移到独立的：

```json
{
  "supportData": [
    {
      "name": "Page_Details.xlsx",
      "role": "report_support_data",
      "fileType": "xlsx",
      "sheets": [],
      "rowCount": 0,
      "columns": []
    }
  ]
}
```

返回对象中不得出现单元格值和记录内容。

### 6.4 scenario 改为可选并增加自动推断

建议：

```text
scenario: optional
```

如果调用方没有提供 scenario：

1. 先执行 document discovery；
2. 识别 specification 和 supportData；
3. 从 specification 文件名、正文标题、结构语义推断场景；
4. 输出 `inferredScenario` 和置信度；
5. 多个场景冲突时返回结构化 `SCENARIO_AMBIGUOUS`，不得静默猜测。

### 6.5 `.xls` 必须进入统一发现链路

当前 `find_spec_documents()` 只扫描 `.xlsx`，应至少支持：

```text
.xlsx
.xls
.xlsm
.txt
.pdf
```

不同格式仍需遵守各自 metadata-only 和需求正文读取边界。

## 7. 验收标准

### 必须通过

1. `CGB3002-TEST` 自动识别为 `report`；
2. `RT01_DM Status Report Specification_11Aug2026.xlsx` 分类为 `specification`；
3. `Page_Details.xlsx`、`Query_Details.xlsx` 分类为 `report_support_data`；
4. `crViewer.xls`、`RT01_V1.0_29JUN2026_PROD.xls` 不再被静默漏掉；
5. `supportData` 只返回结构元数据，不含数据值；
6. `scenario` 缺省时 inspect 仍能开始；
7. 场景冲突时返回 `SCENARIO_AMBIGUOUS`；
8. 真实项目链路达到：

```text
inspect.status = ready
submit.status = validated
execute.status = completed
```

### 必须新增回归测试

```text
test_report_specification_beats_als_header_heuristic
test_page_details_is_report_support_data
test_query_details_is_report_support_data
test_xls_report_support_files_are_discovered
test_scenario_is_inferred_from_specification
test_ambiguous_scenario_fails_with_structured_code
test_support_metadata_contains_no_cell_values
test_cgb3002_real_project_discovery
```

## 8. 最终结论

本问题已被真实项目复现，属于 P0 级业务缺陷：

```text
候选文件发现过宽
    + 文档角色分类不足
    + ALS 启发式覆盖明确 specification
    + .xls 文件被漏扫
    + scenario 要求调用方预先猜测
    = AI 无法稳定识别真实需求，Listing 工作流无法可靠启动
```

当前不应以“单元测试全绿”作为交付依据。修复后必须以真实项目的“文档角色识别、自动场景推断、metadata-only inspect、validated、completed”全链路结果作为交付门禁。
