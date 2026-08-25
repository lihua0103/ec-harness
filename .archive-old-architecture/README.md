# Emerald Clinical Listing Guard

这是一个 DeepSeek Harness / Cordis 企业临床 Listing 安全编排插件。它通过 DSH 官方扩展点统一承载 Listing 工作流、规格解析、数据结构检查、数据出域保护和无原文审计，不修改 Harness 本体。Harness 负责自主理解和本地推理；插件只在内容准备发送给 AI 时执行可开关的数据保护。

插件内置可信本地执行器与能力沙箱（2026-08-24 架构重设计）。模型全权理解需求并编写 pandas 变换代码，代码在本地白名单 AST + 受限运行时 + 子进程隔离的沙箱中执行，查询项目内的 SAS7BDAT/XPT/CSV 数据集，生成 medical、RBQM、manual review 和 report 的真实 Listing XLSX。临床记录只在 Python worker 内读取并写入本地产物，不进入模型上下文；沙箱回程只允许聚合元数据信封（行数/列名/dtype/空值计数）。

## 安全合同

- 模型侧 Listing 入口是代码车道循环：`clinical_listing_inspect` → `clinical_listing_run_code`（按元数据信封迭代）→ `clinical_listing_publish`（重放最近一次成功代码，固定 Writer 产出 Excel）。
- 每次工具调用以 DeepSeek Harness Web UI 当前会话的 `exec.agent.session.header.cwd` 为权威工作区根；静态 `localDataRoot` 仅兼容没有 session cwd 的旧宿主。
- `project` 必须是当前会话工作区内的相对项目目录；当前工作区本身使用 `project: "."`。绝对路径、`..`、盘符路径和符号链接逃逸均拒绝。
- 密码不得作为工具参数传入。显式密码只能用 `credentialRef` 引用 `credentialsDir` 内的本地凭据文件；没有引用时，可信 worker 会在本地按项目名、小型 `.txt` 标记、ZIP 文件名和项目其他文件名生成候选并逐一试解，候选值不会进入模型上下文、工具收据、异常或审计日志。
- `doc`、`docs`、`spec`、`als`、`template` 中的可信需求文档明确豁免自动脱敏，全文供模型理解需求；豁免只对插件标记的工具结果生效，普通用户消息不能伪造该信任来源。
- `.sas7bdat`、`.xpt`、CSV 与 Excel 数据可由 Harness 驱动的本地执行能力读取和加工；开启数据拦截时，真实记录不得进入模型上下文。
- `local_data_metadata` 只用于受控结构检查，返回文件类型、sheet、列名和行数，不返回记录。
- 通用工具和脚本执行不在 pre-execute 阶段被插件拦截；其结果在开启态进入模型上下文前统一经过 post-execute 投影，并由 llm/stream 作最终检查。
- 模型可见的 Listing 结果固定为白名单收据（`CLINICAL_LISTING_INSPECTION` / `CLINICAL_LISTING_CODE_RECEIPT` / `CLINICAL_LISTING_RECEIPT`），仅含规格正文与结构元数据、run 信封聚合统计、相对产物标识和安全警告，不包含真实记录。
- 沙箱能力边界（构造性归零显式出域通道）：无 import、无 `open`/`eval`/`exec`/`query`、禁下划线属性与名称、禁 pandas/numpy 的文件与序列化 IO 方法；数据集只能经注入的 `datasets` 注册表按名读取。
- run 信封的字符串通道（列名、错误文案）出信封前经 strict scrub；数据值走私进列名会被脱敏。
- 真实临床记录、密码、宿主绝对路径和执行器异常原文不会进入模型上下文。
- 生成结果统一标记为 `REAL`。Excel 由本地固定 Writer 写出（CONTENTS 目录页、复核列、公式注入防护），模型代码只产 DataFrame，不写文件。
- 智能表头识别统一由 `header_detect.py` 提供，覆盖多行标题、无表头降级和 XLS/XLSX/CSV 结构提取；EDC 系统字段通过规范化角色映射参与结构理解。这两项与固定 Excel Writer 都是生产能力，不随数据拦截开关关闭。
- 支持 `medical`、`rbqm`、`manual` 和 `report`；缺少规格文档、数据集、字段或存在同名数据集歧义时返回结构化 `invalid`/`needs_input`，不会用假数据补齐。
- `clinical_listing_run_code` 与 `clinical_listing_publish` 的调用次数按会话与项目分别限频并全部计入审计。信封中的 rowCount 是"某值是否存在于某列"的存在性预言机，限频与审计是该通道的收敛手段，不得移除（见 REMEDIATION F-4）。
- Python 安全 worker 不可用、超时或协议异常时 fail-closed；沙箱子进程崩溃/超时收敛为结构化错误，原始 traceback 不出域。

## 配置

Listing 能力默认关闭。启用本地 UAT 工作流时，在插件配置中提供：

```yaml
localDataAccess: uat-local
```

