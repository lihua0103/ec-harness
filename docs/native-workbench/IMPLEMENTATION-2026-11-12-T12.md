# 本轮实现记录（第三棒，2026-11-12）

续接 `docs/native-workbench/STATUS.md`。本文只记录**已经实际执行并验证**的内容；未做项在
`ACCEPTANCE-2026-11-12-T12.md` 与 `STATUS.md` 中如实标注。

## 环境

- 仓库 HEAD `53fd85e`（main）+ 本轮未提交改动；上游 `0.2.2-rc.1` @ `fcc0ad46`，**源码零改动**。
- Node 24.9.0；DSH_HOME `.runtime/nw-web-home`（隔离 profile）；控制面 `.runtime/nw-web-home/platform/native-workbench.sqlite`。
- 浏览器：Playwright + 本机 Edge，headless 1440×900；原生 web `127.0.0.1:3095`，控制面 `127.0.0.1:3096`。
- 合成数据：`scripts/native-workbench-seed-t12.mjs`（项目/空间/两个应用/三个工作/两个执行域/两批基线/两次运行/一个待答问题）。
- 未提交、未推送、未改生产 profile。

## T10 工作台整页替代旧入口（DONE，破坏性切换除外）

`packages/platform-workbench`：

- `src/client/WorkbenchPage.tsx`：
  - **新建工作**：项目/空间/应用/标题/目标；无空间时可登记空间；创建后直接进入工作详情。
  - **草稿**：按员工+工作读取/保存，`expectedRevision` 冲突保留本地文本；草稿可一键带入运行目标。
  - **发起运行**：显式模型选择 + 目标文本；运行创建后刷新历史；失败保留控制面 code。
  - **问答回复**：按运行列出 PENDING 问题，单选/多选/自定义回答；提交后重新读取，已回答/终态拒绝。
  - **模型选择**：默认模型保存（只影响本人后续新运行）；运行使用目录内可用模型。
  - **待处理**：改用控制面 `pending`（真实 PENDING 问题）而不是不存在的 `WAITING_FOR_USER` 运行状态。
- `src/api.ts`：新增 models/preference、workspace、work、draft、run、interactions、answer 调用。
- `src/forms.ts`：模型选择、原生 `user/message` → Submission 提取、回答构建的纯函数。
- `src/index.ts`（Host 半）：
  - 代理从 `resource` 改为 **`handler` 前缀路由**（上游 `resource` 只收 GET/HEAD，实测 405）；
  - 允许 `GET/HEAD/POST/PUT`；请求体 1 MiB 上限；拒绝跨站 Origin / `sec-fetch-site: cross-site` / `..` 路径；
  - 只转发白名单请求头与响应头。
- `src/client/styles.ts`：表单/问答样式，仍全部作用域在 `.ec-wb`。
- 测试：42/42（新增 forms 6、submission-observer 5、host 写路由 4、api 写调用 3）。

浏览器实测（19/19 PASS）：`evidence/t10-ui-smoke.json`、`t10-workbench-home.png`、`t10-work-detail.png`、
`t10-run-created.png`、`t10-two-batches.png`、`t10-answer-submitted.png`。

## T05 原生 composer 提交关联（PARTIAL → 接口闭合）

- Client 半新增 `src/client/submission-observer.ts`：
  - `ctx.sessions.retain(sessionId, {source:'platformWorkbench'})` + `binding.eventSource`；
  - 只认 `user/message` 且 `source.kind==='user'` 的 `rpcId`；`agent.inject`/临时 chunk/无 rpcId 一律忽略；
  - 已有记录按 `requestId` 幂等恢复（RECORDED→ACCEPTED→CONSUMED）；UNKNOWN **不自动重放**；
  - 失败上报控制面 code，不伪造成功；会话 catalog 未就绪时 `refresh()` + 20×250ms 重试。
- 浏览器实测（13/13 PASS）：绑定后的原生 composer 提交 → `CONSUMED` Submission，admission 为
  `session-event:<seq>:user/message`，提交者为 `session:local-workbench`，会话 id 一致；
  **绑定前的历史消息不回填为企业提交**（`since = binding.createdAt`）。
  证据 `evidence/t05-submission-correlation.json`、`t05-native-submission.png`。
- **未采用 DOM 拦截**：没有监听 composer 事件，也没有改写表单；关联来自持久事件窗。

## T11 未跑项（本轮实测）

