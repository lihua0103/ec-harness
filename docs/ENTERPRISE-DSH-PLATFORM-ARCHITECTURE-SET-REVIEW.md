# 企业 DSH 平台架构集 · 三维度评审报告

评审对象：`docs/ENTERPRISE-DSH-PLATFORM-ARCHITECTURE-SET.md`（295 行，v1.0，2026-11-25）
评审方式：三名 GLM 5.4 只读专家并行评审（平台/DSH 契约 · 知识/训练闭环 · 规模化/安全/交付），各自核对了开发规范、四份合同、ADR-0001..0004、锁定版上游源码与对应源码文件。
评审日期：2026-11-25

**效力**：评审报告不是运行合同，不替代规范；建议只作修订输入。架构集原文件未被修改。

---

## 0. 三份评审的结论对照

| 维度 | 评审结论 | 一句话 |
|---|---|---|
| A 平台/DSH 契约 | 有条件可 | 作为"现状+方向"导航文档可用；§3 图、§3.2 第3步、§5.2 三 profile 不能直接当实施基线；改三处后才能冻结 E1 |
| B 知识/训练闭环 | 有条件可 | 数据层目标模型成立，但今天的实现是"带三处人工断点的开环"；§5.5.2 是降门槛，必须撤回 |
| C 规模化/安全/交付 | 有条件可 | 顺序对，但 §4.3 漏掉比"跨包互引"更紧急的三条安全缺口；§5.1 路径在现有工程结构下不可直接执行 |

**共同发现**：三份评审都独立指出架构集**存在越权声明**（把未实现写成现状、把设计写成合同、把单测写成验收），且 §4.3 的 P0 清单不完整。

---

## 1. P0 缺陷汇总（必须先修，阻断 E1）

