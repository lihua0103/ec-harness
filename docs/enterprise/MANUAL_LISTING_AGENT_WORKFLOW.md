# Manual Listing 智能体全流程说明
## 从 spec 需求识别到服务器 R 代码交付（真实项目复盘 + dsh 落地设计）

> **2026-10-20 复核更正：本文保留历史复盘，不作为当前实现或最终重构验收依据。**
> 当前代码及真实服务器目录的核查以 [DSH_LISTING_REFACTOR_ASSESSMENT.md](DSH_LISTING_REFACTOR_ASSESSMENT.md) 为准。
> 尤须更正：ZCode 零告警不证明同一安全边界；双编程零差异不单独证明需求正确；
> 无数据字段不能自行放宽条件或代理；Project_Data 的只读声明与当前 R 缓存/解压/删除行为矛盾；
> `compare_artifacts` 实际比较最近一次成功运行内的两个命名输出，不是最近两次运行；
> 历史输出数量与临时业务裁定不是通用标准；不再新增四个碎片工具，改为升级既有入口。

> **文档定位**：本文以一次已完成的真实 Manual Listing 交付（下称 **P-A**）为样本，逐阶段
> 复盘"AI 如何读懂 DVP、如何反复推敲、如何自己审、最后交出可直接上服务器跑的 R 程序"，
> 并把这条流程抽象成 `@dsh-enterprise/listing` 插件应具备的能力。
>
> **代称约定**：按既有铁律，本文不写真实项目名/方案号。所有路径用占位符：
> `<项目根>`、`<studyKey>`、`<dataDate>`、`<oldDate>`。**项目名由用户输入、不进入 AI 推理**
> ——这既是安全要求，也是目录契约的设计前提（只有项目目录名会变，其余全固定）。
>
> **证据来源**：十余个主会话/冷启动验证/收尾会话的完整 transcript（含多个只读子代理）；
> 交付程序本体；四份审查/终审报告；`docs/enterprise/` 与 `knowledge/` 既有沉淀。

---

## 0. 一句话结论

这条流程的本质不是"让 AI 写 R 代码"，而是**用可审计的三件产物把"需求理解"变成可判定物**：

1. **需求理解矩阵**（每一行 spec 都有一条"原文 → 口径判定 → 数据证据 → 置信级"的链）；
2. **零业务模板 + 三个生成区**（AI 只写业务区，契约层永不被业务污染）；
3. **独立重算的 QC 回执**（审查方不复用生成程序代码，逐格比对，只回计数不回值）。

缺任何一件，"AI 读懂了 spec"就只是自我声明。P-A 之所以能从 83 条需求收敛到 77 个
listing 零差异，靠的是这三件产物互相咬合，而不是某一次模型输出特别聪明。

---

## 1. 全流程复盘：真实会话时间线

### 1.1 会话资产

| 阶段 | 会话主题 | 产出 |
|---|---|---|
| 生成 | 读 Manual Review 需求、写 manual listing R 程序 | V1 单文件 R（83 listing） |
| 生成 | spec 需求与 listing 数据逐条核对 | V1 缺陷清单 |
| 生成 | spec 需求与 R 代码实现逐条验证 | V2 骨架成型 |
| 审查 | 以 DM 角色逐条核查（多轮） | 四列口径模型定型 |
| 审查 | DM comments 版 spec 核查（交付前终审） | 终审报告、三角验证收口 |
| 交付 | DM 反馈确认 + 服务器产物审查 | 496,539 格 diff=0 的交付结论 |
| 冷启动 | 全新会话按插件流程从零重跑 | 78/78 全等，验证可复现 |
| 收尾 | 新鲜会话只收敛 RDS 残差 | rds 151 → 0 |

### 1.2 六个阶段（每阶段的输入、动作、产物、门禁）

```
S0 需求态考古  → S1 需求理解矩阵(U-Gate) → S2 生成区编写
      → S3 本地执行 → S4 独立审查(G-Gate) → S5 服务器交付(D-Gate)
```

#### S0 需求态考古：先确认"哪一版 spec 才是真的"

P-A 的项目根同时躺着 5 个版本的 DVP：

- `..._数据核查计划_V1.0_20260819_internal use.xlsx`（初版）
- `..._20260911.xlsx`（DM 加 comments 的反馈版）
- `..._20260911_R1回复.xlsx`（我方回写处理结论）
- `..._UniqueID回写.xlsx`（回写 Unique ID）
- 以及一个 `_20260911` 的副本

**这一步不是可选的。** 实测差异：

- 初版 Manual Review 有 **83 个数据行**；DM 反馈版里 7 行标"删除"、若干行合并、
  1 行新增 → **最终 77 个 listing / 78 个 sheet**。按字面 83 行实现会多出 7 个 listing。
- **黄色高亮 = 第一版交付的缺陷标记，不是新增需求**。把它当成新需求会重复实现。
- `Unique ID` 列 83 行全空（DBD 从未填号）→ 用 **Excel 行号**做稳定标识
  （MR-001…MR-083），后续矩阵、回写、审查全部引用这个号。
- 表头权威 = `Column Heading (For internal use)` 逐页对照，**不存在全局"去问号"规则**。

> 沉淀为门禁：**G-1 需求态考古先行**。spec 存在评审列（DM Comments `[已处理]`、
> R1 回复版类）时，真实交付态以评审定案列为准。

#### S1 需求理解矩阵（U-Gate）

对每一行 spec 产出四元组：

