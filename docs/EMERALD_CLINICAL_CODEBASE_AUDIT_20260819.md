# Emerald Clinical 代码库审计报告

**审计日期**: 2026-08-19  
**审计范围**: Emerald Clinical Data Guard 完整代码库  
**审计方法**: 静态代码分析 + 需求规格对标 + 数据红线安全审查  
**审计标准**: 代码库审计技能 (codebase-auditor) + 临床数据合规红线

---

## 综合判定

**Verdict:** CONCERNS

系统在安全边界、数据红线实现和测试覆盖方面整体可靠，但存在 3 个 P1 关键缺陷和 7 个 P2 优化点需要修复。主要风险集中在工具结果过滤逻辑的不完整性（P1-1）和审计数据完整性风险（P1-2、P1-3）。

---

## 审计范围与基线

### 代码库结构

**主要技术栈**:
- 运行时: Node.js 24+, Python 3.10+
- 框架: DeepSeek Harness (DSH) 0.1.0-rc.6 + Cordis 插件系统
- 部署模式: 本地工作台，项目内隔离环境
- 代码规模: 32 个源文件 (Python + JavaScript)

**架构分层**:
```
插件入口 (src/index.js)
  ├─ Layer 0: AI 操作监控 (security/ai_operations_monitor.py)
  ├─ Layer 1: 工具结果防护 (src/tool-result-guard.js + security/data_egress_guard.py)
  ├─ Layer 2: 出域检查点 (security/egress_checkpoint.py)
  └─ 审计层 (security/audit_log.py + security/egress_authz.py)
```

**核心组件**:
1. 插件入口与 Worker 协议: `src/index.js`, `security/worker.py`
2. 安全内核: 7 个 Python 模块，约 1500 行
3. 前端层: 4 个 JS 模块，约 460 行
4. 测试: 单元/集成/绕过测试，约 800 行

**验证基线** (实际运行受限):
- Python 环境: 系统 Python 3.10.12 可用，但项目 `.venv` 未在审计环境中构建
- 测试套件: 无法完整执行，依赖 openpyxl 和项目环境
- 契约验证: 通过静态代码检查确认 DSH 扩展点接线

**排除范围**:
- `.cache/`, `.venv/`, `node_modules/`: 依赖缓存
- `.pnpm-store/`, `.dsh/storages/`: 运行时数据
- `var/`: 审计归档（不包含敏感数据的验证通过静态检查）

---

## 健康状况摘要

| 领域 | 状态 | 证据 |
|---|---|---|
| 安全与交付边界 | **CONCERNS** | 3 个 P1 缺陷：工具过滤不完整、审计竞态、错误信息泄露 |
| 可维护性 | PASS | 模块职责清晰，无明显重复，命名规范 |
| 依赖与死代码 | PASS | peer dependencies 正确声明，无明显死代码 |
| 可诊断性、并发与生命周期 | **CONCERNS** | 审计并发安全性不足（P1-2），worker 清理正确 |
| 数据红线合规 | **CONCERNS** | 核心逻辑正确但有绕过风险（P1-1），需补齐测试 |

---

## 关键发现

### P0: 无

### P1: 关键缺陷 (3 个)

#### P1-1: 工具结果过滤仅检查工具名包含 'read'，存在数据泄露风险

**位置**: `src/tool-result-guard.js:67-71`

**问题描述**:
```javascript
export function shouldReplaceResult(exec) {
  if (!exec?.name?.toLowerCase().includes('read')) return false;
  const ext = extname(extractPath(exec.arguments ?? {})).toLowerCase();
  return !ext || ['.xlsx', '.xls', '.csv', '.zip', '.sas7bdat'].includes(ext);
}
```

该函数只对工具名包含 'read' 的工具进行结果过滤。但根据需求 FR-07-02 和红线 R-8，**所有无路径工具结果必须脱敏，不得按工具名白名单跳过**。

**证据**:
1. 需求 EMERALD_CLINICAL_SYSTEM_DETAILED_REQUIREMENTS_20260819.md FR-07-02: "适用所有工具名，不限于 read-like 命名"
2. 主规格 docs/EMERALD_CLINICAL_MASTER_SPEC.md 数据处置表: "无路径工具结果：强制 Python 脱敏，不能按 FULLPASS 放行"
3. 当前实现: 只有工具名包含 'read' 才进入 `shouldReplaceResult` 判断

**攻击场景**:
- 工具名为 `exec_bash`、`run_command`、`evaluate_python` 等不包含 'read' 的工具
- 这些工具返回包含临床数据的结果（如 `cat data.csv` 的输出）
- 因工具名不包含 'read'，`shouldReplaceResult` 返回 false
- 结果直接进入模型上下文，绕过所有过滤

