# @ec-clinical/platform-knowledge

平台公共知识服务与独立 Cordis bundle。业务插件通过 `ctx.clinicalKnowledge` 使用它，
不得在自身包内复制或拥有该服务生命周期。

## 安装与验证

```bash
cd packages/platform-knowledge && pnpm install
```

```bash
cd packages/platform-knowledge && PATH="/d/package/Nvm/nvm/v24.9.0:$PATH" npm run verify
```

bundle 配置可指定存储路径（相对 `DSH_HOME` 或绝对路径）；缺省为 `platform/knowledge.sqlite`：

```yaml
- id: ec-platform-knowledge
  name: '@ec-clinical/platform-knowledge/cordis'
  config:
    storePath: platform/knowledge.sqlite
```

## 激活语义

- `CANDIDATE` 候选可检索（显式 `states`），不进入默认 ACTIVE 检索。
- 已安装验证器的固定用例通过，只证明工具回归（`TOOL_REGRESSION_ONLY`）。
- 只有候选声明的全部 `claims` 都被该验证器 `coverage` 覆盖且用例通过，才转为 `ACTIVE`
  （`CONTENT_CLAIMS`），回执记录已验证的 claims。
- 无 claims、部分覆盖、测试失败、候选变化或验证器替换均不激活。

本包只负责状态与回执，不声称任何方法正文已被业务评审。