```
需求原文要点 → 口径判定 → 数据源证据（表单/列/值域实证） → 置信级 E/I/U
```

- **E**（实证）：对实际数据验证过（如"VISITNAME 去重后确实只有这 4 个值"）；
- **I**（推断）：需求文档 + 临床惯例可推出，但数据上无直接证据；
- **U**（未知）：**必须进"待确认清单"，禁止自挑相近字段代理实现后当 PASS**。

100% 判据：**矩阵中不存在未处理的 U 级**。P-A 首轮有 5 处 U 级，全部在后续
用第三源证据降级为 E 或 I（见 1.3 第 4 点）。

#### S2 生成区编写

模板是**零业务**的：契约层（读数缓存、密码推导、ALS 装载、解码、展开原语、
编码装载、输出样式、运行摘要）+ 三个 `DSH-BUSINESS-ZONE` 生成区：

| 生成区 | 内容 | 失败模式 |
|---|---|---|
| **B1 context** | `A_*` 活动表、`CTX` 跨表上下文列、`add_ctx/CTX_DROP`、`AE_REF/MH_REF/PT_DUP` | 项目无上下文列时须生成最小 CTX，否则下游 `add_ctx` 崩 |
| **B2 listings** | 每个 DVP 需求行一节，`outlisting$<数据集>_<序号> <- …`，按 DVP 行序 | **漏行 = 失败**；生成区未填直接 `stop()` fail-fast |
| **B3 titles** | `LISTING_TITLES` 显示词表（ALS 官方词汇，零自造） | 自造词 = 交付件被 DM 打回 |

每节注释必须写成：`## row<N> | <listing名> | Visits | Related Fields | Condition | Column Heading`。
这是"需求可追溯"的最小单位，审查时逐节对账就靠它。

#### S3 本地执行

`render=false` 重跑已编辑的程序（`render=true` 会用模板覆盖，只在需要重置时用）。
回执只含聚合计数：listing 数 / 行数 / flag 数 / sheet 数 / 产物文件名 / 告警。

#### S4 独立审查（G-Gate）

审查方**不复用生成程序的任何 helper**——判重键、CS 拆分、访视过滤、解码全部在审查
脚本里重写。原因很直接：同源 bug 会互相确认，产出假 PASS。

#### S5 服务器交付（D-Gate）

单文件 R 程序拷到 `SAS_Program/SAS_program/Manual Listing/`，`Rscript` 直跑，
产物落 `Output/04_Out/Manual listing/`。交付前四查见第 3.3 节。

### 1.3 关键转折点（每一个都是"理解偏差"而非"代码笔误"）

| # | 转折 | 错误认知 | 修正后的口径 |
|---|---|---|---|
| 1 | **Condition / Column Heading 的职责** | 以为 Condition 是描述性说明、Column Heading 只是列名 | **Visits×Fields=范围；Condition=行筛选；Column Heading=列输出**。四列是四件不同的事 |
| 2 | **flag 列** | 看到 Condition 里写 `flag=duplicated` 就加一列空 flag | flag **只在 Condition 明确要求处**存在；文字里解释规则不等于要加列 |
| 3 | **83 → 77** | 按字面行数实现 | 评审定案态优先：7 删 + 合并 + 1 新增 |
| 4 | **实验室"不拆分"** | 按 spec 的 CS 匹配 + 编号拆行 | DM 书面口径推翻：**解码长表原样输出**（每检查项目一行、不加匹配列、不拆编号）。L1-L3 口径 |
| 5 | **PT 术语"没数据"** | 数据里没有 PT 字段 → 代理列/不处理 | **没数据 ≠ 不实现编码逻辑**：必须实现编码装载 + 两段键匹配，未命中置空并计数 |
| 6 | **判重键的时间分量** | spec 字面写"采样日期/采样时间/检查结果"，缺字段就整条放弃 | 用**三源三角验证**降级：见下 |
| 7 | **页面命名** | 自动加 `Manual_` 前缀 | 用户明确不要前缀；sheet 名 = ALS 官方表名 |
| 8 | **UK 部分日期** | 日期规范化把 `2025-01-UK` 变空 | 匹配列必须走**原始字符列**，UK 原样输出（18 处） |
| 9 | **编码文件中文** | 匹配永远 0 命中 | WPS 导出把中文存成 `&#26082;` 数字实体，`openxlsx` 不解析 → **先解码再建键**（顺序错则 `norm_t` 先把实体剥成乱码） |
| 10 | **RDS 与 xlsx 不等价** | xlsx 全等即认为交付完成 | RDS 是比对工件：`.d` 派生列、`CRFVER/CRFSTS` 保留，缺失语义按构造路径（join=NA / 显式空=""），**列级归一补丁必打反其中一路** |

**第 6 点的推敲过程值得完整保留**，它是"专业判定"与"猜"的分界线：

- 第一层·数据模型事实：LB1 表**根本没有**"采样时间"字段（建库时没设计）→ 三分量键
  在这套数据上天然只能执行两分量。这是约束，不是选择。
- 第二层·核查目的：该 flag 的质疑文案是"采样日期与结果均相同，请核实是否重复"，
  目的是抓同一标本重复录入。**宁可键宽一点让人工过一遍，不能键严了漏掉真重复。**
- 第三层·实测数字：纯日期键 → 5161 行里 **3557 行被误标**（误报 69%，listing 不可用）；
  日期+结果 → **54 行**（误报 1%）。**键的构成是被数据选出来的。**
