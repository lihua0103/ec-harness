# DeepSeek Harness 企业二次开发架构审计

## 1. 审计结论

DeepSeek Harness 不是一个普通的 Web 应用，而是建立在 Cordis 之上的可组合 Agent Harness：模型、会话、工具、Agent Loop、持久化、Web UI 都是插件。企业二次开发的最小正确单位不是复制或重写核心，而是新增插件、Provider、Consumer 和 profile patch。

本项目采用以下结论：

- 官方 Harness 源码是上游基线，保留其完整核心能力。
- 企业功能全部位于独立的 `packages/enterprise/*`，不直接修改官方 `packages/*`。
- 企业装配配置位于独立 profile/patch 层，不直接修改官方 `packages/bundle/*/cordis.patch.yml`。
- 官方升级通过 `upstream` remote + 定期同步完成；企业插件目录和企业 patch 不被上游覆盖。
- pnpm 是唯一包管理器，官方 workspace 与企业 workspace 统一由 pnpm 管理。

## 2. 官方架构模式

### 2.1 Cordis

Cordis 的核心对象是 `Context`。插件通过服务、事件和可逆 Effect 向 Context 注册能力。插件卸载时 Effect 必须撤销注册，因此所有注册都必须通过 `ctx.effect()`、`ctx.on()` 或官方 Registry API 完成。

### 2.2 Agent 运行链路

```text
turn/start
  -> agent/pre-step
  -> step/start
  -> agent/request
  -> llm/stream
  -> assistant/chunk*
  -> assistant/message
  -> tools/pre-execute
  -> tools/execute
  -> tools/post-execute
  -> tool/result*
  -> step/end
  -> turn/end
```

需要持久化的事实必须写入 Session Event；只影响当前运行的拦截、策略和适配器使用实时事件。

### 2.3 Profile 与 Bundle

Profile 是插件树，Bundle 是可安装的 Cordis 配置层。Web 启动通常由以下层组合：

```text
空配置
  -> dsh-base
  -> dsh-web-app
  -> 企业 profile cordis.patch.yml
  -> 用户层 patch
  -> --patch overlay
```

后加载层以 row id 为目标替换完整配置。企业必须使用独立 row id，避免与官方 row 冲突。

## 3. 官方代码边界

| 区域 | 所有权 | 企业策略 |
|---|---|---|
| `vendor/` | 官方 Cordis 依赖 | 只读，不改业务代码 |
| `packages/core/` | Harness 核心大脑 | 只读，使用事件和服务扩展 |
| `packages/llm/` | LLM 能力缝与官方 Provider | 新 Provider 放企业目录 |
| `packages/client/` | Web UI 工作台 | 新 UI 插件放企业目录 |
| `packages/bundle/` | 官方 profile layer | 企业不改原 patch |
| `apps/` | 官方启动装配 | 仅在上游同步时更新 |
| `packages/enterprise/` | 企业所有 | 企业功能唯一主目录 |
| `profiles/enterprise/` | 企业所有 | 企业组合层 |
| `docs/enterprise/` | 企业所有 | 架构、规范、升级记录 |

## 4. 当前风险审计

1. 直接修改官方 bundle 会在上游升级时产生高冲突。
2. 把企业功能写入官方 Core 会破坏升级边界。
3. 复制官方源码到另一个目录会造成双份运行时和版本漂移。
4. 只依赖发布版 npm 包可以运行，但不能满足源码级企业二次开发。
5. 企业功能若把模型可见内容写在内存中而不入 Session Log，会导致重放、审计和恢复不一致。
6. Provider、Consumer、Service Definition 不完整时，功能只能在特定装配下工作，无法成为稳定扩展。

## 5. 审计后的实施门槛

在实现企业插件前必须完成：

- 明确插件所属能力缝。
- 定义 Service Definition、Provider、Consumer 三个角色。
- 确认模型可见内容是否需要 Session Event。
- 确认配置是否可由企业 profile patch 调整。
- 确认企业 row id、包名和公开 exports 不与官方冲突。
- 添加单元测试、装配测试和必要的 WebUI 测试。
- 在升级演练中验证官方同步不会覆盖企业目录。
