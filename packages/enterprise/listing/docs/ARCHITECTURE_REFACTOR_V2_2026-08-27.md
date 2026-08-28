# Listing 插件架构重构方案 v2（按用户反馈精确化）

> 时间：2026-08-27
> 反馈来源：用户 6 条精确化意见
> 范围：`packages/enterprise/listing` 全栈
> 核心：**按场景判定数据红线 + 全局开关可关闭 + 模板/样式保留为标准输出**

---

## 0. 6 条反馈落地表

| # | 用户反馈 | 我之前理解 | 正确理解 |
|---|---|---|---|
| 1 | `read_spec_files` 直接读 `.txt[:50_000]` + `.xlsx` 整表是**正确**的，因为这是需求字段结构识别——无法识别怎么处理逻辑？ | "返回原文是红线漏洞"（错） | **全量读是对的**，目的是让 AI 看到完整表结构；值出域靠场景判定 + 拦截层把关 |
| 2 | systemPrompt 与系统输出**模板规范**可以引导 AI 这样做（标准输出范例），不写死代码 | "systemPrompt 罗列 sheet 结构是写死"（错） | systemPrompt 的模板引导是**输出标准示范**，应当保留；写死代码 vs 写死模板是两件事 |
| 3 | 密码推导**必须的，不能删** | "密码推导是 AI 推理活，删"（错） | `archive_passwords.py` **必须保留**——这是工程现实，密码不在 doc/ AI 无法推断，必须程序做 |
| 4 | contents 这股**固定模板不能动**，样式、表头怎么输出也是标准 | "场景分支是写死，删 STANDARD_SCENARIOS"（部分错） | 固定模板（Content Sheet / Cover Page）+ 标准样式（颜色/字体/行高/列宽）是**输出标准**，必须保留；只有"列结构业务定义"才不该写死 |
| 5 | 数据红线**不应该固定写死**，应该**按场景判定**——程序读 sas/spec 时是知道场景的，**只要这两个场景的 data 动作产生的数据不发送 AI 就掐断源头** | "字段黑名单 10 个 + 模式扫描"（错） | 红线**按"读数据"的源头动作判定**：sas 读取动作产生的回执 + spec 辅助文件读取动作产生的回执——这两个场景源头全拦截，其他源头（sandbox 内 AI 操作、AI 自己产出的 outputs）不拦截 |
| 6 | 数据安全**拦截开关默认开启，关闭后全部取消**（包括数据出域） | "sanitize_receipt 出口硬拦截不可关闭"（错） | 拦截是**开关可控的**——默认 ON，但用户/宿主可关闭后完全放行 |

---

## 1. 核心范式重写：场景化数据红线

### 1.1 三个核心动作源头

```python
# worker.py 里能产生数据的"动作源头"只有三种：

DATA_SOURCE_SAS    = "sas-dataset"    # pd.read_sas / pd.read_xpt
DATA_SOURCE_SPEC   = "spec-document"  # doc/*.txt / doc/*.xlsx ALS
DATA_SOURCE_OUTPUT = "model-output"   # sandbox 内 AI 定义的 outputs
```

### 1.2 拦截策略（按源头判定，不再固定黑名单）

| 源头 | 数据形态 | 拦截策略 | 是否进回执 |
|---|---|---|---|
| `sas-dataset` | DataFrame 行内容 | **全拦截**——只返回元数据（列名/行数/dtype/nullCount/uniqueCount） | ❌ 不进回执 |
| `spec-document` | .txt / .xlsx ALS 内容 | **结构送 + 值拦截**——列结构 / ALS 三元组送 AI；行内容值拦截 | ⚠️ 结构进，值不进 |
| `model-output` | AI 产出的 outputs DataFrame | **全放行**——AI 自己写的东西回执就是它自己 | ✅ 全进回执 |

**关键**：拦截的判定依据是"**数据从哪里来**"，不是"**字段叫什么名字**"。黑名单字段名是兜底，主拦截靠源头。

### 1.3 拦截开关

```python
# 请求级开关（默认 True）
@dataclass
class ListingRequest:
    project: str
    scenario: Optional[str]
    credential_ref: Optional[str]
    code: Optional[str]
    # 数据红线拦截开关——默认开启，关闭后全部取消
    redact_disabled: bool = False
```

- 默认 `redact_disabled = False` → 拦截生效
- 设为 `True` → 全部取消（包括数据出域拦截）
- 工具参数 `redactDisabled: boolean` 由宿主/用户在调用时决定

### 1.4 三个工具的红线行为

