# Emerald Clinical Listing — Excel 输出与 ZIP 密码规则技术文档

> 整理日期：2026-08-21
> 分析对象代码库：`G:\home\DM`（`src/emerald_clinical_listing/`）
> 范围：ZIP 密码获取规则、Excel 输出标准与样式、Contents 目录 sheet、sheet 命名/顺序/可见性、Go back 导航、整体输出调用链
> 注：文中行号基于 2026-08-21 时点的代码快照。

---

## 1. 总体原则

**LLM agent 不直接写 Excel。** LLM 只负责理解与编排，所有 Excel 物理落盘收敛到唯一确定性函数：

- 写入器：`core/writer.py::write_listing_excel()`（openpyxl，对齐 R openxlsx 模板）
- 写盘前门禁：`infra/validator.py::validate_listing_output()`
- 结构理解层：`core/profile.py::infer_project_profile()` + `core/output_spec.py` + `dataset/rules.py::infer_all_rules()`

默认 profile（见 DM 仓 `src/emerald_clinical_listing/DESIGN.md` L232-289）：

```
include_contents        = True
data_sheet_header_mode  = "go_back_single_header"
column_header_mode      = "label"
sheet_name_mode         = "form_name"
```

---

## 2. ZIP 密码获取规则

### 2.1 核心入口

`core/document_bundle.py::extract_dataset_archives()`（L655-1002）
策略：**构建候选密码列表，逐一试错，命中为止**。无任何硬编码密码。

### 2.2 候选密码来源（按加入顺序）

| # | 来源 | 位置 | 说明 |
|---|------|------|------|
| 1 | 用户显式传入 | `document_bundle.py` L729-730 | CLI `--dataset-password` / 工具参数 `dataset_password` |
| 2 | 密码侧记库（持久化） | `security/password_sidecar.py` | 按**申办方前缀**记住曾成功的密码，存于 `<repo>/var/known_dataset_passwords.json`（gitignore、原子写、不喂 LLM） |
| 3 | 项目名规则推导 | `document_bundle.py` L739-748 | 项目名本身 → 去非字母数字 → 渐进式前缀（`DS5565-0002-NIS` → `DS5565-0002` → `DS5565`） |
| 4 | sidecar txt 文件 | `document_bundle.py` L749-774 | 项目目录下 ≤256B 的小 `.txt`，**文件名（去扩展名）即密码**（如夹具 `A1234567.txt`）；单行 ≤128 字符的内容也作候选 |
| 5 | ZIP 文件名推导 | `document_bundle.py` L776-793 | 完整文件名、stem、按 `_ / - / . / 空格` 拆出的 token（≥2 字符）、`re.findall(r"\d{2,}")` 连续数字段 |
| 6 | 项目目录其他文件推导 | `document_bundle.py` L795-814 | DVP/ALS/说明文档文件名，同 token + 数字段规则 |
| 7 | 空密码兜底 | `document_bundle.py` L816 | — |

### 2.3 关键代码片段

```python
# document_bundle.py L739-748 —— 项目名推导
for project_id in [bundle.project_name, os.path.basename(bundle.project_dir)]:
    _add_password_candidate(password_candidates, project_id)
    _add_password_candidate(password_candidates, re.sub(r"[^A-Za-z0-9]", "", project_id))
    # 渐进式前缀
    parts = project_id.rsplit("-", 1)
    while len(parts) == 2 and parts[0]:
        prefix = parts[0]
        _add_password_candidate(password_candidates, prefix)
        parts = prefix.rsplit("-", 1)
```

```python
# password_sidecar.py L29-43 —— 申办方前缀
def sponsor_prefix(project_name: str) -> str:
    for sep in ("-", "_"):
        if sep in name:
            head = name.split(sep, 1)[0].strip()
            ...
```

### 2.4 试错与解压机制

- **快速路径**（L828-849）：检查 `flag_bits & 0x1`，整包未加密直接解压，不进候选循环。
- **加密路径**（L851-918）：先在 `tempfile.TemporaryDirectory(prefix="dm_zip_stage_")` 本地临时目录逐个候选试解压（避免每个错误候选付一次挂载盘写入代价 ~25s），完整成功才 `shutil.move` 到 `extracted_datasets/`。
- 异常处理：`RuntimeError / BadZipFile / zlib.error / EOFError` 均视为"密码错误，换下一个"（防 ZipCrypto 校验字节 1/256 假通过）。
- **AES 加密（WinZip-AES, compress_type=99）**：stdlib zipfile 读不了，走 `infra/zip_utils.py::extract_encrypted_zip_with_pyzipper()`（L83-114，pyzipper 库）：

