<!--
> **状态横幅(2026-08-28 晚)**:本文 P0-1/P1-1/P1-2/P0-4 已于当日闭合;P1-4(python 解析)
> 与通用车道绕过问题已由 ADR-0007 批次修复(PLUGIN_SYSTEM_AUDIT_20260828.md §修复记录)。
> 现行数据边界、doc 全量读取、stdout 与开关口径以 ADR-0010 为准。
-->
# 数据拦截功能全面审计（2026-08-28）

审计对象：当前签出分支 `feat/clinical/harness`（企业骨架 + listing 红线，2026-08-27 V2 场景化红线重构）为主，`feat/data-egress-switch-refactor`（emerald-clinical-data-guard v2）为对照。
方法：全链路通读源码（JS 挂点层 + Python worker/红线层/沙箱层），所有结论附 file:line 一手证据；行为语义经 `redaction.test.ts` 交叉验证。

---

## 一、现状：三套互不相连的"拦截"，只有一套真的在拦

| 组件 | 位置 | 状态 |
|---|---|---|
| **listing 红线**（唯一生效） | `packages/enterprise/listing/python/redact.py` + `worker.py` | 按数据源头投影：sas→元数据、spec→结构+200字预览；`redactDisabled=true` 全放行 |
| tool-audit 拦截器 | `packages/enterprise/tool-audit/src/data-interceptor.ts:36` | **空函数**。`apply(_ctx)` 注册了 `tools/pre-execute` 类型声明但什么都不做 |
| ui-settings 数据安全服务 | `packages/enterprise/ui-settings/src/data-security-service.ts` | UI 开关 + `protectedPatterns` 配置已实现，但**无任何消费者**（死接线） |
| emerald v2（对照） | `feat/data-egress-switch-refactor` 分支 | 未迁移。tools/post-execute 投影 + llm/stream 正则出域门 + HMAC 收据验签 |

红线核心实现（redact.py）本身是**机械正确的**：`_source` 源头标注（source_registry.py）→ 白名单键投影（METADATA_KEYS / STRUCTURE_KEYS）→ `_walk` 递归、未标记子树对象恒等不动。inspect 的 `dataset_payloads` 带 sample（head 3 行真值）但被投影剥除，spec 的 content 被 200 字预览替换。run_code 回执由程序构造（rowCount/columns/dtype/nullCount 信封），不经数据面。这部分符合"程序只做机械交付"的最高原则。

---

## 二、缺陷清单

### P0 —— 边界失效类

**P0-1：`redactDisabled` 是模型可设的工具参数，AI 可自行关闭红线。**
`packages/enterprise/listing/src/index.ts:135/160/178` 三个工具的 parameters 都暴露 `redactDisabled`，`execute()` 直通 worker；`redact.py:130` 见真即全放行。`redaction.test.ts:50-70` 明确测试并断言该行为（SUBJ-777 与 spec 全文出域）。模型只需一次 `enterprise_listing_inspect(project, redactDisabled: true)` 即拿到全量行值。若开关本意给用户/部署方，必须移出工具 schema（改 profile / env / DataSecurityService 接线），或经 approval 门。

**P0-2：stdout/stderr 原样回显（各 16KB），沙箱内 `print` 即全量出域。**
`sandbox.py` 模块头与 `worker.py operation_run_code`：stdout/stderr 截 16,384 字符原样进回执。`print(datasets['dm'].to_string())` 一行代码就把全表送进模型上下文。这是 2026-08-27 用户裁决的红线范围（"stdout/AI 产物/错误信息一律不碰"），属**有意决定**，但必须认清其性质：它把"构造性归零出域"降级为君子协定。配套问题：tool-audit 注释声称"systemPrompt 指导模型不要 print 数据"，实际 `index.ts` 的 system prompt 只说"stdout 原样回显"，并无此指导——注释与现实脱节。

**P0-3：通用工具面完全裸奔。**
`data-interceptor.ts` apply() 空转 → harness 自带 read/bash 工具对任何文件零拦截。CSV 是纯文本，AI 不经 listing 工具直接 `read data.csv` 即见全量数据（sas7bdat/xpt 二进制读出乱码只是间接缓解）。红线只护住 listing 三条工具的回执，与 harness 工具面没有闭环。

**P0-4：沙箱丢了 AST 禁用表和路径白名单。**
`sandbox.py` 仅 builtins 白名单（无 `__import__`/`open`），但 `pd.read_csv/read_sas/read_excel` 未禁（老 emerald 的 `code_sandbox.py _BLOCKED_CALLS` + `sandbox_runner.py DatasetRegistry._ALLOWED_DATA_DIRS` 在骨架重构中丢失）→ 沙箱内可读盘上任意文件，配合 P0-2 = 任意文件内容出域。另 `scan_excel_structures(relpath)` 接受 `../` 穿越（只回结构，但越出项目边界）。

### P1 —— 设计/一致性类

- **P1-1 源头标记可被重贴/丢失**：`tag_dataframe` 暴露在沙箱命名空间（sandbox.py build_environment），模型可把 sas DataFrame 重标为 model-output；pandas attrs 在 groupby/merge 等操作后丢失 → 未标记=不碰=放行。source_registry 声称"源头无法绕过（ADR-0019）"，与实现不符。今天因 run_code 回执是程序构造信封而无实害，属埋雷。
- **P1-2 UI 开关死接线**：DataSecurityService 的 `enabled`/`protectedPatterns` 无消费者；用户在设置页关闭"数据安全"什么也不会发生——比没有 UI 更危险（虚假安全感）。
- **P1-3 业务启发式写死**：`worker.py:64-68` scenario 靠项目名子串推断（"medical" in project.name）。
- **P1-4 部署脆弱**：`worker.ts` spawn('python') 硬编码解释器，venv/pyreadstat 落地靠 PATH。
- **P1-5 双实现语义漂移**：emerald v2 与骨架红线共用"listing 红线"一词但语义不同（信封+llm/stream 门 vs 源头投影），文档与记忆存在混用。