| 工具 | 源头 | 默认行为 | redact_disabled=True |
|---|---|---|---|
| `listing_inspect` | sas + spec | sas 元数据 + spec 结构 | 全部内容送出（含 sas 行 + spec 全文） |
| `listing_run_code` | sandbox 内 AI 操作 | sandbox 阻断危险 builtins，stdout 自动脱敏 | sandbox 仍阻断（Zip Slip / __import__ 是路径穿越不是数据出域） |
| `listing_publish` | model-output | 输出结构指纹 | 输出结构指纹（publish 产物本身就是 Excel，AI 不会再看） |

---

## 2. 架构图（按反馈重画）

```
┌─ MCP Server (TypeScript) ──────────────────────────────────────┐
│ src/index.ts                                                  │
│   - systemPrompt: 标准模板引导（Output Spec 范例）           │
│   - 三个 tool: inspect / run_code / publish                    │
│   - redactDisabled 参数透传给 Worker                          │
│ src/worker.ts (不变)                                          │
└────────────────────┬──────────────────────────────────────────┘
                     │ stdin/stdout NDJSON（含 redactDisabled）
┌────────────────────▼──────────────────────────────────────────┐
│ Python 持久 Worker                                              │
│                                                                 │
│  ┌─ 数据源头标注层 ────────────────────────┐                   │
│  │ source_registry.py                       │                   │
│  │   @annotate_source("sas-dataset")         │                   │
│  │   @annotate_source("spec-document")       │                   │
│  │   @annotate_source("model-output")        │                   │
│  │   SourceTag(serde) per DataFrame         │                   │
│  └──────────────────────────────────────────┘                   │
│                                                                 │
│  ┌─ 全量读取层（保留原 read_spec_files 行为）─┐                  │
│  │ discovery.py                                │                │
│  │   list_files(project)                      │ ← AI 可调       │
│  │   scan_excel_structures(project)           │ ← AI 可调       │
│  │   load_datasets(project)                   │ ← AI 可调       │
│  │     → 返回 dict[str, DataFrame]            │                  │
│  │       每张 df.attrs["_source"] = "sas-..." │                  │
│  │   read_spec_files(project / "doc")         │ ← AI 可调       │
│  │     → 返回 list[SpecDocument]              │                  │
│  │       每份 doc.source = "spec-document"    │                  │
│  │   extract_with_password(archive, target)   │ ← AI 可调       │
│  └──────────────────────────────────────────┘                   │
│                                                                 │
│  ┌─ Sandbox 层（保留 safe_builtins）─────────┐                  │
│  │ sandbox.py                                  │                 │
│  │   safe_builtins 白名单                      │                 │
│  │   preloaded primitives (pd/np/math/...)    │                 │
│  │   stdout/stderr capture                    │                 │
│  └──────────────────────────────────────────┘                   │
│                                                                 │
│  ┌─ 场景化拦截层（按源头，不按字段名）───────┐                  │
│  │ redact.py                                   │                 │
│  │   SOURCE_POLICY = {                          │                 │
│  │     "sas-dataset":    "metadata_only",       │                 │
│  │     "spec-document":  "structure_only",      │                 │
│  │     "model-output":   "passthrough",         │                 │
│  │   }                                          │                 │
│  │                                              │                 │
│  │   sanitize(receipt, request)                 │                 │
│  │     - 按源头判定：metadata_only / structure  │                 │
│  │                 / passthrough                │                 │
│  │     - redact_disabled=True 时全部 passthrough│                 │
│  │     - 兜底：模式扫描（PHI/日期/ID）          │                 │
│  └──────────────────────────────────────────┘                   │
│                                                                 │
│  ┌─ Excel 写出层（保留模板 + 标准样式，开放 layout）──┐           │
│  │ excel/                                         │                │
│  │   style_atoms.py   : 样式常量（必须保留）       │                │
│  │   templates.py     : Content Sheet 模板        │                │
│  │                       Report Cover 模板（保留） │                │
│  │                       ALS 审核列（这是输出标准）│                │
│  │   layout.py        : 读 df.attrs["_layout"]   │                │
│  │   build_workbook.py: 单一入口                  │                │
│  │     - 内容模板（Content/Cover）由 templates 控 │                │
│  │     - 业务表头由 df.attrs["_layout"] 控制     │                │
│  └──────────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 关键决策（按 6 条反馈精确化）

### 3.1 全量读取必须保留（反馈 1）

**`read_spec_files` 全量读 `.txt[:50_000]` + `.xlsx` 整表内容是正确的**。这是为了：
- 让 AI 看到完整的表结构（横/纵/多层/不规则）
- 让 AI 识别字段关系（哪一列是 Dataset Name、Variable Name、Label）
- 让 AI 推断 listing 输出结构

**值出域**不在读取层解决，**在拦截层**：
- 全量读到的内容标记 `source = "spec-document"`
- 拦截层按源头策略 `structure_only` 剥值，保留结构

### 3.2 systemPrompt 模板引导必须保留（反馈 2）

**标准输出范例应当写在 systemPrompt**（作为引导），**不要写死代码**：
- "推荐按 RT01 样式生成 Content Sheet：标题'Comparison Summary'、Row 2 表头 [...、...]"
- "推荐按 DM Status Report 样式生成 Cover Page"
- "推荐 ALS 审核列：Flag1, __cmp_FLAG__, ..."

代码侧**只暴露样式常量**（颜色/字体/行高），**不强制某种 sheet 结构**。AI 可以遵循范例，也可以自由发挥——但默认会跟随范例。

### 3.3 密码推导必须保留（反馈 3）

**`archive_passwords.py` 不能删**：
- 工程现实：密码不在 `doc/` 下，AI 无法在 sandbox 内推断密码候选
- 全树 `rglob("*.txt")` 是工程必要——doc/ 下的密码提示文件没固定位置
- ZIP 密码爆破是程序责任，不是 AI 推理责任

**保留 `password_candidates` 函数**，但**明确不返回密码值给 AI**——AI 只能看到"已成功解压"或"密码解析失败"。

### 3.4 固定模板不能动（反馈 4）

**Content Sheet / Cover Page 是输出标准**——必须保留为模板：
- `_build_content()`：Comparison Summary 模板（保留）
- `_build_report_cover()`：DM Status Report 模板（保留）
- `_build_report_sheet()`：DM 报告业务页（保留）
- ALS 审核列（`Flag1, __cmp_FLAG__, ...`）：是输出标准，保留

**但**：
- 模板**只对"默认场景"生效**
- AI 通过 `df.attrs["_skip_default_template"] = True` 可跳过模板
- AI 通过 `df.attrs["_layout"]` 可改表头怎么输出（横/纵/多层）

### 3.5 数据红线按场景判定（反馈 5）

**核心思想**：拦截的判定依据是**数据从哪里来**（源头），不是字段名。

```python
# 按源头判定（不再按字段名）
SOURCE_POLICY = {
    "sas-dataset":   "metadata_only",     # 元数据（列名/行数/dtype/nullCount/uniqueCount）
    "spec-document": "structure_only",    # 结构（ALS 三元组）+ 文件元信息
    "model-output":  "passthrough",       # 全放行——AI 自己产的东西就是它自己的
}
```

**掐断源头**：
- sas 读取动作 → 返回的 dict 中只保留 `metadata_only` 形态
- spec 读取动作 → 返回的 dict 中只保留 `structure_only` 形态
- 其他动作（sandbox 内 AI 操作、AI 产出）→ passthrough

**没有"黑名单字段名 10 个"那套**——按源头一刀切，**比按字段名判定更准确**：黑名单易漏（AI 改个字段名就绕过），按源头无法绕过。

### 3.6 拦截开关默认开启可关闭（反馈 6）

```python
# MCP tool 参数
parameters: {
  project: { type: 'string' },
  scenario: { type: 'string', enum: SCENARIOS },
  code: { type: 'string' },
  redactDisabled: {                              # ← 新增
    type: 'boolean',
    default: false,                              # 默认关闭拦截 = 默认开启安全
    description: '数据红线拦截开关（默认 false）；关闭后所有拦截包括数据出域全部取消',
  },
}
```

```python
# worker.py 主循环
def dispatch(req):
    op = req.get("operation")
    redact_disabled = req.get("redactDisabled", False)
    if op == "listing_inspect": response = op_inspect(req)
    elif op == "listing_run_code": response = op_run_code(req)
    elif op == "listing_publish": response = op_publish(req)
    else: response = {"ok": False, "code": "UNKNOWN_OPERATION"}
    
    # ✅ 拦截默认开启；redactDisabled=True 时全部取消
    if not redact_disabled:
        response = sanitize(response, req)
    
    return response
