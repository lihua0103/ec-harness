# 企业身份与数据入口集成契约

状态：待 IT/API 对接；本契约定义平台需要什么、如何消费、如何拒绝，不是已实现能力。当前系统为单机单操作者本机文件模式，不能据此宣称企业身份或数据授权已接入。

## 1. 边界

- **IT/API 提供**：已认证身份断言、项目成员关系、项目数据位置与读取授权、撤权事件。
- **平台提供**：从可信传输上下文派生 Principal（调用者身份），按项目/运行校验资源归属，撤权后停止新输入并记录实际处置。
- **业务插件不提供**：不得从工具参数、文件名、资料类别推断用户授权，也不得自建第二套身份系统（见开发规范 §3.2、§8，ADR-0001）。

## 2. 身份断言

平台 API 边界（独立前端 → 平台控制服务）必须携带 IT 签发的身份断言，平台校验后派生：

```ts
interface IdentityAssertion {
  subject: string;          // 稳定人员标识
  orgId: string;
  issuedAt: string;         // ISO 8601
  expiresAt: string;
  assertionDigest: string;  // 断言原文摘要，用于审计关联
}
interface Principal {
  actorId: string;          // 由断言派生，不接受工具参数提供
  kind: 'operator' | 'service';
  orgId: string;
}
```

- 断言缺失、过期、签名不可信或 orgId 不匹配 → 拒绝请求，不降级为匿名。
- 工具参数中的 `actor`、`projectId`、`path`、`runId` 只是资源引用，不是授权证明；平台以 Principal + 项目成员关系重新判定。
- Worker 使用平台派生的 run 级 service Principal（与 operator 分离），其凭据随 Run 失效。

## 3. 项目与数据入口

```ts
interface DataAccessRequest { principal: Principal; projectId: string; }
interface DataAccessGrant {
  projectId: string;
  roots: Array<{ kind: 'filesystem' | 'api'; location: string }>;
  grantsDigest: string;     // 绑定当前授权快照
  expiresAt: string;
}
```

- 平台向 IT/API 查询成员关系与获准数据位置，把解析结果交给执行域；执行域只能访问 Grant 内位置。
- 撤销成员关系或授权时，平台停止该 Principal 的新 Run 与新输入，按运行合同停止在途执行；无法确认停止时保持未知，不假报取消。
- 信任的本地操作者目录仍可作为开发/单机模式的入口，但企业部署必须由 IT/API 解析位置，不以本机路径代替授权。

## 4. 平台侧接入点（当前代码事实）

- `packages/platform-identity`：已实现断言校验、Principal 派生（含 orgId）、Run 级 service Principal、项目成员与数据授权解析（非成员/跨组织/无授权/过期/撤销一律拒绝）。`InMemoryAccessDirectory` 是 IT/API 数据源的可测试替身，真实部署须提供由 SSO 与项目 API 支撑的目录实现。7 项包级测试覆盖 I01–I05 语义。
- `packages/platform-control/src/service.ts`：`setPolicy(policy)` 是部署接缝，企业身份/项目授权插件用它替换 `LocalOperatorPolicy`。
- `packages/platform-control/src/policy.ts`：`PlatformPolicy.authorize(principal, action, resource)` 是替换点；`LocalOperatorPolicy` 仅用于本机单操作者。
- `packages/platform-control/src/cordis.ts`：operator Principal 从 DSH 会话派生（`session:<id>`），不接受工具参数提供 actor——保留这一约束。
- 控制面自身的 Principal 仍为本机形态（无 orgId/断言摘要）；接入时由适配器把 platform-identity 的 Principal 映射进去，并在审计记录 actor/orgId/断言摘要。

## 5. 验收（I 系列，均未执行）

| 编号 | 场景 | 期望 |
|---|---|---|
| I01 | 无断言/断言过期请求 | 拒绝，不创建 Run |
| I02 | 非项目成员访问项目数据 | 拒绝并记录，不泄露位置 |
| I03 | 运行中撤销成员关系 | 停止新输入，按运行合同处置在途执行并留证 |
| I04 | 工具参数伪造 projectId/actor | 平台按 Principal 判定，不采信参数 |
| I05 | Worker service Principal 越界访问 | 拒绝；Run 级凭据随 Run 失效 |

## 6. 明确未做

真实 SSO/OIDC 接入、项目成员 API、数据位置 API、撤权事件通道、多租户隔离测试均未实现；`platform-identity` 提供的是解析规则与替身目录，不是这些服务的接入。I01–I05 目前只有包级语义测试，企业级验收（真实断言与撤权通道）未执行。在这些完成前，插件继续使用本机获准目录与操作者 R 配置，不得宣称满足企业数据安全验收。