### emerald v2 分支独有缺陷（对照简列）

1. `EMERALD_SIGNING_SALT` 默认空 → `_verify_clinical_guard_signature` 恒 false（egress_checkpoint.py:44-49,107-110）→ 收据 HMAC 信任层是死代码；且进程重启后 trustedToken 重生成，历史会话里的已标记收据每轮全量 DLP 重扫。
2. CSV 不在 `EXCEL_DATA_EXTS`（planes.js:36），工作区任意位置的 .csv plane=null → tool-result-guard 第 11 分支原样放行；`isDataExt`/`DATA_DIR_NAMES`（planes.js:29,87）是死代码，数据目录自动检测没接上。
3. bash/命令类工具读**相对路径**数据文件绕过：`SOURCE_PATH_RE`（tool-result-guard.js:40）只匹配绝对路径，`extractPath` 不认 command 参数 → `cat ./dm.sas7bdat` 走第 11 分支原样放行，而 llm/stream 的正则门对二进制内容基本无效。
4. llm/stream 出域门 = 固化正则特征库（CDISC 字段/编号/日期/医学编码/base64 解码/NFKC 归一化）→ 内容形态识别，补丁竞赛史确凿（visit 13 连击、字母前缀编号 108 连击、PDF 访视窗术语误拦均在注释中留有修复记录）。
5. tool-result-guard 存在不可达死分支（`interceptData` 的 else 分支）+ "智能功能始终生效"注释与提前 return 的实际行为矛盾。
6. 一切 .zip 一律 DATA_BLOCKED（连 doc/ 内的 zip 也拦），过度拦截。

---

## 三、"固定死代码识别拦截"审计

**核心车道不是模式识别。** 当前系统拦截主判据是 `_source` 源头 + 白名单键投影（机械、可判别、无补丁竞赛），且已按 2026-08-27 裁决删除全部 PHI/日期/ID 模式兜底（redact.py 模块头明言）。这符合最高原则。

仍存在的硬编码，按违反程度分两类：

**业务判断类（违反"不写死业务定义、最大程度利用 AI 推理"）：**
- `index.ts` systemPrompt 内整段输出标准：RT01 Content Sheet 表头 ["Listing Seq.","Form Name",…]、DM Status Report Cover Page 规范、`__cmp_FLAG__` 审核列族——业务交付规范固化在提示词，本应由 spec 文档驱动或至少抽为配置；
- SCENARIOS 枚举 + 项目名推断（P1-3）；
- `data-security-service.ts` 默认 `protectedPatterns` glob 写死（且是死配置）。

**机械交付类（可接受）：**
- METADATA_KEYS/STRUCTURE_KEYS/PREVIEW_CHARS/MAX_CAPTURE_CHARS 等投影参数；
- SOURCE_POLICY 四源头映射；
- emerald v2 的 patterns.py（定位是 defense-in-depth 最外层，主线是构造性信封，但正则库本身是典型的固定死识别）。

---

## 四、启用拦截后对 AI 识别/推理的影响

默认启用（redactDisabled=false）时：

**不受限**：需求与表头结构理解（columns/dtypes/uniqueCount/横纵多层表结构全量给）；代码迭代（stdout/stderr 原样、错误消息原文、信封反馈 rowCount/dtype/nullCount）；publish 交付闭环；EDC/模板硬识别已删——字段语义推断交还 AI 推理，反而更符合最高原则。

**受限**：
1. 行值零可见（sample 剥除、信封无 min/max/distinct 值）——AI 无法目检数据质量、无法校对数值、无法从值形态推断编码习惯。但注意矛盾：**因为 stdout 是通的，AI 实际可以 print 出来看**——设计想限制而实现没限制住。
2. spec 只给 200 字预览——深层 ALS/spec 语义理解受制。但通用 read 工具没拦，AI 可绕过 listing 直接读 doc/ 全文——又一次"限了个寂寞"。
3. 老系统 v2 启用时限制更多（值不可见 + llm/stream 正则门有误拦史），那是"用 AI 能力换安全"；当前系统几乎不限 AI 但安全面破了。**两头都没站住：问题不在拦截本身，而在拦截面没有闭合。**

---

## 五、修复建议（按优先级）

1. `redactDisabled` 移出工具参数：改 profile/env，或接 DataSecurityService（含 UI），或至少经 approval 门（P0-1）。
2. 恢复全局 `tools/post-execute` 投影——哪怕只按路径域对 csv/文本数据文件生效，让红线覆盖通用工具面（P0-3）。
3. 沙箱恢复 AST 禁用表（read_*/to_*/eval/query）+ allowed_data_dirs 白名单；`tag_dataframe` 移出模型命名空间（P0-4、P1-1）。
4. stdout 策略明确化：要么接受并记录为显式残余风险（审计留痕），要么加最小约束（如禁 to_string/全量 df 打印、截断行数）（P0-2）。
5. DataSecurityService 接线或移除，死 UI 必须处理（P1-2）。
6. 若 emerald v2 的 llm/stream 门要保留：设 EMERALD_SIGNING_SALT、修 CSV 兜底与 bash 相对路径两个洞。

---

*审计基线：工作树（企业骨架未跟踪文件）+ `feat/data-egress-switch-refactor` git show。该仓库 git status 极慢未执行，若有未入视野的未提交修改以工作树实际状态为准。*
