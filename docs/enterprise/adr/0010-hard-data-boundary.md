# ADR-0010: 宿主开关硬数据边界与 doc 全量分片

- 状态：已实施（2026-08-28）；修订（2026-09-03，见文末"修订记录"）
- 日期：2026-08-28
- 负责人：企业插件组
- 影响范围：listing Python/TS、tool-audit、ui-settings、企业文档与测试
- 取代：ADR-0007 与 ADR-0009 中与本文冲突的数据可见性、stdout 与配置口径；二者与本文不冲突的执行自由、Excel 安全与运行时健壮性决策继续有效

## 背景

临床项目中有两类真实数据值在拦截开启时不能进入 AI 上下文：

1. SAS/XPT/CSV 数据集（含归档解出）的原始行值；
2. `doc/` 外 spec 需求辅助 Excel 的业务单元格值。

同时，`project/doc/**` 是需求理解域。spec、ALS、template、DVP manual review、二进制模板等所有文件都必须完整进入 AI 上下文，AI 才能识别表单字段和处理规则。对 doc 文件做摘要、字段投影、内容模式扫描或扩展名切分，都会破坏需求理解。

数据安全开关是宿主能力：默认开启；部署方显式关闭后，系统不做任何形式的数据拦截。模型请求、工具参数和系统提示不能关闭或开启该开关。

## 决策

1. **项目文件角色按顶层路径优先分类**：
   - `doc/**` 是 `spec-document`，即使文件扩展名是 `.csv`、`.xlsx` 或未知二进制；
   - `.clinical-listing/output/**` 是系统交付物；
   - `.sas7bdat/.xpt/.csv` 是数据集；
   - `doc/` 外 `.xlsx/.xls/.xlsm` 是辅助 Excel；
   - 其他文件为普通文件。
2. **doc 全量分片，不截断**：`listing_inspect` 只返回 `requirementDocuments` manifest；模型必须用 `listing_read_document(documentId, chunkIndex)` 从 0 读到 `isFinal`。每个文件先无损解析为 canonical JSON，再按 256K 字符分片；分片按顺序拼接并 JSON parse 后得到完整对象。未知或二进制 doc 文件以 base64 完整承载，不允许静默丢弃。该行为与开关无关，因为 doc 是需求输入，不属于拦截域。
3. **开关开启时固定两类数据值投影**：数据集回执只构建元数据（name/path/columns/rowCount/dtypes/nullCount/uniqueCount）；doc 外辅助 Excel 只构建结构、统计与 ALS 三元组，不构建业务 rows。原始数据集仍完整加载进 Worker 会话供 sandbox 计算。
4. **开关关闭时零拦截**：数据集行值、doc 外辅助 Excel rows、run_code stdout/stderr、动态异常文本、输出名与列名均按 Worker 原始结果回执；tool-audit 对所有通用工具放行。关闭状态是部署方显式选择，不设置二级内容扫描或部分拦截。
5. **开关开启时封模型可控出口**：`run_code` 的 stdout/stderr、动态异常文本、输出名和列名都不进入回执。它们不是内容扫描对象，而是根本不构建对应载荷；发布回执只含路径、场景、格式和数量。
6. **listing sandbox 执行面全开**：标准 Python builtins、任意 import、open/eval/exec、DataFrame 读写方法均可用。执行层不做数据红线判断；红线在 Worker 回执构建与通用工具出口。
7. **通用工具出口双层 fail-closed（2026-09-03 第二次修订）**：开关开启时通用工具受两层防护——
   （a）**窄版 pre-execute 路径拒绝**：monotonic guard 在通用工具参数中**正向命中**数据集/归档/doc 外辅助 Excel 文件引用时拒绝（附改道 listing 车道指引）；内容型参数（write/edit 的 content、old/new_string 等）、enterprise_* 车道、参数不可解析、doc/与系统输出引用一律放行——拒绝面收敛到"显式要读数据集文件"这一高精度形态；
   （b）**post-execute 值级扫描**：结果文本经专用扫描 Worker（独立进程，常驻保护值哈希、不持有数据）做精确值+相邻 bigram 匹配，命中整体拦截。扫描与主车道计算分进程，不再被长 run_code 阻塞（首次实测暴露的批量误拦根因）。内部控制工具按精确名单（`plan`/`todo_write`）豁免；`additionalContexts` 旁路面一并扫描。服务未装配或读取失败按开启处理。
