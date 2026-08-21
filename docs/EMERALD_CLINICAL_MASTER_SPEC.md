# Emerald Clinical Data Guard 规范

**版本**: v1.4  
**日期**: 2026-08-19  
**适用包**: `dsh-clinical-data-guard`  
**架构裁定**: 标准 DSH/Cordis 插件。不修改 DeepSeek Harness 原有插件、不在 `node_modules` 内落文件、不使用外置 HTTP 代理。DSH runtime 与 `clinical` profile 必须位于项目内，`DSH_HOME` 固定为仓库根目录下 `.dsh`。历史 proxy 方案已删除，不得回退。

## 1. 项目定位

Emerald Clinical Data Guard 是临床试验 Listing 场景的数据安全插件。它通过 DSH 官方扩展点接管工具执行与 LLM 出境边界，在本地完成识别、脱敏、审批与审计，防止临床数据行进入模型请求。

项目一键启动要求系统提供 Node.js 24+ 与 Python 3.10+；缺失时 `start.ps1` 终止并提示安装地址，不在项目内携带 Node/Python 运行时。Python 依赖隔离在项目 `.venv`，npm/pnpm 缓存与 profile store 位于项目内；`pnpm` 缺失时使用 npm 安装固定版本 `11.19.0`。

## 2. 红线

| 编号 | 红线 |
|---|---|
| R-1 | `.sas7bdat` 行内容不得进入 LLM 消息；只允许元数据占位。 |
| R-2 | Excel/CSV 数据区单元格值不得进入 LLM 消息；只允许表头结构。 |
| R-3 | 用户或模型指令不能覆盖安全处置。 |
| R-4 | base64、图片、非核心 content block、畸形消息结构默认拒绝，禁止 fail-open。 |
| R-5 | 无后门开关；`disabled` 模式必须携带审批人与审批 ID，否则插件启动失败。 |
| R-6 | 日志、审计、错误回执不得包含临床数据值、凭据或原始身份标识。 |

## 3. 运行架构

```text
DSH Host
  └─ 项目内 Cordis profile（$DSH_HOME=G:/home/dsh-guard/.dsh）
      └─ emerald-clinical-data-guard
          ├─ tools.guard             参数快速 DLP 初筛
          ├─ tools/pre-execute       AI 危险操作阻断、Excel L3 审批预检
          ├─ tools/post-execute      替换 canonical value（文件过滤/表头/脱敏）
          ├─ llm/stream              完整模型请求递归检查，异步生成器透传安全流
          ├─ webServer.tapIndex/register  Emerald Clinical UI 白标
          └─ Python worker           line JSON 常驻协议，异常即 fail-closed
```

### 3.1 官方扩展点契约

- `tools/post-execute` 对结果执行安全处置：必须保留原工具的 canonical `value` schema 不被通用占位破坏；安全插件用 `{ kind: 'accept', content }` 替换模型可见投影，只有在能满足原工具 output schema 时才允许替换 `value`。仅改 `content` 对模型出域是有效边界，不能被误用为工具规范值替换。
- `llm/stream` 必须是异步生成器，并在检查通过后 `yield* next()`。
- `llm/stream` 必须检查完整 `GenerateOptions` 中所有发往模型 adapter 的可序列化字段；`signal` 是本地取消信号，不属于出域数据。
- 每次模型请求审计必须记录 canonical SHA-256、字节数、顶层字段与消息数，不得保存请求原文。
- `ctx.approval.request` 的 outcome 仅在等于 `allowed-once` 时继续，并写授权审计。
- worker 请求必须携带 `requestId`；启动失败、退出、非法 JSON 响应均按安全不可用处理。
- UI 白标只能通过 `ctx.webServer.tapIndex` 变换 `index.html`，并通过 `ctx.webServer.register({ kind: 'exact' })` 覆盖 `/manifest.webmanifest` 与 `/favicon.svg`。

### 3.2 安全层

