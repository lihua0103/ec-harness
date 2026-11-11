# ADR-0002：Worker 执行器采用 DSH profile / SDK，而不是自定义子进程协议

日期：2026-11-11。状态：已决策；适配器已实现，进程监督/调度未实现。决策人：平台开发。

## 背景

平台控制面需要把已登记的 Run 交给受控执行域。可选路径有：

1. 自定义子进程协议：控制面 spawn 一个普通 Node 脚本，用私有 JSON 协议传输入/结果。
2. DSH profile / SDK：用 `dsh` 命名 profile 或 `@deepseek-ai/dsh-sdk-client` 启动一个完整的 Harness runtime，
   由该 runtime 的 Agent 在锁定 composition 内自主使用工具。
3. 控制主服务内直接 import 领域代码：违反执行隔离与发布合同。

## 决策

采用 **方案 2：DSH profile / SDK**。

- 每个 Run 在其应用发布锁定的 worker profile 中执行；profile 固定 DSH/runtime、平台 bundle、业务插件、
  工具 roster 与资源基线。
- 控制面只传目标、输入引用、应用版本/计划摘要和验收事实；不规定工具调用顺序，不替 Worker 规划步骤。
- Worker 使用 DSH 原生 Agent 循环、工具、会话、取消与权限机制；平台不重造循环，也不在控制服务内执行业务代码。
- Worker 的最终结果不是“成功”证明：它返回会话 id、最终文本、退出事实与产物清单；控制面另行核验。
- 工具 roster 是部署 composition（工作身份和能力边界），不是模型必须遵循的流程；worker 内 Agent 仍自由选择工具。

## 被否决方案

- **自定义子进程协议**：绕过 Harness 的会话、工具授权、取消与事件语义，实际是在重写 Agent 循环；也无法复用
  已批准的插件与 profile 组合。
- **控制服务内 import**：把领域代码、文件和验证器带进控制进程，破坏隔离与故障边界。
- **由模型自报完成/产物**：工具结果不能代替实际退出、文件摘要或业务验收。

## 实现约束

1. Worker 启动走 `dsh --profile <worker-profile>` 或 SDK client；禁止直接启动 `apps/cli`、包 bin 或内联 Cordis 树。
2. profile 与应用发布绑定；运行期不按 latest/安装顺序解析。Worker 启动前核对 planDigest、runtimeBundleDigest。
3. Worker 的输入是目标与已授权资料引用；真实数据访问仍受平台/IT 授权，不因 prompt 获得权限。
4. 取消使用 Harness 的取消与进程终止证据；不能用 `Promise.race` 假装停止。
5. 产物由 Worker 写入隔离工作目录并给出清单；控制面在目录边界内校验大小/摘要，登记后才允许完成屏障。
6. 一个 Run 一个 worker home/session；恢复/重试生成新 Run，不静默复用旧队列。
7. Worker 执行器是 `platform-control` 的外部适配器，不在控制面 import 业务插件或模型 provider。

## 第一阶段交付（进行中）

- `DshProfileExecutor` 已实现：通过 SDK client 启动锁定 profile，传入目标/输入与产物清单契约，映射取消、
  最终文本与产物摘要；控制面登记产物并完成 `artifactsRegistered`。
- 合成 worker 测试覆盖正常完成、产物越界、取消；SDK 模块未安装时明确失败。
- 待补：真实 worker profile 组合、launch 对账、超时后的进程树证据、崩溃恢复、调度与重试。