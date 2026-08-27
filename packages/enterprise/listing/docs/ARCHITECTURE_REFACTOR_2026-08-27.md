# Listing 插件架构级重构方案（基于当前实现）

> 时间：2026-08-27
> 范围：`packages/enterprise/listing` 全栈重构
> 目标：**从架构层实现"智能最大化 + 数据红线安全"**，不做补丁

---

## 1. 当前架构盘点

```
┌─ MCP Server (TypeScript) ─────────────────────────────────────┐
│ src/index.ts            : 3 个 tool 入口 + systemPrompt section│
│ src/worker.ts           : Node spawn python 进程、NDJSON 串行 │
└────────────────────┬───────────────────────────────────────────┘
                     │ stdin/stdout NDJSON
┌────────────────────▼──────────────────────────────────────────┐
│ Python 持久 Worker (单进程、3 个全局变量)                        │
│ python/worker.py        : dispatch() JSONL 主循环              │
│   operation_inspect     : collect_datasets + read_spec_files    │
│   operation_run_code    : sandbox exec, safe_builtins          │
│   operation_publish     : create_multi_sheet_excel             │
│                                                                 │
│ python/archive_passwords.py : 全树 rglob 当密码候选             │
│ python/check_deps.py     : 一次性依赖检查（启动期）               │
│ python/styles/          : Excel 写出的样式原语库                │
│   multi_sheet_writer.py : _prepare_outputs + _build_listing    │
│                           _build_report_sheet + _build_content │
│                           _build_report_cover                  │
│                           _align_previous_columns              │
│                           load_previous_version                │
│                           calculate_changes                    │
└─────────────────────────────────────────────────────────────────┘
```

**当前问题清单**（按架构层分类）：

| 层 | 问题 | 类型 |
|---|---|---|
| Worker | 后缀白名单 `.sas7bdat/.xpt/.csv` | 写死业务定义 |
| Worker | `archive_passwords.py` 全树 rglob | 写死业务逻辑 |
| Worker | `_session_datasets` 等全局单实例 | 多 session 串扰 |
| Worker | sandbox 仅屏蔽危险 builtins，未做"出域拦截" | 数据红线漏洞 |
| Worker | `read_spec_files` 直接读 `.txt[:50_000]` + `.xlsx` 整表内容 | 数据红线漏洞 |
| Worker | `inspect` 返回仅元数据三件套 | 信息供给不足 |
| Worker | `run_code` 返回仅结构，无结构字段加值统计 | 信息供给不足 |
| Writer | `_prepare_outputs` 强塞 COMPARISON_COLUMNS | 写死业务定义 |
| Writer | `_build_listing` 写死 Row 1=HYPERLINK/A1:F1 合并/Row 60 高度 | 写死排版决策 |
| Writer | `STANDARD_SCENARIOS` 按 scenario 枚举 | 写死业务识别 |
| Writer | `_align_previous_columns` 按列号改名 | 写死读取 |
| Writer | `load_previous_version` `min_row=3` / `next(rows_iter)` | 写死读取 |
| Writer | `reportStructureApplied` 等业务字段 | 业务定义泄漏 |
| Writer | `unique_key_columns` 死参数 | 冗余 |
| MCP | systemPrompt 罗列 sheet 结构 | 写死业务定义（system 层） |

---

## 2. 重构目标架构

