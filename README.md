# DeepSeek Harness 企业版

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 核心架构的纯净二次开发基座。

> 仅保留核心 harness 能力与 WebUI，已移除 examples、website、python SDK、第三方搜索 provider、品牌皮肤等非核心社区插件。

---

## 环境要求

- **Node.js**：`^22.19.0 || >=24.0.0`
- **包管理器**：pnpm `>=11.7.0`

---

## 快速开始

```sh
# 1. 安装依赖（企业内部网络环境下执行）
pnpm install

# 2. 构建核心库 + Web 前端
pnpm run build

# 3. 启动 Web UI，默认监听 http://127.0.0.1:3080
pnpm dsh web
```

---

## 仓库结构

```
.
├── apps/
│   ├── cli/              # dsh 命令行入口
│   └── web/              # Vite Web 前端构建
├── packages/
│   ├── core/             # 会话、工具、Agent、Agent Loop
│   ├── api/              # Typert RPC / 远程 BFF
│   ├── typert/           # 类型图生成与注册
│   ├── llm/              # 大模型能力缝与官方适配
│   ├── client/           # Web UI 模块（ui-* + web 启动）
│   ├── web/              # Web 能力缝（fetch/search 抽象）
│   ├── boot/             # profile / bundle 启动
│   ├── bundle/           # base / web-app profile bundle
│   └── ...               # 其他核心能力包
├── vendor/               # 内联 Cordis 框架
├── native/               # landlock-run 原生安全沙箱
├── ENTERPRISE_ARCHITECTURE.md  # 企业架构方案
├── CODING-STANDARDS.md         # 代码开发规范
└── pnpm-workspace.yaml         # workspace 配置
```

---

## 常用命令

```sh
pnpm install                 # 安装所有 workspace 依赖
pnpm run build               # 构建所有产物
pnpm run build:web           # 仅构建 Web 前端
pnpm run typecheck           # TypeScript 全量类型检查
pnpm run lint                # 运行 oxlint
pnpm run test                # 运行单元测试
pnpm run test:gui            # 运行 client/host 测试
pnpm dsh web                 # 启动 Web UI
pnpm dsh web --no-open       # 启动但不自动打开浏览器
```

---

## 二次开发入口

1. **新增企业能力 provider**：参考 `packages/llm/llm` 的服务定义模式，在 `packages/enterprise/providers/` 下新建包。
2. **新增 Web UI 面板**：参考 `packages/client/ui-conversation`，在 `packages/enterprise/ui/` 下新建 `ui-*` 包。
3. **组合企业 profile**：在 `packages/enterprise/bundles/` 下编写 `cordis.patch.yml`，通过 `--patch` 加载。

详细约定见：

- [ENTERPRISE_ARCHITECTURE.md](./ENTERPRISE_ARCHITECTURE.md)
- [CODING-STANDARDS.md](./CODING-STANDARDS.md)
- [docs/architecture.md](./docs/architecture.md)
- [AGENTS.md](./AGENTS.md)

---

## 已精简内容

相比官方完整仓库，本企业版已移除：

- `examples/`、`website/`、`python/`
- `packages/e2b`、`packages/experimental`
- 第三方搜索 provider：`web-search-deepseek`、`web-search-exa`、`web-search-perplexity`
- 官方品牌皮肤：`ui-brand-official`
- `.github/` CI 配置
- 大量非核心校验脚本与生成脚本

---

## 许可证

[MIT](LICENSE)

第三方依赖及许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