```

**开关语义**：
- `redactDisabled = False`（默认）：拦截生效
- `redactDisabled = True`：sanitize 完全不调用，所有数据原样回执
- **Sandbox 仍阻断** `__import__/open`——因为这是**路径穿越/执行**类安全，不是数据出域类安全；不在 redact 开关管辖范围内

---

## 4. 代码契约

### 4.1 源头标注（source_registry.py）

```python
from enum import Enum

class DataSource(str, Enum):
    SAS_DATASET = "sas-dataset"        # pd.read_sas / pd.read_xpt
    SPEC_DOCUMENT = "spec-document"    # doc/*.txt / doc/*.xlsx
    MODEL_OUTPUT = "model-output"      # sandbox 内 AI 产出
    DERIVED = "derived"                # AI 在 sandbox 内对上述数据的衍生


def tag_dataframe(frame: pd.DataFrame, source: DataSource) -> pd.DataFrame:
    """每张加载到 sandbox 的 df 标记源头——这是红线的判定锚点。"""
    frame.attrs["_source"] = source.value
    return frame


# 在 load_datasets 里
def load_datasets(project: Path) -> dict[str, pd.DataFrame]:
    datasets = {}
    for path in scan_data_sources(project):
        df = pd.read_sas(path) if path.suffix in {".sas7bdat", ".xpt"} else pd.read_csv(path)
        datasets[path.stem.upper()] = tag_dataframe(df, DataSource.SAS_DATASET)
    return datasets


