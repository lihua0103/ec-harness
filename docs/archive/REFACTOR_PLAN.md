# 临床数据守护系统重构计划

## 项目背景

将现有的 `dsh-clinical-data-guard` 项目按照企业架构规范重构为 DSH Guard 企业插件。

## 核心功能清单

### 1. AI 临床流程
- Listing 生成流程
- AI 辅助临床数据处理

### 2. 智能算法
- **表头识别**：`security/header_detect.py`
- **EDC 系统字段识别**：需要识别电子数据采集系统的字段

### 3. 输出规范
- **Listing 样式规范模板**：`security/listing_plan.py`, `security/spec_parser.py`
- 标准化输出格式

### 4. 数据安全开关（核心功能）
- **默认状态**：开启（开箱即用安全）
- **关闭后**：不做任何拦截
- **拦截场景**：
  1. **SAS 数据集 data 出域 AI 拦截**：`security/egress_checkpoint.py`
  2. **Spec 需求辅助理解处理数据 data 出域 AI 拦截**：`security/listing_inspector.py`

### 5. 现有核心模块

#### 安全模块 (security/)
- `egress_checkpoint.py` - 出域检查点
- `header_detect.py` - 表头检测
- `listing_workflow.py` - Listing 工作流
- `listing_inspector.py` - Listing 检查器
- `listing_executor.py` - Listing 执行器
- `listing_plan.py` - Listing 计划
- `spec_parser.py` - Spec 解析器
- `code_sandbox.py` - 代码沙箱
- `audit_log.py` - 审计日志
- `patterns.py` - 模式匹配
- `path_policy.py` - 路径策略
- `project_profile.py` - 项目配置

#### 插件模块 (src/)
- `index.js` - 主入口
- `clinical-listing-plugin.js` - 临床 Listing 插件
- `data-interception-policy.js` - 数据拦截策略
- `tool-result-guard.js` - 工具结果守卫
- `planes.js` - 数据平面
- `branding.js` - 品牌定制

#### 测试 (tests/)
- `unit/` - 单元测试（12 个文件）
- `integration/` - 集成测试（6 个文件）
- `e2e/` - E2E 测试（3 个文件）
- `bypass/` - 绕过测试
- `mutation/` - 变异测试

## 重构目标架构

### 新的目录结构

```
packages/enterprise/
├── clinical-guard/              # 临床数据守护插件
│   ├── src/
│   │   ├── index.ts            # 主入口（Cordis 插件）
│   │   ├── config.ts           # 配置和 Schema
│   │   ├── service.ts          # 主服务类
│   │   ├── core/               # 核心功能
│   │   │   ├── egress-switch.ts      # 数据安全开关
│   │   │   ├── egress-checkpoint.ts  # 出域检查点
│   │   │   ├── header-detector.ts    # 表头识别
│   │   │   ├── edc-field-detector.ts # EDC 字段识别
│   │   │   └── listing-template.ts   # Listing 模板
│   │   ├── ai/                 # AI 功能
│   │   │   ├── listing-flow.ts       # Listing 流程
│   │   │   ├── spec-parser.ts        # Spec 解析
│   │   │   └── data-inspector.ts     # 数据检查
│   │   ├── security/           # 安全模块
│   │   │   ├── audit-log.ts          # 审计日志
│   │   │   ├── sandbox.ts            # 代码沙箱
│   │   │   └── path-policy.ts        # 路径策略
│   │   ├── workflow/           # 工作流
│   │   │   ├── listing-executor.ts   # 执行器
│   │   │   └── listing-plan.ts       # 计划
│   │   └── tools/              # Cordis 工具
│   │       ├── listing-inspect.ts
│   │       ├── listing-run-code.ts
│   │       └── listing-publish.ts
│   ├── python/                 # Python 后端（保留）
│   │   └── security/           # 原有 Python 模块
│   ├── tests/
│   │   ├── unit/              # 单元测试
│   │   ├── integration/       # 集成测试
│   │   └── e2e/               # E2E 测试
│   ├── package.json
│   ├── tsconfig.json
│   └── README.md
```

