# 插件系统合规审计报告(2026-08-28)

审计对象:`feat/clinical/harness` 分支 `@dsh-enterprise/platform` 骨架 + 4 个企业插件(ui-settings / tool-audit / branding / listing)。
审计基准:README、ADR-0001~0006、CODING_STANDARDS、PLUGIN_ARCHITECTURE、DEVELOPMENT_WORKFLOW、DATA_GUARD_PLUGIN_DESIGN_20260828。
验证手段:全量源码阅读 + `python3 -m pytest python/tests`(137 passed, 13.9s)+ `check-architecture`(4 插件/6 Bundle 层,过)+ `check:secrets`(过)。

---

## 一、总体结论

**主链路是健康的,外围是欠账的。**

- 装配契约(ADR-0001)执行良好:4 包 manifest/files/exports/patch row/link:/bundles 顺序全部合规,门禁真实有效。
- listing 插件的数据红线与 2026-08-28 两规则口径一致:PROJECTION 单点定义、源头标注不可被模型重贴(P1-1 闭合)、开关宿主侧 fail-closed(P0-1 闭合)、AST 禁用表+项目根围栏(P0-4 闭合)、构建期节流、审计记录无数据值。
- no-hardcode 最高原则大体遵守:规范以"驱动 AI 的材料"形态进 system prompt 与 inspect 回执;模板可跳过(`_skip_default_template`/`_layout`);程序只做机械交付。
- 但实战日志(见 §五)暴露了一个**体系级缺口**:红线是"listing 车道级"而非"系统级",模型可经通用 shell 合法绕过;且"spec 内容住在 xlsx 里"被场景②误伤,直接诱发了这次绕过。

---

## 二、架构与装配合规(通过项)

| 检查项 | 结果 |
|---|---|
| 企业边界(不碰 upstream/submodule) | ✅ check-architecture 通过,无泄漏 |
| profile 独立 pnpm 根 / bundles 顺序(web-app 之后) | ✅ |
| 包 manifest 全项(private/type/files/exports/dsh.bundle.patch) | ✅ 四包齐 |
| row id `enterprise-` 前缀 + name 与包名逐字一致 | ✅ |
| 插件自动发现(enterprise-plugins.mjs,零包名硬编码) | ✅ |
| listing 三工具 schema 无 `redactDisabled`(P0-1) | ✅ 已闭合 |
| `interceptionEnabled()` 软依赖 + `?? true` + try/catch(fail-closed) | ✅ src/index.ts:66-72 |
| worker 缺省 `dataInterception=True`(fail-closed) | ✅ worker.py:51 |
| `tag_dataframe` 不进 sandbox 命名空间(P1-1) | ✅ sandbox.py:69 |
| 审计 JSONL 无数据值(source+path) | ✅ |
| pytest 基线 | ✅ 137 passed |

---

## 三、问题清单(按严重度)

### A. 体系级(需要决策,不是改代码)

**A-1 红线是车道级,不是系统级(P0-3 边界需重新上桌)**
实战日志:模型在 listing 车道内拿不到 Manual Review 单元格值后,改用 harness 通用 shell(pwsh + 系统 Python,pandas/openpyxl/xlrd 齐备)直读 xlsx 并导出到工作文件——零拦截、零审计留痕。通用 shell 同样能直读 sas7bdat/xpt/csv。即:数据红线实际效力 = 仅 listing 三工具回执。此前"通用工具面不拦属执行安全域"是明示接受的边界,但实战证明**模型会在合法需求驱动下主动绕过**,原威胁模型(非对抗 AI 不主动绕)在"车道挡住合法需求"时不成立。可选方向:(a) 部署层收窄 harness shell 权限(宿主配置);(b) 在 harness 层加路径出域检查(超出插件边界,需新机制);(c) 明示接受并文档化"红线仅覆盖 listing 车道",同时在系统提示声明数据访问纪律。

**A-2 "spec 住在 xlsx 里"被场景②误伤(规格缺口)**
两规则按**路径归属**判定:doc/ 下 Excel 一律 aux-excel、单元格值剥除。但 DVP Manual Review 这类**规格正文**也常以 xlsx 交付——被当成数据拦掉,模型在合规车道内无法完成工作,直接诱发了 A-1 的绕过。修复方向:host 侧配置 spec-excel 白名单(文件名/路径 glob,进 `.data-security.json`,与现有 `datasetExtensions` 同层),**不得**做成模型可设参数(重蹈 redactDisabled)。这同时兑现 ADR-0006 决策 6 没接完的线(见 B-3)。