- 第四层·项目内先例：DM 已 Pass 过的 6 个判重行全是"日期主导键 + 空值守卫"，同构。
- 第五层·可推翻性：依据链完整 + 三处留痕（代码注释 / 审查报告 / spec 回复行内写明
  键构成与 54 行）+ 改一处守卫半小时重跑。**猜 = 无依据、被问住只能辩护。**

---

## 2. 服务器目录契约（与截图对应）

```
/mnt/project/<项目目录名>/                     ← 唯一可变的部分（用户输入）
├── Project_Data/                              ← 只读红线：EDC 原始数据
│   └── 01_Raw_sas/
│       └── Manual Listing/
│           └── <dataDate>/                    ← 数据 zip（+ 可选密码 .txt）
│                                              ← 同名目录兼作 RData 读数缓存
├── SAS_Program/                               ← 交付物：R 程序
│   └── SAS_program/
│       └── Manual Listing/
│           ├── <studyKey>_Manual_Listing.R    ← 单文件、可直接 Rscript
│           └── keyDataPointR_<studyKey>.xlsx  ← 新旧比对的键配置（可选）
└── Output/                                    ← 唯一输出目录
    └── 04_Out/
        └── Manual listing/
            ├── <studyKey>_Manual Listing_<dataDate>.xlsx
            ├── <studyKey>_Manual Listing_<dataDate>.RDS
            └── <studyKey>_Manual Listing_<dataDate>(vs<oldDate>).xlsx  ← 比对件（可选）
```

**契约要点（每条都踩过坑）**：

1. **大小写字面**：`Output/04_Out/Manual listing`（小写 l），而 `01_Raw_sas`、`SAS_program`
   下是 `Manual Listing`（大写 L）。不要"统一化"。
2. **数据日期目录必须可写**：解压出的 sas7bdat 与 `sas_data_<date>.RData` 都落这里。
   只读目录 → `checkdir error: cannot create ./sas7bdat Permission denied`。
   程序必须**先探测可写性**，不可写直接报错，不许静默换位落盘。
3. **不新建日期目录**：解压产物放在 zip 本身所在目录，不要另建一层。
4. **输出唯一**：`Output/04_Out/Manual listing/`。程序开头做写测试，不可写直接 `stop()`。
5. **项目根兜底**：项目目录名可能含中文导致 locale 异常 → 写死全名 + 按 `<studyKey>`
   关键字在 `/mnt/project` 下匹配兜底。
6. **数据只读**：程序绝不回写 `Project_Data`。

---

## 3. 交付标准：什么叫"可交付"

### 3.1 xlsx 形态

- 单工作簿 = **`Content` 首页 + 每个 listing 一个 sheet**（P-A：78 sheet）。
- Content：A1:G1 合并 `Comparison Summary`（TNR16 加粗居中）；第 2 行固定七列
  `Listing Seq. / Form Name / New-Modified ? / Total / New / Modified / Old`；
  第 3 行起一 listing 一行，Form Name 为跳转超链接（显示 ALS 官方中文表名）；冻结 A3。
- 业务页：A1 `go back` 返回链接；B1:F1 合并页名；第 2 行 Label 表头
  （TNR13 加粗、`#EDF2F9`、居中、行高 60、换行）；第 3 行起数据 TNR13 + 四边细边框；
  冻结 A3；筛选覆盖第 2 行至末行；空表写带边框「无数据记录」占位行。
- 末尾固定四列审核列：`FLAG(New/Modified/Old) / Update Detail / Review Comments / Initial/Date`。
- **网格线保持 Excel 默认显示**（规范曾写"隐藏"，按用户要求改回）。
- 列宽按 openxlsx 自动 +0.71 的特性反推写入值（16/50/18/9/8/12/8）。

### 3.2 RDS 形态

RDS **不是**单表，是**一个命名 list**（每个 listing 一个 data.frame）。它服务于
`compare_data` 新旧比对，所以与 xlsx 的差异是**故意的**：

| 项 | xlsx | RDS |
|---|---|---|
| `.d` 派生日期列 | 裁掉 | **保留**（比对需要） |
| `CRFVER/CRFSTS` | 裁掉 | **保留** |
| 缺失表示 | 统一空 | **按构造路径**：join 未命中=NA，显式 `dts()`/`if_else`=""；同列内可混合 |
| 列名形态 | 中文显示名 | 中文显示名（transmute 型）/ SAS 变量名+label |

**第 4 行是最反直觉的一条**：曾试过"列级整列 NA→'' 归一"，实测 DS_01 修 20 格反
20 格、PE_02 反 12 格。**唯一正确修法是撤补丁、回构造段逐路径复刻。**

### 3.3 可交付的四道门（D-Gate）

| 查项 | 判据 |
|---|---|
| ① 根路径 | 程序 `root` 默认值 = 交付运行时的项目根；搬机器须改默认值或声明 `DSH_R_PROJECT_ROOT` |
| ② 单文件自包含 | 无 `source()`、无会话临时脚本、无 python 依赖；只用基础包 |
| ③ `[REPLACE]` 清单 | 逐条给"已实证取值"或"需用户确认"的当前状态，不许默认 |
| ④ 产物与摘要 | 文件名/落盘目录/行数·flag 计数与 spec 契约一致，QC 报告随交付 |

### 3.4 可交付的两条量化底线（G-Gate）

1. **有 golden 基准时必须双跑逐文件 QC，0 差异才可宣称交付。**
   P-A 的实测值：xlsx 78/78 sheet 逐格全等；双编程值级 QC **17,993 行 × 421,181 格
   diff = 0**；服务器产物 vs 本机基线 **496,539 格 diff = 0**（含表头与 Content 页）。
