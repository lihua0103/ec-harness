# dsh-guard 架构与数据拦截审查报告

日期：2026-08-28  
分支：`feat/clinical/harness`  
范围：4 个企业插件 + listing Python 层 + 通用车道护栏

---

## 1. 系统架构与功能模块

### 1.1 仓库定位

`feat/clinical/harness` 现在是 **企业扩展平台骨架**（`@dsh-enterprise/platform`）。上游 Harness 已降级为 git submodule `upstream/deepseek-harness`，钉在 `dsh-v0.1.1-rc.2`。企业实现不再改上游本体，升级时可避免被覆盖。

### 1.2 顶层目录

| 目录 | 职责 |
|---|---|
| `packages/enterprise/` | 4 个 dsh 插件包（pnpm workspace 成员） |
| `profiles/enterprise/` | dsh profile 装配（独立 pnpm 根，刻意不入 workspace） |
| `scripts/` | 构建/校验/启动脚本（.mjs） |
| `docs/enterprise/` | ADR、runbooks、审计报告 |
| `tests/architecture/` | 架构守护测试 |
| `upstream/` | deepseek-harness 上游子模块 |

### 1.3 四个 dsh 插件

| 插件 | 核心文件 | 职责 |
|---|---|---|
| `@dsh-enterprise/listing` | `src/index.ts`、`src/worker.ts`、`python/worker.py`、`python/data_guard.py`、`python/sandbox.py` | Listing 车道：inspect/run_code/publish |
| `@dsh-enterprise/tool-audit` | `src/dataset-guard.ts` | 通用车道数据集护栏（tools/pre-execute） |
| `@dsh-enterprise/ui-settings` | `src/data-security-service.ts` | 数据安全开关 + datasetExtensions 单源配置 |
| `@dsh-enterprise/branding` | `src/index.ts`、assets | 企业白标（ADR-0002） |

插件通过各自 `cordis.patch.yml` 注册，包名由 `scripts/enterprise-plugins.mjs` 自动遍历，禁止硬编码。

---

## 2. 数据拦截实现结论

### 2.1 符合 ADR-0007/0009 终裁口径

- **唯一红线**：`dataset`（sas7bdat/xpt/csv）原始行值不出域。
- **doc/ 零拦截**：spec-document 与 aux-excel 全部退出 `data_guard.PROJECTION` 投影表，文本与 Excel 单元格值恒全量回执。
- **执行面全开**：sandbox 不再维护 builtins/AST/import 白名单，`open`/`eval`/`import os` 等全量可用。
- **控制点只在回执出口**：`data_guard.sanitize_receipt` 投影 + `tool-audit` 通用车道护栏 + 120 字符名称上限。

### 2.2 关键实现验证

- `data_guard.py`：`PROJECTION` 仅含 `dataset`；未命中子树对象恒等返回（对象引用不拷贝）。
- `worker.py`：`dispatch` 对所有 operation 回执统一调用 `sanitize_receipt`；审计只记录 `source` + `path`，不含数据值。
- `discovery.py`：`read_spec_files` 无 `build_rows` 开关，doc/ 全量读取；截断上限显式标记 `truncated`。
- `sandbox.py`：标准 Python `exec`，`__builtins__`/`__import__` 真值，pd/np 裸模块注入。
- `dataset-guard.ts`：`enterprise_*` 豁免；WRITE_ONLY_TOOLS 豁免；开关关闭零拦截；服务未装配/出错按开（fail-closed）。
- `data-security-service.ts`：默认 `enabled=true`；旧 `auxExcelExtensions` 等未知键被 `sanitizeConfig` 丢弃。

### 2.3 是否存在误拦截导致 harness 变蠢

**结论：当前实现没有误拦截导致 AI 变蠢。**

- doc/ 文本与 Excel 全量可读，不会逼模型去绕行车道。
- sandbox 执行面全开，合法查询/聚合/变换不会被 `read_`/`to_` 前缀等执行限制断路。
- 通用车道护栏只在参数中出现数据集扩展名文件时拒绝，并给出明确替代车道指引。
- 数据开关仅控制出域点，不影响代码执行能力。

---

## 3. 功能问题清单

### 3.1 Critical

无。未发现可绕过的数据集行值出域通道。

### 3.2 High（建议立即修复）

**H1. operation_publish 的 scenario 参数在 Python worker 入口未显式校验**

- 位置：`packages/enterprise/listing/python/worker.py:215-216`
- 现状：TS 入口 `index.ts` 已用 JSON Schema enum 限制为 `{manual, medical, rbqm, report}`；但 Python worker 的 `operation_publish` 直接拿 `request.get("scenario", "manual")` 拼路径，再传给 `create_multi_sheet_excel`。后者会校验 `SUPPORTED_SCENARIOS`，非法值会抛 `ValueError` 并返回 `PUBLISH_ERROR`，不会写出文件——风险被 Excel 层兜底。
- 建议：在 worker 入口显式校验 scenario，非法时返回 `INVALID_SCENARIO`，与 TS 层保持一致。

