# dsh-guard 架构重构计划（方案 C）

**目标**: 彻底终结补丁竞赛，构建可维护的临床数据安全架构  
**周期**: 2-4 周  
**参考设计**: EMERALD_PROVENANCE_ARCHITECTURE_20260821.md

---

## 一、重构动机

### 当前架构的不可修复问题

1. **判据不可判定**：内容形态识别（"这串像不像数据"）在数学上不可判定
2. **职责倒挂**：AI 擅长的被禁止，程序做不了的硬塞给生成器
3. **补丁竞赛**：每个新场景都要加正则，永无止境
4. **四层拦截**：quickGuard → pre-execute → post-execute → llm/stream，口径漂移
5. **破坏性脱敏**：表头投影、连坐 token 化导致语义归零

### 新架构的核心思想

**从"认出数据形态"转向"数据根本到不了模型"**

- 判据从"这串像不像数据"变成"这字节来自哪"（可判定）
- 数据值全程在执行器域，AI 只处理结构 + 计划
- 本地处理能力完全放开（stdout 不回传）

---

## 二、新架构设计："计划-执行"两段式

```
阶段 1: AI 理解需求（完全放开 spec 可见性）
   输入: spec 完整文本 + ALS 完整结构（不含任何数据值）
         + 数据 schema（表名/列名/类型，不含样本值）
   输出: ListingPlan (JSON DSL)
   {
      datasets: [{name, source, columns, filters, sort}],
      derivedColumns: [{name, expression, refs}],
      layout: {freeze, toc, dropCodeValue, flagColumns...},
      validation: {assertNotNull, assertUnique, assertRange...}
   }
   
阶段 2: 本地确定性执行器（完全隔离在 worker 内）
   输入: ListingPlan + data/*.sas7bdat
   验证: 
     - JSON schema 校验
     - 只允许引用 schema 中存在的表/列
     - 计划中不得包含任何数据字面量（死命令的结构性保证）
     - 表达式 AST 白名单（只允许安全操作）
   执行: pyreadstat 读取 → pandas 处理 → openpyxl 写入
   输出: listing.xlsx（数据值全程不进 AI）
   
阶段 3: 收据返回（仅元数据）
   返回: {
      status: "completed",
      artifact: {name, sheets, rowCounts},
      validation: {passedChecks, warnings},
      executionTime: "12.3s"
   }
```

---

## 三、核心组件设计

### 3.1 ListingPlan DSL 规范

```typescript
interface ListingPlan {
  version: "1.0";
  scenario: "report" | "medical" | "manual" | "rbqm";
  
  // 数据源声明
  datasets: Dataset[];
  
  // 衍生列定义
  derivedColumns?: DerivedColumn[];
  
  // 布局配置
  layout: LayoutConfig;
  
  // 验证规则
  validation?: ValidationRule[];
}

interface Dataset {
  name: string;              // 数据集别名
  source: string;            // SAS 文件名（只能引用 schema 中存在的）
  columns: string[];         // 列名列表（只能引用已存在列）
  filters?: Filter[];        // 过滤条件
  sort?: SortRule[];         // 排序规则
  joins?: Join[];            // 表连接
}

interface Filter {
  column: string;
  operator: "eq" | "ne" | "gt" | "lt" | "in" | "notNull" | "like";
  // value 只能是：
  // 1. 列引用（"@column_name"）
  // 2. 表达式引用（"@derived_col"）
  // 3. 白名单字面量类型（数字、布尔、null）
  // 禁止：字符串字面量（可能包含数据值）
  value?: string | number | boolean | null;
}

interface DerivedColumn {
  name: string;
  expression: Expression;    // AST 白名单表达式
  refs: string[];            // 依赖的列/衍生列
}

interface Expression {
  type: "BinaryOp" | "UnaryOp" | "FunctionCall" | "ColumnRef" | "Literal";
  // 白名单函数：concat, substr, upper, lower, coalesce, 
  //             case_when, if_else, year, month, day, ...
  // 禁止：eval, exec, import, open, ...
}

interface LayoutConfig {
  freeze: {rows: number, cols: number};
  toc: boolean;              // 是否生成目录
  dropCodeValue: boolean;    // 是否移除编码值列
  flagColumns?: string[];    // 标记列（New/Modified/...）
  groupBy?: string[];        // 分组列
  subtotals?: boolean;       // 是否显示小计
}

interface ValidationRule {
  type: "assertNotNull" | "assertUnique" | "assertRange" | "assertPattern";
  columns: string[];
  params?: Record<string, any>;
}
```

### 3.2 计划验证器 (PlanValidator)

**职责**：确定性校验，不依赖 AI

