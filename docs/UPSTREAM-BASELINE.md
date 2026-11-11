# DeepSeek Harness 上游基线调查

日期：2026-11-08

> 本文是取得上游源码时的历史调查快照，不因本轮架构文档更新而补报运行结果。后续构建/插件测试与当前差距统一见[开发交付状态](RELEASE-READINESS.md)；当前职责见[平台1.1](ENTERPRISE-PLATFORM-ARCHITECTURE.md)与[ADR-0001](adr/ADR-0001-DEVELOPMENT-AND-KNOWLEDGE-ARCHITECTURE.md)。下文“未构建/未安装”等陈述仅限当时调查阶段，不是当前全部状态。

## 来源

- 官方仓库：https://github.com/deepseek-ai/deepseek-harness
- GitHub API 主线查询：https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/master
- API 返回 commit：`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`
- API 返回提交时间：`2026-11-04T08:40:00Z`
- 固定源码归档候选：https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159

以上 commit 由实际 API 响应得到，现已完成本地 checkout 与 Git 对象完整性检查；不代表已完成构建、运行或扩展 API 验证。

## 本次拉取结果

1. `git clone` 官方仓库：连接 GitHub 超时，退出码 128（300031ms）。
2. 浅克隆重试：未取得完成结果，已主动停止，避免持续占用后台任务；如残留目录须先检查，不能直接覆盖或声称有效 checkout。
3. 官方 codeload 地址 HEAD 请求：HTTP 200，归档通道可达。
4. 固定提交归档下载此前被自动安全判定服务不可用阻挡，命令未执行。
5. 后续将会话降至 Manual（逐次确认）权限模式后，命令恢复执行；固定提交的 codeload 通道实际返回 HTTP 200，归档下载已启动，最终结果待下文更新。权限工具报告此前模式为 Bypass，与错误文本的 Auto 描述不一致，因此只记录观察到的结果，不断言内部故障机制。
6. 参考项目 `dsh-clinical-boundary/upstream` 中存在 `archive2.tar.gz`（40,314,465 字节），已有源码 HEAD 为 `b830ec950faba0a46dda564be3e2d854afed94f1`；本次不将它冒充新下载的官方候选提交。

**当前结果：固定提交源码已获取、检出并通过 Git 对象完整性检查。**

此前归档通道的失败记录：

- 首次归档下载收到 5,935,165 字节后因 180 秒上限退出（curl 28）。
- 分段探测返回 HTTP 200 而非 206，不依赖断点续传。
- 长时下载在 682.65 秒收到 14,620,055 字节后连接中断（curl 18）；gzip 完整性检查报 EOFError，未解包。日志中的 `Download complete` 是无条件输出标签，不是成功证据。

实际成功路径与验证结果（2026-11-08）：

- 在新的 `upstream/deepseek-harness-git` 目录中复制参考仓库的 Git 对象（no-hardlinks、no-checkout，不复制其未提交工作区），再从官方 origin 获取固定目标提交并检出。
- `origin`：`https://github.com/deepseek-ai/deepseek-harness.git`。
- `HEAD`：`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，detached HEAD；不是参考仓库的 `b830ec950faba0a46dda564be3e2d854afed94f1`。
- `git fsck --connectivity-only` 与 `git fsck --full` 均成功退出、无报错；`git status --porcelain=v1` 无输出。
- `git ls-files` 统计为 20,665 个受跟踪文件，`git ls-files -d` 为 0，未发现受跟踪文件缺失。
- 当前提交显示为浅历史边界（grafted）；上述检查确认本地现有 Git 对象的完整性与检出状态，不代表取得完整上游历史，也不是签名认证、代码安全审计或运行验收。
- 根 `package.json` 声明版本 `0.2.2-rc.1`、包管理器 `pnpm@11.28.5`、Node.js 要求 `>=24.9.0`；尚未核对本机环境是否满足这些声明。
- 检出时关闭 Git hooks，并使用 `core.symlinks=false`；符号链接以链接目标文本文件形式检出，运行前仍需检查 Windows 兼容性。
- 未安装依赖、执行上游脚本或启动 Harness。失败的归档未作为有效源码使用；本次成功基线由 Git commit 标识，不提供归档摘要。

## 当前架构依据

- 现有设计基于 Context7 的官方仓库文档索引，以及参考项目中少量开发源码与架构说明的只读检查。
- 目标提交现已可供本地核对；已读取根 `AGENTS.md`、根 `package.json` 的版本与环境声明，并抽查 README。不把这些初步检查视为扩展接口验证。

尚未完成：按锁定源码核对架构与真实公开 exports/UI/provider 调用链、依赖和运行环境检查、插件装配及安全测试。在线文档与源码获取成功不能替代这些验证。

## 后续核对

无需重新下载同一目标提交。以现有 checkout 为只读基线，继续核对 README、安全说明、package manifests、公开扩展点及现有能力，记录与本项目架构的差异；在依赖安装或运行前另行确认，不自动运行下载代码。
