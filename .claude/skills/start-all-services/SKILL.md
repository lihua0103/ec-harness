---
name: start-all-services
description: 自动启动本机全部开发服务：脱敏工作台、两个本地模型、WorkMate 桥接、DSH 控制面和工作台 WebUI。用户说“启动全部服务”“启动开发环境”或调用 /start-all-services 时使用。
user-invocable: true
---

# 一键启动全部本地服务

当用户要求启动全部服务、启动开发环境，或调用 `/start-all-services` 时，直接在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-all-services.ps1
```

不要只把命令作为建议返回；应实际执行脚本。脚本自身会：

- 幂等检查端口，已经运行的服务不重复启动；
- 按依赖顺序启动 8817、8080、8787、3096、3095、8818；
- 等待每个端口监听并在失败时停止报告；
- 将日志写入 `.runtime/service-logs/`；
- 默认打开脱敏工作台页面。

启动完成后报告实际结果和可用地址。若用户明确要求不打开浏览器，执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-all-services.ps1 -NoBrowser
```

如果某个服务失败，先查看对应的 `.runtime/service-logs/*` 日志并报告失败服务，不要宣称全部启动成功。

## 服务地址

- 脱敏工作台：`http://127.0.0.1:8818/`
- 脱敏模型：`http://127.0.0.1:8817`
- 文档问答模型：`http://127.0.0.1:8080`
- WorkMate 桥接：`http://127.0.0.1:8787`
- DSH 控制面：`http://127.0.0.1:3096`
- DSH 工作台：`http://127.0.0.1:3095`

完整说明见 [LOCAL-SERVICES-STARTUP.md](../../../docs/LOCAL-SERVICES-STARTUP.md)。
