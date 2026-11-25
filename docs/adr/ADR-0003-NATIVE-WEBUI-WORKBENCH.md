# ADR-0003：原生 WebUI 作为企业工作台交互底座（替代"原生界面仅专家辅助入口"）

日期：2026-11-12。状态：**已决策（T01）**；实施状态 T00 完成、T01–T11 未全部完成，见 `docs/native-workbench/STATUS.md`。
决策人：平台开发。依据：[原生 WebUI 与企业工作台实施任务书](../NATIVE-WEBUI-ENTERPRISE-WORKBENCH-IMPLEMENTATION.md)、[上游能力矩阵](../native-workbench/CONTRACT-MATRIX.md)。

## 背景

此前路线把 DSH 原生 WebUI（`ui-conversation`/`ui-chat`/`ui-session` 组成的完整浏览器壳）定位为"专家辅助入口"，
企业工作台另建自制聊天内核（`apps/enterprise-workbench` 当前实现：轮询 + 整体 HTML 重绘，活动由 SDK 事件简化）。
这让同一产品出现两套会话实现，且自研内核无法达到原生流式、工具活动、队列、停止、问答、恢复的真实可观察性。

## 决策

**采用原生 WebUI 作为正式交互底座。** 同一 EMERALD WebUI 内：
- 企业导航（项目/应用/我的工作/待处理）与企业贡献（工作上下文/输入基线/成果版本/检查范围）通过原生 slots 与平台能力进入；
- 会话正文、实时流、composer、队列、steering、取消、问答、附件、历史、文件面板**一律使用原生实现**；
- 企业控制面只拥有工作关系、发布、执行记录、成果封存与审计，不执行领域解析或 Agent 循环；
- 同一个 Session 只有一个写入所有者；交互用原生 Host/Client，批处理继续用 SDK Worker，二者不同时拥有同一 Session。

## 实施形态（2026-11-12 用户确认）

- 企业外壳使用上游声明的 `sidebar` 与 keyed `main` 两个位置。`platform-workbench` 分别提供唯一员工导航和 `emerald-platform` 工作页。企业导航保留工作、会话、项目、应用和待办入口。
- **员工左栏装配修订（2026-11-21，待宿主验收）**：`platform-workbench` 仍由 Cordis 作为 DSH 插件加载。插件以 `priority: -1` 注册 `sidebar`，由 DSH 渲染企业导航。`main:emerald-platform` 承载页面内容、原生会话与工作上下文。员工 Web profile 可叠加配置停用默认 `ui-sidebar`。[单侧栏设计与验收](../WORKBENCH-SINGLE-SIDEBAR-ARCHITECTURE.md)
- **2026-11-13 单页修订（现行）**：打开 Work 仍留在 `emerald-platform`，由插件持有明确的 Session 引用，交给 `SessionProvider`，在页内嵌入原生 `conversation.content`。详情与运行记录不替代中央原生会话。原 `ctx.layout.selectPanel(null)` 两页切换和会话头部的「返回工作台」仅属 11-12 历史实现，不再作为实施依据。见[单页装配证据](../native-workbench/evidence/NATIVE-ASSEMBLY.md)。
- 上游拥有 `sidebar` 的声明与框架几何及保留的 `conversation` 键。企业 Client 在员工 profile 中提供 `sidebar` 的唯一内容，并通过 `conversation.content` 复用原生会话。`apps/enterprise-workbench` 仅作视觉与信息架构基线。
- 证据：`docs/native-workbench/evidence/NATIVE-ASSEMBLY.md`、`t12-a-shell-browser.json`（17/17）。

## 被否决方案

- **继续扩建自制聊天内核**：重复实现流式/队列/取消/恢复，无法证明与原生一致，且违反"不发明第二套会话流协议"。
- **iframe 拼接**：两套状态机、两套鉴权、输入/焦点/主题割裂，仍不是同一产品。
- **原生化后由控制面代理会话事件**：把原生 follow 代理成 activities 会丢失实时性与结算语义；控制面只做投影。
- **假进度/打字动画**：任务书明确禁止；真实可观察性优先。

## 后果与保留条款

- **保留**：企业身份/安全/业务边界不因路线调整被取消；领域插件仍按合同提供能力，不恢复按名称/类别拒读或普通读取审批。
- **数据策略**：旧 `apps/enterprise-workbench` 的 Work/Run 记录不删除；T10 迁移时可行则建原生 Session 关联，缺失时只读展示旧 Run 与成果，用户明确继续后才建带来源的新 Session。内存 activities 丢失部分不编造。
- **交互结算**：沿用当前批处理 `RunSnapshot` 完成屏障；新增交互执行种类时才演进结算，不给批处理默认 `cleanedUp=true`。
- **集中模式**：首个参考实现用两个独立 ExecutionDomain（独立 home/附件/进程身份/凭据），而非共享全权 Host；非 owner 问答/审批当前 owner-only（见 CONTRACT-MATRIX §2），未闭合不得通过 NW13/NW20。
- **上游修改**：若需改上游，制品标识为锁定基线 0.2.2-rc.1 + 补丁摘要，不声称未修改上游通过。

## 受影响旧条款（修订指针）

- `docs/ENTERPRISE-WORKBENCH-DSH-REMEDIATION-ADDENDUM.md`、`docs/CLINICAL-WORKBENCH-SOLUTION.md` 中"原生界面仅专家辅助入口"的定位不再作为实施依据；以本 ADR 与任务书为准。
- `docs/PLATFORM-RUN-LIFECYCLE-CONTRACT.md`、`docs/PLATFORM-APPLICATION-RELEASE-CONTRACT.md`：交互运行不改变批处理完成屏障；如引入交互执行种类须显式修订合同版本，不能无声绕过。
- `docs/ENTERPRISE-IDENTITY-AND-DATA-CONTRACT.md`：身份权威仍为既有系统，经 adapter 接入；测试身份通过不等于 SSO 已接入。

## 未解决（不因本 ADR 成为已实现）

- 公开 slot 能否完整截获原生提交并关联企业执行记录（T02 最小实验）。
- 非 owner 问答/审批参与接缝（当前 BLOCKED 风险）。
- 跨部署原生连接路由、真实公司认证协议。
