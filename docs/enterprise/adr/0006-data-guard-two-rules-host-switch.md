<!--
> **修订横幅(2026-08-28)**:本文决策 1 中的场景②(aux-excel 投影)与决策 3 的"通用工具面零实现"表述
> 已被 ADR-0007 修订——doc/ 零拦截、红线收敛为 dataset 单规则、通用车道经 tool-audit
> pre-execute 护栏拒绝数据集路径引用。开关宿主侧/fail-closed/审计等其余决策不变。
-->
# ADR-0006: 数据拦截两规则口径与宿主侧开关（修订 ADR-0005 的红线部分）

- 状态：已接受（已实施）
- 日期：2026-08-28
- 负责人：enterprise 团队
- 影响范围：`packages/enterprise/listing`（python + src）、`packages/enterprise/ui-settings`、`packages/enterprise/tool-audit`、`docs/enterprise/LISTING_MULTI_SHEET_SPEC.md`
- 依据：用户 2026-08-28 澄清 + `DATA_INTERCEPTION_AUDIT_20260828.md`（缺陷编号沿用）+ `DATA_GUARD_PLUGIN_DESIGN_20260828.md`（设计）

## 背景

ADR-0005（2026-08-27 V2 场景化红线）上线后，审计发现 P0 级问题：
`redactDisabled` 作为**模型可设的工具参数**暴露（P0-1），AI 一次调用即可
关闭红线自取全量行值；同时用户于 2026-08-28 再次澄清最终口径：doc/ 文本
本就要求全量读（200 字预览投影反而妨碍需求理解），拦截只需要"数据集行值"
与"辅助 Excel 单元格值"两种场景，开关应属宿主而非模型。

## 决策

1. **两条投影规则**（`python/data_guard.py`，取代 redact.py）：
   - `dataset`（sas7bdat/xpt/csv 含归档解出）→ 元数据白名单
     `name/path/columns/rowCount/dtypes/nullCount/uniqueCount`；
   - `aux-excel`（doc/ 下 xlsx/xls/xlsm）→ 结构白名单
     `path/type/size/structure/mappings/datasets`。
   doc/ 文本标记 `spec-document` 但**不在投影表** = 全量直通；
   `model-output` passthrough（对象恒等）。无 200 字预览、无模式扫描。
2. **宿主侧开关**（修 P0-1）：三工具 schema 删除 `redactDisabled`；
   `DataSecurityService`（ui-settings 设置页，原死接线 P1-2 接活）是唯一
   开关本体；listing 入口每次调用读 `isEnabled()` 并以 `dataInterception`
   旗标下发 worker（免重启）；**缺省/failure 一律按开**（fail-closed）；
   关闭 = 零拦截（回执一字不改）。
3. **构建期节流**（不建再剥）：开关开时 `sample` 行样本与 xlsx `rows`
   根本不构建；投影层保留作双保险（覆盖 sandbox 旁路载荷）。
4. **沙箱执行安全加固**（P0-4/P1-1，独立于开关）：`tag_dataframe` 移出
   模型命名空间；`list_files`/`scan_excel_structures` 限项目根内
   （`../` 越界 `ESCAPE_PROJECT_ROOT`）；AST 禁用表按名阻断
   `read_*/to_*/eval/query`（合法数据已全部经 `datasets` 注入，沙箱内
   文件 IO 无正当用途）。
5. **审计 JSONL**：worker 投影发生时写 `.clinical-listing/audit.jsonl`
   （时间/操作/开关态/被投影载荷 source+path，无任何数据值）；开关
   toggle 由 DataSecurityService 写 `profiles/enterprise/.data-audit.jsonl`。
   审计写失败不阻断（投影才是防线）。
6. **配置降级**（P1-2 附带）：ui-settings 旧 `protectedPatterns` glob 死
   配置删除，改为 `datasetExtensions`/`auxExcelExtensions`（默认与 python
   侧扩展名集合对齐）。
7. **tool-audit 空拦截器退役**：`tools/pre-execute` 空函数与误导注释
   删除；通用工具面的管控不属本插件（见"不采用"）。

## 不采用的方案

- 保留 `redactDisabled` 工具参数 + approval 门：模型可见面仍在，不如彻底
  移出 schema。
- `tools/pre-execute` 通用拦截（审计建议 2 / P0-3）：拦截式设计要穷举攻击
  面；通用工具面（read/bash）属 harness 执行安全域，由沙箱/权限插件负责，
  不在本插件偷加（设计 §5.2）。
- stdout 脱敏（P0-2）：维持 2026-08-27 裁决——sandbox 内 AI 操作不构成
  "出域到 AI"，显式接受为已知边界（威胁模型 = 非对抗 AI）。
- llm/stream 出域门（emerald v2 路线）：内容形态识别 = 补丁竞赛，不复活。

## 数据与安全

- 默认形态下 AI 可见：doc/ 全文、数据集元数据、Excel 结构（表头带含首批
  ≤2 行——多层表头识别需要，显式接受）、ALS 三元组、自身产物与 stdout。
- 开关关闭是宿主显式授权的数据出域（样本 3 行 + 整表 rows + 全文本就
  全量直通），toggle 与投影均有审计留痕。
- 沙箱执行安全（builtins + AST + 围栏）不受开关影响。

## 升级影响

- 上游 Harness 无改动。listing 工具对外 schema 收窄（少一个参数，向后
  兼容）；回执新增 `dataInterception` 观测字段与 audit.jsonl。
- `redact.py`/`tests/test_redact.py`/`src/redaction.test.ts` 转为退役 shim
  （G: 挂载无法 unlink；Windows 侧可删）。
- 既有 Excel 模板/输出契约不受影响（ADR-0005 §模板部分继续有效，本 ADR
  只修订其"数据红线"小节）。

## 后果

P0-1（模型自关红线）与 P1-2（死开关 UI）闭合；拦截面从"内容猜测"彻底
收敛为"两条来源规则"，AI 在默认形态下保有写代码所需的全部结构信息与
doc/ 全文。残余边界（stdout print、通用工具面）显式记录于设计 §5，待
各自独立决策。