2. **RDS 必须"结构层 + 值层"双零**。值层用 NA 敏感 xor 口径
   （`xor(is.na(x),is.na(y)) | (!is.na(x)&!is.na(y)&x!=y)`），**规范化 NA=="" 会假零**；
   结构层逐对象核 `names`（含列序）/`class`/`label`。
   **"celldiff=0 但 FAIL" = 结构残差**，两者同零才是终局。

---

## 4. 核心方法论：怎么"真正识别 spec"

这一节是本文的重点。前文所有流程都是骨架，这里是"AI 凭什么敢说读懂了"。

### 4.1 四列职责模型（一切推理的起点）

| spec 列 | 职责 | 程序动作 | 常见误读 |
|---|---|---|---|
| **Visits Applied To** | 访视范围 | 非 `ALL` → 访视过滤；**该列也可能填的是表单名** | 以为它一定是访视；合并表单是 `"X/Y"` 完整组合串，写半截零命中 |
| **Related Fields** | 字段范围 | 非 `All items` → 列收窄 | 以为它总是"全部字段" |
| **Condition (For internal use)** | **行** | `Output if …` → `filter()`；`flag=duplicated` → 派生列 | 当成描述性文字 |
| **Column Heading (For internal use)** | **列** | `Raw data`=全字段原样；清单=逐列；"匹配XXX"=回连派生；flag=按 Condition 算 | 以为只是列名列表 |
| **Report Description / Discrepancy Text** | DM 人工核查文本 | **程序不实现、不产出核查 flag** | 当成需求；或完全忽略（其实它是判定意图的第三源） |

### 4.2 U-Gate：把"理解"变成矩阵

矩阵每行四元组，随交付汇报留存、可被审计：

```json
{
  "uid": "MR-039",
  "requirement": "同一参与者采样日期/采样时间/检查结果相同 → flag=duplicated",
  "interpretation": "判重键 = 采样日期 + 检查结果；时间分量在该表无字段，按质疑面退化",
  "evidence": [
    {"dataset": "LB1", "columns": ["LBDAT","LBTEST","LBORRES"], "note": "无采样时间字段（建库即无）"},
    {"dataset": "LB",  "columns": ["LBDAT","LBTEST","LBORRES"], "note": "时间字段存在但 52% 行缺失"},
    {"calc": "纯日期键误标 3557 行 / 日期+结果 54 行", "note": "误报率 69% → 1%"}
  ],
  "confidence": "E",
  "trace": ["代码注释 LB_06 段", "审查报告 P3-2", "spec 回复行内"]
}
```

**置信级判定规则**：

- 三源（Condition / 质疑文本 / 数据库定义）对齐 → **E**
- 仅需求文档 + 临床惯例，数据无冲突 → **I**（汇报中必须显式声明推断依据）
- 数据与需求冲突且无第二源 → **U**（进待确认清单，给用户出路）

### 4.3 红队三类必查（全部来自真实事故）

| 类别 | 查什么 | 事故原型 |
|---|---|---|
| **号体系** | 筛选号/随机号/LIMS 形态/掩码；桥接两侧键形态逐侧实证 | 筛选号形如 `S+5位`，前 2 位是中心号；EDC 占位符未替换 `S01{SUBNUM:0}` 也照原样输出 |
| **时间戳来源** | 录入戳 vs 业务时刻；"字段自带时间"必须**全行恒定差值 + 时刻分布**双重实证 | 某项目 `ECDSTTIM` 恒定 +10h 是前夜空腹时刻，直接拼进 RT 导致 190 行 RT=0 |
| **边界与 off-by-one** | 时点/访视/窗口/队列的**每个枚举值域逐项对表** | PC 表时点标签 48/72/96 与 EDC 采样记录错位一格 |

附加两条纪律：

- **spec 注释列 / 干跑值不可信**，必须独立重算；
- **旧项目惯例跨项目套用前先实证**。

### 4.4 三源三角验证（解决"spec 字面 vs 数据现实"冲突）

```
        Condition (内部实现口径)  ── 定键与过滤
                  │
                  ├── Discrepancy Text Message (DM 判定意图/质疑标准)
                  │     → 验证"我们触发的问题面" == "DM 想问站点的问题"
                  │
                  └── 数据库定义 (可执行性)
                        → 有字段就执行；无字段按质疑面退化
```

三源对齐 = **确证**；只有 Condition 单源 = **推定**，必须留痕并可推翻。

P-A 的完美对照组：`EG_EGT_01` 的 Condition 也写了"检查日期和检查时间"，EG 表**有**
`EGTIM` 字段 → 就执行时间分量（flag=22）；LB1 表**没有**时间字段 → 按质疑面退化。
**同一个 DM 写的 Condition，有字段的执行、无字段的退化——实现忠实于数据模型，
没有一处自作主张。**

### 4.5 五层依据链（"专业判定"的可执行定义）

1. **数据模型事实**（不是选择，是约束）
2. **核查目的**（这个 flag 是干什么的；漏报 vs 误报哪个更不可接受）
3. **误报/漏报的实测数字**（判定必须有数）
4. **项目内先例一致性**（DM 已 Pass 过的同构口径）
5. **可推翻性**（依据链完整 + 留痕 + 低成本修正路径）

### 4.5.1 理解自检四问（判断"真懂"还是"猜的"）

对每一条 U/I 级需求，用四个问题自检。**任何一个答不上来，就说明还没真懂**：

