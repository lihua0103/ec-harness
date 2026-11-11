# 平台工作、运行与会话生命周期合同

设计版本：0.2 · 2026-11-10。类型：架构参考。状态：目标合同，未实现或运行验证。覆盖评审 6、7，与[应用发布合同](PLATFORM-APPLICATION-RELEASE-CONTRACT.md)共同约束 Worker。上层：[多插件总架构](ENTERPRISE-MULTI-PLUGIN-ARCHITECTURE.md)。

> **2026-11-11 局部实现**：`platform-runtime` 的 `RunLedger` 实现 QUEUED→STARTING→RUNNING→终态、
> CAS revision、持久 cancelRequested、fencing token、dispatch 前取消获胜、启动中取消需 `cancel-settled`、
> 完成屏障四项事实齐全才成功；`platform-control` 已持久化运行/输入摘要/事件/审计，工具只能创建/取消，
> dispatch/finish/fail 仅监督器内部可用。Worker 执行器、进程监督、launch 对账、持久调度与 DSH 会话绑定未实现。

## 1. 身份与唯一所有者

| 对象 | 生命周期与关系 |
|---|---|
| Work | 员工的持续业务工作，保存项目归属、目标、消息与结果关系；可以有多个 Run |
| WorkInputRevision | 不可变输入修订，引用资料版本、参数和明确的用户要求 |
| Run | 一次执行尝试，固定 applicationRelease、ExecutionPlan、initialInputRevision 与执行环境 |
| RunInputCommit | 当前 Run 后续接纳的输入提交，逐条留痕，不覆盖初始快照 |
| LaunchAttempt | 一次进程启动/恢复尝试，具有 launchId、监督器、epoch、进程树边界和退出证据 |
| EngineSessionBinding | 一个 Run 对应一个原生 root session；受管后代另记录 lineage |
| InteractionRequest | 一次原生问题或授权请求，绑定 Run、launch epoch、requestId 与适用输入 |

首期规则：一个 Work 同时最多一个非终态 Run；一个活动 Run 独占一个 Worker 执行域和一个 root session。UNKNOWN 也是未结清状态，不能自动排新 Run。普通重试须先确认旧执行已停止并核对副作用，生成新 Run、新 home、新 root session，不重用旧 session 的队列、goal 或权限状态。

恢复用于同一 Run 的技术中断：保留 runId、原 session 与 runtimeLock，增加 launch epoch，重新获得租约；先确认旧进程树已退出，锁与持久存储兼容。不能确认旧执行是否存活时，只允许对账/停止，不另起竞争执行。新 Run 的上下文由平台选取获准历史消息、明确裁定和工件引用重建，记录 context manifest；不无差别复制原生 session 或把模型摘要当权威业务规则。

## 2. 输入提交：保存、入队、消费是三件事

### 必要记录

每个 RunInputCommit 包含 commitId、runId、平台递增序号、actor、inputRevision/digest、内容引用、接纳时授权版本、目标 session、提交尝试记录、engineMessageId（如已取得）、消费证据位置和取消/延后记录。

提交正文和修订不可修改；处理进度通过追加事实记录。视图可展示 PENDING / SENDING / ENQUEUED / CONSUMED / UNKNOWN / NOT_SENT / DEFERRED，但不能仅凭 SDK 回执把 ENQUEUED 改成 CONSUMED。消费证据必须来自锁定版本经测试的持久事件；若版本不提供可靠映射，消费状态留 UNKNOWN，并禁止以精确来源已确认出具检查结论。

平台保存输入后，只有一个会话输入派发器负责有序提交；不并发调用多个 high-level run() 去争同一 session。连续沟通是平台交互，不意味着每条消息独占一个模型回应。

### 首期追加策略

员工可在运行中发送补充，先入平台持久队列，UI 显示“已保存，等待本次工作接收”。当前模型回合忙时不直接注入 steering；在经验证的原生活动结算点，派发器检查取消、授权、锁和运行状态，再按序提交。此处只管理输入交付，不重做 DSH 的模型/工具执行循环。

业务问题/工具授权回答走原生交互回答通道，不进入普通 prompt 队列，避免等待自己解除的阻塞。用户在 WAITING_FOR_USER 时发普通补充，只保存排队，不把它自动当作当前问题的答案。

资料、配置、应用版本发生变化时，生成新输入修订，旧资料仍只读可追溯。若变化要求换 runtimeLock/能力集合，排入下一 Run，不能给活动进程静默换配置。资料不足仍允许适用的理解/草稿工作，不强制所有文件齐备才能开始。

### 不确定投递

SDK prompt 只有入队回执，不能假设接受平台幂等键。如果发送后连接断开且未收到回执，记录 UNKNOWN，不自动重发同一输入。恢复时查可确认的持久日志证据；无法建立可靠对应关系时，由操作者选择核对后新建尝试，保留风险提示，不能仅按消息正文相同去重。传输重连与任务重跑不是同义词。

### 成果和问题的来源