# 在 sandbox 内 AI 衍生时
def derived_from_sas(frame: pd.DataFrame) -> pd.DataFrame:
    """AI 在 sandbox 内 merge / groupby / filter 出的 df——继承源头。"""
    derived = frame.copy()
    derived.attrs["_source"] = frame.attrs.get("_source", DataSource.DERIVED.value)
    return derived
```

### 4.2 场景化拦截（redact.py）

```python
SOURCE_POLICY: dict[str, str] = {
    "sas-dataset":   "metadata_only",
    "spec-document": "structure_only",
    "model-output":  "passthrough",
    "derived":       "passthrough",  # AI 产出的归 AI 自己
}

# 兜底正则（PHI/ID/日期模式）——只对 model-output 之外的兜底
PHI_PATTERNS = [
    re.compile(r"^\s*USUBJID\b", re.IGNORECASE | re.MULTILINE),
    re.compile(r"\b\d{4}-\d{2}-\d{2}\b"),
    re.compile(r"[一-鿿]{2,}.{0,40}(患者|受试者|试验|方案)"),
    re.compile(r"\b[A-Z]{2,}-\d{3,}-\d{3,}\b"),
]


def _to_metadata_only(frame: pd.DataFrame) -> dict:
    """sas 数据集：只留元数据。"""
    return {
        "name": _safe_name(frame),
        "columns": [str(c) for c in frame.columns],
        "rowCount": len(frame),
        "dtypes": {c: str(frame[c].dtype) for c in frame.columns},
        "nullCount": {c: int(frame[c].isna().sum()) for c in frame.columns},
        "uniqueCount": {c: int(frame[c].nunique()) for c in frame.columns},
        "_source": frame.attrs.get("_source"),
    }


def _to_structure_only(doc: dict) -> dict:
    """spec 辅助文件：留结构 + ALS 三元组，不留值。"""
    return {
        "path": doc.get("path"),
        "type": doc.get("type"),
        "size": doc.get("size"),
        "lineCount": doc.get("lineCount"),
        "preview": doc.get("preview", "")[:200],   # 200 字预览
        "structure": doc.get("structure"),          # Excel 表结构全识别
        "mappings": doc.get("mappings"),            # ALS 三元组
        "datasets": doc.get("datasets"),
        "_source": doc.get("_source"),
        # ⚠️ 不返回 .content / .rows / .cells / .values
    }


def sanitize_receipt(receipt: dict, request: dict) -> dict:
    """统一拦截入口。
    
    按源头判定（_source 字段或顶层 source）：
      - sas-dataset → metadata_only
      - spec-document → structure_only
      - model-output → passthrough（AI 自己产的东西回 AI 自己）
    
    兜底：模型输出之外检测 PHI 模式 → [REDACTED-DATA-LEAK]
    """
    if request.get("redactDisabled"): return receipt  # 关闭后全放行
    return _walk(receipt, source=request.get("source"))


def _walk(value, source=None):
    if isinstance(value, dict):
        # 顶层或子层有 _source → 按源头策略剥
        local_source = value.get("_source", source)
        if local_source == "sas-dataset":
            return _to_metadata_only(value)
        if local_source == "spec-document":
            return _to_structure_only(value)
        # 其他字段继续递归
        return {k: _walk(v, local_source) for k, v in value.items() if k != "_source"}
    if isinstance(value, list):
        return [_walk(v, source) for v in value]
    if isinstance(value, str) and source not in {"model-output", "derived"}:
        # 兜底 PHI 扫描（不针对 model-output——AI 自己 stdout）
        for pat in PHI_PATTERNS:
            if pat.search(value):
                return "[REDACTED-DATA-LEAK]"
        return value
    return value
