# @dsh-guard/enterprise-auth

企业级认证插件，支持多种认证方式。

## 功能

- ✅ OAuth2 认证
- ✅ LDAP 认证
- ✅ SAML 认证
- ✅ 会话管理

## 安装

```bash
pnpm install
```

## 配置

在 `configs/cordis.yml` 中配置：

```yaml
plugins:
  - name: '@dsh-guard/enterprise-auth'
    config:
      enabled: true
      provider: oauth2
      sessionTimeout: 3600000
```

## 开发

```bash
# 构建
pnpm build

# 测试
pnpm test

# 监听模式
pnpm test:watch
```

## 许可证

MIT
