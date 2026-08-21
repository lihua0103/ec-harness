# Emerald Clinical Data Guard

这是标准 DeepSeek Harness / Cordis 插件，不修改 DSH 原有插件，也不依赖外置 HTTP 代理。插件通过官方 `tools` 与 `llm` 扩展点接管安全边界：

- `tools/pre-execute`：工具参数 DLP 初筛、AI 危险操作阻断、Excel L3 审批预检。
- `tools/post-execute`：按 DSH 工具契约只替换模型可见的 `content` 投影，保留各工具自己的 canonical `value` schema；SAS/ZIP 返回元数据占位，Excel/CSV 仅返回表头结构，无路径结果强制脱敏。
- `llm/stream`：出境前递归检查完整模型请求（`messages`、`system`、`tools`、`stop` 与路由等可序列化字段；本地 `signal` 除外），非核心 content block 与 image/base64 载荷拒绝。
- 出域证据：每次模型请求写入无原文审计指纹，包含 canonical SHA-256、字节数、顶层字段与消息数；敏感命中在进入模型 adapter 前阻断。
- 常驻 Python worker：line JSON 协议；异常、退出或缺失时 fail-closed。
- Web 白标：通过官方 `webServer.tapIndex/register` 替换标题、PWA manifest 与 favicon；运行时会把未来出现的可见 `DeepSeek` / `DSH` 文本替换为 Emerald Clinical 品牌。
- 审计：JSONL 零数据值，10MB 自动轮转，最多保留 5 个归档。
- 本地 UAT 数据车道（默认关闭）：设置 `EMERALD_LOCAL_DATA_ACCESS=uat-local` 和 `EMERALD_LOCAL_DATA_ROOT` 后，模型只能经 `local_data_metadata` 获取根目录内文件的类型、sheet 名、行数和列名；不会返回任何数据行、单元格值、受试者标识、日期或临床文本，且不会放宽 `bash`、`read`、`pwsh` 或 LLM 出域限制。

## 安装

包内 Python 内核需要系统 Python 3.10+；读取 Excel 表头需要 `openpyxl`。DSH 侧通过 peer dependencies 提供运行时，本包不携带额外 Node 依赖。项目根目录的一键启动脚本会检测系统 Node.js 24+/Python 3.10+，缺失时提示安装；随后安装项目内 runtime、profile 和 Python 依赖，缺 pnpm 时自动安装 pnpm 11.19.0。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File G:\home\dsh-guard\start.ps1
```

如需直接调用 DSH CLI，必须先设置项目内 home：

```powershell
$env:DSH_HOME='G:\home\dsh-guard\.dsh'
G:\home\dsh-guard\runtime\node_modules\.bin\dsh.CMD --profile clinical
```

`cordis.patch.yml` 会将插件加入 profile layer。默认模式是 `enforce`；如需 `disabled`，必须同时提供 `approvalId` 与 `approvedBy`，否则插件启动失败。

## 测试

```powershell
$env:PYTHONIOENCODING='utf-8'
python tests/run_all.py
python tests/mutation/run_mutation.py
```
