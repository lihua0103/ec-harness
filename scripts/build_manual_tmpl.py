# -*- coding: utf-8 -*-
# dsh manual 模板重建（2026-09-19）：契约层 = manual-listing-r skill 骨架（与已交付 V2 逐行同源）
# 业务区 = 已交付 V2 业务段逐字（context/listings/titles 三区），模板零业务值。
# 产物：r-templates/manual_listing.R.tmpl（零业务+DSH-BUSINESS-ZONE fail-fast）
#       dsh-standard-verify/_calibration/HXN6005_ai_zones.R（eval 校准基准）
# 运行环境集成段（cfg/DSH_R_*/运行摘要）为字面内置（与 r-runner.ts 契约对齐）。
import io, re, sys

SKILL_COMMON = r'C:\Users\ding_jinghua\.agents\skills\manual-listing-r\assets\skeleton_common.R'
SKILL_OUTPUT = r'C:\Users\ding_jinghua\.agents\skills\manual-listing-r\assets\skeleton_output.R'
V2           = r'D:\project\company\epro\Project\HXN6005\manual_listing\programs\HXN6005_Manual_Listing_V2.R'
TMPL         = r'D:\project\company\epro\AI-DM-Agent\ec-harness\packages\enterprise\listing\r-templates\manual_listing.R.tmpl'
AZ           = r'D:\project\company\epro\Project\dsh-standard-verify\_calibration\HXN6005_ai_zones.R'

sc = io.open(SKILL_COMMON, encoding='utf-8').read().split('\n')
so = io.open(SKILL_OUTPUT, encoding='utf-8').read().split('\n')
v2 = io.open(V2, encoding='utf-8').read().split('\n')
print('skeleton_common=%d skeleton_output=%d v2=%d' % (len(sc), len(so), len(v2)))

def find(lines, pat, start=0):
    hits = [i for i in range(start, len(lines)) if pat in lines[i]]
    if len(hits) != 1:
        print('ANCHOR FAIL:', repr(pat), hits); sys.exit(1)
    return hits[0]

def strip_blanks(ls):
    while ls and not ls[-1].strip(): ls.pop()
    while ls and not ls[0].strip(): ls.pop(0)
    return ls

# ---- skeleton 分节锚 ----
i_sasdir    = find(sc, 'SAS_DIR     <- ""')
i_enc_cmt   = find(sc, '## 编码解码依据：优先 EDC 系统导出的二进制格式目录')
i_ctx_start = find(sc, '## ---- 受试者上下文（公共，一次派生） ----')
i_pt_start  = find(sc, '## ---- 医学编码结果（PT 术语）装载与查询 ----')
i_drug_start= find(sc, '## ---- 用药编码结果（WHODrug Product_Name）装载与查询 ----')
i_ref_start = find(sc, '## ---- 常用参照表（公共） ----')
i_cs_start  = find(sc, '## CS 判定（"检查结果为CS"')
i_cat       = find(sc, 'cat("common ready:')
assert i_sasdir < i_enc_cmt < i_ctx_start < i_pt_start < i_drug_start < i_ref_start < i_cs_start < i_cat
ctx1 = strip_blanks(sc[i_ctx_start:i_pt_start])      # A_* 活动表 + CTX + add_ctx + CTX_DROP
ctx2 = strip_blanks(sc[i_ref_start:i_cs_start])      # AE_REF/MH_REF/yn0/PT_DUP
funcs = sc[i_cs_start:i_cat]                          # cs_flag/vs_any_cs/expand_ref/expand_ref_vs/expand_ae/finish_fields
common_ready = sc[i_cat]

# ---- V2 rows 段锚 ----
i_v2cat = find(v2, 'cat("common ready:')
i_v2out = find(v2, '## 输出样式：对齐 dsh listing 插件')
i_v2ttl = find(v2, 'LISTING_TITLES <- c(')
t = i_v2ttl - 1
while t > 0 and v2[t].strip().startswith('##'): t -= 1
i_v2ttl_blk = t + 1
rows = strip_blanks(v2[i_v2cat+1:i_v2ttl_blk])
titles = strip_blanks(v2[i_v2ttl_blk:i_v2out])
print('rows=v2 %d..%d titles=v2 %d..%d' % (i_v2cat+2, i_v2ttl_blk, i_v2ttl_blk+1, i_v2out))
assert 'outlisting$' in '\n'.join(rows)
assert 'LISTING_TITLES <- c(' in '\n'.join(titles)

