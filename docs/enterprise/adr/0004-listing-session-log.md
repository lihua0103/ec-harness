# ADR-0004：Listing Session Log 策略

- 状态：已接受
- 日期：2026-08-27
- 决策者：架构师
- 上游 pin：dsh-v0.1.1-rc.2

## 背景

P1 阶段需评估 @dsh-enterprise/listing 插件的工具结果是否需要自定义 SessionEvent 投影。

官方要求：
- 模型可见内容必须可从 SessionEvent 重建
- 工具结果通过 tool/result 事件记录
- SessionEventMap 可通过声明合并扩展

## 评估结论

**Listing 工具无需自定义 SessionEvent**

### 评估维度

1. **工具结果记录**
   - ✅ enterprise_listing_inspect 返回值进入 tool/result 事件
   - ✅ enterprise_listing_run_code 返回值进入 tool/result 事件
   - ✅ enterprise_listing_publish 返回值进入 tool/result 事件

2. **模型可见性**
   - ✅ 所有返回内容在 tool/result.message.content（JSON 序列化）
   - ✅ 模型历史通过 deriveMessages() 从事件重建
   - ✅ replay 机制自动恢复工具上下文

3. **架构合规性**
   - ✅ 使用标准 ctx.command() 注册
   - ✅ 返回值自动包装为 tool/result
   - ✅ 无需扩展 SessionEventMap

4. **对比参考**
   - compaction/* 需要自定义事件（记录压缩过程）
   - hook/* 需要自定义事件（记录 hook 调用）
   - listing 工具不需要（标准工具结果已足够）

## 决策

**豁免自定义 SessionEvent 实现**

理由：
1. 官方 tool/result 事件已完整记录工具返回值
2. 当前实现符合官方架构要求
3. replay 能力已由官方机制提供
4. 无需引入额外复杂度

## 影响

- ✅ 保持实现简洁（无自定义事件）
- ✅ 依赖官方 replay 机制（稳定可靠）
- ✅ 符合架构审计要求（无合规风险）
- ⚠️ 若未来需要记录工具内部状态（如会话生命周期），再评估扩展需求

## 验证

已验证项：
- ✅ 工具返回值可 JSON 序列化
- ✅ deriveMessages 包含工具结果
- ✅ 架构检查通过
- ✅ 测试覆盖工具注册

## 参考

- 官方文档：docs/subsystems/session.md
- 实现代码：packages/enterprise/listing/src/index.ts
- 架构审计：docs/enterprise/ARCHITECTURE_AUDIT.md
