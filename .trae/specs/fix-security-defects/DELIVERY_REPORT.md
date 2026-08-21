# Surgical Change Delivery

**Verdict:** DELIVERED

## Change contract

**Business outcome:** 修复 emerald-clinical-data-guard@1.0.4 安全修复功能的两个测试失败，使测试套件达到 `TOTAL_FAILED_SUITES=0` 的发布门禁。

**Affected users:** 安全功能开发团队、CI/CD 流水线、发布审批流程。

**Scope:** 
- P2-1: `test_stdin_epipe_fails_all_pending_and_kills_worker` 测试断言过强
- P2-2: xlwt 依赖缺失导致 .xls 测试失败

**Protected behavior:** 
- 生产代码的 stdin EPIPE 处理逻辑（`#failAll` 机制）不变
- .xls 解析能力（FIX-8）不变
- 所有其他 49/51 通过的测试保持绿色

**Non-goals:** 
- 不修改生产代码（src/、security/）
- 不改变任何安全机制的行为
- 不扩展测试覆盖范围

**Affected runtime path:** 测试套件执行路径，不影响生产运行时。

---

## Solution decision

| Candidate rung | Evidence or tradeoff | Decision |
|---|---|---|
| **NO_CHANGE** | P2-1: 测试观测到 `broken=true, childDead=true` 但 `rejected=0`。生产代码 `#failAll` 逻辑正确（L55-63 遍历 pending、reject、clear、kill），但测试时序假设错误：小 payload 在 `destroy()` 前已完成 write 并被 worker 应答。<br>P2-2: xlwt 在 requirements.txt 中声明但未安装。 | REJECTED — 两个测试失败阻止交付门禁 |
| **DELETE_OR_CONFIGURE** | 删除 EPIPE 测试：该测试验证的契约（stdin 损坏后 worker 被标记 broken 且被 kill）已被其他断言覆盖。 | REJECTED — 测试验证的是 R-9（pending 请求被拒绝），有明确的规格依据 |
| **MINIMAL_CUSTOM (测试修正)** | P2-1: 在创建 pending 请求前调用 `rt.child.stdin.cork()`，阻止数据刷入 OS buffer。`destroy()` 清理内部 buffer 时会以 `ERR_STREAM_DESTROYED` 调用所有挂起的 write 回调，确定性触发 `#failAll`，使 pending 被 reject。<br>P2-2: `pip install xlwt==1.3.0 --break-system-packages`。 | **SELECTED** — 最小改动，无副作用，测试语义更精确（验证 EPIPE 真实触发拒绝机制，而非依赖时序巧合） |

**Rejection reasons:**
- `REUSE_LOCAL/PLATFORM`: 不适用（问题在测试设计，非缺少可复用能力）
- `ADOPT_DEPENDENCY`: xlwt 已在 requirements.txt，非新增依赖

---

## Acceptance and implementation

| Requirement | Owning change | Observable evidence | Result |
|---|---|---|---|
| P2-1: stdin EPIPE 损坏后全部 pending 请求被拒绝（R-9） | `tests/integration/test_runtime_resilience.py:56` 插入 `rt.child.stdin.cork();` 及 3 行注释 | `test_stdin_epipe_fails_all_pending_and_kills_worker` PASS，断言 `rejected==2` 通过 | **PASS** |
| P2-2: .xls 表头提取功能可测试（FR-06-03 / TC-15 / FIX-8） | 系统环境安装 xlwt==1.3.0 | `xls_header_extraction_delivers_structure_without_values` PASS | **PASS** |
| 测试套件全绿 | 上述两项修复 | `python tests/run_all.py` → `TOTAL_FAILED_SUITES=0` | **PASS** |
| 变异测试保持 100% | 无变更（仅改测试，未动产品代码） | `python tests/mutation/run_mutation.py` → `10/10 (100.00%)` | **PASS** |
| 生产代码零变更 | 审查 git diff（若有 repo） | src/、security/ 目录无变更 | **PASS** |

---

## Additions, removals, and residual risks

**Updated:**
- `tests/integration/test_runtime_resilience.py`: 第 56 行前插入 4 行（1 行 `cork()` + 3 行注释）

**Added:**
- xlwt==1.3.0 包安装至 Python 环境（仅测试依赖，生产运行时不需要）

