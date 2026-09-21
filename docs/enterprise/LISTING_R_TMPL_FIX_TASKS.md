# r-templates/manual_listing.R.tmpl V2 修复任务书（新会话直接照做）

- 日期：2026-09-07
- 对象：`packages/enterprise/listing/r-templates/manual_listing.R.tmpl`（r_manual 车道模板）
- 依据：HXN6005-A1-201 真实数据验证版
  `D:\project\company\epro\Project\HXN6005\manual_listing\programs\HXN6005_Manual_Listing_V2.R`
  （83 listing / 17,762 行已验证）+ 会话中踩坑修复 20 项
- 需求口径：每行 DVP 以 **Column Heading (For internal use)** 为输出需求，
  **Condition** 为过滤/派生规则，**Visits Applied To / Related Fields** 为范围，
  **Report Description / Discrepancy Text** 是 DM 自查逻辑，不进程序。

## 现状对照（本次核对结论）

| 能力 | tmpl 现状 |
|---|---|
| locale 容错（dir_ok/any_kw/sep_norm fixed） | ✅ 已有 |
| grp_flag enquo、.inv/ACT、SYS_DROP、活动表预过滤 !.inv | ✅ 已有 |
| go back 链接、去 Manual_ 前缀、输出目录写测试、summary.json 基建 | ✅ 已有 |
| **zip 密码自动推导候选链** | ❌ 缺（仅单 password，见修复 F1） |
| **formats.sas7bcat 挂载确证编码** | ❌ 缺（read_sas 未带 catalog_file，见修复 F2；R8 仍是假设） |
| **expand_ref/expand_ae/qs_agg/finish_fields 公共件** | ❌ 缺（见修复 F3；新项目按 ColumnHeading 组装必需） |
| 候选解压成功判定（解压出 sas7bdat>0） | ❌ 缺（并入 F1） |

宿主侧（src/r-runner.ts、enterprise_listing_run_r、summary.json 基建）已就位，本次无需改动。

---

## F1 密码自动推导（替换 zip_extract 的密码用法）

在 `zip_extract <- function(zipfile, exdir) {` 之前插入（对齐插件
`python/archive_passwords.py::password_candidates` 候选顺序）：

```r
## ---- 归档密码自动推导（顺序对齐 archive_passwords.py）----
split_tokens <- function(v) {
  t <- trimws(unlist(strsplit(v, "[_/.\\\\s-]+")))
  t[nzchar(t)]
}
token_pw <- function(v) {
  toks <- split_tokens(v)
  out <- unique(c(v, tools::file_path_sans_ext(v), toks[nchar(toks) >= 2]))
  if (length(toks) >= 2) {
    combo <- character(0)
    for (s in seq_along(toks)) for (e in seq(s + 1, length(toks)))
      combo <- c(combo, paste(toks[s:e], collapse = c("", "_", "-")))
    out <- c(out, unique(combo[nchar(combo) >= 2]))
  }
  c(out, regmatches(v, gregexpr("[0-9]{2,}", v))[[1]])
}
password_candidates <- function(project_dir, data_dir) {
  cand <- character(0)
  add <- function(v) if (!is.na(v) && nzchar(v) && !v %in% cand) cand <<- c(cand, v)
  add(password)                                              # 1 显式（可空）
  for (v in token_pw(basename(project_dir))) add(v)          # 2 项目目录名及其分词组合
  for (f in list.files(data_dir, pattern = "\\\\.txt$", full.names = TRUE))   # 3 sidecar txt（逐行）
    for (v in trimws(readLines(f, warn = FALSE))) add(v)
  for (z in list.files(data_dir, pattern = "\\\\.zip$"))     # 4 zip 文件名及其分词
    for (v in token_pw(z)) add(v)
  for (f in list.files(project_dir, pattern = "\\\\.(txt|xlsx|xls)$",
                      recursive = TRUE, full.names = TRUE))  # 5 项目内文档文件名 stem
    add(tools::file_path_sans_ext(basename(f)))
  add("")                                                    # 6 无密码兜底
  cand
}
```

`zip_extract` 内的解压调用改为**逐候选尝试**，成功判定 =
返回码 0 **且** 解压出 `.sas7bdat` 数 > 0（防 ZipCrypto 误通过）：

