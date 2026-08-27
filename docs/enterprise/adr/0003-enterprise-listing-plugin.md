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

### 2. 持久会话直执行替代沙箱代码车道

`run` 操作把模型代码 `exec` 进共享命名空间（`datasets` / `pd` / `np` /
`save_listing`），会话状态跨调用保持，stdout 全量回传（100KB 截断）、
`result` 变量带 DataFrame 摘要与前 50 行预览。原实现的"无状态子进程 +
重放最近成功代码 + publish"三段合同随之退役：交付物由代码内
`save_listing()` 即时产出。超时由 TS 宿主控制（杀进程、状态丢弃、
回执 retryable，重新 inspect 恢复）。

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
引导（inspect → 迭代 → save_listing）是本插件的全部挂载点；不触碰
`tools/*` 事件与 `llm/stream`。

### 6. 输出规范：驱动 AI 实现，程序不写死（2026-08-26 定稿）

开发原则（用户定调）：**所有代码开发都不能写死定义，智能体插件要最大
程度利用 AI 推理**。输出规范以"材料 + 说明"供给模型，由模型在生成代码
时自行落实；程序只保留机械交付职责（`python/output_spec.py` 提供识别
材料与可选辅助函数，`save_listing` 保留写出/样式/变化记录）：

1. 系统字段判定：**SAS 数据集列 − ALS 映射字段 = EDC 系统字段**（ALS
   定义表单业务字段，多出的即系统附加列；各 EDC 系统 raw data 列名
   不同，内置角色别名表仅是排序辅助与可配置提示，`edcAliases` 支持
   企业自有别名扩展）。系统多字段组合确定数据唯一标识；系统列前置
   保留原列名。**程序绝不去重**——数据完全按 spec 需求输出。
2. 输出列（rbqm 除外）：template 优先，否则 ALS 字段列 + PreText 表头；
   rbqm 按会话提供的需求执行。均为模型代码职责。
3. 重跑变化记录（DM 审核口径）：`save_listing` 与上一版按唯一键计数
   diff（同键多行按行数增减），新增/删除/字段变化（旧值→新值）写进
   Contents 页——这是交付物的固定机械机制，保留在程序侧。

## 后果

- 企业 row 增至 5 个；`scripts/` 一行未改（自动发现）。
- Python 运行时成为部署前提（pandas / openpyxl / xlrd），缺解释器时
  工具回执 `PYTHON_NOT_FOUND` 并附安装指引。
- 会话状态在 worker 进程内：宿主重启或超时杀进程后丢失，模型需重新
  inspect（引导提示已写明）。多会话并发各自独立 worker 进程。
- `.listing-output` 与 `_work` 已列入扫描忽略目录，解压产物不回流进
  数据集索引。
- 原分支的 `emerald-clinical-data-guard` 其余部分（出域开关、设置页
  UI、post-execute 投影）仍待各自的迁移决策；若未来迁入，与本插件
  在工具命名空间上不冲突（本包工具带 `enterprise_listing_` 前缀）。