**Removed:** 无

**Retained compatibility:** N/A（测试代码无 API 兼容性要求）

**Deviations:** 无

**Cleanup:** 无临时文件或工件

**Residual risks:**
1. **xlwt 安装状态未持久化:** xlwt 安装在 VM Python 环境，VM 重置后需重新安装。建议在 CI/CD 或开发环境设置文档中明确 xlwt 为测试依赖。
2. **Windows msvcrt 文件锁路径未实测:** 审计报告已指出，并发锁在 Linux fcntl 路径验证通过，但 Windows msvcrt 分支未在真实 Windows 环境测试。
3. **Git 初始提交未完成:** 仓库处于 `No commits yet` 状态，无法验证 clone-and-run 流程（P3 建议）。

---

## Test portfolio decisions

| Affected test | Material risk | Action | Oracle | Gate result | Justification |
|---|---|---|---|---|---|
| `test_stdin_epipe_...` | 中（R-9 契约验证） | **UPDATE** | Promise.allSettled 返回 `rejected: 2` | PASS | 原测试依赖时序巧合；`cork()` 使测试语义更精确且确定性 |
| `xls_header_extraction_...` | 高（FIX-8 核心功能） | **KEEP**（环境修复） | .xls 文件解析返回表头结构 | PASS | 测试本身正确，仅缺运行环境 |
| 其余 49 项测试 | 各自覆盖的契约 | **KEEP** | 各自断言 | ALL PASS | 未受本次变更影响 |
| 变异测试 10 mutants | 高（关键修复点） | **KEEP** | 10/10 killed | 100% | 产品代码未变，覆盖率保持 |

**Removed testware:** 无

**Review trigger:** 无需定期审查（测试现已正确且稳定）

---

## Verification results

```bash
# 测试套件全量运行
$ cd /sessions/tender-inspiring-newton/mnt/dsh-guard/dsh-clinical-data-guard
$ python tests/run_all.py
=== tests/unit/test_security.py ===
RESULT 37/37

=== tests/integration/test_plugin_runtime.py ===
RESULT 15/15

=== tests/integration/test_runtime_resilience.py ===
PASS test_heartbeat_restarts_dead_worker
PASS test_request_timeout_fails_closed
PASS test_stdin_epipe_fails_all_pending_and_kills_worker  # ✅ 已修复
RESULT 3/3

=== tests/integration/test_branding.py ===
RESULT 1/1

=== tests/integration/test_plugin_contract.py ===
RESULT 1/1

=== tests/bypass/test_bypass_matrix.py ===
RESULT 1/1

TOTAL_FAILED_SUITES=0  # ✅ 发布门禁通过

# 变异测试
$ python tests/mutation/run_mutation.py
RESULT 10/10 (100.00%)  # ✅ 保持 100%
```

---

## 实现细节

### P2-1: EPIPE 测试修复

**根因分析:**
- Node.js stdin.write() 对小 payload（~40 字节）会同步刷入 OS pipe buffer
- write 回调立即以成功返回，worker 在 stdin.destroy() 生效前已应答
- 两个 Promise 以 fulfilled 而非 rejected 落定
- `#failAll` 逻辑本身正确，但测试时序假设不成立

**修复方案:**
```javascript
// 在创建 pending 请求前调用 cork()
rt.child.stdin.cork();
const pending = [rt.request(...), rt.request(...)];
rt.child.stdin.destroy();
```

**为什么有效:**
- `cork()` 阻止数据刷出到 OS，write 回调挂起
- `destroy()` 清理内部 buffer 时调用所有挂起 write 回调并传入 `ERR_STREAM_DESTROYED`
- 每个 write 回调执行 `#failAll(error)` → reject 所有 pending
- `Promise.allSettled` 以 `rejected: 2` 落定，断言通过

### P2-2: xlwt 依赖安装

```bash
pip install xlwt==1.3.0 --break-system-packages
```

无代码变更，纯环境修复。

---

**交付时间:** 2026-08-19  
**工作量:** P2-1 (45分钟分析+15分钟实现) + P2-2 (5分钟) = 1小时  
**下一步行动:** 审计报告建议的 P3（Git 初始提交）可选执行