<|constrain|> # | 来源 | 缺陷 | 位置 | 具体失败场景 | 建议修正 |
|---|---|---|---|---|---|
| P0-1 | A#1 / C#1 | **审批可自授**：`approvedBy` 取自请求体/模型参数，主体只是 `session:<id>`；无角色分离 | `platform-control/src/cordis.ts:41-45,261-293,410-436`；`service.ts:639-658,996`；`http.ts:360-366,591-599` | 员工会话装了 `ec-platform-control`，模型可 `register→approve→review` 一条龙伪造 REL-01/QC-03 | 审批人强制取自已验证 Principal；引入角色矩阵与职责分离；管理类工具移出员工会话 profile |
| P0-2 | A#2 / C#3 | **runtimeBundleDigest 不覆盖安装字节**：sha256(字面量版本串 + profile 名 + bundle 名单 + `name@version`)，派发只比较配置串 | `scripts/workbench-deployment.cjs:62-71`；`worker.ts:433-436`；`child-worker.ts:148-160` | 改 worker 的 `cordis.patch.yml` 重开 `schedule`、换 bundle、升级引擎，摘要仍相等 → "漂移即拒绝接单"落空，P0-2 的冻结手段无效 | 把 patch 内容、bundle lock、引擎 commit 纳入摘要并在派发前对实际 profile 重算；或把表述降为"声明一致 + 业务插件字节核对" |
| P0-3 | C#2 | **Worker 可提权**：子进程继承控制面全部环境变量；控制面/知识 HTTP 只绑回环且默认不校验（知识面身份取自 `x-dsh-subject` 请求头） | `child-worker.ts:209`；`http.ts:1293`；`api-cli.ts:141`；`platform-knowledge/src/http.ts:16-27` | 任一 Run 内的模型/R 代码读环境拿到模型密钥，或访问回环端口改发布审批/登记模型目录/跨租户读写知识；ISO-01 必败 | 环境白名单构造、Worker 与控制面间独立凭据、知识面 token 必填并校验来源 |
| P0-4 | C#4 / A#3 | **home 未隔离**：所有 Run 共用一个 `dshHome`，作业文件同用户可读 | `child-worker.ts:181-202`（仅 cwd 按 runId 分目录 `:164`）；`worker.ts:307-320` | 甲项目的 Run 可读到乙项目 Run 的提示词、会话和定时提醒；即使身份正确，ID-01 的会话隔离仍不过 | 并入 P0-2，写明"按 Run 的 home 与凭据"为待建项 |
| P0-5 | A#1 | **员工 Web 仍有插件管理**：叠加层只有 `ui-sidebar disabled` 一行；web 宿主 agent 可用的 `tool-plugin-manager`/`tool-schedule`/`command-goal`/`tool-goal` 来自 preset 行，叠加层未触及；web 模板开 HMR | `packages/platform-workbench/employee-web.patch.yml`（共 20 行）；`scripts/apply-employee-web-profile.cjs:24-29`；上游 `packages/bundle/web-app/presets/standard.patch.yml:38,47,49,132-134` | 员工在中央原生会话让模型装卸插件，变更落在共享 web profile，下次启动或 HMR 生效，所有员工与运维界面一起变；这次执行不在 Run 治理内 | 员工行改为"默认树入口隐藏，agent 侧基线待冻结"；P0-2 拆成 Worker 与 Web 宿主两条，Web 条含 preset 覆盖与 HMR 开关决策 |
| P0-6 | A#4 / B#? | **Worker 基线两处不成立**：(a) "base(或 sdk-minimal 基线)"——sdk-minimal 不叠 dsh-base，行集合不同，patch 命中不存在的 id 只打警告；(b) 缺 goal——现有生成器只禁 `tool-plugin-manager`/`schedule`/`tool-schedule`/`hmr`，base 里 `goal`/`command-goal`/`tool-goal` 无 disabled，项目内 patch 与脚本无任何 goal 行 | `scripts/setup-worker-profile.cjs:32-38,57-64`；上游 `packages/bundle/sdk-app/cordis.patch.yml:67-69`；上游 `packages/bundle/base/cordis.patch.yml:327-334,454-455` | 选 sdk-minimal 时基线整段空转且无报错；按集 §5.4 冻结会漏 goal | 二选一写死（现有脚本与文档都指 base + sdk-app）；goal 三行写进清单与生成器 |
| P0-7 | B#1 | **outbox 泵恒写"待分析"且不带草稿**：投递即算完成；无草稿不建候选 | `platform-control/src/cordis.ts:104-136`；`service.ts` outbox 相关 | 失败 100 个 Run：outbox 全完成、候选 0 条，指标全绿 | 泵后接有负责人的分析环节；候选产出率、台账老化列为 E3 出口 |
| P0-8 | B#2 | **ValidationExecutor 不存在**：只有数据合同，生产代码零调用方；运行期候选只能由操作者本机脚本激活，脚本上下文仅 `{pluginId}` | `scripts/knowledge-accept.mjs:1-36`；`platform-knowledge/src/service.ts:1028-1051`；架构集 §4.2 列为"已落地" | 接身份后脚本对带租户记录一律找不到；单人可自写证据自激活 | 二选一：实现独立执行器，或把操作者验收定为正式环节并加主体与第二人复核 |
| P0-9 | B#3 | **知识绑定是名义的**：控制面按自己 home 的库取快照，Worker 默认回落活库检索（含候选）；带快照参数时来源是"调用方自述" | `platform-control/src/bootstrap.ts:12,36-40`；`platform-knowledge/src/cordis.ts:69-71`；`snapshot-readonly.ts`；DVP `plugins/dm-dvp/src/index.ts:191-232` | 批准的知识 Worker 读不到，Worker 读到未批准候选；一 Run 一 home 下库为空 | Worker 不开库，只走按 Run 解析的固定集合；解析不到返回未绑定而非回落 |
| P0-10 | B#4 | **发布指针吞没 project/shared 域**：指针存在即只取清单；整包替换、上限 256；撤回不动指针；活库检索不查撤回台账 | `platform-knowledge/src/snapshot-readonly.ts:53-110`；`service.ts:350-426,898-911`；`store.ts:691,1188-1206` | 发 1 条试点清单，其余知识对全员消失；撤回后新 Run 绑定空快照；先撤回再回滚，重叠条目永久失效 | 快照 = 清单 ∪ project 域；拦截非预期缩减；单条撤回并强制指定替代清单 |
| P0-11 | B#5 | **我写的"种子固定用例通过即可 ACTIVE"是降门槛**：与验证合同与代码相反（该层明确不激活） | 架构集 §5.5 第 2 条 ↔ 验证合同 §5-8 与 `service.ts:1100-1110` | 无 claims 的方法未经内容验证进入全部新 Run | **撤回这条表述**；改为"构建期为种子 claim 生成覆盖绑定；无 claims 者只作参考" |
| P0-12 | B#6 | **C3 不可执行**：Run 没有"关知识"开关，只能改应用声明 → 连带改变发布摘要 | 架构集 §5.6 C3 与 §4.2 | 做不出只改知识变量的对照 | Run 级知识覆盖项 |