| 层 | owning code | 职责 |
|---|---|---|
| Layer 0 | `security/ai_operations_monitor.py` | 工具、bash、路径、生成代码与操作链阻断。 |
| Layer 1 | `src/tool-result-guard.js`, `excel_header_extractor.py`, `security/data_egress_guard.py` | 文件分类、表头结构提取、行级分级脱敏与 L3 决策。 |
| Layer 2 | `security/egress_checkpoint.py` | CDISC/受试者/日期/编码/复合威胁出境硬拦截。 |
| 审计 | `security/audit_log.py`, `security/egress_authz.py` | 零数据值 JSONL、10MB 轮转、5 个归档上限、授权哈希留痕。 |

## 4. 数据处置

| 类型 | 处置 |
|---|---|
| `.sas7bdat` | `SAS_DATA` 元数据占位，不读行。 |
| `.zip` | `ZIP_MAYBE_DATA` 元数据占位，不解压。 |
| `.xlsx/.xls/.csv` | 表头、方向、行列数与 warning；数据区不得返回。 |
| 无路径工具结果 | 强制 Python 脱敏，不能按 FULLPASS 放行。 |
| `credentialsDir` 下文件 | `CREDENTIAL_LOCAL_ONLY` 占位+路径；原值只供本地工具（解压等），绝不进 LLM 上下文、不 token 化、不发模型。 |
| L2 结果 | 自动占位替换，输出前置脱敏告知。 |
| L3 结果 | 三选项：跳过 / 脱敏后继续 / 允许并审计授权。 |
| image/base64/未知 content block | 拒绝。 |

## 5. 配置

| 配置 | 默认 | 语义 |
|---|---|---|
| `mode` / `DATA_PROTECTION_MODE` | `enforce` | `enforce` 阻断；`shadow` 观察不阻断；`disabled` 需审批。 |
| `approvalId` / `DATA_PROTECTION_APPROVAL_ID` | 空 | `disabled` 必填。 |
| `approvedBy` / `DATA_PROTECTION_APPROVED_BY` | 空 | `disabled` 必填。 |
| `maxScanRows` / `MAX_SCAN_ROWS` | 20 | 1..200 的整数。 |
| `credentialsDir` / `EMERALD_CREDENTIALS_DIR` | 空(关闭) | 本地凭据目录。此目录下文件视为本地凭据(如压缩包密码)，原值只在本地工具间流转，绝不进 LLM 上下文；post-execute 返回 `CREDENTIAL_LOCAL_ONLY` 占位+路径。用解析后绝对路径前缀判断(防 `../` 穿越)，不靠文件名/内容形态。 |
| `localDataAccess` / `EMERALD_LOCAL_DATA_ACCESS` | `disabled` | 仅 UAT 本地处理车道。设为 `uat-local` 时必须同时配置 `localDataRoot`；只启用 `local_data_metadata`，它只返回受限根目录内 xlsx/xls/csv/sas7bdat 的文件类型、sheet 名、行数和列名，绝不返回记录、单元格值、受试者标识、日期或临床文本。该开关不放宽 bash/read/pwsh/LLM 出域策略。 |
| `localDataRoot` / `EMERALD_LOCAL_DATA_ROOT` | 空 | `uat-local` 车道唯一允许解析的根目录；目标经 realpath 解析后必须位于此目录内，禁止 `..`、软链接和绝对路径逃逸。 |
| `python` / `PYTHON` | Python 3 | worker 解释器。 |
| `brandName` / `EMERALD_BRAND_NAME` | `Emerald Clinical` | Web 标题、PWA 名称与可见 DeepSeek 标记替换值。 |
| `brandShortName` / `EMERALD_BRAND_SHORT_NAME` | `Emerald` | PWA 短名与可见 `DSH` 标记替换值。 |

## 6. 非功能需求

