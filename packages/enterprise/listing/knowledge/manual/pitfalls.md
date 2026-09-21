# 已踩过的坑与修法（postmortem 库）

> **使用方式（推优先）**：写码前先过 `scenario-router.md` 的门禁——下表"预防"
> 列就是每个坑对应的门禁，过门禁=坑不会发生。本文件在**门禁仍漏掉**时使用：
> 按报错信号匹配条目 → 修法 → **回填对应 Gate**（进化闭环，见 KB_ARCHITECTURE.md §3）。

## 预防索引（坑 → 门禁映射）

| 坑类 | 预防门禁（写码前过） |
|---|---|
| 访视 kw 零命中/合并表单写半截 | G3 访视门禁（先查 vlab 实际访视去重值域） |
| 编码页名与 EDC 用词不一致 | G1 编码门禁③（页名对 DataPageName 值域核对） |
| 0 行表塌型/join 崩 | G0' 空表防御 + G3（根因多在上游零命中） |
| 判定字段解码错列 | G5 判定门禁（format.sas 绑定，勿按列名猜） |
| 编号拆分显示带前缀 | G2/G4（匹配列只显纯序号） |
| CS 匹配取了打包快照 | G6（取目标表当前值） |
| 派生列漏实现/来源猜错 | G7（逐列识别来源，拿不准问用户） |
| locale/中文/BOM/包缺失 | G0 环境核对（本文件 R 环境节） |

## R 环境 / locale

- 坏 locale（`LC_CTYPE=C.UTF-8` 等）会导致：中文列名解析失败、多字节正则
  invalid、`dir.exists` 抛错、`source` 读 UTF-8 失败。修：清环境变量再跑
  （`set LC_CTYPE=& set LC_ALL=& set LANG=& Rscript ...`）；代码内已用
  `fixed=TRUE`（`any_kw`/`sep_norm`）与 `tryCatch` 路径探测兜底。
- PowerShell 5 `[IO.File]::WriteAllText` 默认 **UTF-8 带 BOM**，R 报
  `unexpected input in "<feff>"`——改写 R 文件必须 `UTF8Encoding($false)`；
  Edit 类工具写文件后再 `Rscript -e "parse(...)"` 验一遍。
- 中文**列名**写在代码位置在部分 locale 解析不了 → 列名一律 ASCII，中文只放
  attr 标签与字符串。
- 服务器可能没有 tidyverse 元包：骨架已做 `requireNamespace("tidyverse")`
  回退到 dplyr/tidyr/purrr/stringr。

## dplyr

- 自定义函数在 `%>%` 管道里接收**列表达式**参数时，必须 `rlang::enquo` +
  `!!` 求值（`grp_flag`/`scale_flags` 已内置）；否则在全局环境求值报
  `object 'SID' not found`。
- 派生列（`ECDATd` 等）只存在于公共段的 `*_A` 表上；fresh `ACT("EC","ec")`
  出来的没有，需内联 `dt_(ECDAT)`。
- `many-to-many` join 前先对多值编号列 `first_id()`，避免键膨胀。
- **0 行 df 过含 `ifelse` 的 helper 会塌型**：`ifelse(character(0), …)` 返回
  `logical(0)`——如 `dig5()` 产出的 SUBJKEY 变 logical，`left_join` 报
  incompatible types（x 是 <logical>）。上游根因几乎都是**上游过滤零命中**
  （见下条），修过滤关键词而不是 helper。

## 数据形态（每项目要重新核对的点）

- **访视过滤 kw 必须对 vlab 解码后的实际访视名整串**：合并表单（一张表覆盖两个
  业务域，如用药/非药物治疗）的访视名是"X/Y"**完整组合串**——写半截→零命中→
  空表（并连锁触发上一条塌型坑）。零命中 note 会打实际访视前 5 个，先看它再改。
- **编码文件页名 vs EDC 用词可能不同**（"伴随"≠"合并"）：PT 术语的记录级键页名
  取编码文件 DataPageName 实际值域核对，勿从 DVP/spec 抄——见场景知识库 §2
  编码方法论。
- 表单后缀表结果列名不同：PE→`PERES`，PE1→`PE1RES`；时间点表可能没有
  `SRSTAT/SRREASN/SRERYDIA`（SRT2/3）——用 `!is.null(df[[col]])` 守卫。
- 编码解码一律走 FORMATS 目录（`dec`）；拿不准的编码表（如妊娠
  `LBCLSIG1`）在 flag 标签标 `[REPLACE/CONFIRM]`。
- 受试者键：`SUBJID` 三种形态（S01019/01011/CN001011），用 `dig5()` 归一。
- 失活：`INVALID` 键 = TID+RECORDID+SUBTRID；`ACT()` 加 `.inv`。

## zip 解压三连坑

- R 内置 `utils::unzip()` **没有 password 参数**（报 unused argument）；
  加密包走系统 `unzip -P`（服务器 Linux）。
- 内置解压引擎**不创建子目录**（报 cannot open file './xxx/yyy'）——兜底前
  先按 `unzip(zipfile, list=TRUE)` 的条目 `dirname` 预建目录（骨架已做）。
- 目标目录无写权限 → Permission denied；数据日期目录必须可写（现行约定）。
- 密码自动推导候选顺序见 `password-rule.md`（骨架 `password_candidates()`）。

## POSIXct / 日期

- `as.POSIXct` 不带 format 遇 NA 拼接串直接报错；始终给 `format` 并先处理
  NA（ifelse NA_character_）。hms 列 `chr_()` 后是 "HH:MM:SS"。
- 部分日期（"2026-07"）用 `dt_()`；日期列在写 xlsx 前统一转文本。

## openxlsx 4.2.x

- 颜色必须带 `#`（如 `"#EDF2F9"`）；`underline` 参数不存在 →
  `textDecoration = "underline"`。
- `writeFormula` 自动补 `=`：公式串不要再带等号。
- `setColWidths` 写入宽度自动 +0.7109375：要规范定值就传"规范值 − 0.7109375"
  （Content 传 16/50/18/9/8/12/8）。
- 大表样式用 `addStyle(..., stack=FALSE, gridExpand=TRUE)`；空表写"无数据记录"
  占位行保持表格线可见；网格线保持 Excel 默认（用户偏好）。
- **loadWorkbook+saveWorkbook 往返不适合改 DM 的 spec**（2026-09-10 实测）：空字符串
  单元格被改写成 `"NA"`（2385 处）、customXml/docProps 部件丢失。改既有 xlsx 用
  `assets/spec_writeback.py`（最小 XML 手术，只动目标单元格，其余字节原样）。
- openxlsx 产物每个 sheet rels 带未引用的 drawing 占位：openpyxl 读取会
  `KeyError: xl/drawings/drawingN.xml`，校验前先剥掉该类 Relationship
  （Excel 本身正常打开）。
- **openpyxl `read_only=True` 读 openxlsx 产物会按声明维度截断业务页行**（每行只见
  首列，回归 diff 假报"零差异"）——输出比对必须用非 read_only 模式（2026-09-10
  去前缀回归实测踩坑）。

## 流程

- 空 listings（0 行）正常，占位行已处理；listing 数必须等于 DVP 行数
  （保存后自检会告警）。
- Excel 正开着输出文件时 `saveWorkbook` 报 Permission denied——关掉重跑。
- flag 抽查原则：高 flag 率先核对是不是规则写错（如中心编号前缀、范围取反），
  再认定是数据问题。
