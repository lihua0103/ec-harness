# 数据出域拦截开关重构计划

日期：2026-08-25  
状态：已完成  
范围：`dsh-clinical-data-guard` 插件的运行态策略、模型出域钩子、Listing 工作流引导与相关测试

## 1. 背景与目标

当前实现同时存在 `DATA_PROTECTION_ENABLED`、`DATA_INTERCEPTION_ENABLED`、
`mode` 与 `localDataAccess`。这些配置分别影响 Node 钩子、Python worker、工具注册、
结果投影和代码沙箱，导致“数据出域开关”没有唯一、稳定的业务语义。

本次重构把开关收敛为一个明确策略：

> `dataInterceptionEnabled` 只决定模型出域边界是否检查、阻断或投影真实数据；
> 不决定 Listing 工具是否注册，不决定 Harness 工作流引导是否注入，也不代替
> 本地执行进程的基础隔离。

目标行为：

1. 开启：用于正式项目。任何准备进入模型上下文的工具结果和最终 LLM 请求都经过
   数据出域检查；真实 data 值不得发送给 AI。
2. 关闭：用于测试或非敏感项目。插件不执行数据出域扫描、投影或阻断，内容按
   DeepSeek Harness 原生链路传递。
3. 无论开关状态：Listing 工具、工具说明及 inspect -> run -> iterate -> publish
   工作流引导始终注册并生效，由 Harness 自主理解需求和编写处理代码。

## 2. 非目标与保留边界

- 不重写 Listing 业务实现、数据目录、Writer 或归档处理流程。
- 不移除子进程隔离、工作目录约束、结构化协议、进程超时等宿主稳定性边界。
- 不引入新依赖，不改变 DSH/Cordis 插件入口合同。
- 不把 `localDataAccess` 当作数据出域开关。它只保留为本地数据能力配置；插件包的
  Listing 工具和引导注册不再由它静默裁剪，执行时缺少能力则返回结构化错误。
- 不为无法从当前 DSH WebServer API 证明的管理员身份机制自造认证体系；设置接口
  实施同源、方法、媒体类型、载荷大小与严格 schema 校验，并记录策略变更。部署层
  身份授权仍由宿主 Web 服务负责。

## 3. 当前根因

### 3.1 多个状态源

- `validateConfig()` 解析 `raw.dataProtectionEnabled`。
- `branding.js` 用模块加载时环境变量初始化另一个全局布尔值。
- Web PUT 只改变 Node 内存值。
- Python `code_sandbox.py` 读取 worker 启动时继承的环境变量。

结果是配置、UI、Node 钩子和 Python 深层行为可能处于不同状态。

### 3.2 策略与能力耦合

`registerClinicalListingPlugin()` 在 `localDataAccess !== "uat-local"` 时整体返回，
同时取消工具注册和 system prompt，引导流程没有架构级保证。

### 3.3 流程提示与出域政策耦合

固定提示同时描述工具流程和“模型绝不能读取数据”的开启态政策。关闭开关后提示仍
要求执行开启态限制，与运行策略冲突。

### 3.4 `mode` 与开关语义重叠

`mode` 只影响部分执行分支；`disabled` 不能关闭全部 Node 钩子，且要求审批字段。
这使同一业务状态出现多种无法等价组合。

## 4. 目标架构

### 4.1 单一运行态策略

新增 `DataInterceptionPolicy`：

- 由已验证插件配置初始化一次。
- `isEnabled()` 是 Node 全部出域钩子的唯一读取入口。
- Web 设置调用 `setEnabled()` 更新同一实例。
- 每次发往 Python 的相关请求通过 `context.dataProtectionEnabled` 携带即时快照。
- 保留旧环境变量作为启动兼容输入，但不再作为深层运行态真源。

### 4.2 三个职责平面

| 平面 | 开关开启 | 开关关闭 |
|---|---|---|
| Harness 工作流 | 始终注册工具和流程提示 | 始终注册工具和流程提示 |
| 模型出域策略 | post-result 投影；llm/stream 最终检查；必要的来源识别 | 全部旁路 |
| 本地执行隔离 | 始终保留进程与路径等基础边界 | 始终保留进程与路径等基础边界 |

工具执行前不再进行与模型出域无关的通用“危险操作”阻断。数据保护的强制点收敛到
工具结果进入模型上下文和最终模型请求两个边界。无行为的 `quickGuard` 与
`tools/pre-execute` 注册已删除，避免形成虚假安全边界。