```r
zip_extract <- function(zipfile, exdir) {
  dir.create(exdir, showWarnings = FALSE, recursive = TRUE)
  cands <- password_candidates(project_dir = dirname(exdir), data_dir = exdir)
  for (pw in cands) {
    if (.Platform$OS.type == "unix") {
      pwa <- if (nzchar(pw)) sprintf("-P %s", shQuote(pw)) else ""
      st <- system(sprintf("unzip -o %s %s -d %s", shQuote(zipfile), pwa, shQuote(exdir)))
      if (st == 0 && length(list.files(exdir, pattern = "\\.sas7bdat$",
                                       recursive = TRUE)) > 0) return(invisible())
      next
    } else if (nzchar(pw)) {
      next   # Windows 无系统 unzip：加密包只在服务器跑
    }
    break  # 空密码候选交给下方 R 内置 unzip 兜底
  }
  warning("密码候选均未解压成功，改用 R 内置 unzip 兜底：", zipfile)
  lst <- tryCatch(unzip(zipfile, list = TRUE), error = function(e) NULL)
  if (!is.null(lst) && !is.null(lst$Name))
    for (dd in unique(dirname(lst$Name))) {
      dd2 <- file.path(exdir, dd)
      if (dd2 != exdir) dir.create(dd2, showWarnings = FALSE, recursive = TRUE)
    }
  unzip(zipfile, exdir = exdir)
}
```

注意：候选数/密码明文不得写日志（只输出尝试次数）。

## F2 formats.sas7bcat 挂载（确证编码，解除 R8 假设）

`read_sas_folder` 内读数循环改为（存在目录则挂载；catalog 比 FORMATS 数据集
完整——HXN6005 实测含 LBCLSIG/LBCLSIG1/VSCLSIG/EGCLSIG 等全部编码）：

```r
    catf <- list.files(".", pattern = "\\.sas7bcat$", recursive = TRUE, full.names = TRUE)
    datasets <- lapply(all_files, function(x) {
      if (length(catf)) haven::read_sas(x, catalog_file = catf) else haven::read_sas(x)
    })
```

挂载后编码变量带 value labels，`CLS/dec` 行为不变但来源确证。同时把文件头
`[REPLACE R8]` 假设告警改为确证说明：

```r
## 编码口径已经 EDC 格式目录(sas7bcat)确证：LBCLSIG/LBCLSIG1/VSCLSIG/EGCLSIG
## = 1正常 2异常无临床意义 3异常有临床意义（VS 系列另有 4=未查）
```
并删除原 `note("LBPG/LBPGU 的检查结果 ... [REPLACE R8]")` 行。

> 实测数据（HXN6005 catalog）：LB.LBCLSIG 值域 1-4；LBPG/LBPGU.LBCLSIG1 值域
> 1-3；VS.VSCLSIG1 值域 1-4；EG.EGCLSIG 值域 1-3——与上述编码一致。

## F3 回填公共件（新项目 ColumnHeading 组装必需）

在 helper 区（`sep_norm` 之后）加入验证过的四个公共件（代码从
`HXN6005_Manual_Listing_V2.R` 原样搬运，全文见该文件）：

1. `expand_ref(df, mh_col="MHNO", ae_col="AENO")` —— 多选编号按"；"拆分，
   一行一条回连病史/AE，追加 匹配类型/编号/名称/起止日期 五列；
2. `expand_ae(df, ae_col)` —— 仅 AE 编号列的展开版；
3. `qs_agg(nm)` —— 记录级量表取 `group_by(SID,RECORDID) %>% slice(1) %>% add_ctx()`；
4. `finish_fields(df)` —— 字段清单型 listing 收尾（状态 + VISIT 展示 +
   前导列 select，等价 lead_cols 但保留 ColumnHeading 的字段筛选）。

并在活动表区补 `DS2_A <- ACT("DS2","ds2")`（V2 曾因缺它报 object not found）。

## 验收（改完后必做）

1. `parse()` 语法通过；HXN6005 渲染跑通 83 listing（行数与已验证 17,762 一致量级）；
2. 无密码 zip：自动推导链第 6 级（空密码）可解压；
3. 有 sidecar `<zip名>.txt`：不填 password 也能解压；
4. LBPG/LBPGU 页的 LBCLSIG1 解码值与 sas7bcat 标签一致（正常/异常NCS/异常CS）；
5. 空 listing 页有"无数据记录"占位行；所有 sheet 无 `.inv/PERF/CSNc/...` 内部列；
6. summary.json 正常产出（run_warnings 含上述 warning 时如实带出）。