# ---- runner 集成段（字面内置；与 r-runner.ts 渲染值/DSH_R_* 运行时覆盖契约一致）----
RUNNER_CFG = '''rm(list = ls()); gc()
## 运行环境容错：宿主 shell 若带 LC_CTYPE=C.UTF-8 之类 Windows 无效值，R 会落到
## CP936 原生编码、解析中文标识符（如 ALS_ECRF$表）报 invalid token；显式拉回 UTF-8。
## Linux 服务器上此 locale 名无效会报错，tryCatch 吞掉即可（服务器本就 UTF-8）。
tryCatch(Sys.setlocale("LC_CTYPE", "Chinese (Simplified)_China.utf8"), error = function(e) NULL)
options(warn = 1)
## 宿主运行时经环境变量覆盖文件头渲染值（DSH_R_*）；独立在服务器运行时环境变量为空，使用渲染值
cfg <- function(env, default) { v <- Sys.getenv(env, unset = ""); if (nzchar(v)) v else default }
summary_path <- cfg("DSH_R_SUMMARY_PATH", "{{SUMMARY_PATH}}")  # 运行摘要 json（宿主聚合回执用；空=写到交付目录）
## 失败也写运行摘要：宿主 enterprise_listing_run_r 据此回执精确的 stop 信息
options(error = function() {
  if (exists("summary_path") && nzchar(summary_path)) tryCatch({
    esc <- function(x) { x <- gsub("\\\\", "\\\\\\\\", x, fixed = TRUE); x <- gsub("\\"", "\\\\\\"", x, fixed = TRUE)
                         gsub("\\n", "\\\\n", gsub("\\r", "", x, fixed = TRUE), fixed = TRUE) }
    writeLines(enc2utf8(sprintf('{"status":"error","message":"%s"}', esc(geterrmessage()))),
               summary_path, useBytes = TRUE)
  }, error = function(e) NULL)
  if (!interactive()) quit(status = 1)
})

## 优先 tidyverse（TAISHAN 模板写法）；未装元包时回退单包，逻辑等价
if (requireNamespace("tidyverse", quietly = TRUE)) {
  library(tidyverse)
} else {
  library(dplyr); library(tidyr); library(purrr); library(stringr)
}
library(haven)
library(tools)
library(openxlsx)

## ------------------------------------------------------------------ ##
## [REPLACE R1] 运行环境配置（宿主渲染段：以下值来自用户输入 / 部署配置）
## 目录契约（固定格式，只有项目根可变）：
##   <root>/Project_Data/01_Raw_sas/Manual Listing/<foldername>/   数据 zip + RData 缓存
##   <root>/SAS_Program/SAS_program/Manual Listing/                 本 R 程序
##   <root>/Output/04_Out/Manual listing/                           唯一交付目录
dir_ok  <- function(p) tryCatch(isTRUE(dir.exists(p)), error = function(e) FALSE)  # locale 容错
dirs_of <- function(p) tryCatch(list.dirs(p, recursive = FALSE), error = function(e) character(0))
root         <- cfg("DSH_R_PROJECT_ROOT",  "{{PROJECT_ROOT}}")   # 项目根目录（宿主已校验存在）
study_key    <- cfg("DSH_R_STUDY_KEY",     "{{STUDY_KEY}}")      # 项目关键字（目录名含中文/编码异常时按此关键字兜底匹配）
foldername   <- cfg("DSH_R_DATA_DATE",     "{{DATA_DATE}}")      # 数据投递日期（zip 所在文件夹名）
old_folder   <- cfg("DSH_R_OLD_DATE",      "{{OLD_DATE}}")       # 旧版数据日期（新旧比对用，可空）
password     <- cfg("DSH_R_ZIP_PASSWORD",  "{{ZIP_PASSWORD}}")   # 数据 zip 密码（宿主经环境变量传入不落盘；独立运行时在此填写）
out_prefix   <- cfg("DSH_R_OUTPUT_PREFIX", "{{OUTPUT_PREFIX}}")  # 交付文件名前缀，如 "<studyKey>_Manual Listing"
out_file <- function(ext, tag = "") paste0(out_prefix, "_", foldername, tag, ".", ext)  # 交付文件名
zip_clear    <- TRUE                                             # 读完是否删除解压出的 sas7bdat
if (!dir_ok(root) && nzchar(study_key)) {
  cands <- dirs_of(dirname(root))
  cands <- cands[grepl(study_key, cands, fixed = TRUE)]
  if (length(cands)) root <- cands[1]
}
if (!dir_ok(root)) stop("项目根目录不存在：", root, "\\n请检查配置段 [REPLACE R1]")
folder_path <- file.path(root, "Project_Data/01_Raw_sas/Manual Listing")
out_path    <- file.path(root, "Output/04_Out/Manual listing")
## 输出/缓存统一在 Output（唯一输出位置；不可写直接报错，不乱落盘）
dir.create(out_path, showWarnings = FALSE, recursive = TRUE)
work_root <- out_path
tf <- file.path(work_root, ".writetest")
r <- tryCatch(file.create(tf, showWarnings = FALSE), error = function(e) FALSE)
if (!isTRUE(r)) stop("输出目录不可写，请检查权限：", work_root)
unlink(tf)
if (!nzchar(summary_path)) summary_path <- file.path(work_root, paste0(".summary_", foldername, ".json"))
outlisting  <- list()
run_warnings <- character(0)              # 运行期告警（写入 summary.json 供宿主回执）
note <- function(...) { m <- paste0(...); run_warnings <<- c(run_warnings, m); message("NOTE: ", m) }
SAS_DIR     <- ""        # sas 数据集所在目录（read_sas_folder 运行时记录；编码结果同目录放置）
'''

