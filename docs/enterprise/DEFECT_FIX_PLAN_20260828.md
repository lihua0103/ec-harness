# 缺陷修复计划(2026-08-28,基于 ADR-0008 全文核对)

- 状态:待执行
- 日期:2026-08-28
- 输入:ADR-0008 全文 + SECURITY_SCAN_20260828.md + PLUGIN_SYSTEM_AUDIT §七 + 用户 2026-08-28 终裁
- 核对方法:文档声称逐项对盘核实;pytest/tsc 沙箱实测;git 索引与磁盘差集比对

## 〇、核对结论(基线健康度)

**已验证为绿(本会话实测)**:

| 项 | 结果 |
|---|---|
| pytest(python/tests 全量) | **160 全绿**(5.13s) |
| 四包 tsc -b(listing/tool-audit/ui-settings/branding) | **零错误** |
| ADR-0008 全部代码声称(GuardedModule/safe_import/IO_WRITER_METHODS 18/literal_cell 九处/back_link 白名单/120 上限/minimalSpawnEnv/WRITE_ONLY_TOOLS/X-DSH-Settings/1MB 捕获上限) | **逐项在盘核实成立** |

**但核对发现两类文档未载明的缺陷**:①用户 2026-08-28 终裁(出域单点)使 ADR-0008 执行安全护栏整体过时;②整个 08-28 工作面(38 个文件)**从未进入 git**,且 G: 挂载上 `git status` 120 秒跑不完,脏状态对用户不可见。

## 一、用户终裁(本计划的最高口径)

> "不管在哪一层,都不限制 harness AI 的代码执行面。始终限制的只有:代码读取的数据行 data 出域。AI 理解 spec → 按 ALS 表单字段 OID 查 SAS → 代码查询/聚合,全程代码执行,只要行值不出域发给 AI 即可。"

即**出域单点原则**:执行面任何一层零限制;唯一红线 = 数据集行值进入 AI 可见回执/上下文。表结构字段(columns/dtypes/rowCount/nullCount/uniqueCount)恒全量可见——此项现状已满足,无需改动。

## 二、缺陷清单与修复动作

### D-1【P0·政策落地】ADR-0008 执行安全护栏退役 → ADR-0009 出域单点

现状:sandbox.py 的 AST 禁用表(read_ 前缀/写出器枚举/双下划线/IO 构造器)、GuardedModule 运行时护栏、safe_import 白名单、builtins 白名单,均为执行面限制,与终裁冲突。

**退役**(删除):SANDBOX_BUILTINS 白名单 dict → 标准 builtins;safe_import/IMPORTABLE_MODULES → 真 `__import__`(os/sys/subprocess 可用);GuardedModule → 裸 pd/np;assert_code_allowed 与全部 BLOCKED_* 名单 → 删除;AST 检查整体移除。

**保留**(全部是出域/交付物/健壮性控制,不是执行面):data_guard.sanitize_receipt 投影(唯一出域口)、dataset-guard 通用车道护栏(挡"generic 工具把数据集原文拉进上下文"这一出域通道)、Excel literal_cell/hyperlink 转义(V-2)、minimalSpawnEnv(V-3,不交出宿主凭据,不限制代码)、回执 120 字符上限(V-4)、捕获流 1MB 上限+truncated(V-7a)、back_link =HYPERLINK 白名单(V-8)、datasets 注入与 list_files/scan_excel_structures 围栏化助手(便利 API,可绕过非强制)。

**联动改**:test_sandbox.py 重写(六条 V-1 逃逸链回归用例删除——防线按终裁退役;新增执行自由用例:`import os`、`open()` 项目内读写、`pd.read_sas`、`df.to_csv` 项目内全通;投影/捕获上限/注入用例保留);index.ts 系统提示(L117"禁止 to_excel/to_csv"、L160 import 白名单段、L163 阻断面清单段)重写为出域单点口径+交付纪律建议(交付仍走 publish,stdout 勿打印行值——纪律性,非硬限制);sandbox.py ENVIRONMENT_HINT 重写;worker.ts 系统提示同口径。