```python
class PlanValidator:
    def validate(self, plan: dict, schema: dict) -> ValidationResult:
        """
        校验规则：
        1. JSON schema 结构合规
        2. 所有表/列引用必须存在于 schema
        3. 表达式 AST 只包含白名单节点
        4. Filter value 不得包含字符串字面量（防止数据值泄露）
        5. 衍生列依赖图无循环
        6. 布局配置参数在合理范围内
        """
        errors = []
        
        # 1. Schema 校验
        if not self._validate_schema(plan):
            errors.append("Invalid JSON schema")
        
        # 2. 引用校验
        for dataset in plan.get('datasets', []):
            if dataset['source'] not in schema['tables']:
                errors.append(f"Unknown table: {dataset['source']}")
            for col in dataset['columns']:
                if col not in schema['tables'][dataset['source']]['columns']:
                    errors.append(f"Unknown column: {col}")
        
        # 3. 表达式白名单校验
        for derived in plan.get('derivedColumns', []):
            if not self._validate_expression_ast(derived['expression']):
                errors.append(f"Unsafe expression in: {derived['name']}")
        
        # 4. 数据字面量检测
        for dataset in plan.get('datasets', []):
            for filter in dataset.get('filters', []):
                if isinstance(filter.get('value'), str) and not filter['value'].startswith('@'):
                    # 字符串字面量可能包含数据值 → 拒绝
                    errors.append(f"String literal not allowed in filter: {filter}")
        
        return ValidationResult(valid=len(errors)==0, errors=errors)
```

### 3.3 确定性执行器 (ListingExecutor)

**职责**：隔离执行，数据不出域

```python
class ListingExecutor:
    def execute(self, plan: dict, data_root: Path) -> ExecutionResult:
        """
        执行环境：
        - 沙箱内运行（只能访问 data_root 下的文件）
        - stdout/stderr 不回传给 AI（只返回结构化结果）
        - 异常不包含数据值（只包含列名/表名）
        """
        # 1. 加载数据
        datasets = {}
        for ds_def in plan['datasets']:
            sas_path = data_root / f"{ds_def['source']}.sas7bdat"
            df = pyreadstat.read_sas7bdat(str(sas_path))[0]
            
            # 只保留需要的列
            df = df[ds_def['columns']]
            
            # 应用过滤
            for filter in ds_def.get('filters', []):
                df = self._apply_filter(df, filter)
            
            datasets[ds_def['name']] = df
        
        # 2. 计算衍生列
        for derived in plan.get('derivedColumns', []):
            df = datasets[derived['refs'][0]]  # 主表
            df[derived['name']] = self._eval_expression(df, derived['expression'])
        
        # 3. 生成 Excel
        output = self._generate_excel(datasets, plan['layout'])
        
        # 4. 返回元数据（不含数据值）
        return ExecutionResult(
            status="completed",
            artifact={"name": output.name, "sheets": [...], "rowCounts": [...]},
            executionTime=12.3
        )
```

### 3.4 来源域架构 (Provenance Plane)

**核心变化**：从"内容识别"到"来源边界"

```javascript
// planes.js - 简化为文件级判断
export function planeOf(filePath) {
  // 1. data plane: 数据域（拒绝出域）
  if (inside(config.dataPlaneRoots, filePath)) return 'data';
  if (hasDataExtension(filePath)) return 'data';  // .sas7bdat 放哪都是数据
  
  // 2. spec plane: 规格域（完整可读）
  if (inside(config.specPlaneRoots, filePath)) return 'spec';
  
  // 3. executor plane: 执行器域（stdout 不回传）
  if (isExecutorScript(filePath)) return 'executor';
  
  // 4. 其他：通用域（正常处理）
  return 'general';
}

// 新增：executor plane 的处理
function handleExecutorPlane(result) {
  // 执行器脚本的 stdout 不回传给 AI
  // 只返回结构化的执行结果
  return {
    status: result.exitCode === 0 ? 'success' : 'failed',
    metadata: extractMetadata(result.stdout),
    // stdout/stderr 不回传
  };
}
```

**Sheet 级判断**不再需要，因为：
- Spec 文件完整可读（AI 需要理解需求）
- 数据文件完全不可读（根本不进模型通道）
- 中间不存在"部分可读"的情况

---

## 四、实施路线图（4 周）

### Week 1: 基础设施（DSL + 验证器）

**Day 1-2**: ListingPlan DSL 设计与规范文档
- 定义完整 TypeScript 接口
- 编写 JSON schema
- 示例计划（covering 4 种场景）

**Day 3-4**: PlanValidator 实现
- JSON schema 校验
- 引用完整性校验
- 表达式 AST 白名单
- 数据字面量检测

**Day 5**: 单元测试
- 合法计划（应通过）
- 非法计划（应拒绝）
- 边界用例

### Week 2: 执行器 + 来源域重构

**Day 1-2**: ListingExecutor 核心逻辑
- SAS 文件读取
- Filter/Sort/Join 应用
- 衍生列计算
- Excel 生成