```

### 4.3 Excel 输出（保留模板 + 开放 layout）

```python
# excel/templates.py — 固定模板（必须保留）
CONTENT_TITLE = "Comparison Summary"
CONTENT_COLUMNS = [
    "Listing Seq.", "Form Name", "New/Modified ?", "Total",
    "New", "Modified", "Old",
]
COMPARISON_COLUMNS = [
    "Flag1", "__cmp_FLAG__", "__cmp_UpdateDetail__",
    "__cmp_RCcomment__", "__cmp_Idate__",
]
COMPARISON_LABELS = {
    "Flag1": "Flag1", "__cmp_FLAG__": "FLAG(New/Modified/Old)",
    "__cmp_UpdateDetail__": "Update Detail",
    "__cmp_RCcomment__": "Review Comments", "__cmp_Idate__": "Initial/Date",
}
REPORT_TITLE = "数据管理状态报告\nDM Status Report"
REPORT_COVER_LABELS = [
    "申办方：\nSponsor:", "方案编号：\nProtocol No:",
    "康德弘翼项目编号：\nWuXi Project ID:", "最新报告生成日期：",
]


def apply_default_template(outputs, scenario):
    """默认模板注入（标准输出范例）。
    
    AI 通过 df.attrs["_skip_default_template"] = True 可跳过。
    """
    if scenario in {"manual", "medical"}:
        for frame in outputs.values():
            if frame.attrs.get("_skip_default_template"): continue
            # 注入 ALS 审核列 + label
            for col in COMPARISON_COLUMNS:
                if col not in frame.columns:
                    frame[col] = ""
            labels = frame.attrs.get("labels", {})
            for col in COMPARISON_COLUMNS:
                labels[col] = COMPARISON_LABELS[col]
            frame.attrs["labels"] = labels
    return outputs


# excel/build_workbook.py — 单一入口
def create_multi_sheet_excel(outputs, output_file, scenario="manual"):
    """单一入口：固定模板（Content/Cover）+ 开放 layout（业务表头）。"""
    # 1. 默认模板（AI 可跳过）
    prepared = apply_default_template(outputs, scenario)
    
    # 2. 写工作簿
    wb = Workbook()
    if scenario == "report":
        _build_report_cover(wb, _report_metadata(prepared))  # 固定 Cover
        for sheet_name, frame in prepared.items():
            _build_sheet(wb, sheet_name, frame)                # 开放排版
    else:
        _build_content(wb, prepared)                          # 固定 Content Sheet
        for sheet_name, frame in prepared.items():
            _build_sheet(wb, sheet_name, frame)
    
    # 3. 原子写入
    _atomic_save(wb, output_file)
    
    return {
        "outputFile": str(output_file),
        "format": "single-workbook-multi-sheet-xlsx",
        "sheetNames": list(prepared.keys()),
        "totalSheets": len(prepared) + 1,
        "totalRows": sum(len(f) for f in prepared.values()),
    }


def _build_sheet(wb, sheet_name, frame):
    """业务 Sheet 渲染：按 df.attrs["_layout"] 自由排版。"""
    layout = frame.attrs.get("_layout", _default_layout())
    ws = wb.create_sheet(sheet_name)
    _apply_styles(ws, layout)
    _apply_header(ws, layout)
    _apply_data(ws, frame, layout)
    _apply_columns(ws, frame, layout)
    _apply_filter(ws, layout)
```

### 4.4 Sandbox（保留 safe_builtins）

```python
SANDBOX_BUILTINS = {
    "len": len, "range": range, "enumerate": enumerate, "zip": zip,
    "list": list, "dict": dict, "set": set, "tuple": tuple,
    "str": str, "int": int, "float": float, "bool": bool,
    "min": min, "max": max, "sum": sum, "abs": abs, "round": round,
    "sorted": sorted, "any": any, "all": all,
    "isinstance": isinstance, "hasattr": hasattr, "callable": callable,
    "type": type, "print": print,
}

