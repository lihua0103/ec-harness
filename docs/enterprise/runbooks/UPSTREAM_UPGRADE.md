# DeepSeek Harness 上游升级手册

## 原则

官方源码是独立 submodule。企业插件不在官方目录中，因此上游同步不应覆盖企业实现。

## 流程

```sh
git checkout -b chore/upgrade-dsh-<version>
git submodule update --remote --merge upstream/deepseek-harness
pnpm install --dir upstream/deepseek-harness
pnpm run upstream:verify
pnpm --dir upstream/deepseek-harness run typecheck
pnpm --dir upstream/deepseek-harness run test
pnpm --dir upstream/deepseek-harness run build
pnpm run typecheck
pnpm run test
pnpm run check:architecture
pnpm run profile:dump
```

## 冲突处理

- 官方 submodule 冲突：按官方仓库规则处理。
- 企业插件冲突：只处理企业目录自身变更。
- 官方 row 发生变化：更新企业 patch，并新增 ADR 说明配置字段与行为变化。
- SessionEventMap、Agent 生命周期、Typert RPC、Host/Client aggregate 变化：必须做专项回归。

## 发布

升级分支必须记录：

- 上游 commit SHA
- 官方版本号
- pnpm lockfile 变化
- 企业插件兼容性结果
- WebUI 关键路径结果
- 回滚 commit SHA