SUMMARY_GRAFT = '''json_str <- function(x) {
  x <- gsub("\\\\", "\\\\\\\\", x, fixed = TRUE); x <- gsub("\\"", "\\\\\\"", x, fixed = TRUE)
  x <- gsub("\\r", "", x, fixed = TRUE); x <- gsub("\\n", "\\\\n", x, fixed = TRUE)
  x <- gsub("\\t", "\\\\t", x, fixed = TRUE)
  paste0("\\"", x, "\\"")
}
json_arr <- function(items) paste0("[", paste(items, collapse = ","), "]")
flag_count <- function(d) {
  fc <- grep("^flag", names(d), value = TRUE)
  if (!length(fc)) return(0L)
  sum(vapply(fc, function(cc) sum(!is.na(d[[cc]]) & nzchar(as.character(d[[cc]]))), numeric(1)))
}
list_items <- vapply(names(outlisting), function(nm) {
  d <- outlisting[[nm]]
  sprintf('{"name":%s,"sheet":%s,"rowCount":%d,"flagCount":%d}',
          json_str(nm), json_str(sub("^Manual_", "", nm)), nrow(d), as.integer(flag_count(d)))
}, character(1))
summary_json <- paste0(
  "{",
  '"status":"ok",',
  '"studyKey":', json_str(study_key), ",",
  '"dataDate":', json_str(foldername), ",",
  '"oldDate":', json_str(old_folder), ",",
  '"listingCount":', length(outlisting), ",",
  '"rowCount":', sum(vapply(outlisting, nrow, numeric(1))), ",",
  '"flagCount":', sum(vapply(outlisting, flag_count, numeric(1))), ",",
  '"sheetCount":', length(chk), ",",
  '"outputs":', json_arr(c(json_str(out_file("xlsx")), json_str(out_file("RDS")))), ",",
  '"warnings":', json_arr(vapply(run_warnings, json_str, character(1))), ",",
  '"listings":', json_arr(list_items),
  "}")
writeLines(enc2utf8(summary_json), summary_path, useBytes = TRUE)

cat("done:", length(outlisting), "listings ->", work_root, "\\n")
'''