**P0 共 12 条。** 其中 P0-1/P0-2/P0-3/P0-4/P0-5/P0-6 是 C/A 评审新发现的**安全缺口**（原架构集 §4.3 完全未列），P0-7/P0-8/P0-9/P0-10/P0-11/P0-12 是 B 评审指出的**知识闭环断点**。

---

## 2. P1 缺陷汇总

| # | 来源 | 缺陷 | 位置 |
|---|---|---|---|
| P1-1 | C#5 | 跨包互引实为 **57 处**，不是 30：`packages/` 内还有 27 处（10 处为运行时值导入）；检查器只扫插件 `src` | `scripts/check-development-standard.mjs:116-139` |
| P1-2 | C#6 | "`workspace:*` 或发布版本"不可行：根目录无 `package.json`/`pnpm-workspace.yaml`；10 份包级锁文件；CI 逐包安装；7 个平台包 `private` 且 4 个直接导出 `.ts` 源码；`plugins/dm-viz` 无锁文件 | 仓库根；`.github/workflows/verify.yml:67-71,115-123` |
| P1-3 | C#7 | 身份缺四个前置：断言无签名校验、零时钟容差（`:72`）；Principal 无角色，`operatorActions` 是全集；审计表只有 `actor` 列；哈希链仅在导出时计算 | `policy.ts:3-10,96-146`；`platform-identity/src/index.ts:61-74`；`store.ts:1142-1145`；`service.ts:2759-2783` |
| P1-4 | C#8 | 发布耦合：摘要含全部插件 `name@version`，一处升级使所有应用的 `releaseDigest` 变化、审批失效 | `workbench-deployment.cjs:68`；`registry.ts:191-209`；`deployment.ts:29-32` |
| P1-5 | C#9 | 数据安全开关全局单文件，`PUT` 无策略检查、无审计；outbox 死信重放无授权；路径按模块位置三级上溯，安装态下控制面与插件指向不同文件 | `http.ts:326-334,536-543`；`data-boundary.ts:17-18` |
| P1-6 | B#7 | C1 未度量：无 recall@5、MRR、阈值；诚实性仅 1 条探针；泄漏只测跨插件；查询与种子同作者 | 架构集 §5.6 C1；`tests/golden.test.mjs:43-58` |
| P1-7 | B#8 | C2 半成：返回集合不落库，Run 记录无证据，`reconcileCitations` 无生产调用方，`cite` 是模型自报 | `platform-knowledge/src/service.ts:445-520`；`evidence.ts:25-43`；`bootstrap.ts:41-56` |
| P1-8 | B#9 | 六条进入条件均无观测面；含不足 3 码位词的查询走全量解码回退 | 架构集 §3.4/§5.6；`service.ts:362-365,395-411` |
| P1-9 | B#10 | 受众是自由标识符、不参与读路径；发布人即批准人；评测报告引用可选 | 架构集 §3.3/§5.5；`service.ts:893-898,937` |
| P1-10 | B#11 | `eventRef` 仅结构校验；投影台账无租户过滤 | 架构集 §3.3；`schema.ts:161-174`；`service.ts:293-300` |
| P1-11 | B#12 | 插件工具用模型传入的 `projectId` 选项目、不经范围边界；检索接缝不存在；C3 排在"学习闭环可信"之后 | `plugins/dm-dvp/src/index.ts`；架构集 §5.6 |
| P1-12 | A#5 | "同层不互引"已被违反，计数偏小：platform-control → platform-knowledge 相对 src 12 处，platform-viz → platform-workbench 1 处，platform-workbench → platform-knowledge 1 处 | `bootstrap.ts:12-13`、`cordis.ts:12-15`、`service.ts:34-38`、`knowledge-seeds.ts:6`、`xlsx.ts:6`、`knowledge-seeds.ts:5` |
| P1-13 | A#8 | `ctx.knowledgeSearch` 接缝不存在（packages、plugins、scripts、docs 零引用）；员工端原生设置消失风险未实测 | 架构集 §3.4/§5.6；`employee-web.patch.yml:15-17` |
| P1-14 | A#7 | "叠加停用 ui-sidebar"列在"有代码 + 包级测试"下，但全仓引用 `employee-web` 的只有 patch、client 注释和脚本，tests 零命中；ADR-0003 写"待宿主验收" | 架构集 §4.2；`docs/adr/ADR-0003-NATIVE-WEBUI-WORKBENCH.md:23` |
| P1-15 | C#7 | 身份缺四个前置：断言无签名校验、零时钟容差；Principal 无角色；审计表只有 `actor` 列；哈希链仅在导出时计算 | `policy.ts:3-10,96-146`；`platform-identity/src/index.ts:61-74`；`store.ts:1142-1145`；`service.ts:2759-2783` |
| P1-16 | C#8 | 发布耦合：摘要含全部插件 `name@version`，一处升级使所有应用的 `releaseDigest` 变化、审批失效 | `workbench-deployment.cjs:68`；`registry.ts:191-209`；`deployment.ts:29-32` |
| P1-17 | C#9 | 数据安全开关全局单文件，`PUT` 无策略检查、无审计；outbox 死信重放无授权；路径按模块位置三级上溯 | `http.ts:326-334,536-543`；`data-boundary.ts:17-18` |

