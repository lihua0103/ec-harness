# @ec-clinical/dsh-dm-dvp

临床数据管理 DVP（数据核查计划）内容生成插件：方案 PDF 文本层读取、公司 DVP 模板工作簿
解析/写出、fire-when 逻辑校验与目标 EDC 渲染、测试用例候选、方法知识沉淀。
模板结构与实例测量（TAISHAN-304 V2.0）见仓库根 `docs/DVP-TEMPLATE-SCHEMA.md`；
方法研究见 `docs/DVP-GENERATION-RESEARCH.md`。版本 0.3.0（2026-11-11 整改：ObjStm 页对象修复、真分页、
知识claims语义、公共平台包独立装入）。

## 工具（11 个）

| 工具 | 作用 |
| --- | --- |
| `dm_dvp_status` | 版本、模板 schema 依据、数据边界、知识种子状态与候选纪律 |
| `dm_dvp_read_protocol` | 读方案 PDF 文本层（语言随项目，window 页区间）；扫描件 NEEDS_OCR、加密拒绝、缺 ToUnicode 以 U+FFFD 占位并计数；解析 /Type /ObjStm 压缩页对象，页树声明数与实际页数不一致时显式告警 |
| `dm_dvp_overview` | 列出 workbook 全部 sheet 及角色分类（含 Cover）；不读任何单元格 |
| `dm_dvp_parse_workbook` | 解析为规则 IR：跨字段规则（fire-when 结构化解析）、字段级规格、人工评审、动态、版本历史 + 逐条诊断；`limit` + `section`/`offset` 真分页，`paging.nextOffset` 续读，`total` 覆盖全量 |
| `dm_dvp_validate_rules` | 规则完整性诊断 + fire-when 结构化解析（只报诊断，不改语义） |
| `dm_dvp_suggest_cases` | 正例/反例/恰边界用例候选；解析不出结构的逻辑降级 unresolved 交人工 |
| `dm_dvp_render_checks` | fire-when → Rave 风格检查步骤（rave-steps）或通用表达式（generic-expression）；结果 RENDER_REFERENCE_ONLY，混合嵌套/复合 NOT 显式标记人工确认 |
| `dm_dvp_write_workbook` | 规则 IR → 公司模板结构 DVP 草稿工作簿（8 sheet）；TEST CASE/DM/DBD Comments 永远留空；输出路径限 directory 内，默认拒绝覆盖 |
| `dm_dvp_methods` | 检索 DVP 方法知识种子（template/firewhen/protocol/uat/cases）；种子为 CANDIDATE |
| `dm_dvp_knowledge_capture` | 沉淀已核实的纠错方法为 CANDIDATE（前提/反例/来源必填；`claimsCsv` 写可由验证器复现的断言） |
| `dm_dvp_knowledge_validate` / `dm_dvp_knowledge_events` | 跑已安装验证器（固定用例）；仅当候选声明的全部 claims 被套件覆盖且通过才转 ACTIVE，否则保持 CANDIDATE 并记录 `TOOL_REGRESSION_ONLY` / 未覆盖 claims / 读事件 |

内置 bundled skill `dm-dvp`：方法流程、fire-when 方言要点、四枚举 Query Type 与边界纪律。

## 数据边界（不可协商）

- Cover sheet 内容**永不读取**；Approval 签署内容不读取；
- Manual Review for Programming 的 TEST CASE 受试者号与 DM/DBD 评审意见**只计数、不回传**；
- 未识别 sheet 只记录存在，不读取内容；
- 方案 PDF 只读文本层：扫描件 NEEDS_OCR（不做 OCR、不凭图猜内容），加密 PDF 拒绝；
- 全部生成物是候选（CANDIDATE），不是已验证 DVP；不伪报验证结果；渲染结果是配置参考，不写生产 EDC；
- UAT 用例留档遵循公司流程：由项目团队在 Manual Review for Programming 行内 TEST CASE 区执行归档。

## 安装与验证

```bash
cd plugins/dm-dvp && pnpm install
```

```bash
cd plugins/dm-dvp && PATH="/d/package/Nvm/nvm/v24.9.0:$PATH" npm run verify
```

verify = typecheck（tsc --noEmit）→ test（node:test + tsx）→ build（esbuild 单文件 bundle）。

## 发布候选包

```bash
cd plugins/dm-dvp && PATH="/d/package/Nvm/nvm/v24.9.0:$PATH" node scripts/release.mjs build <candidate.zip>
```

```bash
cd plugins/dm-dvp && PATH="/d/package/Nvm/nvm/v24.9.0:$PATH" node scripts/release.mjs verify <candidate.zip>
```

```bash
cd plugins/dm-dvp && PATH="/d/package/Nvm/nvm/v24.9.0:$PATH" node scripts/release.mjs approve <candidate.zip> <approved.zip> "<provenance>"
```

候选包 = host 单 bundle（运行时依赖 fflate/yauzl/fast-xml-parser 已捆绑，DSH peer 服务由宿主
固定版本提供）+ release-manifest.json（源码清单、校验和、upstream commit、CANDIDATE 状态）。
`licenses/` 版本化捆绑依赖的许可证文本，构建不依赖可变的 node_modules。写文件一律 flag `wx`
（绝不覆盖）。**候选完整性 ≠ 部署批准 ≠ 业务验收**：state 恒为 CANDIDATE，
productionDataEnabled 恒为 false，approve 只改 distribution 标记并记录操作者来源。

## 复用与依赖

- Workbook 读取复用平台公共包 `packages/platform-workbook`（不含任何业务插件源码引用）；知识服务由独立 bundle
  `packages/platform-knowledge` 提供，DVP 只通过 `clinicalKnowledge` 注入使用。`tests/independence.test.ts`
  锁定 DVP 不依赖 dm-listing 并可单独装配。
- 入参 `rulesJson` 接受规则数组或 `{crossField:[...]}`，宽容归一；垃圾输入显式报错码。
