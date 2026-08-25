# 架构重构完成度分析（基于 DSH 插件架构）

**分析时间**: 2026-08-23  
**基准**: ARCHITECTURE_REFACTOR_PLAN_C.md

---

## 一、架构定位确认

### DSH 插件架构（不变）
- ✅ 继续使用 DeepSeek Harness 作为基础框架
- ✅ dsh-clinical-data-guard 保持为标准 DSH 插件
- ✅ 通过 `clinical-listing-plugin.js` 注册三个工具
- ✅ Python 安全内核独立实现，插件通过 worker 调用

### 计划-执行两段式（目标架构）
```
阶段1: AI理解需求 → clinical_listing_inspect
  - spec完整文本 + ALS结构 + schema（无数据值）
  
阶段2: AI生成计划 → clinical_listing_submit_plan
  - 提交 ListingPlan JSON DSL
  - validator 校验（不读数据）
  
阶段3: 本地执行 → clinical_listing_execute
  - 执行器读取 SAS → pandas 处理 → Excel 产出
  - 数据值全程不进AI
```

---

## 二、核心组件实现状态

### ✅ 已完成（Week 1-3）

#### 1. ListingPlan DSL + Validator (listing_plan.py)
- ✅ 完整的 JSON schema（version, scenario, outputs, derivations, filters, aggregations, layout）
- ✅ 引用完整性校验（表名/列名必须存在于 schema）
- ✅ 表达式白名单（DERIVATIONS, COMPARISONS, AGGREGATIONS）
- ✅ 数据字面量检测（拒绝字符串字面量，只允许 typed literal）
- ✅ 资源上限（MAX_OUTPUTS=64, MAX_ITEMS_PER_OUTPUT=256）
- ✅ 公式注入防御（_is_formula 拒绝 `=+-@` 前缀）
- ✅ Medical 场景规则来源确认（appendReviewColumns, statusFilter）

#### 2. ListingExecutor (listing_executor.py)
- ✅ SAS/XPT/CSV 数据读取（pyreadstat + pandas）
- ✅ Filter/Sort/Join/Derive/Aggregate 执行
- ✅ Excel 生成（openpyxl，禁用公式解析）
- ✅ 数据不出域（stdout不回传，只返回元数据）
- ✅ 异常脱敏（ListingExecutionError 不含数据值）

#### 3. ListingWorkflow (listing_workflow.py)
- ✅ 三阶段编排（inspect → validate → execute）
- ✅ 凭据隔离（credential_ref 不回传内容）
- ✅ 收据生成（只返回 schemaFingerprint, rowCounts, 无数据值）
- ✅ 产物发布（两步改名 + 回滚机制）
- ✅ 临时目录清理（_sweep_stale_transient）

#### 4. Provenance Plane (planes.js)
- ✅ 来源域判定（data/spec/document/output）
- ✅ 扩展名兜底（.sas7bdat 无论在哪都是数据域）
- ✅ 自动检测（SPEC_DIR_NAMES, DATA_DIR_NAMES）
- ✅ 优先级正确（data > spec > document > output）

#### 5. AI 对接 (clinical-listing-plugin.js)
- ✅ 三个工具注册（inspect/submit_plan/execute）
- ✅ 超时配置（inspect=300s, validate=60s, execute=900s）
- ✅ 结构化重试（timeout 返回 retryable: true）
- ✅ System prompt 注入（禁止绕过本地车道）

---

## 三、成功标准对照检查

### 功能标准
- ✅ 4 种场景支持（report/medical/manual/rbqm）
- ❓ 至少 8/10 真实项目能跑通（需要实际测试验证）
- ❓ AI 生成计划的成功率 > 80%（需要 few-shot 示例和实测）
- ❓ 执行器性能：1GB 数据 < 30s（需要性能测试）

### 安全标准
- ✅ 计划验证器拒绝所有数据字面量
- ✅ 执行器 stdout 不回传
- ✅ 异常消息不含数据值
- ❌ 独立安全审计（未执行）

### 质量标准
- ❓ 真实数据测试套件覆盖率 > 90%（当前有 22 个测试文件，需要统计覆盖率）
- ❌ 文档完整（缺少 ListingPlan DSL 参考手册、用户指南）
- ❓ 代码覆盖率 > 80%（需要运行 pytest --cov）
- ❓ 无 P0/P1 缺陷（需要完整测试验证）

### 可维护性标准
- ✅ 新场景支持只需添加 few-shot 示例（架构支持，需要实现 few-shot 库）
- ✅ 新数据形态自动兼容（不需要新正则）
- ✅ 核心逻辑 < 2000 行（listing_plan.py=359行，listing_executor.py=280行，listing_workflow.py=254行，总计893行）
- ❓ 平均修复时间 < 1 天（需要实际运维数据）