## 重构步骤

### 阶段一：准备工作（当前阶段）
1. ✅ 分析现有代码结构
2. ⏭️ 创建重构规划文档
3. ⏭️ 设计新架构

### 阶段二：创建基础框架
1. 创建 `packages/enterprise/clinical-guard/` 目录
2. 设置 package.json 和 tsconfig.json
3. 创建 Cordis 插件入口
4. 实现配置 Schema（包含数据安全开关）

### 阶段三：核心功能迁移
1. **数据安全开关**（最高优先级）
   - 实现开关配置
   - 集成到所有拦截点
   - 默认开启逻辑

2. **SAS 数据集出域拦截**
   - 迁移 `egress_checkpoint.py` 逻辑
   - 集成 AI 拦截决策

3. **Spec 需求处理拦截**
   - 迁移 `listing_inspector.py` 逻辑
   - 集成 AI 理解能力

4. **表头识别算法**
   - 迁移 `header_detect.py`
   - 优化识别精度

5. **EDC 字段识别**
   - 实现字段识别逻辑

6. **Listing 模板规范**
   - 迁移模板生成逻辑

### 阶段四：测试迁移
1. 迁移单元测试（保持覆盖率）
2. 迁移集成测试
3. 迁移 E2E 测试（必须通过）
4. 添加新功能测试

### 阶段五：验证和优化
1. 运行完整测试套件
2. 性能测试
3. 安全审计
4. 文档完善

## 数据安全开关设计

### 配置示例

```yaml
plugins:
  - name: '@dsh-guard/clinical-guard'
    config:
      # 数据安全开关（核心配置）
      dataEgressControl:
        enabled: true  # 默认开启，false 时不做任何拦截
        
        # SAS 数据集出域拦截
        sasDatasetEgress:
          enabled: true
          aiInterception: true
          
        # Spec 需求数据出域拦截
        specDataEgress:
          enabled: true
          aiInterception: true
      
      # 其他功能
      headerDetection:
        enabled: true
      
      edcFieldRecognition:
        enabled: true
      
      listingTemplate:
        enabled: true
```

### TypeScript 接口

```typescript
export interface DataEgressControlConfig {
  enabled: boolean  // 主开关
  sasDatasetEgress: {
    enabled: boolean
    aiInterception: boolean
  }
  specDataEgress: {
    enabled: boolean
    aiInterception: boolean
  }
}

export interface ClinicalGuardConfig {
  dataEgressControl: DataEgressControlConfig
  headerDetection: { enabled: boolean }
  edcFieldRecognition: { enabled: boolean }
  listingTemplate: { enabled: boolean }
}
```

## 测试要求

### 必须通过的测试
1. ✅ 所有单元测试
2. ✅ 所有集成测试
3. ✅ 所有 E2E 测试
4. ✅ 数据安全开关开启/关闭切换测试
5. ✅ SAS 数据集拦截测试
6. ✅ Spec 数据拦截测试

### 测试覆盖率要求
- 单元测试：> 80%
- 集成测试：核心流程 100%
- E2E 测试：主要用户场景 100%

## 交付标准

1. ✅ 所有测试通过
2. ✅ 代码符合企业架构规范
3. ✅ 完整的文档（README + API 文档）
4. ✅ 数据安全开关正常工作
5. ✅ 性能不低于原系统
6. ✅ 安全审计无高危问题

## 时间估算

- 阶段二：2 小时
- 阶段三：6 小时
- 阶段四：4 小时
- 阶段五：2 小时
- **总计**：约 14 小时

## 当前状态

📍 **阶段一：准备工作** - 进行中
- ✅ 代码分析
- ⏭️ 开始实施重构

---

**准备好开始重构了吗？**
