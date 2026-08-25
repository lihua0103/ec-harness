# DeepSeek Harness 企业版架构技术方案

> 版本：v1.0 | 基于 DeepSeek Harness (`dsh`) 0.1.1-rc.2 精简 | 包管理器：pnpm 11.x | Node.js：^22.19 || >=24

## 1. 设计目标

本仓库为企业提供一份**纯净、可控、可二次开发**的 DeepSeek Harness 核心代码基座，目标如下：

1. **只保留核心 harness 架构**：保留 Cordis 插件框架、Agent 执行循环、会话日志、工具管线、LLM 适配、Web UI 外壳等核心能力。
2. **去除社区/示例/品牌插件**：已移除 `examples/`、`website/`、`python/`、`packages/e2b`、`packages/experimental`、第三方搜索 provider（Exa/Perplexity/DeepSeek search）、官方品牌皮肤等。
3. **根目录即系统项目**：不新建多余子目录，企业可直接基于根目录进行版本控制和 CI/CD。
4. **统一 pnpm 工作区**：所有扩展必须走 workspace 机制，禁止在仓库外游离依赖。

---

## 2. 总体架构

### 2.1 架构分层

```
┌─────────────────────────────────────────────────────────────┐
│  产品装配层 (apps)                                            │
│  ├── apps/cli        # dsh 命令行入口，负责 profile 组合与启动     │
│  └── apps/web        # Vite 前端产物构建，输出 dist 供 cli 服务    │
├─────────────────────────────────────────────────────────────┤
│  运行 bundle 层 (packages/bundle)                             │
│  ├── base            # dsh-base：每个 profile 的第一层补丁        │
│  └── web-app         # dsh-web-app：Web UI 专属补丁层            │
├─────────────────────────────────────────────────────────────┤
│  Web UI 层 (packages/client)                                  │
│  ├── web             # 浏览器启动内核（模块系统、BootPage）      │
│  ├── modules         # 客户端模块表与运行时连接                  │
│  ├── ui-*            # 视图/交互组件（会话、侧边栏、设置等）     │
│  └── runtime/connection/hmr  # 前端运行态基础设施              │
├─────────────────────────────────────────────────────────────┤
│  核心能力层 (packages/core / api / typert / llm)              │
│  ├── core/session    # 会话事件日志                             │
│  ├── core/tools      # 工具注册与执行管线                       │
│  ├── core/agent      # Agent 接口与实时注册表                   │
│  ├── core/agent-loop # 默认 Agent 驱动                         │
│  ├── api/gateway     # Typert RPC 网关                        │
│  └── llm/llm         # LLM 能力缝与模型适配                     │
├─────────────────────────────────────────────────────────────┤
│  企业扩展层 (packages/enterprise) —— 二次开发主战场              │
│  ├── providers       # 企业私有大模型/搜索/存储 provider        │
│  ├── ui              # 企业定制 UI 模块/主题                    │
│  └── bundles         # 企业 profile bundle 补丁                │
├─────────────────────────────────────────────────────────────┤
│  框架底座层 (vendor)                                          │
│  └── cordis / cordis-plugin-*  # 一切皆插件的运行时框架         │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心设计原则

- **一切皆插件**：每个能力（LLM、工具、UI 面板、存储）都是 Cordis 插件，通过 `cordis.patch.yml` 组合。
- **模型可见 ⟺ 可记录**：所有进入模型请求的内容必须能通过会话日志重建。
- **能力缝完整**：新增一个能力 = 服务定义(Service Definition) + 服务提供者(Provider) + 消费者(Consumer)。
- **Source plane vs Artifact plane 分离**：静态检查走 `src/`，运行时加载走 `lib/`。

### 2.3 推荐部署形态

```
开发环境：pnpm install → pnpm run build → pnpm dsh web
测试环境：pnpm run test → pnpm run test:gui
生产环境：pnpm run build:official → 启动 dsh web（可配置 host/port）
```

---

## 3. Web UI 功能模块

### 3.1 启动链路

1. `apps/cli/src/bin.ts` 解析 `dsh web`。
2. `apps/cli` 组合 `base` + `web-app` profile 树。
3. `apps/web/src/main.ts` 找到 `#root`，实例化 `AppWebEntry`。
4. `packages/client/web/src/boot.ts` 加载模块表、激活 Cordis 插件、渲染 BootPage。
5. 各 `ui-*` 插件通过 `ui-renderer` 与 `ui-slots` 注册视图。

