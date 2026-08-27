# 临床 Listing 插件最终企业级实现方案

> 时间：2026-08-27
> 范围：`packages/enterprise/listing`（TypeScript MCP 入口 + Python 持久 Worker + Excel Writer）
> 文档核心：**智能最大化 + 数据红线安全**——除"sas 数据集 / spec 辅助文件 / 原始 data 行"绝对禁出域外，其余环节完全放开交给 harness / AI 推理。

---

## 0. 三条核心约束（红线 + 原则）

### 0.1 数据红线（硬约束，绝对不可越界）

| 类型 | 数据形态 | 是否可送 AI | 出域方式 |
|---|---|---|---|
| **sas 数据集** | `.sas7bdat` / `.xpt` 二进制行数据 | ❌ 严禁 | 不可返回原始行；只可返回列级结构 |
| **原始 data** | 任何数据集的 `df.head(N) / df.values / df.to_dict()` 等暴露实际值的形态 | ❌ 严禁 | 不可作为回执返回；只能在 Worker 进程内消费 |
| **spec 辅助文件** | `doc/` 下 `.xlsx/.xls/.xlsm/.txt/.md` 的内容文本（含 ALS 表格的 label / datasetName / sourceColumn） | ✅ 允许 | 经清洗/聚合后可作为回执 |
| **统计聚合** | rowCount / dtype / nullCount / unique_value_set（去标识枚举）/ 文件路径 | ✅ 允许 | 元数据级 |
| **AI 写出的 outputs** | 模型在 sandbox 内定义并经 publish 落盘的 DataFrame | ✅ 允许（产物） | publish 后回执只给 sheet 级摘要 |

### 0.1.1 红线精确化（重要补充）

**「原始数据」的定义**：单元格**值**（cell value）。所有数据行 / 列内容 / 日期 / 姓名 / 编号 / 受试者 ID 等具体值。

**「Excel 表结构字段」的定义**：表的**结构特征**——
- 列名、列顺序、列数
- 表头行数（单层 / 多层）
- 表头层级关系（哪些列在第几层、合并单元格树）
- 数据类型（dtype）
- 行数 / 空值统计 / 去重计数
- 合并单元格范围、冻结窗格位置
- 命名空间、目录结构、文件路径
- sheet 名、sheet 数量

**规则**：
- ✅ **结构字段一律允许送 AI**——多场景 listing 的横向 / 纵向 / 多表头 / 不规则表结构，AI 必须能看到结构才能推理
- ❌ **单元格值禁止送 AI**——行内容、数值、字符串值不可见
- ✅ **程序行为不禁止**——Worker 可以读 Excel、解析 sheet 结构、按结构重组数据、写出新 Excel——程序操作不受限
- 🚧 **限制只在「回执字段」上**——什么字段能回给 AI 是唯一边界

### 0.2 智能原则（最高原则，软约束，决定系统形态）

> **不写死业务定义，最大程度利用 AI 推理；程序只做机械交付+信息供给。**

### 0.3 输出标准（视觉规范，不属于业务定义）

- 颜色 / 字体 / 字号 / 边框 / 对齐 / 行高 / 列宽算法 / 冻结算法 → **保留为常量与算法**
- 第 1 行必放什么、是否放 HYPERLINK、是否合并 → **交回 AI 自由组合**
- 判断标准：**不影响"这条数据是什么"，只影响"这条数据长什么样"——就是输出标准**

---

## 1. 总体架构

```
┌──────────────────────────────────────────────────────────────────┐
│  AI Agent (Harness)                                               │
│  智能：读 spec → 理解需求 → 编写 pandas 代码 → 定义 outputs        │
│  限制：只能调工具；sandbox 内禁止 to_excel / to_csv                │
└──────────────────────────────────────────────────────────────────┘
          │                      │                       │
          ▼                      ▼                       ▼
   listing_inspect       listing_run_code         listing_publish
          │                      │                       │
          ▼                      ▼                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  TypeScript MCP (src/index.ts)                                    │
│  - 单 agent 单 worker，持久进程                                   │
│  - system prompt 注入"红线 + 工作流 + 输出标准"                   │
│  - 不解析 stdout/stderr；只做透传                                  │
└──────────────────────────────────────────────────────────────────┘
          │                      │                       │
          ▼                      ▼                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Python Worker (python/worker.py)                                 │
│  - 三操作：inspect / run_code / publish                            │
│  - 全局 session：_session_project / _session_datasets / _outputs   │
│  - exec 沙箱：safe_builtins 白名单 + 屏蔽 __import__ / open / ...  │
└──────────────────────────────────────────────────────────────────┘
          │                      │                       │
          ▼                      ▼                       ▼
   机械 IO：                 sandbox exec：              create_multi_sheet_excel
   - 列枚举                  - 代码只能引用 datasets    （原子临时文件 + os.replace）
   - 行数统计                  + pd / np + math
   - 加载 sas/xpt/csv        - 必须定义 outputs dict
   - 不返回行数据            - 不允许写文件
```