### B. 缺陷类(快赢,建议尽快修)

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| B-1 | spawn 无 UTF-8 环境 + `python` 解析硬编码 | listing/src/worker.ts:73 | 实战中文错误全部 GBK 乱码("代码执行失败"→"??????ִ??ʧ??")。修:`spawn(env:{...process.env, PYTHONUTF8:'1', PYTHONIOENCODING:'utf-8'})`;Windows 加 `py -3` 兜底(即 P1-4) |
| B-2 | sandbox builtins 过瘦 | sandbox.py:31-39 | 缺 `Exception`/`ValueError` 等异常类(逼模型写裸 `except:`)、`dir`/`repr`/`map`/`filter`;`hasattr` 有而 `getattr` 无(不一致)。实战 6 连败才摸清环境。另建议 run_code 回执附"环境可用名清单"(信息供给原则,一次调用省 N 次试错) |
| B-3 | 扩展名配置死接线 | ui-settings `datasetExtensions`/`auxExcelExtensions` vs discovery.py:26-27 | 宿主可配、GET 可见,但 worker 判定用独立硬编码集合——改配置零效果。ADR-0006 决策 6 只完成一半。修:开关/配置随 request 一并下发 worker |
| B-4 | ui-settings 丢弃 register disposer | ui-settings/src/data-security-service.ts:80,:95 | 插件卸载后两条路由残留,违反"注册必须可卸载"(branding 是正确示范) |
| B-5 | 审计写失败被静默吞 | data-security-service.ts:113 `.catch(()=>undefined)` | 设计文档 §3.4 要求记 stderr,未兑现 |
| B-6 | branding 半兑现 ADR-0002 | branding/src/branding.ts | `/favicon.svg` 无人服务(客户端指向 404 破图);index-inject 注入行、`validateBrandingConfig`(1..80/1..24)、`DSH_BRAND_*` env 兜底、manifest 白标全部未做;`brandName` 无转义内插进 `<title>`/meta/`<script>`(注入向量)。合规版实现躺在 git-ignored 的 `branding.ts.backup`(截断,不可编译) |
| B-7 | 设置页文案过时 | settings-page.ts:166-169 | 仍按旧 ADR-0004 glob 目录语义描述,漏 .csv、夸大覆盖面,与 ADR-0006 口径矛盾 |

### C. 流程与卫生类

| # | 问题 | 说明 |
|---|---|---|
| C-1 | auth 包移除无 ADR/CHANGELOG | 2026-08-27 `cb68825`(listing P1 修复提交)里整目录删除,提交信息未提 auth。违反 DEVELOPMENT_WORKFLOW §2"非简单改动必须新增 ADR"。残留:README §2/§8、CODEOWNERS、runbooks、ADR-0004、pnpm-lock 仍引用 auth |
| C-2 | ADR-0004 编号冲突 | `0004-data-security-toggle.md` 与 `0004-listing-session-log.md` 同号;前者已被 ADR-0006 实质取代但未标注,内文 API(protectedPatterns/check-file/minimatch)全部不存在 |
| C-3 | 文档系统性漂移 | 7+ 份文档(DATA_SECURITY_GUIDE/IMPLEMENTATION/SUMMARY/DELIVERY、E2E 指南等)仍教已删除 API,照做必失败;README"六道门禁"vs `check:all` 实际 8 步;PLUGIN_ARCHITECTURE §1 仍是早期目录名 |
| C-4 | 树内杂物(Windows 侧删除清单) | `docs/enterprise/file_show (6).xlsx`、`scripts/start.mjs.backup`/`.new`、`brand-diagnosis.js`、`branding/src/branding.ts.backup`、`python/__pycache__/`(含 cpython-310 旧字节码)、退役 shim 三件(`redact.py`/`tests/test_redact.py`/`src/redaction.test.ts`)、`python/styles/` 兼容层(全仓库零引用) |
| C-5 | 运行时状态未 gitignore | `profiles/enterprise/.data-security.json`、`.data-audit.jsonl` 不在 .gitignore,首次 toggle 即脏工作树 |
| C-6 | vitest 双跑 lib | 各包无 vitest include/exclude,`lib/*.test.js` 与 src 双份执行,陈旧产物可能掩盖 src 已改 |
| C-7 | 测试不达 CODING_STANDARDS 最低要求 | ui-settings/tool-audit 仅导出形状断言;无加载/卸载测试;开关行为测试寄居在 listing 包(ui-settings 自身零覆盖) |
| C-8 | tool-audit 空壳 + 死依赖 | apply() 刻意为空(定位"审计消费端"未兑现);inject `dataSecurityService` 但零消费——ui-settings 缺装时反挂载失败;`minimatch` 与 ui-settings 依赖零引用 |
| C-9 | 部署参数写死 | templates.py `REPORT_COVER_LABELS` 硬编码"康德弘翼/WuXi Project ID"申办方名——固定模板是明示例外,但申办方名属部署参数,应挪 cordis.patch.yml config(B10) |
| C-10 | 50K 截断无标记 | discovery.py:32 `MAX_TEXT_CHARS=50_000` 与"doc/ 全量读"口径矛盾——超限时静默截断,回执无 truncated 标记 |
| C-11 | `data-security/changed` 事件零消费者 | 设计文档把它画进开关流,实际无人监听(listing 按次轮询)。要么删,要么 listing 订阅 |