header = '''# =====================================================================
# {{STUDY_KEY}} Manual Listing（DVP Manual Review sheet，需求行驱动）
# 风格对齐 TAISHAN-304 模板：outlisting + <数据集>_<序号>（去 Manual_ 前缀）+ attr 标签
#
# ★ 本模板零业务逻辑（2026-09-17 用户定案）：业务逻辑一律由 harness AI 识别本项目
#   DVP spec/ALS/EDC 结构后生成，写入下方 DSH-BUSINESS-ZONE 生成区；模板只含
#   harness 契约层（读数缓存/密码推导/ALS 装载/解码/范围-行-列原语/PT+WHODrug 编码
#   装载/输出样式/运行摘要），与已交付程序同源（manual-listing-r skill 骨架）。
#   未生成业务区即运行 → fail-fast 出路：先按生成区契约逐区生成，再 render=false 运行。
#
# 生成区契约（AI 逐区对照 DVP+数据实证后填写；口径/门禁详见 enterprise_listing_kb(manual)）：
#   B1 context —— 受试者上下文与项目参照表：A_* 活动表（IC/DS/DS1/DS3/DS4/EC/SV/
#     AE/MH/CM/PR/IE/DS2/LB…按本项目 EDC 表集实证增删）、CTX 跨表上下文列表
#     （列集=本项目 DVP Column Heading 的【表单】上下文列，聚合规则按列语义定并
#     留痕；给药访视关键词按本项目方案实证，禁写死 OID）、add_ctx/CTX_DROP、
#     AE_REF/MH_REF/PT_DUP（PT 判重类 listing 参照）。项目无上下文列时生成仅
#     SID 的最小 CTX（add_ctx/CTX_DROP 依赖保持可用）。
#   B2 listings —— outlisting 装配（漏行=失败）：DVP Manual Review 每一需求行一节，
#     节注释=row号|listing名|Visits|Related Fields|Condition|Column Heading 映射，
#     outlisting$Manual_<数据集>_<序号> <- … 按 DVP 行序装配（RDS 对象名保留
#     Manual_ 前缀供新旧比对；sheet/Content/B1 显示层由输出段自动去前缀；
#     换数据源必须同步改名）。四列口径：Visits×Fields 定范围（访视过滤/字段
#     清单）、Condition 定行（Output if/flag=duplicated）、Column Heading 定列
#     （Raw data 原样红线 + 上下文列 + 派生列 + 匹配拆行）；访视规则 V1-V4、
#     实验室口径 L1-L3 见下。
#   RDS 工件形态惯例（新旧比对 compare_data 依赖 RDS 列名形态，必须逐条遵守）：
#     R1 outlisting 键名带 Manual_ 前缀（SUBJECT_01 型"参与者信息"类无前缀者除外）；
#     R2 transmute 型字段清单 listing（fields 收窄类）的 RDS 列名=中文显示名
#        （疾病名称/开始日期/是否持续…），与 xlsx 表头同词；RDS 内列名即
#        交付面显示名，attr label 同值或缺失均可；
#     R3 CTX 上下文列在 listing 内重命名为中文（试验阶段/给药日期PartA_D1/
#        治疗结束日期/知情同意签署日期…），与 xlsx 表头同词；
#     R4 .d 派生日期列（LBDATEd/VISDATd/DSENDATd…）与 CRFVER/CRFSTS 保留在
#        RDS（写盘层才裁，xlsx 不受影响）；
#     R5 缺失表示逐列按构造路径：join 产生的缺失=NA，显式 dts()/if_else 产生
#        的=""；自检代码必须把 NA 与 "" 视为不同值（禁止规范化后再比）。
#   B3 titles —— 显示词表：LISTING_TITLES（sheet 名 -> Content/B1 中文表名，词表=
#     ALS 官方词汇/DVP Form Name，零自造；同名去重由输出段自动追加 sheet 名后缀）
#     及其余显示层修正（须与 als_arrange/.als_applied 标记协同，防二次重排甩尾）。
#
# 需求口径（DVP Manual Review sheet 各列的职责）：
#   Visits Applied To × Related Fields  -> 范围（ALL / All items 即全量，其余按访视/字段过滤）
#   Condition ( For internal use)      -> 行（Output if 筛选；flag=duplicated 重复标记）
#   Column Heading ( For internal use) -> 列（Raw data + 上下文列【表单】+ 派生列 + 匹配病史/AE/CM/PR 拆行）
#   Report Description / Discrepancy Text Message 为 DM 人工核查内容，程序不实现、不产出核查 flag
#
# 访视处理规则（同 EDC 系统通用，实战固化）：
#   V1  Visits Applied To 非 ALL 的每一行都必须落访视范围过滤（漏挂 = 全表数据混入）；
#       ALL 则不调用。
#   V2  Form Name / Visits Applied To 可能同时限定多个表单（"既往/伴随病史 + 不良事件"
#       类）：每个表单各自走自己的访视范围，再合并或分 listing。
#   V3  计划外访视：VISITOID=99 是系统级不变量；访视名带实例后缀，必须关键词匹配
#       并挂 oid="99" 兜底（$VISITNAME 解码失效时回退 "访视99"，纯关键词会 0 行）。
#   V4  按访视名派生（采样/给药日期聚合）一律用关键词包含匹配，覆盖多套同概念 OID；
#       禁止写死 VISITOID 数值，必要时对照 SV 实证并标 [CONFIRM]。零命中必须
#       note() 进运行摘要——收到零命中告警必须先核对访视关键词再交付。
#
# 实验室检查 listing 口径（L1-L3，同 EDC 系统通用；DM 书面口径优先并在行注释标日期）：
#   L1  实验室检查类多项目模块：解码长表原样输出——每个检查项目一行、不加匹配列、
#       不拆编号（spec Condition 的"CS 时匹配拆行"条款对该类表被 DM 口径取代时，
#       以 DM 书面确认为准）。
#   L2  打包编号单元格原文保留在格内；记录级字段随行重复（"前面数据要补齐"）。
#   L3  边界：只覆盖实验室多项目模块表；妊娠等单项目检查表与其他表单仍按 spec
#       CS 匹配 + 编号拆行（expand_ref/cs_flag）。
#
# 本文件由 @dsh-enterprise/listing 的 r_manual 车道按模板
# r-templates/manual_listing.R.tmpl 渲染生成：双花括号占位符已由宿主填入用户输入
# （项目根 / 数据日期 / 旧版日期 / zip 密码 / 交付前缀），可直接 Rscript 运行；
# 也可脱离插件在服务器上独立执行（只依赖文件头配置段）。
#
# ## [REPLACE] 待确认/替换清单（运行前逐项过一遍）：
#   R1  运行环境配置（项目根/数据日期/旧版日期/密码由宿主渲染，通常无需手改）
#   R10 输出段：有旧版时接入公司 compare_data 新旧比对（输出段 [REPLACE R10] 注释处）
#   R11 PT 术语/WHODrug：编码结果随数据包投递时自动装载；未投递时 PT术语/Product_Name
#       列为空（不回退原值，避免混淆已编码/未编码）
# ====================================================================='''

