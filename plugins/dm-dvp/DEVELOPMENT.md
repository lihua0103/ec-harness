# dm-dvp 开发与边界记录

延续 dm-listing 的验证文化：不伪报测试通过、不把目标文档当已实现代码、生成物永远标注候选状态。

## 2026-11-24 输入发现、通用工作簿读取与员工入口（v0.3.9）

- **来源**：真实工作台会话（工作"dvp生成式训练"）里，用户要求"读取当前目录方案以及 ALS excel 生成 DVP"。
  模型自行加载了 dm-dvp 技能并成功调用 dm_dvp_read_protocol / dm_dvp_methods / dm_dvp_overview，但随后连续调用
  并不存在的 dm_dvp_read_als / dm_dvp_list_files / dm_dvp_scan（全部 UNKNOWN_TOOL），最后停下向操作者要路径。
  同一会话的输入框只看得到 dm-listing 的入口（dm-dvp 此前没有客户端部分）。
- **新增宿主工具**（`src/inputs.ts`；注册工具 12 → 14，README 工具表 11 → 13 行）：
  - `dm_dvp_scan`：列出目录内方案 PDF / 可读工作簿 / 旧版或二进制工作簿的存在、大小、修改时间，不读内容；
    其他类型按扩展名计数；不跟随符号链接，跳过点开头目录与 node_modules；`recursive` / `maxDepth` 控制范围；
    相关文件 500 个、遍历 20000 项封顶并在 notices 标明。
  - `dm_dvp_read_workbook`：读取非 DVP 模板工作簿（ALS / 数据库结构等）的任意 sheet；省略 sheetId 返回清单；
    `startRow`/`endRow` 行窗口；单次过大返回 `SHEET_TOO_LARGE_USE_WINDOW`。
- **边界不放松**（parse.ts 头注、DVP-TEMPLATE-SCHEMA §8）：含 DVP 规则 sheet（Edit Checks / Field Level / Manual Review*）
  的工作簿一律 `DVP_TEMPLATE_USE_DEDICATED_TOOLS`，连清单也不给——Cover 永不读、Approval 不读、TEST CASE 只计数只由
  overview / parse 保证；任何工作簿里名为 Cover / Approval 的 sheet `SHEET_CONTENT_NOT_READ`；dynamic / version history
  名称单独出现不构成模板。`locateInsideDirectory` 从 parse.ts 导出共用；`.xls` 的 `WORKBOOK_NOT_XLSX` 现在带"另存为 .xlsx"
  的说明（旧版二进制格式不在公共包 platform-workbook 的支持范围，属已知限制）。
- **员工入口**：新增浏览器端 `src/client/index.ts`（`dsh.client.platform: web`、`exports["./client"]`），挂在公开的
  `conversation.input.right` 列表槽位（`conversation.input.activity` 是单占位，已由 dm-listing 占用）。点击把 DVP 可用
  能力清单插入输入框（zh/en 随宿主语言）；提示词里的工具名与 `dm_dvp_status.tools`、实际注册的一致性由测试锁定。
  会话属于另一项应用时入口隐藏：工作台把"当前会话所属应用"作为平台事实经上游根标准工具包公开
  （`useConversationApplication`：`slots.provideRoot` + `GlobalStandardProps` 声明合并），本插件只比较自己
  application.json 的 appId；没有该事实（历史会话、不在工作台里运行）时照常显示。**未改上游 Harness 源码。**
- **其他**：`dm_dvp_status` 的版本改为读随包 package.json（原硬编码 0.3.0）并导出 `DVP_PLUGIN_VERSION`；`tools` 清单
  补齐两件新工具；技能正文补输入发现与读取能力及其边界；`knowledge/manifest.json` 为两件新工具声明 `noMethodKnowledge`
  及理由（目录发现与通用读取没有 DVP 方法语义；"从 ALS 推导字段级规格"若有方法可另行沉淀为候选种子）。
- **升版本原因**：lib 字节变化（新增 `lib/client.js`、host 重新构建）会改变发布 `artifactDigest`；0.3.8 已登记
  （控制面库摘要 `962b798b…`），同版本换摘要重新登记会被 `APP_RELEASE_CONFLICT` 拒绝，因此升 0.3.9。