```
┌─ MCP Server (TypeScript) ─────────────────────────────────────────┐
│ src/index.ts    : 3 个 tool 入口 + systemPrompt 只传达契约         │
│ src/worker.ts   : NDJSON 串行协议 + transport 适配（不变）           │
└────────────────────┬────────────────────────────────────────────────┘
                     │ stdin/stdout NDJSON
┌────────────────────▼────────────────────────────────────────────────┐
│ Python 持久 Worker                                                   │
│                                                                       │
│  ┌─ 数据加载层 ──────────────────────┐                                │
│  │ _discovery.py                     │  ← 给 AI 看「结构」           │
│  │   list_files(project)            │  ← 全文件清单（路径/大小/后缀）│
│  │   scan_excel_structures(project) │  ← 读 Excel 表结构（横/纵/   │
│  │                                    │      多层/不规则），不返回值   │
│  │   load_datasets(project)         │  ← 返回 dict[str, DataFrame]  │
│  │   zip_extract(archive, target)   │  ← 程序机械解压                 │
│  └──────────────────────────────────┘                                │
│                                                                       │
│  ┌─ 单向玻璃 sandbox 层 ────────────┐                                  │
│  │ _sandbox.py                       │                                │
│  │   safe_builtins (白名单)          │  ← 屏蔽 __import__/open/...    │
│  │   preloaded_primitives (pd/np/   │                                │
│  │       math/datasets/list_files/   │                                │
│  │       scan_excel_structures/...)  │                                │
│  │   OUT_BOUND_FIELDS = {...}  黑名单│  ← 出域拦截的字段名集合         │
│  │   sanitize_return(value)         │  ← 递归脱敏                    │
│  └──────────────────────────────────┘                                │
│                                                                       │
│  ┌─ 红线拦截层 ──────────────────────┐                                │
│  │ _redact.py                         │                                │
│  │   _scrub_field_names(dict)        │  ← 黑名单字段丢弃              │
│  │   _scrub_value_patterns(str)      │  ← 模式扫描（日期/PHI）        │
│  │   _scrub_text(text, max=2000)     │  ← 长度截断                    │
│  │   _sanitize_receipt(receipt)       │  ← 组合以上三步                │
│  └──────────────────────────────────┘                                │
│                                                                       │
│  ┌─ 操作分发层 ──────────────────────┐                                │
│  │ worker.py                          │                                │
│  │   dispatch(request) → response    │                                │
│  │     if inspect → _discovery.*     │                                │
│  │     if run_code → _sandbox.exec   │                                │
│  │     if publish → excel.build +     │                                │
│  │                  _sanitize_receipt │                                │
│  └──────────────────────────────────┘                                │
│                                                                       │
│  ┌─ Excel 写出层（纯原语库）───────┐                                  │
│  │ excel/                             │                                │
│  │   style_atoms.py (字体/颜色/边框)│  ← 纯原语常量                   │
│  │   layout.py         (排版策略)    │  ← 读 df.attrs["_layout"]     │
│  │   build_workbook()                │  ← 单一入口，零场景分支       │
│  └──────────────────────────────────┘                                │
└───────────────────────────────────────────────────────────────────────┘
```

**关键变化**：
1. **删除** `archive_passwords.py`（密码推导完全交给 AI 在 sandbox 内通过标准 `zipfile` 完成）
2. **删除** `check_deps.py`（启动期由 TypeScript 侧做；不属于数据层）
3. **重构** `multi_sheet_writer.py` → 拆为 `excel/style_atoms.py` + `excel/layout.py` + `excel/build_workbook.py`
4. **新增** `_discovery.py`、`_sandbox.py`、`_redact.py` 三个分层模块
5. **删除** `_prepare_outputs` 强塞列、`STANDARD_SCENARIOS` 枚举、`_align_previous_columns` 按列号改名

---

## 3. 文件级改造清单

### 3.1 删除（7 个）

| 文件 | 删除原因 |
|---|---|
| `python/archive_passwords.py` | 写死业务逻辑；密码推导由 AI 在 sandbox 内完成 |
| `python/check_deps.py` | 启动检查由宿主做；不在数据层职责 |
| `python/styles/multi_sheet_writer.py` | 重构为 excel/ 三模块 |
| `python/styles/__init__.py` | 同步重写 |
| `_prepare_outputs` 函数 | 写死业务定义（强塞 COMPARISON_COLUMNS） |
| `_align_previous_columns` 函数 | 写死按列号读取 |
| `unique_key_columns` 参数 | 死代码 + 业务定义泄漏 |

### 3.2 新增（5 个）

| 文件 | 职责 |
|---|---|
| `python/discovery.py` | `list_files` / `scan_excel_structures` / `load_datasets`——纯结构返回，零数据值 |
| `python/sandbox.py` | safe_builtins + preloaded 原语 + 预编译执行 |
| `python/redact.py` | 字段黑名单 + 模式扫描 + 长度截断 |
| `python/excel/style_atoms.py` | 纯样式常量（颜色/边框/字体/对齐） |
| `python/excel/layout.py` | 读 `df.attrs["_layout"]`，决定 sheet 排版（AI 自由组合） |
| `python/excel/build_workbook.py` | 单一入口，按 df.attrs 自由排版 |