8. **无额外内容拦截**：开关开启时也只拦截上述两类数据值及其直接旁路面；不做 PHI/日期/ID 等内容模式扫描，不因普通文件内容拦截工具调用。doc/ 防洗白（修订决策 10）是唯一例外，且只作用于会话建立后新增/改写的 doc 文件。
9. **配置只保留 `enabled`**：`.data-security.json` 仅持久化布尔值，默认 `true`；历史扩展名键忽略，非法或损坏配置回落开启。扩展名与两类角色固定在代码中，宿主不能增删拦截对象，模型不能伪造开关（当前进程内）；配置文件落盘改动在下次启动加载时写入审计（`event: load`）。
10. **doc/ 防洗白（2026-09-03 新增）**：会话建立时登记 doc/ 文件指纹基线（size+mtime_ns）。基线内的项目原始输入直接信任、永不扫描——doc/ 全量可读的需求域语义不变。会话期间新增或被改写的 doc 文件（run_code 可经 `open()` 写入）在 `read_document` 出域前做保护值精确匹配：命中即拒绝（`PROTECTED_DOCUMENT_CONTENT`），inspect 重复装载时命中文件剔除并记入失败清单。这不是内容模式扫描，只覆盖两类受保护值的精确表示。

## 不采用的方案

- **doc 按扩展名或内容分类**：会把 `doc/spec.csv`、模板文件和二进制需求材料错误踢出需求域。
- **摘要/预览代替全量读取**：无法保证 AI 理解全部表单字段与业务规则。
- **模式扫描兜底**：误伤合法需求文本，且不能可靠判定临床数据；本边界按源头与路径角色判定。
- **可配置扩展名**：会把固定红线变成可删减状态，出现配置漏拦。
- **关闭后部分拦截**：违反部署方“关闭 = 不做任何形式拦截处理”的终裁。
- **限制 listing sandbox 执行面**：会破坏查询、聚合和动态处理能力；通用绕过防线放在通用工具出口。

## 数据与安全

- Listing 投影审计写入 `<project>/.clinical-listing/audit.jsonl`；tool-audit 拒绝审计写入 `<project>/.clinical-listing/tool-audit.jsonl`。两者只含时间、工具、操作码、source/pathClass/path/project，不含业务数据值。
- ui-settings 开关审计写入 `$DSH_HOME/profiles/enterprise/.data-audit.jsonl`，只含时间、事件与布尔状态。
- Worker spawn 使用最小环境并强制 UTF-8；`.credentials.yaml` 不读取、不输出，归档凭据只按引用进入解压流程。
- `upstream/` 保持只读；真实临床项目与仓库分离。

## 升级影响

Listing 新增第 4 个模型工具 `enterprise_listing_read_document`，Agent 生命周期内复用同一个 Python Worker。TS 入口每次调用读取 `dataSecurityService.isEnabled()`，并以内部 `hostDataInterception` 字段下发 Worker；模型可见 schema 不含开关。tool-audit 改用官方 monotonic `tools.guard()`，后续 pre-execute listener 不能把拒绝改成允许。ui-settings 恢复设置页开关与 GET/POST API，但移除扩展名配置。

## 验证

- Python：`python -m pytest packages/enterprise/listing/python/tests -q`，148 通过。
- Listing TS：`CI=true corepack pnpm --filter @dsh-enterprise/listing test`，24 通过。
- tool-audit TS：`CI=true corepack pnpm --filter @dsh-enterprise/tool-audit test`，16 通过。
- ui-settings TS：`CI=true corepack pnpm --filter @dsh-enterprise/ui-settings test`，5 通过。
- 收口门禁：`CI=true corepack pnpm run check:all`，已通过（lint、typecheck、workspace/root 测试、architecture、secrets、Python dependencies、upstream、profile verify）。

