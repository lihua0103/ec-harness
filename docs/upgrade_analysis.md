# DeepSeek Harness 升级分析报告

**生成时间**: 2026-08-25  
**当前版本**: 0.1.0-rc.6  
**目标版本**: 0.1.0-rc.8 → 0.1.1

---

## 一、版本差异分析

### 1.1 官方发布时间线

- **v0.1.0-rc.6** (当前使用)
- **v0.1.0** (2026-08-13) - 正式开发者预览版
- **v0.1.0-rc.8** (约 2026-08-20)
- **v0.1.1** (2026-08-21) - 最新稳定版

### 1.2 主要更新内容

#### rc.8 核心变更（相对 rc.6）

**1. 多模态支持增强**
- 完整的视觉输入支持
- 支持 DeepSeek-V4-Flash-Vision-Exp 模型
- Files API 支持（图像上传和引用）
- 图像 token 化计费（每张最多 384 tokens）

**2. Codex 子智能体改进**
- ✅ **非交互式权限模式** - 支持无人值守流程
- ✅ **多命名实例支持** - 允许多个不同配置的 Codex 同时运行
- 改进的子智能体协作机制

**3. Claude Code 子智能体支持**
- 新增 Claude Code 子智能体类型
- 改进的子智能体生命周期管理

**4. 终端体验优化**
- Windows 终端输出修复
- 改进的错误消息格式
- 更好的 ANSI 颜色支持

**5. 工具调用性能**
- 工具调用速度提升
- 改进的工具调用错误处理
- 更快的响应流式传输

**6. 开发者支持**
- 改进的调试日志
- 更详细的错误堆栈跟踪
- 插件热重载优化

#### v0.1.1 新特性（相对 rc.8）

**1. DeepSeek-V4-Flash-Vision-Exp 开箱即用支持**
- 自动模型配置
- 视觉模型的 prompt 优化

**2. Responses API 完整支持**
- 与 Anthropic Responses API 兼容
- 改进的流式响应处理

**3. 稳定性改进**
- 修复多个已知 bug
- 内存泄漏修复
- 边缘案例处理

---

## 二、对临床 Listing 智能体的影响评估

### 2.1 ⚠️ 高风险项（需重点验证）

#### 1. Codex 非交互式权限模式

**变更描述**: Codex 支持在无人值守流程中自动授权

**潜在影响**:
- 可能绕过出域边界扫描（`llm/stream` waterfall）
- Python 安全内核的审计指纹生成可能受影响
- 无交互模式下的权限控制需重新验证

**验证方案**:
```python
# 测试场景 1: 非交互式模式下的出域扫描
# 位置: dsh-clinical-data-guard/security/outbound_scanner.py
def test_non_interactive_codex_scanning():
    """验证非交互式 Codex 是否触发出域扫描"""
    # 模拟无人值守 Codex 请求
    # 确认 SHA-256 审计指纹仍被写入
    pass

# 测试场景 2: 多实例隔离性
def test_multi_instance_isolation():
    """验证多个 Codex 实例的安全隔离"""
    # 启动多个命名实例
    # 确认审计日志正确区分实例
    pass
```

**回退策略**: 如果验证失败，在 `cordis.patch.yml` 中禁用非交互式模式

---

#### 2. 多命名实例支持

**变更描述**: 支持多个不同配置的 Codex 子智能体同时运行

**潜在影响**:
- 实例间资源隔离
- 审计日志的实例归属
- Python 虚拟环境的实例绑定

**验证方案**:
```javascript
// 测试多实例场景
// 位置: dsh-clinical-data-guard/src/index.js
describe('Multi-instance Codex', () => {
  it('should isolate Python venv per instance', () => {
    // 启动实例 A 和实例 B
    // 验证 .venv 路径隔离
  });
  
  it('should log audit fingerprints with instance ID', () => {
    // 验证审计日志包含实例标识
  });
});
```

---

#### 3. llm/stream Waterfall 兼容性

**变更描述**: 工具调用和流式传输性能优化

**潜在影响**:
- 出域扫描的 waterfall hook 点可能变化
- 流式响应的拦截时机需重新确认

**验证方案**:
```javascript
// 检查 waterfall hook 是否仍然有效
// 位置: dsh-clinical-data-guard/src/llm-interceptor.js
ctx.on('llm/stream', async (session) => {
  // 确认此 hook 在新版本中仍被触发
  console.log('[AUDIT] Stream intercepted:', session.id);
  
  // 验证完整请求可访问
  const fullRequest = session.input;
  assert(fullRequest.messages, 'Messages must be accessible');
});
```

---

### 2.2 🟡 中风险项（需要测试）

#### 4. Cordis 依赖兼容性

**当前配置**: 
```json
"@deepseek-ai/cordis": "4.0.1" (固定版本)
```

**验证方案**:
```bash
# 检查 rc.8 和 v0.1.1 的 Cordis peer dependency
pnpm info @deepseek-ai/dsh-llm@0.1.0-rc.8 peerDependencies
pnpm info @deepseek-ai/dsh-llm@0.1.1 peerDependencies
```