---

## 2. 三段式工作流（契约）

### 2.1 `listing_inspect`

**输入**：`project`（绝对路径）、`scenario?`、`credentialRef?`

**Worker 行为**：
1. `Path(request["project"]).resolve()`——项目根固定
2. `read_spec_files(project / "doc")`——读 spec/ALS 文本内容（**这一类是允许出域的**）
3. `collect_datasets(..., metadata_only=True)`——只 `head(0)` 拿列，**绝不读数据行**

**返回（已脱敏的元数据）**：

```python
{
  "ok": True,
  "action": "listing-inspect",
  "inspection": {
    "scenario": "medical",                       # 宿主传入
    "documents": [                               # spec 辅助文件：允许出域
      {"path": "spec/RT01.xlsx", "type": "als",
       "datasets": ["DM", "AE"], "mappings": [...]}
    ],
    "datasets": [                                # sas 数据集：仅元数据
      {"name": "DM", "path": "raw/dm.sas7bdat",
       "columns": ["USUBJID", "AGE", "SEX"],     # 列名允许（不是 data）
       "rowCount": 1234,                         # 行数允许
       "dtypes": {"AGE": "int64"},               # 类型允许
       "nullCount": {"AGE": 0}}
    ],
    "failures": [],
    "dataClass": "METADATA_ONLY"
  }
}
```

**关键脱敏点**：
- `documents[*].content` 不返回——ALS 已被映射成 `{datasetName, sourceColumn, label}` 三元组（标签语义，而非原表行）
- `datasets[*]` 没有 `sample` / `preview` / 前 N 行——只到列为止

### 2.2 `listing_run_code`

**输入**：`project`、`code`（Python 源码）、`credentialRef?`

**Worker 行为**：
1. session 切换检查：`if _session_project != project: 重新 collect_datasets(..., metadata_only=False)`
2. 构造 sandbox：
   ```python
   safe_builtins = {
       "len", "range", "enumerate", "zip", "list", "dict",
       "set", "tuple", "str", "int", "float", "bool",
       "min", "max", "sum", "abs", "round", "sorted", "print",
       "isinstance", "hasattr", "callable", "any", "all", "type",
       # 禁止：__import__ / open / getattr / setattr / eval / exec /
       # globals / locals / Exception / compile / input / vars / help
   }
   environment = {
       "__builtins__": safe_builtins,
       "datasets": _session_datasets,   # 沙箱内唯一接触原始数据的句柄
       "pd": pd, "np": np, "math": math,
       # 不暴露：re / os / sys / json / pathlib / zipfile / urllib
   }
   ```
3. `exec(compile(code, "<listing-code>", "exec"), environment)`
4. 校验 `environment["outputs"]` 存在且为 `dict[str, DataFrame]`

**返回（产物级元数据，不带原始行）**：

```python
{
  "ok": True,
  "action": "listing-run-code",
  "receipt": {
    "outputCount": 51,
    "outputs": {
      "LISTING_DM_01": {
        "rowCount": 1234,                    # 行数允许
        "columns": [
          {"name": "USUBJID", "dtype": "object",
           "nullCount": 0},
          ...
        ]
        # 不返回：前 N 行 / sample / to_dict()
      }
    },
    "publishReady": True,
    "stdout": "...", "stderr": "..."         # stdout/stderr 已截断到 16K
  }
}
```

**关键脱敏点**：
- `metadata[*].columns[*]` 不含 `sampleValues` / `topValues` / `preview`
- `metadata[*].rowCount` 是允许的（元数据级别，不构成隐私）
- 沙箱里 AI 即使写 `print(df.head())` 也不会泄漏到 AI 视角——因为 print 走 `capture_out` 写进 receipt 的 `stdout` 字段，然后 **system prompt / worker 都要拦截这个字段回显给 AI**

> ⚠️ **关键修正（与之前差异）**：当前 system prompt 只在"代码层"禁 `print(df)`，但 **AI 可以直接 Read receipt.stdout 看到数据行**。最终方案必须在 worker 端对 `capture_out` 做行级扫描拦截，详见 §6。

### 2.3 `listing_publish`

**输入**：`project`、`scenario`、`trackChanges?`

**Worker 行为**：
1. 校验 `_last_outputs` 存在 + project 与 session 一致
2. `create_multi_sheet_excel(_last_outputs, output_path, scenario, track_changes=...)`
3. 落盘到 `project/.clinical-listing/output/{scenario}/{scenario.upper()}_LISTINGS.xlsx`