| 项 | 结果 | 证据 |
|---|---|---|
| NW05 队列/steering | **PASS**：普通 Enter 排队、Ctrl+Enter steering 进入运行轮；两消息各出现一次 | `evidence/nw05-browser.json`、`nw05-queue-t12.png`、`nw05-steer-t12.png`、`nw05-final-t12.png` |
| NW08 Host 重启 | **PASS**：运行中断后重启，历史仅一条、无残留运行、后续轮成功 | `evidence/nw08-browser-a.json`、`nw08-browser-b.json`、`nw08-restart-continued.png` |
| NW08 写锁竞争 | **PASS（并发写）**：两个标签页同时提交，Host 串行化；每个视图各消息仅一条 | `evidence/nw08-lock.json`、`nw08-lock-tab1/2.png` |
| NW09 输入故障切点 | **PASS**：RECORDED 跨重启保留；重试幂等；同 requestId 不同内容 409；UNKNOWN 跨重启保持且不被自动重放 | `evidence/nw09-submission-faults.json` |
| NW10 工作/域切换 | **PASS**：两个域、两个原生会话；切换后历史与草稿互不串 | `evidence/nw10-browser.json`、`nw10-domain-switch.png` |
| NW15 模型切换 | **PARTIAL**：企业运行模型快照冻结（改默认不改变已创建运行）；**原生模型菜单只有一条已路由模型，未切换** | `evidence/nw15-model.json` |
| NW17 Listing 新批次 | **PASS（平台语义）**：同 Work 两批基线（revision 2/1 均可查）、两次运行各自成果保留；未运行真实 Listing 业务代码 | `evidence/nw17-nw18-evidence.json` |
| NW18 DVP 修订 | **NOT_RUN**：只登记了 DVP 独立应用与来源批次，未执行真实 DVP 修订；不把平台边界当成 DVP 业务验收 | 同上 |
| NW22 迁移 | **NOT_RUN（破坏性切换未执行）**：两次 dry-run 摘要一致；`--expect-digest` 一致 0、不一致 4、`--apply` 2 | `evidence/nw22-dryrun-1.json`、`nw22-dryrun-2.json` |
| NW23 安装/卸载 | **PASS**：启用→禁用→启用；禁用后无 工作台入口、无 `.ec-wb`、无注入样式、无 EMERALD 品牌 | `evidence/nw23-disabled.json`、`nw23-enabled.json` |

## T02 卸载/禁用往返（DONE）

- profile `cordis.patch.yml` 移除插件 insert 行 → 重启：入口/页面/样式/品牌全部无残留，零页面错误。
- 恢复 insert 行 → 重启：入口、品牌、整页与作用域样式恢复。证据同 NW23。

## T08 集中部署（BLOCKED，逐条见 `HOSTED-2026-11-12.md`）

- 已实现并实测：hosted 描述符校验、凭据/query URL 拒绝、单控制进程约束、Origin 白名单、浏览器同源写代理。
- 缺失：认证入口、域代理（HTTP/WS/文件/问答）、两个真实隔离域、撤权往返 → BLOCKED。

## 契约修订

- `CONTRACT-MATRIX.md` §3.1：**`resource` 路由只允许 GET/HEAD，写入口必须使用 `handler` 路由**（本轮实测 405）。
- §3.2：Session id 形如 `session-<uuid>`；新会话在 Client catalog 可见前需 refresh+重试；T05 关联在浏览器半完成。

## 复现命令

```bash
# 控制面（种子库）
cd packages/platform-control
node --import tsx/esm src/api-cli.ts --port 3096 --store ../../.runtime/nw-web-home/platform/native-workbench.sqlite

# 原生 web（隔离 profile）
cd upstream/deepseek-harness-git
DSH_HOME=../../.runtime/nw-web-home PLATFORM_WORKBENCH_CONTROL_URL=http://127.0.0.1:3096 \
  node --import tsx/esm ../../scripts/dsh-web-launcher.cjs web --host 127.0.0.1 --port 3095
```

浏览器脚本在 `.runtime/nw-t12-*.cjs`（不入库）；每个脚本把 JSON 与截图写入 `docs/native-workbench/evidence/`。

## 未做（不写成完成）

- 旧 `apps/enterprise-workbench` 的删除/正式入口切换：需用户明确确认；本轮只完成替代能力与 dry-run。
- 正式迁移写入、旧 Work→原生 Session 自动关联、回退演练。
- 真实 Listing/DVP 业务执行、业务审核绑定。
- 真实 SSO/撤权、集中域、非 owner 问答审批（BLOCKED）。
- 原生模型切换（单路由模型）。
