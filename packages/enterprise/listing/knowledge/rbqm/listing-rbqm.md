# 场景库：rbqm（风险质量管理指标）

车道：`enterprise_listing_inspect → read_document → run_code → publish(scenario="rbqm")`。
**首项目已实施**（RBQM_test，2026-09-14）：交付形态 = 会话 AI 按本库终案**独立编写单文件
R 程序**（配置段+逐 KRI 函数+runner），项目根落盘 `RBQM_KRI_Listing_<数据日期>.R`，
本机 Rterm/服务器 Rscript 执行；publish 车道仍为多 sheet 骨架待沉淀。

## 目录契约（首项目实证，2026-09-14）

- 数据：`<项目>/Project_Data/01_Raw_sas/RBQM/<数据日期>/`（sas7bdat 已解压 **或** zip；
  zip 场景：密码自动推导链同 manual 库 password-rule——sidecar txt→目录名分词→相邻
  组合→无密码兜底；zip 在项目根时解压到 tempdir 缓存，不污染项目目录）
- 程序：`<项目>/RBQM_KRI_Listing_<数据日期>.R`（项目根，非 SAS_Program 车道目录）
- 输出：`<项目>/Output/04_Out/RBQM/<数据日期>/`；**一条需求一个 xlsx**；
  KRI 明细 + 配套标准表（如 `KRI_019_标准.xlsx`）。
- 非 SAS 数据源（Query_Details.xlsx 等）随数据目录或项目根投递，程序按
  DATA_DIR→项目根 顺序探测。

## L1 写码前门禁（Gate）

- **GR0 继承 G0 通用**（见 manual 库 G0：写进代码的业务关键词先对实际值域核对）。
- **GR1 指标口径来源**：KRI/QTL 阈值与分母口径必须来自方案/风险计划文件原文并
  列出出处；无出处的指标**列待确认**，禁止自行设定。
- **GR2 输出契约**：publish 场景固定 rbqm 的多 sheet 规范；未沉淀前先 inspect
  对齐结构。
- **GR3 中心名称列**（2026-09-14）：凡含中心编号列的输出，编号右侧并排
  `SITE_NAME`；映射取 subj 花名册（StudyEnvSiteNumber→Site），非 SAS 来源同样
  用该映射反查。细则见 manual 库 output-spec.md「中心编号必须并排中心名称」。
- **GR4 spec 解读纪律**（2026-09-14 铁律重申）：需求只读 Visits Applied To / Form
  Name / Condition / Column Heading 四列；**DM Comments 即使看起来像交付契约
  （文件名/率公式/干跑数字）也整列禁读**——干跑数字常是旧口径，验收=Condition
  忠实实现+真实数据核对。