# ---- 组装新模板 ----
out = []
out.append(header)
out.append(RUNNER_CFG)
out.append('## 编码口径已经 EDC 格式目录(sas7bcat)确证：LBCLSIG/LBCLSIG1/VSCLSIG/EGCLSIG')
out.append('## = 1正常 2异常无临床意义 3异常有临床意义（VS 系列另有 4=未查）')
out.append('')
out.extend(sc[i_enc_cmt:i_ctx_start])             # 读数/密码/ALS/解码/工具/失活/状态（契约）
out.extend(sc[i_pt_start:i_drug_start])           # PT 装载（契约）
out.extend(sc[i_drug_start:i_ref_start])          # WHODrug 装载（契约）
out.append('# >>> DSH-BUSINESS-ZONE:context <<< harness AI 业务生成区（B1：受试者上下文与项目参照表，模板零业务值）')
out.append('stop("业务生成区 [context] 未生成：本模板不含业务逻辑——由 harness AI 识别本项目 DVP/ALS/EDC 后",')
out.append('     "按文件头生成区契约（B1-B3 与场景库 manual 口径终案表）生成 context/listings/titles 三区，再以 render=false 运行")')
out.append('# <<< DSH-BUSINESS-ZONE:context >>>')
out.extend(funcs)                                  # CS 判定/展开原语（契约）
out.append(common_ready)
out.append('')
out.append('# >>> DSH-BUSINESS-ZONE:listings <<< harness AI 业务生成区（B2：DVP 逐行 outlisting 装配，模板零业务值）')
out.append('stop("业务生成区 [listings] 未生成：DVP 每一需求行一节装配 outlisting——按文件头生成区契约 B2 生成后重跑")')
out.append('# <<< DSH-BUSINESS-ZONE:listings >>>')
out.append('')
out.append('# >>> DSH-BUSINESS-ZONE:titles <<< harness AI 业务生成区（B3：LISTING_TITLES 显示词表，模板零业务值）')
out.append('stop("业务生成区 [titles] 未生成：LISTING_TITLES=ALS 官方词汇——按文件头生成区契约 B3 生成后重跑")')
out.append('# <<< DSH-BUSINESS-ZONE:titles >>>')
out.append('')
so2 = []
for l in so:
    l = l.replace('saveRDS(outlisting, file = paste0("{{OUTPUT_STEM}}_Manual Listing_", foldername, ".RDS"))',
                  'saveRDS(outlisting, file = out_file("RDS"))')
    l = l.replace('saveWorkbook(wb, paste0("{{OUTPUT_STEM}}_Manual Listing_", foldername, ".xlsx"), overwrite = TRUE)',
                  'saveWorkbook(wb, out_file("xlsx"), overwrite = TRUE)')
    l = l.replace('chk <- getSheetNames(paste0("{{OUTPUT_STEM}}_Manual Listing_", foldername, ".xlsx"))',
                  'chk <- getSheetNames(out_file("xlsx"))')
    l = l.replace('olddata <- readRDS(paste0("{{OUTPUT_STEM}}_Manual Listing_", old_folder, ".RDS"))',
                  '##   olddata <- readRDS(out_file("RDS", paste0("(vs", old_folder, ")")))')
    l = l.replace('output_path = paste0("{{OUTPUT_STEM}}_Manual Listing_", foldername,',
                  '##                output_path = out_file("xlsx", paste0("(vs", old_folder, ").xlsx"))')
    l = l.replace('"(vs", old_folder, ").xlsx"))', '')
    l = l.replace('sheet 数 = 83 listing + Content', 'sheet 数 = listing 数 + Content')
    assert '{{OUTPUT_STEM}}' not in l, l
    so2.append(l)
