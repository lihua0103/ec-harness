# Emerald Clinical Data Guard 开发与验收计划

**版本**: v2.4  
**日期**: 2026-08-19  
**执行角色**: 研发总监 / 后端 / 安全 / 测试 / 多 Agent 复核  
**最终形态**: DSH/Cordis 标准插件，全量满足红线、验收、绕过与非功能需求。

## 1. 架构决定

采用独立插件包 `emerald-clinical-data-guard`：

- 不修改 DeepSeek Harness 原有插件，不修改 `node_modules`。
- 项目内 `runtime/` 锁定 DSH `0.1.0-rc.6`；`DSH_HOME` 固定为项目内 `.dsh/`。
- 通过 `cordis.patch.yml` 加入 DSH profile layer。
- 安全边界集中在 `tools/pre-execute`、`tools/post-execute`、`llm/stream`。
- `llm/stream` 扫描完整模型请求并写入无原文出域指纹；`signal` 仅是本地取消信号，不进入扫描。
- Web UI 白标集中在官方 `webServer.tapIndex/register` 扩展点，不修改宿主源码。
- Python worker 常驻本地，line JSON 通信，异常 fail-closed。
- 旧 `proxy.js`、旧 Node-Python checkpoint、旧示例、旧锁文件与未接线企业模块全部删除。

## 2. 开发工作流

| 工作流 | 结果 |
|---|---|
| 官方契约复核 | Agent 复核 DSH rc.6 扩展点，确认 post-execute 必须替换 `value`、stream 必须异步生成器。 |
| 插件内核 | 实现 `src/index.js`、`tool-result-guard.js`、`patterns.js` 与 `security/worker.py`。 |
| 安全算法 | 统一 `patterns.py`；修复 base64 边界、零宽归一化、pickle 别名、base64 shell、SAS 扩展、文件名豁免。 |
| 完整出域检测 | 扫描 `GenerateOptions` 全部模型侧可序列化字段；新增 canonical SHA-256 审计指纹。 |
| 审批与审计 | 实现 L3 三选项、`allowed-once` 授权、零数据值 JSONL、轮转与磁盘上限。 |
| 企业清理 | 删除旧 proxy 形态和未接线模块，保留唯一标准插件路径。 |
| 一键交付 | `start.ps1` 检测系统 Node.js 24+ 与 Python 3.10+，缺失时提示安装；自动安装缺失 pnpm 11.19.0，按锁文件安装依赖、刷新 profile、启动 Web UI 并打开工作台。 |
| UI 白标 | 使用官方 `webServer` 扩展替换标题、PWA manifest、favicon，并把可见 `DeepSeek` / `DSH` 文本替换为 Emerald Clinical 品牌。 |
| 多 Agent 同步 | 一个 Agent 复核插件契约，一个 Agent 盘点仓库清理；主线并行实现与测试。 |

## 3. 质量门禁

| 门禁 | 命令 | 目标 |
|---|---|---|
| 契约 | `tests/integration/test_plugin_contract.py` | manifest、patch、default export、inject、五个扩展点。 |
| 项目交付契约 | `tests/test_project_contract.py` | 一键启动、项目内 DSH_HOME/runtime/profile、无 C 盘与 proxy 回退。 |
| 单元/安全 | `tests/unit/test_security.py` | 识别、脱敏、审计、性能、误报、轮转。 |
| 插件运行时 | `tests/integration/test_plugin_runtime.py` | 工具、LLM、Excel、审批、fail-closed、shadow。 |
| UI 品牌 | `tests/integration/test_branding.py` | 标题、manifest、favicon、官方扩展点与动态文本替换。 |
| 绕过 | `tests/bypass/test_bypass_matrix.py` | BY-1..BY-12。 |
| 总回归 | `python tests/run_all.py` | 全部 suite 通过。 |
| 变异 | `python tests/mutation/run_mutation.py` | 10/10，100%。 |
| 静态 | `node --check` / `py_compile` | JS/Python 语法。 |

## 4. 验收矩阵

| 范围 | 要求 | 结果 |
|---|---|---|
| R-1..R-6 | 红线全部由自动化测试守护 | PASS |
| AC-1..AC-14 | 全部二值验收 | PASS |
| BY-1..BY-12 | 全部绕过场景通过 | PASS |
| NFR-1 | 正常检查 <10ms | 单元测试通过 |
| NFR-2 | 100 个正常合成请求零误拦 | 单元测试通过 |
| NFR-3 | clean/dirty 均 100% 审计 | 单元测试通过 |
| NFR-4 | 安全模块覆盖率 >=90% | PASS，trace 行覆盖 100% |
| NFR-5 | 变异杀死率 >95% | 10/10，100% |
| NFR-6 | 10MB 轮转、5 个归档上限 | 单元测试通过 |
| NFR-7 | 不新增监听端口 | 契约测试确认标准插件形态 |
| NFR-8/9 | 完整模型请求扫描；审计只保存指纹 | 单元与集成测试通过 |
| UI-BR-1..UI-BR-4 | Web 标题、PWA、favicon 与动态可见文本全部 Emerald Clinical 白标 | 品牌测试通过 |

## 5. 最终验证记录

- `tests/run_all.py`：单元 14/14、运行时 10/10、品牌 1/1、契约 1/1、绕过 1/1，总失败 suite 0。
- `tests/mutation/run_mutation.py`：10/10 killed，100.00%。
- `node --check`：7 个 JS 入口全部通过；`py_compile`：全部 Python 源/测试通过。
- 标准库 `trace`：安全模块行覆盖 100%。
- 真实 DSH 安装：`dsh 0.1.0-rc.6`，独立 `clinical` profile，peer 依赖完整；`1.0.4` tarball 包 18 个文件，含品牌与完整出域检测源码，且无字节码。
- 项目内安装冒烟：从 `.dsh/profiles/clinical/node_modules` 导入插件，`inject=["tools","llm","webServer"]`，Python worker 安全流通过。
- 完整出域验收：`messages`、`system`、`tools`、`stop` 与路由等字段进入同一审计指纹；干净请求允许，`system` 敏感命中在进入 adapter 前阻断。
- UI 白标 HTTP 验收：`/` 返回 200 且 title 为 `Emerald Clinical`；`/manifest.webmanifest` 返回 `Emerald Clinical` / `Emerald`；`/favicon.svg` 返回 Emerald 图标且无 DeepSeek 标识。
- 一键启动：默认缺 Python 分支按设计终止并提示安装；`EMERALD_PYTHON` 指向项目 `.venv` 时 `start.ps1 -Check` 通过，pnpm 显示 `Already up to date`；`start.ps1 -NoOpen` 启动 Web UI，`http://127.0.0.1:3080` 返回 200。
- 运行时策略：系统 Node.js `24.19.0` 可满足 DSH rc.6 的 Node 24+ 要求；项目不携带便携 Node/Python，`.tools` 与运行时压缩包已删除。

## 6. 交付边界

- 交付物：插件源码、Python 安全内核、官方 patch、项目内 DSH runtime 清单/锁文件、项目内 profile、一键启动、分层测试、变异测试、README、规范与开发计划。
- 不交付：外置 proxy、Docker proxy、宿主源码修改、未接线的 SSO/SIEM/沙箱/租户模块。
- 已知局限：模式驱动检测不能承诺识别所有未知混淆；每次新增绕过样本必须进入 BY 矩阵与变异 oracle。