### 3.3 保留并修改（4 个）

| 文件 | 修改 |
|---|---|
| `python/worker.py` | 简化 `dispatch`：三操作各自调用新模块；统一 `_sanitize_receipt` 拦截 |
| `python/styles/__init__.py` | 重写为 `from .excel.build_workbook import create_multi_sheet_excel` |
| `src/index.ts` | systemPrompt 只传达契约，不罗列 sheet 结构 |
| `src/worker.ts` | 不变（传输层） |

---

## 4. 核心契约定义（代码级）

### 4.1 数据红线契约（_redact.py）

```python
# 受保护的值字段名：出现即整字段丢弃（10 个黑名单）
OUT_BOUND_FORBIDDEN_FIELDS: frozenset[str] = frozenset({
    "sample", "preview", "head", "values", "data",
    "content", "rows", "cells", "items", "records",
})

# 受保护的数据模式：命中即 [REDACTED-DATA-LEAK]
VALUE_PATTERNS: tuple[re.Pattern, ...] = (
    re.compile(r"\b\d{4}-\d{2}-\d{2}\b"),                  # ISO 日期
    re.compile(r"\b\d{1,2}[A-Z]{3}\d{4}\b"),               # 临床日期（15JAN2024）
    re.compile(r"^\s*USUBJID\b", re.IGNORECASE | re.MULTILINE),
    re.compile(r"[一-鿿]{2,}.{0,40}(患者|受试者|试验|方案)"),
    re.compile(r"\b[A-Z]{2,}-\d{3,}-\d{3,}\b"),           # 协议编号
)

# 受保护的 stdout/stderr 长度
MAX_CAPTURE_CHARS = 2000  # 从 16384 缩到 2000


def sanitize(value: Any, depth: int = 0) -> Any:
    """递归脱敏：黑名单字段 + 模式扫描 + 长度截断。
    
    设计原则：结构字段一律放行，值字段全拦截。
    """
    if depth > 16: return "[TRUNCATED-DEPTH]"
    if isinstance(value, dict):
        return {k: sanitize(v, depth + 1) for k, v in value.items()
                if k not in OUT_BOUND_FORBIDDEN_FIELDS}
    if isinstance(value, list):
        return [sanitize(v, depth + 1) for v in value]
    if isinstance(value, str):
        for pat in VALUE_PATTERNS:
            if pat.search(value):
                return "[REDACTED-DATA-LEAK]"
        return value[:MAX_CAPTURE_CHARS]
    return value


def sanitize_receipt(receipt: dict) -> dict:
    """统一入口：所有 MCP 响应走这里。"""
    return cast(dict, sanitize(receipt))
```

### 4.2 单向玻璃 sandbox 契约（_sandbox.py）

```python
# Sandbox 白名单：AI 在 sandbox 内可用的全部内置
SANDBOX_BUILTINS: dict[str, Any] = {
    # 类型/序列
    "len": len, "range": range, "enumerate": enumerate, "zip": zip,
    "list": list, "dict": dict, "set": set, "tuple": tuple,
    "str": str, "int": int, "float": float, "bool": bool,
    # 集合操作
    "min": min, "max": max, "sum": sum, "abs": abs, "round": round,
    "sorted": sorted, "any": any, "all": all,
    # 类型判断
    "isinstance": isinstance, "hasattr": hasattr, "callable": callable,
    "type": type,
    # IO（仅 stdout/stderr，不开 open）
    "print": print,
}

# Sandbox 预载原语（AI 可调用，但不进回执 = "单向玻璃"）
SANDBOX_PRIMITIVES: dict[str, Any] = {
    "pd": pd, "np": np, "math": math, "datasets": ...,  # 运行期注入
    # 程序读到的"结构"可送 AI；读到的"值"被屏蔽在 stdout
}


def execute(code: str, datasets: dict[str, pd.DataFrame]) -> tuple[dict, str, str]:
    """在 sandbox 内执行 code，返回 (env_after_exec, stdout, stderr)。
    
    调用方负责把 stdout/stderr 灌进 redact.sanitize_receipt。
    """
    environment: dict[str, Any] = {
        "__builtins__": SANDBOX_BUILTINS,
        "datasets": datasets,
        **SANDBOX_PRIMITIVES,
    }
    capture_out, capture_err = StringIO(), StringIO()
    with redirect_stdout(capture_out), redirect_stderr(capture_err):
        exec(compile(code, "<listing-code>", "exec"), environment)
    return environment, capture_out.getvalue(), capture_err.getvalue()
```