### 4.3 提示拆分

- 永久 section：描述 inspect -> run -> iterate -> publish、工具参数和反馈使用。
- 不把运行态开关值写入静态 system prompt，避免会话中切换后产生陈旧政策。
- 开启态安全由代码边界强制执行，不依赖模型遵守提示。

### 4.4 设置接口

- 只接受 `PUT application/json` 和严格的 `{dataInterceptionEnabled: boolean}`。
- 限制请求体大小，拒绝额外字段、缺失字段和错误类型。
- 校验浏览器同源信号，拒绝明确的跨站请求。
- 返回 `no-store`，策略变更写入结构化审计日志，不记录任何临床数据。

## 5. 实施步骤

1. 新增策略模块并以配置初始化，兼容旧环境变量。
2. `branding.js` 改为依赖注入策略实例，不再拥有独立全局状态。
3. `index.js` 全部门控和 Python context 改读策略实例；移除 `mode` 对开关的控制。
4. 删除工具参数 DLP 与通用 pre-execute 阻断，只保留模型边界的 post/stream 强制。
5. Listing 工具和永久流程提示无条件注册；执行能力错误在调用时结构化返回。
6. 将提示改为中性的 Harness 工作流说明，移除与关闭态冲突的固定政策文字。
7. Python 代码沙箱不再读取 `DATA_PROTECTION_ENABLED`；基础执行隔离始终一致。
8. 设置接口增加严格输入、同源和审计控制。
9. 补齐运行态开关矩阵测试并执行仓库要求的回归套件。

## 6. 验收矩阵

| 编号 | 场景 | 期望 |
|---|---|---|
| A1 | 配置显式关闭、环境未设置 | UI、Node 钩子和 Python context 均为关闭 |
| A2 | 旧环境变量关闭 | 启动时关闭，兼容既有部署 |
| A3 | Web 从开切到关 | 不重启 worker；下一次 post/stream 立即旁路 |
| A4 | Web 从关切到开 | 下一次 post/stream 立即执行出域保护 |
| A5 | 开启态 data 工具结果 | 原始 data 值不进入模型内容 |
| A6 | 开启态受保护来源进入 LLM | 最终发送前阻断 |
| A7 | 关闭态相同内容 | 插件不扫描、不投影、不阻断，原样转发 |
| A8 | 开启/关闭两态 | 三个 Listing 工具均注册 |
| A9 | 开启/关闭两态 | 永久工作流 section 均注册且不含陈旧开关政策 |
| A10 | `localDataAccess` 非 uat-local | 工具与引导仍可发现；调用返回能力错误 |
| A11 | 非法设置载荷 | 400/413/415，不改变当前状态 |
| A12 | 明确跨站设置请求 | 403，不改变当前状态 |
| A13 | 旧 `mode` 配置 | 配置、worker context 与 shadow 分支全部移除，不形成第二个开关 |
| A14 | 关闭态模型代码 | 不因出域环境变量产生不同 AST 规则 |

## 7. 测试计划

- 单元/集成：策略初始化优先级、状态切换、订阅/审计行为。
- Branding 集成：GET/PUT、严格载荷、大小限制、媒体类型和跨站拒绝。
- 插件集成：同一插件实例内动态开关，验证 post 与 llm/stream 下一请求生效。
- 插件合同：工具与 system prompt 永久注册，旧双真源引用消失。
- Python 单元：代码沙箱行为不再受 `DATA_PROTECTION_ENABLED` 环境变量影响。
- 回归命令：
  - `python -m pytest dsh-clinical-data-guard/tests/unit/ -v`
  - `python dsh-clinical-data-guard/tests/run_all.py`

## 8. 风险与回滚

- 风险：移除 pre-execute 通用阻断会扩大 Harness 的本地操作自由度。这是本次需求的
  明确目标；模型出域仍由 post-result 与 llm/stream 双边界保护。
- 风险：运行态开关是进程级策略，同实例多项目共享。当前 UI 和宿主没有可靠项目
  策略持久层，本次不伪造项目级隔离；正式部署应使用独立实例或后续接入宿主会话
  配置存储。
- 回滚边界：策略模块、三个 Node 消费文件、代码沙箱的一处环境分支和对应测试。
  不涉及数据迁移或外部状态。

## 9. 交付记录

### 9.1 实际变更

- 新增 `src/data-interception-policy.js`，以单个进程内策略实例统一配置、设置接口、
  Node 钩子和 Python 请求 context 的即时状态。
