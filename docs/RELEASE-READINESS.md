# 当前开发交付状态与证据

更新：2026-11-09 · 范围：架构变更文档已交付，代码迁移未完成。

本文名称保留以兼容旧链接，**不再定义本机隔离安全上线门禁**。旧Hyper-V/投影/签名安全回执要求由 [ADR-0001](adr/ADR-0001-DEVELOPMENT-AND-KNOWLEDGE-ARCHITECTURE.md) 替代。数据安全由IT源头与未来API承担，API尚未接入；开发可继续，不能据此宣称生产安全已验收。

## 1. 状态说明

- `HISTORICAL_PASSED`：此前特定版本/夹具的实际结果，不覆盖后续源码。
- `UNVERIFIED_CHANGES`：代码已写但未执行对应验证。
- `NOT_IMPLEMENTED`：只有设计或缺少完整消费者链。
- `NOT_RUN`：验收未执行；不等于失败，也不等于通过。
- 本轮文档检查单独记录，不升级业务能力状态。

## 2. 实际证据矩阵

| 能力 | 状态 | 事实与限制 |
|---|---|---|
| 旧Listing合成开发闭环 | HISTORICAL_PASSED | 此前69项测试、host/client类型与构建通过；固定demo、CSV/Excel/RDS、多场景人工R fixture，不是项目级模型生成验收 |
| ALS整sheet/投影/安全拒读旧合同 | HISTORICAL_PASSED | 旧69项中含相关断言；用户新范围已撤销安全门禁，后续必须替换测试，不能以旧通过证明新合同 |
| 三项目经验静态文本及接线 | UNVERIFIED_CHANGES | manual/pk/intake/scenario-methods新增，index注册4技能及经验工具；未完成本轮类型/测试/构建 |
| 平台KnowledgeService | UNVERIFIED_CHANGES（部分实现） | 已编写公共schema/store/service、SQLite修订/检索/验证激活/快照、独立Cordis装配和Listing候选种子；全部未运行验证。检索为scope过滤Unicode子串，FTS、项目裁定激活/推广、真实运行事件学习与自动上下文未完整实现 |
| 旧安全代码撤出 | NOT_IMPLEMENTED | 归档命令在执行前被工具服务阻止；原Cover/辅助表拒读、投影/批准、readiness/UI及部署目录仍在 |
| 项目发现与spec/ALS/SAS读取 | NOT_IMPLEMENTED | 尚未接通通用项目目录、批次/版本及SAS记录完整工作流；demo不能替代 |
| R执行与格式检查 | HISTORICAL_PASSED | 本机Node24.9.0/R4.5.0 x64 Rterm曾实际执行手写fixture和独立双格式检查；固定依赖/输出合同仍需泛化 |
| 服务器独立单文件R交付 | NOT_IMPLEMENTED | 通用程序配置、异目录任意cwd/服务器形态复跑尚未完成；历史demo ZIP可用不代表真实项目代码包已就绪 |
| 备份/恢复 | HISTORICAL_PASSED | 旧合成TaskStore一致性与新目录恢复测试通过；不是知识库、完整安装升级或灾难恢复验收 |
| 浏览器新流程 | NOT_RUN | 上一版入口smoke曾验证；后续预览工具判定服务不可用，未完成当前构建/新工作流复验 |
| 模型自主冷启动 | NOT_RUN | 未以当前项目资料让模型完成独立生成/纠错/QC；手写fixture不是替代证据 |
| 当前真实项目与服务器验收 | NOT_RUN | 没有本轮真实项目/真实服务器运行与业务责任人验收 |
| IT安全API | 外部待提供 | 无API合同与实现，不继续自建安全框架，不伪造已集成 |
| 完整安装与分发 | PARTIAL/待重验 | 旧候选重复构建/加载曾通过；新增知识接线后未重验。此前@nodable/entities@3.1.0安装包缺许可正文，分发处理仍需解决，不编造许可 |

历史验证入口：插件目录使用Node24.9.0运行 `scripts/verify.mjs`。Node SQLite仍有experimental警告；测试计数随旧合同退役变化，不以保持69为目标。

## 3. 当前源代码与文档不一致

目标文档允许正常资料读取（Cover亦无禁令），但当前`index.ts/service.ts/workbook.ts/readiness.ts/client/index.ts`仍有旧限制。知识引导部分已改，不能说明工具实现已改。此差距须先消除，不能只改提示词或开关。

已编写的公共知识服务以安装代码执行案例并绑定候选digest，但本批尚未实际验证，真实Run/QC事件与自主学习链未接通；不能让模型自报“学习成功”充当已激活经验。详细现状和改动清单见 [迁移与验收](MIGRATION-AND-ACCEPTANCE.md)。

## 4. 新开发交付完成条件

1. 公开工具可从项目目录发现并正常读取spec/ALS/SAS/支持格式，完整分页，业务歧义才询问；旧数据类别门禁从入口/包/UI撤出。
2. 平台按插件/项目检索与持久经验、幂等种子、实际验证激活、冲突/撤回/快照可验证。
3. R自主生成、执行、日志反馈与修复、当前需求多工件QC接同一修订，不靠固定demo答案。
4. 单文件R在异目录与服务器配置下实际复跑，无DSH/Node/Python/本机source依赖，输入不误写、输出不覆盖旧正式结果。
5. Manual、PK BE、PK SAD/MAD人工格式项目的端到端通过，Medical另测与review核心复用；模型冷启动与真实服务器测试单独标状态。
6. 包/版本/许可、安装启停及浏览器用户路径有证据，报告保留失败和未执行项。

本轮只更新架构文档，没有修改业务源码、接入IT API、读真实项目数据或执行系统级配置。已做文件枚举及内容搜索的手工一致性核对；自动链接检查和独立审阅代理均在执行前被应用判定服务阻止，没有产出通过证据。没有运行应用测试/构建或R业务。文档的自洽性不代表以上完成条件已满足。