### 4.3 信息供给契约（_discovery.py）

```python
# AI 第一次进 session 拿到的"项目地形图"
@dataclass
class ProjectTerrain:
    files: list[FileEntry]                   # 路径 / 大小 / 后缀（结构）
    excel_structures: list[ExcelStructure]   # 多表结构识别（横/纵/多层/不规则）
    dataset_metadata: dict[str, DatasetMeta] # datasets[*].columns / rowCount / dtype
    previous_version: Optional[PreviousVersion]  # 上版指纹（结构级）


@dataclass
class FileEntry:
    path: str
    size: int
    suffix: str
    is_dir: bool
    # ⚠️ 不含 content / preview / sample


@dataclass
class ExcelStructure:
    path: str
    sheets: list[SheetStructure]
    # ⚠️ 不含任何 cells[*].value


@dataclass
class SheetStructure:
    name: str
    orientation: Literal["horizontal", "vertical", "mixed"]
    header_rows: int                       # 多层表头占 N 行
    header_levels: int                     # 表头合并层数
    max_row: int
    max_column: int
    merged_cells: list[str]                # 合并范围（A1:C1）
    column_tree: dict[str, list[str]]      # 多表头层级
    is_irregular: bool                     # 不规则（合并/稀疏）
    # ⚠️ 不含 cells[*].value / preview / sample


def scan_excel_structures(project: Path) -> list[ExcelStructure]:
    """扫描项目下所有 Excel，返回结构指纹，不返回值。"""
    ...


def list_files(project: Path) -> list[FileEntry]:
    """列出项目下所有文件路径。"""
    ...


def load_datasets(project: Path) -> dict[str, pd.DataFrame]:
    """加载 sas/xpt/csv 数据集到 dict[str, DataFrame]。"""
    ...
```

### 4.4 Excel 输出契约（_excel/）

```python
# df.attrs["_layout"]：AI 通过此字段自由组合排版
@dataclass
class SheetLayout:
    # 行配置（最多 10 行表头——多层表头）
    header_rows: int = 1                   # 表头占 N 行（默认 1）
    header_columns: list[list[str]] = ...  # 多层表头：[[L1, L1, L2], [L1, L2, L2]]
    # 锚点配置
    anchor_cell: tuple[int, int] = (1, 1)  # 数据起始行/列（默认 A1）
    freeze_panes: str = "A2"               # 冻结算法
    auto_filter: bool = True
    # 样式选择（指向 style_atoms 常量名）
    header_style: str = "HEADER_FONT"      # 引用样式原语
    data_style: str = "DATA_FONT"
    fill_color: str = "PALE_BLUE"
    border: str = "GRID_BORDER"
    alignment: str = "HEADER_ALIGNMENT"
    # 可选：导航（自由决定要不要 / 放哪）
    back_link: Optional[dict] = None       # {"cell": "A1", "formula": "=HYPERLINK(...)"}
    # 可选：分组（特殊场景）
    sheet_group: Optional[str] = None
```

**Sheet 渲染算法**（`excel/build_workbook.py`）：

