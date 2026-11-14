# DSH 插件社区调研：自研 UI 工作台与原生级会话流式

日期：2026-11-13。类型：社区检索 + 锁定源码契约核实，供工作台路线决策参考。
锁定基线：DeepSeek Harness `0.2.2-rc.1` @ `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`（`upstream/deepseek-harness-git`）。
证据等级沿用 [CONTRACT-MATRIX](CONTRACT-MATRIX.md)：**S**=锁定源码已核实 · **A**=装配已核实 · **B**=实际行为已验证 · **C**=社区自述（README/发布说明，本仓未复跑）。

## 1. 检索渠道（全部为真实公开地址）

| 渠道 | 地址 | 结果 |
|---|---|---|
| 官方社区入口（上游 README） | https://github.com/deepseek-ai/deepseek-harness#community-and-support | GitHub Discussions、Discord、官方发现主题 `dsh-plugin` |
| GitHub 主题 | https://github.com/topics/dsh-plugin | 官方推荐的插件发现标签；API 检索 `topic:dsh-plugin` 命中数万仓库（含大量无关高星仓库，需人工筛选） |
| npm 关键词 | https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin | 约 1.4 万条模糊命中；头部为真实 DSH 插件 |
| 官方插件市场机制 | npm `@deepseek-ai/dsh-plugin-market`；上游 `packages/client/ui-plugin-market`、`packages/experimental/plugin-market-bundle` | Web「Discover」页 + `plugin_market` agent 工具，消费可配置索引源 |
| 社区精选列表/索引 | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin ；npm `dsh-plugin-catalog`（约 10581 条，索引 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`） | 列表本身即 format-1 市场索引，可加入 Discover |
| 社区可视化市场 | https://github.com/dsh-market/dsh-market （npm `dshmarket`） | 插件内浏览/搜索/一键安装 |

结论：DSH 已有成规模的插件社区与官方市场分发机制；但**没有发现可直接复用的"企业临床工作台"成品**。最接近的企业形态与自研流式形态见 §2。

## 2. 与"自研工作台 + 原生级流式"相关的社区方案

| 形态 | 代表（真实仓库） | 做法 | 对本项目的意义 | 证据 |
|---|---|---|---|---|
| 完全自研 UI，只消费公开契约 | [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)（npm `@deepseek-harness-tui/dsh-tui`） | 终端 UI：流式 Markdown/thinking、工具卡、审批/问答、队列、TPS/上下文条；自述"Zero core changes: consumes only DSH's public exports"，正从挂载插件转向自有入口 + DSH 进程内作后端；官方负责人推荐 | **自研界面达到原生级流式的存在性证明**；其"自有 composition root + 公开包"路线可借鉴 | C |
| 自研客户端 + 插件自有 API 转发原生会话流 | [WNLUO/dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin)（AI-HUB 手机端） | Host 插件开 `/api/mobile/v1/*` + relay/局域网配对；手机侧逐块流式、实时工具调用、审批/问答、排队插话、fork、换模型；支持无头宿主 | 集中部署/多端形态的参考：插件自有 API 只转发原生会话能力，不另造会话协议 | C |
| 原生 WebUI 整体视觉/交互改造 | [Nwflower/dsh-claude-style](https://github.com/Nwflower/dsh-claude-style)（npm `dsh-claude-style`） | 主题插件复刻 Claude Code Desktop 风格与交互；要求 dsh ≥ 0.2.2-rc.1（与本仓锁定一致） | 证明"保留原生会话、整体换壳"在社区可行且与锁定版兼容 | C |
| 插件自有 HTTP/WS 工作台 | [zhoulvyuan/dsh-plugin#dsh-claude-code-web](https://github.com/zhoulvyuan/dsh-plugin/tree/master/dsh-claude-code-web) | `webServer.register` + `registerUpgrade` 挂自有 HTTP/WebSocket，悬浮/可弹出工作台，流式 transcript/工具卡/thinking | **注意：它驱动的是 Claude Code CLI，不是 DSH 会话**。只能作"插件自有服务 + 自研 UI"的架构参考，不能当作 DSH 原生流式先例 | C |
| 企业协作前台 | [01men/DeptAI-UI-DSH](https://github.com/01men/DeptAI-UI-DSH) | 部门看板/工单/审批在 DSH 会话与面板内运行，治理（IAM/OIDC/RBAC）走既有合同不重造 | 企业工作台 IA 参考；**要求 DSH ≥0.1.0-rc.7 <0.2.0，与锁定版不兼容**，不可直接采用 | C |
| 任务工作台 | [suifei/dsh-ai-team](https://github.com/suifei/dsh-ai-team) | 自有任务/验收/台账，独立 profile（其 patch 放开沙箱与审批） | 任务 ownership 模型参考；其安全姿态与企业边界相反，不可照搬 | C |
| 办公/交互视图增强 | [dream-num/dsh-univer-office](https://github.com/dream-num/dsh-univer-office)；[lhuans/dsh-genui](https://github.com/lhuans/dsh-genui)；[Fei2411/deep-view](https://github.com/Fei2411/deep-view) | Univer 表格 Gateway+Viewer 内联预览/浮动窗口；聊天内交互图表/表单/视图 | 与 `platform-workbook`、成果预览直接相关的集成先例 | C |
| 桌面外壳 | [dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop)、[anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) | 第三方桌面客户端，内置市场 | 分发形态参考；不改变会话契约 | C |

## 3. 流式能力契约核实（锁定源码，S 级）

**原生 WebUI 的逐 token 流式不是私有魔法，而是公开 follow 契约 + 公开 Client 折叠器：**

1. `SessionFollowRequest.assistantStream?: true` 是公开请求字段——"Include process-local assistant presentation frames for the Web client"
   （`packages/api/session-controller/src/types.ts:492-498`）。Host 侧 `web/controller.ts:38` 按该字段挂 assistant 监听并在 opening 携带 `SessionAssistantStreamBaseline`（`startedAfterSeq`/`nextIndex`/compact stream/revision）。
2. 公开 Client 适配器 `SessionEventStream`（`client/transport.ts:137-207`）在 follow 时**默认即带 `assistantStream: true`**（:182），并校验 opening 必含 baseline；`ClientAssistantStream`（`client/sessions/assistant-stream.ts`）把 transient `assistant/live-chunk` 按 dense index/revision 折叠到 durable `assistant/message`/`assistant/attempt` 结算，处理重连 rebaseline、失败/中断退役、gap 修复。
3. 因此任何消费公开 Client 会话适配器的自研 UI，拿到的就是原生 WebUI 同一条流式通道；队列/steer/cancel/问答/附件/fork 的公开入口见 CONTRACT-MATRIX §2。
4. **SDK（Worker 批处理）只有 durable 事件粒度**：run 收集通知至 idle，`finalResponse` 取最后 `assistant/message`（`packages/sdk/client/README.md:145`），无 live-chunk。交互级流式必须走 Client/follow 路径，不能从 SDK Worker 事件里"补"出逐 token。

诚实标注：以上 1–4 为 S 级源码核实；"第三方据此端到端达到原生同等体验"目前只有社区自述（C 级，dsh-TUI/AI-HUB），本仓未复跑。若走完全自研路线，须按 T02 式最小实验取得 B 级证据。

## 4. 路线对照与建议

| | A：原生 conversation + 企业整页外壳（现行 ADR-0003） | B：完全自研聊天 UI |
|---|---|---|
| 流式/队列/取消/问答/附件 | 原生实现，零重建；已 17/17 浏览器实证（`evidence/t12-a-shell-browser.json`） | 公开契约支持（§3），但 composer、工具卡、审批渲染、结算语义、重连修复全部自建 |
| 与原生一致性 | 天然一致 | 需逐项对齐并持续跟随上游 Developer Preview 破坏性变更 |
| 验收成本 | 已覆盖 NW 大部分 | NW01–NW24 中交互项需重跑，另加流式保真专项 |
| 社区先例 | dsh-claude-style（换壳不换会话） | dsh-TUI、AI-HUB（C 级） |
| 企业阻塞（两条路线相同） | 非 owner 问答/审批 owner-only（remote-access README:87）、集中部署路由、真实 SSO 未接 | 同左，且自建 UI 不解决这些 Host 侧接缝 |

**建议**：产品面维持 A 方案——自研的是企业导航/工作上下文/成果/审计（平台职责），会话正文与流式一律原生；这与社区"换壳不换会话"的主流做法一致，也符合规范"不发明第二套会话流协议"。若业务后续坚持完全自研聊天界面，按 B 的公开契约（`assistantStream` + `SessionEventStream`/`ClientAssistantStream`）先做最小实验取得 B 级证据，再评估重建成本；不以 dsh-claude-code-web 这类"自有服务驱动外部 CLI"的形态冒充 DSH 原生流式。

## 5. 可复现检索命令

```bash
curl -s "https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=50"
curl -s "https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=30"
```

官方 Discover 索引源（社区目录）：`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`。