**返回**：

```python
{
  "ok": True,
  "action": "listing-publish",
  "receipt": {
    "outputFile": ".clinical-listing/output/medical/MEDICAL_LISTINGS.xlsx",
    "scenario": "medical",
    "dataClass": "REAL",
    "format": "single-workbook-multi-sheet-xlsx",
    "statistics": {
      "totalRows": 12345,
      "totalSheets": 52,
      "listingSheetCount": 51,
      "sheetNames": ["Content", "LISTING_DM_01", ...],
      "scenario": "medical"
      # 不返回：任何 sheet 的数据预览
    }
  }
}
```

---

## 3. Excel Writer 重构（去掉写死的业务定义，保留样式规范）

### 3.1 当前状态（已识别的问题）

| 模块 | 状态 | 处置 |
|---|---|---|
| `_prepare_outputs` 强塞 `COMPARISON_COLUMNS`（5 个审核列） | ❌ 写死业务 | **删** |
| `STANDARD_SCENARIOS` / `COMPARISON_LABELS` 常量 | ❌ 写死业务 | **删** |
| `_build_listing` 写死 Row 1=HYPERLINK / Row 2=Label / freeze A3 / A1:F1 合并 | ❌ 写死排版 | **删**（保留算法） |
| `_align_previous_columns` 按位置重命名 | ⚠️ 半个写死 | **改为由 AI 决定** |
| `load_previous_version` 硬编码 `min_row=3` | ❌ 写死读取 | **改为暴露原文件路径，让 AI 决定** |
| `unique_key_columns` 死参数 | ❌ 冗余 | **删** |
| `reportStructureApplied / rbqmStructureFlexible / standardStructureApplied` 回写字段 | ❌ 业务定义泄漏 | **删** |
| 样式常量（PALE_BLUE / HEADER_FONT / GRID_BORDER / CENTER / HEADER_ALIGNMENT / REPORT_*） | ✅ 输出标准 | **保留** |
| 列宽算法 / 冻结算法 / 默认字号 11pt | ✅ 输出标准 | **保留** |
| REPORT_COLUMN_WIDTHS / REPORT_HEADER_HEIGHTS（按 sheet 名字典查列宽） | ⚠️ 半写死 | **改成可继承 AI 给的样式 spec** |

### 3.2 重构后的 Writer 形态

`multi_sheet_writer.py` 退化成 **纯样式原语库 + 原子写**：

```python
def create_multi_sheet_excel(
    outputs: Dict[str, pd.DataFrame],
    output_file: Path,
    track_changes: bool = True,
) -> Dict[str, Any]:
    """原子生成唯一 Excel；不写死场景分支，由 system prompt + AI 自决样式。"""
    normalized = normalize_sheet_outputs(outputs)  # 只验 sheet name + 类型
    previous = _read_previous(output_file) if track_changes else None
    changes = calculate_changes(previous, normalized)

    wb = Workbook()
    # 不再有 scenario 分支；AI 在 run_code 里通过 attrs 决定是否要 Cover/Content/...
    # 简化入口：所有 sheet 走同一渲染路径
    _apply_default_styles(wb, normalized)  # 全局默认样式（输出标准）
    if "cover" in normalized:
        _render_cover(wb, normalized["cover"])
    if "content" in normalized:
        _render_content(wb, normalized["content"], changes)
    for sheet_name, frame in normalized.items():
        if sheet_name in ("cover", "content"):
            continue
        _render_listing(wb, sheet_name, frame, header_rows=int(frame.attrs.get("header_rows", 1)))

    # 原子写
    output_file.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{output_file.stem}-", suffix=".xlsx", dir=output_file.parent)
    os.close(fd)
    tmp_path = Path(tmp)
    try:
        wb.save(tmp_path); wb.close()
        os.replace(tmp_path, output_file)
    finally:
        tmp_path.unlink(missing_ok=True)

    return {"outputFile": str(output_file), "sheetNames": list(normalized.keys()),
            "totalRows": sum(len(f) for f in normalized.values()),
            "listingSheetCount": len([k for k in normalized if k not in ("cover", "content")])}
```

### 3.3 AI 控制排版的机制

AI 在 sandbox 内通过 `df.attrs["_excel_layout"]` 传渲染参数：

```python
# AI 写代码示例：把某表配成"单层表头，标题在 A1，标题用 SHEET_TITLE 字体"
df.attrs["_excel_layout"] = {
    "header_rows": 1,                        # 表头占几行（取代之前写死的 2）
    "title": "Listing 16.2.1 Demographics",  # 可选，渲染时合并 A1:F1 显示
    "back_link": True,                       # 可选，渲染时 A1 = HYPERLINK
    "freeze_after_header": True,             # 可选
    "auto_filter": True,
    "column_widths": {...},                  # 可选覆盖默认算法
}
# 不传 _excel_layout 时走默认：纯样式（输出标准），不写死排版
```

