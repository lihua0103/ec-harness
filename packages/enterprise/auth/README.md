# @dsh-guard/enterprise-auth

企业级认证插件骨架。

## 当前状态

⚠️ **这是一个未完成的插件骨架**，默认在 `configs/cordis.yml` 中处于 `disabled: true`。

配置契约、服务注册与 Context 类型扩展已就位，但具体认证逻辑尚未实现——
调用 `authenticate()` 会抛出 `认证提供商 <provider> 尚未实现`。

| 能力 | 状态 |
|------|------|
| 插件注册与配置契约 | ✅ 已实现 |
| OAuth2 认证 | ⬜ 未实现 |
| LDAP 认证 | ⬜ 未实现 |
| SAML 认证 | ⬜ 未实现 |
| 会话管理 | ⬜ 未实现 |
| 多因素认证（MFA） | ⬜ 未实现 |

## 配置

```yaml
plugins:
  - name: '@dsh-guard/enterprise-auth'
    disabled: false          # 改为 false 才会加载
    config:
      enabled: true
      provider: oauth2       # ldap | oauth2 | saml
      sessionTimeout: 3600000
```

相关凭据通过环境变量注入，见根目录 `.env.example` 的「企业认证」段。

## 开发说明

本插件遵循 cordis v4 的两个约束：

1. **不使用 `Schema`** —— cordis v4 不再导出 Schema（由独立的
   `@deepseek-ai/schemastery` 提供，本项目未安装）。配置用 TypeScript
   接口加 `DEFAULT_CONFIG` 常量表达。
2. **`Service` 构造签名为 `(ctx, name)`** —— 只接受两个参数。

```bash
pnpm build      # tsc 编译到 lib/
pnpm test       # vitest
```

注意 `tsconfig.json` 显式设置了 `noEmit: false`——根配置为类型检查用途
设了 `noEmit: true`，不覆盖会导致构建静默产出空目录。

## 实现认证逻辑

在 `src/index.ts` 的 `authenticate()` 中按 `this.config.provider` 分派到
具体实现。建议每个 provider 独立成模块（`src/providers/oauth2.ts` 等），
便于分别测试。

## 许可证

MIT
