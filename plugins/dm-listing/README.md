# DM Listing 插件

更新：2026-11-11 · 包版本0.2.0。当前阶段：**真实项目工作流、加密数据包读取、学习闭环激活链路已实现；全量回归70/70、tsc、host/client bundle通过；知识服务已迁为独立平台bundle；DSH Web装配烟测通过（平台、Listing、DVP三包均安装并启用），未执行业务会话或临床验收。**

## 现行开发方向

基于现有DeepSeek Harness，覆盖Manual、Medical、Report及PK BE/SAD-MAD，自主识别项目资料、理解spec/ALS/SAS、编写/运行/修复R、独立QC，输出服务器可独立运行的单文件R及代码/证据包。Medical复用Manual的需求识别与处理核心，输出按当前项目。

用户已取消插件自建的数据安全拦截，明确包括Cover名称限制。数据安全由IT源头及未来API承担；API尚未接入，不宣称已实现。插件不做按文件名/sheet/数据类别的安全拦截，Cover可按任务读取。格式/资源限额、取消/超时、任务一致性、防误覆盖及真实测试/QC继续保留。distribution放行机制已落地：构建默认产NOT_APPROVED候选；`node scripts/release.mjs approve <candidate.zip>` 在integrity VERIFIED且blockers为空时按2026-11-10操作者授权升级为APPROVED，provenance固定记录「操作者授权下的AI自主确认 2026-11-10」，state与productionDataEnabled不变，放行产物复验VERIFIED。

## 加密数据包与冷启动（2026-11-10 已实现并定向验证）

- **加密zip数据包**：EDC交付的sas zip包可能带密码。插件读取通道内建密码候选推导（顺序对齐已交付程序：显式密码→项目目录名分词→zip旁sidecar txt→zip文件名分词→项目txt/Excel文档名stem→无密码）；传统ZipCrypto在进程内解密（12字节头探测淘汰错候选、CRC-32全量校验），密码不进日志或模型上下文；AES/强加密zip需本机7-Zip兜底（其argv可见密码与已交付R程序一致）。条目安全检查（遍历/绝对路径/重复名/超限）在解析期拒绝。
- **大sheet边界**：需求sheet实测5.8-7.2MB，单条目上限放开至32MB/64MB总量；解析层500000单元格上限、返回层100000单元格在窗口过滤后判定——大sheet可分窗口完整读取，超限整体读取显式拒绝不截断。
- **冷启动闭环**：以HXN6005真实spec需求sheet（DM_02人口统计学，19列）为输入——读需求列头→AI自主理解IR→自主编写R→纯合成数据执行→独立QC比对需求原词列头/FLAG域/记录ID唯一性。QC曾真实抓出列头弯引号与直引号偏差并驱动修正后PASS。
- **学习闭环接线**：注册已安装业务验证器（正/反/边界用例复现archive纯函数）；dm_listing_knowledge_capture沉淀CANDIDATE（可带claims）、dm_listing_knowledge_validate执行验证。固定用例通过只记`TOOL_REGRESSION_ONLY`；只有候选声明的全部claims被套件覆盖且通过才转ACTIVE，部分覆盖/无claims保持CANDIDATE并记录实际scope。

**浏览器验证由操作者完成。** demo旧入口保留为演示，不再作为唯一工作流；真实项目入口为overview → read_sheet → describe_dataset。

## 架构与实施真源

- [平台总架构1.1](../../docs/ENTERPRISE-PLATFORM-ARCHITECTURE.md)
- [Listing架构0.4](../../docs/DSH-CLINICAL-ARCHITECTURE.md)
- [架构变更决策ADR-0001](../../docs/adr/ADR-0001-DEVELOPMENT-AND-KNOWLEDGE-ARCHITECTURE.md)
- [平台自主经验知识库](../../docs/PLATFORM-EXPERIENCE-KNOWLEDGE.md)
- [迁移与验收清单](../../docs/MIGRATION-AND-ACCEPTANCE.md)
- [开发交付证据](../../docs/RELEASE-READINESS.md)

## 经验知识状态

平台应统一管理shared/plugin/project作用域和插件/场景/EDC/主题分类。Listing贡献领域种子与验证器，不自己再建知识数据库。Manual/Medical共用review方法；PK共同/BE/SAD-MAD按前提分类，项目常量和业务裁定不自动跨项目推广。

知识服务已迁至独立平台包`packages/platform-knowledge`（自带Cordis bundle与patch），Listing/DVP均只通过`clinicalKnowledge`注入使用，不再由Listing安装或拥有服务生命周期。Workbook读取迁至`packages/platform-workbook`，业务插件间不再引用源码。当前检索为scope先过滤的Unicode子串，不是已实现FTS；项目业务裁定激活、推广、真实运行事件学习及上下文自动绑定尚未完整实现。历史静态方法作为种子迁移来源，尚无结构化JSON/Markdown种子manifest。

知识帮助理解，不是固定业务答案：来源/范围/行条件/列处理/人工核查说明/输出分开解释，重复标记不误当筛选，join/展开/空表/缺失/class/label独立验证。三历史交付项目只能证明方法来源，不能证明当前插件已在新项目正确生成。

## 历史可运行基线

曾通过：69项合成/工程测试、TypeScript及host/client构建；本机Node24.9.0/R4.5.0 x64 Rterm实际执行五种场景人工fixture，核验CSV/Excel/RDS及ZIP。后续新经验接线改变源码，旧结果不覆盖当前新增代码。浏览器新流程、模型自主冷启动和真实服务器运行未完成。

原验证入口仍保留，下一阶段迁移后须重跑并记录测试替换原因：

```bash
"D:/package/Nvm/nvm/v24.9.0/node.exe" scripts/verify.mjs
```

不切换系统默认Node，不自动安装R或改系统配置。任务与工件不在本轮删除；旧数据保留策略见迁移文档。

## 文档兼容说明

- [DEVELOPMENT.md](DEVELOPMENT.md)：最新现状与历史过程；历史规则不覆盖新决策。
- [PROJECTION.md](PROJECTION.md)：旧设计停用说明，不再是当前数据读取合同，代码仍待撤出。
- [knowledge/README.md](knowledge/README.md)：种子迁移入口及状态。

本轮已修改插件业务实现（archive加密包读取、knowledge-validators验证器、平台knowledge events接口、新工具接线）并运行定向测试；真实临床数据未读取，测试全部使用合成fixture。验证结论以DEVELOPMENT.md与verify.mjs实际运行结果为准；不宣称可以上线或已完成真实项目交付。
