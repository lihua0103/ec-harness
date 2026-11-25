# DVP 蒸馏训练循环标准（通用版）

适用于**任何具备文件读写与 HTTP 能力的 agent 执行环境**（Claude Code、zcode 及其他编辑器/CLI agent）。执行本标准前，先把「环境适配」一节的占位映射为当前环境的实际值。已在 DXP-604-101 项目完整闭环验证（v0.5 对 STD 验收全绿；台账见环境适配的 STATE_MD）。

## 0. 角色与铁律：数据边界（动任何文件前先默读一遍）

本循环中有两类执行方：

- **执行 agent**（读这份规范的你——无论 Claude 还是 zcode）：负责编排、派发、机械验收、沉淀台账。
- **桥接模型**（通过工作台 run 执行的业务模型）：负责**一切文档内容读取**与规则物化。

铁律（2026-11-23 用户定调修订：**DVP 逻辑规则可读；真实临床项目信息仍禁读**）：

> **2026-11-24 修订（用户定调：数据安全是用户自己开关的，与模型无关）**：下列第 1、3、5、6 条中的数据边界**只在数据安全开关开启时适用**。
> 开关是手动维护的 `.runtime/data-boundary.json`（`{ "dataSecurity": true | false }`），命令 `node .runtime/data-boundary.cjs on|off|status [--restart]` 或平台设置页「数据安全」卡片：
> 开启（默认；文件缺失或损坏也按开启）——以上各条照旧生效；关闭——执行 agent 可直接读取真实项目内容，Cover / Approval / 人名 / 样例值原值返回。
> 开关**不随模型目录变化**（之前"目录全是公司内部模型即全量"的自动判定已废弃）。当前状态：关闭。
> 工作流纪律（done/blocked 回复、禁止 ask_user_question、磁盘→磁盘）与开关无关，照常适用。

1. 执行 agent **不读取真实临床项目信息**：受试者数据、人名、样例值、方案临床正文等敏感数据不进入 agent 上下文。
2. **DVP 逻辑规则可读**：规则文件、规则内容（Logic/discrepancy 文本、ID 词表、列形等）与规则统计属工作语料，允许执行 agent 直接读取。
3. 结构信息（文件名、sheet 名、行列数、字节级表头）与统计量照常可读；真实临床项目信息的读取仍由**桥接模型**完成；中间产物走**磁盘→磁盘**（CSV/ndjson）。
4. 向桥接模型的提问只能是结构/统计性问题；每个 goal 的最终回复必须是单行 `done: <n>` 或 `blocked: <码>`——这同时是机械验收依据。
5. Cover 临床内容不外显；人名一律 `<NAME>`；Approval col-B 值一律 `<VAL>`。
6. 用户边界原话：会话模型可以全量读取所有文档，但不能把项目敏感数据告诉执行 agent；2026-11-23 补充：「DVP逻辑规则那些可读，真实临床项目信息不允许读取」。

## 1. 前置检查（每次起跑）

1. 桥接 cookie 新鲜度（<24h）：过期则用桥接目录的登录脚本刷新（headful 浏览器 SSO 弹窗；**用户必须在弹出的那个窗口里登录**，用户自己浏览器的登录不算）。cookie 文件热加载，桥接服务无需重启。
2. 控制面与工作台 API 存活；执行 agent 的会话 cookie 按「环境适配」解析。
3. 工作唯一性：dispatch 前查 runs 存储（sqlite 只读连接）无活动 run——workspace 独占，一工作同时只允许一个活动 run。

## 2. 训练循环配方（照抄结构，换参数）

### 2.1 STD 结构 dump（脚本读文件，stdout 只输出计数）

- 用只读方式逐行读真实 DVP 的各规则 sheet，写 `TRAIN_DIR/std-<sheet>.csv`（磁盘→磁盘），**stdout 只打印行数**。
- 坑：**trim 声明维度尾空列**（曾有 sheet 声明 16359 列，不 trim 会从 132KB 膨胀到 4.1MB 拖垮链）；form 名含字面 `\r\n` 一律 sanitize 为 `_`；表头行按首列特征跳过（如 `Form Name` / `Unique ID` / `Add/Delete` 前缀）。

### 2.2 逐 form/page 单对链（模板见环境适配 CHAIN_TPL）

- **一 run 一文件**（P31 律：单文件指令首过 ~97%，多文件指令表 ~30% 失败）。
- goal 必备六要素：
  1. 工具白名单「只允许 read 和 write」+「**尤其禁止 ask_user_question（无人应答会永久阻塞）**」；
  2. 错误纪律：静默原样重试一次，禁止任何分析/表格/进度类 chat 文字；
  3. 输入路径逐字；
  4. 输出键名与列序；
  5. 行数目标；
  6. 「最终回复必须只是 `done: <n>`」。