**Day 3**: 执行器沙箱隔离
- stdout/stderr 不回传
- 异常脱敏（只保留列名/表名）
- 资源限制（内存/时间）

**Day 4-5**: 来源域简化重构
- planes.js 简化为文件级判断
- 移除 smart_guard / data_egress_guard 的内容扫描
- 保留 planeAdmission（路径级拦截）

### Week 3: AI 对接 + 工具链集成

**Day 1-2**: AI Prompt 工程
- 教会 AI ListingPlan DSL
- Few-shot 示例（每种场景 3-5 个）
- 调试 AI 生成的计划质量

**Day 3-4**: 工具链集成
- listing_workflow.py 改为"理解→计划→执行"三段
- spec/ALS 完整可读（不再只给计数）
- 执行结果返回元数据

**Day 5**: 端到端测试
- RBQM_test 完整流程
- GQ1005-301 完整流程
- 验证：数据不出域、计划合规、产出正确

### Week 4: 测试 + 文档 + 上线

**Day 1-2**: 真实数据测试套件
- 基于 Clinical-Data 10 个项目
- 覆盖 4 种场景
- 自动化回归测试

**Day 3**: 安全审计
- 计划验证器覆盖率
- 执行器沙箱逃逸测试
- 数据泄露路径扫描

**Day 4**: 文档与培训
- 架构设计文档
- ListingPlan DSL 参考手册
- 用户使用指南
- 开发者维护指南

**Day 5**: 上线准备
- 灰度发布计划
- 回滚方案
- 监控与告警
- 上线 checklist

---

## 五、风险与缓解

### 风险 1: AI 生成的计划质量不稳定
- **概率**: 高
- **影响**: 可能需要多次交互才能生成合法计划
- **缓解**: 
  - 充足的 few-shot 示例
  - 计划验证器给出清晰的错误提示
  - 支持用户手动修正计划
  - 保存历史成功计划作为模板

### 风险 2: 执行器性能问题
- **概率**: 中
- **影响**: 大数据集处理慢
- **缓解**: 
  - 分批处理
  - 进度反馈
  - 资源限制
  - 可配置超时

### 风险 3: 迁移期兼容性
- **概率**: 高
- **影响**: 旧 API 用户需要适配
- **缓解**: 
  - 提供兼容层（自动转换旧请求）
  - 灰度发布
  - 双轨运行 2 周
  - 详细迁移文档

### 风险 4: 新架构仍有漏洞
- **概率**: 中
- **影响**: 数据泄露
- **缓解**: 
  - 独立安全审计
  - 渗透测试
  - Bug bounty
  - 持续监控

---

## 六、成功标准

### 功能标准
- [ ] 4 种场景（report/medical/manual/rbqm）全部支持
- [ ] 至少 8/10 真实项目能跑通
- [ ] AI 生成计划的成功率 > 80%（一次通过）
- [ ] 执行器性能：1GB 数据 < 30s

### 安全标准
- [ ] 计划验证器拒绝所有数据字面量
- [ ] 执行器 stdout 不回传
- [ ] 异常消息不含数据值
- [ ] 独立安全审计通过

### 质量标准
- [ ] 真实数据测试套件覆盖率 > 90%
- [ ] 文档完整（架构/API/用户指南）
- [ ] 代码覆盖率 > 80%
- [ ] 无 P0/P1 缺陷

### 可维护性标准
- [ ] 新场景支持只需添加 few-shot 示例（不改代码）
- [ ] 新数据形态自动兼容（不需要新正则）
- [ ] 核心逻辑 < 2000 行
- [ ] 平均修复时间 < 1 天

---

## 七、投入产出分析

### 投入
- **人力**: 1 人全职 4 周
- **风险**: 迁移期双轨运行成本

### 产出
- **终结补丁竞赛**：新场景不需要改代码
- **安全可证明**：数据在结构上到不了模型
- **可维护性**：核心逻辑简化 10 倍
- **AI 能力释放**：理解需求 + 生成计划（这是它擅长的）
- **本地处理放开**：不再担心"程序处理数据会不会泄露"

### ROI
- 当前架构：每个新场景 = 2-5 天修复 + 测试
- 新架构：每个新场景 = 2-5 个 few-shot 示例（2 小时）

**回收期**: 约 3-4 个新场景后开始回本

---

## 八、下一步行动

### 立即开始（Day 1）
1. 确认架构设计（本文档）
2. 创建 Week 1 任务分解
3. 开始 ListingPlan DSL 详细设计

### 需要决策
1. 是否保留旧架构作为 fallback？
2. 灰度发布策略（按场景？按项目？）
3. 迁移期支持期限（建议 4 周）

---

**文档版本**: v1.0  
**编写时间**: 2026-08-23 00:10  
**预计开始**: 2026-08-23  
**预计完成**: 2026-09-20