**判断标准**：
- 颜色 / 字体 / 边框 → **写死在常量里**，AI 改不了（防止视觉撕裂）
- 排版（标题位置 / 合并 / 冻结 / 筛选）→ **AI 用 `_excel_layout` 自决**
- 业务定义（列结构 / 标签 / 数据语义）→ **AI 通过 DataFrame.columns / attrs["labels"] 控制**

---

## 4. Spec 辅助文件处理（结构字段全送，值禁出域）

### 4.1 多场景表结构识别（必须全支持）

多场景 listing 会遇到各种 Excel 表结构形态，**结构识别全送 AI，值不出域**：

| 表结构形态 | 识别策略 | 送给 AI 的字段 |
|---|---|---|
| **横向表**（一行 = 一条记录，列展开） | 读第一行作列名 | `columns / rowCount / dtypes` |
| **纵向表**（一列 = 一字段，行堆叠） | 读第一列作字段名 | `rowOrientation / columnCount` |
| **多层表头**（合并单元格跨多行） | 递归读前 N 行作多级列名 | `headerRows / headerLevels / mergedCells` |
| **不规则表**（稀疏合并、跨列跨行） | 读所有合并单元格范围 | `mergedCells / sparseCells / maxRow/maxCol` |
| **跨 sheet 模板** | 读每个 sheet 的结构指纹 | `sheets[*].structure` |

### 4.2 当前实现（问题：直接读全文）

`read_spec_files` 当前直接读 `.txt/.md` 的 `path.read_text()[:50_000]`、`.xlsx` 整张 sheet 内容并解析出 mappings（datasetName / sourceColumn / label）。问题是 `.xlsx` 整张表可能包含数据行（不只是 ALS 结构），被原样灌进 documents[*].content → AI 看到。

### 4.3 最终方案（结构送，值留）

```python
def read_spec_files(doc_dir: Path) -> tuple[list[dict], list[dict]]:
    """读取 spec 辅助文件：返回结构字段，不返回原始值。"""
    documents, failures = [], []
    for path in sorted(doc_dir.rglob("*")):
        if not path.is_file(): continue
        try:
            suffix = path.suffix.lower()
            if suffix in {".xlsx", ".xls", ".xlsm"}:
                # 用 openpyxl 直接读结构（程序可读，不给 AI 看值）
                wb = load_workbook(path, data_only=False, read_only=False)
                structure = _xlsx_structure(path)
                # structure 字段全部可送：columns / headerLevels / mergedCells / ...
                documents.append({
                    "path": path.relative_to(doc_dir).as_posix(),
                    "type": "als" if _is_als_structure(wb) else "xlsx",
                    "structure": structure,            # 全结构送 AI
                    "mappings": _extract_als_mappings(wb),  # ALS 三元组送 AI（语义，不含值）
                    "datasets": _extract_als_datasets(wb),
                    # ⚠️ 不返回原始 content——sheets[*].values / sheets[*].data 一律不送
                })
            elif suffix in {".txt", ".md"}:
                full = path.read_text(encoding="utf-8", errors="ignore")
                documents.append({
                    "path": path.relative_to(doc_dir).as_posix(),
                    "type": "text",
                    "size": len(full),
                    "lineCount": full.count("\n") + 1,
                    "preview": full[:200],          # 200 字预览——结构级，不算值出域
                    # 不返回完整 content——AI 想读全文调 inspect_doc(path)
                })
        except Exception as exc:
            failures.append(_failure(path, doc_dir, "read-spec", exc))
    return documents, failures


def _xlsx_structure(path: Path) -> dict:
    """读 Excel 结构指纹：横纵 / 多表头 / 合并 / 不规则——全识别。"""
    wb = load_workbook(path, data_only=False, read_only=False)
    sheets = []
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        # 1. 合并单元格范围（全结构）
        merged_ranges = [str(r) for r in ws.merged_cells.ranges]
        # 2. 表头行数：探测第 1 个非空行往下数到第一个纯值行的距离
        header_rows = _detect_header_rows(ws)
        # 3. 列结构：前 header_rows 行的合并树
        column_tree = _build_column_tree(ws, header_rows)
        # 4. 数值范围（max_row / max_column）
        max_row, max_col = ws.max_row, ws.max_column
        # 5. 方向判断：max_row > max_col → 纵向；反之横向
        orientation = "vertical" if max_row > max_col else "horizontal"
        sheets.append({
            "name": sheet_name,
            "orientation": orientation,
            "headerRows": header_rows,
            "headerLevels": _count_levels(column_tree),
            "maxRow": max_row,
            "maxColumn": max_col,
            "mergedCells": merged_ranges,
            "columnTree": column_tree,        # 多表头层级结构
            "isIrregular": len(merged_ranges) > 0 or _has_sparse_cells(ws),
            # ⚠️ 不返回：sheets[*].values / sheets[*].data
        })
    wb.close()
    return {"sheets": sheets, "sheetCount": len(sheets), "orientation": "multi-sheet"}
```