```python
# zip_utils.py L100-113
pwd = password.encode() if password else None
with pyzipper.AESZipFile(zip_path) as zf:
    if pwd:
        zf.setpassword(pwd)
    for name in zf.namelist():
        if not name.lower().endswith((".sas7bdat", ".xpt")):
            continue
        ...
```

- **成功回填**：解压成功后回写 sidecar（`document_bundle.py` L921-926）。
- **全部失败**：按是否 AES、是否缺 pyzipper 分三种口径写 `bundle.extraction_warnings`（L963-1000），提示"密码须数据方提供，用 dataset_password 重跑"。
- **嵌套 ZIP**：支持 ZIP 内嵌 ZIP 递归解压（L928-933）。

### 2.5 安全加固（`infra/zip_utils.py`）

| 规则 | 位置 |
|------|------|
| zip-slip 路径校验 | L27-38 |
| 解压总大小上限 `AGENT_ZIP_MAX_TOTAL_BYTES`（默认 2GB） | — |
| 单文件上限 `AGENT_ZIP_MAX_FILE_BYTES`（默认 500MB，SAS/XPT 豁免） | — |
| magic 头真伪校验（`SAS7BDAT_MAGIC = 0xC2EA8160`、`XPT_MAGIC = "HEADER RECORD"`） | L128-152 |

### 2.6 密码参数传递链路

```
__main__.py --dataset-password
  ├─ dataset/pipeline.py          L128-141
  ├─ manual/executor.py           L126-142
  ├─ rbqm/executor.py             L244-252
  ├─ understanding/onboard.py     L73-108
  └─ llm/tools/registry.py        L171（LLM agent 工具参数 dataset_password）
```

---

## 3. Excel 输出标准与样式

### 3.1 唯一写入器

`core/writer.py::write_listing_excel()`（L18-238）
所有场景（dataset / report / manual / rbqm）最终都汇到此函数。

### 3.2 行结构

| `include_contents` | Row 1 | Row 2 | Row 3+ |
|---|---|---|---|
| True | "Go back" 超链接 | 表头 | 数据 |
| False | 表头 | 数据 | — |

`header_row = 2 if include_contents else 1`（L121）。

### 3.3 表头样式（L149-171，单行与双行统一）

```python
cell.font = Font(bold=True)
cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
cell.fill = openpyxl.styles.PatternFill(start_color="D9E1F2", end_color="D9E1F2", fill_type="solid")
```

### 3.4 数据 sheet 规则汇总

| 规则 | 值 / 逻辑 | 位置 |
|------|-----------|------|
| 双行表头模式 | `dual_sas_name_plus_label`：Row N = SAS 源列名（`source_headers`），Row N+1 = 显示 Label（`secondary_headers`） | L137-163 |
| 冻结窗格 | 冻结全部表头行 + 前 4 列：`ws.freeze_panes = f"E{data_start}"` | L212-214 |
| 自动筛选 | `ws.auto_filter.ref = f"A{header_row}:{last_col}..."` | L216-219 |
| 日期格式 | 按列检测 date/Timestamp 后批量设 `number_format = date_format_convention`（默认 `YYYY-MM-DD`，调用方透传，不硬编码） | L196-210 |
| 列宽自适应 | 采样前 200 行（`ML_AUTO_WIDTH_SAMPLE` 可调），`min(max_len + 3, 60)` | L253-280 |
| 原子写盘 | 先写 `.tmp.<pid>` 再 `os.replace`，防半截 workbook | L224-236 |
| 合并单元格 | **无** | — |
| sheet 可见性 | **无设置，全部恒可见** | — |

### 3.5 列结构/标签决策来源

- `core/output_spec.py`：`OutputColumn(source_column, display_label, output_order)`，display label 优先级（L62-80）：

```
ALS PreText  >  SAS attrs label  >  _RAW 后缀  >  列名本身
```

- `core/profile.py`：`ProjectProfile` 决定 `include_contents / data_sheet_header_mode / column_header_mode / sheet_name_mode`；有期望输出时从模板推断，无模板用默认 profile。

---

## 4. Contents（目录）sheet 输出规则

实现：`core/writer.py` L76-116。`include_contents=True` 时**第一个**创建名为 `"Contents"` 的 sheet。

