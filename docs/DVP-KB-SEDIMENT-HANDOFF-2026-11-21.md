# DVP 知识沉淀交接文档（2026-11-21）

> 交接目标：新会话接手 **DVP 训练路线第三阶段「知识沉淀」**——把 v1.0→插件升级→v1.1 复跑→对标公司 V6.0 全链路实证出的知识，按知识库合同沉淀为种子/清单/文档资产。前两阶段（自主生成、真实 DVP 对比）已完成并量化。

---

## 1. 路线定位与已完成事实

训练路线（2026-11-20 定调）：自主生成 → 真实 DVP 对比 → **知识沉淀（本交接）** → 多 EDC 反复迭代；公共规则 = 标准库自然来源。

已完成的实证链（全部有量化证据，细节见 [DVP-TEMPLATE-SCHEMA.md §9.3–9.4](DVP-TEMPLATE-SCHEMA.md)）：

| 事实 | 数值/证据 |
|---|---|
| v1.0（内联 68 条）→ 插件升级（bulk 写入 + 6 模板旋钮）→ v1.1 复跑 | v1.1 = `DVP_ATG-008-HX-001_v1.1_CANDIDATE.xlsx`，151KB，SHA-256 `2AE4D2AB48DF6F93DA8DB1BA0E71813A35F5CE52C244148A89C2F12474B70DAB` |
| 插件写簿实证（非 python 绕过） | 工作簿 mtime 与最后一次 `dm_dvp_write_workbook` 调用差 108ms；zip 无 openpyxl 指纹（无 docProps/core.xml） |
| bulk 路径实测 | 8 个 NDJSON（crossField 849 / fieldLevel 709 / dynamic 715 / matrix 130 / manualReview 16 / subjectStatus 4 / versionHistory 6）经文件引用传入；5 次 write 的 documentJson 仅 0.8–0.9KB；两次误传非清单参数 `templateDirectory` 后模型自行修正 |
| Edit Checks 对标 | 849/866（98%）；**逐表单计数精确命中**：LB 101=101、TM 91=91、TH 79=79、TE 54=54、FH 52=52 |
| Edit Checks Rave 对标 | 709=709；ControlType/IsRequired/QueryFutureDate/QueryNonConformance 枚举分布逐项相同（257/142/109/96/53/52、592/117、611/98、514/195） |
| Manual Review / Subject Status | 92=92 行、4=4 行 |
| 零编造 | Version History 仅证据行（V5.0 日期取自 ALS CopySource 文件名、V6.0 取自标准文件名），Modified By 留空 |
| 访视命名 | ALL×638 + 真实访视名；"所有访视"×0（v1.0 为 ×61） |
| 模板旋钮模型侧决策 | 模型自选 `editChecksQueryType=false` 匹配实物 8 列形态；识别标准无 Programming 页后主动不写入（8 条规则留存 NDJSON 未丢） |
| 插件测试基线 | dm-dvp 73/73 绿；仓库 verify-all 21/21 |

## 2. 残留差距（= 知识沉淀的主要原料）

按价值排序，前两项是**知识缺口**（模型缺惯例知识），后两项是**能力缺口**（插件缺配置面，属于下一开发迭代，不属于本阶段）：

1. **访视矩阵条目的跨页归类口径**：标准把访视-表单矩阵放 Matrix 页（44 行，`DYN_VISIT_*`，新增form 列放条件表单如「实验室检查-CA125检测(仅卵巢癌受试者)」「KPS评分（仅GBM）」）；v1.1 把 253 条 Dynamic Visit 塞进 Dynamic 页、Matrix 130 行几乎全是 SV。→ 需沉淀「归类惯例」：Dynamic Visit 只留极少量（标准 4 条），访视展开归 Matrix；新增form 放条件数据表单而非访视表单。
2. **SV_ 矩阵后缀 ID 缺口**：跨周期访视规则 ID 带矩阵后缀（标准 49 条 `SV_#_C#_C#` 形），v1.1 仅 10 条，约 39 条跨周期规则未进 Edit Checks；同时 EX 前缀多 23 条（口径漂移）。
3. **Manual Review 列形**：标准 29 列（Listing ID/Name/Version/CRF/Field/Visits/ReportDesc/DiscrepancyText/Review group/Condition/Column Heading + 尾部 UAT/Comments 稀疏列，Review group 全 DM）；v1.1 用了 8 列通用形。行数 92=92 已命中，列形未对齐。
4. **文案小差**：Logic「注：」注释（标准 69 处 / 我方 0）；「请核查」变体（标准 23 / 我方 0，我方统一「请核实」）；【表单.字段】记法密度过高（2009 vs 75——标准只在真正跨表时用【】，同表内字段裸写）。