```python
def create_multi_sheet_excel(
    outputs: dict[str, pd.DataFrame],
    output_file: Path,
) -> dict[str, Any]:
    """单一入口：按 df.attrs["_layout"] 自由排版，零场景分支。"""
    # 1. 规范化 sheet 名（程序机械责任）
    normalized = normalize_sheet_outputs(outputs)
    
    # 2. 原子写入（程序机械责任）
    wb = Workbook()
    for sheet_name, frame in normalized.items():
        layout = frame.attrs.get("_layout", default_layout())
        _render_sheet(wb, sheet_name, frame, layout)
    
    # 3. 原子保存（程序机械责任）
    output_file.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{output_file.stem}-", suffix=".xlsx", dir=output_file.parent)
    os.close(fd)
    tmp_path = Path(tmp)
    try:
        wb.save(tmp_path); wb.close()
        os.replace(tmp_path, output_file)
    finally:
        tmp_path.unlink(missing_ok=True)
    
    # 4. 机械返回（结构级，不含数据值）
    return {
        "outputFile": str(output_file),
        "format": "single-workbook-multi-sheet-xlsx",
        "sheetNames": list(normalized.keys()),
        "totalSheets": len(normalized) + 1,  # +1 for Content/Cover if exists
        "totalRows": sum(len(frame) for frame in normalized.values()),
    }
```

**`_render_sheet` 按 layout 自由渲染**：

```python
def _render_sheet(wb, sheet_name, frame, layout):
    ws = wb.create_sheet(sheet_name)
    ws.freeze_panes = layout.freeze_panes
    ws.sheet_view.showGridLines = False
    
    # 1. 锚点之前的"导航行"（可选）
    if layout.back_link:
        cell = ws.cell(*layout.back_link["cell"], layout.back_link["formula"])
        cell.font = BACK_LINK_FONT
        cell.border = GRID_BORDER
    
    # 2. 表头（多层）
    header_font = STYLE_ATOMS[layout.header_style]
    header_fill = STYLE_ATOMS[layout.fill_color]
    for row_idx, header_row in enumerate(layout.header_columns):
        for col_idx, value in enumerate(header_row, 1):
            cell = ws.cell(row_idx + 1, col_idx, value)
            cell.font = copy(header_font)
            cell.fill = copy(header_fill)
            cell.alignment = STYLE_ATOMS[layout.alignment]
    
    # 3. 数据（从锚点起）
    data_font = STYLE_ATOMS[layout.data_style]
    anchor_row, anchor_col = layout.anchor_cell
    for row_offset, values in enumerate(frame.itertuples(index=False, name=None)):
        for col_offset, value in enumerate(values):
            cell = ws.cell(anchor_row + row_offset, anchor_col + col_offset,
                           None if pd.isna(value) else value)
            cell.font = copy(data_font)
            cell.alignment = Alignment(vertical="center")
    
    # 4. 列宽自适应（程序机械责任）
    for col_idx, column in enumerate(frame.columns, anchor_col):
        ws.column_dimensions[get_column_letter(col_idx)].width = \
            max(14.71, min(50.71, len(str(column)) + 2))
    
    # 5. 筛选范围（程序机械责任）
    if layout.auto_filter:
        last_col = get_column_letter(anchor_col + len(frame.columns) - 1)
        ws.auto_filter.ref = f"A{anchor_row}:{last_col}{anchor_row + len(frame)}"
```

---

## 5. Worker 主循环（重构后）

```python
# worker.py — 极简 dispatch
from discovery import list_files, scan_excel_structures, load_datasets
from sandbox import execute
from redact import sanitize_receipt
from excel.build_workbook import create_multi_sheet_excel
import json
import sys


def op_inspect(req):
    project = Path(req["project"]).resolve()
    return {
        "ok": True,
        "action": "listing-inspect",
        "inspection": {
            "files": list_files(project),
            "excelStructures": scan_excel_structures(project),
            "datasetMetadata": _meta_only(load_datasets(project)),
            "scenario": req.get("scenario"),
        },
    }


def op_run_code(req):
    project = Path(req["project"]).resolve()
    datasets = load_datasets(project)
    env, stdout, stderr = execute(req["code"], datasets)
    if "outputs" not in env:
        return {"ok": False, "code": "OUTPUTS_REQUIRED",
                "reason": "代码必须定义 outputs"}
    _session_outputs = env["outputs"]
    return {
        "ok": True,
        "action": "listing-run-code",
        "receipt": {
            "outputs": _structure_only(_session_outputs),  # 仅列结构
            "publishReady": True,
            "stdout": stdout,    # redact 阶段会被截断 + 模式扫描
            "stderr": stderr,
        },
    }


def op_publish(req):
    output = Path(req["project"]).resolve() / ".clinical-listing" / "output.xlsx"
    statistics = create_multi_sheet_excel(_session_outputs, output)
    return {
        "ok": True,
        "action": "listing-publish",
        "receipt": {"statistics": statistics},
    }


def dispatch(req):
    op = req.get("operation")
    if op == "listing_inspect": return op_inspect(req)
    if op == "listing_run_code": return op_run_code(req)
    if op == "listing_publish": return op_publish(req)
    return {"ok": False, "code": "UNKNOWN_OPERATION"}


def main():
    for line in sys.stdin:
        if not line.strip(): continue
        try:
            response = dispatch(json.loads(line))
        except Exception as exc:
            response = {"ok": False, "code": "WORKER_ERROR", "reason": str(exc)}
        # ✅ 统一拦截：所有响应必经 redact
        sys.stdout.write(json.dumps(sanitize_receipt(response), ensure_ascii=False) + "\n")
        sys.stdout.flush()
```