---

## 四、no-hardcode 原则符合度(listing)

**符合**:输出规范以 system prompt 契约 + inspect 信息供给驱动 AI;模板可跳过、layout 可接管;`_als_mappings` 列名识别是尽力提取(miss 时降级为 structure,模型仍可见 headerRows 自行辨认);场景推断(project name)仅作 `inferredScenario` 提示。
**偏差**:C-9(申办方名);`_als_mappings` miss 时无提示,m模型不知道 mappings 缺席是列名不匹配所致(建议在回执加一句 hint)。

---

## 五、实战场景复盘(2026-08-28 用户提供的运行日志)

**现象**:模型连续 6 次 run_code 失败(`__import__` not found → `dir`/`globals` 未定义 → `eval` 被阻 → `Exception` 未定义 → 未定义 outputs → outputs 空字典),探明环境后发现结构扫描不含单元格值,判定"Manual Review 是 spec 正文需要读取",转用 pwsh 系统 Python 直读导出。

**定性**:
1. **拦截行为本身符合既定口径**——doc/ xlsx 属场景②,单元格值剥除是规格内行为,不是程序 bug。
2. **但口径存在 A-2 缺口**——合法需求在合规车道内无解,模型被迫绕道,恰是"把 AI 整成盲人"落在合法用例上。
3. **绕道后果比不拦更糟**——pwsh 通道零拦截零审计,既没保护数据,也没留住审计痕迹,还让红线形同虚设(A-1)。
4. **体验被两个可修缺陷放大**——中文乱码(B-1)让模型看不懂错误;builtins 过瘦(B-2)烧掉 6 次调用才摸清环境。

**建议处置顺序**:先修 B-1/B-2(当天可交付)→ 决策 A-2(spec-excel 白名单,host 侧配置)→ 决策 A-1(通用 shell 面收不收)。

---

## 六、优化机会(功能模式)

1. **环境自描述回执**:run_code 失败回执附可用命名空间清单(datasets 键名/pd/np/list_files/scan_excel_structures),把"试错发现"变"一次读明"。
2. **metadata 计算成本**:66 表全列 nunique/nullCount 在 inspect 期是全表扫描;可对超阈值列采样或延迟到显式请求。
3. **`data-security/changed` 订阅**:listing 订阅事件缓存开关态,替代每调用 try/catch 轮询(顺带消 C-11)。
4. **worker 生命周期**:超时 kill 后会话数据全丢、下次静默重载(_ensure_session);可在回执加 `reloaded: true` 标记,让模型知道会话被重置过。
5. **`scan_excel_structures` 与 inspect 的结构口径复用同一函数**——已经是(`_sheet_structure`),好;但 doc/ 内与项目根内两个入口的忽略规则(SCAN_IGNORE_PARTS)不一致之处可对齐。

---

## 七、修复记录(2026-08-28 晚,ADR-0007 批次)

用户裁决:**doc/ 零拦截;别让 harness AI 变蠢,同时防住真实数据泄露。**