- **构建与发布流水线**：`build.mjs` 增加客户端 client-module factory；`scripts/release-lib.mjs` 的候选包加入
  `package/lib/client.js`（校验清单放行并要求它）。新增开发依赖（react、@types/react、五个 @deepseek-ai 客户端包，
  均为指向 upstream 的 link，不打包）。
- **验证**（2026-11-24，Node 24.9.0）：tsc 通过；测试 95/95（新增 `tests/inputs.test.ts` 9、`tests/client-entry.test.ts` 6）；
  host/client bundle 构建；`scripts/check-development-standard.mjs` 通过；候选包 build → verify 通过
  （CANDIDATE / NOT_APPROVED / 无分发阻断项；仅验证流水线，未批准、未入 `.runtime/candidates`）。
  隔离环境浏览器实测（3091→3097，合成应用与数据）15/15：DVP 工作会话只显示「DM DVP」且可插入能力提示词、
  不显示 DM Listing；Listing 工作只显示 DM Listing、不显示 DM DVP；历史会话两者并存；无页面报错。
- **未执行**：真实模型用新工具完成一次 DVP 任务（目录扫描 → 读 ALS → 生成）；旧版 `.xls` 的读取（不支持，需转存）；
  四应用重登记后的正式环境验证；临床验收。
- **既有缺口（本轮未改）**：候选包不含 `application.json` 与 `knowledge/`，而 `apply` 会读 `knowledge/manifest.json`、
  发布装配会读 `application.json`——当前部署经 link 使用源码目录所以无碍，候选包单独安装前需补齐。

## 2026-11-11 整改（v0.3.0）

- **PDF ObjStm 修复**：对象流头是「对象号 偏移」，旧实现把偏移误当对象号，压缩页对象不可达；生产形态 PDF
  会静默丢页。现按对象号/偏移正确展开，并记录 `objectStreams/objectStreamObjects/objectStreamFailures`。
  新增页树 `/Count` 与实际解析页数核对（`PAGE_TREE_INCOMPLETE`）、缺失页对象/内容流诊断与
  `PAGE_COVERAGE_INCOMPLETE` notice；不完整时明确提示核对原件，不再静默当作完整方案。
- **真分页**：`parseDvpWorkbook` 新增 `section` + `offset`，`stats.paging[section].nextOffset` 可续读；
  `sections[role].returned/total` 为实际页与全量统计；`offset` 必须配 `section`（`PAGING_SECTION_REQUIRED`）。
- **知识验证语义**：验证器新增 `coverage`，候选新增 `claims`。固定用例通过只记 `TOOL_REGRESSION_ONLY`；
  只有候选声明的全部 claims 被覆盖且用例通过才 `ACTIVE`（`CONTENT_CLAIMS`），回执记录已验证 claims。
  新增窄种子 `dm-dvp.changemark.format` 作为可复现激活示例；宽方法种子保持 CANDIDATE。
- **公共能力抽离**：Workbook 读取迁至 `packages/platform-workbook`；知识服务 Cordis 适配迁至
  `packages/platform-knowledge` 独立 bundle，Listing/DVP 的 patch 不再安装知识服务。DVP 不再引用
  dm-listing 源码，`tests/independence.test.ts` 验证单独装配。
- **验证**：`npm run verify` 68/68 通过、tsc 通过、bundle 构建通过。PDF 修复使用合成 ObjStm 夹具，
  未用真实项目资料；DSH Web 插件页确认 DVP 与平台包均安装启用，但未发送模型业务请求或做临床验收。

## 验证

```bash
cd plugins/dm-dvp && pnpm install
```

```bash
cd plugins/dm-dvp && PATH="/d/package/Nvm/nvm/v24.9.0:$PATH" npm run verify
```

Node 24.9.0（绝对路径 `D:/package/Nvm/nvm/v24.9.0/node.exe`；不切换全局默认 22）。pnpm 走仓库既有缓存。
只有 `upstream/` 是 git 仓库；本插件改动不是 git diff。发布候选链路（build→verify→approve）见 README。

## 模块图（刻意保持的形状）