| # | 自检问题 | 答不上来意味着 |
|---|---|---|
| 1 | **换一种说法能复述吗？** 把 spec 原文合上，用自己的话讲出"这一行列从哪来、行怎么筛、有没有派生" | 只是在复读原文，没建立语义 |
| 2 | **能举出一个反例吗？** "什么情况下这一行不应该输出 / 不应该打 flag" | 只知道正例，边界没想清 |
| 3 | **依据链每一层都有东西吗？** 数据模型事实 / 核查目的 / 误报数字 / 项目先例 / 推翻成本 | 只有"我觉得应该这样" |
| 4 | **如果 DM 不同意，改哪里、多久能重跑？** | 说明实现方式耦合太深，或者根本没想清楚口径在哪一层 |

第 4 问尤其关键：它是"专业判定"和"猜"的最终分界。P-A 的 LB_06 之所以敢定案，是因为
"改一处守卫、半小时内重跑回归"这句话是真的——口径被隔离在一个明确的位置上。

### 4.6 反模式清单（出现即视为理解失败）

- ❌ 自挑相近字段代理实现，然后当 PASS
- ❌ 把 spec 注释列/干跑值当锚点
- ❌ 按列名/标签猜判定字段（必须按**列自身 `format.sas` 绑定**）
- ❌ 从 spec 抄页名/访视名（必须对实际数据**去重值域**核对；零命中即停，不许当"没数据"继续）
- ❌ 编码未命中就"回退原值"（应**置空 + 计数进回执**，避免混淆已编码/未编码）
- ❌ 自动加前缀、自动补空 flag 列
- ❌ 把长表拆成宽表（DM 要长表直出）
- ❌ 需求写"拆分一行一条"却把 `1,AAA；2,BBB` 塞进一个单元格
- ❌ 拿"合并去重"当理由简化 Raw data（两表列结构不同时，保留 lead 列 + 判重字段即可，
  但必须写明理由）

---

## 5. 代码生成：模板零业务 + 三个生成区

### 5.1 为什么必须"零业务模板"

P-A 早期是"骨架 + 核查节"用 python 脚本组装（`_assemble_v2.py`）。这带来一个隐蔽
风险：**骨架里的公共段修改会在下次组装时被覆盖**。所以任何"读数/编码装载"级修复
都必须落在骨架，而业务逻辑落在核查节。

现在的形态更彻底：**模板只含契约层，业务全在三个生成区**。好处：

- 模板可跨项目复用，业务与项目强绑定，不会互相污染；
- 生成区未填 → 运行 fail-fast 并给出出路（这是**预期守卫，不是缺陷**）；
- 校准回归 = 模板 + 注入历史项目的业务区 → 应 100% 复现历史产物。

### 5.2 契约层必须包含什么（每条都是踩出来的）

| 能力 | 关键实现点 |
|---|---|
| locale 容错 | `tryCatch(Sys.setlocale("LC_CTYPE", "Chinese (Simplified)_China.utf8"))`；Linux 上无效名报错要吞掉（服务器本就 UTF-8）；`dir.exists` 也要 `tryCatch` |
| 失败写摘要 | `options(error=...)` 里写 `{"status":"error","message":...}` 再 `quit(status=1)`，宿主才能拿到精确 stop 信息 |
| 目录契约 + 写测试 | 输出目录 `file.create` 探测；不可写直接 `stop()` |
| 解压与密码推导 | 系统 `unzip`/`7z` 优先（R 内置 `unzip()` **没有 `password` 参数**）；解压前 `dir.create(exdir)`；候选密码顺序与插件 `archive_passwords.py` 对齐 |
| ALS 装载 | 字段名映射（输出显示名以 ALS eCRF 变量名为准）+ 字段序（= 临床 DM 查看顺序） |
| 全局解码 | 优先 `formats.sas7bcat`（`haven::catalog_file` 挂载，比 FORMATS 数据集完整），FORMATS 兜底 |
| 编码装载 | 记录级键（受试者\|页名\|记录号）→ 词典级（规范化术语）两段；**先解码实体再建键** |
| 展开原语 | `split_ids`/`first_id`/`ae_ids`/`expand_ref`/`grp_flag`/`lead_cols` |
| 输出样式 | Content 七列 + 审核四列 + go back + 冻结/筛选/边框/列宽 |
| 运行摘要 | `summary.json`：`status/listingCount/rowCount/flagCount/sheetCount/outputs/warnings/listings[]` |

### 5.3 单文件交付纪律

- 无 `source()`、无临时脚本依赖；
- 服务器无 python、无网络安装 → 只用基础包
  （`haven/dplyr/tidyr/purrr/stringr/openxlsx`，`tidyverse` 可选并 `requireNamespace` 探测）；
- 文件头配置段即可独立运行（`DSH_R_*` 环境变量为空时用渲染值）。

---

## 6. 自审核：为什么"自己审"必须换一套代码

### 6.1 审查纪律（dm-listing-review 七步）

角色设定：资深临床数统 DM，**立场是挑错不是自证**——默认"程序可能有错"。

1. **结构对账**：sheet 数/顺序 = spec 活动行序；Content 每行 Total = 对应 sheet
   数据行数；审核四列齐全；flag 列只存在于 Condition 明确要求的 listing。
2. **四列映射逐行审查**（每个活动行）。
3. **Output if 行数独立重算**（判重键、过滤、拆分全部在审查脚本重写）。
4. **flag 独立重算 + 反向漏标检查**。
5. **CS 匹配逐处与目标表当前值核对**。
6. **编码列与编码文件交集归因**。
7. **全表解码扫描**（裸码检查：coded 列不得出现孤立数字）。

