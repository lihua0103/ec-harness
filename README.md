# Emerald Clinical Data Guard

这是面向本地 DeepSeek Harness（DSH）/ Cordis 的临床试验数据安全项目。源码、DSH runtime、独立 profile、Python 虚拟环境、npm/pnpm 缓存和运行数据全部位于项目根目录；不修改 DSH 原有插件，不修改 `node_modules` 源码，也不启动外置 HTTP 代理或新增插件监听端口。

当前唯一交付边界：

```text
docs/                         主规格与 v2 开发验收计划
runtime/                      项目内 DSH 0.1.0-rc.6 清单与锁文件
.dsh/profiles/clinical/       项目内 profile 清单与 pnpm 锁文件
dsh-clinical-data-guard/      标准插件、Python 安全内核、测试与发布包
```

Web 工作台通过插件内官方 `webServer` 扩展完成 Emerald Clinical 白标：页面标题、PWA 名称、favicon 与未来出现的可见 `DeepSeek` / `DSH` 文本均替换为 Emerald Clinical 品牌，不修改 DSH 官方包或 `node_modules` 源码。

模型出域边界位于官方 `llm/stream` waterfall：插件会在请求进入模型 adapter 前扫描完整模型请求，并写入无原文的 canonical SHA-256 审计指纹。

## 一键启动

启动前需在系统安装 Node.js 24+（含 npm）与 Python 3.10+；缺失时脚本会终止并提示安装地址，不会把 Node/Python 运行时放进项目。`pnpm` 缺失时会用 npm 安装固定版本 `11.19.0`，已存在则直接复用。首次运行或锁文件变化时，DSH npm 包、Python 依赖和 profile 依赖会安装到项目目录；pnpm 使用 `--prefer-offline` 复用项目内 store：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

脚本会：

1. 使用项目根目录下的 `.dsh` 作为 `DSH_HOME`，禁止落到用户主目录。
2. 按锁文件安装项目内 DSH runtime。
3. 基于系统 Python 创建 `.venv` 并按根目录 `requirements.txt` 安装 Python 依赖。
4. 使用系统或自动安装的 pnpm 按相对路径刷新 `clinical` profile。
5. 启动 Web 工作台并自动打开 `http://127.0.0.1:3080`。

本地工作台只监听 `http://127.0.0.1:3080`，不启动额外的观察或调试端口。

只做环境和 profile 校验、不启动服务时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Check
```

发布包位于：

```text
dsh-clinical-data-guard/emerald-clinical-data-guard-1.0.7.tgz
```

SHA-256: `310FA292D2999C7D162D1F4C8D27085E4DF83F9A3F424F8BA0D8A2B10F2BAE67`

## 验证

```powershell
# 从项目根目录执行
Set-Location .\dsh-clinical-data-guard
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONDONTWRITEBYTECODE='1'
python tests\run_all.py
python tests\mutation\run_mutation.py
& ..\.venv\Scripts\python.exe ..\tests\test_project_contract.py
```

详细架构、验收矩阵和仓库纪律见 [EMERALD_CLINICAL_MASTER_SPEC.md](docs/EMERALD_CLINICAL_MASTER_SPEC.md) 与 [EMERALD_DEV_PLAN_v2_20260818.md](docs/EMERALD_DEV_PLAN_v2_20260818.md)。
