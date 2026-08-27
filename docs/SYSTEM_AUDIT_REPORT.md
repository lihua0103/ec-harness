# DSH Enterprise Platform 系统审计报告

生成时间: 2026-08-27
审计范围: 架构完整性、安全性、功能实现、代码质量

## 一、执行摘要

经过全面审计，DSH Enterprise Platform 在架构设计和代码质量方面表现优秀，但存在以下关键问题：

**关键发现**：
- ✅ 架构设计优秀，企业层与官方层完全解耦
- ✅ 4个核心插件实现完整且测试通过
- 🔴 Auth插件完全缺失（README提到但未实现）
- ⚠️ 数据安全UI未接入主界面
- ⚠️ Python沙箱采用低强度设计（有意为之，面向受信环境）

**风险等级**: 中等（受信内网）/ 严重（公网环境）

---

## 二、架构完整性 ✅

### 2.1 插件装配验证

已实现4个企业插件，全部正确装配：

1. `@dsh-enterprise/branding` - 品牌白标
2. `@dsh-enterprise/ui-settings` - 企业设置UI与数据安全服务
3. `@dsh-enterprise/tool-audit` - 工具审计与数据拦截
4. `@dsh-enterprise/listing` - 临床Listing引导

装配顺序符合依赖关系：
- dsh-base → dsh-web-app → ui-settings → tool-audit → branding → listing

### 2.2 官方边界隔离

- ✅ 上游submodule: upstream/deepseek-harness@dsh-v0.1.1-rc.2
- ✅ 企业代码完全位于 packages/enterprise/
- ✅ 无企业代码泄漏进官方目录
- ✅ 命名空间隔离: @dsh-enterprise/* vs @deepseek-ai/*
- ✅ Row ID隔离: enterprise-* 前缀

### 2.3 架构门禁

```
architecture checks passed (4个企业插件，6个Bundle层)
secret scan passed
typecheck: 全部通过
tests: 31/31 通过
```

---

## 三、安全审计 ⚠️

### 3.1 凭证安全 ✅

- ✅ 无硬编码API密钥
- ✅ 无私钥泄漏
- ✅ .env.example仅包含占位符

### 3.2 数据安全机制 ⚠️ 部分实现

#### 已实现：
1. **DataSecurityService**
   - 默认启用拦截
   - 配置持久化: profiles/enterprise/.data-security.json
   - HTTP API: /api/settings/data-security
   - 受保护模式: *.sas7bdat, *.xpt, data/**/*.xlsx等

2. **工具级拦截**
   - tool-audit通过 tools/pre-execute 拦截
   - 数据安全启用时阻断 enterprise_listing_* 全部工具
   - 简单有效的一刀切策略

#### 未完成：
1. 🔴 **前端UI未接入主界面** - 用户无法通过界面操作
2. ⚠️ 细粒度文件级拦截未实现（当前是工具级）
3. ⚠️ 缺少端到端集成测试

### 3.3 Python Worker安全 ⚠️

**当前状态**：
- AST策略验证（禁止import、exec、私有属性）
- 独立子进程 + 超时控制（900秒）
- **有意降低强度**（ADR-0003）

**设计口径**（引自ADR-0003）：
> "业务侧明确：当前部署是受信内网环境，这条流程完全不需要限制AI操作"

**风险**：
- 🔴 缺少OS级隔离（容器/VM）
- ⚠️ 可访问进程环境变量
- ⚠️ inspect返回数据预览（前5行）
- ⚠️ stdout不脱敏

**适用场景**：仅限受信内网

### 3.4 归档密码 ⚠️

采用sidecar方式: `<archive>.txt` 明文存储
- 风险: 明文暴露
- 缓解: 依赖文件系统权限

---

## 四、功能完整性

### 4.1 已实现功能 ✅

**Branding插件**：
- 品牌名替换: Emerald Clinical Trials
- favicon/manifest更新
- Logo注入（logoRow + railFish）
- MutationObserver实时DOM监控

**UI Settings插件**：
- DataSecurityService完整实现
- HTTP API端点
- 配置持久化
- Same-origin保护

**Tool Audit插件**：
- tools/pre-execute拦截
- Listing工具阻断
- minimatch路径匹配

**Listing插件**：
- 三阶段流程: inspect → run_code → publish
- Python Worker (NDJSON协议)
- Agent隔离会话
- Spec/ALS识别
- 多数据源: SAS/XPT/CSV
- 加密归档解压
- Multi-sheet Excel
- 4种场景: manual/medical/report/rbqm

### 4.2 未实现功能 🔴

1. **Auth插件**
   - README提到但完全未实现
   - 无代码、无测试、无文档
   - 未装配到Profile

2. **UI集成**
   - 数据安全设置页面HTML已生成
   - 但未接入主界面导航
   - 用户无法通过UI访问

### 4.3 功能接线分析

