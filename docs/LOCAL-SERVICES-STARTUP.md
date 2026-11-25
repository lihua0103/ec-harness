# 本地服务一键启动

`\.runtime\start-all-services.ps1` 会幂等启动本机开发所需服务；已在监听的端口会跳过，不会重复拉起进程。

## 启动

在 PowerShell 中运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .runtime\start-all-services.ps1
```

脚本默认启动：

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| 脱敏模型 | `http://127.0.0.1:8817` | Qwen3-1.7B fast 档 |
| 文档问答模型 | `http://127.0.0.1:8080` | Qwen3-4B |
| WorkMate 桥接 | `http://127.0.0.1:8787` | 需要本机有效 cookie |
| DSH 控制面 | `http://127.0.0.1:3096` | 项目控制面 |
| DSH 工作台 WebUI | `http://127.0.0.1:3095` | 原生工作台 |
| 脱敏工作台 | `http://127.0.0.1:8818` | 启动完成后自动打开浏览器 |

日志统一写入 `.runtime/service-logs/`，便于区分启动失败原因。脚本只绑定 `127.0.0.1`，不会把这些本地服务暴露到局域网。

## 选项

```powershell
# 不自动打开浏览器
powershell -NoProfile -ExecutionPolicy Bypass -File .runtime\start-all-services.ps1 -NoBrowser

# 只启动工作台（不启动两个模型、桥接和脱敏工作台）
powershell -NoProfile -ExecutionPolicy Bypass -File .runtime\start-all-services.ps1 -NoModels -NoBridge -NoDeid

# 不启动文档问答模型
powershell -NoProfile -ExecutionPolicy Bypass -File .runtime\start-all-services.ps1 -NoDocChat
```

`-NoWorkbench`、`-NoBridge`、`-NoDeid` 也可单独组合。服务停止仍使用现有服务各自的停止方式；本脚本不强制杀掉用户已经运行的进程。

> 说明：脚本使用当前机器已有的 `D:\package`、`D:\local-llm`、`D:\llm` 安装路径。如果这些路径变化，请先调整脚本顶部的路径常量。