ArtifactRevision/InteractionRequest 至少记录 runId、launch epoch、生成事件位置、已证实消费的 commit 集合/连续前缀，以及未确认输入范围。只有在逐条连续消费已验证时才能仅保存 consumedThroughSequence；否则必须保存集合或 unknown 标记。

生成前已有的工件不能因后续补充修改来源归属。业务验证器只对确定输入与产物摘要出具回执；来源不完整可以保留草稿，但检查状态为未充分验证。完整性不是“文件存在”或模型口头确认。

## 3. 调度与启动准入

创建 Run、输入快照与 outbox dispatch 同一数据库事务提交。Run 保存 commandSeq、stateRevision、cancelRequestedAt/cancelReason、当前 leaseEpoch 与执行授权引用。

调度者取得租约时生成单调递增 fencing token。token 约束控制数据库、资源服务、回执和新输入的写入；它不能远程阻止已经获得本地文件权限的旧进程写文件，因此旧 worker 的进程树停止与隔离清理仍是必要条件。

监督器在 spawn 前持久登记 launchId 与 launch intent；本机监督器日志/操作系统作业容器必须使“spawn 成功但 PID 尚未写入数据库”也能对账。PID 不是身份，要带进程创建标识/受控进程树句柄防 PID 复用。具体采用何种 OS 机制在目标 Windows/Linux 环境各自验证。

启动顺序：

1. 消费者以 Run 期望状态、commandSeq、leaseEpoch 和未取消条件 CAS 领取启动意图；迟到消息、旧 token、已取消工作直接结束派发。
2. 启动前注册 launchId 和监督责任，取得唯一 spawn permit；取消可撤销未消费 permit。
3. 取得 permit 后仍可能与取消发生竞态。监督器 spawn 后必须再次核验准入，先建立可停止的进程树边界，再发 SDK initialize/恢复/业务输入。若取消已生效，停止该进程，不发送业务输入。
4. 初始化过程中保留监督器的独立取消通道；引擎自身不装配自动唤醒入口。登记 session binding 后再次核验 token、取消与授权才接收业务输入。
5. 任意环节失败进入有所有者的清理/对账。租约过期不是旧进程已退出的证据；接管者先证明旧进程被终止或不存在，再产生新的有效执行。

控制服务不可用时，监督器不能无限期沿用租约。达到部署定义的租约/凭据期限后停止新增输入与副作用能力，并按策略终止执行；状态恢复前保持未知，不在另一节点双跑。

## 4. 取消与完成竞争

取消命令幂等地写入持久 cancelRequestedAt 与递增 commandSeq，阻止新的 dispatch、resume、普通消息与原生授权回答。已有未完成交互标失效；取消回执先返回“已请求取消”，而非“已取消”。

| 原状态 / 竞态 | 原子决定 | 后续责任与状态 |
|---|---|---|
| QUEUED，未授予 spawn permit | 撤销 dispatch/permit；同事务记取消 | 可记 CANCELLED，前提为监督器账本证明没有获准或未知启动 |
| QUEUED/STARTING，permit 已发或 spawn 结果未知 | 记 CANCELLING，拒绝新输入 | 监督器按 launchId 对账并停止；无 PID 不能证明完成 |
| RUNNING/WAITING_FOR_USER | 记 CANCELLING、交互失效、撤销后续准入 | 关闭独占 DSH、确认受管进程树退出、核对外部副作用 |
| FINALIZING 与取消并发 | 使用同一 stateRevision/commandSeq 做 CAS | 取消先提交则不得再报 SUCCEEDED；成功终态先提交则返回 already-terminal，不倒写 CANCELLED |
| 取消超时、监督器失联、外部执行结局不明 | 保存取消意图与未知原因 | UNKNOWN，继续对账；禁止自动重试或恢复业务执行 |
| 已是终态 | 返回原终态及取消处置说明 | 不重复执行停止，不把取消当作回滚 |

只有观察到相应进程树停止、待回答请求失效且执行结局已核对，才进入 CANCELLED。停止不撤销已经完成的写文件/外发；保留实际副作用记录。若某连接器有无法核实的外部工作，UNKNOWN 比“取消成功”更准确。取消请求一旦成立，不可静默清掉并恢复该 Run；重新开展工作走新的 Run，并显式确认输入与已发生副作用。

## 5. Run 完成屏障

状态集合：QUEUED / STARTING / RUNNING / WAITING_FOR_USER / FINALIZING / CANCELLING / SUCCEEDED / FAILED / CANCELLED / UNKNOWN。Work 的业务完成/复核与 Run 的技术终态分离。

普通 prompt 路线必须检查受管后代活动，不能只采用 high-level run 的下一次根 idle。锁定 SDK 的 session/wait 可帮助等待后代结算，但 parked inbox 不阻塞返回；因此它只是屏障的一部分，不是独立完成证明。

终结顺序：