### 4.4 sandbox 单向玻璃原语

AI 在 sandbox 内需要"看结构 + 读值"的能力来推理，但读到的值不能回到模型视野：

```python
# sandbox 内 AI 可用原语
inspect_doc(path, max_chars=4000)        # 读文本全文：结果进 stdout（被拦截）
inspect_xlsx_structure(path)              # 读 xlsx 全结构（程序读，不出值）：结果可送 AI
inspect_xlsx_sheet(path, sheet, rows=0)   # 读 sheet 的"前 N 行结构"：N=0 时只读结构
                                          # rows>0 时返回值进 stdout（被拦截）
```

**Worker 端拦截**：

```python
def _capture_call(name, fn):
    """包装 sandbox 原语：结果根据是否含值决定如何处理"""
    result = fn()
    if name in {"inspect_doc", "inspect_xlsx_sheet"} and "rows" in name and ...:
        # 含值的调用：结果进 capture_out（被 _sanitize_receipt 拦截）
        return result  # 仅返回字符串长度 / 截断摘要
    return result  # 结构调用：直接返回
```

### 4.5 ALS 提取（仅语义三元组）

```python
def _extract_als_mappings(wb) -> list[dict]:
    """从 ALS 结构 Excel 提取 datasetName/sourceColumn/label——无值。"""
    ws = wb.active  # ALS 单 sheet 结构
    mappings = []
    for row in ws.iter_rows(min_row=2, values_only=True):  # 跳过表头
        dataset, variable, label = row[0], row[1], row[2] if len(row) > 2 else None
        if dataset and variable:
            mappings.append({
                "datasetName": str(dataset).strip().upper(),
                "sourceColumn": str(variable).strip(),
                "label": str(label).strip() if label else "",
                # 不含任何原始值
            })
    return mappings
```

### 4.6 关键判断

- **结构字段 vs 值字段**：列名（结构）允许出；列内容（值）禁出。多场景表结构识别（横/纵/多层/不规则）属于结构识别——AI 必须看到才能正确生成 outputs。
- **程序行为不受限**：Worker 可以读 Excel 任何 sheet、解析任何层级、重组数据、写出新文件。**程序对 Excel 的操作完全放开**，只在「最后回执字段」上做拦截。
- **多场景 listing 的列结构推断**：AI 在 sandbox 内看到 structure 后，自己推断列关系、决定输出表头层级、合并策略——不写死。

---

## 5. 数据红线的全链路拦截

### 5.1 三层防线

```
第 1 层：system prompt（行为引导，弱）
   "严禁在代码中 print(df.head()) / df.values / df.to_dict()"
   ↓

第 2 层：sandbox 资源限制（结构限制，中）
   safe_builtins 白名单：屏蔽 __import__ / open / Exception
   stdout/stderr 截断 16K
   ↓

第 3 层：Worker 回执脱敏（硬拦截，强）
   强制扫描回执 JSON，剥离任何可能含原始数据的字段
```

### 5.1.1 红线精确边界（**关键**）

| 字段类别 | 是否可送 AI | 例子 |
|---|---|---|
| **结构字段**（表结构 / 文件结构 / 元数据） | ✅ 全送 | 列名 / 表头行数 / 合并单元格 / 方向 / dtype / rowCount / uniqueCount / 文件路径 |
| **数据字段**（具体值） | ❌ 全拦截 | 单元格内容 / 受试者 ID / 日期 / 姓名 / 编号 |
| **统计字段**（聚合后的去标识数字） | ✅ 允许 | min / max / nullCount / uniqueCount（去重后个数，不是值） |

**判断口诀**：**结构识别全送，值禁出域；程序操作不受限，限制只在回执字段**。

### 5.2 第 3 层具体实现（必须落地）

