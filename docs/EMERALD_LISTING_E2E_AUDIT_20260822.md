# Emerald Clinical Listing 端到端（E2E）审计报告 — 第二轮复审

**日期：** 2026-08-22 晚
**方式：** Chrome DevTools MCP 驱动真实工作台（http://127.0.0.1:3080）模拟用户操作：新建会话 → 提交 RBQM_test listing 任务 → 全程跟踪；辅以 worker 子进程隔离复现
**性质：** 测试审计，仅记录问题，未修改任何产品代码
**关联：** [EMERALD_LISTING_REFACTOR_AUDIT_20260822.md](EMERALD_LISTING_REFACTOR_AUDIT_20260822.md)（第一轮代码审查）、[EMERALD_LISTING_ROOT_CAUSE_ANALYSIS_20260822.md](EMERALD_LISTING_ROOT_CAUSE_ANALYSIS_20260822.md)（RCA）

---

## 1. 上轮 BLOCK 修复核验（代码级，均通过）

| 上轮编号 | 结论 | 证据 |
|---|---|---|
| F-1 30s 超时 | ✅ 已修复 | [clinical-listing-plugin.js L11-21](file:///g:/home/dsh-guard/dsh-clinical-data-guard/src/clinical-listing-plugin.js#L11-L21) 按操作分级超时（inspect 300s / validate 60s / execute 900s），支持 config/env 覆写；超时返回结构化 `LISTING_TIMEOUT` retryable 收据而非裸 Error（L47-62）；[index.js L211-244](file:///g:/home/dsh-guard/dsh-clinical-data-guard/src/index.js#L211-L244) 做配置形状校验 |
| F-2 valueRef 静默错误 | ✅ 已修复 | [listing_executor.py L86](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/listing_executor.py#L86) 改为 `result[_column(...)]` 取列值比较；附带修复 N-8 限定名碰撞（L54-65，只认 `DATASET__COLUMN` 重命名列） |
| F-3 plan 攻防面零测试 | ✅ 已补齐 | 新增 [test_listing_plan_contract.py](file:///g:/home/dsh-guard/dsh-clinical-data-guard/tests/unit/test_listing_plan_contract.py)（658 行），已纳入 run_all.py 门禁 |
| N-1 计划资源上限 | ✅ 已补齐 | 新增 `security/listing_budget.py`（ListingBudgetExceeded / charge_execution），listing_workflow.py L20 接入 |

## 2. E2E 实测发现的新问题（本轮核心价值）

### E-1 [BLOCK] 工作台运行旧进程 + 磁盘新代码 → 首个会话即报 UnboundLocalError，真实错误被掩盖

**现象：** 21:50 首个 e2e 会话，模型调用 `clinical_listing_workflow(project="RBQM_test", scenario="rbqm")`，立即返回：
`Error: cannot access local variable 'ListingWorkflowError' where it is not associated with a value`

**根因链（已查实）：**
1. DSH 服务器进程（PID 11848）**17:45:35 启动**；而 `listing_budget.py`（20:29:12）、`worker.py`（20:42:29）、`listing_workflow.py`（21:11:50）均在之后修改——**代码改动后服务器未重启**；
2. 插件以 pnpm `link:` 指向工作区，旧服务器内存中是旧 worker.py，懒导入时读到磁盘上的新 listing_workflow.py，导不出旧函数名 → ImportError；
3. **代码缺陷放大**：[worker.py L196-230](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/worker.py#L196-L230) 把 `from security.listing_workflow import (ListingWorkflowError, ...)` 放在 try 内，而 `except ListingWorkflowError:` 在 L227——import 一旦失败，`except` 子句引用未绑定名字，抛出 UnboundLocalError，**真实 ImportError 被永久掩盖**。模型侧只能看到一句无解的话，按系统提示"工具失败不得重试"直接报告失败。

**记录要求（不改代码，仅登记）：**
- worker.py 的 import-in-try + except-引用-imported-name 是结构性缺陷：任何导入失败（缺依赖/缺模块/代码漂移）都会变成 UnboundLocalError 掩盖真因。建议 import 移出 try 或单独捕获 ImportError 并原样上报。
- 部署纪律：pnpm link 意味着"工作区即运行时"，改完代码必须重启服务器；建议启动脚本加入版本戳校验（磁盘 mtime 晚于进程启动时间则告警）。

### E-2 [BLOCK] 重启后连续两轮 `[Errno 9] Bad file descriptor` 秒败 —— worker 解释器选择不确定，无依赖自检

**现象：** 21:55 重启服务器后，21:58/21:59 两轮运行均在第 1 步以 `本轮运行失败 [Errno 9] Bad file descriptor` 立即结束。

**根因链（已查实）：**
1. 新服务器（PID 18448，21:55:19 启动）在 21:56:00 spawn 了**两个不同的 python**：
   - PID 20672：`G:\home\dsh-guard\.venv\Scripts\python.exe`（依赖齐全，隔离验证 `import pandas, pyreadstat, openpyxl` 通过，手动 spawn worker ping/pong 正常）；
   - PID 21416：`C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`（**缺 pyreadstat**，ModuleNotFoundError 实证）；
2. 落到缺依赖解释器的 worker 启动即崩，崩溃 traceback 写入已失效的 stderr 句柄时产生 EBADF，以无语义的方式杀掉整轮运行；
3. **worker 启动路径没有"解释器钉死 + 依赖预检"**：没有用 venv 绝对路径启动，也没有在 worker 启动时 fail-fast 报"pyreadstat 未安装"，故障以 EBADF 形式呈现，排障成本极高。

**备注：** 本次服务器由审计方在后台终端启动，PATH 环境可能使 codex-runtimes python 排在前面（用户正常从控制台启动时未必复现）。但"解释器不确定 + 无依赖自检"本身是产品健壮性缺口，需登记修复。

### E-3 [BLOCK] inspect 遇打不开的数据归档整单失败，且收据无任何可行动诊断

**现象（worker 隔离复现，4.3s 返回）：**
```
listing_inspect(RBQM_test, rbqm) → {"ok": false, "code": "LISTING_WORKFLOW_ERROR",
                                    "reason": "clinical listing operation failed"}
```

**根因链（已查实）：**
```
listing_data_catalog.py L56 _materialize_archives
  → PathPolicyError("a local data archive could not be opened")   # test_20260622_151305.zip 加密/未供凭据
  → listing_inspector.py L132 ValueError
  → listing_workflow.py L42 ListingWorkflowError("listing inspection failed")
  → worker.py L227 统一 sanitize 成 "clinical listing operation failed"
```

**问题本质：** RBQM_test 的 `raw/` 下已有 **72 个明文 .sas7bdat 可直接用**，仅因项目根目录一个加密 ZIP 打不开，整个 inspect 就死亡——既没有降级跳过，也没有在收据里告诉 AI"缺的是这个归档的凭据"。这是 RCA S5（结构化 missing）与上轮 W-6（诊断不足）在真实数据上的实证复发。模型拿到这句 sanitized 错误后无法采取任何修复动作，只能停止。

**建议方向（登记）：** 归档打不开应降级为 warning + `missing: ["credential:<归档名>"]`，其余数据集正常进入目录；worker 的 sanitize 应保留结构化 code（如 `ARCHIVE_CREDENTIAL_REQUIRED`）。

### E-4 [NOTE] 超时中断遗留的 staging 残留至今未回收

`RBQM_test/.clinical-listing/output/.rbqm-tmp-26041d78…/`（19:45 那次 30s 超时运行的残留，内含 37 个单域提取 xlsx）至今仍留在 output 目录下，未被后续运行清理或回收——上轮 F-7（发布路径回滚/清理）的实证。残留还会导致后续 glob 可见性混乱（模型在报告中把 37 个临时件误读为"产出不完整"的证据）。

### E-5 [NOTE] 部署拓扑风险：pnpm link 使"工作区=运行时"

`.dsh/profiles/clinical/package.json` 使用 `link:../../../dsh-clinical-data-guard`。开发即生产，任何保存即时影响正在运行的会话；配合 E-1 的重启缺失，"代码漂移"故障可稳定复现。建议至少文档化"改代码必重启"的运行手册，或在 start.ps1 中做 mtime 自检。

## 3. 正向确认

1. **今天 14:01 RBQM_test 已有 20 个 listing 工作簿 + MANIFEST 成功发布**（`output/rbqm/RBQM_001~020.xlsx`），证明执行链路在依赖齐全、无归档卡壳时可产出真实结果；
2. F-1/F-2/F-3/N-1 四项上轮问题的修复质量良好（含防御性注释与配置校验），test 基线中新增 plan 合同测试 658 行；
3. worker 隔离测试：协议层 ping/pong 正常，sanitize 行为符合 fail-closed 设计（只是诊断性因此受损，见 E-3）。

## 4. 未覆盖（被上述缺陷阻断）

- **完整的"新工具链 inspect → validate → execute → 新发布产物"在生产 UI 路径上尚未跑通一轮**：E-1（旧进程）与 E-2（解释器/EBADF）先后阻断了两次尝试；worker 隔离层又被 E-3（归档硬失败）阻断。
- 建议修复 E-1~E-3 后（或：从正常控制台重启服务器 + 提供 ZIP 凭据/移除根目录加密 ZIP），按本报告 §2 的操作序列重放 e2e，即可在 30 分钟内拿到完整证据。

## 5. 结论

| 维度 | 结论 |
|---|---|
| 上轮 BLOCK 修复 | **通过**（F-1/F-2/F-3 代码级核验合格） |
| 本轮 E2E | **未通过**——发现 3 个新 BLOCK（E-1 部署漂移 + 异常掩盖、E-2 解释器不确定 + 无依赖自检、E-3 归档硬失败无诊断），均已在真实环境复现并定位到行号 |
| 总体裁决 | **NOT READY**。三个新 BLOCK 均为"真实用户一用就撞"级别；修复量都不大（异常处理顺序、解释器钉死+预检、归档降级+结构化 missing），但必须先修再谈完成 |

## 附录：本轮 E2E 操作时间线

| 时间 | 事件 |
|---|---|
| 21:43 | 3080 在线探测 OK；枚举 8 个项目 |
| 21:50 | 会话 1：调旧工具 `clinical_listing_workflow` → UnboundLocalError（E-1） |
| 21:54 | 查实服务器 17:45 启动、代码 20:29-21:11 改动未重启 |
| 21:55 | stop.bat → start.bat 重启（PID 18448） |
| 21:58 | 会话 2 第 1 轮：`[Errno 9] Bad file descriptor`（E-2） |
| 21:59 | 重试第 2 轮：同样 EBADF |
| 22:05 | 查实双 python worker（venv OK / codex 缺 pyreadstat） |
| 22:0x | worker 隔离复现：ping OK；inspect → LISTING_WORKFLOW_ERROR（E-3），直调拿到完整异常链 |