### 4.1 8 列固定骨架（对齐 ADAV 标准模板，非项目硬编码）

```python
# writer.py L82-86
contents_headers = [
    "Listing Seq.", "Listing Name(Please Click Down)", "Data Set Label",
    "Report Description", "New/Modified ?",
    "Total Row Count", "New Count", "Modified Count",
]
```

### 4.2 样式与内容

| 项 | 规则 | 位置 |
|----|------|------|
| 表头样式 | 深蓝字 `Font(bold=True, color="FF111877")` + 浅蓝底 `PatternFill("FFEDF2F9", solid)` + 左对齐 | L87-94 |
| Listing Name | 带超链接 `f"#'{safe_name}'!A1"` 指向对应 sheet，蓝色下划线字体 | L98-111 |
| Data Set Label | 来自 `sheet_labels`；dataset 场景由 `dataset/pipeline.py::_sheet_labels_for_contents`（L400-412）从 ALS FormName 填充，缺省回退 sheet 名 | — |
| Total Row Count | `len(df)` | — |
| New/Modified、New Count、Modified Count | 固定为 None / 0 | — |
| 列宽 | 固定 `A~H = [10.5, 32, 28.5, 17, 14.5, 15, 10, 14]` | L113-115 |
| 冻结 | `B2` | L116 |

### 4.3 生成时机与开关

- **去重**：layout 中声明的同名 `contents` sheet 会被跳过，Contents 只由 writer 统一生成（`core/base_executor.py` L151-154）。
- **分片模式**：shard 阶段不写 Contents，merge 阶段才对完整 listing 生成（`base_executor.py` L355-356）。
- **开关来源**：`ProjectProfile.include_contents`（`core/profile.py` L35, L75-76）——即使期望输出里没有 Contents 也**始终补全**。
- **RBQM 例外**：`include_contents=False`（`rbqm/executor.py` L692, L718）。

---

## 5. 其他 sheet 显示规则（命名 / 顺序 / 可见性）

| 规则 | 逻辑 | 位置 |
|------|------|------|
| 命名来源 | dataset 场景 = 表单名/FormOID（`sheet_name_mode`：`form_name` 或 `listing_oid_nn`）；report/manual = layout.sheets 声明的 `name` | `core/profile.py` L317-320 |
| 合法性归一 | `_sanitize_sheet_name`：非法字符 `\ / * ? : [ ]` → `_`，截断 31 字符 | `core/writer.py` L241-247 |
| 撞名消歧 | base_executor 按 `_R<dvp_row>` / `_2` / `_N` 后缀确定性改名并记 warning | `core/base_executor.py` L172-190 |
| 撞名兜底 | writer 内部撞名直接 `raise ValueError`，**绝不让 openpyxl 静默自动改名**（否则 Contents 超链接全指向同一张表） | `core/writer.py` L57-70 |
| 顺序 | Contents 第一（若启用）→ 数据 sheet 严格按 `listing_dict` 插入顺序（layout.sheets 声明顺序或 FormOID 目标顺序）；分片 merge "先写不被后写覆盖"，保住首次出现顺序 | `base_executor.py` L499-501 |
| 可见性 | 无任何 `sheet_state` / hidden 设置，所有 sheet 恒可见 | — |
| 结构校验 | 写盘前 `validate_listing_output` 校验列序、敏感列、declared vs 产出差集，失败即 raise，不产残缺 Excel | `infra/validator.py` L61 |

---

## 6. "Go back" 规则

**性质**：Excel 内返回目录的超链接，非流程回退逻辑。

### 6.1 写侧（`core/writer.py` L128-133）

```python
# Row 1: Go back hyperlink —— 样式对齐标准模板（超链接色 + 下划线）
cell_a1 = ws.cell(row=1, column=1, value="Go back")
cell_a1.hyperlink = f"#'Contents'!A1"
cell_a1.font = Font(color="0000FF", underline="single")
ws.row_dimensions[1].height = 15
```

- 仅当 `include_contents=True` 时写。
- 每个数据 sheet 的 A1 都是指向 `Contents!A1` 的 "Go back" 超链接，与 Contents 行的 `Listing Name` 超链接互为**往返导航**。

### 6.2 读侧 / 模板推断侧