# Sandbox 预载：让 AI 在 sandbox 内能调程序函数（不是真文件 IO，是程序封装）
SANDBOX_PRIMITIVES = {
    "pd": pd, "np": np, "math": math,
    "list_files": list_files,                       # 程序函数
    "scan_excel_structures": scan_excel_structures, # 程序函数
    "tag_dataframe": tag_dataframe,                 # 程序函数（源头标注）
}
```

---

## 5. MCP 入口契约（保留模板引导）

```typescript
// systemPrompt — 标准输出范例引导（不写死代码）
listing.systemPrompt.section({
  name: 'tool:enterprise-listing', order: 116,
  text: `# 临床 Listing 工具契约

## 标准输出范例（推荐）

### Medical/Manual 场景（RT01 标准）
推荐按以下结构生成：
- Content Sheet（自动生成）：
  - Row 1: 标题 "Comparison Summary"
  - Row 2: 表头 ["Listing Seq.", "Form Name", "New/Modified ?", "Total", "New", "Modified", "Old"]
  - Row 3+: 每个业务表的变化统计
- 业务 Sheet：
  - Row 1: 返回链接 + Sheet 名称
  - Row 2: Label（来自 attrs["labels"]）
  - Row 3+: 数据行
  - 默认补齐审核列：Flag1, __cmp_FLAG__, __cmp_UpdateDetail__, __cmp_RCcomment__, __cmp_Idate__

### Report 场景（DM Status Report 标准）
- Cover Page（自动生成）：申办方 / 方案编号 / 项目编号 / 报告日期
- 业务 Sheet：单层表头（Row 1 表头，Row 2+ 数据）

### RBQM 场景
- 无固定 Content/Cover Page
- 业务 Sheet 结构同 Manual

## 自定义排版

可通过 df.attrs["_layout"] 控制：
\`\`\`python
df.attrs["_layout"] = {
    "header_rows": 3,                    # 多层表头
    "header_columns": [["L1", "L1", "L2"], ["L1", "L2", "L2"]],
    "anchor_cell": (4, 1),
    "freeze_panes": "A4",
    "back_link": {"cell": "A1", "formula": "=HYPERLINK(...)"},
}
df.attrs["_skip_default_template"] = True  # 跳过默认模板
\`\`\`

## 数据红线（按源头判定）

- **sas 数据集（sas-dataset）**：只回元数据（列名/行数/dtype/nullCount/uniqueCount），行内容不出域
- **spec 辅助文件（spec-document）**：回结构（表结构 + ALS 三元组），值不出域
- **AI 自己产出（model-output）**：全放行——你自己写的东西回到你自己
- **拦截开关**：redactDisabled=true 全部放行（默认 false）

## Sandbox 安全（保留）

- 屏蔽 __import__ / open / Exception（程序执行安全，与数据红线无关）
- 屏蔽 getenv / system / popen（程序执行安全）
- stdout/stderr 自动脱敏（PHI 模式扫描）
`,
});
```

---

## 6. 测试矩阵（按 6 条反馈覆盖）

### 6.1 全量读取正确（反馈 1）

```python
def test_read_spec_files_full_content():
    # doc/ 下 50K txt + xlsx 整表 100 行 + ALS 列
    # 必须全量读到（行内容、cell value 都读到）
    # 源头标记 = "spec-document"
    # 拦截后才剥值
    
def test_sas_full_load():
    # sas7bdat 10000 行全量加载
    # 源头标记 = "sas-dataset"
    # 拦截后才剥为元数据
```

### 6.2 systemPrompt 模板引导（反馈 2）

```python
def test_system_prompt_contains_routine_examples():
    # systemPrompt 含 "Comparison Summary"、"Content Sheet"、"Cover Page" 等模板引导字样
    # 但不含硬编码代码分支
    
def test_ai_can_skip_template_via_attr():
    # df.attrs["_skip_default_template"] = True
    # _apply_default_template 不注入 ALS 列
```

### 6.3 密码推导保留（反馈 3）

```python
def test_archive_passwords_password_candidates_includes_doc_txt():
    # doc/*.txt 必须作为密码候选
    
def test_archive_passwords_password_candidates_includes_zip_stem():
    # zip 同名 .txt 必须作为候选

def test_password_value_never_leaks_to_ai():
    # 解压成功后回执不含密码值
```

### 6.4 固定模板保留（反馈 4）

```python
def test_content_sheet_template_intact():
    # 默认 medical/manual 场景自动生成 Content Sheet
    # Row 1 = "Comparison Summary"
    # Row 2 = CONTENT_COLUMNS
    # Row 3+ = 各业务表统计
    
def test_report_cover_template_intact():
    # report 场景自动生成 Cover Page
    # 4 行（申办方/方案编号/项目编号/报告日期）
    
def test_als_columns_added_by_default():
    # 默认 medical/manual 场景每个业务表自动补齐 Flag1/__cmp_*__ 列
    
def test_layout_attr_overrides_template():
    # df.attrs["_layout"]["header_columns"] 覆盖默认表头
```

### 6.5 按场景判定（反馈 5）

```python
def test_sas_source_marked():
    # load_datasets 返回的每张 df.attrs["_source"] = "sas-dataset"
    
def test_spec_source_marked():
    # read_spec_files 返回的每份文档 source = "spec-document"

def test_redact_sas_to_metadata_only():
    # input: {"_source": "sas-dataset", "columns": [...], "rowCount": 100}
    # output: {"_source": "sas-dataset", "columns": [...], "rowCount": 100}
    # input: {"_source": "sas-dataset", "sample": [1,2,3]}
    # output: {"_source": "sas-dataset"}  # sample 被剥
    
def test_redact_spec_to_structure_only():
    # input: {"_source": "spec-document", "content": "50K 全文"}
    # output: {"_source": "spec-document", "preview": "200字", "structure": {...}}
    
def test_redact_model_output_passthrough():
    # input: {"_source": "model-output", "outputs": {...}}
    # output: 原样（AI 自己写的东西回 AI 自己）