## 修订记录

### 2026-09-03：通用车道防线改为值级扫描 + doc 防洗白（全系统审计后修订）

事实：commit `61dc8a9` 曾实现决策 7 的 pre-execute 路径拒绝；随后改版将 guard 改为恒放行、防线移至 listing 宿主 post-execute 值扫描，但当时未修订本 ADR，造成"代码、ADR、系统提示词"三方口径失配（2026-09-03 全系统审计 P0）。本次修订把已实施的机制如实立档，并补齐配套收口：

1. **决策 7 重写**（如上）：值级 post-execute 扫描是通用车道防线，精确值哈希匹配，命中整体拦截。选择理由：仅按路径拦截对元数据/普通执行结果误伤率高；值级扫描只拦两类受保护值的精确表示，其余全放行，与"红线之外全权交给 harness"的业务口径一致。
2. **新增决策 10**（doc 防洗白）：封堵 run_code 写 doc/ 再 read_document 回读的行值洗白通道；原始 doc 输入零影响。
3. **如实登记残余风险**（非对抗威胁模型下的接受面）：
   - R-4 初始化窗口（2026-09-03 收窄）：pre-execute 窄版路径拒绝恢复后，"参数显式引用数据集文件"的通用调用在任何阶段都被拒；残余窗口仅剩"不写路径的间接读取"（如通用 shell 读无扩展名拷贝、子代理结果回传），由 post-execute 值扫描覆盖——但值扫描要求保护值索引已建立（任一 listing 工具成功调用后预热专用扫描 Worker）。部署方如需彻底封闭，应在部署配置锚定默认项目并由宿主预热扫描 Worker。
   - R-5 匹配精度：精确值+bigram 匹配对改写/编码/拼接后的派生值不敏感；系统提示词已明示模型不得变换数据值绕行。
   - R-6 执行自由与网络出域（承 ADR-0009 R-1/R-3）：doc/ 全量入上下文 + 执行面全开 + 出域不封的组合，依赖 doc/ 输入来源可信；CRO/供应商外部交付材料建议在部署侧做输入审查。
   - R-7 上游 spill 落地（2026-09-03 实测新增）：官方 harness spill policy 把超大工具结果写到 `%TEMP%/dsh-spill-*`，其中 `enterprise_listing_read_document`/`inspect` 的 spill 含 doc 全量业务值与数据集元数据，且上游无清理机制（实测跨会话累积数百 MB）。缓解：listing 插件启动时回收超过 6 小时的 `dsh-spill-*`/`dsh-listing-*` 目录（企业层补偿，不改上游）；`pnpm run clean:data` 提供 opt-in 的会话/缓存/临时数据保留清理。残余：存活会话内的 spill 文件在会话期间可被通用 shell 读取——精确值扫描会拦截原值输出，但转码输出（base64 等）不可拦，按非对抗模型口径接受并登记。
4. **配套收口（同日）**：内部工具豁免改精确名单（plan/todo_write）；`project` 参数 host 侧锚定（一会话一项目，拒绝换绑与任意目录）；`read_document` 分片出域前基线比对；设置页开关与 GET/POST API 恢复（写操作须 `X-DSH-Settings: 1` 头，V-6 口径）；开关加载/变更全部入审计；worker 崩溃 stderr 只进日志不回模型；back_link 公式收紧为字面量形态；ZIP 解压预算与 SpreadsheetML 列上限；run_code runner `stdin=DEVNULL` + 自杀超时；`_source` 属性不接受模型重贴；check_deps 版本强制。
5. 决策 9 补充：模型在当前进程内仍不能伪造开关；配置文件落盘篡改在下次启动以 `event: load` 审计留痕（明文文件可被本机进程改写是 ADR-0009 R-1 的既接受面）。