**文档**:新增 adr/0009-egress-only-execution-freedom.md(决策/取代 ADR-0008 决策 1 与修订 1-3 的执行面部分/风险登记 R-1~R-3/保留项清单);SECURITY_SCAN_20260828.md 增 §六"第三轮:政策反转记录";ADR-0008 加取代横幅;CHANGELOG 记批次。

**验收**:pytest 新基线全绿(数目会变,以全绿为准);执行自由四探针全通;投影用例零回归;inspect 元数据白名单不变;开关语义不变(开=投影+车道拦,关=零拦截,执行面恒不被任何开关触碰)。

### D-2【P0·版本控制】38 个未追踪文件 + D-3 六文件 378 行改动,整体未提交

未追踪清单(全文见附录 A):ADR-0005/0006/0007/0008、SECURITY_SCAN/PLUGIN_SYSTEM_AUDIT/DATA_GUARD_PLUGIN_DESIGN/DATA_INTERCEPTION_AUDIT 四份、python 层 22 个核心文件(data_guard/sandbox/discovery/source_registry/excel 五件/tests 十二件)、dataset-guard.ts+dataset-guard.test.ts、listing data-guard.test.ts、ui-settings data-security-config.test.ts。已追踪未提交:worker.ts/index.ts/branding.ts/data-security-service.ts/settings-page.ts/tool-audit index.ts(378 insertions)。

风险:一次 `git clean -fd`/换机/误操作即全失;`git status` 在 G: 挂载不可用(120s 超时),用户当前**看不到**自己的脏状态。

**动作**:先于一切代码改造,按具体路径 `git add`(附录 A)提交 as-is 基线——把"160 全绿的 V-1 加固态"入库,作为 D-1 政策反转的**可回退点**。profiles/ 三个运行时文件(.credentials.yaml/enterprise/cordis.yml/settings.yaml)已被 .gitignore 正确覆盖,不会入库。

### D-4【P1·索引脏项】两处"盘上已删、索引未记"

packages/enterprise/ui-settings/doc(无扩展名旧交付清单)与 scripts/commit-changes.bat——`git add -A` 或显式 `git rm --cached` 随 D-2 批记录删除。

### D-5【P1·杂物】清单(核对后仍存)

docs/enterprise/file_show (6).xlsx;scripts/brand-diagnosis.js;branding/src/branding.ts.backup;退役 shim 三件(listing python/redact.py、python/tests/test_redact.py、src/redaction.test.ts);python/styles/ 整目录(git rm,功能已由 excel/style_atoms.py 接管);五包 lib/ 内 5 个陈旧 *.test.js(branding×2/tool-audit/ui-settings×2,或 `pnpm run clean` 重建)。shim 删除后 data_guard.AUX_EXCEL_KEYS 兼容别名一并退役(注释更新)。start.mjs.backup/.new 已被用户删除,无需处理。

### D-6【P1·验证债·Windows 侧]

`pnpm run check:all`(8 步,沙箱跑不了 oxlint/vitest——esbuild/原生二进制);`scripts/start.bat` 实点 + ADR-0007 §验证四步端到端(inspect 见 doc/ xlsx 单元格值/shell 读 .sas7bdat deny 且引导回 listing/关开关放行/run_code 中文错误不乱码)。D-1 落地后四步口径以 ADR-0009 重述(沙箱执行面全开,第②步语义不变)。

### D-7【P2·文档债】过时交付文档收口

候选(LISTING_IMPLEMENTATION_REPORT/FINAL_STATUS_REPORT/IMPLEMENTATION_STATUS/LISTING_RECOVERY_REPORT/BUILD_VERIFICATION_REPORT/DATA_SECURITY_SUMMARY/DATA_SECURITY_DELIVERY/DATA_SECURITY_IMPLEMENTATION/LISTING_PROBLEM_SOLUTION/LISTING_QUICK_REFERENCE 等):统一动作 = 加"已过时,现行口径见 ADR-0007/0009 与 README"横幅归档;确无历史价值者径删。执行时逐份核横幅存量,避免重复。

