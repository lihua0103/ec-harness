# 当前实现与企业产品差距：独立核查

2026-11-11 · 只读源码核查快照 · **不是冻结版本测试或企业验收**。

关联：[产品蓝图](00-product-blueprint.md)、[场景验收](02-scenario-acceptance-review.md)、[主方案](../CLINICAL-WORKBENCH-SOLUTION.md)。本轮不修改源码、部署配置或既有整改文档；其他会话仍在修改 apps/platform-control。行号为读取时定位，后续需重新绑定源码版本。

## 1. 用户当前看到的系统

截图文字与 `apps/enterprise-workbench` 的工作入口、合成应用、模型目录及“执行器未配置”提示相符。不能仅凭截图确定实际运行进程或数据库路径；以下描述源代码默认行为，不声称读取了当前实例配置。

| 问题 | 读取时事实 | 产品缺口与不能作的推论 |
|---|---|---|
| 项目如何选择 | [app.mjs](../../apps/enterprise-workbench/src/app.mjs:234) 项目是默认 SYN-001 的文本框；[http.ts](../../packages/platform-control/src/http.ts:185) bootstrap 没有项目目录 | 不是已接项目目录但无权限结果；自由编号不等于企业项目授权、目录绑定 |
| 本地目录在哪 | [worker.ts](../../packages/platform-control/src/worker.ts:261) SDK cwd 为 worker.workspace/runId，home/profile 取部署配置；projectId 不决定 cwd | 没有员工可理解的项目资料源→节点→Run 目录关系；目录独立不等于安全沙箱 |
| 模型选择是什么 | [models.ts](../../packages/platform-control/src/models.ts:280) 目录是 metadata；available 来自 enabled 等目录状态，不证明凭据与推理链路 | 模型可显示≠adapter 已装配≠凭据有效≠本次能够推理 |
| 为什么不执行 | [api-cli.ts](../../packages/platform-control/src/api-cli.ts:98) 以 null executor 建立控制服务；seed 是合成目录与应用 | 默认独立工作台入口并未装配 Worker，不能用选择模型后的排队记录证明真实调用 |
| 是否完全没有 Worker | [cordis.ts](../../packages/platform-control/src/cordis.ts:49) 有 DshProfileExecutor 装配路径；[worker.ts](../../packages/platform-control/src/worker.ts:257) 可把模型快照交 SDK | 应描述“执行适配存在、默认入口未接通”，不能把全部执行能力说成没有 |
| 是否有持久历史 | 平台 SQLite 保存 Work/Run/输入/事件等；DSH 保存原生 Session | 有持久化不等于多人共享、完整会话连续性、备份恢复或临床批准 |
| 是否有成果下载/实时更新 | 读取时已出现 SSE、成果封存下载及相关测试源码 | 不再笼统写没有这些能力；但 SSE 状态不等于完整原生聊天流，封存不等于业务交付 |

## 2. 记录保存在哪里

| 内容 | 当前默认归属 | 边界 |
|---|---|---|
| 正式前端页面草稿/选择 | 浏览器页面内存；已提交对象来自 API | 不能与旧原型 localStorage 任务库混同 |
| Work/Run/输入/事件/目录/偏好/交互/审计 | API 主机上的 SQLite；CLI 默认 `$DSH_HOME/platform/workbench.sqlite`，未设 DSH_HOME 时基于仓库 `.runtime/dsh-home` | 此处“服务端”指 API 进程，当前本地模式不代表云端 |
| Cordis 控制面默认库 | `platform/control.sqlite`，与 CLI 默认库不同 | 从另一入口打开看不到记录，不应立即判断数据丢失；需统一部署权威 |
| 实际工作文件 | Worker 所在主机的 `workspace/runId` | 远端主机不会因为收到员工 D 盘路径就能访问文件 |
| 原生 DSH Session | base bundle 默认在配置的 dshHome/sessions；profile 可覆盖持久根 | 原生 JSONL/Zstd 等格式由 DSH 维护；平台不另建第二套可写会话事实 |
| 封存成果 | 控制库同级 artifacts/runId/name 等受控位置 | 源码具备摘要复验/下载路径；真实部署可用性、恢复和共享须另验 |