**为何当前妥协不可接受**:
1. 这是数据红线 R-2 的直接绕过路径
2. 测试用例 BY-13 明确覆盖此场景："非 read 工具名 + 无路径结果必须被替换"
3. 需求文档多处强调"所有工具""不得按工具名豁免"

**必需修复方案**:
```javascript
export function shouldReplaceResult(exec) {
  const path = extractPath(exec.arguments ?? {});
  const ext = extname(path).toLowerCase();
  
  // 有路径且扩展名在危险列表中
  if (path && ['.xlsx', '.xls', '.csv', '.zip', '.sas7bdat'].includes(ext)) {
    return true;
  }
  
  // 无路径或路径提取失败 → 强制进入脱敏（红线 R-8）
  if (!path) {
    return true;
  }
  
  return false;
}
```

**影响**: 高 - 直接违反数据红线，允许临床数据通过非 read 工具泄露  
**预估工作量**: 2 小时（修改逻辑 + 补充测试用例）  
**参考**: [OWASP Input Validation](https://owasp.org/www-project-proactive-controls/v3/en/c5-validate-inputs)

---

#### P1-2: 审计日志写入存在竞态条件，可能丢失记录

**位置**: `security/audit_log.py:22-41`

**问题描述**:
```python
def write_audit_record(...):
    os.makedirs(directory, mode=0o700, exist_ok=True)
    current = os.path.join(directory, f"{prefix}_{datetime.now().strftime('%Y%m')}.jsonl")
    
    if os.path.exists(current) and os.path.getsize(current) >= max_bytes:
        stamp = datetime.now().strftime("%Y%m%d%H%M%S")
        rotated = f"{current}.{stamp}-{uuid.uuid4().hex[:8]}.rotated"
        os.replace(current, rotated)  # 竞态窗口：多进程同时轮转
        os.chmod(rotated, 0o600)
    
    # ... 删除旧归档 ...
    
    with open(current, "a", encoding="utf-8") as handle:
        handle.write(...)  # 竞态窗口：多进程同时追加
    os.chmod(current, 0o600)
```

**并发失败场景**:
1. **轮转竞态**: 进程 A 和 B 同时检测到文件超限
   - 两者都调用 `os.replace(current, rotated_A)` 和 `os.replace(current, rotated_B)`
   - rotated_B 覆盖 rotated_A，导致部分记录永久丢失
   
2. **追加竞态**: 无文件锁保护
   - 虽然 POSIX 保证单次 write 原子性，但 JSON 编码 + 换行符是分两步
   - 极端情况下可能产生截断的 JSON 行
   
3. **混合竞态**: 进程 A 正在追加，进程 B 触发轮转
   - A 的写入可能丢失或写入到已被重命名的文件

**证据**:
1. 需求 NFR-6: "审计自动轮转且有磁盘上限"
2. 需求 BR-06: "并发写入不丢记录"
3. 需求 TC-34: "并发验收：worker、审计、轮转并发"
4. 当前实现: 无文件锁、无轮转锁、无原子性保证

**为何当前妥协不可接受**:
1. 审计记录是法规遵从的关键证据，丢失不可接受
2. 多 agent / workflow 场景下，并发写入是常态
3. 红线 R-6 要求"完整留痕"，竞态导致的记录丢失违反此红线

**必需修复方案**:
```python
import fcntl  # Unix 文件锁

ROTATION_LOCK = os.path.join(directory, ".rotation.lock")

def write_audit_record(...):
    os.makedirs(directory, mode=0o700, exist_ok=True)
    lock_file = open(ROTATION_LOCK, "w")
    
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)  # 排他锁
        
        current = os.path.join(directory, f"{prefix}_{datetime.now().strftime('%Y%m')}.jsonl")
        
        # 在锁内检查轮转
        if os.path.exists(current) and os.path.getsize(current) >= max_bytes:
            stamp = datetime.now().strftime("%Y%m%d%H%M%S")
            rotated = f"{current}.{stamp}-{uuid.uuid4().hex[:8]}.rotated"
            os.replace(current, rotated)
            os.chmod(rotated, 0o600)
            
            archives = glob.glob(os.path.join(directory, f"{prefix}_*.jsonl.*.rotated"))
            archives.sort(key=os.path.getmtime, reverse=True)
            for stale in archives[max_archives:]:
                os.unlink(stale)
        
        # 在锁内追加
        with open(current, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        os.chmod(current, 0o600)
        
    finally:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        lock_file.close()
```

**Windows 兼容性**:
Windows 不支持 `fcntl`，需使用 `msvcrt.locking` 或文件重命名原子性技巧。

**影响**: 高 - 审计记录丢失违反法规遵从要求  
**预估工作量**: 4 小时（实现跨平台文件锁 + 并发测试）  
**参考**: [Python fcntl documentation](https://docs.python.org/3/library/fcntl.html)

---

#### P1-3: 错误消息可能泄露本地路径，违反红线 R-6

**位置**: `src/tool-result-guard.js:94`, `security/worker.py:112`, `security/egress_checkpoint.py`

**问题描述**:
多处错误处理直接将 Python 异常消息或文件路径传递给用户/审计：

```javascript
// src/tool-result-guard.js:94
detail: redactSensitiveText(error.message),  // error.message 可能包含完整路径
```

```python
# security/worker.py:112
except Exception as exc:
    return _result(False, code="SECURITY_UNAVAILABLE", reason=str(exc))
```

**泄露场景**:
1. Excel 提取器失败: `FileNotFoundError: [Errno 2] No such file or directory: '/path/to/patient_001_data.xlsx'`
2. Worker 导入失败: `ModuleNotFoundError: No module named 'openpyxl' in /home/user/clinical-project/...`
3. 权限错误: `PermissionError: [Errno 13] Permission denied: '/data/sensitive/dm.sas7bdat'`

所有这些错误消息会：
- 通过 `reason` 字段返回给用户界面
- 写入审计日志（虽然审计日志本身受权限保护，但红线要求"不得包含未脱敏路径"）

**证据**:
1. 红线 R-6: "日志、审计、错误回执不得包含临床数据值、凭据或原始身份"
2. 需求 BR-06: "错误 detail 必须先脱敏且不得泄露本地路径或临床值"
3. 当前实现: 多处直接 `str(exc)` 或 `error.message`

**为何当前妥协不可接受**:
1. 文件路径可能包含患者标识（如 `patient_101-001234.xlsx`）
2. 路径暴露项目结构，可能被用于进一步攻击
3. 明确违反红线 R-6

**必需修复方案**:
```python
# security/worker.py
import re

def sanitize_error(exc: Exception) -> str:
    """从异常消息中移除路径和敏感信息"""
    message = str(exc)
    # 移除绝对路径
    message = re.sub(r'[A-Z]:\\[^:\n]+', '[PATH]', message)  # Windows
    message = re.sub(r'/[^:\s]+', '[PATH]', message)  # Unix
    # 移除可能的临床数据模式
    message = re.sub(r'\b\d{3,4}-\d{3,6}\b', '[SUBJ]', message)
    message = re.sub(r'\b[A-Z]\d{6,8}\b', '[SUBJ]', message)
    return message[:200]  # 限制长度

# 应用到所有异常处理
except Exception as exc:
    return _result(False, code="SECURITY_UNAVAILABLE", reason=sanitize_error(exc))
```

```javascript
// src/tool-result-guard.js
function sanitizeErrorMessage(message) {
  return message
    .replace(/[A-Z]:\\[^\s:]+/g, '[PATH]')
    .replace(/\/[^\s:]+/g, '[PATH]')
    .replace(/\b\d{3,4}-\d{3,6}\b/g, '[SUBJ]')
    .substring(0, 200);
}

// 使用
detail: sanitizeErrorMessage(error.message),
```

**影响**: 高 - 违反数据红线，可能泄露敏感信息  
**预估工作量**: 3 小时（统一错误清理函数 + 全局应用 + 测试）  
**参考**: [OWASP Error Handling](https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html)

---


### P2: 重要优化 (7 个)

#### P2-1: Worker 进程缺少心跳检测，僵死进程无法及时发现

**位置**: `src/index.js:8-37`

**问题**: Worker 进程启动后没有心跳机制。如果 worker 进入死循环或被系统挂起，Node 端无法检测，导致所有安全检查超时 fail-closed，阻塞正常工作流。

**建议**: 
- Worker 启动时发送 `{type: "ready"}` 消息
- Node 端定期（每 30 秒）发送 `{operation: "ping"}` 请求，预期 5 秒内收到 pong
- 3 次 ping 失败后，重启 worker 并标记为 degraded 状态

**影响**: 中 - 可用性问题，但有 fail-closed 保护  
**工作量**: 3 小时

---

#### P2-2: Excel 提取器超时硬编码 10 秒，大文件可能误判

**位置**: `src/tool-result-guard.js:36`

**问题**: 对于包含大量合并单元格或多 sheet 的 Excel，10 秒可能不足，导致正常文件被误判为 `CHECK_FAILED`。

**建议**: 将超时改为可配置参数 `excelTimeoutMs`（默认 10000，最大 30000），超时后使用 SIGTERM → 等待 2 秒 → SIGKILL 的优雅关闭流程。

**影响**: 中 - 误拦正常大文件  
**工作量**: 1 小时

---

#### P2-3: DLP 模式库更新需要手动同步，容易出错

**位置**: `security/patterns.py`, `src/patterns.js`, `scripts/sync_patterns.py`

**问题**: Python 和 JavaScript 使用两套独立的模式定义。虽然有同步脚本，但需要手动运行，容易忘记。

**建议**: 在 CI 中验证 `node_patterns.json` 与 `patterns.py` 的一致性，或让 Node 端直接调用 Python 端模式匹配。

**影响**: 中 - 维护风险  
**工作量**: 2 小时

---

#### P2-4: Worker stdin 写入失败仅 reject 当前请求，进程可能已损坏

**位置**: `src/index.js:68-73`

**问题**: 如果 stdin 管道损坏（EPIPE），仅拒绝单个请求不足够。后续请求仍会尝试写入损坏的管道。

**建议**: stdin 写入失败时，标记 worker 为损坏状态，kill 进程，拒绝所有待处理请求。

**影响**: 中 - 边缘错误处理不健壮  
**工作量**: 1 小时

---

#### P2-5: 授权记录使用 SHA-256 哈希用户/会话，无法关联审计

**位置**: `security/egress_authz.py`

**问题**: 授权文件保存 `sha256(user)` 和 `sha256(session)`，但审计文件可能使用不同的哈希上下文，导致事后无法关联。

**建议**: 使用 HMAC-SHA256 并统一 salt，或在授权记录中同时保存 `audit_context_hash`。

**影响**: 中 - 审计可追溯性降低  
**工作量**: 2 小时

---

#### P2-6: 品牌替换使用 MutationObserver 可能影响性能

**位置**: `src/branding.js:40-47`

**问题**: 监听整个 DOM 树的字符变化，在大型 SPA 中可能触发大量回调。

**建议**: 添加防抖（debounce）至少 100ms，或使用更精确的 CSS 选择器。

**影响**: 中 - 性能问题，但影响范围有限  
**工作量**: 2 小时

---

#### P2-7: Base64 解码尝试所有 16+ 字符串，可能误解码

**位置**: `security/egress_checkpoint.py:109`

**问题**: 正则匹配过于宽泛，可能误将普通标识符解码为 base64，增加误报风险。

**建议**: 提高最小长度到 24 字符，或要求 token 以 `=` 结尾。

**影响**: 低 - 可能增加计算开销  
**工作量**: 1 小时

---

## 修复优先级与依赖关系

### 立即修复 (阻塞发布)
1. **P1-1**: 工具过滤逻辑 → 数据泄露风险最高
2. **P1-3**: 错误消息清理 → 违反红线 R-6

### 短期修复 (本周内)
3. **P1-2**: 审计并发锁 → 法规遵从要求
4. **P2-1**: Worker 心跳 → 可用性基础

### 中期优化 (两周内)
5. **P2-2, P2-3, P2-4**: 工程健壮性
6. **P2-5, P2-6**: 可追溯性和性能

---

## 数据红线合规性检查表

| 红线 | 状态 | 证据 |
|---|---|---|
| R-1: SAS 行内容不进入 LLM | ✅ PASS | `dataOnlyPlaceholder('SAS_DATA')` 正确实现 |
| R-2: Excel 数据区不进入 LLM | ⚠️ **CONCERNS** | 表头提取正确，但 P1-1 允许非 read 工具绕过 |
| R-3: 指令不能覆盖安全处置 | ✅ PASS | 所有检查在 worker 内部，用户无法干预 |
| R-4: 非核心 block 默认拒绝 | ✅ PASS | `ALLOWED_CONTENT_BLOCKS` 白名单正确 |
| R-5: 无后门开关 | ✅ PASS | disabled 模式需 approvalId + approvedBy |
| R-6: 审计不包含数据值 | ⚠️ **CONCERNS** | P1-3 错误消息可能泄露路径 |

**总体合规**: 6 项中 4 项 PASS，2 项 CONCERNS（由 P1-1 和 P1-3 导致）

---

## 结论与建议

### 关键优势
1. **架构正确**: 多层防御设计符合纵深防御原则
2. **红线意识强**: 代码中多处明确标注红线编号
3. **测试驱动**: BY-1~BY-13 绕过矩阵覆盖全面
4. **可审计**: 审计日志设计符合法规要求（除 P1-2 并发问题）

### 必须解决的风险
本次审计发现 **3 个 P1 关键缺陷**，全部与数据红线直接相关：

1. **P1-1** (工具过滤不完整): 立即修复，**阻塞所有生产部署**
2. **P1-2** (审计竞态): 在多 agent 部署前必须修复
3. **P1-3** (错误消息泄露): 违反红线 R-6，需立即修复

修复这 3 个缺陷后，系统可达到 **PASS with minor concerns** 状态。

### 发布建议
- **当前版本 (1.0.4)**: 🚫 不建议生产部署，存在数据泄露风险
- **修复 P1 后**: ✅ 可用于受控试点，需监控审计日志
- **修复 P1 + P2-1/2**: ✅ 可用于生产环境

---

**审计完成时间**: 2026-08-19  
**审计员**: Kiro AI (Claude Opus 5)  
**报告版本**: 1.0