```python
# worker.py 新增
import re

# 受保护的"值字段"——出现即丢弃
_VALUE_FIELD_NAMES = {"sample", "preview", "head", "values", "data",
                      "content", "rows", "cells", "items", "records"}

# 命中即视为数据泄漏
_DATA_PATTERNS = [
    re.compile(r"^\s*USUBJID\b", re.IGNORECASE | re.MULTILINE),
    re.compile(r"\b\d{4}-\d{2}-\d{2}\b"),                              # 日期
    re.compile(r"[一-鿿]{2,}.{0,40}(患者|受试者|试验|方案)"),   # 中文 PHI
]

def _scrub(value):
    """递归扫描回执 dict/list/str：
       - 出现受保护的"值字段"名 → 直接删
       - 字符串命中数据模式 → 替换 [REDACTED]
       - 结构字段（列名 / 行数 / 元数据）一律放行
    """
    if isinstance(value, dict):
        return {k: _scrub(v) for k, v in value.items() if k not in _VALUE_FIELD_NAMES}
        # ⚠️ 关键：sample / preview / head / values / data / content / rows / cells / items / records 一律丢弃
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    if isinstance(value, str):
        for pat in _DATA_PATTERNS:
            if pat.search(value):
                return "[REDACTED-DATA-LEAK]"
        return value
    return value

def _sanitize_receipt(receipt: dict) -> dict:
    """最终回执脱敏：剥字段 + 模式扫描 + 长度硬截断"""
    scrubbed = _scrub(receipt)
    # stdout/stderr 必须截断，且模式扫描（AI 在 sandbox 里 print(df.head()) 会经此处拦截）
    if "stdout" in scrubbed:
        scrubbed["stdout"] = _scrub_text(scrubbed["stdout"], max_chars=2000)
    if "stderr" in scrubbed:
        scrubbed["stderr"] = _scrub_text(scrubbed["stderr"], max_chars=2000)
    return scrubbed

# 在 operation_run_code / operation_inspect / operation_publish 返回前
return _sanitize_receipt(raw_response)
```

### 5.3 关键细节

- **字段级丢弃优于内容扫描**：与其尝试识别"数据"长什么样，不如直接禁掉 `sample / preview / head / values / data / content / rows / cells / items / records` 这十个字段名。一旦代码里写 `outputs["sample"] = df.head().to_dict()`，回执就直接丢
- **stdout/stderr 是最大风险口**：当前 system prompt 说"禁 print(df)"，但即使 AI 守规矩，`df.merge()` / `df.groupby()` 也可能 print 中间值。必须截断到 2000 字 + 模式扫描
- **statistics 中禁列**：明确 `metadata[*].columns[*]` 不能有 `sampleValues / topValues / preview` 字段；写代码时按命名约束
- **结构字段放行**：列名（`columns[*].name`）、表头行数（`structure.headerRows`）、合并范围（`structure.mergedCells`）、方向（`orientation`）——这些属于表结构识别，全送 AI
- **程序操作不受限**：Worker 可以用 openpyxl 读 xlsx 的所有结构、做所有合并、重组、写出——只**对回执字段**做拦截

### 5.4 多场景 listing 的结构识别全支持

横/纵/多层/不规则表结构都是结构识别场景，全送 AI：

```python
# inspect 返回的 structure 字段（AI 必须看到的）
{
  "path": "spec/RT01.xlsx",
  "type": "als",
  "structure": {
    "sheets": [{
      "name": "Sheet1",
      "orientation": "horizontal",     # 横向/纵向
      "headerRows": 3,                 # 多表头占 3 行
      "headerLevels": 2,               # 两层表头（合并）
      "maxRow": 1500,
      "maxColumn": 24,
      "mergedCells": ["A1:C1", "D1:F1", ...],  # 多表头合并
      "columnTree": {                   # 多表头层级结构
        "Subject Information": ["USUBJID", "AGE", "SEX"],
        "Adverse Events": ["AETERM", "AESEV", "AESER"]
      },
      "isIrregular": True              # 不规则表（有合并/稀疏）
    }]
  }
}
```

**程序操作不受限**：Worker 用 openpyxl 读这些结构、做合并拆分、按层级重组——但**值（cell.value）不进回执**。

---

## 6. 信息供给：让 AI 推理有 context

### 6.1 inspect 必须给够（虽然不能给数据行）

```python
{
  "inspection": {
    "datasets": [
      {"name": "DM",
       "path": "raw/dm.sas7bdat",
       "columns": ["USUBJID", "AGE", "SEX", "RACE", "ARM"],
       "rowCount": 1234,
       "dtypes": {"USUBJID": "object", "AGE": "float64", "SEX": "object"},
       "nullCount": {"AGE": 0, "RACE": 12},
       "uniqueCount": {"SEX": 2, "ARM": 4}       # 元数据级：去标识后的去重数
       # 不含：sample / topValues / preview
      }
    ],
    "documents": [
      {"path": "spec/RT01.xlsx", "type": "als",
       "datasets": ["DM", "AE"], "mappingCount": 152}
    ],
    "previousVersion": {                          # 仅元数据
      "exists": True,
      "path": ".clinical-listing/output/medical/MEDICAL_LISTINGS.xlsx",
      "sheetCount": 51,
      "rowCount": 12000
      # 不含：sheet 数据预览
    }
  }
}
```