| 项 | 处置 | 位置 |
|---|---|---|
| A-1 车道级绕过 | ✅ tool-audit 复活为通用车道护栏:tools/pre-execute 按路径引用 deny 数据集文件,enterprise_* 豁免,开关感知 fail-closed,拒绝理由引导回 listing 车道 | tool-audit/src/dataset-guard.ts(新)+index.ts |
| A-2 spec-xlsx 误伤 | ✅ 场景②整条退役:doc/ 零拦截,文本与 Excel 单元格恒全量回执;截断上限改协议护栏并显式标记 truncated(文本 50K→200K) | data_guard/discovery/worker.py |
| B-1 乱码+P1-4 | ✅ spawn 强制 PYTHONUTF8/PYTHONIOENCODING + DSH_PYTHON→python3/python、Windows python→py -3 候选链 + windowsHide;worker 侧 reconfigure 双保险 | listing/src/worker.ts、python/worker.py main() |
| B-2 builtins 过瘦 | ✅ 补异常类/dir/repr/map/filter 等;失败回执附 environmentHint;**并堵住审计未发现的 `pd.__dict__['read_sas']` 双下划线绕过**与 numpy/Excel 文件 IO 构造器(np.loadtxt/ExcelFile/HDFStore/SAS7BDAT 等) | sandbox.py |
| B-3 扩展名死接线 | ✅ datasetExtensions 单源(ui-settings)→ listing worker + tool-audit 护栏;auxExcelExtensions 废除(载入自动丢弃) | data-security-service.ts、discovery.normalize_extensions、dataset-guard |
| B-4 disposer 丢弃 | ✅ 路由 disposer 收集,stop() 拆除 | data-security-service.ts |
| B-5 审计静默吞错 | ✅ logger.warn 留痕 | data-security-service.ts |
| B-6 branding 半兑现 | ✅ validate+env 兜底、HTML 转义、index-inject 注入行、/favicon.svg+/manifest.webmanifest 路由;**顺带修复客户端脚本 `\b` 在模板字面量中被转义为退格符、短名替换从未生效的隐藏 bug** | branding/src/branding.ts |
| B-7 设置页文案 | ✅ 改 ADR-0007 口径 | settings-page.ts |
| C-5/C-6/C-9 | ✅ .gitignore 运行时状态;四包 tsconfig 排除测试 + vitest --exclude lib;WuXi 申办方名挪 patch config reportCoverLabels | .gitignore、各包 tsconfig/package.json、templates.py、listing/cordis.patch.yml |
| C-1/C-2/C-3(文档债) | ✅ 部分:ADR-0007 新增;0004/0005/0006 与设计/审计文档加取代横幅;README 门禁道数/§8 现状/目录树修正;CHANGELOG 记录;7+ 份过时交付文档的全文重写留待后续 | docs/enterprise/* |

**沙箱验证(2026-08-28)**:pytest 143 全绿(新增 doc/ 直通、截断标记、sandbox 封堵/内建用例);四包 tsc -b 零错误;check-architecture(4 插件/6 Bundle 层)+ check-secrets 通过;护栏全链路经编译产物驱动验证(deny/allow/豁免/开关关/fail-closed/legacy 配置丢弃);真实 worker NDJSON 冒烟:doc/ xlsx 单元格值全量可见、数据集投影生效、中文报错不乱码、environmentHint 在、异常类可用。

**Windows 侧待办**(G: 挂载不可删,需用户执行):
1. 删除杂物:`docs/enterprise/file_show (6).xlsx`、`scripts/start.mjs.backup`、`scripts/start.mjs.new`、`scripts/brand-diagnosis.js`、`packages/enterprise/branding/src/branding.ts.backup`、退役 shim 三件(listing `python/redact.py`、`python/tests/test_redact.py`、`src/redaction.test.ts`)、`python/styles/` 兼容层目录、各包 `lib/` 内陈旧 `*.test.js` 产物(或直接 `pnpm run clean`)
2. `pnpm run check:all` 收口(沙箱无法跑 oxlint/vitest)
3. `start.bat` 实点一次 + 端到端复验四步(见 ADR-0007 §验证)
4. `git add -A && git commit`(本轮改动面:4 包 src + tsconfig/package.json + patch yml + python 全层 + docs)