**H2. tool-audit 在 JSON.stringify 异常时 fail-open，可能绕过护栏**

- 位置：`packages/enterprise/tool-audit/src/dataset-guard.ts:57-66`
- 现状：`findDatasetReference` 在 `JSON.stringify` 抛异常时返回 `undefined`，上层 `if (reference)` 不成立，直接 `return next()` 放行。
- 风险：构造含循环引用且内嵌数据集文件名的 tool arguments，可让护栏失效。
- 建议：序列化失败时应按 deny 处理（fail-closed），或返回哨兵值让 `registerDatasetGuard` 拒绝。

### 3.3 Medium

**M1. CSV 数据集默认 UTF-8，未对 Windows GBK 编码做回退**

- 位置：`packages/enterprise/listing/python/discovery.py:176-179`
- 建议：utf-8 失败后退让 `gbk`/`gb2312`/`cp936`。

**M2. doc/ 文本读取使用 `errors="ignore"` 会静默丢字**

- 位置：`packages/enterprise/listing/python/discovery.py:353`
- 建议：改 `errors="replace"` 并保留替换标记，或做编码探测回退。

**M3. audit 写入失败被外层空 `except` 静默吞掉**

- 位置：`packages/enterprise/listing/python/worker.py:251-254`
- 建议：移除外层空 except，或改为 logger.warn 留痕。

**M4. `list_files` 自身无项目根围栏**

- 位置：`packages/enterprise/listing/python/discovery.py:112-114`
- 现状：通过 `sandbox._confined` 调用时受保护，但函数自身可被直接调用。
- 建议：函数内部复用根围栏检查。

### 3.4 Low / Info

- L1. `_walk` 对含嵌套 dataset 的非 dataset 父节点 copy-on-write 时会剥离 `_source`（当前数据结构不会触发）。
- L2. 通用车道护栏不区分目录，doc/ 下同名 `.csv` 也会被 deny（符合 ADR-0007 口径，但需在文档中明确）。
- L3. `_CappedCapture` 1MB 是软上限（可超出一个写入块，已标记 truncated，可接受）。
- L4. `run_code` 元数据构造未处理重复/非字符串列名。
- L5. `archive_passwords.py` 未限制 sidecar `.txt` 文件大小。
- L6. `request["project"]` 未要求绝对路径，相对路径解析依赖 worker cwd。

---

## 4. 测试与门禁状态

| 检查项 | 沙箱结果 | 备注 |
|---|---|---|
| pytest | **143 passed / 0 failed** | Python 层健康 |
| `tsc --build` | 通过 | 四包零类型错误 |
| `check-architecture` | 通过 | 4 插件 / 6 Bundle 层 |
| `check-secrets` | 通过 | 无敏感信息泄露 |
| `check-upstream` | 通过 | upstream 契约 OK |
| `check:python` | 通过 | pandas/numpy/openpyxl 就绪 |
| oxlint / vitest | **无法运行** | 沙箱缺少对应平台原生二进制 |
| `profile:verify` | **失败** | esbuild 平台二进制不匹配（需 Windows 侧） |

**结论**：沙箱侧代码逻辑层面的核心门禁（pytest、tsc、architecture、secrets、upstream）全部通过。lint/test/profile 验证被沙箱环境阻塞，需在 Windows 本机跑 `pnpm run check:all` 收口。

---

## 5. 杂物清理状态

记忆里的待删杂物（`file_show (6).xlsx`、`brand-diagnosis.js`、`branding.ts.backup`、`*redact*`、`python/styles/`）已不在磁盘上，清理已完成。

当前未跟踪文件仅剩：

- `.pytest_cache/`（运行产物）
- `packages/enterprise/listing/docs/DELIVERY_20260828.md`（交付文档）
- 根目录 `settings.yaml`

---

## 6. 总体结论

1. **数据拦截正确**：单规则 dataset 投影、doc/ 零拦截、执行面全开均符合 ADR-0007/0009 终裁口径。
2. **没有误拦截导致 harness 变蠢**：AI 可全量读 doc/、在 sandbox 内自由执行 Python、用 listing 车道完成全部工作。
3. **残留功能问题可控**：最高优先级是修复 H2（tool-audit 序列化失败 fail-open）和 H1（Python worker scenario 入口校验）；其余为中等/低优先级体验与健壮性项。
4. **验证待收口**：Windows 侧 `pnpm run check:all`（vitest/oxlint/profile:verify）是最后验证项。