- `src/rules.ts`：IR + 诊断 + 外部输入宽容归一。零依赖（除 firewhen），可独立测试。
- `src/firewhen.ts`：公司 `fire when` 方言解析器。零依赖。
- `src/parse.ts`：sheet 角色分类 + 列关键词映射 → IR。依赖平台公共包 `packages/platform-workbook` 与 rules；不引用 dm-listing 源码。
- `src/input.ts`：人工评审行的宽容归一（TEST CASE/评审意见只留计数）。
- `src/cases.ts`：用例候选生成。依赖 firewhen + rules 类型。
- `src/render.ts`：fire-when AST → 目标 EDC 配置参考（rave-steps / generic-expression）。
- `src/write.ts` + `src/xlsx-out.ts`：IR → 公司模板结构 DVP 草稿工作簿（zip 直写，不引 xlsx 库）。
- `src/pdf-fonts.ts`：PDF 字体层（ToUnicode CMap、codeBytes 判定、诚实降级计数）。零依赖。
- `src/protocol.ts`：方案 PDF 文本层抽取（对象树、page tree、内容流扫描）。依赖 fflate（inflate）。
- `src/knowledge-seeds.ts` / `src/knowledge-validators.ts`：方法知识种子（恒 CANDIDATE）与
  已安装验证器（固定正/反/边界用例复现活代码；模型 JSON 只能选运行哪个验证器，不能供用例）。
- `src/index.ts`：DSH 工具/skill 注册 + KnowledgeService 生命周期接线（contribution/validator/seeds；
  种子失败只降级检索能力，不阻断装配，`dm_dvp_status` 如实上报）。
- `scripts/release-lib.mjs` / `scripts/release.mjs`：候选包构建/校验/分发标记（见下）。
- `tests/fixtures/make-xlsx.ts`：vendored 自 dm-listing demo.ts 的合成 xlsx 构造器——刻意不 import demo.ts。
  `tests/fixtures/make-pdf.ts`：合成 PDF 构造器（bfchar/bfrange/Identity-H/Flate/encrypt 夹具）。
  **夹具内容全部人工合成，禁止来自临床数据。**

## 数据边界（实现位置）

| 边界 | 实现位置 |
| --- | --- |
| Cover 内容永不读取 | `parse.ts` `classifySheet`：cover → `readable:false`，永不 readWorksheet；parse.test 以 canary 断言 |
| Approval 签署内容不读取 | 同上，approval 角色不可读 |
| TEST CASE 受试者号/DM/DBD 意见只计数 | `parse.ts` `buildManualReview`：`countEntries` 只留数字；parse.test canary 断言内容不出现在任何返回值 |
| 写出端 TEST CASE/DM/DBD Comments 永远留空 | `write.ts`：这三列只写列头，不接任何输入；write.test 断言 |
| 未识别 sheet 只记录存在 | unknown 角色不可读；写出端辅助 sheet（Sheet2/分配/WpsReserved 等）不生成 |
| Cover/Approval 写出只出脚手架 | `write.ts`：标题/版本/项目号骨架，无内容填充路径 |
| PDF 只读文本层，扫描件 NEEDS_OCR | `protocol.ts`：无文本层记 NO_TEXT_LAYER + NEEDS_OCR notice，不做 OCR |
| 加密 PDF 拒绝且不绕过 | `protocol.ts` `/Encrypt` → ENCRYPTED_PDF_UNSUPPORTED |
| 缺 ToUnicode 字体 U+FFFD 占位并计数 | `pdf-fonts.ts` decodeCodes + FONT_WITHOUT_TOUNICODE / ENCODING_FIDELITY 诊断 |
| 候选非终稿 | `cases.ts`/`write.ts` NOTICES 固定声明 CANDIDATE；工具描述与 skill 内容同款纪律 |

数据安全拦截由 IT 源头与未来 API 承担（ADR-0001），插件不自建安全层；上述边界是**需求边界**而非安全机制。

## fire-when 方言：已知权衡

- **前缀 NOT**：仅 `NOT (…)` 视为逻辑非；`Not` 后跟词组按字段名处理（"Not Done" 是合法字段名，
  词法上无法区分 bare `NOT x = y`，选择字段名优先）。`is not missing` / `x not null` 不受影响。
- **词组字段名启发式**：操作数吞并后续非关键字词，直到操作符/关键字边界。形如 `Is Missing` 的字段名
  会被关键字截断而降级 freeform（显式诊断，不静默）。
- **多词歧义**：`A B > 1` 中 `A B` 整体视为字段名——方言本身无字段定界符，这是唯一可判定读法。
- 解析失败一律降级 freeform + 诊断码，绝不硬拒（结构适配不作为读取门槛）。