def test_redact_derived_passthrough():
    # AI 在 sandbox 内 merge 出的 df.attrs["_source"] = "derived"
    # 全放行

def test_no_field_name_blacklist_needed():
    # 不再有 OUT_BOUND_FORBIDDEN_FIELDS 字段黑名单
    # 全靠源头判定
```

### 6.6 拦截开关可关闭（反馈 6）

```python
def test_redact_disabled_default_false():
    # 默认 redactDisabled=False，拦截生效
    
def test_redact_disabled_true_skips_all():
    # redactDisabled=True，sanitize_receipt 不调用
    # sas 数据集行内容原样回执
    
def test_sandbox_safety_independent_of_redact_switch():
    # redactDisabled=True 不解除 sandbox safe_builtins
    # open() / __import__ 仍阻断（这是程序执行安全）
```

---

## 7. 文件级最终改动（按 6 条反馈）

### 7.1 保留（不删）

| 文件 | 原因 |
|---|---|
| `python/archive_passwords.py` | 密码推导是工程必要 |
| `python/check_deps.py` | 启动期检查 |
| `python/worker.py`（主体） | 调度逻辑保留，重构 dispatch |
| `python/styles/multi_sheet_writer.py` | 重写但保留模块位置 |
| `STANDARD_SCENARIOS` 常量 | 用于默认模板（AI 可跳过） |
| `COMPARISON_COLUMNS / LABELS` | 是输出标准（模板默认），AI 可跳过 |

### 7.2 重构（基于现有模块）

| 模块 | 重构 |
|---|---|
| `worker.py` | dispatch 三操作 → 统一 `sanitize_receipt` 出口（按源头判定，可关闭） |
| `multi_sheet_writer.py` | 拆为 `excel/{atoms,templates,layout,build}` |
| `systemPrompt` | 重写为"标准输出范例引导"——内容保留为示范 |

### 7.3 新增

| 模块 | 职责 |
|---|---|
| `python/source_registry.py` | `DataSource` 枚举 + `tag_dataframe` |
| `python/redact.py` | 场景化拦截（按源头） + 开关 |
| `python/excel/templates.py` | 默认模板（Content/Cover/ALS）— 标记 `default_template=True` |
| `python/excel/layout.py` | 读 `df.attrs["_layout"]` |
| `python/excel/build_workbook.py` | 单一入口 |

### 7.4 删除（之前误判）

| 删除 | 原因 |
|---|---|
| `OUT_BOUND_FORBIDDEN_FIELDS`（黑名单字段名 10 个） | 改为按源头判定，不再按字段名 |
| `MAX_CAPTURE_CHARS = 2000`（缩到 2000） | 改回 16384（按源头判定不靠长度截断） |
| 删除 `archive_passwords.py` 的计划 | 撤回，必须保留 |
| 删除 `_prepare_outputs` 强塞列 | 改回：保留为 `apply_default_template`，AI 可跳过 |
| 删除 `STANDARD_SCENARIOS` 枚举 | 改回：保留用于触发默认模板 |

---

## 8. 决策记录（10 条 ADR）

| ADR | 决策 | 来源 |
|---|---|---|
| ADR-0013 | 全量读取正确（spec / sas 全量读，按源头判定剥值） | 反馈 1 |
| ADR-0014 | systemPrompt 保留标准输出范例（不写死代码但保留模板引导） | 反馈 2 |
| ADR-0015 | 密码推导必须保留（archive_passwords.py 不删） | 反馈 3 |
| ADR-0016 | 固定模板保留（Content Sheet / Cover Page / ALS 审核列），AI 可通过 attrs 跳过 | 反馈 4 |
| ADR-0017 | 红线按场景判定（按源头 _source 字段，不再按字段名黑名单） | 反馈 5 |
| ADR-0018 | 拦截开关可控（redactDisabled 默认 false，关闭后全放行；sandbox 安全不受影响） | 反馈 6 |
| ADR-0019 | 源头标注：sas-dataset / spec-document / model-output / derived | 反馈 5 |
| ADR-0020 | 默认模板可跳过（df.attrs["_skip_default_template"] = True） | 反馈 4 |
| ADR-0021 | Sandbox 安全独立于 redact 开关（路径穿越/执行安全不在 redact 范围） | 反馈 6 |
| ADR-0022 | 样式常量保留（颜色/字体/行高/列宽）；layout attrs 控制排版决策 | 反馈 4 |

---

## 9. 与 v1 的关键差异

| 维度 | v1（我之前错的设计） | v2（本次正确） |
|---|---|---|
| **全量读取** | "返回原文是红线漏洞，要去掉"（错） | 全量读取正确，按源头判定剥值 |
| **systemPrompt** | "罗列 sheet 结构是写死，要去掉"（错） | 模板引导保留（标准输出范例） |
| **archive_passwords** | 删除（错） | 必须保留 |
| **固定模板** | 删除 Content/Cover/ALS（错） | 保留为默认模板，AI 可跳过 |
| **红线判定** | 字段黑名单 10 个 + 模式扫描 | **按源头判定**（_source 字段） |
| **拦截开关** | 不可关闭（错） | `redactDisabled` 可控，默认 false |
| **兜底** | 字段黑名单 + 模式扫描 | 仅模式扫描（PHI），针对非 model-output |

---

## 10. 总结

**v2 的核心范式转换**：

1. **数据红线判定 = 源头，不是字段名**
   - 按 `df.attrs["_source"]` 判定：`sas-dataset` → metadata_only；`spec-document` → structure_only；`model-output` → passthrough
   - 比字段黑名单更准确（无法绕过）

2. **拦截是开关可控的**
   - 默认开启（`redactDisabled = false`）
   - 关闭后全部取消（除 sandbox 安全，那是程序执行安全不是数据安全）

3. **全量读取是工程必要**
   - `read_spec_files` 全量读 `.txt[:50_000]` + `.xlsx` 整表 = 正确
   - `pd.read_sas` 全量读 = 正确
   - 值出域靠源头拦截层剥

4. **固定模板是输出标准**
   - Content Sheet / Cover Page / ALS 审核列保留
   - AI 通过 `df.attrs["_skip_default_template"] = True` 可跳过
   - AI 通过 `df.attrs["_layout"]` 可改业务表排版

5. **systemPrompt 是引导不是写死**
   - 保留标准输出范例（推荐按 RT01 模板、按 DM Status 模板）
   - 不写死代码分支（不强制走哪种 sheet 结构）

**最终架构形态**：

```
数据加载层（discovery.py）：全量读 + 源头标注
↓
Sandbox 层（sandbox.py）：safe_builtins 保留
↓
操作层（worker.py）：三操作各自产回执
↓
拦截层（redact.py）：按源头判定（sas → metadata；spec → structure；output → passthrough）
  ↑ ↑
  │ └─ redactDisabled 开关（默认 false）
  └─ sandbox 安全独立于此开关