**核心纪律：重算逻辑独立实现，不 source 生成程序的 helper。**

### 6.2 量化断言（交付汇报必须带数字，不许"已核对"）

P-A 的终审断言模板：

| 类别 | 断言内容 |
|---|---|
| 行数守恒 | 13 个 listing 的独立重算行数 = 交付件实测（如 5058 / 5161 / 425 / 315 …） |
| flag 守恒 | 7 个判重 listing 的独立重算 flag 数 = 交付件（如 96 / 93 / 54 / 22 …） |
| 专项 | UK 部分日期 18/18 原样输出，逐处列出 sheet |
| 裸码 | 15 个代表性 sheet 的 coded 列，裸码 0 处 |
| 结构 | 78 sheet，Content Total 与各 sheet 实测 0 不一致 |

### 6.3 双编程 QC（最硬的证据）

**QC 编程侧从原始数据出发，独立重建 77 个 listing 的全部行、全部列、全部值**
（访视过滤、Output if、编号拆分、CS 匹配、flag 判重、CTX 派生、编码词典、解码、
表单名细分），再与交付 RDS 逐 listing 逐列逐格比对。

P-A 结果：**77 listing / 17,993 行 / 421,181 格，diff = 0。**

> 注意：QC 过程中出现过 6 类"期望侧"差异（`VISITNAME` 解码 attr 丢失、LB 表单名细分、
> `paste0` 零长参数幽灵 id、逻辑值 vs 字符、`transmute` 列名、漏建表），全部取证定位为
> **QC 脚本自身口径问题**并修正，交付件未发现缺陷。**这说明双编程是有效的——它能抓到
> 双方的错，而不是互相确认。**

### 6.4 残差外科收敛（长会话退化的对策）

冷启动收敛轨迹（真实数据）：

```
xlsx: 14,949 → 11,942 → 6,829 → 5,443 → 173 → 210 → 0   (78/78 全等)
rds :    612 →    322 →    311 →   151 →    0            (值层+结构层)
```

**实测规律**：同一会话 6 轮后，AI 开始"宣告完成 + 给残差找语义豁免"（把 NA 语义差
解释成"解码值域差异"拒修）。对策：

- 换**新鲜收尾会话**接手：只带 GT 路径 + 残差模式清单 + 逐列镜像指令；
- **一次只改一列形态**，xlsx 与 RDS 双验证；禁整块重写
  （实测两轮回归都是整块重写把已修列冲掉、甚至破坏 ALS 词汇管线）；
- 收敛前先快照 xlsx 全等状态。

### 6.5 审查的独立性如何在工程上保证

| 层 | 做法 |
|---|---|
| 代码层 | 审查脚本独立文件，不 `source()` 生成程序；helper 重写 |
| 上下文层 | 用**独立会话/子代理**执行审查，不继承生成过程的"我已经对了"的假设 |
| 证据层 | 每处 finding 必须带数字（期望 n 行 vs 实际 n 行）；分不清"缺陷 vs 数据现实"时先回原始数据取证 |
| 只读层 | 审查不改交付件；发现 P1 → 回生成程序修复 → 重跑 → 复审 |

---

## 7. 服务器执行与交付

### 7.1 执行方式

```bash
# 放置：SAS_Program/SAS_program/Manual Listing/<studyKey>_Manual_Listing.R
Rscript "<studyKey>_Manual_Listing.R"
```

宿主（dsh）执行时经环境变量覆盖文件头渲染值，不落盘密码：

```
DSH_R_PROJECT_ROOT / DSH_R_STUDY_KEY / DSH_R_DATA_DATE / DSH_R_OLD_DATE
DSH_R_ZIP_PASSWORD / DSH_R_OUTPUT_PREFIX / DSH_R_SUMMARY_PATH
```

### 7.2 环境要求

| 项 | 要求 |
|---|---|
| R | ≥ 4.2；`Rscript` 在 PATH 或 `DSH_RSCRIPT` 指定 |
| 包 | `haven / dplyr / tidyr / purrr / stringr / openxlsx`（+ `tools`） |
| locale | 显式设中文 UTF-8；Windows 本地跑前清 `LC_CTYPE/LC_ALL/LANG`（`C.UTF-8` 是无效值，会让 R 落到 CP936，中文标识符解析报 invalid token） |
| 网络 | 无（不联网安装） |
| python | 无（服务器没有） |

### 7.3 服务器排障清单（按出现频率排序）

| 症状 | 根因 | 处置 |
|---|---|---|
| `cannot change working directory` / `未找到数据目录或数据zip` | 目录契约不符 / 日期目录名错 | 核对 `folder_path/foldername` |
| `checkdir error: cannot create ./sas7bdat Permission denied` | 数据目录只读 | 解压到可写目录（Output），不在数据目录新建 |
| `unused argument (password = ...)` | R 内置 `unzip()` 无 `password` 参数 | 用系统 `unzip`/`7z` |
| `'exdir' does not exist` | 解压目标未创建 | 解压前 `dir.create(recursive=TRUE)` |
| `Rscript.exe 不是内部或外部命令`（bin 转发器存在但 x64 缺失） | R 安装不完整 | 用 `Rterm.exe --vanilla --slave --file=...` |
| 日志出现 `cannot create file ... Device or resource busy`，但程序报 `done` | 输出 xlsx 被 Excel/WPS 占用，**本轮没保存成功** | 关文件重跑；判断标准是文件时间戳 |
| 编码匹配永远 0 命中 | 编码导出把中文存成 `&#NNNNN;`，`openxlsx` 不解析；且解码顺序错（`norm_t` 先剥掉实体字符） | 先解码再 `norm_t` 建键 |
| 新旧比对全 New、无 Modified | 跨环境 `RECORDID` 不稳定；UAT vs PRO 是两个库 | 只用业务键（`SUBJID`）能配上的行；PRO vs PRO 才正常 |
| `key fields not in shared columns` | 比对包要求配置的每个键列**双侧都真实存在** | 按表单实际列子集写键：取 `SUBJID→RECORDID→SUBTRID→CSN` 中双侧共有的最大前缀 + `CmpRowSeq` |