- 验收 = 机械行数对账（输出文件行数幂等 → 断点续跑免费）；PASS_CAP=3。
- **STD 是唯一事实源**：逐字拷贝（typo/大小写如字面 `True`/换行/标点都照抄），GEN 独有 form/page 机械丢弃，目标行数 = STD 各组行数合计。
- **MR 是设计型**：STD 其他项目的 MR 只作行形态参照，内容从**本项目** ALS 字段清单设计（人工看 listing 才能核查的项），**禁止拷贝 STD 核查内容（拷贝=编造）**；formName/relatedFields 只能取 ALS 原值。
- 写簿层统一补的不要链里做：discrepancy 尾词（如「，请核查。」）由 write 层加，链里不带尾词。

### 2.3 装配（单工具单次调用）

- 写簿工具（如 `dm_dvp_write_workbook`）**恰好一次**；documentJson 逐字传入（bulk 四规则文件 + versionHistory + template：sheetOrder / governanceOrder=approval-first / editChecksTestcaseColumns=true / fieldLevelLayout=als / discrepancyTail / changeMarkStyle=version / includeProgramming=false）；错误纪律同上；回复单行。

### 2.4 验收（全绿才许报闭环；未通过不得报合规/已验证/可发布）

- 结构校验脚本：sheet 顺序、行列数、表头字节（xlsx 先解包到临时目录再查 XML/行读取）。
- GEN vs STD 统计 diff（**只打印统计**）：总行数、逐 form 计数、ID 词表形态、Type 词表、testcase 填充率、id 多重集差（onlyGEN/onlySTD 必须双空才算零差）。
- 字节保真：xlsx zip 内字面 CR 计数与 STD 模板层模式一致（多行表头/便签行的 CRLF 原文保真）。
- **模型自报不可信**：验收必须查落盘文件与 runs 存储，不信 run 的 result 文字。

### 2.5 沉淀

- 每轮向 STATE_MD 追加 P 编号经验条目（一行一条事实，含数字）。
- 记忆/知识库对应条目追加一行状态；跨项目共性升级为通用规则。

## 3. 已知残差与坑（写 goal 前核对）

- 写簿 bool 强制转换会把 STD 字面 `True` 归一为 `TRUE`（DXP 实测 3/372，知情保留；消除需写簿层加原值透传开关）。
- HTTP GET run 详情不回 state 时——轮询一律走 runs 存储按 run_id 前缀查 state；终态集 SUCCEEDED/FAILED/CANCELLED/BLOCKED。
- 取消卡死/死信 run：cancel 接口带 `{expectedRevision}`。
- bulk 输入键（crossField/fieldLevel/manualReview/dynamic）均支持文件引用；链产物用 ndjson，每行一个 JSON 对象。
- 子任务/子会话 brief 必须禁「分析收尾」类开放指令，只给机械步骤与验收行。

## 4. 环境适配（占位 → 当前已验证默认）

| 占位 | 当前默认（DXP 已验证，可替换） |
|---|---|
| PROJECT_DIR | 真实项目目录（如 `D:\project\company\epro\Project\DXP`） |
| TRAIN_DIR | `PROJECT_DIR/.train`（STD csv 与逐组产物） |
| RUNTIME_DIR | `D:\project\company\ec-clinical-dsh\.runtime\dxp`（脚本模板/派发 json/台账目录） |
| STATE_MD | `RUNTIME_DIR/state.md`（P 条目台账） |
| CHAIN_TPL | `RUNTIME_DIR/chain-ec.mjs`、`chain-dyn2.mjs`、`chain-als3.mjs`、`chain-mr.mjs`、`run21.mjs`、`dispatch-run21.json`（换路径即可复用） |
| WORKBENCH_API | `http://127.0.0.1:3095/platform-workbench`（控制面 3096） |
| SESSION_COOKIE | `.runtime/dsh-web-cookie.txt`（tab 分隔第 6/7 列拼 `name=value; …`） |
| BRIDGE_DIR | `.runtime/wuxigpt-bridge`（login.mjs / cookies.json / bridge.out.log 排障） |
| BRIDGE_MODEL | 见 `.claude/rules/new-session-model.md`（ID 会随路由变化，查 /v1/models 核实） |

新训练项目起跑 = 复制本标准 + 换上表映射 + 工作台新建工作取 WORK id。Windows 注意：R 一律 Rterm（`--file=` 连写）；执行环境有沙箱限制时，受限令牌读不到的盘区交由操作者代跑。
