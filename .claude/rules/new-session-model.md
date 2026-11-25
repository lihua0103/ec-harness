# 新会话默认模型

为本项目新建独立 Claude Desktop Code 会话（`start_session`）时，如果用户没有为该会话明确指定模型，默认传：

- `model: "claude-fable-ccs-587319"`（可设置 ID 不带 `[1m]` 后缀；`[1m]` 只是选择器显示的 1M 上下文变体，传入会被拒绝或忽略）。
- 对应模型选择器条目：**无锡模型 / deepseek-v4.1-flash-high**（用户所称「DeepSeek 4.1-hight」即此 high 档）。
- 2026-11-20 已对桌面网关模型目录核验，并实建会话验证。

该 ID 是 CC Switch 栈路由哈希，供应商路由被编辑后会变化。若创建时被拒绝或目录中查无此 ID：向本会话 `ANTHROPIC_BASE_URL` 拼接 `/v1/models` 拉取目录（Bearer 用 CC Switch 桌面网关 token，存于 `~/.cc-switch/cc-switch.db` 的 `settings` 表 `claude_desktop_gateway_token` 键），按 `display_name` 「无锡模型 / deepseek-v4.1-flash-high」匹配新 ID 并更新本文件。不得猜测 ID，不得静默改用其他模型启动；目标不可用时说明限制，请用户在选择器中确认。

边界：用户本次明确选择的模型优先；不修改当前会话、恢复中的会话或子代理的模型。2026-11-20 已在用户级 `~/.claude/settings.json` 写入 `"model": "claude-fable-ccs-587319"` 作为桌面/CLI 的默认键；但桌面选择器的「每用户记忆」可能优先于它，且 CC Switch 切换供应商时可能重写该文件，手动新建是否生效需实测一次确认。