**关键**：`sanitize_receipt` 在 `main` 出口处统一拦截——任何字段流到 stdout 前都会被扫描，黑名单字段（`sample/preview/head/values/data/content/rows/cells/items/records`）直接丢弃，模式命中的字符串替换成 `[REDACTED-DATA-LEARK]`。

---

## 6. MCP 入口契约（src/index.ts 重构）

```typescript
// systemPrompt 只传达契约，不罗列 sheet 结构
listing.systemPrompt.section({
  name: 'tool:enterprise-listing', order: 116,
  text: `# 临床 Listing 工具契约

## 三阶段工作流

### 1. enterprise_listing_inspect
返回"项目地形图"，全结构字段，零数据值：
- files：路径 / 大小 / 后缀（结构）
- excelStructures[*].sheets[*]：横/纵/多层/不规则表的结构指纹（不含 cell value）
- datasetMetadata[*]：列名 / 行数 / dtype / nullCount（结构 + 统计）
- scenario：当前场景字符串

### 2. enterprise_listing_run_code
在 sandbox 内写 pandas 代码，必须定义 outputs: dict[str, DataFrame]。
可通过 df.attrs["_layout"] 控制排版：
- header_rows / header_columns：多层表头（横/纵/不规则）
- anchor_cell / freeze_panes / auto_filter
- back_link：可选导航
- header_style / data_style：引用样式原语名

### 3. enterprise_listing_publish
原子发布 Excel。layout 由你控制，程序不写死。

## 数据红线（精确边界）

结构识别全送：列名 / 表头行数 / 合并单元格 / 方向 / dtype / rowCount / 统计
数据值禁出域：单元格内容 / 受试者 ID / 日期 / 姓名 / 编号 / PHI

禁止字段（回执自动丢弃）：
sample / preview / head / values / data / content / rows / cells / items / records

## Sandbox 单向玻璃
你在 sandbox 内 print() / inspect_doc() / inspect_xlsx_sheet(rows>0)
读到的内容进 stdout，**stdout 不会被送回**——你能"看到"但结果不回到模型视野。

## 程序操作不受限
Worker 对 Excel / sas / zip / 文件系统的操作完全放开。
限制只在 sandbox（AI 代码）和回执字段（值字段黑名单）。
`,
});

// 三个 tool 不变（transport 走 src/worker.ts）
registerTool(listing, { name: 'enterprise_listing_inspect', ... })
registerTool(listing, { name: 'enterprise_listing_run_code', ... })
registerTool(listing, { name: 'enterprise_listing_publish', ... })
```

---

## 7. 状态机（取代全局变量）

**当前问题**：`_session_project / _session_datasets / _last_outputs` 全局单实例 → 多 session 串扰。

**重构**：worker 进程内每个 `project` 一个 session dict：

```python
_sessions: dict[str, dict] = {}  # project → {datasets, last_outputs, loaded_at}

def _get_session(project: Path) -> dict:
    key = str(project)
    if key not in _sessions:
        _sessions[key] = {
            "datasets": load_datasets(project),
            "last_outputs": None,
            "loaded_at": datetime.now(),
        }
    return _sessions[key]
```