out.extend(so2)
out.append('')
out.append('## ------------------------------------------------------------------ ##')
out.append('## 运行摘要（宿主 enterprise_listing_run_r 聚合回执的唯一来源）：只含      ##')
out.append('## listing 名 / 行数 / flag 数 / 产物文件名 / 告警，不含任何数据行值         ##')
out.append('## ------------------------------------------------------------------ ##')
out.append(SUMMARY_GRAFT)

new_tmpl = '\n'.join(out) + '\n'
io.open(TMPL, 'w', encoding='utf-8', newline='\n').write(new_tmpl)
print('new template lines:', len(new_tmpl.split('\n')))

# ---- 生成 ai_zones.R（校准基准 = 已交付 V2 业务段逐字）----
az = []
az.append('## HXN6005-A1-201 Manual Listing 业务生成区定稿（eval AI 校准步基准）')
az.append('## 内容 = 已验收交付程序（HXN6005_Manual_Listing_V2.R，2026-09-11 23:16 终版）')
az.append('## 对应业务段原样；经 applyBusinessZones 按 DSH-BUSINESS-ZONE 标记注入渲染程序，')
az.append('## render=false 执行后对 golden2（交付程序同沙箱重跑产物）回归。')
az.append('')
az.append('# >>> DSH-BUSINESS-ZONE:context <<< B1：受试者上下文与项目参照表（已验收业务段）')
az.extend(ctx1)
az.append('')
az.extend(ctx2)
az.append('# <<< DSH-BUSINESS-ZONE:context >>>')
az.append('')
az.append('# >>> DSH-BUSINESS-ZONE:listings <<< B2：DVP 逐行 outlisting 装配（已验收业务段）')
az.extend(rows)
az.append('# <<< DSH-BUSINESS-ZONE:listings >>>')
az.append('')
az.append('# >>> DSH-BUSINESS-ZONE:titles <<< B3：LISTING_TITLES 显示词表（已验收业务段）')
az.extend(titles)
az.append('# <<< DSH-BUSINESS-ZONE:titles >>>')
io.open(AZ, 'w', encoding='utf-8', newline='\n').write('\n'.join(az) + '\n')
print('ai_zones written:', AZ)

# ---- 自检 ----
zt = re.findall(r'# >>> DSH-BUSINESS-ZONE:([\w-]+) <<<', new_tmpl)
zc = re.findall(r'# <<< DSH-BUSINESS-ZONE:([\w-]+) >>>', new_tmpl)
assert zt == zc == ['context', 'listings', 'titles'], (zt, zc)
za = re.findall(r'# >>> DSH-BUSINESS-ZONE:([\w-]+) <<<', '\n'.join(az))
assert za == ['context', 'listings', 'titles'], za
ph = sorted(set(re.findall(r'\{\{(\w+)\}\}', new_tmpl)))
need = {'PROJECT_ROOT', 'STUDY_KEY', 'DATA_DATE', 'OLD_DATE', 'ZIP_PASSWORD', 'OUTPUT_PREFIX', 'SUMMARY_PATH'}
assert set(ph) == need, (ph, need)
assert 'outlisting$Manual_SUBJ' not in new_tmpl and 'LISTING_TITLES <- c(' not in new_tmpl
assert 'CTX <- IC_A' not in new_tmpl
print('SELF-CHECK OK; placeholders:', ph)