- `src/index.js` 将显式 `dataInterceptionEnabled` 设为最高优先级，并兼容旧
  `dataProtectionEnabled` 与环境变量启动默认值；删除旧 `mode`、无行为的
  `quickGuard`/`tools/pre-execute` 注册，强制点收敛到 `tools/post-execute` 与
  `llm/stream`。
- `src/branding.js` 删除模块级开关状态，GET/PUT 直接读写注入的策略实例；设置接口
  增加严格 JSON schema、媒体类型、1024 字节大小、明确跨站请求和 `no-store` 控制。
- `src/clinical-listing-plugin.js` 无条件注册 inspect、run-code、publish 三个工具和
  中性工作流提示；缺少本地能力时在调用阶段返回 `LOCAL_DATA_ACCESS_REQUIRED`。
- `security/code_sandbox.py` 删除由 `DATA_PROTECTION_ENABLED` 控制 AST 检查的旁路，
  保证本地执行隔离在两种出域策略下始终一致。
- 更新 Branding、插件运行态、旁路矩阵和沙箱测试；新增策略单元用例，并纳入仓库
  测试编排。

### 9.2 无用代码清理

- 删除生产不可达的 worker operation：`check_tool`、`scrub_row`、`inspect_file`、
  `authorize`、`consume_authorization`，以及仅服务这些分支的 XLS 适配器。
- 删除无生产调用的 `ai_operations_monitor.py`、`data_egress_guard.py`、
  `egress_authz.py` 和整条 L3 审批/一次性授权链。
- 删除无运行时消费者的 Node `scanDlp`/`scanDlpDetailed` 及专属测试；保留生产仍使用
  的 `redactSensitiveText` 错误净化。
- 删除过期的 pre-hook、审批、旧 operation、旧 monitor mutation/bypass 测试，现有
  测试只锁定真实运行边界。

明确保留并继续测试的生产能力：

- 固定 Excel Writer 与模板规范：CONTENTS、复核列、样式、冻结、筛选、公式注入
  防护和原子发布。
- EDC 系统字段识别与 canonical 角色映射。
- XLS/XLSX/CSV 智能表头识别、无表头降级和结构元数据提取。

旧 `data_egress_guard.py` 的删除不影响智能表头：表头唯一实现已经收敛在
`security/header_detect.py`，并由 `local_data_inspector.py` 与
`listing_executor.py` 直接调用。

### 9.3 验证结果

- `python -m pytest dsh-clinical-data-guard/tests/unit/ -v`：`177 passed`；存在 3 个
  已有警告，无失败。
- `python dsh-clinical-data-guard/tests/bypass/test_bypass_matrix.py`：
  `PASS BY-1..BY-13`，`RESULT 1/1`。
- `python dsh-clinical-data-guard/tests/run_all.py`：所有编排套件通过，最终
  `TOTAL_FAILED_SUITES=0`。其中插件集成 `42/42`、安全用例 `72/72`、Listing 计划
  `43/43`、Listing 安全 `28/28`、Listing 修复 `19/19`、韧性 `4/4`、扫描 DLP
  `23/23`，Branding、插件合同、安装 smoke、旁路矩阵和 planes 均通过。
- 静态残留搜索未发现 `getDataInterceptionState`、`setDataInterceptionState`、
  `config.mode ===` 门控或沙箱环境开关旁路；`git diff --check` 无空白错误。

### 9.4 实施偏差

- 无需求语义偏差。无行为的 `quickGuard` 与 pre-execute 钩子已直接删除；宿主实际
  运行合同只保留 post-execute、llm/stream、工具注册和工作流提示。
- `local_data_metadata` 仍由 `localDataAccess` 控制注册，因为它是独立的辅助元数据
  能力；三个 Listing 工具及 Harness 工作流引导已按要求恒定注册。

### 9.5 残余风险

- 策略仍是插件进程级状态，而非项目或会话级状态。同一进程承载不同敏感等级项目时，
  应部署独立实例；后续若宿主提供可信会话配置存储，可再升级为会话级策略。
- 当前宿主 WebServer 扩展接口没有可证明的管理员认证 API。本次已实现同源、方法、
  媒体类型、载荷大小、严格 schema 和审计控制；操作者身份授权仍需部署层保障。
- 完整测试中仍会报告既有 Excel 文件句柄 `ResourceWarning`，不影响退出码和本次功能
  验收，但建议由该测试夹具所有者后续关闭工作簿句柄。
