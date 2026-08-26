# DSH Enterprise Platform

面向企业二次开发的 DeepSeek Harness 扩展平台。

本项目保留 DeepSeek Harness 的官方核心能力，并把企业代码、企业 Profile、企业治理脚本与官方源码严格隔离：

```text
upstream/deepseek-harness/     官方 Harness 源码基线，由 Git submodule 管理
packages/enterprise/           企业插件实现
profiles/enterprise/           企业 Bundle/Profile 装配
scripts/                       上游同步、架构检查、Profile 运行入口
docs/enterprise/               企业架构、规范、升级手册
```

企业代码不复制官方实现，不修改官方 `packages/`、`vendor/`、`apps/`。

## 环境

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- Git

## 初始化

```sh
git submodule update --init --depth 1
pnpm install
pnpm run check:upstream
pnpm run check:architecture
```

## 一键启动

Windows 双击根目录的 start.bat，或执行：

pnpm start

启动器会自动检查并使用 pnpm 安装根项目、官方 Harness 和企业 Profile 依赖；缺少企业插件或官方 Harness 构建产物时会自动构建，然后启动 WebUI。

依赖目录、lib/、dist/、构建缓存和会话文件均已加入 .gitignore，上传代码时只提交源码、配置、文档和 pnpm-lock.yaml。

## 启动 WebUI

```sh
pnpm run profile:run
```

该命令调用官方 Harness 的 `dsh web`，并叠加 `profiles/enterprise/cordis.patch.yml`。

## 开发流程

```sh
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run check:architecture
```

新增企业能力时：

1. 先阅读 [架构审计](./docs/enterprise/ARCHITECTURE_AUDIT.md)。
2. 选择官方 Service Definition、Provider、Consumer 或 Event 扩展点。
3. 在 `packages/enterprise/<capability>/` 新建插件包。
4. 在 `profiles/enterprise/cordis.patch.yml` 添加企业 row。
5. 添加插件加载、卸载、装配和必要的 Session replay 测试。
6. 运行官方基线检查与企业检查。

## 官方升级

```sh
pnpm run upstream:status
pnpm run upstream:sync
pnpm run upstream:verify
```

完整流程见 [UPSTREAM_UPGRADE.md](./docs/enterprise/runbooks/UPSTREAM_UPGRADE.md)。

## 文档

- [架构审计](./docs/enterprise/ARCHITECTURE_AUDIT.md)
- [插件架构](./docs/enterprise/PLUGIN_ARCHITECTURE.md)
- [企业代码规范](./docs/enterprise/CODING_STANDARDS.md)
- [开发工作流](./docs/enterprise/DEVELOPMENT_WORKFLOW.md)
- [升级手册](./docs/enterprise/runbooks/UPSTREAM_UPGRADE.md)
- [安全与审计](./docs/enterprise/runbooks/SECURITY_AUDIT.md)
- [ADR 模板](./docs/enterprise/adr/0000-template.md)
