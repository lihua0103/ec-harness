---
name: "clinical-listing-flow"
description: "Guides the DeepSeek Harness agent through the clinical listing code lane end to end: identify doc/ → read spec & ALS → infer scenario → locate SAS zip & credential → author pandas code → iterate on metadata envelope → publish Excel. Invoke when the user asks to produce/generate a clinical listing, run the listing workflow, or when a listing session needs flow discipline in dsh-guard."
---

# 临床 Listing 代码车道流程引导（dsh-guard）

引导 DSH agent 按**代码车道**完成临床 Listing：模型全权理解需求并编写 pandas 变换代码，本地沙箱执行，数据零出域。红线只有两条——**SAS 行级数据**与 **doc/ 外真实数据文件绝不进模型**；doc/ 内规格文本可进模型用于理解需求。

## 触发条件

- 用户要求"生成/产出 listing"、"跑 listing 流程"、"做 Medical/RBQM Listing"
- listing 会话中出现流程漂移（跳过 inspect 直接写代码、反复 publish、把数据值写进回复）时，用本 Skill 校正

## 环境事实（dsh-guard）

| 项 | 值 |
|---|---|
| 工作目录 | `g:\home\dsh-guard` |
| 工作台 | http://127.0.0.1:3080（`start.bat` 启动，首次启动会装依赖，慢属正常） |
| 项目数据根 | `G:\home\Clinical-Data`（项目名=子目录名，动态枚举，勿写死清单） |
| 模式要求 | `uat-local`（不满足时工具返回 `LOCAL_DATA_ACCESS_REQUIRED`） |

## 流程（严格按序执行）

### 1. 识别 doc（规格域判定）
- 只认项目目录下的 `doc/` 为规格域：spec 正文、ALS、模板、要求文档都在这里，**全文可读**
- `doc/` 外的一切 Excel/CSV/SAS 都是数据域：只可见元数据（表头/行数），永不出域
- 拿不准某文件是规格还是数据 → 按**数据**处理（fail closed）

### 2. 调 `clinical_listing_inspect` 读 spec + ALS + schema
- 传参：`project`（相对项目名）、可选 `scenario`、`credentialRef`（无加密归档传空串）
- 从返回读：`documents`（spec 正文/ALS 内容）、`schema`（数据集→字段）、`datasets`（含 `archive/<file>` 成员）、`scenario`/`inferredScenario`、`missing`（如 `credential:<名字>` 表示归档待解密）
- ALS 是**字段目录**（dataset→sourceColumn→label 映射），不承载 New/Modified 等规则语句；规则语句在非 ALS spec 正文里找

### 3. 分析 listing 场景
- 四场景：`medical` / `rbqm` / `manual` / `report`；省略时由 inspect 按路径推断（见 `inferredScenario` 与 `scenarioConfidence`）
- 场景决定 publish 时固定 Writer 的行为：medical/rbqm 自动追加复核列（Flag / Update Details / Review Comments / Initial_Date）

### 4. 找 SAS zip 并确认解密
- inspect 已读归档 central directory：加密打不开的归档出现在 `missing` 里，形如 `credential:<归档相对名>`
- 解法：从本地凭据目录找对应引用（真实项目常见 `<编号>.txt` 单行密码），下次调用传 `credentialRef`
- 密码永不进模型/收据；解压只在 execute 侧最小化发生，模型不感知路径

### 5. 编写 pandas 代码并 `clinical_listing_run_code`
可用能力（收窄到白名单，其余一律被拒）：
- `datasets`：按数据集名取 DataFrame（大小写不敏感），如 `datasets["dm"]`；错误消息会列出可用数据集
- `pd` / `np` / `math` 与纯计算内建（`len/sorted/range/...`）
- 自定义函数、推导式、f-string 都允许

**禁用**（`SANDBOX_CODE_REJECTED` 的常见原因）：
- 任何 `import` / `from ... import`
- 下划线开头的属性或名（`__class__`、`_x`；`_` 占位符除外）
- 文件/网络/序列化 IO：`read_csv/read_excel/to_csv/to_pickle/np.load/open/...`
- 动态执行：`eval/exec/compile/query`
- `global` / `nonlocal` / async

代码约定：必须赋值 `result`（单个 DataFrame）或 `outputs`（`{listing 名: DataFrame}`）。多张 listing 用 `outputs`。

### 6. 按元数据信封迭代
- run 只回**聚合元数据**：每输出的 `rowCount`、每列 `name/dtype/nullCount`
- 用它验证理解：行数对不对（对照 spec 预期/上一版）、列齐不齐、空值是否异常
- 列名/错误文案出信封前会被 scrub；不要试图把数据值放进列名或变量名（会被脱敏，且属违规）
- 迭代上限：默认每会话每项目 200 次 run、50 次 publish（超限 `RUN_BUDGET_EXHAUSTED` / `EXECUTE_BUDGET_EXHAUSTED`），别刷次数

### 7. `clinical_listing_publish` 发布
- 重放**最近一次成功**的代码（不是重写），固定 Writer 产出 `<SCENARIO>_LISTINGS.xlsx`
- 产物位置：`<项目>/.clinical-listing/output/<scenario>/`；含 Contents 目录页（8 列固定表头 + 超链接）与各 listing sheet（表头样式/冻结/筛选/公式注入防护）
- publish 前没有成功 run → `NO_SUCCESSFUL_RUN`；先 run 成功再 publish
- 收据 `dataClass: REAL` 但只回 artifact 元数据；产物内容模型不可读

## 失败码速查

| code | 含义 | 动作 |
|---|---|---|
| `LOCAL_DATA_ACCESS_REQUIRED` | 非 uat-local 模式 | 检查会话/配置模式 |
| `CREDENTIAL_REF_INVALID` / `CREDENTIALS_DIR_NOT_CONFIGURED` | 凭据引用无效 | 核对 credentialRef 与凭据目录 |
| `SANDBOX_CODE_REJECTED` | 代码触发白名单 | 按消息改写（去 import/IO/下划线） |
| `RUN_BUDGET_EXHAUSTED` | run 次数耗尽 | 收敛迭代，直接 publish 最近成功代码 |
| `NO_SUCCESSFUL_RUN` | publish 前无成功 run | 先 run 到 ok |
| `LISTING_INSPECTION_FAILED` | inspect 失败 | 看 reason；多为项目路径/规格解析问题 |

## 纪律（红线）

1. 绝不读取、打印、转述 SAS/XPT 数据行、单元格值或其派生值——反馈只有元数据信封
2. 绝不绕过本地车道（不用通用 shell/读文件工具碰数据域文件）
3. Excel 产物由固定 Writer 写出，模型代码只产 DataFrame
4. spec 理解可以引用 doc/ 原文；数据结论只能引用行数/空值计数等聚合
