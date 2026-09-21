# ADR-0003：临床 Listing 引导插件（@dsh-enterprise/listing）

- 状态：已接受
- 日期：2026-08-26
- 决策者：平台团队
- 上游 pin：`dsh-v0.1.1-rc.2`（`upstream/deepseek-harness` submodule）

## 背景

`feat/data-egress-switch-refactor` 分支的 `emerald-clinical-data-guard`
实现了完整的 Listing 链路：`clinical_listing_inspect`（spec/ALS 识别与
metadata-only schema）→ `clinical_listing_run_code`（AST 白名单沙箱里的
pandas 代码车道，只回聚合元数据信封）→ `clinical_listing_publish`
（重放最近一次成功代码，固定 Excel Writer）。该实现的安全模型是
"构造性归零出域通道"（沙箱 + 信封 + 双 worker 车道 + 预算记账 + 审计
签名，共 20 个 Python 模块）。

业务侧明确：当前部署是受信内网环境，这条流程**完全不需要限制 AI 操作**
——模型可以看真实数据值、自由写代码（含 import 与文件读写）。需要的
是 harness 引导：识别 spec/ALS 文档、把需求字段映射到 ALS 表单字段、
解压 SAS 数据集、处理并产出 listing 交付物。

## 决策

### 1. 重构而非迁移

按新骨架插件模式新建 `packages/enterprise/listing`（row
`enterprise-listing`），TS 宿主 + 精简 Python worker。不搬运旧实现的
安全机制：删除沙箱、四平面、出域检查、脱敏、双车道、心跳、预算、
审计签名。Python 侧从 20 个模块收敛为 4 个（`worker` / `spec_parser` /
`catalog` / `writer`），其中 spec 解析（宽容列头、关系型/扁平双形态 ALS、
autoFilter 修复）与 Excel Writer 样式从原实现移植。

### 2. 持久会话与唯一发布车道

TS 宿主为每个 Agent 维持独立 NDJSON Python worker，并串行执行 `inspect → run_code →
publish`。`run_code` 在当前会话提供 `datasets` / `pd` / `np`，模型必须生成
非空 `outputs: dict[str, pandas.DataFrame]`；不接受旧 `result` 变量，也禁止
模型调用 `to_excel` / `ExcelWriter` 绕过交付边界。`publish` 是唯一 Excel
发布入口，直接使用会话中最近一次成功的 `outputs` 调用统一 Writer，最终
只生成一个工作簿。超时由 TS 宿主控制（杀进程并丢弃状态，重新 inspect
恢复）。

### 3. 数据可见性口径

inspect 返回数据值预览（默认前 5 行，可配 `previewRows: 0` 关闭），
run 的 stdout 不脱敏。这是**有意为之**的口径变更：本流程面向受信内网
与内部数据。若未来部署到需要出域管控的环境，必须新增 ADR 重新引入
管控层，而不是在本包上打补丁。

### 4. 归档凭据简化为 sidecar

加密 zip 的密码从 credentialRef + credentialsDir 通道简化为归档同目录
`<归档名>.txt`（单行明文）。sidecar 属于项目工作区，由工作区自身的
访问控制保护；不再有跨目录凭据读取面。

### 5. 宿主接线沿用结构类型

与 ADR-0002 相同：peer 依赖仅 cordis 内核，`ctx.tools` /
`ctx.systemPrompt` 以结构子集类型访问并 fail-fast。工具注册与系统提示
引导（inspect → run_code → publish）是本插件的全部挂载点；不触碰
`tools/*` 事件与 `llm/stream`。

### 6. 输出规范：AI 负责业务内容，Writer 固化交付结构（2026-08-27 修订）

AI 根据 spec、ALS 与数据集推理业务列、字段顺序、筛选逻辑及多个业务
Listing，并通过 `DataFrame.attrs["labels"]` 提供变量 Label；程序不写死
具体表单或业务 Sheet。为避免模型输出多个文件或任意样式，机械交付结构
由统一 Writer 固化：

1. 每次 publish 只生成一个 `<项目标识>_{SCENARIO}_LISTINGS.xlsx`，业务 Sheet 按
   `outputs` 动态生成。（2026-09-04 命名修订：项目标识 = 项目目录名，跟随
   申办方 `<方案号>_<文档类型>` 交付命名，跨项目收集可区分；旧名
   `{SCENARIO}_LISTINGS.xlsx` 弃用，已发布旧文件不迁移，track_changes
   首跑按全量新增重建基线。）
