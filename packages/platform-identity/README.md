# @ec-clinical/platform-identity

企业身份断言校验与项目数据访问解析。实现 [企业身份与数据入口契约](../../docs/ENTERPRISE-IDENTITY-AND-DATA-CONTRACT.md) §2–§3 的解析规则，供企业部署接入控制面。

## 能力

- `validateAssertion` / `derivePrincipal`：拒绝畸形、未生效、过期断言；Principal 只从已认证断言派生，忽略调用方附带的 `actor`/`actorId` 字段。
- `deriveServicePrincipal`：Run 级 service Principal，与 operator 分离，不继承项目访问权。
- `InMemoryAccessDirectory`：项目成员关系与数据位置授权的解析规则实现——非成员、跨组织、无授权、成员/授权过期一律拒绝；撤销即时生效；返回的 Grant 为副本，调用方不能篡改。

## 边界

本包**不实现**控制面的 policy 接口。部署方写一个薄适配器调用这些函数，再传给 `platformControl.setPolicy(...)`；包之间保持解耦，替换身份来源不影响运行状态。

`InMemoryAccessDirectory` 是 IT/API 数据源的**可测试替身实现**，不代表 SSO/OIDC、项目成员 API 或数据位置 API 已接入。真实部署必须提供由这些服务支撑的目录实现。契约 I01–I05 的企业级验收（真实断言、真实撤权通道、多租户隔离）仍未执行。

## 验证

```bash
cd packages/platform-identity && pnpm install
```

```bash
cd packages/platform-identity && PATH="/d/package/Nvm/nvm/v24.9.0:$PATH" npm run verify
```

测试覆盖 I01（断言拒绝）、I02（非成员/跨组织/无授权拒绝）、I03（撤销生效）、I04（不采信调用方 actor）、I05（service Principal 无项目访问）的包级语义，以及过期与副本不可变性。
