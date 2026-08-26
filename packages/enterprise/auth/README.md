# 企业认证插件

该包是企业身份认证的扩展点模板，不包含任何默认认证逻辑。

实现要求：

- 只通过官方公开 Service/Event API 接入认证。
- 凭证进入 `credentials` 服务，不写入 Session、Prompt 或日志明文。
- 登录、刷新、注销和失败事件必须可审计。
- 不修改官方 `packages/identity` 或 `packages/credentials`。
