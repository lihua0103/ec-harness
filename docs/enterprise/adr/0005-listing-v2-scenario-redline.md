<!--
> **修订横幅(2026-08-28)**:本文红线小节(场景化投影/doc 结构投影)已被 ADR-0006 收敛、
> 再被 ADR-0007 修订为 dataset 单规则 + doc/ 零拦截。沙箱执行安全部分仍有效。
-->
# ADR-0005: Listing 场景化数据红线（按源头判定 + 可关闭开关 + 模板保留）

- 状态：已接受（部分修订——"数据红线"小节与 redactDisabled 工具参数已被 [ADR-0006](./0006-data-guard-two-rules-host-switch.md) 取代；Excel 模板/layout/会话部分继续有效）
- 日期：2026-08-27
- 负责人：enterprise 团队
- 影响范围：`packages/enterprise/listing`（python/ 全栈 + src/index.ts）、`docs/enterprise/LISTING_MULTI_SHEET_SPEC.md`
- 来源：`packages/enterprise/listing/docs/ARCHITECTURE_REFACTOR_V2_2026-08-27.md`（用户 6 条精确化反馈）+ 同日口头澄清；V2 文档中的 ADR-0013~0022 在本仓统一落档为 ADR-0005

## 背景

V1 重构曾把数据安全做成"出口硬拦截 + 字段黑名单"思路，用户给出 6 条
纠正（V2 文档 §0），核心是：全量读取是工程必要（识别表结构才能处理
逻辑）、systemPrompt 模板引导与固定输出模板是输出标准而非写死、红线
应按"读取数据的动作源头"判定而非按字段名、拦截必须可用开关关闭。

实现当日用户进一步澄清范围：**拦截只针对"读取动作回执出域到 AI"这
一个点，其他任何环节不做处理**——sandbox 内 AI 操作（stdout）、AI 自己
的产物、错误消息一律原样；不做全局模式扫描（否则报告日期、USUBJID
列名这类必需信息会被打码，"把 AI 整成盲人"）。

## 决策

1. **源头标注层**（`python/source_registry.py`）：`DataSource` 枚举
   `sas-dataset / spec-document / model-output / derived`；进入回执的
   数据载荷一律带 `_source` 标记；未知源头值在标注期即报错（fail-closed）。
2. **全量读取层**（`python/discovery.py`）：`read_spec_files` 全量读
   txt（≤50K）与 xlsx 整表（结构 + ALS 三元组 + 行值）；`load_datasets`
   全量读 SAS/XPT/CSV 并标注 `sas-dataset`；`list_files` /
   `scan_excel_structures` 作为 sandbox 程序函数预载。`archive_passwords`
   密码推导**保留**（工程现实：密码不在 doc/，AI 无法推断），但密码值
   永不出现在回执。
3. **拦截层**（`python/redact.py`）：`SOURCE_POLICY` 按源头投影——
   `sas-dataset → metadata_only`（列名/行数/dtype/nullCount/uniqueCount）、
   `spec-document → structure_only`（结构/三元组/200 字预览，剥 content/
   rows/values）、`model-output / derived → passthrough`（对象恒等，一字
   不动）。`sanitize_receipt` 是 dispatch 后的**唯一**出口；未标记子树
   返回原对象，不做任何扫描。**无字段黑名单、无 PHI 模式兜底。**
4. **开关**：工具参数 `redactDisabled`（默认 `false`）逐请求透传；为
   `true` 时 `sanitize_receipt` 直接返回原回执，含数据出域在内的全部
   拦截取消。
5. **模板保留**（`python/excel/`）：`style_atoms`（样式常量）+
   `templates`（Content Sheet / Cover Page / ALS 审核列，输出标准）+
   `layout`（`df.attrs["_layout"]` 自定义排版：多层表头/锚点/冻结/返回
   链接/列宽，非法即 fail-closed）+ `build_workbook`（唯一入口）。AI 可
   逐表 `_skip_default_template=True` 跳过模板注入。`styles/` 保留为
   兼容转发层。
6. **sandbox**（`python/sandbox.py`）：builtins 白名单阻断
   `__import__/open/eval` 等**程序执行安全**，独立于 redact 开关；
   stdout/stderr 原样捕获回执（AI 操作回显不出域）。
7. **会话**：`inspect` 全量加载后把数据集留在会话（`run_code` 免二次
   读取）；`run_code` 冷启动自行收集，此时读失败 fail-closed
   （inspect 路径的失败已在回执披露，不重复阻断）。

## 不采用的方案

- **字段名黑名单 + 模式扫描**（V1 方向）：AI 改个字段名即绕过；模式
  扫描会误伤日期/列名等必需信息。按源头判定无法绕过且精确。
- **出口硬拦截不可关闭**：拦截必须可控（用户反馈 6），默认开启、
  `redactDisabled=true` 全放行。
- **删除固定模板 / 删除密码推导 / 限制全量读取**（V1 误判）：Content
  Sheet / Cover Page / ALS 审核列是输出标准；密码推导是工程必要；
  全量读是表结构识别的前提。
- **stdout 脱敏**（V2 文档遗留表述）：sandbox 内 AI 操作不构成"出域
  到 AI"，按同日澄清不处理。

## 数据与安全

- 出域点唯一：读取动作的回执。默认形态下 AI 可见：列名、行数、dtype、
  null/unique 计数、spec 结构、ALS 三元组、200 字预览、自身产物与
  stdout。行值与全文仅 `redactDisabled=true` 时回执。
- `redactDisabled=true` 时回执含真实数据（sas head 样本 + spec 全文 +
  整表行值），调用方（宿主/用户）承担该授权。
- sandbox 执行安全（无 import/文件 IO/动态执行）不受开关影响。
- ZIP 解压走成员越界校验（Zip Slip）与密码候选爆破，密码值不回执。

## 升级影响

- 上游 Harness 无改动（仍是 tools/systemPrompt 挂载）。
- `python/` 新增 4 模块 + `excel/` 包；`styles/` 变兼容层；既有导入
  路径不破坏。
- Excel 默认输出与既有规范逐字节一致（worker.test.ts 精确断言通过）；
  仅新增 `_layout` / `_skip_default_template` 两条 AI 自由度通道。

## 后果

正面：红线从"内容猜测"变为"来源判定"，不可绕过且不误伤；AI 在默认
形态下仍具备写代码所需的全部结构信息；开关语义简单（一个布尔）。

代价/权衡：`inspect` 全量加载大 SAS 数据集的内存与耗时进入首跳（但
会话复用避免了二次读取）；自定义 layout 页重跑不参与行级变化比较；
`redactDisabled=true` 是显式授权的数据出域，审计上应记录调用方。

验证：pytest 74 项（tests/）+ vitest 17 项（含端到端红线与精确模板
断言）+ 变异测试报告见交付文档。
