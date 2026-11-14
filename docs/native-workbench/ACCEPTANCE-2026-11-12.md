# T11 全链路验收矩阵（NW01–NW24）— 2026-11-12

状态：**PARTIAL**。本文件只记录实际执行的事实；源码阅读、单元测试和截图不互相替代。
结果只有 PASS / FAIL / NOT_RUN / BLOCKED。

## 执行环境（所有用例共用，除非单独注明）

| 项 | 值 |
|---|---|
| 仓库 | `D:\project\company\ec-clinical-dsh`，HEAD `53fd85e` + 本轮未提交改动（T07/T09/T10/T11） |
| DSH | `0.2.2-rc.1` @ `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，上游 `git status` 0 项 |
| Node | 24.9.0（合规） |
| 部署模式 | 本地：控制面 `127.0.0.1:3096` + 原生 web `127.0.0.1:3095` |
| Profile | `.runtime/nw-web-home/profiles/web`（隔离开发 profile） |
| 身份 | 本地测试 operator principal（`session:...`）；**不是公司 SSO** |
| 模型 | GLM-5.3-Flash，经已配置的 ZAI 路由；密钥只从环境读取 |
| 夹具 | 合成应用/项目/工作/运行/成果/输入批次（`scripts/native-workbench-seed-reports.mjs`）；合成浏览器本地记录（`.runtime/nw-migration-sample.json`） |
| 浏览器 | Playwright + 本机 Edge，headless；1440×900，窄屏 390×844 |

## 结果总表

| ID | 场景 | 结果 | 证据与说明 |
|---|---|---|---|
| NW01 | 两轮对话 | PASS | 同一原生 Session 第二轮正确回忆代号 `ZETA-7412`；`evidence/nw01-nw07-browser.json`、`nw01-two-rounds.png` |
| NW02 | 实时长输出 | PASS | 20 行长输出：118 次采样、29 次增长、39 个增长步，均在最终结算前；`evidence/nw02-nw06-browser.json`、`nw02-long-stream.png` |
| NW03 | 工具活动 | PASS | 工具提示词执行后“轨迹”视图含工具条目；`nw03-tool-trace.png`。callId 配对未逐条断言 |
| NW04 | 输入同时输出 | PASS | 输入草稿时内容仍在实时变化、运行未结束；草稿与焦点保留；同一轮随后完成（28 秒、含第 15 行）；`evidence/nw04-browser.json`、`nw04-postrun-browser.json`、`nw04-input-while-streaming.png` |
| NW05 | 排队与 steering | NOT_RUN | 排队子集已观察（队列提示 + 当前轮结束后排队轮执行，`nw05-queue.png`）；**steering 与原生接纳/消费关联未验证**，整案不标 PASS |
| NW06 | 停止与继续 | PASS | 停止结算保留 19 字部分内容，同一会话后续轮成功；`nw06-stop-continue.png` |
| NW07 | 刷新/断网 | PASS | 刷新后重开同一会话，用户气泡计数仍为 1，无重复消息；`nw07-refresh.png` |
| NW08 | Host 重启/写锁竞争 | NOT_RUN | 未在共享环境制造 Host 重启或并发写；不伪造结论 |
| NW09 | 输入故障切点 | NOT_RUN | 控制面 `submissions` 状态机与重启测试覆盖 RECORDED/ACCEPTED/UNKNOWN；原生提交前置截获尚未接入 |
| NW10 | 工作/域切换 | NOT_RUN | 两个 ExecutionDomain 的连接切换与草稿隔离未实现/未测 |
| NW11 | 双身份授权 | BLOCKED | 无真实身份接口；只有测试目录适配器，不能代表 SSO 验收 |
| NW12 | 活跃连接撤权 | BLOCKED | 未接入真实撤权事件与 `remoteAccess.invalidate` 往返 |
| NW13 | 原生问答与审批 | BLOCKED | 上游 `remote-access/README.md` 明确非 owner 参与为 owner-only；集中模式无公开接缝 |
| NW14 | 附件/文件隔离 | BLOCKED | 无两个独立 home/执行身份的集中域；不能以 sessionId 参数证明隔离 |
| NW15 | 模型切换 | NOT_RUN | 原生会话内模型切换未执行；控制面冻结快照与不串用户有单元测试，但不等于本用例 |
| NW16 | 成果版本 | PASS | 封存复制复算 SHA-256、篡改拒绝、投影不暴露封存路径（platform-control 测试）；UI 仅对 `sealedAt` 显示已封存并允许下载。**业务审核未实现** |
| NW17 | Listing 新批次 | NOT_RUN | 无 Listing 业务切片；输入批次追加不覆盖旧版已有平台测试 |
| NW18 | DVP 修订 | NOT_RUN | 无 DVP 业务切片 |
| NW19 | 本地部署 | PASS | T08 本地真实启动 health/bootstrap + 种子 API 10 项；本轮 T07/T09 本地真实浏览器 |
| NW20 | 集中部署 | BLOCKED | 两个隔离域、认证入口与 HTTP/WS/文件/问答路由未实现 |
| NW21 | 原生 UI 回归 | PASS | 原生侧栏/会话/composer/模型菜单存在；除注入 503 外无控制台错误；`t07-t09-browser.json`、`nw01-nw07-browser.json` |
| NW22 | 迁移 | NOT_RUN | 仅完成只读 dry-run（`MIGRATION-2026-11-12.md`、`MIGRATION-DRYRUN-2026-11-12.json`）；未执行写入 |
| NW23 | 安装/卸载 | NOT_RUN | 构建产物为原生 ModuleLoader factory，真实 profile 加载 PASS；卸载/禁用往返清理未测 |
| NW24 | 体验 | PASS | 键盘焦点、390px 窄屏无横向溢出、暗色 `color-scheme: dark`、紧凑布局、空状态与分页；`t09-*.png`。长历史阅读为原生能力，未单独计时；reduced-motion 仅样式契约测试，未做动画观测 |

## 汇总

- PASS：NW01、NW02、NW03、NW04、NW06、NW07、NW16、NW19、NW21、NW24（10 项）。
- NOT_RUN：NW05、NW08、NW09、NW10、NW15、NW17、NW18、NW22、NW23（9 项）。
- BLOCKED：NW11、NW12、NW13、NW14、NW20（5 项）。
- 未出现 FAIL。

## 性能记录（只记录实测，不宣称提速）

- 环境：headless Edge，1440×900，Node 24.9.0；长输出 20 行，采样间隔 300ms。
- 观测：118 次采样中 29 次长度增长；首次内容在结算前到达；无模拟回放证据。
- 本文件不提供毫秒级吞吐对比，也未宣称性能提升。

## 证据口径

- 第一轮自动化脚本（`nw01-nw07-browser.json`）在长输出测量与会话重开上有等待/选择器问题，
  其中 FAIL 记录原样保留，不删除；最终判定以各用例列出的定向证据为准。
- NW02/NW05/NW06/NW07/NW21 的最终结果见 `nw02-nw06-browser.json`、`nw04-nw06-browser.json`、
  `nw04-postrun-browser.json`；NW04 的 live 更新与草稿/焦点见 `nw04-browser.json`。
- 截图是当轮真实页面；合成数据不包含业务资料。

## 明确未覆盖

- 真实公司认证/撤权、集中域隔离、非 owner 问答/审批（BLOCKED）。
- Listing/DVP 业务切片、业务审核绑定、真实模型 smoke 的业务正确性。
- Host 重启、写锁竞争、卸载往返、跨域切换。