---

## 3. P2 缺陷汇总

<|constrain|> # | 来源 | 缺陷 |
|---|---|---|
| P2-1 | C | 按需装配未实现：Worker profile 是静态全量 bundle，每个 Run 都加载全部插件；上百插件时启动时间、工具 schema 体积、工具名冲突才是瓶颈；§0/§3.2 把它写成现状，§4.3 未列缺口 |
| P2-2 | C | 会话到身份的映射未定义：反向代理转发 DSH 的 cookie/token，不是 IT 断言；DSH 登录不分用户时所有人同一个 Principal |
| P2-3 | C | 密钥管理缺位：§8 只列 ValidationExecutor 的凭据；Worker 的模型密钥、签名密钥、轮换均无归属 |
| P2-4 | C | 撤权时限与通道：「约定时限内」没有数值，撤权事件通道未实现；E2 的撤权演练没有出口判据 |
| P2-5 | C | E1 出口「ID-01/02（合成）」易误读：验收清单写明替身目录不计通过，建议改名以免被当成 P0 已过 |
| P2-6 | C | P0-4 证据不可追溯：`KNOWLEDGE-SCALE-ASSESSMENT.md:78-87` 只有 8 行缺口，不含"约 20 项"，也不含 HTTP 默认无鉴权；`.runtime/kb-opt` 只有脚本和日志，且未入库 |
| P2-7 | C | E0 出口当前不成立：工作树有 47 个未提交改动，架构集自身未跟踪，22/22 记录不对应任何提交；Worker profile 定义在已忽略的 `.runtime` 下 |
| P2-8 | C | CI 即使跑通也不是合并门禁：全量 lane 仅手动触发（`verify.yml:39,81`） |
| P2-9 | B | 发布权与职责分离：激活（脚本）和发布是同一个人、同一台机器，"业务放行"没有独立对象 |
| P2-10 | B | 插件版本与验证器兼容：发布记录无插件版本范围、无验证器摘要；验证器每次运行前重注册 |
| P2-11 | B | Worker 取知识的形态：架构图里 Worker 与知识库之间没有连线，也没有合同 |
| P2-12 | B | 待分析台账的负责人与老化：无人认领、无超期指标 |
| P2-13 | B | 在途 Run 的"已用被撤回知识"标记：影响面只列绑定该发布的 Run，上限 500 |
| P2-14 | A | profile 命名与 home 拓扑未定：脚本直接改出厂 `web` profile，员工与运维共用一个 profile |
| P2-15 | A | 引擎字节是否另有核对未确认（未核对） |
| P2-16 | A | 第 2 步幂等键未核对（未核对） |