↓
Excel 层（excel/）：模板保留 + layout 开放
↓
MCP 层（index.ts）：模板引导保留 + redactDisabled 透传
```

每层职责清晰，每条 ADR 有反馈来源，每个测试有覆盖目标。

---

## 11. 实现澄清（2026-08-27 同日口头反馈，效力高于上文遗留表述）

> 本节为实现当天用户追加的范围澄清，与 §1.4 表格及 §5 中"stdout 自动
> 脱敏 / PHI 模式兜底扫描"的遗留表述冲突时，**以本节为准**。已落档
> ADR-0005。

1. **拦截范围收紧到唯一出口**：只拦截"读取数据源动作产生的回执出域
   到 AI"——即 `listing_inspect` 的 documents/datasets 载荷与 sandbox
   读取类程序函数的返回值。`run_code` 的 stdout/stderr 是 sandbox 内
   AI 操作的回显，**原样回执，不做脱敏**。
2. **无模式兜底扫描**：`PHI_PATTERNS` 不进运行时路径。日期
   （`2026-08-27`）、`USUBJID` 列名等必需信息不得被打码——不能把 AI
   整成盲人。按源头判定已经精确且不可绕过。
3. **passthrough 子树对象恒等**：`model-output` / `derived` 与一切未
   标记内容返回原对象（`_walk` 保持 identity），一个字节都不动。
4. 其余 6 条反馈的落地与本文 §1–§7 一致：全量读取、模板保留、密码
   推导保留、源头判定、`redactDisabled` 开关、sandbox 执行安全独立。

---

## 12. 后续修订（2026-08-28，取代本节之上的红线相关表述）

次日用户再澄清 + 全面审计后，红线口径收敛为**两规则 + 宿主开关**，已按
`docs/enterprise/DATA_GUARD_PLUGIN_DESIGN_20260828.md` 实施并落档
ADR-0006。与本节冲突之处以 ADR-0006 为准，要点：

- doc/ 文本**全量直通**（撤销 §11-2 之外残余的 200 字预览投影）；
- 拦截只剩两种场景：数据集行值（→ 元数据白名单）、doc/ 辅助 Excel
  单元格值（→ 结构白名单）；
- `redactDisabled` 工具参数**删除**（审计 P0-1：模型可自关红线），开关
  改为宿主侧 DataSecurityService 设置页（P1-2 死接线接活）；
- 沙箱补 AST 禁用表（`read_*/to_*/eval/query`）与程序函数项目根围栏，
  `tag_dataframe` 移出模型命名空间（P0-4 / P1-1）。