# DSH Guard 企业架构

## 1. 设计原则

- **纯净骨架**：不携带 DeepSeek Harness 源码，通过 npm 依赖官方运行时。
- **插件扩展**：企业业务全部以 Cordis 插件形式落地。
- **pnpm 工作区**：`packages/enterprise/*` 统一管理。

## 2. 运行时架构

```
┌──────────────────────────────────────┐
│  你的企业插件（packages/enterprise/*） │
├──────────────────────────────────────┤
│  configs/cordis.yml                  │
├──────────────────────────────────────┤
│  @deepseek-ai/dsh（官方运行时）        │
├──────────────────────────────────────┤
│  Node.js + pnpm                       │
└──────────────────────────────────────┘
```

## 3. 目录职责

| 路径 | 职责 |
|---|---|
| `configs/cordis.yml` | profile：挂载 base、web-app、企业插件 |
| `packages/enterprise/` | 企业插件仓库 |
| `scripts/` | 初始化、构建、工具脚本 |
| `docs/enterprise/` | 企业开发文档 |

## 4. 扩展点

- **模型/凭证 provider**：替换默认 DeepSeek 适配
- **UI 插件**：通过 `dsh-client-ui-*` 注册视图
- **工具插件**：通过 `dsh-tools` 注册模型可调用工具
- **安全/审计插件**：拦截事件、记录日志