已实证达标的（沉淀时标「已实证」而非待办）：请核实句尾（853/849 行 ≈ 100% vs 标准 97%）、缺失型/一致性型/时序型三模板（「已提供，但」144 vs 138、「不等于」33 vs 71、晚于 18=18、早于 34≈33）、Add/Delete/Update 基线全空（双方 0% 填充）、ID=表单缩写_序号主体、零编造、Subject Status【表单.字段】条件记法（状态语言我方中文/标准英文，小差可留模型取舍）。

## 3. 沉淀落点与建议工作分解

### 3.1 种子与清单同步（先做，有现成缺陷）

- `plugins/dm-dvp/src/knowledge-seeds.ts` 现有 **7 颗种子**（含 2026-11-21.1 新增 `dm-dvp.bulkwrite.scale`），但 `plugins/dm-dvp/knowledge/manifest.json` 仍记 `seeds: 6`——**清单与种子已不同步，需重生成/对账**。
- 种子合同与格式见 [KNOWLEDGE-AGENT-CONTRACT.md](KNOWLEDGE-AGENT-CONTRACT.md)；种子走窄声明（claims 与 topics 见既有 7 颗的写法）；`DVP_SEED_VERSION` 递增。
- 新会话写入前先核对：knowledge-seeds.ts / manifest.json / knowledge-validators.ts / application.json / tests/knowledge.test.ts 均有**未提交改动**（一部分来自另一会话的知识代理工作，一部分来自本次 bulk 升级）——遵守单写入者规则，先理清范围再动。

### 3.2 建议新增/升级的种子候选（供起草，按合同定稿）

| 候选 id | 内容要点 | topics |
|---|---|---|
| `dm-dvp.conventions.evidence`（新增） | §9.1 惯例清单中已实证项的状态升级：请核实句尾、三型差异模板、ID 主体、Add/Delete/Update 基线全空、零编造——附 v1.1 对标数值作证据 | template |
| `dm-dvp.classification.visit-matrix`（新增，对应差距 1） | 访视-表单矩阵归 Matrix 页、`DYN_VISIT_*`、新增form 放条件数据表单；Dynamic Visit 严格少用；跨页归类是模型侧识别决策，插件不代劳 | template, design |
| `dm-dvp.id.matrix-suffix`（新增，对应差距 2） | 跨周期访视规则 ID 带矩阵后缀（`SV_` 系）；同为开放问题：v1.1 命中 10/49 | template |
| `dm-dvp.text.density`（新增，对应差距 4） | 【表单.字段】记法仅跨表引用时用；「注：」注释用法；「请核查」为「请核实」的合法变体 | template |
| `dm-dvp.bulkwrite.scale`（升级现有） | 补充实证数据：8 NDJSON 实测、documentJson 0.8KB 级、`templateDirectory` 误传自愈案例 | writer, template |
| `dm-dvp.template.knobs`（新增） | 旋钮决策范式：模型按实物形态自选（实证：editChecksQueryType=false 匹配 8 列）；静默套默认视为缺陷；汇报须含取值与依据 | template, writer |

### 3.3 文档与「公共规则标准库」定位

- [DVP-TEMPLATE-SCHEMA.md](DVP-TEMPLATE-SCHEMA.md) §9.1–9.4 已承载全部蒸馏事实（惯例/实物形态/v1.0 差距/v1.1 对标），本阶段主要是把 §9.4 结论回写进 §9.1 的状态（已实证 vs 待验证），不要重复建文档。
- 「公共规则=标准库自然来源」：惯例种子（三型模板、ID 约定、零编造、归类口径）应写成 **EDC 无关的公共知识**（不绑 Rave 术语的先抽象、Rave 实例作注脚），为多 EDC 迭代（路线第四阶段）供料。是否落成独立公共种子文件 vs 留在 dm-dvp 种子内，由新会话按 [DSH-ENTERPRISE-KNOWLEDGE-DELIVERY-PLAN.md](DSH-ENTERPRISE-KNOWLEDGE-DELIVERY-PLAN.md) 的分层判断。
- 沉淀后跑 `scripts/verify-all.cjs`（项目支持的 Node 版本）；PostToolUse 钩子会在每次 Write/Edit 后自动跑规范检查，当场修。