通常不需要配置工作区路径；Web UI 选择的目录会随每次执行传入。只有旧宿主无法提供 session cwd 时，才可配置 `localDataRoot` 作为兼容回退。需要本地凭据时，可另行配置 `credentialsDir`，但不得把密码放进工具参数。

`listingTimeoutMs` 可按操作覆写本地计算超时。Listing 是重本地 I/O 操作；超时返回可重试的结构化收据而非裸错误。`EMERALD_LISTING_MAX_EXECUTIONS` 覆写单会话单项目的 run/publish 次数上限（默认 50）。

inspect 阶段扫描项目 `doc`、`docs`、`spec`、`als`、`template` 目录中的 XLSX 需求文档，以及项目根目录中名称明确包含 spec、template、validation plan 或 DVP 的 XLSX；同时以 metadata-only 方式收集本地数据集的真实字段名作为可执行 schema。ALS 映射原样提供给模型理解需求，但不构成数据可用性证明——只有本地数据源的真实 metadata 才进入 schema，避免出现"validator 通过、executor 找不到字段"。项目内缺少唯一数据源时，在 worker 临时目录中受限解压项目 ZIP，解包产物统一显示为 `archive/<file>`。产物写入项目的 `.clinical-listing/output/<scenario>`，发布是整目录原子替换并带回滚保护。

ZIP 候选顺序为：本地凭据引用、项目名原值/去符号值/渐进式 `-` 前缀、项目内不超过 256 字节的 `.txt` 文件名 stem 与不超过 128 字符的单行内容、ZIP 文件名 token、项目其他文件名 token，最后尝试空密码。所有尝试只发生在 worker 内存与临时目录；路径穿越、链接、文件数、总大小、单文件大小或压缩比违规会立即 fail-closed，不会被当成普通密码错误继续尝试。

当前内置执行器不持久保存成功密码，也尚未支持 WinZip AES、嵌套 ZIP 和 SAS/XPT magic 校验。固定 Writer 已落实 CONTENTS、复核列、表头样式、冻结窗格、筛选、公式注入防护及发布流程；来源系统特有的 Go back 等额外规则应作为后续独立交付，不得通过放宽模型出域边界补偿。

## DSH 工具

Listing 工具共用参数：

- `project`：必填，当前 Web UI 会话工作区内的相对项目目录；使用 `.` 处理当前工作区本身。
- `scenario`：可选，支持 `medical`、`rbqm`、`manual` 和 `report`；省略时由规格推断。
- `credentialRef`：必填，`credentialsDir` 内相对凭据文件引用；无加密归档时传空字符串。

`clinical_listing_run_code` 额外接收 `code`（pandas 变换代码字符串）。可用：`datasets`（按名取 DataFrame，如 `datasets["dm"]`）、`pd`、`np`、`math` 与纯计算内建。禁用：任何 import、下划线属性/名称、文件与序列化 IO（read_*/to_*/load/save 等）、`eval`/`exec`/`query`。代码必须赋值 `result`（单个 DataFrame）或 `outputs`（`{listing 名: DataFrame}`）。返回只含聚合元数据信封，数据值不出域。

`clinical_listing_publish` 重放最近一次成功代码，由固定 Writer 产出 `<SCENARIO>_LISTINGS.xlsx`；publish 前必须有一次 status 为 ok 的 run。

`local_data_metadata` 参数：

- `path`：当前 Web UI 会话工作区内的相对 XLSX、XLS、CSV、SAS7BDAT 或 XPT 路径。该工具只返回结构元数据。

## 运行边界

`dataInterceptionEnabled` 是唯一运行态数据出域开关：

- 开启：`tools/post-execute` 在工具结果进入模型上下文前投影真实 data，`llm/stream` 对最终模型请求执行递归出域检查；审计只保存哈希、计数、类别和动作，不保存数据原文。
- 关闭：上述数据扫描、投影和阻断全部旁路，内容交由 DeepSeek Harness 原生链路处理。
- 两种状态下：Listing 工具、智能表头、EDC 字段处理、固定 Excel Writer 和 `inspect -> run -> iterate -> publish` Harness 引导始终生效。

包内 Python 组件需要 Python 3.10+。安装后在插件目录执行：

```powershell
python -m pip install -r requirements.txt
```

Excel 结构解析由 `openpyxl`、`xlrd` 提供，测试夹具使用 `xlwt`；SAS metadata-only 结构检查使用 `pyreadstat==1.3.6`。该版本提供 Python 3.13 Windows wheel，不要求把 `pandas` 作为插件硬依赖。Node 侧 DSH 运行时由 peer dependencies 提供。

## 验证

```powershell
python tests/run_all.py
python tests/mutation/run_mutation.py
npm pack --dry-run --json --cache .npm-cache
```

发布前还应从生成的 `.tgz` 安装到干净临时目录，验证包导入、worker `ping`、工具无重复注册、Listing 合同和安全 fixture 工作流。