`uniqueCount` 是关键——AI 知道 `SEX` 有 2 个值（写代码时不会去构造 5 种 sex），但**不知道这 2 个值是什么**。这正是"信息供给够用 + 数据不出域"的边界。

### 6.2 run_code 回执增加「结构指纹」

```python
{
  "receipt": {
    "outputs": {
      "LISTING_DM_01": {
        "rowCount": 1234,
        "columns": [
          {"name": "USUBJID", "dtype": "object", "nullCount": 0,
           "uniqueCount": 1234},                  # 全唯一 → 几乎肯定是 ID
          {"name": "AGE", "dtype": "float64", "nullCount": 0,
           "min": 18, "max": 89, "uniqueCount": 72},  # 数值列给 min/max
          {"name": "SEX", "dtype": "object", "nullCount": 0,
           "uniqueCount": 2}
        ]
      }
    }
  }
}
```

- 数值列：min / max / uniqueCount（不是 values）
- 文本列：uniqueCount（不是 sampleValues）
- ID 列：uniqueCount == rowCount（AI 自己推断是 ID）

### 6.3 publish 后给文件指纹（不打开也能验）

```python
{
  "receipt": {
    "outputFile": "...",
    "statistics": {
      "totalRows": 12345,
      "totalSheets": 52,
      "sheetNames": ["Content", "LISTING_DM_01", ...],
      "perSheet": {
        "LISTING_DM_01": {"rowCount": 1234, "columnCount": 8}
        # 不含：任何数据预览
      }
    }
  }
}
```

---

## 7. 架构改动清单（按优先级）

### P0（数据红线，最关键）

| # | 改动 | 文件 |
|---|---|---|
| 1 | `_sanitize_receipt` 全链路脱敏：模式扫描 + 字段级丢弃（值字段名 10 个） | `worker.py` 新增 |
| 2 | 字段级丢弃 `sample/preview/head/values/data/content/rows/cells/items/records` | `worker.py` |
| 3 | `read_spec_files` 不返回原文 + 读 Excel 全结构（横/纵/多层/不规则） | `worker.py` |
| 4 | sandbox 暴露 `inspect_doc(path)` / `inspect_xlsx_structure(path)` / `inspect_xlsx_sheet(path, sheet, rows)` 原语 | `worker.py` |
| 5 | system prompt 增补"sandbox 是单向玻璃 + 结构字段全送 + 值禁出域"说明 | `src/index.ts` |
| 6 | `_VALUE_FIELD_NAMES` 黑名单：含 10 个值字段名，回执构造时强制丢弃 | `worker.py` |
| 7 | stdout/stderr 截断 2000 字 + 模式扫描正则 | `worker.py` |

### P1（去掉写死的业务定义）

| # | 改动 | 文件 |
|---|---|---|
| 6 | 删 `_prepare_outputs` / `COMPARISON_COLUMNS` / `COMPARISON_LABELS` / `STANDARD_SCENARIOS` | `multi_sheet_writer.py` |
| 7 | 删 `unique_key_columns` 死参数 + 返回字段里的 `*StructureApplied` / `*StructureFlexible` | `multi_sheet_writer.py` |
| 8 | 删 `_build_listing` 的固定 Row 1 / 固定 HYPERLINK / 固定合并 A1:F1 | `multi_sheet_writer.py` |
| 9 | 引入 `df.attrs["_excel_layout"]` 让 AI 控制排版（保留样式常量） | `multi_sheet_writer.py` |
| 10 | 删 `load_previous_version` 硬编码 `min_row=3`，改为暴露上版路径让 AI 决定 | `multi_sheet_writer.py` |
| 11 | `_align_previous_columns` 改为可空操作（AI 在 sandbox 里自己读上版） | `multi_sheet_writer.py` |
| 12 | `create_multi_sheet_excel` 删 `scenario` 参数（Cover/Content 走 attr 自决） | `multi_sheet_writer.py` |
| 13 | `operation_publish` 删 `scenario` 必传，改为从 `_last_outputs` 的 `_excel_layout` 自取 | `worker.py` |
| 14 | `operation_inspect` 删 `inferredScenario`（AI 自己从 spec 推） | `worker.py` |

### P2（信息供给）

| # | 改动 | 文件 |
|---|---|---|
| 15 | inspect 返回 `uniqueCount` / `min / max` | `worker.py` |
| 16 | run_code metadata 增 `uniqueCount` / `min / max` | `worker.py` |
| 17 | inspect 返回 `previousVersion` 元数据 | `worker.py` |
| 18 | publish 返回 `perSheet` 指纹 | `worker.py` |
| 19 | sandbox 暴露 `list_files(project)` 原语，AI 自己筛后缀 | `worker.py` |

