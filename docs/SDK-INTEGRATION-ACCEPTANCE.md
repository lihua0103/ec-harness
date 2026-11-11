# SDK 集成交付级验收记录

- 日期:2026-11-11
- 被测对象:锁定源码 `upstream/deepseek-harness-git` v0.2.2-rc.1(构建产物),`@deepseek-ai/dsh-sdk-client` 0.2.2-rc.1
- 结论:**11/11 用例真实模型运行通过**(权威轮 2026-11-11T01:53–01:56Z,约 3 分钟);用例 09(崩溃注入)套件就绪但被执行权限拦截,待批准后补跑。
- 定位:这是 SDK/引擎集成层的交付级验收,**不等于**平台上线验收——发布/生命周期/知识验证三份合同的 A01–A08、R01–R12、K01–K08 仍需在真实的企业运行基线与平台服务上执行。本记录同时产出了若干改变基线设计的引擎事实(见 §3)。

## 1. 套件与产物

| 项 | 位置 |
|---|---|
| 验收套件 | [scripts/sdk-acceptance/run-all.mjs](../scripts/sdk-acceptance/run-all.mjs) |
| overlays | basic(全禁工具)/ tools(fs 读写)/ ask(问答链路)三份,一次性 `--patch` |
| 隔离 | 每用例独立 `DSH_HOME` + 合成工作区;重跑换时间戳目录,不删除任何目录 |
| 报告 | `.runtime/sdk-acceptance/report.json`(逐用例 pass/facts/error/耗时) |
| 复跑 | `"/d/package/Nvm/nvm/v24.9.0/node.exe" scripts/sdk-acceptance/run-all.mjs`;`CASE_FILTER=<id,...>` 跑子集 |

用例失败保留真实错误并以非零退出;响应逐字记录,不做预设文本遮罩。凭据 `ZAI_CODING_CN_API_KEY` 只检查存在、只经 `apiKeyEnv` 引用,全程不打印。

## 2. 用例矩阵(权威轮)

| # | 用例 | 验收目标 | 结果 | 关键证据 |
|---|---|---|---|---|
| 01 | init-prompt-contract | 子进程 initialize、prompt、事件校验、关闭 | ✓ | 严格 JSON 契约一次通过;全部 durable events 过 `validatedSessionEvent`;`session.status` 可观测 |
| 02 | tool-execution | 真实工具执行落盘 | ✓ | 模型经 fs 工具创建 `TOOL-PROBE.txt`,磁盘内容逐字节断言通过;事件含 `tool/call`/`tool/result` |
| 03 | multi-turn-memory | 同会话多轮记忆 | ✓ | 第二轮准确回溯第一轮代号"玄武-7391" |
| 04 | user-question-answer | 原生提问端到端应答 | ✓ | `ask_user_question` → 宿主收到 `{requestId,sessionId,questions[]}`,应答 XLSX 后模型最终回复明确采纳 |
| 05 | user-question-cancel | 提问取消路径 | ✓ | 宿主 `{cancelled:true}` 后 turn 体面完成,模型正确理解跳过 |
| 06 | concurrent-sessions | 并发会话隔离 | ✓ | 双会话并行,结果互不污染;逐会话通知过滤无串线 |
| 07 | resume-missing-rejects | 恢复不存在会话拒绝 | ✓ | `JsonRpcResponseError: session "…" not found` |
| 08 | resume-occupied-rejects | 跨进程占用恢复拒绝(租约) | ✓ | `JsonRpcResponseError: session "…" is already owned by an active write handle` |
| 10 | truncation-reason | 截断终止语义 | ✓ | `finishReason="max-tokens"`,finalResponse 为空 |
| 11 | lowlevel-subscribe-wait-drain | 平台任务消费模式 | ✓ | `subscribeSessionTree` → run → `session/wait` → `tryNext` 排空全链路,无串线 |
| 12 | approval-channel | 审批通道安装与工具写入 | ✓* | 文件写入成功;**审批请求未触发**(见 §3-5),通道安装/协议面正常 |
| 09 | crash-takeover-resume | 强杀子进程后跨进程恢复 | 待执行 | 套件就绪;执行需强制结束测试自拉子进程的权限,待批准 |

## 3. 平台级新事实(必须落进设计/合同)

1. **sdk-minimal 无问答链路**:`ask_user_question` 工具(`tool-ask-user`)与 `userQuestions` 服务(`user-questions`)都不在 sdk-minimal,须**成对**显式插入 overlay。企业运行基线清单必须包含交互插件组——这不是选项,是缺了就没法实现 WAITING_FOR_USER 状态的事实。
2. **durable event 词表实测完整**(02/05/12 三轮一致):`agent/inbox/spliced, turn/start, step/start, system/message, user/message, request/header, request/context, session/title, assistant/message, tool/call, tool/result, step/end, turn/end`。**没有逐 token 事件**:`assistant/message` 是整条消息级事件。平台进度模型必须按事件级设计;若产品要求逐 token UI,需另找通道并单独验证。
3. **占用拒绝 = 引擎原生写柄租约**:`already owned by an active write handle`。运行生命周期合同的 LaunchAttempt/fencing epoch 在引擎层有直接对应物,Worker 接管时"旧进程仍持柄"可检测,不必自造心跳。
4. **截断语义**:`finishReason="max-tokens"`,且该轮 finalResponse 为空。平台 Run 判定必须以 finishReason 为准,不能把"有响应文本"当成功;max-tokens 轮要进重试/降级策略而不是记 SUCCEEDED。
5. **审批通道未触发**:approvalRequests+onRequest 安装成功,但 danger-full-access 沙箱基线下 fs 写入直接放行。真实审批触发需要 gating 权限预设——归入企业基线的权限工程,A 系列验收要含"审批真的弹出过"的场景,不能只验安装。
6. **onRequest 时序约束**:`client.start()` 之后才能安装请求处理器,否则 `TransportClosedError`。平台 Executor 代码须按此顺序。
7. **onUserQuestion 取消即收敛**:宿主 dismiss 后运行体面完成,不悬挂、不报错——WAITING_FOR_USER 的用户放弃路径在引擎层免费获得。

## 4. 未覆盖边界(诚实清单)

1. 用例 09 崩溃接管:套件与 PID 精确匹配注入已就绪,待执行许可;在补跑通过前,"非正常退出后的历史完整性"**没有**运行证据。
2. 真实审批触发(需权限预设工程)、审批拒绝/取消分支。
3. 多 runtime 同 home 并发写的历史一致性(08 只证了"拒绝进入",没证"持久文件不损坏")。
4. 会话压缩、超长会话、深层子代理树(`subscribeSessionTree` 只测了单层)。
5. `sdk-minimal + overlay` ≠ 企业运行基线;A01–A08/R01–R12/K01–K08 仍待在其目标实现上执行。
6. 逐 token 流式:事件面已证不存在(§3-2),备选通道未验证。

## 5. 对既有文档的影响

- [SDK 最小接入冒烟记录](SDK-MINIMAL-INTEGRATION-VERIFICATION.md):仍有效,是其首批证据;本记录在能力覆盖上取代它作为集成层验收基准。
- 发布合同企业基线清单需增补:交互插件组(§3-1)、事件级进度假设(§3-2)、finishReason 判定规则(§3-4)、审批触发场景(§3-5)。
- 运行生命周期合同:租约语义可绑定引擎 `active write handle`(§3-3)。