---

## 4. 遗漏项（架构集未覆盖但实际致命）

三份评审共同/各自的遗漏项，按影响排序：

1. **Web 交互执行域是第二执行域**（A）：中央原生会话跑在 web 宿主进程，用共享 UI home 和 `preset-standard`，有 plugin_manager、schedule、goal，HMR 开着。没有 launchId、完成屏障、知识快照绑定。失败场景同 P0-1/P0-5。
2. **控制面与知识库的边界是共享文件，不是服务**（A）：快照始终按路径直读 SQLite（`bootstrap.ts:80-86`、`snapshot-readonly.ts:95-98`），配了 `knowledgeServiceUrl` 也一样；读不到就返回 undefined，Run 静默无知识绑定。分进程/分机部署时全部 Run 无知识且无报错。
3. **反向代理没有信任模型**（A）：代理只转发 authorization、cookie 等（`platform-workbench/src/index.ts:115-122`），不做认证。控制面入口用固定主体（`api-cli.ts:107,141,147`，mode 为 local-operator）。`config.ts:38` 注释说主体由 `x-dsh-subject` 转发，但没有任何代码读它，代理也不转发它。补身份源时若让控制面信任该头，必须由代理剥离客户端自带头并自行签发。
4. **发布权与职责分离**（B）：激活（脚本）和发布是同一个人、同一台机器，"业务放行"没有独立对象。
5. **待分析台账的负责人与老化**（B）：无人认领、无超期指标；outbox 全绿而沉淀为零。
6. **在途 Run 的"已用被撤回知识"标记**（B）：影响面只列绑定该发布的 Run，上限 500；长 Run 中途撤回，模型上下文里已读内容继续影响产物，产物无标记。
7. **密钥管理缺位**（C）：§8 只列 ValidationExecutor 的凭据；Worker 的模型密钥、签名密钥、轮换均无归属。
8. **撤权时限与通道**（C）：「约定时限内」没有数值，撤权事件通道未实现；E2 的撤权演练没有出口判据。
9. **profile 命名与 home 拓扑未定**（A）：脚本直接改出厂 `web` profile，员工与运维共用一个 profile。

---

## 5. 评审确认没问题的点（避免"全都有问题"式结论）

三份评审共同/分别确认：

1. **禁用 `ui-sidebar` 的机制可行**：`disabled: true` 保留条目并跳过挂载；slot 最低 priority 渲染、同 key 同 priority 抛错；工作台注入的是 `workspaces`/`sessions`（A）。
2. **Worker 禁用项有上游明文**：sdk README 写明用 patch 关 `tool-plugin-manager`；`schedule` 是唯一注入 `sdkSessionActivation` 的行（A）。
3. **五阶段的 1、4、5 与代码吻合**：`resolveExecutionPlan`；workerPrompt 不规定工具顺序；屏障缺一即 UNKNOWN；知识快照只读打开，单写者未被破坏（A）。
4. **模型目录漂移是失败而非静默**：目录是部署 JSON，能力字段手写；路由不一致由 `worker.ts:440-453` 和 SDK initialize 拒绝（A）。
5. **outbox 的持久化、幂等、重试、死信、重放齐全**，投影失败不改 Run 状态（B）。
6. **随包套件无法激活运行期候选**：套件须含该 id，且覆盖绑定须等于候选摘要；模型侧验证工具不能自批（B）。
7. **固定集合检索逐条 fail-closed**：撤回、撤权、篡改、不可用都进 `excluded`，不换新版；发布后新 Run 绑定、旧 Run 不漂移、撤回影响面可查，有测试（B）。
8. **指针切换带版本条件更新，清单不可变；回滚不复活已撤回条目**（B）。
9. **未发现把合成验证写成隔离证明**：架构集第 5 行有免责声明，第 224 行写明独立进程不是沙箱，第 248 行声明不冒充真实插件（C）。
10. **模型目录不接受 baseURL**，端点由部署脚本和 Worker profile 决定，伪造目录不能把流量导向外部端点（C）。