- **GR5 数据边界口径**（2026-09-15，用户拍板）：拦截对象只有两类**源数据值入
  AI 上下文**——SAS 数据集行值、doc 外辅助 Excel 业务值。程序执行（pwsh 跑 R/
  生成 listing Excel）与其运行日志**放行**；交付物 Output/04_Out/** 的读取
  **放行**（dataset-guard 交付域判定 + post-execute 路径豁免双层）。结构列
  （SITE/FOLDER/VISIT/TPT 等方案词表，含中心名称）不入保护索引。扫描哈希按
  数据面指纹持久化（.clinical-listing/scan-cache.json），重启秒级恢复不再
  fail-closed 风暴；数据面指纹未变的重复 inspect 秒级复用。

## L2 口径终案（用户拍板记录；首项目 RBQM_test 收官沉淀）

1. **spec 需求本体=四列**（C/D/E/F）；A 列=KRI 编号（即输出文件名），G 列禁读（GR4）。
2. **锚点记录多条时取"临床定义所属的那条"**：PK 的 EOI=同周期 D1 内 ECYN='Yes'
   记录的**最晚结束时刻**（PK 窗锚定整袋输注结束）——"取最晚结束"是通用规则。
3. **表清单（Form Name）权威于 Visits 文字综述**：Form 覆盖的访视即使 Visits 文字
   未列出（如 pc2 同时覆盖 C1D8+C3D8），满足 Condition 的记录照进分母。
4. **多记录归并取"任一满足"**：入排 IE 多记录（复筛）时任一 IEYN='Yes' 即合格；
   表单"记录为不符合"类信号（IECAT/IETESTCD）按 Condition 字面 EXISTS 实现，
   编号词表不因值域缺失而扩展。
5. **标准上限外的记录排除出分母**：检验值分级标准只到 G4，记录 Grade 5（结局
   驱动，由 SAE/死亡审查覆盖）属不可判定→不入分母；同理"可判定"限定词成立。
6. **无法分期的组合不入分母**：分期标准表没有的组合（如 T0&M0）→不可判定排除；
   记录粗分期（Stage III/IV）按大组匹配推导集。
7. **无日期字段的表不参与延迟类指标**：字段探测确认无关键日期且无可靠回退关联键
   时，排除并注记，**禁止启发式近似锚点**（错配归因污染 KRI）；有同域带日期的
   姊妹表覆盖监控时注明替代覆盖。
8. **中心实验室为主、本地检验条件回退**：中心实验室文件含 LLN/ULN 可全量判定；
   回退文件无参考范围时，依赖 LLN/ULN 的档位判不可判定。
9. **时点指标（质疑长龄等）数值随导出时点变化**：以随包导出为准，不做跨时点对账。
10. **GR3 SITE_NAME**（见上）。

## L4 坑与信号（首项目实测）

- **`filter(x %in% cfg$改名前列)` 静默清空**：config 列改名后旧引用只发 warning，
  `%in% NULL`→logical(0)，程序 DONE 但 rows=0——交付前必核各行数/加行数哨兵。
- **haven 空串是 "" 不是 NA**：`值 %in% c(" Unknown","Tx",…)` 排除清单要同时覆盖
  "" 与 NA（`is.na()` 先行短路），否则 NA 记录漏排进分母。
- **pandas 读 xlsx 的整数是读取端类型推断**：文本 "001" 被 pandas 显示成 1——判定
  写盘格式用 openpyxl 直读或 `dtype=str`，别当写码缺陷。
- **Rterm 跑无 BOM UTF-8 中文脚本**：R 4.5 UCRT 下脚本内 setlocale 后中文文件名/
  sheet 名/字符串值全部正确；日志是 UTF-8 字节，cmd `type`（GBK）看必乱码。
- **日期时间拼接**：EDC 日期 `16 Jan 2025` 文本 + 时间 `H:MM`（有 9:31 无前导零
  形态），解析需归一化；录入延迟 = DATE(MinCreated) − 关键日期，负值（补录）保留。
- **openpyxl 直读 openxlsx 产物会撞 drawing rels**：QC 用 pandas read_excel（走
  read_only）或 R 读回。

## L5 项目档案

- **RBQM_test（2026-09-14，首项目）**：9 条 KRI（PK 采样窗偏离/基线 ADA/入排误纳
  NEUT/对照组 D1-D5 完整性/Tier1 录入延迟/Tier1+2 录入延迟/质疑长龄/CTCAE 分级
  一致性/TNM 分期一致性）。黄金参考 = 项目根 `RBQM_KRI_Listing_20260806.R`；
  spec=doc/KRI_Listing_Spec_*.xlsx（四列口径）。阈值等项目特定值一律以黄金参考
  配置段为准（[REPLACE] 标注）。基线数字（20260806 数据，验收判据）：KRI-010
  924/超窗51；KRI-011 224/合格223；KRI-014 451/分子1；KRI-015 217人/周期926/
  完整884；KRI-016 451人/91592条/中位20；KRI-017 148行=74中心×2层；KRI-018
  130/长龄1；KRI-019 4047/错误62；KRI-020 813=410+403/错误23（全部 N3 误记
  IIIB）。KPI：AI 独立实现待本档案更新。