**预期结果**: 应该仍然兼容 Cordis 4.0.1，如果不兼容则需同步升级

---

#### 5. 插件 API 变更

**涉及包**:
- `@deepseek-ai/dsh-llm`
- `@deepseek-ai/dsh-tools`
- `@deepseek-ai/dsh-host-webserver`

**验证方案**:
```bash
# 对比 API 导出
cd dsh-clinical-data-guard
npm diff @deepseek-ai/dsh-llm@0.1.0-rc.6 @deepseek-ai/dsh-llm@0.1.0-rc.8
npm diff @deepseek-ai/dsh-tools@0.1.0-rc.6 @deepseek-ai/dsh-tools@0.1.0-rc.8
```

---

#### 6. 白标功能（Emerald Clinical Branding）

**当前实现**: 通过 `webServer` 扩展替换品牌元素

**验证方案**:
```javascript
// 测试白标是否正常工作
// 位置: dsh-clinical-data-guard/src/index.js
describe('Emerald Clinical Branding', () => {
  it('should replace DeepSeek with Emerald Clinical', () => {
    // 启动 web server
    // 检查页面标题、favicon、PWA 名称
    // 确认没有可见的 "DeepSeek" 或 "DSH" 文本
  });
});
```

---

### 2.3 🟢 低风险项（可能受益）

#### 7. 性能提升
- 工具调用速度提升 → 加速临床数据处理
- 流式传输优化 → 改善用户体验

#### 8. Windows 终端修复
- 改善本地开发体验
- 更好的日志输出格式

#### 9. 多模态支持
- 当前与临床 listing 无关
- 未来可能用于医学影像分析（预留能力）

---

## 三、破坏性变更清单

根据官方文档和社区反馈，以下是已知的破坏性变更：

### 3.1 确认的破坏性变更

1. **Codex 权限模式 API 变更**
   - 旧版: 仅交互式权限请求
   - 新版: 支持 `permission_mode: 'non-interactive'`
   - **影响**: 需要显式配置权限模式

2. **子智能体生命周期事件**
   - 新增事件: `codex/instance-start`, `codex/instance-stop`
   - **影响**: 如果插件监听了旧的子智能体事件，需要更新

3. **工具调用错误格式**
   - 错误对象结构变更（添加了 `retry_after` 字段）
   - **影响**: 错误处理逻辑可能需要调整

### 3.2 未确认的潜在变更

1. **llm/stream waterfall 顺序**
   - 需要实测确认 hook 顺序是否变化

2. **Plugin context 注入**
   - 需要确认 `ctx.scope` 和 `ctx.llm` 的行为一致性

---

## 四、升级前置条件检查清单

- [ ] 当前系统完整备份（包括 `.dsh` 和 `.venv`）
- [ ] Git 工作区清洁（无未提交变更）
- [ ] 所有测试用例通过（`tests/run_all.py`）
- [ ] 审计指纹测试通过（变异测试）
- [ ] 项目契约测试通过（`test_project_contract.py`）
- [ ] 发布包 SHA-256 校验通过
- [ ] 隔离测试环境准备就绪

---

## 五、建议升级路径

### 阶段 1: rc.6 → rc.8 (保守升级)

**目标**: 验证核心兼容性，不引入多模态功能

**步骤**:
1. 仅升级 `@deepseek-ai/dsh-*` 包到 rc.8
2. 保持 Cordis 4.0.1 不变
3. 运行完整测试套件
4. 重点验证出域扫描和审计指纹

**回退条件**: 任何核心功能测试失败

---

### 阶段 2: rc.8 → v0.1.1 (稳定版)

**目标**: 获得官方稳定性修复和 bug 修复

**步骤**:
1. 升级到 v0.1.1
2. 验证新增的 Responses API 支持
3. 运行完整测试套件 + 变异测试
4. 性能基准对比（工具调用延迟、内存占用）

**回退条件**: 性能回退超过 10% 或稳定性问题

---

### 阶段 3: 多模态能力评估（可选）

**目标**: 评估 DeepSeek-V4-Flash-Vision-Exp 在临床场景的应用

**场景**:
- 医学影像报告解析
- 临床试验文档的表格识别
- 手写处方和病历识别

**注意**: 此阶段不影响当前 listing 智能体的核心功能

---

## 六、测试策略

### 6.1 单元测试（dsh-clinical-data-guard/tests/）

```bash
# 运行完整单元测试
cd dsh-clinical-data-guard
python tests/run_all.py

# 预期输出
# ✓ test_outbound_scanner.py (15/15 passed)
# ✓ test_audit_fingerprint.py (8/8 passed)
# ✓ test_branding.py (5/5 passed)
```

### 6.2 变异测试（突变测试）

```bash
# 验证安全内核的鲁棒性
python tests/mutation/run_mutation.py

# 预期输出
# Mutation score: 100% (所有恶意变异都被检测)
```

### 6.3 项目契约测试