### P3（清理）

| # | 改动 | 文件 |
|---|---|---|
| 20 | 删 `archive_passwords.py`（AI 在 sandbox 里直接写 zipfile） | `worker.py` + `archive_passwords.py` 删 |
| 21 | 删 worker.py 后缀白名单 `_plain_sources` | `worker.py` |
| 22 | 文件末尾空行清理 | 全部 |

---

## 8. 测试覆盖建议

### 8.1 红线测试（必须全绿）

```python
# --- 值出域拦截 ---
def test_sas_data_never_leaks_to_ai():
    # AI 在 sandbox 写 print(df.head(50))，回执 stdout 必须 [REDACTED]

def test_field_level_drop_blocks_value_fields():
    # AI 写 outputs["sample"] = df.head().to_dict()，回执剥字段
    # AI 写 outputs["content"] = "...", 回执剥字段
    # AI 写 outputs["preview"] = [...], 回执剥字段

def test_structure_fields_pass_through():
    # ⚠️ 反向测试：结构字段必须能送 AI
    assert "columns" in receipt["datasets"][0]           # 列名允许
    assert "rowCount" in receipt["datasets"][0]         # 行数允许
    assert "structure" in receipt["documents"][0]       # 表结构允许
    assert "headerRows" in receipt["structure"]["sheets"][0]
    assert "mergedCells" in receipt["structure"]["sheets"][0]

def test_horizontal_vertical_multilevel_irregular_all_supported():
    # ⚠️ 多场景结构识别测试
    # 横向表：orientation="horizontal"
    # 纵向表：orientation="vertical"
    # 多层表头：headerLevels=3, mergedCells 跨行
    # 不规则表：isIrregular=True, sparseCells 不空
    # 全部结构字段必须送 AI

def test_value_in_stdout_gets_scrubbed():
    # AI print(df.head()) → stdout 含 "USUBJID-001-2024-01-15" → 截断 + 模式扫描 → [REDACTED]

def test_inspect_doc_result_not_in_receipt():
    # AI 调 inspect_doc("spec/RT01.docx")，回执不含 content 字段

def test_sandbox_blocks_open():
    # AI 写 open("/etc/passwd")，抛 NameError

def test_sandbox_blocks_import():
    # AI 写 import os，抛 NameError (__import__ not found)
```

### 8.2 业务开放性测试（必须全绿）

```python
def test_no_scenario_branch_in_writer():
    # create_multi_sheet_excel 不再判 scenario

def test_ai_can_control_layout_via_attrs():
    # df.attrs["_excel_layout"]["header_rows"] = 3，sheet 渲染 3 行表头

def test_ai_can_define_own_columns():
    # 任意 outputs["FOO"] = pd.DataFrame(...) 不需要强制 6 列

def test_ai_can_read_previous_via_sandbox():
    # 在 run_code 里 pd.read_excel(previous_path) 能跑通

def test_worker_can_operate_excel_freely():
    # ⚠️ 程序行为不受限测试
    # Worker 内部 openpyxl.load_workbook() 不被 sandbox 限制
    # Worker 内部 ws.merge_cells() / ws.cell() 都正常
    # sandbox 内只有 AI 代码受限制

def test_multiple_sheet_structures_recognized():
    # 横向 + 纵向 + 多层表头 + 不规则 4 种表结构混在一个 spec 文件
    # structure.sheets[*] 必须每个 sheet 都返回 orientation / headerRows / mergedCells
```

---

## 9. 总结

最终方案的核心张力是 **「智能最大化 vs 数据零泄漏」**——这两者表面冲突，实际可以共存：

- **智能最大化**：砍掉所有写死业务定义（列、标签、场景、排版）→ 改用 `df.attrs["_excel_layout"]`、inspect 原语、sandbox 内 `list_files / inspect_doc` 暴露，让 AI 在沙箱内自由推理
- **数据零泄漏**：三层防线（prompt 引导 / sandbox 结构 / 回执脱敏）确保 sas 原始行 + spec 原文 + data 预览**永远不回到 AI 视野**

关键设计 **「单向玻璃 sandbox」**：AI 在沙箱里能读 inspect_doc / 上版 Excel / 当前 datasets——但读到的内容只用于生成 `outputs`，**所有读取操作的"中间产物"都被 Worker 拦截在 sandbox 内**，回执里只回结构指纹（rowCount / uniqueCount / min / max / 列名）。

这样既满足红线，又让 AI 有充分 context 做推理——**程序不替 AI 决定业务，但严格守护数据出域**。