2. `manual` / `medical` 使用固定 `Content`、三层业务页结构，并自动补齐
   五个比较审核列；`rbqm` 不强制比较列，但复用 RT01 视觉样式。
3. `report` 使用 DM Status Report 固定 `Cover Page`；业务页为单层表头、
   第 2 行起数据，不补比较审核列，并套用范例表头行高与列宽。
4. 字体、填充、边框、冻结窗格、筛选、行高、列宽与链接样式分别来自
   RT01 Manual Listing 与 `file_show (6).xlsx` 的结构/样式提炼；不复制范例业务数据。
5. 重跑变化记录在没有可靠业务唯一键时只按完整行多重集计算新增/删除，
   不伪造 `modified`；变化统计写入 `Content`。

### 7. r_manual 车道：交付物是可独立运行的单文件 R 程序（2026-09-07 新增）

对"DVP 已固化、目录按固定契约投递"的项目，交付物不是 AI 每次现场生成的
pandas 代码，而是一份可直接在服务器 `Rscript` 运行的 TAISHAN 风格单文件
R 程序（HXN6005-A1-201 真实 UAT 数据验证：83 条 DVP → 83 listing + Content）。
设计见 `docs/enterprise/LISTING_R_INTEGRATION_DESIGN.md`。

0. 需求口径：DVP Manual Review 的 Visits Applied To × Related Fields 定范围、Condition 定行
   （Output if / flag=duplicated）、Column Heading 定列（Raw data + 上下文 / 派生 / 匹配拆行列）；
   Report Description / Discrepancy Text 是 DM 人工核查内容，程序不实现、不产出核查 flag。
1. 与 pandas 车道并列，不复用 Python Worker：宿主 `src/r-runner.ts` 只做
   模板渲染 → 写入项目 `SAS_Program/SAS_program/Manual Listing/<studyKey>_Manual_Listing.R`
   → 子进程 `Rscript` → 读取 R 程序自写的运行摘要 json 组装聚合回执。
   读数、核查、样式化 xlsx（对齐 `LISTING_MULTI_SHEET_SPEC.md` manual 场景，
   用户偏好：网格线默认显示、`go back` 返回链接、页名去 `Manual_` 前缀）全部在 R 内完成。
2. 模板资产 `r-templates/manual_listing.R.tmpl`，文件头 7 个双花括号占位符
   （项目根/studyKey/数据日期/旧版日期/zip 密码/输出前缀/摘要路径）；运行时参数
   经 `DSH_R_*` 环境变量覆盖渲染值（模板 `cfg()`），因此 AI 按 DVP 修改过的程序换
   数据日期可直接 `render=false` 重跑，zip 密码不落进 R 文件；脱离插件在服务器独立运行
   时用文件头渲染值。
3. 项目名/方案号/数据日期由用户在对话中直接提供、作为普通工具参数进入模型上下文
   （不经 ui-settings 设置页）；提示引导禁止模型推断这些值。项目名只能是部署配置
   项目根（缺省 `/mnt/project`，`rListing.projectRoot`）下的单层目录名或绝对路径。
4. 回执只含聚合计数（listing/行/flag/sheet）、产物文件名、R 程序告警；失败时取
   R `stop()` 写入摘要的精确信息，开关开启时 stderr 不回流（同 run_code 口径）。
   缺 Rscript 回 `R_NOT_FOUND`（同 `PYTHON_NOT_FOUND` 模式）。
5. 已知平台坑：Windows 上最小化子进程环境必须保留 `PROCESSOR_ARCHITECTURE`，
   否则 R 加载包后以 0xC0000005 崩溃（实测二分定位）；不透传 `LC_*`。

## 后果

- 企业 Profile 装配 4 个企业 row；未实现的 auth 空壳不装配；`scripts/` 一行未改（自动发现）。
- Python 运行时成为部署前提（pandas / openpyxl / xlrd），缺解释器时
  工具回执 `PYTHON_NOT_FOUND` 并附安装指引。
- 会话状态在 worker 进程内：宿主重启或超时杀进程后丢失，模型需重新
  inspect（引导提示已写明）。多会话并发各自独立 worker 进程。
- `.listing-output` 与 `_work` 已列入扫描忽略目录，解压产物不回流进
  数据集索引。
- 原分支的 `emerald-clinical-data-guard` 其余部分（出域开关、设置页
  UI、post-execute 投影）仍待各自的迁移决策；若未来迁入，与本插件
  在工具命名空间上不冲突（本包工具带 `enterprise_listing_` 前缀）。

