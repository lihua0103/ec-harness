# 企业 Agent 开发工作流

## 1. 需求分类

先判断需求属于哪一类：

- 模型接入：LLM Provider
- 模型工具：Tool Consumer
- 请求治理：Agent/Tool/FS/Telemetry Event
- 持久化事实：Session Event + Projection
- WebUI：Client UI plugin + Host RPC/Service
- 配置能力：Settings namespace + Settings UI
- 安全能力：Credentials、Identity、Approval、Permission、Sandbox 或 Subprocess

禁止因为“改起来方便”直接修改 Agent Loop 或官方核心服务。

## 2. 设计评审

实现前必须提交：

- 扩展点说明
- Service Definition / Provider / Consumer 关系
- 数据是否模型可见
- 是否需要 Session Event
- 配置与凭证来源
- 企业 row id 与包名
- 上游升级影响

非简单改动必须新增 ADR。

## 3. 实现顺序

1. 编写接口和类型。
2. 编写 Provider/Consumer。
3. 用 `ctx.effect()`、`ctx.on()` 注册。
4. 写 Profile patch。
5. 写装配测试。
6. 写 UI 或 replay 测试。
7. 运行质量门禁。

## 4. 交付门禁

```sh
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run check:architecture
pnpm run check:upstream
```

涉及官方升级时，额外执行 `pnpm run upstream:verify` 和 `pnpm run profile:dump`。
