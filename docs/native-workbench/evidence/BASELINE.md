# T00 接手基线证据（NATIVE-WEBUI-ENTERPRISE-WORKBENCH-IMPLEMENTATION）

建立时间：2026-11-12（接续 `docs/NATIVE-WEBUI-ENTERPRISE-WORKBENCH-IMPLEMENTATION.md` 第 0 节）。
本文只记录基线事实，不覆盖任何未提交工作，不切换分支、不提交、不清理、不 stash。

## 1. 仓库 HEAD 与工作区状态

- 仓库根：`D:\project\company\ec-clinical-dsh`
- 当前分支：`main`
- 仓库 HEAD commit：`53fd85efd79c81784a0dff7ef86f4ae5e4b97c37`
  - 提交信息：`feat(identity): add enterprise identity and project data-access resolution`
- **未提交**（相对 HEAD）：61 个文件变更。组成：
  - 修改（M）：31 个文件（docs 4、packages 27、plugins 4、prototypes 8、scripts 9）
  - 新增未跟踪（??）：30 个目录/文件（apps/、docs/* 多份、packages/platform-control 6 个新源码、prototypes 2、scripts 10）

### 1.1 关键修改文件（按任务书权威源）

| 文件 | 状态 | 与本文关系 |
|---|---|---|
| `docs/NATIVE-WEBUI-ENTERPRISE-WORKBENCH-IMPLEMENTATION.md` | 新增 | 本文任务书本身（任务源） |
| `docs/PLATFORM-CONTROL-IMPLEMENTATION.md` | 修改 | 控制面现状，T03/T04/T05 设计依据 |
| `docs/REMEDIATION-2026-11-11.md`、`docs/ENTERPRISE-REMEDIATION-PLAN-2026-11-11.md` | 修改/新增 | 整改基线，不重述相反条款 |
| `packages/platform-control/src/{store,service,works,projects,policy,runs,worker,cordis,config}.ts` | 修改 | T03/T04/T05 直接改造对象 |
| `packages/platform-control/src/{http,models,api-cli,deployment}.ts` | 新增 | T05/T06 HTTP 与模型/部署入口 |
| `packages/platform-control/tests/*.test.ts`（http/projects/work/models*） | 新增 | T03/T04/T05 测试 |
| `apps/enterprise-workbench/**` | 新增 | 当前正式前端切片（T06 复用的页面/状态层） |
| `packages/platform-identity/src/index.ts` | 已跟踪 | T04 复用：derivePrincipal / InMemoryAccessDirectory |
| `scripts/{workbench-deployment,workbench-live-e2e,start-dsh-web,dsh-web-launcher,...}.cjs` | 修改/新增 | T08 部署装配依据 |

### 1.2 真实修改体量（避免误判"无改动"）

- `git diff --stat`（已跟踪）：31 文件，+3579 / -311 行
- 新增 `platform-control` 源码抽样行数：api-cli 164、http 563、models 367、projects 153、works 107（合计 1354 行）
- 这些未提交改动是**接手前既有工作**；本任务从 T00 起不覆盖、不按旧快照回写。

## 2. 上游锁定契约

- 上游目录：`upstream/deepseek-harness-git`（git 子模块/镜像检出）
- 锁定版本：`0.2.2-rc.1`，commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`
- 上游 HEAD 当前即该 commit（已核对）
- 相关原生包（T01/T02 将逐文件核实 export 与签名）：
  - `packages/client/ui-conversation`（`@deepseek-ai/dsh-client-ui-conversation`，v0.2.2-rc.1）
  - `packages/client/ui-chat`（`@deepseek-ai/dsh-client-ui-chat`，v0.2.2-rc.1）
  - `packages/client/ui-session`
  - `packages/api/session-controller/src/client/transport.ts`（`ClientRemote['session']`、*AssistantStream*、*Remote* 命名空间）
  - `packages/host/frontend-static`（Web shell SPA 分发 + 进程 token/cookie 准入）

## 3. 工具链与运行环境

- Node：**v22.20.0**（PATH 中唯一 node 为 `/d/package/Nvm/nodejs/node`）
- 项目支持 Node：**>=24.9.0**（见 `verify-all.cjs` 的 `supportedNode` 与各处 `engines`）
- **现状缺口**：当前环境 Node < 24.9，未达到项目支持版本；`scripts/verify-all.cjs` 会报
  `Node 22.20.0 is unsupported; require >=24.9.0.` 并以 EXIT 0 退出（注意：该脚本支持性检查
  退出码为 0，不构成强制门禁；真实包验证命令仍可在 22.20 下运行但非声明支持范围）。
- pnpm：`10.7.0`；tsx `4.23.13`；typescript `6.0.3`；esbuild `0.28.2`
- **T00 结论**：基线 Node 不达标；后续 T03–T11 的 `verify` 需在 >=24.9 环境复跑，本环境结果
  仅作初步验证，不报告为项目支持的合规验证。

### 3.1 在 Node 22.20 下的初步验证（仅供 T00 现状参考，非交付门禁）

- `packages/platform-control`：
  - `tsc --noEmit`：`TSC_EXIT:0`（类型通过）
  - `tsx --test tests/*.test.ts`：**68/68 通过**
  - `node build.mjs`：构建成功，产物在 `lib/`（含 http.js、cordis.js、api-cli.js）
- 根检查器：`node scripts/check-development-standard.mjs` → PASSED（插件互引/包边界无违规）
- 根聚合器：`node scripts/verify-all.cjs` → 因 Node 版本打印不支持提示后 EXIT 0

## 4. 当前监听服务

- 未发现本工作区内的运行服务（无 `:3080`–`:3099` 区间 LISTENING 端口）。
- `.runtime/*.log` 为历史产物（最近 `remediation-final6.log`），无活跃进程持有。
- `.runtime/workbench-preview.sqlite` 最后写入 2026-11-11 13:28，当前无进程持有写锁。

## 5. 写入所有权边界（同一组文件单一写入负责人）

依据 CLAUDE.md："同一组文件只允许一个写入负责人。存在其他会话/子任务写入时先明确范围，不并行覆盖。"

- **本任务（本文 T00→T11）写入负责人**：单一接续会话，负责 `docs/native-workbench/**`、
  `packages/platform-control` 的 T03–T05 改造、`packages/platform-workbench`（T02 新增）、
  部署脚本（T08）。
- **其他会话范围**：T00 开始时未发现其他会话持有上述文件的写锁，也未发现 `*.lock` 协作文件。
  "未收到回复"不视为已协调；任何并行写入请求须先明确文件责任再继续。
- **不可并行编辑**：manifest、pnpm-lock.yaml、总导航、同一测试夹具。多任务通过公共接口消费，
  不并发 Edit 同一文件（T00/T01 后写入 ownership 表，见 STATUS.md）。

## 6. 机密处理

- 基线证据**不含**任何密钥：`.env`、provider key、Bearer token、credential 路径均未记录。
- 部署脚本（如 `workbench-deployment.cjs`）仅引用 credential env 变量名（如 `ZAI_CODING_CN_API_KEY`），
  从不内联密钥；本基线不复制其值。
- `DSH_HOME` 指向 `.runtime/dsh-home`，为本地开发目录，不含生产凭据。

## 7. T00 验收对照

| 验收项 | 状态 |
|---|---|
| 基线可复查 | ✅ 本文 + `git status` + 上游 commit 已记录 |
| 未经授权未切分支/提交/清理 | ✅ 仅读取与写证据文件，未切分支、未提交、未 reset/clean/stash |
| Node 支持 >=24.9 | ⚠️ 当前环境 22.20 不达标；记录为已知缺口，后续在合规环境复跑 |
| 真实密钥不进入证据 | ✅ 仅引用 env 变量名，不记录值 |
| 写入负责人记录 | ✅ 见第 5 节与 STATUS.md |

下一步：T01（上游能力矩阵与 ADR）。T00 完成。