---

## 6. 必须撤回的架构集表述

评审 B 明确指出以下架构集表述与验证合同/代码矛盾，**必须撤回**：

| 架构集位置 | 原表述 | 问题 | 修正 |
|---|---|---|---|
| §5.5 第 2 条 | "种子自动激活：装配期导入 + 固定用例通过即可达 ACTIVE" | 与验证合同 §5-8 及代码相反（该层明确不激活）；属于降门槛 | "构建期为种子 claim 生成覆盖绑定；无 claims 者只作参考，不激活" |
| §4.2 | "知识：…事件投影、验证请求/回执" 列为已落地 | ValidationExecutor 只有数据合同，生产代码零调用方 | 移到"待实现"，或注明"操作者脚本验收" |
| §3.2 第 3 步 | "按 Run 装配闭包 / 独立 home" | 代码未实现，也未入缺口表 | 改为"目标态；现状为部署级单值 profile/dshHome" |
| §5.2 员工行 | "无插件管理/无原生工作区树" | 员工 Web agent 侧仍可用 plugin_manager/schedule/goal | 改为"默认树入口隐藏，agent 侧基线待冻结" |
| §4.1 | "7 个包 engines.dsh 均为 0.2.2-rc.5" | 只有 4 个插件声明；7 个平台包只有 engines.node | 改数字，或给两个 bundle 补 engines.dsh |
| §4.2 | "叠加停用 ui-sidebar"列在"有代码 + 包级测试" | tests 零命中；ADR-0003 写"待宿主验收" | 移到"待验收" |
| §3.4/§5.6 | "ctx.knowledgeSearch 接缝" | packages、plugins、scripts、docs 零引用 | 标注"待设计（三角色）" |
| §4.3 | "跨包源码互引 30 处" | 实为 57 处；检查器看不见 packages 内的 27 处 | 改为 57，检查器扩展到 packages→packages 与 scripts |
| §4.3 | "CI 全量 lane 从未在 runner 执行"（未列） | 全量 lane 仅手动触发 | 补入缺口表 |
| §0 | "当前差距（P0）"未含 P0-1..P0-6 | 三条比"跨包互引"更紧急的安全缺口未列 | 补入 P0 清单 |

---

## 7. 建议的修订顺序（给用户决策）

1. **先修 P0-1..P0-6（安全）**：审批自授、Worker 提权、摘要不含字节、home 未隔离、员工 Web agent 侧、Worker 基线。这六条不修，E1 无法冻结。
2. **再修 P0-7..P0-12（知识闭环）**：outbox→候选、ValidationExecutor、知识绑定真实化、发布指针语义、撤回降门槛、Run 级知识开关。
3. **修事实错误**：跨包计数 57、engines.dsh 数字、employee-web 测试、ctx.knowledgeSearch 接缝标注、CI 全量 lane 未跑。
4. **补遗漏项**：Web 交互执行域、控制面/知识库共享文件边界、反向代理信任模型、密钥管理、撤权时限、profile/home 拓扑。
5. **修订 §5.5.2 与 §5.6 C3**：撤回降门槛；Run 级知识开关前置。

**未核对**（三份评审均未跑命令）：verify-all 22/22、代码规模表、p95 ≤ 120ms、跨 Run goal 可达性、单侧栏浏览器实测、第 2 步幂等键、引擎字节是否另有核对、现网库计数（53 个种子仅 5 个可达 ACTIVE）、`.runtime/kb-opt` 的约 20 项缺陷清单原文、控制面与 Worker 的库文件是否同一文件。

---

## 8. 评审证据索引

三份评审报告的原文（含完整核对过程与行号）：
- 评审 A（平台/DSH 契约）：task `a90b37452b0bebfd2`
- 评审 B（知识/训练闭环）：task `a5cc489a87b805a8b`
- 评审 C（规模化/安全/交付）：task `aa2350b2e2db0bebc`

本报告只做汇总与排序，不重复评审原文的细节；如需某条缺陷的完整核对依据，可回查对应评审。