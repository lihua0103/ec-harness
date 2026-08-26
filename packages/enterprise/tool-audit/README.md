# 工具审计插件

用于集中承载工具调用的企业鉴权、参数脱敏、结果审计和拒绝策略。

严禁在单个工具中复制审计逻辑；统一接入 `tools/pre-execute`、`tools/execute`、`tools/post-execute` 等官方扩展点。