**数据安全拦截机制**：

实际实现采用**工具级拦截**：
```typescript
// tool-audit/src/data-interceptor.ts
ctx.on('tools/pre-execute', (exec, next) => {
  if (dataSecurityService.isEnabled() && LISTING_TOOLS.has(exec.name)) {
    return { kind: 'deny', reason: '数据安全策略已启用' }
  }
  return next()
})
```

**评价**：
- ✅ 简单有效：一刀切阻断整个工具链
- ⚠️ 粒度粗糙：无法区分敏感/非敏感文件
- ℹ️ data-security/check-file事件已定义，预留了细粒度扩展能力

---

## 五、潜在漏洞

### 5.1 高风险 🔴

1. **无身份认证机制**
   - Auth插件完全缺失
   - 任何访问者可操作全部功能
   - HTTP API无认证要求

2. **数据安全可被绕过**
   - 用户可通过HTTP API关闭开关
   - 无审计日志
   - 无管理员强制策略

### 5.2 中风险 ⚠️

1. **CSRF保护有限**
   - 仅检查Origin header
   - 未使用CSRF token

2. **Python沙箱强度**
   - 这是有意设计（受信环境）
   - 如部署到公网则风险严重

3. **归档密码明文**
   - sidecar .txt文件
   - 依赖文件系统权限

### 5.3 低风险 ℹ️

1. Worker会话状态仅内存
2. 变化追踪算法简化

---

## 六、架构设计评价

### 6.1 优势 ✅

1. **企业层完全解耦**
   - 零侵入官方代码
   - 升级友好
   - 门禁自动验证

2. **插件机制灵活**
   - 基于Cordis事件驱动
   - 依赖注入清晰
   - 可组合性强

3. **代码质量高**
   - TypeScript严格模式
   - 测试覆盖良好
   - 文档完备（4个ADR）

### 6.2 改进空间 ⚠️

1. **依赖注入**
   - 当前使用字符串注入
   - 缺少运行时类型检查

2. **事件架构**
   - data-security/check-file未充分利用
   - 可扩展为细粒度控制

3. **配置管理**
   - 分散在多处
   - 缺少统一配置中心

---

## 七、改进建议

### 7.1 紧急 🔴

1. **实现Auth插件**
   - 基础身份认证
   - API鉴权
   - 会话管理

2. **UI集成**
   - 接入主界面导航
   - 实现设置页面可访问

### 7.2 重要 ⚠️

1. **审计日志**
   - 记录数据安全开关变更
   - 记录敏感文件访问
   - 记录代码执行

2. **细粒度拦截**
   - 扩展data-security/check-file
   - 支持文件级策略
   - 白名单机制

3. **加强CSRF**
   - CSRF token
   - SameSite cookies

### 7.3 优化 ℹ️

1. 端到端测试
2. 性能监控
3. Python依赖锁版本

---

## 八、合规性

### 8.1 GDPR/隐私 ⚠️
- 无数据处理日志
- 无用户同意机制
- 数据保留策略未定义

### 8.2 审计追踪 ⚠️
- 开关变更无日志
- 文件访问无记录
- 代码执行无签名

---

## 九、部署建议

### 适用场景
✅ **可部署**：
- 完全受信的内网环境
- 单租户部署
- 内部开发/测试

🔴 **不可部署**：
- 公网环境
- 多租户环境
- 处理高敏感数据（除非完成加固）

### 部署前清单
1. ⚠️ 确认环境为受信内网
2. ⚠️ 配置数据安全开关（通过HTTP API）
3. 🔴 实现基础认证（如需要）
4. ⚠️ 配置审计日志
5. ✅ 验证Python依赖完整

---

## 十、总体评价

### 分数卡
- 架构设计: ⭐⭐⭐⭐⭐ (5/5)
- 代码质量: ⭐⭐⭐⭐⭐ (5/5)
- 功能完整: ⭐⭐⭐⭐☆ (4/5) - Auth缺失
- 安全性: ⭐⭐⭐☆☆ (3/5) - 受信环境足够，公网不足
- 文档: ⭐⭐⭐⭐⭐ (5/5)

### 结论

DSH Enterprise Platform 展现了**优秀的架构设计**和**高质量的代码实现**。企业扩展层与官方基线完全解耦，插件机制灵活且易于维护。

**关键优势**：
- 零侵入式企业扩展
- 完备的门禁与测试
- 清晰的ADR文档

**关键不足**：
- Auth插件完全缺失
- 数据安全UI未接入
- 审计日志缺失

**适用性评估**：
- ✅ 受信内网环境：可直接使用
- ⚠️ 生产环境：需补全Auth和审计
- 🔴 公网环境：需大量安全加固

建议优先完成Auth插件和UI集成后再考虑生产部署。

---

审计人: AI System Auditor
审计日期: 2026-08-27