### 7.4 新旧比对（可选交付件）

```
新 RDS + 旧 RDS + keyDataPointR_<studyKey>.xlsx → compare_data() → (vs<oldDate>).xlsx
```

- 着色与 New/Modified 标记由比对包完成，**我们不写样式代码**；
- 键配置全 ASCII、按表单实际列子集、生成时自证"键列双侧存在"；
- 主 listing xlsx 里的 `FLAG` 列是恒 `New` 的占位，不是比对结果。

---

## 8. dsh 插件现状评估

### 8.1 已经具备的（比想象中多）

| 能力 | 现状 | 位置 |
|---|---|---|
| 目录契约 + 渲染 + 执行 | `enterprise_listing_run_r` 完整实现 | `src/r-runner.ts` |
| 零业务模板 + 三生成区 | 已落地（66KB / 1023 行模板，三个区 fail-fast） | `r-templates/manual_listing.R.tmpl` |
| 场景知识库 | 五场景路由 + manual 深库 8 篇 | `knowledge/` |
| 四列口径 | 已沉淀（六列白名单 + 处理顺序 + N 行=N listing） | `manual/baiaozhi-scenario-kb.md`、`dvp-patterns.md` |
| U-Gate 定义 | 已写成文本门禁（矩阵 + 红队三类 + 100% 判据） | `knowledge/router.md` |
| G-Gate / D-Gate 定义 | 已写成文本门禁 | 同上 |
| 回执只含计数 | R 车道宿主不解析数据行值 | `r-runner.ts` |
| 单测 | 6 个 vitest + 19 个 pytest | `src/*.test.ts`、`python/tests/` |

### 8.2 缺口（这是本文要解决的核心）

| # | 缺口 | 后果 |
|---|---|---|
| **1** | **门禁只是文本，没有状态机** | 未过 U-Gate 也能直接 `run_r`；"声明门禁"靠模型自觉 |
| **2** | **没有需求结构化提取工具** | `read_document` 给原文分片，四列结构化靠模型逐字读 256K 文本；易漏行、易把评审列当需求 |
| **3** | **没有需求矩阵的读写/校验** | 矩阵只在汇报文本里，不可校验、不可审计、跨会话丢失 |
| **4** | **没有文件级 QC 工具** | `compare_artifacts` 只比"最近两次 run_code 的 DataFrame"，**不读 xlsx/rds 文件**；golden 逐格比对全靠临时脚本 |
| **5** | **没有独立审查通道** | 审查只能靠 AI 再写脚本，同一上下文里"自证"风险高 |
| **6** | **U-Gate 在 r_manual 不可达** | `run_r` 不触发 `inspect`；`inspect` 要绝对路径、`run_r` 允许相对名，两条链的项目绑定是两套 |
| **7** | **scenario 枚举不一致** | `index.ts` 允许 `r_manual`，`templates.py` 不认，会返回 `INVALID_SCENARIO` |
| **8** | **G-Gate 资产缺失** | 文档指定的 golden 基准与四个比对器不在仓库内，无法自动跑 eval |
| **9** | **无 L5 项目档案检索** | 新项目无法按 `studyKey` 自动读到"同型项目上次踩的坑" |
| **10** | **R 车道 warnings 未过值扫描** | `run_r` 属 `enterprise_*` 被 post-execute 豁免，`warnings` 原样回传（目前只含计数与提示，但缺硬保证） |

---

## 9. 落地设计：把这条流程变成插件能力

### 9.1 目标状态机

```
S0 requirements   ← 结构化提取 spec（含评审态）
S1 matrix         ← 需求理解矩阵（E/I/U），U 级阻断
S2 generated      ← 三生成区已填（静态检查：三区非空 + 行数 = 活动需求行数）
S3 executed       ← 本地跑通（回执计数）
S4 reviewed       ← 独立重算 QC（0 差异 / 残差清单）
S5 delivered      ← D-Gate 四查 + 产物落盘
```

状态存 `<项目根>/.clinical-listing/gates.json`（该目录已存在，复用它存 `audit.jsonl`）。

### 9.2 工具契约（新增 4 个，改造 2 个）

#### ① `enterprise_listing_requirements`（新增）

从 spec 结构化抽出需求矩阵的**原始事实层**（不含任何受试者数据值）。

```ts
in:  { project, documentId?, revision?: "latest" | string }
out: {
  revision, sheet, headerColumns: string[],
  rows: [{
    uid,              // "MR-039"（Unique ID 空则用 Excel 行号）
    excelRow,
    formName, visits, relatedFields, condition, columnHeading,
    reviewState,      // "active" | "deleted" | "merged" | "added"
    highlighted,      // 黄色高亮 = 第一版缺陷标记
    dmComment
  }],
  summary: { total, active, deleted, merged, added },
  warnings: ["Unique ID 全空，已用行号", "发现 5 个 spec 版本，已按 latest 选择"]
}
```