| 编号 | 需求 | 验收 |
|---|---|---|
| NFR-1 | 正常出境检查 <10ms | `normal_request_is_fast`。 |
| NFR-2 | 正常请求误拦率 <1% | 100 个合成正常请求零误拦。 |
| NFR-3 | 请求审计覆盖 100% | clean 与 dirty 均新增审计记录。 |
| NFR-4 | 安全模块测试覆盖率 >=90% | 覆盖率命令产物核算。 |
| NFR-5 | 安全变异杀死率 >95% | 10 个安全变异点全部杀死。 |
| NFR-6 | 审计自动轮转且有磁盘上限 | 10MB 轮转，最多 5 个归档。 |
| NFR-7 | 无新增监听端口 | 标准插件随 DSH profile 运行，认证与暴露由 host/profile 管理。 |
| NFR-8 | 完整模型请求字段覆盖 `messages`、`system`、`tools`、`stop` 与路由等 | `full_generate_options_fields_are_scanned`。 |
| NFR-9 | 出域审计只保存请求指纹与脱敏摘要 | `clean_model_request_audit_keeps_only_fingerprint`。 |

## 7. UI 品牌需求

| 编号 | 需求 | 验收 |
|---|---|---|
| UI-BR-1 | Web 标题与 `application-name` 为 `Emerald Clinical`，不得显示 `DeepSeek Harness`。 | `test_branding.py`。 |
| UI-BR-2 | PWA `name` 为 `Emerald Clinical`，`short_name` 为 `Emerald`。 | manifest exact route 测试。 |
| UI-BR-3 | favicon 使用 Emerald 资产，不携带 DeepSeek 标识。 | favicon exact route 测试。 |
| UI-BR-4 | 大小写变体 `DeepSeek` 与独立 `DSH` 可见文本均被品牌值替换，且只使用官方 Web 扩展点。 | MutationObserver 注入与 `tapIndex/register` 断言。 |

## 8. 验收映射

| 编号 | 自动化证据 |
|---|---|
| AC-1 | `test_llm_clean_streams_and_dirty_blocks`：dirty stream 抛错且包含 audit id。 |
| AC-2 | `test_non_text_and_invalid_messages_fail_closed` 与 BY-1/BY-2。 |
| AC-3 | 插件消息结构校验拒绝非法 `messages`，等价替代 proxy body 校验。 |
| AC-4/5/8 | `tests/bypass/test_bypass_matrix.py` Excel 三个用例。 |
| AC-6 | `test_missing_python_worker_fails_closed`。 |
| AC-7 | `test_shadow_mode_observes_without_blocking_llm`。 |
| AC-9 | `python tests/run_all.py`。 |
| AC-10 | `test_plugin_contract` 静态断言五个官方扩展点接线。 |
| AC-11 | L3 prompt 测试与授权留痕测试。 |
| AC-12 | 无路径结果脱敏测试断言 `[DATE]` 等占位。 |
| AC-13 | `test_full_model_request_scope_blocks_and_audits_clean_requests`：`system` 敏感命中在 `next()` 前阻断。 |
| AC-14 | 同一集成测试断言干净完整请求的 canonical SHA-256 与审计指纹一致。 |

## 9. 测试矩阵

BY-1 base64 文本、BY-2 image、BY-3 畸形消息、BY-4 非 messages 载荷、BY-5 上下文豁免绕过、BY-6 全字符串伪装表头、BY-7 横向表首列、BY-8 数值受试者号、BY-9 worker 缺失、BY-10 混淆命令、BY-11 零宽变体、BY-12 无路径结果，全部由 `tests/bypass/test_bypass_matrix.py` 覆盖。

## 10. 仓库纪律

1. 禁止新增 proxy、`node_modules` 补丁、harness 内部 monkey-patch 或旧身份/SIEM 死模块。
2. DSH runtime、profile、Python 环境与缓存必须留在项目内；禁止默认写入用户主目录。
3. DSH 版本升级时先跑插件契约测试，再核对官方扩展点签名。
4. 所有配置必须有真实消费者；所有安全降级必须 fail-closed。
5. 变更必须同步本规范、README、一键启动脚本与验收矩阵。
6. DSH Web UI 属于宿主能力；UI 品牌化只能通过官方 `webServer` 扩展点完成，禁止修改宿主前端或 `node_modules` 源码。