依据：[api-cli.ts:30](../../packages/platform-control/src/api-cli.ts:30)、[config.ts:165](../../packages/platform-control/src/config.ts:165)、[store.ts](../../packages/platform-control/src/store.ts)、[service.ts](../../packages/platform-control/src/service.ts)、[上游持久化 README](../../upstream/deepseek-harness-git/packages/session/session-persistence-jsonl/README.md)、[base bundle](../../upstream/deepseek-harness-git/packages/bundle/base/cordis.patch.yml)。未读取数据库内容、秘密或真实临床资料。

## 3. Work 持久不等于 Session 连续

读取时 Worker 一次 high-level run 未指定 sessionId，上游通常创建新 Session；平台主要在 outcome/result 中记录返回 ID。未看到完整的持久 Run→Session→home/profile/cwd 接管关系及实际 resumeSession 恢复链路。

- 终态后新尝试的 UI 主要提交新 goal/projectId，并未形成包含前序明确决定、资料和成果的上下文清单。
- 运行时补充输入可进入平台记录，但一次性 Worker 缺少持续派发消费者，晚到输入可能留 PENDING 并使完成屏障不满足。
- 失败/取消后 retry 建新 Run；读取时重试包装初始输入，不足以证明包含全部追加要求。
- Work 与首个 Run 分两次请求创建；无已证明的请求级幂等闭环，不能以单 Work 活动 Run 限制代替重复创建防护。
- RunScheduler 领取排队任务，不等于面向业务的周期性任务服务；原生 DSH schedule 是否启用是另一个装配事实。

定位：[worker.ts](../../packages/platform-control/src/worker.ts:399)、[runs.ts](../../packages/platform-control/src/runs.ts:125)、[service.ts](../../packages/platform-control/src/service.ts:817)、[app.mjs](../../apps/enterprise-workbench/src/app.mjs:388)、[scheduler.ts](../../packages/platform-control/src/scheduler.ts)、[上游 SDK api.ts](../../upstream/deepseek-harness-git/packages/sdk/client/src/api.ts)。实现仍在变动，以上需在开发基线冻结后复核，不能当最终缺陷关闭清单。

## 4. 企业授权与执行可信度

只读核查中，当前独立入口使用本地固定 operator；Work 的 projectId 格式有效不代表企业项目访问已经核验。已有 platform-identity 包是可复用资产，但其存在不能证明项目列表、会话、成果下载、交互、事件流都接通同一资源授权。

每 Run cwd、独立子进程、CAS/fencing 都有工程价值，**不能独立证明文件/网络沙箱、旧进程停止或跨项目安全**。Worker 的配置 home 共享和默认环境继承等需随部署合同核验。runtimeBundleDigest 字段相等也不能代替实际 profile/安装闭包一致性的证明。

这些责任属于平台/API/IT执行环境；不应让领域插件重新增加按文件名/类别拒读或普通 R 开发批准。

## 5. 历史测试的证据不能越界

[platform-worker-e2e.mjs](../../scripts/platform-worker-e2e.mjs:41) 的历史执行路径使用独立控制服务、自定义 factory 和固定模型路由。即使该路径历史成功，也不证明截图中的目录选择→默认 API→对应 adapter→结果返回已经闭环。

同样：
- 测试源码存在≠本轮执行。
- 工程门禁通过≠临床用例正确≠企业部署验收。
- 上游 Context7 当前文档≠锁定版本契约；其示例仅作发现入口。锁定基线为 `0.2.2-rc.1` / `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，接口以本地锁定公开源码为准。
- 本轮源码核查未启动服务、未调用真实模型、未访问生产 API，不能推定实际部署状态。

## 6. 对开发计划的含义

不建议继续按“补项目下拉、加模型配置按钮、加重试按钮”分别交付。先把一个工作跨批次的资料/代码/运行/问题/检查/交付关系落实为合同与案例，再实现对应的纵向切片。

复用现有 Work/Run、状态内核、SDK Worker、模型快照、事件和成果能力；按证据补齐身份接缝、项目资料、幂等、连续输入、Session绑定及受管执行，不另写 DSH 模型客户端、Agent loop、Loader 或会话格式。

## 7. 检查状态

- 源码与文档只读核查：已执行，属于移动工作区快照。
- 实际 UI/DSH 模型调用、企业授权与临床业务验收：**本轮未执行**。
- 全仓 `verify-all.cjs`：**本轮未执行**；代码负责人仍写入并运行构建/门禁，避免并行写构建产物。其他会话提供的门禁数字不作为本轮证明。
- 本目录 Markdown 链接、规范检查：以本轮交付总结中的实际命令结果为准。文档校验不证明上述设计已实现。