**配套**：进程退出时 `_sessions.clear()`；每个 session 含 LRU 限制（如最多 8 个）防止 OOM。

---

## 8. 测试矩阵（架构级验证）

### 8.1 数据红线

```python
# 字段级拦截（10 个黑名单）
test_sanitize_drops_sample_field()           # {"sample": "x"} → {}
test_sanitize_drops_content_field()          # {"content": "x"} → {}
test_sanitize_drops_values_field()           # {"values": [1,2,3]} → {}

# 模式拦截
test_sanitize_redacts_iso_dates()            # "2024-01-15" → "[REDACTED-DATA-LEAK]"
test_sanitize_redacts_chinese_phi()          # "受试者张三" → "[REDACTED-DATA-LEAK]"

# 结构字段放行（反向）
test_sanitize_passes_columns_through()       # {"columns": [...]} 保留
test_sanitize_passes_orientation_through()    # {"orientation": "horizontal"} 保留
test_sanitize_passes_header_rows_through()    # {"headerRows": 3} 保留
test_sanitize_passes_merged_cells_through()  # {"mergedCells": [...]} 保留
test_sanitize_passes_dtype_through()          # {"dtype": "int64"} 保留
test_sanitize_passes_row_count_through()      # {"rowCount": 1234} 保留
test_sanitize_passes_unique_count_through()   # {"uniqueCount": 2} 保留

# 多场景表结构
test_inspect_recognizes_horizontal_table()    # orientation: "horizontal"
test_inspect_recognizes_vertical_table()      # orientation: "vertical"
test_inspect_recognizes_multilevel_header()   # headerLevels: 3
test_inspect_recognizes_irregular_table()     # isIrregular: True

# Sandbox 单向玻璃
test_sandbox_print_doesnt_leak_to_receipt()  # print(df.head()) → stdout=[REDACTED]
test_sandbox_inspect_doc_not_in_receipt()     # 调 inspect_doc(path) → 回执不含 content
```

### 8.2 业务开放性

```python
# AI 自由排版
test_layout_attr_header_columns_renders()    # df.attrs["_layout"]["header_columns"]
test_layout_attr_back_link_renders()         # df.attrs["_layout"]["back_link"]
test_layout_attr_freeze_panes_renders()      # df.attrs["_layout"]["freeze_panes"]

# 场景无关
test_no_scenario_branch_in_writer()           # create_multi_sheet_excel 不再判 scenario
test_ai_can_define_arbitrary_columns()        # 任意 columns 都接受
test_ai_can_mix_sheet_structures()            # 同 workbook 内横向 + 纵向 + 多层混合

# Worker 程序操作
test_worker_can_read_excel_freely()           # Worker openpyxl 不受 sandbox 限制
test_worker_can_extract_zip_freely()          # Worker zipfile 不受 sandbox 限制
test_worker_can_load_sas_freely()             # Worker pd.read_sas 不受 sandbox 限制
```

### 8.3 状态隔离

```python
test_two_sessions_dont_interfere()            # project A / B 各跑一遍 outputs 不串
test_session_lru_eviction()                  # 第 9 个 session 触发 LRU
```

---

## 9. 实施步骤

### Phase 1（架构骨架）

1. 新建 `python/discovery.py` + `python/sandbox.py` + `python/redact.py`
2. 删除 `python/archive_passwords.py` + `python/check_deps.py`
3. 重写 `python/worker.py` 的 `dispatch`，统一 `sanitize_receipt` 出口
4. 验证：inspect 不返回任何值字段，run_code 的 stdout 自动脱敏

### Phase 2（Excel 原语化）

5. 新建 `python/excel/style_atoms.py` + `layout.py` + `build_workbook.py`
6. 删除 `python/styles/multi_sheet_writer.py`
7. 验证：writer 无 scenario 分支；df.attrs["_layout"] 自由控制排版

### Phase 3（契约层）

8. 重写 `src/index.ts` 的 systemPrompt（只传达契约，不罗列 sheet 结构）
9. 重写 `_sessions` 状态机（取代全局变量）
10. 验证：多 session 串行不串扰

### Phase 4（测试覆盖）