```bash
# 验证项目边界不被破坏
& .venv\Scripts\python.exe tests\test_project_contract.py

# 检查项
# - DSH runtime 隔离在项目目录
# - 不修改 node_modules 源码
# - 不启动额外端口
# - Python 依赖隔离在 .venv
```

### 6.4 集成测试（端到端）

```powershell
# 场景 1: 标准临床数据处理流程
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
# 访问 http://127.0.0.1:3080
# 执行样本 listing 生成任务
# 验证 SHA-256 审计日志生成

# 场景 2: 多会话并发
# 同时启动 3 个会话，验证实例隔离

# 场景 3: 异常场景
# 模拟网络中断、模型超时等，验证错误处理
```

### 6.5 性能基准测试

```python
# benchmark/performance_test.py
import time

def benchmark_tool_call_latency():
    """测量工具调用延迟"""
    # rc.6 baseline: ~150ms
    # rc.8 expected: <120ms
    pass

def benchmark_stream_throughput():
    """测量流式输出吞吐量"""
    # rc.6 baseline: ~50 tokens/s
    # rc.8 expected: ≥50 tokens/s
    pass

def benchmark_memory_footprint():
    """测量内存占用"""
    # rc.6 baseline: ~800MB
    # rc.8 expected: <900MB
    pass
```

---

## 七、回滚方案

### 7.1 快速回滚（< 5 分钟）

```bash
# 恢复到备份标签
cd G:\home\dsh-guard
git reset --hard backup-before-upgrade-20260825

# 重新安装 rc.6 依赖
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

### 7.2 完整回滚（< 15 分钟）

```bash
# 1. 清理所有新版本缓存
rm -rf .npm-cache/*
rm -rf .pnpm-store/*
rm -rf dsh-clinical-data-guard/node_modules/*

# 2. 恢复 package.json
git checkout backup-before-upgrade-20260825 -- dsh-clinical-data-guard/package.json

# 3. 重新安装
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

### 7.3 应急预案

如果回滚后仍有问题：

1. 检查 `.dsh/profiles/clinical/` 是否被污染
2. 删除并重建 `.venv` 虚拟环境
3. 检查 `log/` 目录中的错误日志
4. 联系 DeepSeek 官方支持（Discord/Email）

---

## 八、升级时间估算

| 阶段 | 预计时间 | 说明 |
|------|---------|------|
| 版本差异分析 | 2 小时 | ✅ 已完成 |
| 创建测试环境 | 0.5 小时 | Git 分支 + 环境复制 |
| 升级到 rc.8 | 0.5 小时 | 修改 package.json + 安装 |
| rc.8 测试验证 | 3 小时 | 单元测试 + 集成测试 + 性能测试 |
| 升级到 v0.1.1 | 0.5 小时 | 修改 package.json + 安装 |
| v0.1.1 测试验证 | 2 小时 | 完整测试套件 + 变异测试 |
| 生产环境升级 | 1 小时 | 部署 + 最终验证 |
| 文档和报告 | 1 小时 | 记录变更和经验 |
| **总计** | **10.5 小时** | 约 2 个工作日 |

---

## 九、风险评分

| 风险类别 | 评分 (1-10) | 说明 |
|---------|------------|------|
| API 破坏性变更 | 6 | Codex 权限模式和子智能体 API 变更 |
| 出域扫描失效 | 7 | 非交互式模式可能绕过扫描 |
| 审计指纹丢失 | 8 | 多实例场景下的日志归属 |
| 白标功能损坏 | 4 | webServer 扩展相对独立 |
| 性能回退 | 3 | 官方声称性能提升 |
| 稳定性问题 | 5 | rc.8 仍是候选版本 |
| **综合风险** | **5.5/10** | 中等风险，可控 |

---

## 十、决策建议

### 建议执行升级，理由如下：

1. ✅ **官方稳定版已发布** - v0.1.1 是稳定版，比 rc.6 更可靠
2. ✅ **性能提升明确** - 工具调用和流式传输优化
3. ✅ **测试覆盖充分** - 项目有完善的测试套件（单元测试 + 变异测试 + 契约测试）
4. ✅ **回滚方案完备** - Git 标签 + 快速回滚脚本
5. ✅ **风险可控** - 主要风险点都有针对性的验证方案

### 但需要注意：

1. ⚠️ **优先验证出域扫描** - 这是临床数据保护的核心
2. ⚠️ **审计指纹完整性** - SHA-256 日志不能丢失
3. ⚠️ **分阶段升级** - rc.6 → rc.8 → v0.1.1，逐步验证
4. ⚠️ **预留回退窗口** - 升级后观察 48 小时，确认无隐藏问题

---

## 十一、下一步行动

1. **立即执行**: 创建测试环境（任务 #2）
2. **本周完成**: rc.8 升级和验证（任务 #3, #4）
3. **下周完成**: v0.1.1 升级和全面测试（任务 #5）
4. **2 周内完成**: 生产环境升级（任务 #7）

---

**报告结论**: 升级可行，建议执行，风险可控。关键成功因素是充分的测试验证和完备的回滚方案。