## 4. 可复用配方（过程知识，同样值得沉淀）

- **对比脚本**：`.runtime/dvp-compare/compare1.py`（结构统计，GEN/STD 双侧安全）、`compare2.py`（ID 范式/表头）、`compare3.py`（文本范式聚合）。**坑**：compare3 的 GEN 侧列偏移是 v1.0 九列时代写的（7,8）；v1.1 八列布局须用 dcol=6, lcol=7，本次已用一次性脚本绕过，脚本本身未改。
- **写簿实证配方**：mtime vs bridge.log write 调用时间戳（`grep -n "write_workbook" bridge.log`）+ `Get-FileHash` + zip 条目指纹（有无 docProps/core.xml 区分 openpyxl 与插件 JS 写簿）。
- **续跑驱动**：`.runtime/wuxigpt-bridge/dvp-v11-run1.mjs`（last-token.tmp URL → #/detail/<workId> → 进入对话 → 输指令 → 10s 轮询，3 连拍判完成、审批自动拒绝、bridge.log 字节偏移跟踪工具行）。
- **桥接**：WuXi 桥 127.0.0.1:15721（[[wuxigpt-workmate-bridge]]，cookie 24h）；工作会话 a0ea1cd7 / 工作 cfb0e70b「ATG DVP 生成」；工作台重启后 token 失效，须从 UTF-16LE 日志 `iconv` 提取新 token。

## 5. 红线（全部继续有效）

1. **§8 数据边界**：规则原文/差异文案/访视-表单清单/Cover 正文不进 repo、不进上下文；只看统计量。工作区 `_tmp/bulk` 等 NDJSON 是临床衍生数据，**不得**复制进仓库。
2. **插件通用性边界**：插件只供能力（bulk、旋钮、校验），方案/ALS 识别、惯例取舍、模板形态选择一律模型侧推理；不得为对齐某个真实 DVP 在代码里写死项目逻辑。
3. **不写死权限/ACL**：可选权限控制是配置面，不是代码常量。
4. **隔离工作区**：`D:\project\company\epro\Project\ATG-DSH-DVP`（1-Protocal 方案 + 2-ALS 600MB 导出 + 4-Data Validation Plan 标准）；不允许读取/操作其他目录。
5. **交付纪律**：未经请求不提交/推送；未通过的实现不得报告为合规/已验证；verify-all 过门禁才算交付前提。
6. **单写入者**：见 3.1 的未提交清单。

## 6. 文件地图

| 内容 | 路径 |
|---|---|
| 模板 schema + 惯例蒸馏（§9.1–9.4） | `docs/DVP-TEMPLATE-SCHEMA.md` |
| 知识合同 / 交付计划 | `docs/KNOWLEDGE-AGENT-CONTRACT.md`、`docs/DSH-ENTERPRISE-KNOWLEDGE-DELIVERY-PLAN.md` |
| DVP 研究底稿 | `docs/DVP-GENERATION-RESEARCH.md`、`docs/DVP-DM-PRACTICE.md` |
| dm-dvp 种子源 / 清单 | `plugins/dm-dvp/src/knowledge-seeds.ts`、`plugins/dm-dvp/knowledge/manifest.json` |
| 插件 bulk+旋钮实现 | `plugins/dm-dvp/src/input.ts`、`write.ts`、`index.ts`；测试 `tests/write.test.ts` |
| 隔离工作区（临床衍生数据，勿入仓库） | `D:\project\company\epro\Project\ATG-DSH-DVP`（v1.0/v1.1 工作簿、`_tmp/bulk/*.ndjson`、`_tmp/ndjson/` ALS 元数据） |
| 对比/核验/驱动脚本 | `.runtime/dvp-compare/`、`.runtime/wuxigpt-bridge/` |
| 相关记忆 | `atg-dvp-generated`、`dvp-company-conventions`、`dvp-training-roadmap`、`knowledge-p0-implementation`、`enterprise-knowledge-agent-per-plugin` |