## 渲染边界（render.ts）

- 渲染结果是**配置参考**（RENDER_REFERENCE_ONLY），不写生产 EDC 配置，不声称 Rave 已配置。
- AND/OR 混合嵌套 → NEEDS_MANUAL_GROUPING（扁平步骤序列不承载分组语义，不自动决定顺序）。
- 复合 NOT → NEEDS_MANUAL_REWRITE（不自动 De Morgan，防缺失语义漂移）；单比较 NOT 可安全翻转算子并留痕。
- `is (not) missing` → IsMissing/IsPopulated；freeform 不渲染（显式说明，不编造步骤）。
- 字段级 Form OID/Field OID/Control Type 是 Rave 风格系统功能层；跨 EDC 复用需按目标系统映射，
  不假定其他系统同构（跨系统映射是后续版本）。

## PDF 抽取边界（protocol.ts / pdf-fonts.ts）

- 手写解析器（仓库无 PDF 库）：仅覆盖文本层常见形态——literal/hex 字符串、Td/TD/T*/ET 换行、
  Tf 字体切换、ToUnicode CMap（bfchar/bfrange）、Identity-H 双字节码、FlateDecode（zlib 包裹，
  裸 deflate 兜底回退）、TJ 数组大负 kern 词距启发式（≤ -120/1000 em 记一个空格；个别生产者
  既不写空格字形也不写 kern 的位置会粘连，属抽取近似，关键段落人工核对原件）。异形 PDF 诚失败（诊断码）。
- 表格/图表/版式不在返回内；涉及视觉内容须人工查原件复核，抽取文本不是方案结构化数据。
- 上限：32MB 文件 / 2000 页 / 单页 80k 字符 / 全文 600k 字符，超限截断并计数（PAGE_CAP_EXCEEDED、
  PAGE_TEXT_TRUNCATED）；page tree 不可走通时回退外观顺序并记 PAGE_TREE_FALLBACK。
- 窗口参数 1-based 闭区间，越界显式 PAGE_WINDOW_INVALID。

## 写出边界（write.ts / xlsx-out.ts）

- 8 sheet 草稿：Cover/Approval 脚手架 + Version History + Edit Checks + Edit Checks(Field Level)
  + Manual Review + Manual Review for Programming + Dynamic；辅助 sheet 不生成。
- UAT 三列（TEST CASE-Subject ID / DM Comments / DBD Comments）永远留空；用例由项目团队行内留档执行。
- outputPath 必须落在 directory 内，默认拒绝覆盖（overwrite 显式 true 才放行）。

## 发布纪律（scripts/release-*）

- host 单 bundle：运行时依赖捆绑、UNBUNDLED_RUNTIME_DEPENDENCY 检查兜底；DSH peer 服务 external，由宿主固定版本提供。
- release-manifest.json：源码清单（src/licenses/脚本/文档，不含测试）、checksums、upstream commit
  （要求 upstream 工作区干净，否则 UPSTREAM_WORKTREE_DIRTY 拒绝）、state 恒 CANDIDATE、
  productionDataEnabled 恒 false、acceptance 恒 NOT_RUN。
- 捆绑依赖许可证文本版本化于 `licenses/`（含 node_modules 缺 LICENSE 的 @nodable/entities）；
  缺文本/冲突成为 distributionBlockers，approve 拒绝带 blocker 的候选。
- 全部写文件 flag `wx`；候选完整性 ≠ 部署隔离 ≠ 业务验收 ≠ 发布批准（manifest notice 原文声明）。

## 其他实现边界

- **公式单元格**：workbook.ts 既有行为是缓存值不可得；DVP 解析按空值处理并在 sheet 报告计 `formulaCells`。
- **日期序列值**：不做 Excel 序列→日期还原，原样字符串返回。
- **用例候选按单个比较拆分**（PER_COMPARISON）：AND/OR 组合期望需人工合并数据集后判定。
- **rulesJson 上限** 1MB / 2000 条；工具响应 900KB 封顶。

## 上游 harness 依赖与已知缺口（e2e 实证）