1. 确认当前输入交付状态、原生 terminal/error 与受管后代活动。模型请求上限、拒绝、工具失败等不能仅凭 SDK accepted 映射为业务成功。
2. 原子关闭当前 Run 的输入接纳，转 FINALIZING，记录 acceptedCutoffSequence。CAS 失败或发现截止前待派发输入则继续处理，不漏掉它们。截止后补充保存为下一输入草稿，显示“本次正在结束，尚未执行”，由用户确认或原启动策略明确授权后建立下一 Run。
3. 所有已接纳输入必须被结算：CONSUMED 或明确 NOT_SENT/DEFERRED；有 UNKNOWN 则不得成功。未发送补充只可在有可见说明的情况下延后，不能静默丢弃；对影响当前目标的未执行要求，当前结果保持不完整而非假通过。
4. 平台登记截至最终事件位置的产物清单、摘要、来源与检查事实。AppExecutor 报告完成不能免除平台校验；结果合同不满足则 FAILED，语义/执行结局不明则 UNKNOWN。
5. 确认没有待处理交互、可自行唤醒的 goal/schedule 或未结算工作。parked 输入保留未执行事实并关闭旧运行时，不让它后来在原终态 Run 内再执行；无法确认可控范围时 UNKNOWN。
6. flush/持久化事件与绑定，关闭独占运行时并确认进程树退出；收齐关闭产生的最终事件后冻结投影水位和成果引用。已登记工件必须被复制/封存到不可变 artifact revision 或受控不可写位置，不能之后仍指向可被 worker 改写的临时文件。
7. 根据技术结果和取消竞争，通过最终 CAS 写入 SUCCEEDED/FAILED/CANCELLED；缺少退出/持久证据则 UNKNOWN。SUCCEEDED 仍不代表 QC、UAT 或人工业务批准。

恢复同 Run 不回滚已有副作用，不重新发送已消费输入。重复事件按来源和逻辑序号去重。恢复前先核对已知终态：终态 Run 不可再次激活；新业务需求从 Work 创建新的 Run。

## 6. 人工交互合同

业务澄清、工具授权、计划审阅、业务复核分别建模。原生请求绑定 runId、launchEpoch、root/child sessionId、requestId、输入前缀和过期策略；重新启动后即便字符串 requestId 相同也不是旧请求。

回答在服务端验证身份、项目、请求状态、修订与当前 epoch，通过 CAS 领取唯一回答提交权。传输结果未知不得显示“已被引擎接受”；记录 answer-submission-unknown 并对账，不能自动再放行一次有副作用操作。

用户问题取消只关闭该问题，不等于取消 Run。工具授权的 allowed-once 只授权对应操作，不是业务审核。业务审核绑定不可变工件修订，不使用“聊天中说可以”替代。

浏览器断线不直接停止 worker，但待问题和时限仍由平台管理。超时使用明确策略取消/结束工作，不伪造默认回答。原生问题已随进程关闭失效时，保留历史问题并显式标过期；恢复后的新问题需要新回答。

## 7. 工作台必须展示的事实

- 普通消息显示已保存、待接收、已接收/已消费或未知，不能把网络发送成功当成 AI 已理解。
- 运行与业务检查并列，不以单一绿色完成覆盖未执行 QC。
- 取消先显示正在停止；未知结果提供诊断和处理入口，不自动弹出“重试成功”。
- 旧结果关联其输入与运行版本；追加消息不会改写旧结果的来源标签。
- 项目批次修改只影响新的输入修订；进行中的任务不悄悄切换路径或应用。
- 员工不需要手动推进内部步骤，以上状态是自动运行的可见事实，而不是流程按钮。

## 8. 必须执行的竞争与恢复验收

| 编号 | 场景 | 期望 |
|---|---|---|
| R01 | 相同请求重复提交 | 一份 Run/输入，不重复副作用；未知投递不自动重发 |
| R02 | outbox 延迟，QUEUED 已取消 | 迟到消费者不能再取得启动权 |
| R03 | spawn 成功但绑定前取消/崩溃 | launchId 可找到并清理进程，无无主执行 |
| R04 | 完成/取消同时提交 | 唯一终态、符合 CAS 获胜规则，证据不丢 |
| R05 | 租约丢失后旧进程仍活 | 不并行启动新业务执行，旧输出 token 被拒，直到停止核实 |
| R06 | 运行中补充、入队未消费、发送回执丢失 | 来源不误归、未知不重发、UI 不伪报消费 |
| R07 | 受管后代晚结束 / parked 输入 | 不因根 idle 提前成功，不在终态后执行旧队列 |
| R08 | FINALIZING 时用户追加 | 明确排入下一输入草稿，不混进已封存成果 |
| R09 | 同 Run 恢复与新 Run 重试 | 前者原 session 且旧进程已退出；后者新 session/home，重建上下文可追溯 |
| R10 | 旧问题晚答、撤权、epoch 更换 | 旧回答拒绝，不能授权新操作 |
| R11 | 临时文件登记后仍被修改 | 不可变成果隔离或摘要不一致拒绝，不交付变化后的未检查文件 |
| R12 | SDK 结束但持久化/清理失败 | UNKNOWN，不假报成功或取消 |

取消、源事件消费证明、受管后代和进程树停止均须用锁定 SDK/OS 实测；合同不能代替实现证据。