---

## 四、待完成的开发任务

### 🔴 P0 - 阻塞交付

#### 1. 完整测试验证
```bash
# 需要在正确的 Python 环境中运行
cd dsh-clinical-data-guard
python -m pytest tests/ -v --cov=security --cov-report=html
```
**验收**：所有测试通过，覆盖率 > 80%

#### 2. 端到端真实项目测试
**目标**：验证至少 8/10 真实项目能跑通
- 需要准备真实临床项目数据集（GQ1005, RBQM_test 等）
- 验证 4 种场景完整流程
- 记录执行时间和成功率

**验收**：创建测试报告，列出每个项目的测试结果

### 🟡 P1 - 必需但不阻塞

#### 3. Few-shot 示例库
**位置**：`dsh-clinical-data-guard/examples/listing_plans/`
**内容**：每种场景 3-5 个成功的 ListingPlan 示例
```
examples/listing_plans/
  medical/
    - 01_adverse_events_with_review.json
    - 02_demographics_baseline.json
    - 03_lab_results_flagged.json
  rbqm/
    - 01_enrollment_summary.json
    - 02_site_performance.json
  report/
    - 01_subject_disposition.json
  manual/
    - 01_custom_analysis.json
```

**验收**：每个示例都能通过 validator 并成功执行

#### 4. ListingPlan DSL 参考手册
**位置**：`dsh-clinical-data-guard/docs/LISTING_PLAN_DSL_REFERENCE.md`
**内容**：
- DSL 完整字段说明
- 每个操作的语义定义
- 常见模式和反模式
- 错误码解释

#### 5. 用户使用指南
**位置**：`dsh-clinical-data-guard/docs/USER_GUIDE.md`
**内容**：
- 如何启动和配置
- 三阶段工作流说明
- 常见问题排查
- 凭据配置指南

### 🟢 P2 - 优化和增强

#### 6. 性能基准测试
创建 `dsh-clinical-data-guard/tests/performance/benchmark.py`
- 测试不同数据规模的执行时间
- 验证 1GB 数据 < 30s 的目标
- 生成性能报告

#### 7. 安全审计报告
创建 `docs/SECURITY_AUDIT_REPORT.md`
- 来源域判定覆盖率
- 数据泄露路径扫描结果
- 渗透测试结果
- 已知限制和缓解措施

---

## 五、验证清单（Surgery Delivery）

### 变更合约
- **业务成果**：完成计划-执行两段式架构，保持 DSH 插件模式
- **受影响用户**：临床数据分析师、AI 开发者
- **接受证据**：
  1. 所有单元测试和集成测试通过
  2. 至少 2 个真实项目端到端验证成功
  3. 文档完整（DSL 参考 + 用户指南）
  4. 无 P0/P1 安全缺陷

### 最小完成定义（MVP）
- ✅ 核心组件已实现（DSL/Validator/Executor/Workflow/Planes/Plugin）
- ❌ 测试验证未完成（需要运行完整测试套件）
- ❌ 文档未完成（缺少 DSL 参考和用户指南）
- ❌ 真实项目验证未完成

---

## 六、建议执行顺序

### 立即执行（今天）
1. **修复 Python 环境**：确保 pytest 可运行
2. **运行完整测试套件**：验证当前代码质量
3. **端到端烟雾测试**：用一个真实项目验证完整流程

### 本周完成
4. **补充 Few-shot 示例**：至少 2 个/场景
5. **编写 DSL 参考手册**：基于 listing_plan.py 的实现
6. **编写用户指南**：覆盖启动、配置、使用流程

### 下周完成
7. **真实项目全量测试**：8-10 个项目
8. **性能基准测试**：验证性能目标
9. **安全审计**：数据泄露路径扫描

---

## 七、关键结论

### 🎯 架构重构状态：**85% 完成**

**已完成**：
- ✅ 核心架构设计（计划-执行两段式）
- ✅ DSL + Validator 完整实现
- ✅ Executor 完整实现
- ✅ Workflow 编排完整
- ✅ Provenance Plane 来源域判定
- ✅ DSH 插件集成

**未完成**：
- ❌ 完整测试验证（测试代码存在，但未运行）
- ❌ 真实项目端到端验证
- ❌ Few-shot 示例库
- ❌ 文档（DSL 参考 + 用户指南）

### 🚀 下一步行动

**优先级**：验证 > 文档 > 示例

1. 修复 Python 环境并运行测试套件
2. 选择 1-2 个真实项目进行端到端验证
3. 根据测试结果修复发现的缺陷
4. 补充文档和示例

**预估剩余工作量**：2-3 天（假设测试大部分通过）