11. 字段级拦截测试（10 个黑名单）
12. 模式拦截测试（日期/PHI）
13. 结构字段放行测试（反向）
14. 多场景表结构识别测试（横/纵/多层/不规则）
15. 业务开放性测试（layout / 自由 columns）
16. 状态隔离测试（多 session）

---

## 10. 关键决策记录（ADR）

| ADR | 决策 | 理由 |
|---|---|---|
| ADR-0004 | 删除 `archive_passwords.py` | 密码推导是 AI 推理活，程序不写死 |
| ADR-0005 | 删除 `_prepare_outputs` 强塞列 | 业务定义由 AI 从 spec 推理，不由程序决定 |
| ADR-0006 | `df.attrs["_layout"]` 取代 `STANDARD_SCENARIOS` | 排版由 AI 自由组合，scenario 不再分支 |
| ADR-0007 | `sanitize_receipt` 在 worker.py 出口统一拦截 | 单一拦截路径，字段黑名单 10 个 |
| ADR-0008 | `_sessions` dict 取代全局变量 | 多 session 隔离 |
| ADR-0009 | `inspect_doc/inspect_xlsx_sheet(rows=0)` 单向玻璃 | AI 能"读"但结果不回模型 |
| ADR-0010 | systemPrompt 只传达契约 | 不罗列 sheet 结构（避免业务定义泄漏到 system 层） |
| ADR-0011 | 删除 `unique_key_columns` 参数 | 死代码 + 业务定义泄漏 |
| ADR-0012 | 样式常量与排版决策解耦 | 颜色/字体保留为常量（输出标准），位置/导航交回 AI |

---

## 11. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| Phase 2 重构 writer 时回归现有 listing | 业务中断 | 保留 2 套 writer 并行（_v2 标记），测试通过后切换 |
| `_sessions` LRU 配置不当 | session 切换 O(N) | 加 `MAX_SESSIONS = 8`，超出 LRU 驱逐 |
| `sanitize_receipt` 误杀合法字段 | AI 推理失能 | 黑名单硬编码 10 个，可审查；其他字段一律放行 |
| 字段黑名单扩展（如未来 AI 输出 `preview`） | 漏拦截 | 命名约定审查 + e2e 测试覆盖 |

---

## 12. 与当前实现的对照

| 维度 | 当前 | 重构后 |
|---|---|---|
| 文件数 | 5 个 Python + 2 个 TS | 9 个 Python（分层）+ 2 个 TS |
| 数据红线拦截 | 无 | worker 出口统一 `_sanitize_receipt` |
| sandbox 原语 | 22 个 builtins | 22 + 程序读 Excel 结构原语 |
| 信息供给 | 仅元数据三件套 | 项目地形图（文件 / Excel 结构 / 数据集元数据 / 上版指纹） |
| Excel 排版 | `_build_listing` 写死 Row 1=HYPERLINK | `df.attrs["_layout"]` 自由组合 |
| Writer 分支 | `_prepare_outputs` 强塞列 | 零分支，按 layout 渲染 |
| 全局状态 | 3 个全局变量 | `_sessions` dict，LRU 隔离 |
| systemPrompt | 罗列 sheet 结构 | 只传达契约 |

---

## 13. 总结

**这不是补丁，是重构**。本次架构变更彻底重构 6 个层次：

1. **数据加载层**（discovery.py）—— 单纯结构返回，零值
2. **Sandbox 层**（sandbox.py）—— 安全执行 + 单向玻璃
3. **拦截层**（redact.py）—— 字段黑名单 + 模式扫描 + 长度截断
4. **Writer 层**（excel/）—— 纯原语库 + layout 自由组合
5. **调度层**（worker.py）—— 统一 `sanitize_receipt` 出口
6. **契约层**（index.ts）—— systemPrompt 只传达契约

**数据红线** 从「靠 system prompt + safe_builtins 软约束」升级为「worker 出口硬拦截」。
**业务开放** 从「`_prepare_outputs` 强塞列 + `STANDARD_SCENARIOS` 枚举」升级为「`df.attrs["_layout"]` 自由组合」。
**信息供给** 从「元数据三件套」升级为「项目地形图（含多场景 Excel 结构识别）」。

每个层级都有清晰职责、清晰边界、清晰 ADR。