### 3.2 主要视图模块

| 包名 | 一句话职责 |
|---|---|
| `ui-layout` | 总布局框架 |
| `ui-sidebar` | 左侧会话/工作区导航 |
| `ui-conversation` | 对话消息渲染 |
| `ui-input-trigger` | 用户输入框与快捷命令 |
| `ui-commands` | `/` 命令面板 |
| `ui-goal` | 目标(goal)管理 |
| `ui-jobs` | 后台任务面板 |
| `ui-model-selection` | 模型选择器 |
| `ui-settings-general` | 通用设置 |
| `ui-settings-models` | 模型参数设置 |
| `ui-settings-plugins` | 已安装插件清单 |
| `ui-skill` | 技能(skill)管理 |
| `ui-subagent` | 子代理面板 |
| `ui-tool` | 工具调用展示 |
| `ui-trajectory` | 执行轨迹 |
| `ui-workspace` | 工作区管理 |
| `ui-theme` | 主题/深色模式 |
| `ui-attachment` | 附件预览 |
| `ui-message-feedback` | 消息反馈 |
| `ui-deliverables` | 交付物 |
| `ui-plan` | Plan 模式 |
| `ui-workflow-run` | 工作流运行 |
| `ui-permission-presets` | 权限预设 |
| `ui-directory-picker-*` | 目录选择器(browse/native) |

### 3.3 扩展 Web UI 的标准方式

1. 新增 `packages/client/ui-<feature>` 插件包。
2. 在该包中导出视图组件，并通过 `ui-renderer`/`ui-slots` 注册。
3. 在 `packages/enterprise/bundles/<name>/cordis.patch.yml` 中挂载/替换对应 row。
4. 运行 `pnpm dsh web --patch ./your.patch.yml` 验证。

---

## 4. 企业扩展目录

所有企业定制必须落在 `packages/enterprise/` 下，禁止直接修改 `packages/core/`、`vendor/`、`apps/cli/` 的原始实现（只读参考）。

```
packages/enterprise/
  providers/
    llm-<name>/          # 企业私有大模型适配
    search-<name>/       # 企业搜索 provider
    storage-<name>/      # 企业存储 provider
  ui/
    ui-<feature>/        # 新增视图
    theme/               # 企业主题/Brand
  bundles/
    enterprise/          # 企业 profile bundle
      cordis.patch.yml
      package.json
```

---

## 5. 技术栈约束

| 层级 | 技术 |
|---|---|
| 语言 | TypeScript 6.x（ESM only） |
| 运行时 | Node.js ^22.19 \|\| >=24 |
| 包管理 | pnpm 11.x |
| 构建 | tsc + tsdown + vite |
| 测试 | vitest |
|  lint  | oxlint |
| 插件框架 | Cordis（vendor/ 内联） |
| 前端 | React 18 + Vite |

---

## 6. 已移除内容清单

- `examples/`、`website/`、`python/`
- `packages/e2b`、`packages/experimental`
- `packages/web/web-search-deepseek`、`web-search-exa`、`web-search-perplexity`
- `packages/client/ui-brand-official`
- `.github/`（含 CI）
- 非核心 gate/verify 脚本
- 原 `pnpm-lock.yaml`

后续如需恢复某项，需从官方仓库单独引入并更新 workspace 依赖。

---

## 7. 相关文档

- [CODING-STANDARDS.md](./CODING-STANDARDS.md) —— 代码开发规范
- [docs/architecture.md](./docs/architecture.md) —— 官方架构文档
- [AGENTS.md](./AGENTS.md) —— 官方贡献约定
- [docs/development.md](./docs/development.md) —— 官方开发指南