- **单轮输出截断即终态（上游缺口，非插件问题）**：`dsh-agent-loop` 遇到模型单次补全
  `finish = max-tokens` 直接把 turn 判为终态（agent-loop index.js `return { kind: "max-tokens" }`），
  不续写、不重试、不拆轮；headless 应用随即退出（exit 0），任务无声中止。
  压缩（compaction）解决不了这一类——它针对输入窗口满，这里是单次补全输出上限。
  应对：① profile 里给足 `maxTokens`（GLM-5.3-Flash 实测 16384 不够，已配 32768）；
  ② 任务提示词要求"规则内容放工具参数、正文简短"。已列为上游 issue 素材；
  插件层不做掩盖。实证：dm-dvp 7 个工具调用全部正常执行，断点在 LLM 编排层。
- **provider 配置责任**：pi-ai 默认 `providers` 为空字典，`zai-coding-cn` 等第三方 provider
  必须在 profile patch 显式给出（api/baseURL/apiKeyEnv/models）；credential 走环境变量或
  credentials 服务（web Models 页写入）。headless 任务对"每会话一题、答完即退"的形态，
  长链路任务要靠提示词约束轮次体量。

## E2E 实证（PROFISCOV 全链路，2026-11-10）与 v0.3 修复

公开方案（NCT0445659 structured summary，3 页 PDF）经 DSH headless（profiles/dvp，GLM-5.3-Flash）
跑通全链路 → 8 sheet 候选工作簿，结构层一次通过（表头/边界列/候选标注 vs 公司模板基准全对齐），
边界零越界。完整报告 `.runtime/dvp-e2e/E2E-REPORT.md`，对照脚本 `.runtime/dvp-template/compare_dvp.py`。

**设计原则（用户定调）**：不能限制 harness AI 的操作——插件开发的意义是把人力工作模式搬给 AI、提升效率。
工具的职责是给能力与诚实信息（宽容归一、诊断、计数），不是流程枷锁；实现路径由 AI 自定，
任务提示词写成目标+验收标准，不编排步骤。

暴露的插件侧缺口（首轮 e2e，均已修复，58 测试绿）：

1. ✅ **crossField 别名不对称**：`coerceRuleInput`（rules.ts）现识别 `form→formName`、
   `fields 数组→targetField(首)+relatedFields(余)`、`message→discrepancyText`、`targetedField→targetField`、
   `relatedField→relatedFields`；与 manualReview/dynamic 既有别名对齐。
2. ✅ **条目级未知键静默丢弃**：`parseWorkbookInputJson`（input.ts）现逐条目记录未识别键
   （`区[i].键` 形式，含 project 级），与顶层未知键合并返回；写端 UNKNOWN_KEYS_IGNORED notice 逐条暴露
   （上限 80 条防刷屏）。识别即归一、不识别即上报，两态都透明。
3. ✅ **versionHistory/project 别名**：`author/by→modifiedBy`、`change/description→comments`；
   project 归一 `code→studyCode`、`name/title→studyTitle`、`protocolNo/registry→protocolNumber`、
   `version→dvpVersion`、`date→dvpDate`、`author→createdBy`（coerceProject，非法类型显式 PROJECT_NOT_OBJECT）。
4. ✅ **工具描述即契约**：dm_dvp_write_workbook 描述补齐各区 canonical 键 + 别名表 +
   issues/未知键/覆盖语义（信息陈述，非命令式）。首轮 e2e 的 agent 纪律问题（无视 issues、
   用例未复跑）以验收标准式提示词应对，不在插件层加操作限制。

v2 复跑验收（同日，headless 同 profile）：6 内容区全填充——Edit Checks 19 / Field Level 24 /
Manual Review 5 / MRfP 5 / Dynamic 8 / Version History 2（V1.0→V2.0/2026-11-10）；
issues=0、无未知键 notice；回读 19 条规则逐行零诊断；validate 19/19（freeform=0）、
suggest 67 用例候选（3 unresolved）、render 19/19 零标记；compare_dvp 结构对照全对齐，
UAT 三列计数 0。输入仍是 3 页期刊 structured summary letter（公开渠道无完整方案书），
规则密度与输入规模成比例。

## v0.2 已完成（原 slice 1"刻意不做"清单的兑现）

方案 PDF 文本层抽取（CN/EN，诚实降级）；xlsx 多 sheet 写出；KnowledgeService 接线（种子 +
contribution + 已安装验证器 + capture/validate/events 工具）；按目标 EDC 渲染 fire-when
（rave-steps/generic-expression）。行内变更控制逐版本差异追溯、字段级 OID/ControlType 跨系统
映射仍是后续版本。
