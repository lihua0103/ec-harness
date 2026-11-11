# Listing 经验种子：迁移状态

更新：2026-11-09 · 目标是平台统一KnowledgeService，不是Listing独立知识数据库。

现行设计见 [平台经验库](../../../docs/PLATFORM-EXPERIENCE-KNOWLEDGE.md) 和 [迁移清单](../../../docs/MIGRATION-AND-ACCEPTANCE.md)。旧“合成限定、Cover拒读、未知候选禁止读内容”等知识规则不再作为当前开发要求；代码仍有旧限制，尚待撤出。

## 当前状态

- `src/knowledge.ts`已调整开发引导，版本2026.11.09.2。
- `src/manual-methods.ts`、`pk-methods.ts`、`intake-methods.ts`、`scenario-methods.ts`新增静态通用经验，入口注册4技能和经验工具，但新增接线尚未本轮验证。
- 已编写外层platform-knowledge公共schema/store/service、独立Cordis适配和src/knowledge-seeds.ts五类候选；当前没有结构化JSON/Markdown种子manifest。本批服务/测试/构建全部未运行验证，不能称运行可用或自主学习已完整实现。

## 拟迁移分类

Manual与Medical共享review核心；PK分common/be/sad-mad；intake/ALS/SAS/EDC/runtime/output-QC/server-delivery按主题。Report独立积累，不冒充三历史项目的成熟证据。

种子从旧Manual、PK BE、PK SAD/MAD成功纠错方法提炼：问题、根因、修法、前提、不适用、反例与验证引用。未知列/布局仍完整读，固定字段类型/样式/OID/阈值不推广；历史项目成功不等于本库复现或新插件验收。

下一阶段把静态正文拆成有稳定ID/revision/digest的插件种子，平台负责幂等导入、检索、项目经验、冲突、验证激活和快照；不长期维护两套同内容文本，也不在每个会话默认注入整库。本文仅说明迁移，不触发种子导入。
