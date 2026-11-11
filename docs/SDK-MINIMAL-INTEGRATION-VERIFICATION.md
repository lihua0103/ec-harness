# SDK 最小真实接入验证记录

> 2026-11-11 后续:交付级验收套件已完成 11/12 用例(工具执行、多轮、提问应答/取消、并发隔离、恢复拒绝、截断、排空、审批通道),见 [SDK-INTEGRATION-ACCEPTANCE](SDK-INTEGRATION-ACCEPTANCE.md)。本记录保留为首批冒烟证据。

- 日期:2026-11-11
- 被测对象:锁定源码 `upstream/deepseek-harness-git` v0.2.2-rc.1(构建产物),`@deepseek-ai/dsh-sdk-client` 0.2.2-rc.1
- 结论:**最小真实接入全链路通过**。SDK 子进程拉起、initialize、真实 prompt、严格 JSON 契约响应、Session durable events/status、隔离 home 持久化、跨进程精确恢复与恢复后新 prompt、干净关闭,全部实测通过(三次真实运行,每次约 16–20 秒)。
- 边界:本次验证**不构成**发布/生命周期/知识验证三份合同的 A01–A08、R01–R12、K01–K08 任何一条验收;架构 §19"只读核对不是运行验收"现在有了第一份运行证据,但企业运行基线验收仍需按合同另做。

## 1. 验证方式

- 脚本:[scripts/sdk-minimal-e2e.mjs](../scripts/sdk-minimal-e2e.mjs) — 从构建后的 client lib 导入 `DeepSeekHarness`/`validatedSessionEvent`,拉起 `dsh --profile sdk-minimal` 子进程。
- 一次性 overlay:[scripts/sdk-minimal-e2e.overlay.yml](../scripts/sdk-minimal-e2e.overlay.yml) — 经 `--patch` 注入 `@deepseek-ai/dsh-llm-pi-ai`(zai-coding-cn 路由,anthropic-messages → bigmodel 端点,`apiKeyEnv: ZAI_CODING_CN_API_KEY`)+ 默认模型,并关闭 plugin-manager、schedule、workspace-dependencies、两个持久 shell、working-directory,同时禁用 tool-fs 全部读写。凭据只经环境变量被 SDK 引用,脚本与报告从不打印。
- 隔离:独立 `DSH_HOME`(`.runtime/sdk-minimal-e2e-home`)、合成工作区(`.runtime/sdk-minimal-e2e-workspace`),无任何真实临床数据。
- 模型:glm-5.3-flash(maxTokens 512)。两次真实 prompt 均要求只返回固定 JSON:第一轮 `{status:"SDK_PROMPT_RECEIVED",received:true,canAnswerQuestions:false}`,恢复轮 `{status:"RESUME_PROMPT_OK"}`,模型一次通过,报告逐字记录实际响应,不做预设文本遮罩。
- 报告:`.runtime/sdk-minimal-e2e-report.json`(每次运行覆盖;失败时保留真实错误并以非零退出)。

## 2. 已证实事实

1. 同版本 SDK 客户端以 `dshBin` 拉起子进程,20 秒内完成 initialize 握手。
2. `session/prompt` 入队后最终响应为区间末尾根文本;严格 JSON 契约在真实模型上成立。
3. 单轮产生 13 条 Session durable events,全部通过 `validatedSessionEvent` 校验;`session.event` 与 `session.status` 通知对本会话可观测。
4. 隔离 home 的 `sessions/` 持久化真实存在。
5. `close()` 干净收尾,进程无悬挂。
6. **跨进程精确恢复**:新进程对上一轮进程产生的 `session-cb3adca6…` 执行 `resumeSession`,返回 handle id 精确一致;在恢复出的会话上再发一次真实 prompt,正常完成(符合 client api.ts"恢复不拒发输入、handle 可继续运行"的语义)。
7. 运行基线事实:**sdk-minimal 只内置 deepseek-official adapter**。首次运行实测报错 `no adapter registered for provider "zai-coding-cn"`,必须经 patch 注入 llm-pi-ai 路由才能使用配置的其他 provider。这直接支撑[发布合同](PLATFORM-APPLICATION-RELEASE-CONTRACT.md)的运行基线要求:企业 profile 必须显式声明 provider 组合,不能假设 sdk-minimal 自带。

## 3. 验证过程中的失败与修正(防止同样的误读进入平台代码)

- 首次运行失败(见上,provider adapter 缺失)→ overlay 修复;这是**运行基线的真实约束**,不是临时补丁。
- 恢复断言首版用 `resumed.sessionId` 判断,实际 `HarnessSession` 的属性是 `id`(client api.ts:230),导致误报 `RESUME_RETURNED_DIFFERENT_SESSION`;修正为 `resumed.id` 后通过。平台代码对接时注意同一命名。

## 4. 未覆盖边界(诚实清单)

1. 未调用任何 DSH 工具、业务插件工具、文件读写(overlay 已禁用;tool-fs 连只读也关闭)。
2. `user-question/ask` 未真实触发——`onUserQuestion` 取消回调挂载但从未被调用;approval opt-in 未验证。
3. 中途取消、取消竞争、Worker 崩溃接管、FINALIZING 完成屏障、成果登记均未验证([运行生命周期合同](PLATFORM-RUN-LIFECYCLE-CONTRACT.md)范围)。
4. 逐 token 流式未验证(本次只观测最终响应)。
5. 客户端事件过滤 ≠ 租户隔离;Run 级隔离需按 R 系列合同验证。
6. 单会话单轮覆盖;多轮长会话、压缩、并发会话未验证。
7. `sdk-minimal + overlay` ≠ 企业运行基线;企业 profile(发布合同企业基线 7 条)与 A01–A08 验收仍待做。

## 5. 复跑方式

```bash
"/d/package/Nvm/nvm/v24.9.0/node.exe" scripts/sdk-minimal-e2e.mjs
```

```bash
DSH_E2E_RESUME_SESSION_ID=<上轮 sessionId> "/d/package/Nvm/nvm/v24.9.0/node.exe" scripts/sdk-minimal-e2e.mjs
```

环境需有 `ZAI_CODING_CN_API_KEY`(只引用,不打印)。恢复轮必须先有一轮成功运行产生的持久会话。
