# 企业 Agent 安全审计

## 必查范围

- 凭证是否进入代码、Prompt、Session Log 或普通日志。
- 工具是否在 `tools/pre-execute` 前完成权限判断。
- 文件系统是否通过 `ctx.fs` 和官方策略服务访问。
- 进程是否通过 `ctx.subprocess`，并受 `ctx.sandbox`/approval 策略保护。
- 审计事件是否为结构化数据，是否能被查询和重放。
- 企业 UI 是否只暴露当前用户有权访问的数据。

## 禁止事项

- 裸调用 `child_process`。
- 在工具内自建第二套权限系统。
- 将 API Key 写入 `cordis.patch.yml`。
- 直接修改官方 Core 以插入企业鉴权。
- 通过全局变量在 Host 与 Client 之间传递权限状态。

## 交付材料

每个安全相关插件必须提供威胁模型、拒绝路径测试、审计事件字段说明和回滚方式。