| 用途 | 逻辑 | 位置 |
|------|------|------|
| 表头模式判定 | 首单元格归一化后等于 `"goback"` → 判定为 `go_back_single_header` 表头模式 | `core/profile.py` L274-277 |
| 模板学习 | 学习既有 listing 模板时，Row0="Go back" 意味着列名在 Row1（`header_row_idx = 1`） | `dataset/rules.py` L180-295 |
| 基线读取 | 读上一轮产出作基线时跳过 writer 写入的 "Go back" 导航行来定位表头 | `core/prior_listing_io.py` L51 |

---

## 7. 整体输出调用链

### 7.1 通用骨架（report / manual 场景）

```
LLM agent 工具（llm/tools/pipeline_ops.py, registry.py）
  → server/orchestrator/core.py（编排，透传 dataset_password 等）
  → report/executor.py  ReportListingExecutor.run   (L467-480)
    或 manual/executor.py ManualListingExecutor.run (L266-276)
  → core/base_executor.py run_layout_listing() (L83)
      - 按 layout.sheets 逐 sheet produce（produce_sheet_or_raise）
      - 撞名消歧 → validate_listing_output 校验
  → core/writer.py write_listing_excel() (L244)   ← 唯一写 Excel 点
```

分片路径：

```
run_layout_listing_shard()（产 pickle + sidecar）
  → merge_listing_shards()（覆盖断言 + 校验）
  → write_listing_excel（base_executor.py L545）
```

### 7.2 dataset（medical listing）场景

```
MedicalListingPipeline.from_project_documents (dataset/pipeline.py L120)
  → discover_project_bundle + extract_dataset_archives（含密码候选试错）
  → pipeline.run() → _build_listing()（按 FormOID 顺序产各 sheet DataFrame）
  → validate_listing_output
  → write_listing_excel(listing, ...,
      include_contents=profile.include_contents,
      column_header_mode / source_headers / secondary_headers / sheet_labels
      均来自 ProjectProfile + ALS)                    (pipeline.py L383-390；merge 路径 L519-526)
```

### 7.3 RBQM 场景

```
rbqm/executor.py _write_excels_per_kri() (L652-725)
  → 每条已计算 KRI 一个 Excel（Summary + Detail + 最终数据 sheet），
    待澄清 KRI 合并一份 RBQM_待澄清汇总.xlsx
  → write_listing_excel(..., include_contents=False)   (L692, L718)
```

### 7.4 角色分工总结

| 组件 | 职责 |
|------|------|
| `core/writer.py::write_listing_excel` | **唯一** Excel 物理写入器（样式 / Contents / Go back / 冻结 / 筛选 / 列宽 / 原子写） |
| `core/base_executor.py::run_layout_listing / merge_listing_shards` | report/manual 共享骨架（顺序、消歧、校验） |
| `dataset/pipeline.py::MedicalListingPipeline` | dataset 场景 listing 构建与 writer 调用 |
| `rbqm/executor.py::_write_excels_per_kri` | RBQM 场景每 KRI 一簿的输出组织 |
| `core/profile.py::infer_project_profile` + `core/output_spec.py` + `dataset/rules.py::infer_all_rules` | "理解层"：决定 sheet 结构 / 表头模式 / 列标签 |
| `infra/validator.py::validate_listing_output` | 写盘前结构门禁 |
| `llm/tools/*`、`server/orchestrator/*` | 只负责调用 onboard/pipeline 工具并透传参数（如 `dataset_password`），**不直接操作 Excel** |

---

## 8. 关键文件速查表

所有路径相对于 `G:\home\DM\src\emerald_clinical_listing\`：

| 文件 | 关键内容 |
|------|----------|
| `core/document_bundle.py` | ZIP 解压与密码候选试错（L655-1002） |
| `security/password_sidecar.py` | 密码侧记库（申办方前缀记忆） |
| `infra/zip_utils.py` | AES 解压（pyzipper）、zip-slip 防护、magic 校验 |
| `core/writer.py` | `write_listing_excel`（唯一写入器）、Contents、Go back、sheet 名归一 |
| `core/output_spec.py` | 列结构与 display label 优先级 |
| `core/profile.py` | ProjectProfile、表头模式推断（含 goback 检测） |
| `core/base_executor.py` | report/manual 骨架、撞名消歧、分片 merge |
| `dataset/pipeline.py` | dataset 场景 listing 构建、sheet labels |
| `dataset/rules.py` | 既有模板学习（Go back → header_row_idx） |
| `core/prior_listing_io.py` | 读基线时跳过 Go back 导航行 |
| `rbqm/executor.py` | RBQM 输出（无 Contents） |
| `infra/validator.py` | `validate_listing_output` 写盘前门禁 |