### D-8【P2】CODEOWNERS L31 `/packages/enterprise/auth/` 死条目(包已不存在);runbooks/PLUGIN_DISTRIBUTION.md L21/L23 auth 残留示例改 ui-settings/listing 实形。

### D-9【P2】ADR-0004 编号冲突正式归档

0004-listing-session-log.md(无横幅)与 0004-data-security-toggle.md 并存。建议:session-log 移 docs/enterprise/adr/archived/ 保留原文并加横幅说明编号让位(不改号,避免 0009/0010 占用冲突);toggle 版横幅的"现行口径见 ADR-0006"链补 0007/0009 指向。

### D-10【P3】CHANGELOG.md 偏移 6181 处 1 个 NUL 字节(grep 判二进制,破坏可检索性)——删除该字节。

### D-11【P3】ADR-0008 验证节数字勘误(153→160→D-1 后再变):ADR-0009 落地时以修订注记统一,不改历史正文。

## 三、刻意不做(维持既定裁决,新 ADR 重申)

stdout 原样回执(打印行值通道 = 既定接受,调试刚需,非对抗威胁模型);publish/通用工具内容级判定(违背源头判定);run_code 进程内墙钟(V-7 已裁决,TS 900s 兜底);通配符形态拦截(`ls *.csv` 误伤)。

## 四、风险登记(ADR-0009 §接受项)

R-1 执行面全开后的宿主破坏面(幻觉性 rm -rf/越项目写文件)——终裁接受,系统提示纪律+TS 900s 粗粒度兜底;R-2 stdout 打印行值(维持既定接受);R-3 网络出域(urlopen 等)不再封——非对抗威胁模型。回退保证:D-2 批0 的 as-is commit 即 ADR-0008 加固态,随时可 revert。

## 五、执行批次

| 批 | 内容 | 执行环境 |
|---|---|---|
| 0 | D-2/D-3 基线提交(先入库再动代码) | 沙箱(按路径 add,避开全仓 status) |
| 1 | D-1 出域单点改造(sandbox/测试/提示词/ADR-0009/SECURITY_SCAN §六/CHANGELOG) | 沙箱(pytest+tsc 复验) |
| 2 | D-4/D-5/D-10 索引脏项+杂物+NUL | 沙箱(删除需用户批一次文件删除权限) |
| 3 | D-7/D-8/D-9 文档债 | 沙箱 |
| 4 | D-6 Windows 收口:check:all、start.bat 四步、终批 commit | 用户侧(命令清单见附录 B) |

## 附录 A:未追踪文件全清单(38)

docs/enterprise/:DATA_GUARD_PLUGIN_DESIGN_20260828.md、DATA_INTERCEPTION_AUDIT_20260828.md、PLUGIN_SYSTEM_AUDIT_20260828.md、SECURITY_SCAN_20260828.md、adr/0005-listing-v2-scenario-redline.md、adr/0006-data-guard-two-rules-host-switch.md、adr/0007-dataset-only-redline-and-lane-guard.md、adr/0008-sandbox-runtime-guard-excel-neutralization.md;

packages/enterprise/listing/python/:data_guard.py、discovery.py、redact.py(批 2 删)、sandbox.py、source_registry.py、excel/{__init__,build_workbook,layout,style_atoms,templates}.py、tests/conftest.py、tests/test_{data_guard,discovery,excel_exact_contract,excel_layout,excel_templates,formula_neutralization,mutation_hardening,redact(批 2 删),sandbox,source_registry,worker_dispatch}.py;

packages/enterprise/listing/src/:data-guard.test.ts、redaction.test.ts(批 2 删);

packages/enterprise/tool-audit/src/:dataset-guard.ts、dataset-guard.test.ts;

packages/enterprise/ui-settings/src/:data-security-config.test.ts。

## 附录 B:Windows 侧命令清单(批 4)

```
cd /d G:\home\dsh-guard
pnpm install
pnpm run check:all
scripts\start.bat   # 实点 ADR-0007 四步(以 ADR-0009 口径复验)
git add -A && git commit -m "ADR-0009 出域单点:执行面放开,杂物清理,文档债收口"
```