**关键约束**：只回需求文本与结构，不回任何数据值。

#### ② `enterprise_listing_matrix`（新增）

```ts
op: "write" | "read" | "validate"
in: {
  project,
  entries: [{
    uid, requirement, interpretation,
    evidence: [{ dataset, columns, note } | { calc, note }],
    confidence: "E" | "I" | "U",
    trace: string[]      // 代码注释位置 / 报告章节 / spec 回复行
  }]
}
out: { coverage: { total, E, I, U, missing }, blockers: string[], ok: boolean }
```

`validate` 规则：

- `active` 行数 ≠ 矩阵条目数 → `ok=false`
- 存在 `confidence="U"` 且 `trace` 为空 → `ok=false`，列 `blockers`
- `I` 级必须在 `trace` 中声明推断依据

#### ③ `enterprise_listing_qc`（新增，替代"临时脚本"）

```ts
in: {
  project,
  baseline: "golden" | "<绝对路径>" | "auto",
  mode: "structure" | "cells" | "both",
  artifact: "xlsx" | "rds" | "both"
}
out: {
  sheets: [{ name, rows, cols, cellDiff }],
  structure: { namesEqual, classEqual, labelEqual },
  totals: { cellDiff, structureDiff },
  verdict: "PASS" | "FAIL"
}
```

**关键约束**：只回计数与 sheet 名/列号，**不回任何值**。这正是"数据不出域"的落点。

#### ④ `enterprise_listing_gate`（新增）

```ts
in: { project, action: "status" | "advance" | "reset", stage? }
out: { stage, passed: string[], blocked: [{ stage, reason }], nextAction }
```

改造 `run_r`：`render` 前检查 `stage >= matrix`，否则拒绝并给 `nextAction`
（除非显式 `force: true`，且 `force` 写审计日志）。

#### ⑤ 改造 `enterprise_listing_inspect`

- 接受相对项目名（与 `run_r` 统一）；
- 输出增加 `specRevisions[]`（发现多版本时列出，由模型判断评审态）；
- 输出增加 `contractCheck`（三棵树是否存在、数据日期目录是否可写）。

#### ⑥ 修复 `templates.py` 的 scenario 枚举

把 `r_manual` 纳入或显式分流（当前会 `INVALID_SCENARIO`）。

### 9.3 知识库补齐

| 新增/强化 | 内容 |
|---|---|
| `manual/review-playbook.md` | 把 dm-listing-review 七步 + 量化断言模板 + 五层依据链 + 三源三角验证写入 master |
| `manual/spec-archaeology.md` | 需求态考古：多版本识别、评审列优先、黄色高亮语义、Unique ID 空的处理 |
| `manual/pitfalls.md` 增补 | 编码实体解码顺序、RDS NA/"" 构造路径、Excel 占用致静默未保存、Rscript bin 转发器 |
| L5 项目档案索引 | 按 `studyKey` 可检索；新项目先读同型档案（一遍过率/差异收敛史） |

### 9.4 实施顺序与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1** | `requirements` + `matrix` + `gate`（状态机） | 用已交付项目跑：矩阵覆盖 77 行，U 级 0；未过矩阵时 `run_r` 被拒 |
| **M2** | `qc`（文件级逐格 + 结构层） | 对 golden2 跑出 `PASS`；人为改 1 格 → `FAIL` 且定位到 sheet+列号 |
| **M3** | 独立审查通道（独立会话 + 只读脚本 + 回执） | 注入 3 类已知缺陷（漏行 / flag 多标 / UK 丢失），审查全部抓到 |
| **M4** | 知识库补齐 + eval 扩容（含负样本） | `dsh-standard-verify` ALL PASS；负样本全部被门禁拦截 |

### 9.5 数据安全边界（贯穿设计）

| 层 | 规则 |
|---|---|
| 入 | spec/ALS 是业务文档，可读；**受试者数据行值不进上下文** |
| 中间 | 需求矩阵的 `evidence` 只允许：数据集名、列名、去重计数、业务枚举值域；**不允许行值** |
| 出 | 所有回执只含计数、文件名、sheet 名、列号；QC 不回值 |
| R 车道 | 读数/核查/样式化全程在项目目录完成；宿主只读 `summary.json` |

---

## 10. 总结

P-A 这条路走通的三个关键判断，也是 dsh 插件必须固化的三条：

1. **"读懂 spec"不是感觉，是矩阵。** 每一行需求都必须能落到"原文 → 口径 → 数据证据 →
   置信级"，U 级必须变成待确认清单，而不是悄悄用一个相近字段顶上。
2. **"自审核"必须换一套代码和一套上下文。** 同一份 helper 自测只能证明"代码符合代码"；
   双编程独立重算（17,993 行 × 421,181 格 diff=0）才证明"代码符合需求"。
3. **"可交付"是四查 + 双零，不是"跑通了"。** 根路径、单文件自包含、`[REPLACE]` 状态、
   产物计数，加上 xlsx 逐格零差异与 RDS 结构+值双零。

插件当前已经有模板、车道、知识库三块地基，缺的是**把门禁从文本变成状态机**、
**把需求从原文变成矩阵**、**把 QC 从临时脚本变成工具**。补齐这三件，新项目只提供
"项目目录 + spec + SAS 数据"，就能重复 P-A 的完整流程，而不是重复 P-A 的弯路。
