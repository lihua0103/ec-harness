# T11 全链路验收矩阵（NW01–NW24）— 2026-11-12（第三棒更新）

本文件**取代** `ACCEPTANCE-2026-11-12.md` 中的结果总表；旧文件仍保留为第一轮/第二轮历史证据。
结果只有 PASS / FAIL / NOT_RUN / BLOCKED；源码阅读、单元测试和截图不互相替代。

## 执行环境

| 项 | 值 |
|---|---|
| 仓库 | `D:\project\company\ec-clinical-dsh`，HEAD `53fd85e` + 本轮未提交改动 |
| DSH | `0.2.2-rc.1` @ `fcc0ad46`，上游 `git status` 0 项 |
| Node | 24.9.0 |
| 部署 | 控制面 `127.0.0.1:3096` + 原生 web `127.0.0.1:3095` |
| Profile | `.runtime/nw-web-home/profiles/web`（隔离） |
| 身份 | 本地 operator principal；**不是公司 SSO** |
| 模型 | 原生：GLM-5.3-Flash（单路由）；企业运行：合成目录 A/B（不发起真实模型调用） |
| 夹具 | `scripts/native-workbench-seed-t12.mjs` 合成项目/空间/工作/域/批次/运行/待答问题 |
| 浏览器 | Playwright + 本机 Edge，headless，1440×900 |

## 结果总表

| ID | 场景 | 结果 | 证据与说明 |
|---|---|---|---|
| NW01 | 两轮对话 | PASS | 第一轮证据 `nw01-nw07-browser.json`、`nw01-two-rounds.png` |
| NW02 | 实时长输出 | PASS | 第一轮证据 `nw02-nw06-browser.json`、`nw02-long-stream.png` |
| NW03 | 工具活动 | PASS | `nw03-tool-trace.png`；callId 未逐条断言 |
| NW04 | 输入同时输出 | PASS | `nw04-browser.json`、`nw04-input-while-streaming.png` |
| NW05 | 排队与 steering | **PASS（本轮）** | 普通 Enter 排队 + Ctrl+Enter steering 进入运行轮；两消息各一次；`nw05-browser.json`、`nw05-queue-t12.png`、`nw05-steer-t12.png`、`nw05-final-t12.png` |
| NW06 | 停止与继续 | PASS | `nw06-stop-continue.png` |
| NW07 | 刷新/断网 | PASS | `nw07-refresh.png`；断网重连未单独注入 |
| NW08 | Host 重启/写锁竞争 | **PASS（本轮）** | 重启：中断轮历史仅一条、后续轮成功；并发写：两标签页同时提交被串行化、每视图各一条；`nw08-browser-a.json`、`nw08-browser-b.json`、`nw08-lock.json` |
| NW09 | 输入故障切点 | **PASS（本轮）** | 控制面进程重启：RECORDED 保留、重试幂等、同 requestId 不同内容 409、UNKNOWN 保持且不自动重放；`nw09-submission-faults.json` |
| NW10 | 工作/域切换 | **PASS（本轮）** | 两个执行域、两个原生会话；切换后历史/草稿互不串；`nw10-browser.json`、`nw10-domain-switch.png` |
| NW11 | 双身份授权 | BLOCKED | 无真实身份接口；测试目录适配器不代表 SSO |
| NW12 | 活跃连接撤权 | BLOCKED | 未接真实撤权事件与 `remoteAccess.invalidate` 往返 |
| NW13 | 原生问答与审批 | BLOCKED | 上游 owner-only；集中模式无非 owner 参与接缝 |
| NW14 | 附件/文件隔离 | BLOCKED | 无两个独立 home/执行身份的集中域 |
| NW15 | 模型切换 | NOT_RUN | 企业运行模型快照冻结已验证（`nw15-model.json`）；**原生模型菜单只有一条已路由模型**，未做真实切换；不伪造第二条路由 |
| NW16 | 成果版本 | PASS | 第一轮测试；业务审核未实现 |
| NW17 | Listing 新批次 | **PASS（平台语义）** | 同 Work 两批基线（revision 2/1 均可查）+ 两次运行各自成果；`nw17-nw18-evidence.json`。**未运行真实 Listing 业务代码** |
| NW18 | DVP 修订 | NOT_RUN | 只登记 DVP 独立应用与来源批次，未执行真实 DVP 修订；不把平台边界当业务验收 |
| NW19 | 本地部署 | PASS | T08 本地启动 + 本轮真实浏览器全链路 |
| NW20 | 集中部署 | BLOCKED | 逐条见 `HOSTED-2026-11-12.md` |
| NW21 | 原生 UI 回归 | PASS | 第一轮证据 + 本轮所有浏览器脚本零页面错误（T05/NW05/NW08/NW10/NW23） |
| NW22 | 迁移 | NOT_RUN | 仅 dry-run：两次摘要一致、`--expect-digest` 守卫生效；正式写入需用户确认；`nw22-dryrun-1/2.json` |
| NW23 | 安装/卸载 | **PASS（本轮）** | 启用→禁用→启用：禁用后入口/页面/样式/品牌零残留；`nw23-disabled.json`、`nw23-enabled.json` |
| NW24 | 体验 | PASS | 第一轮证据；本轮新增表单/问答沿用同一 `.ec-wb` 作用域与键盘焦点 |

## 汇总

- PASS：16（NW01–NW10、NW16、NW17、NW19、NW21、NW23、NW24）
- NOT_RUN：3（NW15、NW18、NW22）
- BLOCKED：5（NW11–NW14、NW20）
- FAIL：0

## 口径与边界

- NW17 的 PASS 限定为**平台批次语义**；真实 Listing 插件执行、业务审核与领域验收不在本项。
- NW18 未执行真实修订，保持 NOT_RUN；DVP 独立应用/来源批次的存在不等于修订验收。
- NW15 只证明企业运行模型快照冻结；原生切换需要第二条真实路由模型，当前隔离 profile 只有一条。
- NW22 的 dry-run 不是迁移；删除/切换旧入口属破坏性操作，必须由用户明确确认后执行。
- 所有 PASS 均为**本地隔离环境 + 合成数据**；不是公司 SSO、集中部署或生产验收。
